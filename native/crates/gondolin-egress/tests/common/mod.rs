#![allow(dead_code)]

use bytes::Bytes;
use gondolin_egress::{Egress, HookBackend, NoHooks, Resolver};
use gondolin_netstack::{FlowAbort, FlowControl, FlowHandler, FlowMeta, TcpFlow};
use gondolin_proto::net::{HttpRules, MitmCaConfig, NetConfig, NetPolicy};
use http::{Request, Response};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use rcgen::{CertificateParams, DistinguishedName, DnType, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::net::TcpListener;

pub type TestBody = BoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;

pub fn body(data: impl Into<Bytes>) -> TestBody {
    Full::new(data.into()).map_err(|e| match e {}).boxed()
}

/// A CA (PEM cert + key) and an issuer for leaves.
pub struct TestCa {
    pub cert_pem: String,
    pub key_pem: String,
    issuer: Issuer<'static, KeyPair>,
}

impl TestCa {
    pub fn new(name: &str) -> Self {
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let mut params = CertificateParams::default();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, name);
        params.distinguished_name = dn;
        params.is_ca = IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let cert = params.self_signed(&key).unwrap();
        let cert_pem = cert.pem();
        let key_pem = key.serialize_pem();
        let issuer = Issuer::new(params, key);
        Self { cert_pem, key_pem, issuer }
    }

    pub fn mitm_config(&self) -> MitmCaConfig {
        MitmCaConfig { cert_pem: self.cert_pem.clone(), key_pem: self.key_pem.clone() }
    }

    /// rustls server config for an upstream serving `names`.
    pub fn server_config(&self, names: &[&str]) -> rustls::ServerConfig {
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let params =
            CertificateParams::new(names.iter().map(|s| s.to_string()).collect::<Vec<_>>())
                .unwrap();
        let cert = params.signed_by(&key, &self.issuer).unwrap();
        let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into()),
        )
        .unwrap();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        config
    }

    /// Client config trusting this CA.
    pub fn client_config(&self) -> rustls::ClientConfig {
        let mut roots = rustls::RootCertStore::empty();
        let der =
            rustls::pki_types::CertificateDer::from_pem_slice(self.cert_pem.as_bytes()).unwrap();
        roots.add(der).unwrap();
        let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        config
    }
}

use rustls::pki_types::pem::PemObject;

/// Resolver with fixed answers; unknown names resolve to 127.0.0.1 unless
/// listed in `fail`. Answers can be scripted per call.
#[derive(Default)]
pub struct TestResolver {
    pub answers: Mutex<HashMap<String, Vec<Vec<IpAddr>>>>,
    pub fail: Mutex<Vec<String>>,
    pub calls: AtomicU64,
}

impl TestResolver {
    pub fn set(&self, host: &str, answers: Vec<Vec<&str>>) {
        self.answers.lock().unwrap().insert(
            host.to_string(),
            answers
                .into_iter()
                .map(|a| a.into_iter().map(|s| s.parse().unwrap()).collect())
                .collect(),
        );
    }
}

impl Resolver for TestResolver {
    fn lookup<'a>(
        &'a self,
        host: &'a str,
    ) -> gondolin_egress::BoxFuture<'a, io::Result<Vec<IpAddr>>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail.lock().unwrap().iter().any(|h| h == host) {
                return Err(io::Error::new(io::ErrorKind::NotFound, "not found"));
            }
            let mut answers = self.answers.lock().unwrap();
            if let Some(list) = answers.get_mut(host) {
                if list.len() > 1 {
                    return Ok(list.remove(0));
                }
                if let Some(last) = list.first() {
                    return Ok(last.clone());
                }
            }
            Ok(vec!["127.0.0.1".parse().unwrap()])
        })
    }
}

pub type Handler = Arc<
    dyn Fn(Request<Incoming>) -> Pin<Box<dyn Future<Output = Response<TestBody>> + Send>>
        + Send
        + Sync,
>;

pub fn handler<F, Fut>(f: F) -> Handler
where
    F: Fn(Request<Incoming>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Response<TestBody>> + Send + 'static,
{
    Arc::new(move |req| Box::pin(f(req)))
}

/// Starts an upstream HTTP(S) server on 127.0.0.1.
pub async fn upstream(handler: Handler, tls: Option<rustls::ServerConfig>) -> SocketAddr {
    upstream_counted(handler, tls).await.0
}

/// [`upstream`] that also counts accepted connections.
pub async fn upstream_counted(
    handler: Handler,
    tls: Option<rustls::ServerConfig>,
) -> (SocketAddr, Arc<std::sync::atomic::AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let acceptor = tls.map(|c| tokio_rustls::TlsAcceptor::from(Arc::new(c)));
    let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = accepted.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            counter.fetch_add(1, Ordering::SeqCst);
            let handler = handler.clone();
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let svc = service_fn(move |req| {
                    let handler = handler.clone();
                    async move { Ok::<_, Infallible>(handler(req).await) }
                });
                let builder = hyper::server::conn::http1::Builder::new();
                match acceptor {
                    Some(acceptor) => {
                        let Ok(tls) = acceptor.accept(stream).await else {
                            return;
                        };
                        let _ =
                            builder.serve_connection(TokioIo::new(tls), svc).with_upgrades().await;
                    }
                    None => {
                        let _ = builder
                            .serve_connection(TokioIo::new(stream), svc)
                            .with_upgrades()
                            .await;
                    }
                }
            });
        }
    });
    (addr, accepted)
}

#[derive(Default)]
pub struct AbortFlag(pub AtomicBool);

impl FlowAbort for AbortFlag {
    fn abort(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

pub fn config(rules: Option<HttpRules>, ca: Option<&TestCa>) -> NetConfig {
    NetConfig {
        policy: NetPolicy { rules, allow_websockets: true },
        mitm: ca.map(TestCa::mitm_config),
        use_system_roots: false,
        use_webpki_roots: false,
        upstream_ca_pems: ca.map(|c| vec![c.cert_pem.clone()]).unwrap_or_default(),
        ..NetConfig::default()
    }
}

/// Rules allowing everything incl. internal ranges (local upstreams).
pub fn open_rules() -> HttpRules {
    HttpRules { block_internal_ranges: false, ..HttpRules::default() }
}

pub struct Harness {
    pub egress: Egress,
    pub resolver: Arc<TestResolver>,
}

impl Harness {
    pub fn new(config: NetConfig, hooks: Arc<dyn HookBackend>) -> Self {
        let resolver = Arc::new(TestResolver::default());
        let egress = Egress::with_resolver(config, hooks, resolver.clone()).unwrap();
        Self { egress, resolver }
    }

    pub fn simple(rules: Option<HttpRules>) -> Self {
        Self::new(config(rules, None), Arc::new(NoHooks))
    }

    /// Opens a guest flow to `dst_port`; returns the guest end and the abort flag.
    pub fn open(&self, dst_port: u16) -> (DuplexStream, Arc<AbortFlag>) {
        let (guest, host) = tokio::io::duplex(256 * 1024);
        let abort = Arc::new(AbortFlag::default());
        let flow = TcpFlow {
            meta: FlowMeta {
                id: 1,
                src: "192.168.127.3:40000".parse().unwrap(),
                dst: SocketAddr::new("192.0.2.1".parse().unwrap(), dst_port),
                synthetic_hostname: None,
            },
            stream: Box::pin(host),
            control: FlowControl::new(abort.clone()),
        };
        let egress = self.egress.clone();
        tokio::spawn(async move { egress.handle_tcp(flow).await });
        (guest, abort)
    }

    /// Sends a raw request on a fresh plain flow and reads until EOF.
    pub async fn raw(&self, request: &[u8]) -> Vec<u8> {
        let (mut guest, _) = self.open(80);
        guest.write_all(request).await.unwrap();
        read_to_end(&mut guest).await
    }

    /// Opens a TLS flow through the MITM (trusting `ca`) with SNI `name`.
    pub async fn tls(
        &self,
        ca: &TestCa,
        name: &str,
    ) -> tokio_rustls::client::TlsStream<DuplexStream> {
        let (guest, _) = self.open(443);
        let connector = tokio_rustls::TlsConnector::from(Arc::new(ca.client_config()));
        connector
            .connect(rustls::pki_types::ServerName::try_from(name.to_string()).unwrap(), guest)
            .await
            .unwrap()
    }
}

pub async fn read_to_end<S: tokio::io::AsyncRead + Unpin>(stream: &mut S) -> Vec<u8> {
    let mut out = Vec::new();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(20), stream.read_to_end(&mut out))
        .await
        .expect("timed out reading response");
    out
}

/// Parsed raw HTTP/1.x response.
#[derive(Debug)]
pub struct Parsed {
    pub status_line: String,
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub raw_head: String,
}

impl Parsed {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Parses one response (skipping interim 1xx responses other than 101).
pub fn parse(raw: &[u8]) -> Parsed {
    let mut raw = raw;
    loop {
        let end = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .unwrap_or_else(|| panic!("no header end in {:?}", String::from_utf8_lossy(raw)));
        let head = String::from_utf8_lossy(&raw[..end]).into_owned();
        let rest = &raw[end + 4..];
        let mut lines = head.split("\r\n");
        let status_line = lines.next().unwrap().to_string();
        let status: u16 = status_line.split(' ').nth(1).unwrap().parse().unwrap();
        if (100..200).contains(&status) && status != 101 {
            raw = rest;
            continue;
        }
        let headers: Vec<(String, String)> = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        let chunked = headers
            .iter()
            .any(|(k, v)| k == "transfer-encoding" && v.eq_ignore_ascii_case("chunked"));
        let body = if chunked { dechunk(rest) } else { rest.to_vec() };
        return Parsed { status_line, status, headers, body, raw_head: head };
    }
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(line_end) = data.windows(2).position(|w| w == b"\r\n") else {
            return out;
        };
        let size = usize::from_str_radix(
            std::str::from_utf8(&data[..line_end]).unwrap().split(';').next().unwrap().trim(),
            16,
        )
        .unwrap();
        data = &data[line_end + 2..];
        if size == 0 {
            return out;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
}

pub async fn body_bytes(req: Request<Incoming>) -> Bytes {
    req.into_body().collect().await.unwrap().to_bytes()
}

pub fn header_text(req: &Request<Incoming>, name: &str) -> Option<String> {
    req.headers().get(name).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
}

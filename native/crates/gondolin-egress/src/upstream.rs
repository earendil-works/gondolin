//! Upstream connections: a pooled hyper client whose connector resolves and
//! checks every new connection against the ip policy (DNS rebinding
//! protection at connect time), plus raw connections for WebSocket tunnels.

use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use http::Uri;
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use rustls::ClientConfig;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, ServerName};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use crate::body::HookBody;
use crate::error::{Blocked, BoxError, PipelineError};
use crate::policy::{PolicyEngine, bare_host};

/// Upstream TCP connect timeout per address (undici `connect.timeout`)
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Idle pooled connection lifetime (`DEFAULT_SHARED_UPSTREAM_IDLE_TTL_MS`)
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Idle pooled connections per origin (`DEFAULT_SHARED_UPSTREAM_CONNECTIONS_PER_ORIGIN`)
const POOL_MAX_IDLE_PER_HOST: usize = 16;

pub type UpstreamClient = Client<HttpsConnector<GuardedConnector>, HookBody>;

/// Upstream TLS trust configuration.
#[derive(Debug, Clone, Default)]
pub struct TrustConfig {
    pub webpki_roots: bool,
    pub system_roots: bool,
    pub extra_pems: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum TrustError {
    #[error("invalid upstream CA certificate: {0}")]
    Pem(String),
    #[error(transparent)]
    Tls(#[from] rustls::Error),
}

/// Builds the upstream rustls client config (without ALPN; the pooled client
/// adds `http/1.1`, WebSocket tunnels set it themselves).
pub fn client_tls_config(trust: &TrustConfig) -> Result<ClientConfig, TrustError> {
    let mut roots = rustls::RootCertStore::empty();
    if trust.webpki_roots {
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }
    if trust.system_roots {
        let native = rustls_native_certs::load_native_certs();
        for cert in native.certs {
            let _ = roots.add(cert);
        }
    }
    for pem in &trust.extra_pems {
        for cert in CertificateDer::pem_slice_iter(pem.as_bytes()) {
            let cert = cert.map_err(|e| TrustError::Pem(e.to_string()))?;
            roots.add(cert)?;
        }
    }
    let config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()?
            .with_root_certificates(roots)
            .with_no_client_auth();
    Ok(config)
}

/// Connection refused by the ip policy at connect time.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConnectBlocked(pub Blocked);

/// Resolves the URI host, filters the addresses through the ip policy and
/// connects to the first reachable allowed address.
#[derive(Clone)]
pub struct GuardedConnector {
    policy: Arc<PolicyEngine>,
}

impl GuardedConnector {
    pub fn new(policy: Arc<PolicyEngine>) -> Self {
        Self { policy }
    }
}

impl tower_service::Service<Uri> for GuardedConnector {
    type Response = TokioIo<TcpStream>;
    type Error = BoxError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let policy = self.policy.clone();
        Box::pin(async move {
            let host = uri.host().ok_or("missing host")?.to_string();
            let https = uri.scheme_str() == Some("https");
            let protocol = if https { "https" } else { "http" };
            let port = uri.port_u16().unwrap_or(if https { 443 } else { 80 });
            let allowed = match policy.allowed_addresses(&host, protocol, port).await {
                Ok(a) => a,
                Err(PipelineError::Blocked(b)) => {
                    return Err(Box::new(ConnectBlocked(b)) as BoxError);
                }
                Err(e) => return Err(e.to_string().into()),
            };
            if allowed.is_empty() {
                tracing::debug!(target: "gondolin::egress", "http connect blocked by policy {host}");
                return Err(Box::new(ConnectBlocked(Blocked::forbidden(format!(
                    "blocked by policy: {host}"
                )))) as BoxError);
            }
            let stream = connect_any(&allowed, port).await?;
            Ok(TokioIo::new(stream))
        })
    }
}

async fn connect_any(addrs: &[IpAddr], port: u16) -> std::io::Result<TcpStream> {
    let mut last_err = None;
    for ip in addrs {
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(SocketAddr::new(*ip, port)))
            .await
        {
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Ok(Err(e)) => last_err = Some(e),
            Err(_) => {
                last_err =
                    Some(std::io::Error::new(std::io::ErrorKind::TimedOut, "connect timeout"))
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("no addresses")))
}

/// Builds the pooled upstream client.
pub fn build_client(policy: Arc<PolicyEngine>, tls: ClientConfig) -> UpstreamClient {
    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_tls_config(tls)
        .https_or_http()
        .enable_http1()
        .wrap_connector(GuardedConnector::new(policy));
    Client::builder(TokioExecutor::new())
        .pool_idle_timeout(POOL_IDLE_TIMEOUT)
        .pool_max_idle_per_host(POOL_MAX_IDLE_PER_HOST)
        .pool_timer(TokioTimer::new())
        .http1_max_headers(1024)
        .build(https)
}

/// A raw upstream stream (plain TCP or TLS) for WebSocket tunnels.
pub trait UpstreamIo: AsyncRead + AsyncWrite + Send + Unpin + 'static {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin + 'static> UpstreamIo for T {}

/// Connects to the first reachable of `addresses` (allowed by policy) and performs the TLS
/// handshake for `https` with SNI `hostname`.
pub async fn connect_raw(
    tls: &Arc<ClientConfig>,
    https: bool,
    hostname: &str,
    addresses: &[IpAddr],
    port: u16,
) -> Result<Box<dyn UpstreamIo>, BoxError> {
    let stream = connect_any(addresses, port).await?;
    if !https {
        return Ok(Box::new(stream));
    }
    let host = bare_host(hostname);
    let name = match host.parse::<IpAddr>() {
        Ok(ip) => ServerName::IpAddress(ip.into()),
        Err(_) => ServerName::try_from(host.to_string())?,
    };
    let connector = tokio_rustls::TlsConnector::from(tls.clone());
    let tls_stream = connector.connect(name, stream).await?;
    Ok(Box::new(tls_stream))
}

//! Upstream connections: a pooled HTTP client whose connector resolves and
//! checks every new connection against the ip policy (DNS rebinding
//! protection at connect time), plus raw connections for WebSocket tunnels.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use gondolin_http::HeadLimits;
use gondolin_http::client::{
    Client, ClientConfig as HttpClientConfig, Connect, ConnectFuture, Target,
};
use rustls::ClientConfig;
use rustls_pki_types::CertificateDer;
use rustls_pki_types::pem::PemObject;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use crate::error::{Blocked, BoxError, PipelineError};
use crate::policy::PolicyEngine;

/// Upstream TCP connect timeout per address (undici `connect.timeout`)
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Idle pooled connection lifetime (`DEFAULT_SHARED_UPSTREAM_IDLE_TTL_MS`)
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Idle pooled connections per origin (`DEFAULT_SHARED_UPSTREAM_CONNECTIONS_PER_ORIGIN`)
const POOL_MAX_IDLE_PER_HOST: usize = 16;

/// Max upstream response head size in `bytes` (hyper's default buffer limit)
const MAX_RESPONSE_HEAD_BYTES: usize = 8192 + 4096 * 100;
/// Max upstream response header lines
const MAX_RESPONSE_HEADERS: usize = 1024;

pub type UpstreamClient = Client;

/// Upstream TLS trust configuration.
#[derive(Debug, Clone, Default)]
pub struct TrustConfig {
    pub webpki_roots: bool,
    pub system_roots: bool,
    pub extra_pems: Vec<String>,
}

#[derive(Debug)]
pub enum TrustError {
    Pem(String),
    Tls(rustls::Error),
}

impl From<rustls::Error> for TrustError {
    fn from(e: rustls::Error) -> Self {
        TrustError::Tls(e)
    }
}

impl std::fmt::Display for TrustError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrustError::Pem(e) => write!(f, "invalid upstream CA certificate: {e}"),
            TrustError::Tls(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for TrustError {}

/// Builds the upstream rustls client config (without ALPN).
pub fn client_tls_config(trust: &TrustConfig) -> Result<ClientConfig, TrustError> {
    let mut roots = rustls::RootCertStore::empty();
    if trust.webpki_roots {
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }
    if trust.system_roots {
        // unparsable or unsupported system certificates are skipped
        for pem in crate::system_roots::load() {
            for cert in CertificateDer::pem_slice_iter(&pem).flatten() {
                let _ = roots.add(cert);
            }
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
#[derive(Debug)]
pub struct ConnectBlocked(pub Blocked);

impl std::fmt::Display for ConnectBlocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for ConnectBlocked {}

/// Resolves the target host, filters the addresses through the ip policy and
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

impl Connect for GuardedConnector {
    fn connect<'a>(&'a self, target: &'a Target) -> ConnectFuture<'a> {
        Box::pin(async move {
            let host = &target.host;
            let protocol = if target.https { "https" } else { "http" };
            let allowed = match self.policy.allowed_addresses(host, protocol, target.port).await {
                Ok(a) => a,
                Err(PipelineError::Blocked(b)) => {
                    return Err(Box::new(ConnectBlocked(b)) as BoxError);
                }
                Err(e) => return Err(e.to_string().into()),
            };
            if allowed.is_empty() {
                gondolin_log::debug!(target: "gondolin::egress", "http connect blocked by policy {host}");
                return Err(Box::new(ConnectBlocked(Blocked::forbidden(format!(
                    "blocked by policy: {host}"
                )))) as BoxError);
            }
            let stream = connect_any(&allowed, target.port).await?;
            Ok(Box::new(stream) as gondolin_http::BoxIo)
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

/// Builds the pooled upstream client (`tls` with ALPN `http/1.1`).
pub fn build_client(policy: Arc<PolicyEngine>, tls: Arc<ClientConfig>) -> UpstreamClient {
    Client::new(
        Arc::new(GuardedConnector::new(policy)),
        Some(tls),
        HttpClientConfig {
            limits: HeadLimits {
                max_bytes: MAX_RESPONSE_HEAD_BYTES,
                max_headers: MAX_RESPONSE_HEADERS,
            },
            idle_timeout: POOL_IDLE_TIMEOUT,
            max_idle_per_target: POOL_MAX_IDLE_PER_HOST,
        },
    )
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
    let name = gondolin_http::tls::server_name(hostname)?;
    let tls_stream = gondolin_http::tls::connect(tls.clone(), name, stream).await?;
    Ok(Box::new(tls_stream))
}

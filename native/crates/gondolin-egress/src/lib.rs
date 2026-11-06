//! Egress for gondolind: classifies guest TCP flows and mediates HTTP(S).
//!
//! Seams (see `native/DESIGN.md`): [`Egress`] implements
//! [`gondolin_netstack::FlowHandler`]; programmable hooks are reached through a
//! [`HookBackend`] implemented by gondolind (controller callbacks) and later djs.
//!
//! Per flow: explicit `tcp.hosts` mappings are tunneled raw; otherwise the
//! first bytes are classified (HTTP/1.x request line, TLS ClientHello, SSH
//! banner on SSH ports) and everything else is reset. HTTP is bridged by a
//! hyper server per flow, TLS is terminated with a per-host leaf certificate
//! (MITM) and then bridged the same way.

mod body;
mod classify;
mod error;
mod headers;
mod hooks;
mod http;
mod ip;
mod mitm;
mod patterns;
mod policy;
mod remote;
mod secrets;
mod upstream;
mod ws;

use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use bytes::{Buf, Bytes, BytesMut};
use gondolin_netstack::{FlowHandler, TcpFlow};
use gondolin_proto::net::{NetConfig, NetLimits, NetPolicy, TcpHostMapping};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use tokio::sync::Semaphore;

pub use crate::body::{
    BodyHandle, HookBody, PullError, PullableBody, empty as empty_body, full as full_body,
};
pub use crate::classify::{Classification, MAX_FLOW_SNIFF, classify};
pub use crate::error::{Blocked, BoxError};
pub use crate::hooks::{
    BodyChoice, HookBackend, HookError, IpAllowInfo, NoHooks, RequestDecision, RequestHead,
    ResponseDecision, ResponseHead,
};
pub use crate::http::MAX_HTTP_HEADER_BYTES;
pub use crate::ip::{is_internal_ip, is_internal_ip_str};
pub use crate::mitm::{MitmAuthority, MitmError};
pub use crate::patterns::{match_hostname, matches_any_host, normalize_pattern, unique_hosts};
pub use crate::policy::{Resolver, SystemResolver};
pub use crate::remote::{ControllerLink, RemoteHooks};
pub use crate::secrets::apply_secrets;

/// Errors building an [`Egress`].
#[derive(Debug, thiserror::Error)]
pub enum EgressError {
    #[error(transparent)]
    Mitm(#[from] MitmError),
    #[error(transparent)]
    Trust(#[from] upstream::TrustError),
}

/// Shared state of all flows.
pub(crate) struct Shared {
    pub engine: Arc<policy::PolicyEngine>,
    pub limits: NetLimits,
    pub client: upstream::UpstreamClient,
    pub tls_client: Arc<rustls::ClientConfig>,
    pub mitm: Option<Arc<MitmAuthority>>,
    pub concurrency: Arc<Semaphore>,
    pub tcp_hosts: Vec<TcpHostMapping>,
    /// SSH sniff ports and proxy (set once at startup)
    pub ssh: std::sync::RwLock<SshState>,
}

#[derive(Default, Clone)]
pub(crate) struct SshState {
    /// destination ports where `SSH-` banners are recognized
    pub ports: Vec<u16>,
    pub proxy: Option<gondolin_sshproxy::SshProxy>,
}

/// The egress flow handler.
#[derive(Clone)]
pub struct Egress {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for Egress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Egress").finish_non_exhaustive()
    }
}

impl Egress {
    /// Builds the egress side from `configure.net` with the system resolver.
    pub fn new(config: NetConfig, hooks: Arc<dyn HookBackend>) -> Result<Self, EgressError> {
        Self::with_resolver(config, hooks, Arc::new(SystemResolver))
    }

    /// Like [`Egress::new`] with a custom host resolver (tests).
    pub fn with_resolver(
        config: NetConfig,
        hooks: Arc<dyn HookBackend>,
        resolver: Arc<dyn Resolver>,
    ) -> Result<Self, EgressError> {
        let engine = Arc::new(policy::PolicyEngine::new(config.policy, hooks, resolver));
        let tls = upstream::client_tls_config(&upstream::TrustConfig {
            webpki_roots: config.use_webpki_roots,
            system_roots: config.use_system_roots,
            extra_pems: config.upstream_ca_pems,
        })?;
        let client = upstream::build_client(engine.clone(), tls.clone());
        let mut tls = tls;
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let mitm = match &config.mitm {
            Some(ca) => Some(Arc::new(MitmAuthority::from_pem(
                &ca.cert_pem,
                &ca.key_pem,
                config.limits.tls_cache_max_entries as usize,
                Duration::from_millis(config.limits.tls_cache_ttl_ms),
            )?)),
            None => None,
        };
        let concurrency =
            Arc::new(Semaphore::new(config.limits.max_concurrent_requests.max(1) as usize));
        Ok(Self {
            shared: Arc::new(Shared {
                engine,
                limits: config.limits,
                client,
                tls_client: Arc::new(tls),
                mitm,
                concurrency,
                tcp_hosts: config.tcp_hosts,
                ssh: std::sync::RwLock::new(SshState {
                    ports: config.ssh.map(|s| s.ports).unwrap_or_default(),
                    proxy: None,
                }),
            }),
        })
    }

    /// Attaches the SSH egress proxy (SSH banners on its ports are handed to it).
    /// Applies to flows accepted afterwards.
    pub fn with_ssh_proxy(self, proxy: Option<gondolin_sshproxy::SshProxy>) -> Self {
        let mut ssh = self.shared.ssh.write().unwrap();
        if let Some(proxy) = &proxy {
            ssh.ports = proxy.sniff_ports();
        }
        ssh.proxy = proxy;
        drop(ssh);
        self
    }

    /// Replaces the declarative policy (`policy_update`); applies to requests
    /// evaluated from now on.
    pub fn update_policy(&self, policy: NetPolicy) {
        self.shared.engine.set_policy(policy);
    }

    /// The current declarative policy.
    pub fn policy(&self) -> Arc<NetPolicy> {
        self.shared.engine.policy()
    }
}

fn mapped_target<'a>(
    mappings: &'a [TcpHostMapping],
    host: Option<&str>,
    port: u16,
) -> Option<&'a TcpHostMapping> {
    let host = host?.trim().to_ascii_lowercase();
    let host = host.trim_end_matches('.');
    if host.is_empty() {
        return None;
    }
    mappings
        .iter()
        .find(|m| m.host == host && m.port == Some(port))
        .or_else(|| mappings.iter().find(|m| m.host == host && m.port.is_none()))
}

#[async_trait]
impl FlowHandler for Egress {
    async fn handle_tcp(&self, flow: TcpFlow) {
        let shared = self.shared.clone();
        let TcpFlow { meta, mut stream, control } = flow;
        let id = meta.id;

        if let Some(target) =
            mapped_target(&shared.tcp_hosts, meta.synthetic_hostname.as_deref(), meta.dst.port())
        {
            tracing::debug!(
                target: "gondolin::egress",
                flow = id,
                "tcp map {} {}:{} -> {}:{}",
                meta.src,
                meta.synthetic_hostname.as_deref().unwrap_or_default(),
                meta.dst.port(),
                target.upstream_host,
                target.upstream_port
            );
            match tokio::net::TcpStream::connect((
                target.upstream_host.as_str(),
                target.upstream_port,
            ))
            .await
            {
                Ok(mut upstream) => {
                    let _ = upstream.set_nodelay(true);
                    if let Err(err) =
                        tokio::io::copy_bidirectional(&mut stream, &mut upstream).await
                    {
                        tracing::debug!(target: "gondolin::egress", flow = id, "tcp map ended: {err}");
                    }
                }
                Err(err) => {
                    tracing::debug!(target: "gondolin::egress", flow = id, "tcp map connect failed: {err}");
                    control.abort();
                }
            }
            return;
        }

        let ssh = shared.ssh.read().unwrap().clone();
        let ssh_port = ssh.ports.contains(&meta.dst.port());
        let mut buf = BytesMut::with_capacity(4096);
        let class = loop {
            match classify(&buf, ssh_port) {
                Classification::NeedMore => {}
                other => break other,
            }
            if buf.len() >= MAX_FLOW_SNIFF {
                deny(&control, &meta.src, &meta.dst, id, "sniff-limit-exceeded");
                return;
            }
            match stream.read_buf(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        };

        let prefixed = Lingering::new(Prefixed { prefix: buf.freeze(), inner: stream });
        match class {
            Classification::Http { method } if method == "CONNECT" => {
                deny(&control, &meta.src, &meta.dst, id, "connect-not-allowed");
            }
            Classification::Http { .. } => {
                http::serve_http(shared, prefixed, http::Scheme::Http, id).await;
            }
            Classification::Tls => {
                let Some(mitm) = shared.mitm.clone() else {
                    deny(&control, &meta.src, &meta.dst, id, "tls-without-mitm-ca");
                    return;
                };
                let acceptor = tokio_rustls::LazyConfigAcceptor::new(
                    rustls::server::Acceptor::default(),
                    prefixed,
                );
                let start = match acceptor.await {
                    Ok(start) => start,
                    Err(err) => {
                        tracing::debug!(target: "gondolin::egress", flow = id, "tls client hello failed: {err}");
                        control.abort();
                        return;
                    }
                };
                let servername = start
                    .client_hello()
                    .server_name()
                    .map(str::to_string)
                    .unwrap_or_else(|| meta.dst.ip().to_string());
                tracing::debug!(target: "gondolin::egress", flow = id, "tls sni {servername}");
                let name = servername.clone();
                let config = match tokio::task::spawn_blocking(move || mitm.server_config(&name))
                    .await
                {
                    Ok(Ok(config)) => config,
                    Ok(Err(err)) => {
                        tracing::warn!(target: "gondolin::egress", flow = id, "tls mitm for {servername} failed: {err}");
                        control.abort();
                        return;
                    }
                    Err(_) => {
                        control.abort();
                        return;
                    }
                };
                let tls = match start.into_stream(config).await {
                    Ok(tls) => tls,
                    Err(err) => {
                        tracing::debug!(target: "gondolin::egress", flow = id, "tls handshake failed: {err}");
                        control.abort();
                        return;
                    }
                };
                http::serve_http(shared, tls, http::Scheme::Https, id).await;
            }
            Classification::Ssh => {
                let Some(proxy) = ssh.proxy else {
                    deny(&control, &meta.src, &meta.dst, id, "ssh-not-enabled");
                    return;
                };
                let Some(target) = proxy.target_for(&meta) else {
                    deny(&control, &meta.src, &meta.dst, id, "policy-deny");
                    return;
                };
                proxy.handle(TcpFlow { meta, stream: Box::pin(prefixed), control }, target).await;
            }
            Classification::Deny | Classification::NeedMore => {
                deny(&control, &meta.src, &meta.dst, id, "unknown-protocol");
            }
        }
    }
}

fn deny(
    control: &gondolin_netstack::FlowControl,
    src: &SocketAddr,
    dst: &SocketAddr,
    id: u64,
    reason: &str,
) {
    tracing::debug!(target: "gondolin::egress", flow = id, "tcp blocked {src} -> {dst} ({reason})");
    control.abort();
}

/// Extra guest bytes discarded after a connection is done in `bytes`
/// (`MAX_HTTP_PIPELINE_BYTES`)
const LINGER_MAX_BYTES: usize = 64 * 1024;
/// How long unread guest input is drained after a connection is done
const LINGER_TIME: Duration = Duration::from_secs(2);

/// Closes gracefully: when dropped, unread guest input (e.g. a request body
/// the pipeline rejected without reading) is drained in the background for a
/// bounded time, so the flow ends with FIN after the response instead of a
/// reset that could discard it.
struct Lingering<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> {
    inner: Option<S>,
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> Lingering<S> {
    fn new(inner: S) -> Self {
        Self { inner: Some(inner) }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> Drop for Lingering<S> {
    fn drop(&mut self) {
        let Some(mut inner) = self.inner.take() else {
            return;
        };
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        handle.spawn(async move {
            // FIN after everything written so far, then drain the guest's input
            let _ = tokio::io::AsyncWriteExt::shutdown(&mut inner).await;
            let mut buf = vec![0u8; 8 * 1024];
            let mut total = 0;
            let _ = tokio::time::timeout(LINGER_TIME, async {
                while total <= LINGER_MAX_BYTES {
                    match inner.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => total += n,
                    }
                }
            })
            .await;
        });
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> AsyncRead for Lingering<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(self.inner.as_mut().expect("stream")).poll_read(cx, buf)
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> AsyncWrite for Lingering<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(self.inner.as_mut().expect("stream")).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(self.inner.as_mut().expect("stream")).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(self.inner.as_mut().expect("stream")).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(self.inner.as_mut().expect("stream")).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.as_ref().is_some_and(|s| s.is_write_vectored())
    }
}

/// A stream that first yields already-read bytes.
struct Prefixed<S> {
    prefix: Bytes,
    inner: S,
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if !self.prefix.is_empty() {
            let n = self.prefix.len().min(buf.remaining());
            buf.put_slice(&self.prefix[..n]);
            self.prefix.advance(n);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

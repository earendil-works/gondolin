//! Userspace network stack for gondolind: speaks QEMU's stream netdev
//! (`u32` big-endian length-prefixed Ethernet frames over a unix stream) or
//! raw frames from a datagram socket ([`FrameSocket`], e.g. a packet socket on
//! a Firecracker tap, with Linux offload headers handled by [`offload`]) and
//! terminates guest traffic on the host.
//!
//! - Ethernet, ARP for the gateway, IPv4 (checksums verified, fragments
//!   dropped), ICMP echo for any destination, a DHCP server, UDP only for DNS
//!   (`synthetic`, `trusted`, `open`; see `docs/network.md`).
//! - Every guest TCP connection, whatever its destination, is terminated by a
//!   smoltcp socket and handed to a [`FlowHandler`] as a [`TcpFlow`] byte stream.
//!   Backpressure is the TCP window in both directions; nothing is buffered
//!   beyond the per-flow socket buffers and a bounded frame queue to QEMU.
//!
//! Seams (see `native/DESIGN.md`): [`NetStack::new`] + [`NetStack::serve`] for
//! gondolind, [`FlowHandler`] / [`TcpFlow`] / [`FlowMeta`] /
//! [`SyntheticHostLookup`] for `gondolin-egress`.

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};

pub mod config;
pub mod dhcp;
pub mod dns;
mod flow;
pub mod frames;
pub mod offload;
mod stack;
pub mod wire;

pub use config::{DnsConfig, DnsMode, MacAddr, NetConfig, NetLimits, SyntheticHostMapping};
pub use dns::SyntheticHostMap;
pub use frames::FrameSocket;
pub use stack::{NetStack, NetStackError, NetStats, READ_HOLD};

/// Addressing of one guest TCP connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowMeta {
    /// per-stack connection id (for logs; unique for the lifetime of the [`NetStack`])
    pub id: u64,
    /// guest-side source address
    pub src: SocketAddr,
    /// destination the guest connected to
    pub dst: SocketAddr,
    /// hostname behind `dst` when synthetic per-host DNS mapping assigned it
    pub synthetic_hostname: Option<String>,
}

/// Bidirectional byte stream of a guest TCP connection.
///
/// Semantics of the stream handed out by [`NetStack`]:
/// - read returns EOF once the guest sent FIN (half-close: writing still works);
///   `ConnectionReset` when the guest reset the connection, `ConnectionAborted`
///   after [`FlowControl::abort`] or when the stack shut down;
/// - write returns `Pending` while the per-flow send buffer is full (the guest's
///   window is the backpressure); errors once the connection can't send;
/// - shutdown sends FIN after queued data (reading continues);
/// - dropping it closes gracefully (FIN after queued data), or resets if unread
///   guest data remains, like a Linux socket.
pub trait FlowStream: AsyncRead + AsyncWrite + Send + Unpin + 'static {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin + 'static> FlowStream for T {}

/// Aborts a flow; implemented by the stack (and by tests).
pub trait FlowAbort: Send + Sync + 'static {
    /// Resets the guest connection (TCP RST), discarding buffered data.
    fn abort(&self);
}

/// Cloneable handle to control a flow independently of its stream (e.g. after
/// `tokio::io::split`).
#[derive(Clone, Default)]
pub struct FlowControl {
    inner: Option<Arc<dyn FlowAbort>>,
}

impl FlowControl {
    pub fn new(inner: Arc<dyn FlowAbort>) -> Self {
        FlowControl { inner: Some(inner) }
    }

    /// A control whose `abort` does nothing (flows built from plain streams).
    pub fn detached() -> Self {
        FlowControl { inner: None }
    }

    /// Resets the connection to the guest (node engine: `abortTcpSession`).
    /// Pending reads/writes on the stream fail with `ConnectionAborted`.
    pub fn abort(&self) {
        if let Some(inner) = &self.inner {
            inner.abort();
        }
    }
}

impl fmt::Debug for FlowControl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FlowControl").field("attached", &self.inner.is_some()).finish()
    }
}

/// One accepted guest TCP connection (handshake completed).
pub struct TcpFlow {
    pub meta: FlowMeta,
    pub stream: Pin<Box<dyn FlowStream>>,
    pub control: FlowControl,
}

impl TcpFlow {
    /// Builds a flow from any stream with a detached control (tests, adapters).
    pub fn new(meta: FlowMeta, stream: impl FlowStream) -> Self {
        TcpFlow { meta, stream: Box::pin(stream), control: FlowControl::detached() }
    }

    /// Resets the guest connection and drops the flow.
    pub fn abort(self) {
        self.control.abort();
    }
}

impl fmt::Debug for TcpFlow {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TcpFlow").field("meta", &self.meta).finish()
    }
}

/// Receives guest TCP connections; implemented by `gondolin-egress`.
///
/// Each call runs on its own tokio task.
pub trait FlowHandler: Send + Sync + 'static {
    /// Handles one connection until it is done. Dropping the stream closes it.
    fn handle_tcp(&self, flow: TcpFlow) -> BoxFuture<'_, ()>;
}

/// Runs both futures until the first completes; the other is dropped
/// (`tokio::select!` without the macros feature). The polling order
/// alternates: with a fixed order, a first future that always has work would
/// use up tokio's cooperative budget on every poll and starve the second.
pub async fn race<T>(
    a: impl std::future::Future<Output = T>,
    b: impl std::future::Future<Output = T>,
) -> T {
    use std::task::Poll;
    let mut a = std::pin::pin!(a);
    let mut b = std::pin::pin!(b);
    let mut a_first = true;
    std::future::poll_fn(|cx| {
        a_first = !a_first;
        if a_first {
            if let Poll::Ready(v) = a.as_mut().poll(cx) {
                return Poll::Ready(v);
            }
            b.as_mut().poll(cx)
        } else {
            if let Poll::Ready(v) = b.as_mut().poll(cx) {
                return Poll::Ready(v);
            }
            a.as_mut().poll(cx)
        }
    })
    .await
}

/// A boxed, sendable future (the async trait methods of the native crates).
pub type BoxFuture<'a, T> = Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// Looks up the hostname a synthetic DNS answer mapped to `ip` (per-host mode).
pub trait SyntheticHostLookup: Send + Sync + 'static {
    fn hostname_for(&self, ip: IpAddr) -> Option<String>;
}

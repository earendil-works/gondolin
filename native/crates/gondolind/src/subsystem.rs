//! Integration points for the VFS and network subsystems.
//!
//! `configure.vfs` and `configure.net` are opaque CBOR values owned by their
//! subsystems; [`build_vfs`] and [`build_net`] turn them into backends. The
//! core daemon owns the guest channels and the QEMU netdev socket and hands
//! traffic to the backends:
//!
//! - [`VfsBackend`] answers sandboxfs RPC requests from the guest's
//!   `virtio-fs` port (`guest/ARCHITECTURE.md` §6). The core handles the boot
//!   configuration op `mounts`, idle-pause resume, activity tracking and
//!   framing; the backend sees every other op.
//! - [`NetBackend`] serves QEMU's stream netdev connection (length-prefixed
//!   Ethernet frames) on a socket in the session's private directory.
//!
//! Subsystems may register handlers for their own controller message types
//! through [`SubsystemContext::dispatcher`] and call the controller with
//! [`Controller::request`].

use std::sync::Arc;

use gondolin_wire::Value;
use tokio::net::UnixStream;

use crate::controller::{Controller, Dispatcher};
use crate::fields::Fields;
use crate::session::ActivityHandle;

/// Linux errno values used in sandboxfs responses (guest errnos, independent of
/// the daemon's OS).
pub mod errno {
    pub const EIO: i64 = 5;
    pub const EAGAIN: i64 = 11;
    pub const ENOSYS: i64 = 38;
}

/// Answer to one sandboxfs RPC request (`fs_response` payload).
#[derive(Debug, Clone, PartialEq)]
pub struct FsReply {
    /// errno (0 = success)
    pub err: i64,
    /// result map (`res`)
    pub res: Option<Value>,
    /// error detail (`message`)
    pub message: Option<String>,
}

impl FsReply {
    pub fn error(err: i64, message: impl Into<String>) -> Self {
        FsReply { err, res: None, message: Some(message.into()) }
    }

    pub fn ok(res: Value) -> Self {
        FsReply { err: 0, res: Some(res), message: None }
    }
}

/// Host side of the guest filesystem.
pub trait VfsBackend: Send + Sync + 'static {
    /// Handles one sandboxfs request (`op` and its `req` map). Requests of one
    /// guest connection arrive one at a time.
    fn handle<'a>(&'a self, op: &'a str, req: Value) -> crate::BoxFuture<'a, FsReply>;
    /// Releases resources at session shutdown.
    fn close<'a>(&'a self) -> crate::BoxFuture<'a, ()> {
        Box::pin(async move {})
    }

    /// The same filesystem over virtio-fs (vhost-user-fs), when the backend
    /// offers it; the session decides whether the VMM can use it.
    fn virtio_fs(&self) -> Option<Arc<dyn VirtioFsService>> {
        None
    }
}

/// A virtio-fs device backend: vhost-user-fs (QEMU) or FUSE over a socket
/// (libkrun with gondolin's patch).
pub trait VirtioFsService: Send + Sync + 'static {
    /// Serves one vhost-user connection until the frontend disconnects
    /// (blocking; runs on its own thread).
    fn serve(&self, conn: std::os::unix::net::UnixStream);
    /// Serves one FUSE-over-socket connection (`gondolin_virtiofs::socket`)
    /// until the VMM disconnects (blocking; runs on its own thread).
    fn serve_socket(&self, conn: std::os::unix::net::UnixStream);
    /// Number of request queues (the device also has a high-priority queue).
    fn request_queues(&self) -> usize;
    /// Whether the controller insists on virtio-fs (warn when unavailable).
    fn required(&self) -> bool {
        false
    }
}

/// Host side of the guest network.
pub trait NetBackend: Send + Sync + 'static {
    /// Serves one QEMU stream-netdev connection until it closes. A new
    /// connection (QEMU restart) is served by a new call; the previous one is
    /// dropped first.
    fn serve<'a>(&'a self, stream: UnixStream) -> crate::BoxFuture<'a, ()>;
    /// Serves raw frames (Firecracker: a packet socket on the VM's tap) until
    /// the socket fails or the future is dropped.
    fn serve_frames<'a>(
        &'a self,
        socket: Arc<dyn gondolin_netstack::FrameSocket>,
    ) -> crate::BoxFuture<'a, ()>;
    /// Releases resources at session shutdown.
    fn close<'a>(&'a self) -> crate::BoxFuture<'a, ()> {
        Box::pin(async move {})
    }
    /// The guest's address, gateway and DNS servers (what DHCP would hand
    /// out) as a kernel command line argument for its init, which then skips
    /// DHCP (~40 ms of busybox udhcpc per boot); see [`crate::net::guest_net_arg`].
    fn guest_net_arg(&self) -> Option<String> {
        None
    }
}

/// Network attachment of the VM.
#[derive(Clone)]
pub enum NetSetup {
    /// no network device
    None,
    /// served in the daemon
    Native(Arc<dyn NetBackend>),
}

/// What subsystems get to wire themselves up.
pub struct SubsystemContext {
    pub ctl: Arc<Controller>,
    pub dispatcher: Dispatcher,
    pub activity: ActivityHandle,
    /// enabled debug components
    pub debug: Vec<String>,
}

impl SubsystemContext {
    pub fn debug_enabled(&self, flag: &str) -> bool {
        self.debug.iter().any(|f| f == flag)
    }
}

/// Builds the VFS backend for `configure.vfs`.
///
/// Modes:
/// - absent/`null`: no backend (requests fail with `ENOSYS`, `vfs: null`)
/// - `{ mode: "native", fuse_mount, binds, mounts, hooks }`: the mount table of
///   `gondolin-vfs` ([`gondolin_proto::vfs::VfsConfig`], `crate::vfs`)
pub fn build_vfs(
    config: Option<&Value>,
    ctx: &SubsystemContext,
) -> Result<Option<Arc<dyn VfsBackend>>, String> {
    let Some(config) = config.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    match Fields::of(config).text("mode") {
        Some("native") => crate::vfs::build(config, ctx).map(Some),
        Some(other) => Err(format!("unsupported vfs mode: {other}")),
        None => Err("vfs configuration requires a mode".into()),
    }
}

/// Builds the network attachment for `configure.net`.
///
/// Modes:
/// - absent/`null`: no network device
/// - `{ mode: "native", ... }`: served in the daemon ([`crate::net`])
pub fn build_net(config: Option<&Value>, ctx: &SubsystemContext) -> Result<NetSetup, String> {
    let Some(config) = config.filter(|v| !v.is_null()) else {
        return Ok(NetSetup::None);
    };
    match Fields::of(config).text("mode") {
        Some("native") => crate::net::build_native(config, ctx),
        Some(other) => Err(format!("unsupported net mode: {other}")),
        None => Err("net configuration requires a mode".into()),
    }
}

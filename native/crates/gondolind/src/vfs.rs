//! Native VFS (`configure.vfs.mode = "native"`): the mount table of
//! `gondolin-vfs` serves the guest's sandboxfs requests in the daemon.
//!
//! - object-tier mounts and `before` hooks call the controller
//!   (`vfs_call`, `vfs_hook`);
//! - `vfs_event`s are sent asynchronously when the controller asked for them;
//! - the controller sends `vfs_invalidate` and `fs_call` (controller fs API).
//!
//! Controller handlers run inline in the controller reader, so anything that
//! may itself wait for the controller (`fs_call` through an object mount or a
//! hook) is spawned.

use std::sync::Arc;

use async_trait::async_trait;
use gondolin_proto::vfs::{
    FsCall, HookContext, VfsCall, VfsCallResult, VfsConfig, VfsInvalidate, types,
};
use gondolin_vfs::{EventSink, ObjectBackend, VfsError, VfsResult, VfsService, errno};
use gondolin_wire::{RawEnvelope, Value};

use crate::controller::{CallError, Controller, ControllerHandler};
use crate::subsystem::{FsReply, SubsystemContext, VfsBackend, VirtioFsService};
use gondolin_proto::vfs::VfsTransport;
use gondolin_vfs::virtiofs::VirtioFs;
use gondolin_virtiofs::fuse::{CachePolicy, FuseServer};

/// Forwards object-tier calls and hooks to the controller.
struct ControllerObjects {
    ctl: Arc<Controller>,
}

fn call_error(e: CallError) -> VfsError {
    match e {
        CallError::Remote(r) => VfsError::from_code(&r.code, Some(r.message)),
        other => VfsError::new(errno::EIO, other.to_string()),
    }
}

#[async_trait]
impl ObjectBackend for ControllerObjects {
    async fn call(&self, call: VfsCall) -> VfsResult<VfsCallResult> {
        let result = self.ctl.request(types::VFS_CALL, &call).await.map_err(call_error)?;
        let result: VfsCallResult = gondolin_wire::from_value(result)
            .map_err(|e| VfsError::new(errno::EIO, format!("invalid vfs_call_result: {e}")))?;
        gondolin_vfs::call_result(result)
    }

    async fn before_hook(&self, ctx: &HookContext) -> VfsResult<()> {
        self.ctl.request(types::VFS_HOOK, ctx).await.map(|_| ()).map_err(call_error)
    }
}

/// The native VFS backend of a session.
pub struct NativeVfs {
    service: Arc<VfsService>,
    transport: VfsTransport,
    virtio_fs: std::sync::OnceLock<Arc<VirtioFsDevice>>,
    queues: usize,
}

/// The mount table as a vhost-user-fs backend.
struct VirtioFsDevice {
    server: Arc<FuseServer<VirtioFs>>,
    queues: usize,
    required: bool,
}

impl VirtioFsService for VirtioFsDevice {
    fn serve(&self, conn: std::os::unix::net::UnixStream) {
        // queue 0: high priority (FORGET etc.), 1..: requests
        let mut backend =
            gondolin_virtiofs::vhost_user::Backend::new(self.server.clone(), 1 + self.queues);
        if let Err(e) = backend.serve(conn) {
            tracing::debug!("virtio-fs: connection ended: {e}");
        }
    }

    fn request_queues(&self) -> usize {
        self.queues
    }

    fn required(&self) -> bool {
        self.required
    }
}

#[async_trait]
impl VfsBackend for NativeVfs {
    async fn handle(&self, op: &str, req: Value) -> FsReply {
        let reply = self.service.request(op, &req).await;
        FsReply { err: reply.err as i64, res: reply.res, message: reply.message }
    }

    async fn close(&self) {
        self.service.close().await;
    }

    fn virtio_fs(&self) -> Option<Arc<dyn VirtioFsService>> {
        if self.transport == VfsTransport::Sandboxfs {
            return None;
        }
        let rt = tokio::runtime::Handle::try_current().ok()?;
        let device = self.virtio_fs.get_or_init(|| {
            let fs = VirtioFs::new(self.service.core().clone(), rt).with_lookup_hook(|name| {
                if name == "gondolind-test-panic" {
                    crate::panics::test_panic(crate::panics::TestPanic::Vfs);
                }
            });
            // same TTLs as the sandboxfs RPC replies
            let mut server = FuseServer::new(fs, CachePolicy { entry_secs: 1, attr_secs: 1 });
            // FLUSH carries object-tier commit errors to the guest's close()
            server.flush = self.service.has_buffered_mounts();
            Arc::new(VirtioFsDevice {
                server: Arc::new(server),
                queues: self.queues,
                required: self.transport == VfsTransport::Virtiofs,
            })
        });
        Some(device.clone() as Arc<dyn VirtioFsService>)
    }
}

struct FsCallHandler {
    service: Arc<VfsService>,
}

#[async_trait]
impl ControllerHandler for FsCallHandler {
    async fn handle(&self, msg: RawEnvelope, ctl: &Arc<Controller>) {
        let call: FsCall = match msg.payload() {
            Ok(call) => call,
            Err(e) => {
                ctl.reply_err(&msg.t, msg.id, "invalid_request", &e.to_string());
                return;
            }
        };
        let service = self.service.clone();
        let ctl = ctl.clone();
        tokio::spawn(async move {
            let result = service.controller_call(call).await;
            ctl.send(types::FS_CALL_RESULT, msg.id, &result);
        });
    }
}

struct InvalidateHandler {
    service: Arc<VfsService>,
}

#[async_trait]
impl ControllerHandler for InvalidateHandler {
    async fn handle(&self, msg: RawEnvelope, ctl: &Arc<Controller>) {
        let inv: VfsInvalidate = match msg.payload() {
            Ok(inv) => inv,
            Err(e) => {
                ctl.reply_err(&msg.t, msg.id, "invalid_request", &e.to_string());
                return;
            }
        };
        match self.service.invalidate(inv.mount_id, inv.path.as_deref()) {
            Ok(()) => {
                if msg.id != 0 {
                    ctl.reply_ok(&msg.t, msg.id, vec![]);
                }
            }
            Err(e) => {
                if msg.id != 0 {
                    ctl.reply_err(&msg.t, msg.id, &e.code(), &e.message);
                }
            }
        }
    }
}

/// Builds the native VFS from `configure.vfs` (`mode: "native"`).
pub fn build(config: &Value, ctx: &SubsystemContext) -> Result<Arc<dyn VfsBackend>, String> {
    let cfg: VfsConfig = gondolin_wire::from_value(config.clone())
        .map_err(|e| format!("invalid vfs config: {e}"))?;
    let backend: Arc<dyn ObjectBackend> = Arc::new(ControllerObjects { ctl: ctx.ctl.clone() });
    let events = if cfg.hooks.events {
        let (sink, mut rx) = EventSink::channel(gondolin_vfs::EVENT_QUEUE);
        let ctl = ctx.ctl.clone();
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                if !ctl.send(types::VFS_EVENT, 0, &event) {
                    break;
                }
            }
        });
        sink
    } else {
        EventSink::none()
    };
    let service =
        Arc::new(VfsService::new(&cfg, backend, events).map_err(|e| format!("vfs: {e}"))?);
    ctx.dispatcher.register(types::FS_CALL, Arc::new(FsCallHandler { service: service.clone() }));
    ctx.dispatcher
        .register(types::VFS_INVALIDATE, Arc::new(InvalidateHandler { service: service.clone() }));
    let queues = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(1, 4);
    Ok(Arc::new(NativeVfs {
        service,
        transport: cfg.transport,
        virtio_fs: std::sync::OnceLock::new(),
        queues,
    }))
}

//! Host side of the guest filesystem (`guest/ARCHITECTURE.md` §6) for gondolind.
//!
//! - [`VfsService`] owns the mount table (built from `configure.vfs`), serves
//!   the guest's `virtio-fs` port ([`VfsService::serve`]) and the controller fs
//!   API ([`VfsService::controller_call`]).
//! - Native providers: [`host::HostProvider`] (hardened passthrough),
//!   [`memory::MemoryProvider`] (also `static` mounts), wrapped by
//!   [`layers`] (read-only, hide rules) and routed by [`router::MountRouter`].
//! - The object tier ([`object::ObjectProvider`]) caches whole-file providers
//!   that live in the controller and reaches them through [`ObjectBackend`],
//!   which gondolind implements by forwarding `vfs_call`s.
//! - [`hooks`] emits `vfs_event`s and runs the controller's blocking `before`
//!   hook.

pub mod core;
pub mod error;
pub mod hooks;
pub mod host;
pub mod layers;
pub mod memory;
pub mod object;
pub mod provider;
pub mod router;
pub mod rpc;
#[cfg(test)]
mod rpc_tests;
pub mod types;
pub mod virtiofs;
#[cfg(test)]
mod virtiofs_tests;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use gondolin_proto::vfs::{
    FsCall, FsCallResult, HookContext, MountConfig, MountLayer, MountSource, ObjectDirEntry,
    VfsCall, VfsCallResult, VfsConfig,
};
use serde_bytes::ByteBuf;
use tokio::io::{AsyncRead, AsyncWrite};

pub use error::{VfsError, VfsResult, errno};
pub use hooks::EventSink;
use provider::{DynProvider, Handle};
use router::{Mount, MountRouter};
use rpc::{MountsInfo, ReaddirCache, RpcSession};
use types::{OpenFlags, vpath};

/// The controller side of the object tier and of `before` hooks.
///
/// gondolind implements it by sending `vfs_call` / `vfs_hook` requests over
/// the controller pipe. `call` returns only successful results (`ok: true`);
/// failures are errors carrying the errno.
#[async_trait]
pub trait ObjectBackend: Send + Sync + 'static {
    async fn call(&self, call: VfsCall) -> VfsResult<VfsCallResult>;

    /// Blocking `before` hook; an error denies the operation.
    async fn before_hook(&self, _ctx: &HookContext) -> VfsResult<()> {
        Ok(())
    }
}

/// Backend for configurations without object mounts or hooks.
pub struct NoBackend;

#[async_trait]
impl ObjectBackend for NoBackend {
    async fn call(&self, call: VfsCall) -> VfsResult<VfsCallResult> {
        Err(VfsError::new(errno::ENOSYS, format!("no object backend for mount {}", call.mount_id)))
    }
}

/// Converts a wire result into a `Result` (`ok: false` → errno error).
pub fn call_result(result: VfsCallResult) -> VfsResult<VfsCallResult> {
    if result.ok {
        Ok(result)
    } else {
        Err(VfsError::from_code(result.code.as_deref().unwrap_or("EIO"), result.message.clone()))
    }
}

#[cfg(test)]
pub(crate) async fn test_timeout<T>(f: impl Future<Output = T>) -> T {
    tokio::time::timeout(std::time::Duration::from_secs(20), f).await.expect("test timed out")
}

/// Default capacity of the `vfs_event` queue.
pub const EVENT_QUEUE: usize = 4096;

/// The daemon's VFS: mount table, guest RPC session and controller fs API.
pub struct VfsService {
    router: Arc<MountRouter>,
    /// router wrapped with hooks
    root: DynProvider,
    objects: HashMap<u32, Arc<object::ObjectProvider>>,
    core: Arc<core::FsCore>,
    rpc: RpcSession,
    readdir: Arc<Mutex<ReaddirCache>>,
    fs_handles: Mutex<HashMap<u64, Handle>>,
    next_fh: AtomicU64,
}

fn build_mount(
    cfg: &MountConfig,
    backend: &Arc<dyn ObjectBackend>,
    objects: &mut HashMap<u32, Arc<object::ObjectProvider>>,
) -> VfsResult<DynProvider> {
    let mut provider: DynProvider = match &cfg.source {
        MountSource::Host { root } => Arc::new(host::HostProvider::new(root)?),
        MountSource::Memory {} => Arc::new(memory::MemoryProvider::new()),
        MountSource::Static { files } => Arc::new(memory::MemoryProvider::with_files(
            files.iter().map(|(p, d)| (p.as_str(), d.as_slice())),
        )?),
        MountSource::Object(o) => {
            if objects.contains_key(&o.mount_id) {
                return Err(VfsError::new(
                    errno::EINVAL,
                    format!("duplicate object mount id {}", o.mount_id),
                ));
            }
            let p = Arc::new(object::ObjectProvider::new(o.clone(), backend.clone()));
            objects.insert(o.mount_id, p.clone());
            p
        }
    };
    for layer in &cfg.layers {
        provider = match layer {
            MountLayer::Readonly {} => layers::readonly(provider),
            MountLayer::Hide(h) => {
                let deny = match &h.deny_write_errno {
                    Some(code) => errno::from_name(code).ok_or_else(|| {
                        VfsError::new(errno::EINVAL, format!("unknown errno {code}"))
                    })?,
                    None => errno::EACCES,
                };
                let mode = match h.write_mode {
                    gondolin_proto::vfs::HideWriteMode::Deny => layers::HideWriteMode::Deny,
                    gondolin_proto::vfs::HideWriteMode::Tmpfs => layers::HideWriteMode::Tmpfs,
                };
                Arc::new(layers::HideProvider::new(
                    provider,
                    &h.paths,
                    mode,
                    h.deny_symlink_bypass,
                    deny,
                ))
            }
        };
    }
    if cfg.readonly {
        provider = layers::readonly(provider);
    }
    Ok(provider)
}

fn fs_err(e: VfsError) -> FsCallResult {
    FsCallResult { ok: false, code: Some(e.code()), message: Some(e.message), ..Default::default() }
}

fn fs_ok() -> FsCallResult {
    FsCallResult { ok: true, ..Default::default() }
}

impl VfsService {
    /// Builds the mount table of `configure.vfs`.
    pub fn new(
        config: &VfsConfig,
        backend: Arc<dyn ObjectBackend>,
        events: EventSink,
    ) -> VfsResult<VfsService> {
        let mut objects = HashMap::new();
        let mut mounts = Vec::new();
        for m in &config.mounts {
            if !m.path.starts_with('/') || m.path.contains('\0') {
                return Err(VfsError::new(
                    errno::EINVAL,
                    format!("invalid mount path {:?}", m.path),
                ));
            }
            mounts.push(Mount {
                path: m.path.clone(),
                provider: build_mount(m, &backend, &mut objects)?,
            });
        }
        if mounts.is_empty() {
            mounts.push(Mount {
                path: "/".into(),
                provider: Arc::new(memory::MemoryProvider::new()),
            });
        }
        let before = if config.hooks.before { Some(backend.clone()) } else { None };
        let events = if config.hooks.events { events } else { EventSink::none() };
        let info = MountsInfo { mount: config.fuse_mount.clone(), binds: config.binds.clone() };
        Self::assemble(mounts, objects, Some(info), hooks::Hooks::new(before, events))
    }

    /// Builds a service from already constructed mounts (tests, embedding).
    pub fn from_mounts(
        mounts: Vec<Mount>,
        info: Option<MountsInfo>,
        hooks: hooks::Hooks,
    ) -> VfsResult<VfsService> {
        Self::assemble(mounts, HashMap::new(), info, hooks)
    }

    fn assemble(
        mounts: Vec<Mount>,
        objects: HashMap<u32, Arc<object::ObjectProvider>>,
        info: Option<MountsInfo>,
        hooks: hooks::Hooks,
    ) -> VfsResult<VfsService> {
        let router = Arc::new(MountRouter::new(mounts)?);
        let root = hooks::HookedProvider::wrap(router.clone(), hooks);
        let core = Arc::new(core::FsCore::new(root.clone(), router.clone()));
        let session = RpcSession::new(core.clone(), info);
        let readdir = core.readdir_cache();
        Ok(VfsService {
            router,
            root,
            objects,
            core,
            rpc: session,
            readdir,
            fs_handles: Mutex::new(HashMap::new()),
            next_fh: AtomicU64::new(1),
        })
    }

    /// Serves the guest's `virtio-fs` port until EOF. Inode and handle state
    /// survives reconnects (call `serve` again with the new stream).
    pub async fn serve<S: AsyncRead + AsyncWrite + Unpin>(
        &self,
        stream: S,
    ) -> Result<(), gondolin_wire::WireError> {
        let (r, w) = tokio::io::split(stream);
        let mut reader = gondolin_wire::FrameReader::new(r);
        let mut writer = gondolin_wire::FrameWriter::new(w);
        while let Some(frame) = reader.read_frame().await? {
            let Ok(value) = gondolin_wire::decode::<gondolin_wire::Value>(&frame) else {
                tracing::debug!("vfs: undecodable frame ({} bytes)", frame.len());
                continue;
            };
            // the session lock is held per request only
            let response = self.rpc.handle_message(&value).await;
            if let Some(response) = response {
                writer.write_message(&response).await?;
                writer.flush().await?;
            }
        }
        Ok(())
    }

    /// Handles one sandboxfs request (for embedders that own the framing,
    /// like gondolind's `virtio-fs` port). Requests run one at a time.
    pub async fn request(&self, op: &str, req: &gondolin_wire::Value) -> rpc::RpcReply {
        self.rpc.reply(op, req).await
    }

    /// Whether some mount buffers writes until close (object tier with
    /// `commit: close`), so FLUSH must reach the provider.
    pub fn has_buffered_mounts(&self) -> bool {
        self.objects.values().any(|o| o.commits_on_close())
    }

    /// The inode-level filesystem shared by the guest transports.
    pub fn core(&self) -> &Arc<core::FsCore> {
        &self.core
    }

    /// The mount router (for embedding and tests).
    pub fn router(&self) -> &Arc<MountRouter> {
        &self.router
    }

    /// Request counters of the guest session.
    pub async fn metrics(&self) -> rpc::Metrics {
        self.core.metrics()
    }

    /// `vfs_invalidate`: drops cached state of an object mount below `path`.
    pub fn invalidate(&self, mount_id: u32, path: Option<&str>) -> VfsResult<()> {
        let p = self.objects.get(&mount_id).ok_or_else(|| {
            VfsError::new(errno::ENOENT, format!("unknown object mount {mount_id}"))
        })?;
        p.invalidate_path(path);
        // guest listings below the mount may be stale as well
        self.readdir.lock().unwrap().clear();
        Ok(())
    }

    /// Keeps the guest's readdir snapshots consistent with controller
    /// mutations: `removed` paths disappear from continuations.
    fn invalidate_dirs(&self, paths: &[&str], removed: bool) {
        let mut cache = self.readdir.lock().unwrap();
        for p in paths {
            if removed {
                cache.removed(vpath::parent(p), vpath::basename(p));
                cache.forget_tree(p);
            } else {
                cache.changed(vpath::parent(p));
            }
        }
    }

    /// `fs_call`: the controller fs API on the mount table.
    pub async fn controller_call(&self, call: FsCall) -> FsCallResult {
        match self.controller_call_inner(call).await {
            Ok(r) => r,
            Err(e) => fs_err(e),
        }
    }

    async fn controller_call_inner(&self, call: FsCall) -> VfsResult<FsCallResult> {
        let n = |p: &str| vpath::normalize(p);
        let root = &self.root;
        Ok(match call {
            FsCall::Stat { path, follow } => {
                let a = if follow {
                    root.stat(&n(&path)).await?
                } else {
                    root.lstat(&n(&path)).await?
                };
                FsCallResult { stat: Some(a.to_fs_stat()), ..fs_ok() }
            }
            FsCall::Readdir { path } => {
                let p = n(&path);
                let mut entries = Vec::new();
                for e in root.readdir(&p).await? {
                    let kind = match e.kind {
                        Some(k) => k,
                        None => match root
                            .lstat(&vpath::join(&p, &e.name))
                            .await
                            .ok()
                            .and_then(|a| a.kind())
                        {
                            Some(k) => k,
                            None => types::EntryKind::File,
                        },
                    };
                    entries.push(ObjectDirEntry { name: e.name, kind });
                }
                FsCallResult { entries: Some(entries), ..fs_ok() }
            }
            FsCall::Access { path, mask } => {
                let p = n(&path);
                match root.access(&p, mask).await {
                    Err(e) if e.is(errno::ENOSYS) => {
                        root.stat(&p).await?;
                        if mask & 2 != 0 && self.router.readonly_at(&p) {
                            return Err(VfsError::op(errno::EROFS, "access", &p));
                        }
                    }
                    r => r?,
                }
                fs_ok()
            }
            FsCall::Mkdir { path, mode, recursive } => {
                let p = n(&path);
                root.mkdir(&p, mode.unwrap_or(0o755), recursive).await?;
                self.invalidate_dirs(&[&p], false);
                fs_ok()
            }
            FsCall::Rmdir { path } => {
                let p = n(&path);
                root.rmdir(&p).await?;
                self.invalidate_dirs(&[&p], true);
                fs_ok()
            }
            FsCall::Unlink { path } => {
                let p = n(&path);
                root.unlink(&p).await?;
                self.invalidate_dirs(&[&p], true);
                fs_ok()
            }
            FsCall::Rename { from, to } => {
                let (a, b) = (n(&from), n(&to));
                root.rename(&a, &b).await?;
                self.invalidate_dirs(&[&a, &b], true);
                self.invalidate_dirs(&[&b], false);
                fs_ok()
            }
            FsCall::Chmod { path, mode } => {
                root.chmod(&n(&path), mode & 0o7777).await?;
                fs_ok()
            }
            FsCall::Truncate { path, size } => {
                root.truncate(&n(&path), size).await?;
                fs_ok()
            }
            FsCall::Readlink { path } => {
                FsCallResult { target: Some(root.readlink(&n(&path)).await?), ..fs_ok() }
            }
            FsCall::Symlink { target, path } => {
                let p = n(&path);
                root.symlink(&target, &p).await?;
                self.invalidate_dirs(&[&p], false);
                fs_ok()
            }
            FsCall::Realpath { path } => {
                FsCallResult { target: Some(root.realpath(&n(&path)).await?), ..fs_ok() }
            }
            FsCall::Open { path, flags, mode } => {
                let p = n(&path);
                let f = OpenFlags::parse(&flags)
                    .ok_or_else(|| VfsError::op(errno::EINVAL, "open", &p))?;
                let handle = root.open(&p, f, mode.unwrap_or(0o644)).await?;
                if f.create {
                    self.invalidate_dirs(&[&p], false);
                }
                let fh = self.next_fh.fetch_add(1, Ordering::Relaxed);
                self.fs_handles.lock().unwrap().insert(fh, handle);
                FsCallResult { fh: Some(fh), ..fs_ok() }
            }
            FsCall::Read { fh, offset, length } => {
                let handle = self.fs_handle(fh)?;
                let len = (length as usize).min(gondolin_wire::MAX_FRAME - 64 * 1024);
                let data = handle.read(offset, len).await?;
                FsCallResult { data: Some(ByteBuf::from(data)), ..fs_ok() }
            }
            FsCall::Write { fh, offset, data } => {
                let handle = self.fs_handle(fh)?;
                let mut written = 0;
                while written < data.len() {
                    let n = handle.write(offset + written as u64, &data[written..]).await?;
                    if n == 0 {
                        return Err(VfsError::op(errno::EIO, "write", ""));
                    }
                    written += n;
                }
                FsCallResult { size: Some(written as u64), ..fs_ok() }
            }
            FsCall::Close { fh } => {
                let handle = self
                    .fs_handles
                    .lock()
                    .unwrap()
                    .remove(&fh)
                    .ok_or_else(|| VfsError::op(errno::EBADF, "close", ""))?;
                handle.close().await?;
                fs_ok()
            }
        })
    }

    fn fs_handle(&self, fh: u64) -> VfsResult<Handle> {
        self.fs_handles
            .lock()
            .unwrap()
            .get(&fh)
            .cloned()
            .ok_or_else(|| VfsError::op(errno::EBADF, "fh", ""))
    }

    /// Closes guest and controller handles (committing dirty object files)
    /// and releases providers.
    pub async fn close(&self) {
        self.rpc.close().await;
        let handles: Vec<Handle> =
            self.fs_handles.lock().unwrap().drain().map(|(_, h)| h).collect();
        for h in handles {
            let _ = h.close().await;
        }
        self.root.close().await;
    }
}

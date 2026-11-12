//! Controller hooks around the mount table, replacing the node engine's
//! `SandboxVfsProvider` `before`/`after` hooks: a blocking `before` callback
//! (only when the controller registered one) and asynchronous, bounded,
//! non-blocking `vfs_event` notifications.
//!
//! The hooked operations and their contexts match `SandboxVfsProvider`: path
//! ops `open`, `stat`, `lstat`, `readdir`, `mkdir`, `rmdir`, `unlink`,
//! `rename`, `link`, `chmod`, `truncate`, `statfs` and handle ops `read`,
//! `write`, `stat`, `truncate`, `release`.

use crate::BoxFuture;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use gondolin_proto::vfs::{HookContext, VfsEvent};
use tokio::sync::mpsc;

use crate::ObjectBackend;
use crate::error::VfsResult;
use crate::provider::{DynProvider, FileHandle, Handle, Provider};
use crate::types::{Attr, DirEntry, OpenFlags, StatFs};

/// Bounded, non-blocking sink for `vfs_event`s. Events that do not fit are
/// dropped and counted.
#[derive(Clone, Default)]
pub struct EventSink {
    tx: Option<mpsc::Sender<VfsEvent>>,
    dropped: Arc<AtomicU64>,
}

impl EventSink {
    /// A sink that discards everything.
    pub fn none() -> EventSink {
        EventSink::default()
    }

    /// A sink with a queue of `capacity` events and its receiver.
    pub fn channel(capacity: usize) -> (EventSink, mpsc::Receiver<VfsEvent>) {
        let (tx, rx) = mpsc::channel(capacity.max(1));
        (EventSink { tx: Some(tx), dropped: Arc::default() }, rx)
    }

    pub fn enabled(&self) -> bool {
        self.tx.is_some()
    }

    pub fn emit(&self, event: VfsEvent) {
        if let Some(tx) = &self.tx
            && tx.try_send(event).is_err()
        {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Number of events dropped because the queue was full.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

/// Hook dispatch shared by the wrapper and its handles.
pub struct Hooks {
    before: Option<Arc<dyn ObjectBackend>>,
    events: EventSink,
}

impl Hooks {
    pub fn new(before: Option<Arc<dyn ObjectBackend>>, events: EventSink) -> Hooks {
        Hooks { before, events }
    }

    pub fn active(&self) -> bool {
        self.before.is_some() || self.events.enabled()
    }

    async fn before(&self, ctx: &HookContext) -> VfsResult<()> {
        match &self.before {
            Some(backend) => backend.before_hook(ctx).await,
            None => Ok(()),
        }
    }

    fn after<T>(&self, ctx: HookContext, result: &VfsResult<T>, bytes: Option<u64>) {
        if self.events.enabled() {
            self.events.emit(VfsEvent {
                ctx,
                error: result.as_ref().err().map(|e| e.code()),
                bytes: if result.is_ok() { bytes } else { None },
            });
        }
    }

    async fn run<T>(
        &self,
        ctx: HookContext,
        fut: impl Future<Output = VfsResult<T>>,
    ) -> VfsResult<T> {
        self.before(&ctx).await?;
        let result = fut.await;
        self.after(ctx, &result, None);
        result
    }
}

fn ctx(op: &str, path: &str) -> HookContext {
    HookContext { op: op.into(), path: Some(path.into()), ..Default::default() }
}

/// Wraps a provider (normally the mount router) with hooks.
pub struct HookedProvider {
    inner: DynProvider,
    hooks: Arc<Hooks>,
}

impl HookedProvider {
    /// Returns `inner` unchanged when no hook is active.
    pub fn wrap(inner: DynProvider, hooks: Hooks) -> DynProvider {
        if !hooks.active() {
            return inner;
        }
        Arc::new(HookedProvider { inner, hooks: Arc::new(hooks) })
    }
}

impl Provider for HookedProvider {
    fn readonly(&self) -> bool {
        self.inner.readonly()
    }

    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move { self.hooks.run(ctx("lstat", path), self.inner.lstat(path)).await })
    }

    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move { self.hooks.run(ctx("stat", path), self.inner.stat(path)).await })
    }

    fn readdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Vec<DirEntry>>> {
        Box::pin(
            async move { self.hooks.run(ctx("readdir", path), self.inner.readdir(path)).await },
        )
    }

    fn open<'a>(
        &'a self,
        path: &'a str,
        flags: OpenFlags,
        mode: u32,
    ) -> BoxFuture<'a, VfsResult<Handle>> {
        Box::pin(async move {
            let c = HookContext {
                flags: Some(flags.as_node_str().into()),
                mode: Some(mode),
                ..ctx("open", path)
            };
            let handle = self.hooks.run(c, self.inner.open(path, flags, mode)).await?;
            Ok::<Handle, crate::VfsError>(Arc::new(HookedHandle {
                inner: handle,
                hooks: self.hooks.clone(),
                path: path.to_string(),
                append: flags.append,
            }))
        })
    }

    fn mkdir<'a>(
        &'a self,
        path: &'a str,
        mode: u32,
        recursive: bool,
    ) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let c = HookContext { mode: Some(mode), ..ctx("mkdir", path) };
            self.hooks.run(c, self.inner.mkdir(path, mode, recursive)).await
        })
    }

    fn rmdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { self.hooks.run(ctx("rmdir", path), self.inner.rmdir(path)).await })
    }

    fn unlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { self.hooks.run(ctx("unlink", path), self.inner.unlink(path)).await })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let c = HookContext {
                op: "rename".into(),
                old_path: Some(from.into()),
                new_path: Some(to.into()),
                ..Default::default()
            };
            self.hooks.run(c, self.inner.rename(from, to)).await
        })
    }

    fn link<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let c = HookContext {
                op: "link".into(),
                old_path: Some(from.into()),
                new_path: Some(to.into()),
                ..Default::default()
            };
            self.hooks.run(c, self.inner.link(from, to)).await
        })
    }

    fn symlink<'a>(&'a self, target: &'a str, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { self.inner.symlink(target, path).await })
    }

    fn readlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<String>> {
        Box::pin(async move { self.inner.readlink(path).await })
    }

    fn chmod<'a>(&'a self, path: &'a str, mode: u32) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let c = HookContext { mode: Some(mode), ..ctx("chmod", path) };
            self.hooks.run(c, self.inner.chmod(path, mode)).await
        })
    }

    fn truncate<'a>(&'a self, path: &'a str, size: u64) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let c = HookContext { size: Some(size), ..ctx("truncate", path) };
            self.hooks.run(c, self.inner.truncate(path, size)).await
        })
    }

    fn access<'a>(&'a self, path: &'a str, mask: u32) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { self.inner.access(path, mask).await })
    }

    fn utimes<'a>(
        &'a self,
        path: &'a str,
        atime_ms: Option<Option<i64>>,
        mtime_ms: Option<Option<i64>>,
    ) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { self.inner.utimes(path, atime_ms, mtime_ms).await })
    }

    fn statfs<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<StatFs>> {
        Box::pin(async move { self.hooks.run(ctx("statfs", path), self.inner.statfs(path)).await })
    }

    fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<String>> {
        Box::pin(async move { self.inner.realpath(path).await })
    }

    fn invalidate(&self, path: Option<&str>) {
        self.inner.invalidate(path)
    }

    fn close<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move { self.inner.close().await })
    }
}

struct HookedHandle {
    inner: Handle,
    hooks: Arc<Hooks>,
    path: String,
    append: bool,
}

impl FileHandle for HookedHandle {
    fn read<'a>(&'a self, offset: u64, len: usize) -> BoxFuture<'a, VfsResult<Vec<u8>>> {
        Box::pin(async move {
            let c = HookContext {
                offset: Some(offset),
                length: Some(len as u64),
                ..ctx("read", &self.path)
            };
            self.hooks.before(&c).await?;
            let result = self.inner.read(offset, len).await;
            let bytes = result.as_ref().ok().map(|d| d.len() as u64);
            self.hooks.after(c, &result, bytes);
            result
        })
    }

    fn write<'a>(&'a self, offset: u64, data: &'a [u8]) -> BoxFuture<'a, VfsResult<usize>> {
        Box::pin(async move {
            // appends carry no offset, like the node engine's `position: null`
            let c = HookContext {
                offset: if self.append { None } else { Some(offset) },
                length: Some(data.len() as u64),
                ..ctx("write", &self.path)
            };
            self.hooks.before(&c).await?;
            let result = self.inner.write(offset, data).await;
            let bytes = result.as_ref().ok().map(|n| *n as u64);
            self.hooks.after(c, &result, bytes);
            result
        })
    }

    fn stat<'a>(&'a self) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move { self.hooks.run(ctx("stat", &self.path), self.inner.stat()).await })
    }

    fn truncate<'a>(&'a self, size: u64) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let c = HookContext { size: Some(size), ..ctx("truncate", &self.path) };
            self.hooks.run(c, self.inner.truncate(size)).await
        })
    }

    fn sync<'a>(&'a self) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { self.inner.sync().await })
    }

    fn flush<'a>(&'a self) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { self.inner.flush().await })
    }

    fn wants_flush(&self) -> bool {
        self.inner.wants_flush()
    }

    fn close<'a>(&'a self) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let c = ctx("release", &self.path);
            if let Err(e) = self.hooks.before(&c).await {
                // a denied release must not leak the handle
                let _ = self.inner.close().await;
                return Err(e);
            }
            let result = self.inner.close().await;
            self.hooks.after(c, &result, None);
            result
        })
    }
}

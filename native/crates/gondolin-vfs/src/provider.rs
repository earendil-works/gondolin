//! The path-based provider interface every mount kind implements (the native
//! counterpart of the node engine's `VirtualProvider`).
//!
//! Paths are normalized absolute paths relative to the provider's root.
//! Operations that the provider does not support return `ENOSYS`.

use crate::BoxFuture;
use std::sync::Arc;

use crate::error::{VfsError, VfsResult, errno};
use crate::types::{Attr, DirEntry, OpenFlags, StatFs};

/// An open file.
pub trait FileHandle: Send + Sync {
    /// Reads up to `len` bytes at `offset`; shorter only at end of file.
    fn read<'a>(&'a self, offset: u64, len: usize) -> BoxFuture<'a, VfsResult<Vec<u8>>>;
    /// Blocking read straight into `bufs` for callers on their own threads
    /// (virtio-fs queues); `None` when the handle has no such fast path.
    fn read_vectored_sync(
        &self,
        _offset: u64,
        _bufs: &mut [&mut [u8]],
    ) -> Option<VfsResult<usize>> {
        None
    }
    /// Blocking write of `data` without copying it, for callers on their own
    /// threads (virtio-fs queues); `None` when the handle has no fast path.
    fn write_sync(&self, _offset: u64, _data: &[u8]) -> Option<VfsResult<usize>> {
        None
    }
    /// Writes `data` at `offset` (append handles write at the end).
    fn write<'a>(&'a self, offset: u64, data: &'a [u8]) -> BoxFuture<'a, VfsResult<usize>>;
    fn stat<'a>(&'a self) -> BoxFuture<'a, VfsResult<Attr>>;
    fn truncate<'a>(&'a self, size: u64) -> BoxFuture<'a, VfsResult<()>>;
    /// Makes written data durable (`fsync`; object tier: commit).
    fn sync<'a>(&'a self) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { Ok(()) })
    }
    /// A file descriptor of the handle was closed (`FLUSH`): buffering
    /// providers commit here so the error reaches the guest's `close()`.
    fn flush<'a>(&'a self) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { Ok(()) })
    }
    /// Whether [`flush`](Self::flush) does anything: handles that don't are
    /// opened with `FOPEN_NOFLUSH` over sandboxfs, so `close()` costs no
    /// round trip to the host.
    fn wants_flush(&self) -> bool {
        false
    }
    /// Releases the handle; commit failures of buffering providers surface here.
    fn close<'a>(&'a self) -> BoxFuture<'a, VfsResult<()>>;
}

pub type Handle = Arc<dyn FileHandle>;

pub trait Provider: Send + Sync + 'static {
    /// Every mutation fails with `EROFS` (`VirtualProvider.readonly`).
    fn readonly(&self) -> bool {
        false
    }

    /// Metadata without following a final symlink.
    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Attr>>;

    /// Metadata following symlinks.
    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move { self.lstat(path).await })
    }

    fn readdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Vec<DirEntry>>>;

    /// Opens (and with `flags.create` creates) a file; `mode` applies to new files.
    fn open<'a>(
        &'a self,
        path: &'a str,
        flags: OpenFlags,
        mode: u32,
    ) -> BoxFuture<'a, VfsResult<Handle>>;

    fn mkdir<'a>(
        &'a self,
        path: &'a str,
        mode: u32,
        recursive: bool,
    ) -> BoxFuture<'a, VfsResult<()>>;

    fn rmdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<()>>;

    fn unlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<()>>;

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, VfsResult<()>>;

    /// Hard link `to` → `from`.
    fn link<'a>(&'a self, from: &'a str, _to: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { Err(VfsError::op(errno::ENOSYS, "link", from)) })
    }

    fn symlink<'a>(&'a self, _target: &'a str, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { Err(VfsError::op(errno::ENOSYS, "symlink", path)) })
    }

    fn readlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<String>> {
        Box::pin(async move { Err(VfsError::op(errno::ENOSYS, "readlink", path)) })
    }

    fn chmod<'a>(&'a self, path: &'a str, _mode: u32) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { Err(VfsError::op(errno::ENOSYS, "chmod", path)) })
    }

    /// Sets times in `ms` since the epoch (`Some(None)`: now; `None`: unchanged).
    fn utimes<'a>(
        &'a self,
        path: &'a str,
        _atime_ms: Option<Option<i64>>,
        _mtime_ms: Option<Option<i64>>,
    ) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { Err(VfsError::op(errno::ENOSYS, "utimes", path)) })
    }

    /// Path truncate; the default opens the file read-write and truncates.
    fn truncate<'a>(&'a self, path: &'a str, size: u64) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let handle = self.open(path, OpenFlags::READ_WRITE, 0o644).await?;
            let result = handle.truncate(size).await;
            let closed = handle.close().await;
            result.and(closed)
        })
    }

    /// Permission check with the daemon's credentials; `ENOSYS` makes the RPC
    /// layer fall back to a mode-bit check.
    fn access<'a>(&'a self, path: &'a str, _mask: u32) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move { Err(VfsError::op(errno::ENOSYS, "access", path)) })
    }

    fn statfs<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<StatFs>> {
        Box::pin(async move { Err(VfsError::op(errno::ENOSYS, "statfs", path)) })
    }

    /// Resolves symlinks inside the provider (used for hide rules).
    fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<String>> {
        Box::pin(async move { Ok(path.to_string()) })
    }

    /// Drops cached state below `path` (object tier; no-op elsewhere).
    fn invalidate(&self, _path: Option<&str>) {}

    /// Releases provider resources.
    fn close<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move {})
    }
}

pub type DynProvider = Arc<dyn Provider>;

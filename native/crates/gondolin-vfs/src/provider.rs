//! The path-based provider interface every mount kind implements (the native
//! counterpart of the node engine's `VirtualProvider`).
//!
//! Paths are normalized absolute paths relative to the provider's root.
//! Operations that the provider does not support return `ENOSYS`.

use std::sync::Arc;

use async_trait::async_trait;

use crate::error::{VfsError, VfsResult, errno};
use crate::types::{Attr, DirEntry, OpenFlags, StatFs};

/// An open file.
#[async_trait]
pub trait FileHandle: Send + Sync {
    /// Reads up to `len` bytes at `offset`; shorter only at end of file.
    async fn read(&self, offset: u64, len: usize) -> VfsResult<Vec<u8>>;
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
    async fn write(&self, offset: u64, data: &[u8]) -> VfsResult<usize>;
    async fn stat(&self) -> VfsResult<Attr>;
    async fn truncate(&self, size: u64) -> VfsResult<()>;
    /// Makes written data durable (`fsync`; object tier: commit).
    async fn sync(&self) -> VfsResult<()> {
        Ok(())
    }
    /// A file descriptor of the handle was closed (`FLUSH`): buffering
    /// providers commit here so the error reaches the guest's `close()`.
    async fn flush(&self) -> VfsResult<()> {
        Ok(())
    }
    /// Releases the handle; commit failures of buffering providers surface here.
    async fn close(&self) -> VfsResult<()>;
}

pub type Handle = Arc<dyn FileHandle>;

#[async_trait]
pub trait Provider: Send + Sync + 'static {
    /// Every mutation fails with `EROFS` (`VirtualProvider.readonly`).
    fn readonly(&self) -> bool {
        false
    }

    /// Metadata without following a final symlink.
    async fn lstat(&self, path: &str) -> VfsResult<Attr>;

    /// Metadata following symlinks.
    async fn stat(&self, path: &str) -> VfsResult<Attr> {
        self.lstat(path).await
    }

    async fn readdir(&self, path: &str) -> VfsResult<Vec<DirEntry>>;

    /// Opens (and with `flags.create` creates) a file; `mode` applies to new files.
    async fn open(&self, path: &str, flags: OpenFlags, mode: u32) -> VfsResult<Handle>;

    async fn mkdir(&self, path: &str, mode: u32, recursive: bool) -> VfsResult<()>;

    async fn rmdir(&self, path: &str) -> VfsResult<()>;

    async fn unlink(&self, path: &str) -> VfsResult<()>;

    async fn rename(&self, from: &str, to: &str) -> VfsResult<()>;

    /// Hard link `to` → `from`.
    async fn link(&self, from: &str, _to: &str) -> VfsResult<()> {
        Err(VfsError::op(errno::ENOSYS, "link", from))
    }

    async fn symlink(&self, _target: &str, path: &str) -> VfsResult<()> {
        Err(VfsError::op(errno::ENOSYS, "symlink", path))
    }

    async fn readlink(&self, path: &str) -> VfsResult<String> {
        Err(VfsError::op(errno::ENOSYS, "readlink", path))
    }

    async fn chmod(&self, path: &str, _mode: u32) -> VfsResult<()> {
        Err(VfsError::op(errno::ENOSYS, "chmod", path))
    }

    /// Sets times in `ms` since the epoch (`Some(None)`: now; `None`: unchanged).
    async fn utimes(
        &self,
        path: &str,
        _atime_ms: Option<Option<i64>>,
        _mtime_ms: Option<Option<i64>>,
    ) -> VfsResult<()> {
        Err(VfsError::op(errno::ENOSYS, "utimes", path))
    }

    /// Path truncate; the default opens the file read-write and truncates.
    async fn truncate(&self, path: &str, size: u64) -> VfsResult<()> {
        let handle = self.open(path, OpenFlags::READ_WRITE, 0o644).await?;
        let result = handle.truncate(size).await;
        let closed = handle.close().await;
        result.and(closed)
    }

    /// Permission check with the daemon's credentials; `ENOSYS` makes the RPC
    /// layer fall back to a mode-bit check.
    async fn access(&self, path: &str, _mask: u32) -> VfsResult<()> {
        Err(VfsError::op(errno::ENOSYS, "access", path))
    }

    async fn statfs(&self, path: &str) -> VfsResult<StatFs> {
        Err(VfsError::op(errno::ENOSYS, "statfs", path))
    }

    /// Resolves symlinks inside the provider (used for hide rules).
    async fn realpath(&self, path: &str) -> VfsResult<String> {
        Ok(path.to_string())
    }

    /// Drops cached state below `path` (object tier; no-op elsewhere).
    fn invalidate(&self, _path: Option<&str>) {}

    /// Releases provider resources.
    async fn close(&self) {}
}

pub type DynProvider = Arc<dyn Provider>;

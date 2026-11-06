//! Host side of the guest filesystem (`guest/ARCHITECTURE.md` §6) for gondolind.
//!
//! Seams (see `native/DESIGN.md`): [`ObjectBackend`] is implemented by gondolind
//! and forwards whole-file operations to the controller.

use async_trait::async_trait;
use bytes::Bytes;

/// File metadata as reported by an object-tier provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectStat {
    /// whether the entry is a directory
    pub is_dir: bool,
    /// file size in `bytes`
    pub size: u64,
    /// permission bits (`0o644` style, no file type bits)
    pub mode: u32,
    /// modification time in `ms` since the unix epoch
    pub mtime_ms: i64,
}

/// One directory entry from an object-tier provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectDirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Error of an object-tier operation, as a Linux errno name (`ENOENT`, `EACCES`, ...).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct ObjectError {
    pub code: String,
    pub message: String,
}

/// Whole-file operations of a controller-side provider, addressed by mount id
/// and a path relative to the mount (always starting with `/`).
#[async_trait]
pub trait ObjectBackend: Send + Sync + 'static {
    async fn stat(&self, mount_id: u32, path: &str) -> Result<ObjectStat, ObjectError>;
    async fn readdir(&self, mount_id: u32, path: &str) -> Result<Vec<ObjectDirEntry>, ObjectError>;
    /// Reads `length` bytes at `offset` (`None` = to the end of the file).
    async fn read_file(
        &self,
        mount_id: u32,
        path: &str,
        offset: u64,
        length: Option<u64>,
    ) -> Result<Bytes, ObjectError>;
    async fn write_file(&self, mount_id: u32, path: &str, data: Bytes) -> Result<(), ObjectError>;
    async fn unlink(&self, mount_id: u32, path: &str) -> Result<(), ObjectError>;
    async fn rename(&self, mount_id: u32, from: &str, to: &str) -> Result<(), ObjectError>;
    async fn mkdir(&self, mount_id: u32, path: &str) -> Result<(), ObjectError>;
    async fn rmdir(&self, mount_id: u32, path: &str) -> Result<(), ObjectError>;
    async fn truncate(&self, mount_id: u32, path: &str, size: u64) -> Result<(), ObjectError>;
}

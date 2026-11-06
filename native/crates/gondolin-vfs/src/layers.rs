//! Provider wrappers: read-only (`ReadonlyProvider`) and hide rules
//! (`ShadowProvider` with a `createShadowPathPredicate` predicate).

use std::sync::Arc;

use async_trait::async_trait;

use crate::error::{VfsError, VfsResult, errno};
use crate::memory::MemoryProvider;
use crate::provider::{DynProvider, Handle, Provider};
use crate::types::{Attr, DirEntry, OpenFlags, StatFs, vpath};

/// Rejects every mutation with `EROFS`.
pub struct ReadonlyProvider {
    inner: DynProvider,
}

impl ReadonlyProvider {
    pub fn new(inner: DynProvider) -> ReadonlyProvider {
        ReadonlyProvider { inner }
    }
}

fn erofs<T>(op: &str, path: &str) -> VfsResult<T> {
    Err(VfsError::op(errno::EROFS, op, path))
}

#[async_trait]
impl Provider for ReadonlyProvider {
    fn readonly(&self) -> bool {
        true
    }
    async fn lstat(&self, path: &str) -> VfsResult<Attr> {
        self.inner.lstat(path).await
    }
    async fn stat(&self, path: &str) -> VfsResult<Attr> {
        self.inner.stat(path).await
    }
    async fn readdir(&self, path: &str) -> VfsResult<Vec<DirEntry>> {
        self.inner.readdir(path).await
    }
    async fn open(&self, path: &str, flags: OpenFlags, mode: u32) -> VfsResult<Handle> {
        if flags.is_write() {
            return erofs("open", path);
        }
        self.inner.open(path, flags, mode).await
    }
    async fn mkdir(&self, path: &str, _mode: u32, _recursive: bool) -> VfsResult<()> {
        erofs("mkdir", path)
    }
    async fn rmdir(&self, path: &str) -> VfsResult<()> {
        erofs("rmdir", path)
    }
    async fn unlink(&self, path: &str) -> VfsResult<()> {
        erofs("unlink", path)
    }
    async fn rename(&self, from: &str, _to: &str) -> VfsResult<()> {
        erofs("rename", from)
    }
    async fn link(&self, _from: &str, to: &str) -> VfsResult<()> {
        erofs("link", to)
    }
    async fn symlink(&self, _target: &str, path: &str) -> VfsResult<()> {
        erofs("symlink", path)
    }
    async fn readlink(&self, path: &str) -> VfsResult<String> {
        self.inner.readlink(path).await
    }
    async fn chmod(&self, path: &str, _mode: u32) -> VfsResult<()> {
        erofs("chmod", path)
    }
    async fn utimes(
        &self,
        path: &str,
        _atime_ms: Option<Option<i64>>,
        _mtime_ms: Option<Option<i64>>,
    ) -> VfsResult<()> {
        erofs("utimes", path)
    }
    async fn truncate(&self, path: &str, _size: u64) -> VfsResult<()> {
        erofs("truncate", path)
    }
    async fn access(&self, path: &str, mask: u32) -> VfsResult<()> {
        if mask & 2 != 0 {
            self.inner.stat(path).await?;
            return erofs("access", path);
        }
        self.inner.access(path, mask).await
    }
    async fn statfs(&self, path: &str) -> VfsResult<StatFs> {
        self.inner.statfs(path).await
    }
    async fn realpath(&self, path: &str) -> VfsResult<String> {
        self.inner.realpath(path).await
    }
    fn invalidate(&self, path: Option<&str>) {
        self.inner.invalidate(path)
    }
    async fn close(&self) {
        self.inner.close().await
    }
}

/// Behaviour of writes to hidden paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HideWriteMode {
    Deny,
    Tmpfs,
}

/// `ShadowProvider` over a prefix path list.
pub struct HideProvider {
    backend: DynProvider,
    /// normalized hidden paths, longest first
    paths: Vec<String>,
    write_mode: HideWriteMode,
    tmpfs: MemoryProvider,
    deny_symlink_bypass: bool,
    deny_errno: i32,
}

impl HideProvider {
    pub fn new(
        backend: DynProvider,
        paths: &[String],
        write_mode: HideWriteMode,
        deny_symlink_bypass: bool,
        deny_errno: i32,
    ) -> HideProvider {
        let mut paths: Vec<String> =
            paths.iter().map(|p| vpath::normalize(p)).filter(|p| p != "/").collect();
        paths.sort_by_key(|p| std::cmp::Reverse(p.len()));
        paths.dedup();
        HideProvider {
            backend,
            paths,
            write_mode,
            tmpfs: MemoryProvider::new(),
            deny_symlink_bypass,
            deny_errno,
        }
    }

    fn hidden(&self, path: &str) -> bool {
        let p = vpath::normalize(path);
        self.paths.iter().any(|h| vpath::is_under(&p, h))
    }

    async fn resolves_hidden(&self, path: &str) -> bool {
        if !self.deny_symlink_bypass {
            return false;
        }
        match self.backend.realpath(path).await {
            Ok(resolved) => self.hidden(&resolved),
            Err(_) => false,
        }
    }

    async fn is_shadowed(&self, path: &str) -> bool {
        self.hidden(path) || self.resolves_hidden(path).await
    }

    fn tmpfs_mode(&self) -> bool {
        self.write_mode == HideWriteMode::Tmpfs
    }

    fn deny<T>(&self, op: &str, path: &str) -> VfsResult<T> {
        Err(VfsError::op(self.deny_errno, op, path))
    }

    fn enoent<T>(op: &str, path: &str) -> VfsResult<T> {
        Err(VfsError::op(errno::ENOENT, op, path))
    }

    /// Creates the parent of a shadowed path in tmpfs when it only exists in
    /// the backend (`ensureUpperParent`).
    async fn ensure_upper_parent(&self, path: &str) -> VfsResult<()> {
        let parent = vpath::parent(path);
        if parent == path {
            return Ok(());
        }
        match self.tmpfs.stat(parent).await {
            Ok(_) => return Ok(()),
            Err(e) if !e.is(errno::ENOENT) => return Err(e),
            Err(_) => {}
        }
        match self.stat(parent).await {
            Ok(st) if st.is_dir() => self.tmpfs.mkdir(parent, 0o755, true).await,
            Ok(_) => Ok(()),
            Err(e) if e.is(errno::ENOENT) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

#[async_trait]
impl Provider for HideProvider {
    fn readonly(&self) -> bool {
        self.backend.readonly()
    }

    async fn lstat(&self, path: &str) -> VfsResult<Attr> {
        if self.is_shadowed(path).await {
            if self.tmpfs_mode() {
                return self.tmpfs.lstat(path).await;
            }
            return Self::enoent("lstat", path);
        }
        self.backend.lstat(path).await
    }

    async fn stat(&self, path: &str) -> VfsResult<Attr> {
        if self.is_shadowed(path).await {
            if self.tmpfs_mode() {
                return self.tmpfs.stat(path).await;
            }
            return Self::enoent("stat", path);
        }
        self.backend.stat(path).await
    }

    async fn readdir(&self, path: &str) -> VfsResult<Vec<DirEntry>> {
        if self.is_shadowed(path).await {
            if self.tmpfs_mode() {
                return self.tmpfs.readdir(path).await;
            }
            return Self::enoent("readdir", path);
        }
        let p = vpath::normalize(path);
        let mut entries: Vec<DirEntry> = self
            .backend
            .readdir(&p)
            .await?
            .into_iter()
            .filter(|e| !self.hidden(&vpath::join(&p, &e.name)))
            .collect();
        if self.tmpfs_mode() {
            let upper = match self.tmpfs.readdir(&p).await {
                Ok(u) => u,
                Err(e) if e.is(errno::ENOENT) || e.is(errno::ENOTDIR) => Vec::new(),
                Err(e) => return Err(e),
            };
            for entry in upper {
                if let Some(existing) = entries.iter_mut().find(|e| e.name == entry.name) {
                    *existing = entry;
                } else {
                    entries.push(entry);
                }
            }
        }
        Ok(entries)
    }

    async fn open(&self, path: &str, flags: OpenFlags, mode: u32) -> VfsResult<Handle> {
        if self.is_shadowed(path).await {
            if self.tmpfs_mode() {
                if flags.create {
                    self.ensure_upper_parent(&vpath::normalize(path)).await?;
                }
                return self.tmpfs.open(path, flags, mode).await;
            }
            if flags.is_write() {
                return self.deny("open", path);
            }
            return Self::enoent("open", path);
        }
        self.backend.open(path, flags, mode).await
    }

    async fn mkdir(&self, path: &str, mode: u32, recursive: bool) -> VfsResult<()> {
        if self.is_shadowed(path).await {
            if !self.tmpfs_mode() {
                return self.deny("mkdir", path);
            }
            self.ensure_upper_parent(&vpath::normalize(path)).await?;
            return self.tmpfs.mkdir(path, mode, recursive).await;
        }
        self.backend.mkdir(path, mode, recursive).await
    }

    async fn rmdir(&self, path: &str) -> VfsResult<()> {
        if self.is_shadowed(path).await {
            if !self.tmpfs_mode() {
                return self.deny("rmdir", path);
            }
            return match self.tmpfs.rmdir(path).await {
                Err(e) if e.is(errno::ENOENT) => Ok(()),
                r => r,
            };
        }
        self.backend.rmdir(path).await
    }

    async fn unlink(&self, path: &str) -> VfsResult<()> {
        if self.is_shadowed(path).await {
            if !self.tmpfs_mode() {
                return self.deny("unlink", path);
            }
            return match self.tmpfs.unlink(path).await {
                Err(e) if e.is(errno::ENOENT) => Ok(()),
                r => r,
            };
        }
        self.backend.unlink(path).await
    }

    async fn rename(&self, from: &str, to: &str) -> VfsResult<()> {
        let from_shadow = self.is_shadowed(from).await;
        let to_shadow = self.is_shadowed(to).await;
        if from_shadow || to_shadow {
            if self.tmpfs_mode() && from_shadow && to_shadow {
                return self.tmpfs.rename(from, to).await;
            }
            return Err(VfsError::op(errno::EXDEV, "rename", &format!("{from} -> {to}")));
        }
        self.backend.rename(from, to).await
    }

    async fn link(&self, from: &str, to: &str) -> VfsResult<()> {
        // the node engine does not special-case link; keep hidden entries unreachable
        if self.is_shadowed(from).await || self.is_shadowed(to).await {
            return Err(VfsError::op(errno::EXDEV, "link", from));
        }
        self.backend.link(from, to).await
    }

    async fn symlink(&self, target: &str, path: &str) -> VfsResult<()> {
        if self.is_shadowed(path).await {
            if !self.tmpfs_mode() {
                return self.deny("symlink", path);
            }
            return self.tmpfs.symlink(target, path).await;
        }
        self.backend.symlink(target, path).await
    }

    async fn readlink(&self, path: &str) -> VfsResult<String> {
        if self.is_shadowed(path).await {
            if self.tmpfs_mode() {
                return self.tmpfs.readlink(path).await;
            }
            return Self::enoent("readlink", path);
        }
        self.backend.readlink(path).await
    }

    async fn chmod(&self, path: &str, mode: u32) -> VfsResult<()> {
        if self.is_shadowed(path).await {
            if !self.tmpfs_mode() {
                return self.deny("chmod", path);
            }
            return self.tmpfs.chmod(path, mode).await;
        }
        self.backend.chmod(path, mode).await
    }

    async fn utimes(
        &self,
        path: &str,
        atime_ms: Option<Option<i64>>,
        mtime_ms: Option<Option<i64>>,
    ) -> VfsResult<()> {
        if self.is_shadowed(path).await {
            if !self.tmpfs_mode() {
                return self.deny("utimes", path);
            }
            return self.tmpfs.utimes(path, atime_ms, mtime_ms).await;
        }
        self.backend.utimes(path, atime_ms, mtime_ms).await
    }

    async fn truncate(&self, path: &str, size: u64) -> VfsResult<()> {
        if self.is_shadowed(path).await {
            if !self.tmpfs_mode() {
                return self.deny("truncate", path);
            }
            return self.tmpfs.truncate(path, size).await;
        }
        self.backend.truncate(path, size).await
    }

    async fn access(&self, path: &str, mask: u32) -> VfsResult<()> {
        if self.is_shadowed(path).await {
            if self.tmpfs_mode() {
                return self.tmpfs.access(path, mask).await;
            }
            return Self::enoent("access", path);
        }
        self.backend.access(path, mask).await
    }

    async fn statfs(&self, path: &str) -> VfsResult<StatFs> {
        self.backend.statfs(path).await
    }

    async fn realpath(&self, path: &str) -> VfsResult<String> {
        if self.is_shadowed(path).await {
            if self.tmpfs_mode() {
                return self.tmpfs.realpath(path).await;
            }
            return Self::enoent("realpath", path);
        }
        self.backend.realpath(path).await
    }

    fn invalidate(&self, path: Option<&str>) {
        self.backend.invalidate(path)
    }

    async fn close(&self) {
        self.backend.close().await
    }
}

pub fn readonly(inner: DynProvider) -> DynProvider {
    Arc::new(ReadonlyProvider::new(inner))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    fn backend() -> MemoryProvider {
        let m = MemoryProvider::new();
        m.write_file_sync("/visible.txt", b"ok", 0o644).unwrap();
        m.write_file_sync("/.envrc", b"SECRET", 0o644).unwrap();
        m
    }

    fn names(entries: Vec<DirEntry>) -> Vec<String> {
        entries.into_iter().map(|e| e.name).collect()
    }

    #[test]
    fn deny_mode() {
        block(crate::test_timeout(async {
            let m = backend();
            let h = HideProvider::new(
                Arc::new(m.clone()),
                &["/.envrc".into()],
                HideWriteMode::Deny,
                true,
                errno::EACCES,
            );
            assert!(h.stat("/.envrc").await.unwrap_err().is(errno::ENOENT));
            assert!(h.open("/.envrc", OpenFlags::READ, 0).await.err().unwrap().is(errno::ENOENT));
            let n = names(h.readdir("/").await.unwrap());
            assert!(n.contains(&"visible.txt".to_string()) && !n.contains(&".envrc".to_string()));
            assert!(
                h.open("/.envrc", OpenFlags::parse("w+").unwrap(), 0)
                    .await
                    .err()
                    .unwrap()
                    .is(errno::EACCES)
            );
            h.chmod("/visible.txt", 0o755).await.unwrap();
            assert!(h.chmod("/.envrc", 0o777).await.unwrap_err().is(errno::EACCES));
            // symlink bypass
            m.symlink(".envrc", "/link").await.unwrap();
            assert!(h.open("/link", OpenFlags::READ, 0).await.err().unwrap().is(errno::ENOENT));
            assert!(h.stat("/link").await.unwrap_err().is(errno::ENOENT));
            assert!(h.rename("/visible.txt", "/.envrc").await.unwrap_err().is(errno::EXDEV));
        }));
    }

    #[test]
    fn tmpfs_mode() {
        block(crate::test_timeout(async {
            let m = backend();
            m.mkdir("/project/doc", 0o755, true).await.unwrap();
            let h = HideProvider::new(
                Arc::new(m.clone()),
                &["/.envrc".into(), "/project/doc/gen".into()],
                HideWriteMode::Tmpfs,
                true,
                errno::EACCES,
            );
            assert!(h.open("/.envrc", OpenFlags::READ, 0).await.err().unwrap().is(errno::ENOENT));
            assert!(!names(h.readdir("/").await.unwrap()).contains(&".envrc".to_string()));
            let f = h.open("/.envrc", OpenFlags::parse("w+").unwrap(), 0o644).await.unwrap();
            f.write(0, b"GUEST").await.unwrap();
            f.close().await.unwrap();
            let f = h.open("/.envrc", OpenFlags::READ, 0).await.unwrap();
            assert_eq!(f.read(0, 100).await.unwrap(), b"GUEST");
            assert!(names(h.readdir("/").await.unwrap()).contains(&".envrc".to_string()));
            assert_eq!(m.read_file_sync("/.envrc").unwrap(), b"SECRET");

            h.mkdir("/project/doc/gen", 0o755, false).await.unwrap();
            assert!(h.stat("/project/doc/gen").await.unwrap().is_dir());
            assert!(names(h.readdir("/project/doc").await.unwrap()).contains(&"gen".to_string()));
            assert!(m.stat("/project/doc/gen").await.unwrap_err().is(errno::ENOENT));
            assert!(h.mkdir("/project/doc/gen", 0o755, false).await.unwrap_err().is(errno::EEXIST));
            h.chmod("/.envrc", 0o600).await.unwrap();
            assert_eq!(h.stat("/.envrc").await.unwrap().perm(), 0o600);
            assert_eq!(m.stat("/.envrc").await.unwrap().perm(), 0o644);
        }));
    }

    #[test]
    fn readonly_wrapper() {
        block(crate::test_timeout(async {
            let m = backend();
            let r = ReadonlyProvider::new(Arc::new(m));
            assert!(
                r.open("/visible.txt", OpenFlags::READ_WRITE, 0)
                    .await
                    .err()
                    .unwrap()
                    .is(errno::EROFS)
            );
            assert!(r.chmod("/visible.txt", 0o777).await.unwrap_err().is(errno::EROFS));
            assert!(r.access("/visible.txt", 2).await.unwrap_err().is(errno::EROFS));
            r.open("/visible.txt", OpenFlags::READ, 0).await.unwrap();
        }));
    }
}

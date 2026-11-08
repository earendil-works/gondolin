//! Mount table: longest-prefix routing with synthetic parent directories
//! (the node engine's `MountRouterProvider`).

use crate::BoxFuture;
use crate::error::{VfsError, VfsResult, errno};
use crate::provider::{DynProvider, Handle, Provider};
use crate::types::{Attr, DirEntry, EntryKind, OpenFlags, StatFs, vpath};

/// One routed mount.
#[derive(Clone)]
pub struct Mount {
    /// normalized mount point
    pub path: String,
    pub provider: DynProvider,
}

/// Routes paths to mounts by longest prefix. Paths above mount points that
/// no mount covers are read-only synthetic directories.
pub struct MountRouter {
    /// longest first
    mounts: Vec<Mount>,
    all_readonly: bool,
}

struct Routed<'a> {
    mount: &'a Mount,
    rel: String,
}

fn is_noent(e: &VfsError) -> bool {
    e.is(errno::ENOENT)
}

impl MountRouter {
    pub fn new(mounts: Vec<Mount>) -> VfsResult<MountRouter> {
        if mounts.is_empty() {
            return Err(VfsError::new(errno::EINVAL, "mounts cannot be empty"));
        }
        let mut seen = std::collections::HashSet::new();
        let mut mounts: Vec<Mount> = mounts
            .into_iter()
            .map(|m| Mount { path: vpath::normalize(&m.path), provider: m.provider })
            .collect();
        for m in &mounts {
            if !seen.insert(m.path.clone()) {
                return Err(VfsError::new(
                    errno::EINVAL,
                    format!("duplicate mount path: {}", m.path),
                ));
            }
        }
        mounts.sort_by_key(|m| std::cmp::Reverse(m.path.len()));
        let all_readonly = mounts.iter().all(|m| m.provider.readonly());
        Ok(MountRouter { mounts, all_readonly })
    }

    pub fn mounts(&self) -> &[Mount] {
        &self.mounts
    }

    fn route(&self, path: &str) -> Option<Routed<'_>> {
        let p = vpath::normalize(path);
        self.mounts
            .iter()
            .find(|m| vpath::is_under(&p, &m.path))
            .map(|m| Routed { mount: m, rel: vpath::relative(&p, &m.path).to_string() })
    }

    fn require(&self, path: &str, op: &str) -> VfsResult<Routed<'_>> {
        self.route(path).ok_or_else(|| VfsError::op(errno::ENOENT, op, path))
    }

    /// Names of mount points directly below `path` (excluding `path` itself).
    fn virtual_children(&self, path: &str) -> Vec<String> {
        let p = vpath::normalize(path);
        let prefix = if p == "/" { "/".to_string() } else { format!("{p}/") };
        let mut out: Vec<String> = self
            .mounts
            .iter()
            .filter(|m| m.path != p && m.path.starts_with(&prefix))
            .filter_map(|m| m.path[prefix.len()..].split('/').next().map(str::to_string))
            .filter(|s| !s.is_empty())
            .collect();
        out.sort();
        out.dedup();
        out
    }

    fn ensure_virtual_dir(&self, path: &str, op: &str) -> VfsResult<()> {
        if self.virtual_children(path).is_empty() {
            Err(VfsError::op(errno::ENOENT, op, path))
        } else {
            Ok(())
        }
    }

    fn same_mount<'a>(
        &'a self,
        from: &str,
        to: &str,
        op: &str,
    ) -> VfsResult<(&'a Mount, String, String)> {
        let a = self.require(from, op)?;
        let b = self.require(to, op)?;
        if a.mount.path != b.mount.path {
            return Err(VfsError::op(errno::EXDEV, op, from));
        }
        Ok((a.mount, a.rel, b.rel))
    }

    /// Whether writes below `path` can succeed at all (the mount's flag).
    pub fn readonly_at(&self, path: &str) -> bool {
        match self.route(path) {
            Some(r) => r.mount.provider.readonly(),
            None => true,
        }
    }

    /// The mount containing `path`, with the mount-relative path.
    pub fn resolve(&self, path: &str) -> Option<(&Mount, String)> {
        self.route(path).map(|r| (r.mount, r.rel))
    }

    async fn stat_like(&self, path: &str, follow: bool) -> VfsResult<Attr> {
        match self.route(path) {
            Some(r) => {
                let res = if follow {
                    r.mount.provider.stat(&r.rel).await
                } else {
                    r.mount.provider.lstat(&r.rel).await
                };
                match res {
                    Err(e)
                        if is_noent(&e)
                            && r.mount.path == "/"
                            && !self.virtual_children(path).is_empty() =>
                    {
                        Ok(Attr::virtual_dir())
                    }
                    r => r,
                }
            }
            None => {
                self.ensure_virtual_dir(path, if follow { "stat" } else { "lstat" })?;
                Ok(Attr::virtual_dir())
            }
        }
    }
}

impl Provider for MountRouter {
    fn readonly(&self) -> bool {
        self.all_readonly
    }

    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move { self.stat_like(path, false).await })
    }

    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move { self.stat_like(path, true).await })
    }

    fn readdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Vec<DirEntry>>> {
        Box::pin(async move {
            let children = self.virtual_children(path);
            let Some(r) = self.route(path) else {
                if children.is_empty() {
                    return Err(VfsError::op(errno::ENOENT, "readdir", path));
                }
                return Ok(children
                    .into_iter()
                    .map(|c| DirEntry::new(c, EntryKind::Dir))
                    .collect());
            };
            let entries = match r.mount.provider.readdir(&r.rel).await {
                Ok(entries) => entries,
                Err(e) if is_noent(&e) && r.mount.path == "/" && !children.is_empty() => Vec::new(),
                Err(e) => return Err(e),
            };
            if children.is_empty() {
                return Ok(entries);
            }
            let mut out: Vec<DirEntry> =
                entries.into_iter().filter(|e| !children.contains(&e.name)).collect();
            out.extend(children.into_iter().map(|c| DirEntry::new(c, EntryKind::Dir)));
            Ok(out)
        })
    }

    fn open<'a>(
        &'a self,
        path: &'a str,
        flags: OpenFlags,
        mode: u32,
    ) -> BoxFuture<'a, VfsResult<Handle>> {
        Box::pin(async move {
            let r = self.require(path, "open")?;
            r.mount.provider.open(&r.rel, flags, mode).await
        })
    }

    fn mkdir<'a>(
        &'a self,
        path: &'a str,
        mode: u32,
        recursive: bool,
    ) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let r = self.require(path, "mkdir")?;
            r.mount.provider.mkdir(&r.rel, mode, recursive).await
        })
    }

    fn rmdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let r = self.require(path, "rmdir")?;
            r.mount.provider.rmdir(&r.rel).await
        })
    }

    fn unlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let r = self.require(path, "unlink")?;
            r.mount.provider.unlink(&r.rel).await
        })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let (m, a, b) = self.same_mount(from, to, "rename")?;
            m.provider.rename(&a, &b).await
        })
    }

    fn link<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let (m, a, b) = self.same_mount(from, to, "link")?;
            m.provider.link(&a, &b).await
        })
    }

    fn symlink<'a>(&'a self, target: &'a str, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let r = self.require(path, "symlink")?;
            r.mount.provider.symlink(target, &r.rel).await
        })
    }

    fn readlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<String>> {
        Box::pin(async move {
            let r = self.require(path, "readlink")?;
            r.mount.provider.readlink(&r.rel).await
        })
    }

    fn chmod<'a>(&'a self, path: &'a str, mode: u32) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let r = self.require(path, "chmod")?;
            r.mount.provider.chmod(&r.rel, mode).await
        })
    }

    fn utimes<'a>(
        &'a self,
        path: &'a str,
        atime_ms: Option<Option<i64>>,
        mtime_ms: Option<Option<i64>>,
    ) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let r = self.require(path, "utimes")?;
            r.mount.provider.utimes(&r.rel, atime_ms, mtime_ms).await
        })
    }

    fn truncate<'a>(&'a self, path: &'a str, size: u64) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let r = self.require(path, "truncate")?;
            r.mount.provider.truncate(&r.rel, size).await
        })
    }

    fn access<'a>(&'a self, path: &'a str, mask: u32) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            match self.route(path) {
                Some(r) => match r.mount.provider.access(&r.rel, mask).await {
                    Err(e)
                        if is_noent(&e)
                            && r.mount.path == "/"
                            && !self.virtual_children(path).is_empty() =>
                    {
                        Ok(())
                    }
                    res => res,
                },
                None => self.ensure_virtual_dir(path, "access"),
            }
        })
    }

    fn statfs<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<StatFs>> {
        Box::pin(async move {
            if let Some(r) = self.route(path) {
                match r.mount.provider.statfs(&r.rel).await {
                    Err(e) if e.is(errno::ENOSYS) => {}
                    res => return res,
                }
            }
            // Virtual directories report the first mount below that has stats.
            let p = vpath::normalize(path);
            let prefix = if p == "/" { "/".to_string() } else { format!("{p}/") };
            for m in &self.mounts {
                if !m.path.starts_with(&prefix) {
                    continue;
                }
                match m.provider.statfs("/").await {
                    Ok(s) => return Ok(s),
                    Err(e) if e.is(errno::ENOSYS) || e.is(errno::ENOENT) => continue,
                    Err(e) => return Err(e),
                }
            }
            Ok(StatFs::SYNTHETIC)
        })
    }

    fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<String>> {
        Box::pin(async move {
            match self.route(path) {
                Some(r) => {
                    let resolved = match r.mount.provider.realpath(&r.rel).await {
                        Err(e)
                            if is_noent(&e)
                                && r.mount.path == "/"
                                && !self.virtual_children(path).is_empty() =>
                        {
                            return Ok(vpath::normalize(path));
                        }
                        res => res?,
                    };
                    if r.mount.path == "/" {
                        Ok(resolved)
                    } else if resolved == "/" {
                        Ok(r.mount.path.clone())
                    } else {
                        Ok(format!("{}{}", r.mount.path, resolved))
                    }
                }
                None => {
                    self.ensure_virtual_dir(path, "realpath")?;
                    Ok(vpath::normalize(path))
                }
            }
        })
    }

    fn invalidate(&self, path: Option<&str>) {
        for m in &self.mounts {
            m.provider.invalidate(path);
        }
    }

    fn close<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            for m in &self.mounts {
                m.provider.close().await;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::MemoryProvider;
    use std::sync::Arc;

    fn block<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    fn names(entries: Vec<DirEntry>) -> Vec<String> {
        let mut n: Vec<String> = entries.into_iter().map(|e| e.name).collect();
        n.sort();
        n
    }

    #[test]
    fn routes_and_virtual_children() {
        block(crate::test_timeout(async {
            let root = MemoryProvider::new();
            root.write_file_sync("/root.txt", b"r", 0o644).unwrap();
            root.write_file_sync("/app", b"conflict", 0o644).unwrap();
            let app = MemoryProvider::new();
            app.write_file_sync("/a.txt", b"a", 0o644).unwrap();
            let deep = MemoryProvider::new();
            deep.write_file_sync("/d.txt", b"d", 0o644).unwrap();
            let r = MountRouter::new(vec![
                Mount { path: "/".into(), provider: Arc::new(root) },
                Mount { path: "/app".into(), provider: Arc::new(app) },
                Mount { path: "/x/y/z".into(), provider: Arc::new(deep) },
            ])
            .unwrap();
            assert_eq!(names(r.readdir("/").await.unwrap()), vec!["app", "root.txt", "x"]);
            // the mount masks the conflicting base entry
            assert!(r.stat("/app").await.unwrap().is_dir());
            assert!(r.stat("/x").await.unwrap().is_dir());
            assert!(r.stat("/x/y").await.unwrap().is_dir());
            assert_eq!(names(r.readdir("/x/y").await.unwrap()), vec!["z"]);
            assert_eq!(r.stat("/x/y/z/d.txt").await.unwrap().size, 1);
            assert_eq!(r.stat("/x/y/../y/z/d.txt").await.unwrap().size, 1);
            assert!(r.rename("/root.txt", "/app/root.txt").await.unwrap_err().is(errno::EXDEV));
            assert!(r.link("/root.txt", "/app/l").await.unwrap_err().is(errno::EXDEV));
            assert!(r.stat("/nope").await.unwrap_err().is(errno::ENOENT));
            assert_eq!(r.statfs("/x").await.unwrap(), StatFs::SYNTHETIC);
            assert_eq!(r.realpath("/app/a.txt").await.unwrap(), "/app/a.txt");
        }));
    }

    #[test]
    fn virtual_root_without_base_mount() {
        block(crate::test_timeout(async {
            let r = MountRouter::new(vec![Mount {
                path: "/a/b".into(),
                provider: Arc::new(MemoryProvider::new()),
            }])
            .unwrap();
            assert!(r.stat("/").await.unwrap().is_dir());
            assert_eq!(names(r.readdir("/").await.unwrap()), vec!["a"]);
            assert!(
                r.open("/x", OpenFlags::parse("w").unwrap(), 0o644)
                    .await
                    .err()
                    .unwrap()
                    .is(errno::ENOENT)
            );
            assert!(r.mkdir("/a/c", 0o755, false).await.unwrap_err().is(errno::ENOENT));
        }));
    }
}

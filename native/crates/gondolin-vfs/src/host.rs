//! `host` mounts: hardened passthrough to a directory on the daemon's machine.
//!
//! Every path is resolved relative to a directory fd of the root without ever
//! leaving it: a component-wise walk that opens each directory with
//! `O_NOFOLLOW` and resolves symlinks itself (absolute targets are mapped back
//! into the root when they point inside it, everything else is `ENOENT`). On
//! Linux `openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)` resolves the parent
//! directory in one call and the walk is the fallback. The final component is
//! then operated on with `*at` calls relative to that parent fd, so a
//! concurrent swap of a path component for a symlink cannot redirect an
//! operation outside the root.
//!
//! Symlink policy (the node engine's hardened `RealFSProvider`): operations
//! that follow the final symlink (open, stat, readdir, mkdir, chmod, access,
//! symlink, link source, statfs, realpath) fail with `ENOENT` for escaping or
//! dangling links; `lstat`, `readlink`, `unlink`, `rmdir`, `rename` and the
//! `link` destination act on the link itself. `chmod` drops setuid/setgid.

use crate::BoxFuture;
use std::collections::VecDeque;
use std::fs::File;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::os::unix::fs::FileExt;
use std::sync::Arc;

use crate::sys::{self, Errno};
use libc::{
    O_APPEND, O_CLOEXEC, O_CREAT, O_DIRECTORY, O_NOFOLLOW, O_RDONLY, O_RDWR, O_TRUNC, O_WRONLY,
};

use crate::error::{VfsError, VfsResult, errno};
use crate::provider::{FileHandle, Handle, Provider};
use crate::types::{Attr, DirEntry, EntryKind, OpenFlags, StatFs, vpath};

const MAX_SYMLINKS: u32 = 40;
/// Permission bits plus sticky; setuid/setgid are never applied to host files.
const CHMOD_ALLOWED_BITS: u32 = 0o1777;

/// A shared directory fd (cached directories are used by several requests).
type Fd = Arc<OwnedFd>;

/// How long a cached directory fd is trusted, like the guest's dentry TTL:
/// changes made on the host side (outside the provider) show up after it.
const DIR_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(1);
/// Largest number of cached directory fds per mount.
const DIR_CACHE_BUDGET: usize = 256;

struct CachedDir {
    fd: Fd,
    expires: std::time::Instant,
    /// last use, for LRU eviction
    seq: u64,
}

/// Directory fds by root-relative path, for paths whose every component is a
/// real directory (no symlinks), so resolution can start below the root.
/// Entries are opened `O_NOFOLLOW` relative to their parent like the walk,
/// expire after [`DIR_CACHE_TTL`], are evicted LRU beyond
/// [`DIR_CACHE_BUDGET`], and are dropped when the provider renames or
/// removes them or an ancestor.
#[derive(Default)]
struct DirCache {
    dirs: std::collections::HashMap<String, CachedDir>,
    seq: u64,
}

impl DirCache {
    /// The deepest cached directory at or above `path`.
    fn longest(&mut self, path: &str) -> Option<(String, Fd)> {
        let now = std::time::Instant::now();
        let mut p = path;
        loop {
            if let Some(c) = self.dirs.get_mut(p) {
                if c.expires > now {
                    self.seq += 1;
                    c.seq = self.seq;
                    return Some((p.to_string(), c.fd.clone()));
                }
                self.dirs.remove(p);
            }
            if p == "/" {
                return None;
            }
            p = vpath::parent(p);
        }
    }

    fn insert(&mut self, path: String, fd: Fd) {
        if self.dirs.len() >= DIR_CACHE_BUDGET
            && !self.dirs.contains_key(&path)
            && let Some(oldest) =
                self.dirs.iter().min_by_key(|(_, c)| c.seq).map(|(k, _)| k.clone())
        {
            self.dirs.remove(&oldest);
        }
        self.seq += 1;
        let expires = std::time::Instant::now() + DIR_CACHE_TTL;
        self.dirs.insert(path, CachedDir { fd, expires, seq: self.seq });
    }

    /// Drops `path` and everything below it.
    fn invalidate(&mut self, path: &str) {
        self.dirs.retain(|k, _| !vpath::is_under(k, path));
    }
}

struct Root {
    fd: Fd,
    /// canonical host path of the root (to map absolute symlinks back)
    path: String,
    cache: std::sync::Mutex<DirCache>,
}

/// Hardened host directory provider.
#[derive(Clone)]
pub struct HostProvider {
    root: Arc<Root>,
}

/// A resolved location: a directory fd plus the final name inside it
/// (`None` when the location is the directory itself).
struct Resolved {
    dir: Fd,
    name: Option<String>,
    /// path of the location relative to the root
    vpath: String,
}

impl Resolved {
    fn name_or(&self, errno_value: i32, op: &str, path: &str) -> VfsResult<&str> {
        self.name.as_deref().ok_or_else(|| VfsError::op(errno_value, op, path))
    }
}

fn dir_flags() -> libc::c_int {
    #[cfg(target_os = "linux")]
    {
        libc::O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    }
    #[cfg(not(target_os = "linux"))]
    {
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    }
}

fn map_errno(e: Errno, op: &str, path: &str) -> VfsError {
    VfsError::op(errno::from_host(e.raw_os_error()), op, path)
}

fn ts_ms(sec: i64, nsec: i64) -> i64 {
    sec * 1000 + (nsec + 500_000) / 1_000_000
}

// field types differ between platforms
#[allow(clippy::unnecessary_cast)]
fn stat_to_attr(st: &sys::Stat) -> Attr {
    Attr {
        mode: st.st_mode as u32,
        size: st.st_size as u64,
        nlink: st.st_nlink as u32,
        uid: st.st_uid as u32,
        gid: st.st_gid as u32,
        atime_ms: ts_ms(st.st_atime as i64, st.st_atime_nsec as i64),
        mtime_ms: ts_ms(st.st_mtime as i64, st.st_mtime_nsec as i64),
        ctime_ms: ts_ms(st.st_ctime as i64, st.st_ctime_nsec as i64),
    }
}

fn is_symlink(st: &sys::Stat) -> bool {
    st.st_mode & libc::S_IFMT == libc::S_IFLNK
}

fn is_dir(st: &sys::Stat) -> bool {
    st.st_mode & libc::S_IFMT == libc::S_IFDIR
}

impl Root {
    fn dup_root(&self) -> VfsResult<Fd> {
        Ok(self.fd.clone())
    }

    /// Resolves `path` (normalized, relative to the root). With `follow` the
    /// final component is resolved through symlinks as well; a final symlink
    /// that dangles or escapes is `ENOENT`.
    fn resolve(&self, path: &str, follow: bool, op: &str) -> VfsResult<Resolved> {
        let normalized = vpath::normalize(path);
        if let Some(found) = self.resolve_fast(&normalized, follow) {
            return Ok(found);
        }
        self.walk(&normalized, follow, op)
    }

    /// Resolves the parent directory from the deepest cached ancestor,
    /// opening the remaining components `O_NOFOLLOW` (Linux: one
    /// `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`) and caching them.
    /// `None` hands over to the full walk: a symlink on the way or as the
    /// followed final component, or any error (the walk reports it).
    fn resolve_fast(&self, path: &str, follow: bool) -> Option<Resolved> {
        if path == "/" {
            return Some(Resolved { dir: self.fd.clone(), name: None, vpath: "/".into() });
        }
        let parent = vpath::parent(path);
        let (prefix, mut dir) = self
            .cache
            .lock()
            .unwrap()
            .longest(parent)
            .unwrap_or_else(|| ("/".to_string(), self.fd.clone()));
        if prefix != parent {
            let rest = vpath::relative(parent, &prefix).trim_start_matches('/').to_string();
            dir = self.open_dirs(&dir, &prefix, &rest)?;
        }
        let name = vpath::basename(path).to_string();
        if follow {
            match sys::statat(&*dir, name.as_str(), true) {
                Ok(st) if is_symlink(&st) => return None,
                _ => {}
            }
        }
        Some(Resolved { dir, name: Some(name), vpath: path.to_string() })
    }

    /// Opens the symlink-free relative directory path `rest` below `base`
    /// (at `prefix`), caching what it opens: one `openat2` on Linux, else
    /// (and where openat2 is unavailable: kernels before 5.6, seccomp
    /// filters, emulators) one `openat(O_NOFOLLOW)` per component.
    fn open_dirs(&self, base: &Fd, prefix: &str, rest: &str) -> Option<Fd> {
        #[cfg(target_os = "linux")]
        {
            use std::sync::atomic::{AtomicBool, Ordering};

            static NO_OPENAT2: AtomicBool = AtomicBool::new(false);
            if !NO_OPENAT2.load(Ordering::Relaxed) {
                match sys::openat2(
                    &**base,
                    rest,
                    libc::O_PATH | O_DIRECTORY | O_CLOEXEC,
                    0,
                    libc::RESOLVE_BENEATH | libc::RESOLVE_NO_SYMLINKS | libc::RESOLVE_NO_MAGICLINKS,
                ) {
                    Ok(fd) => {
                        let fd = Arc::new(fd);
                        let key = if prefix == "/" {
                            format!("/{rest}")
                        } else {
                            format!("{prefix}/{rest}")
                        };
                        self.cache.lock().unwrap().insert(key, fd.clone());
                        return Some(fd);
                    }
                    Err(Errno::NOSYS) | Err(Errno::PERM) => {
                        NO_OPENAT2.store(true, Ordering::Relaxed);
                    }
                    Err(_) => return None,
                }
            }
        }
        let mut dir = base.clone();
        let mut key = prefix.to_string();
        for comp in rest.split('/').filter(|c| !c.is_empty()) {
            // O_NOFOLLOW | O_DIRECTORY: a symlink fails (the walk handles it)
            let fd = sys::openat(&*dir, comp, dir_flags(), 0).ok()?;
            dir = Arc::new(fd);
            key = vpath::join(&key, comp);
            self.cache.lock().unwrap().insert(key.clone(), dir.clone());
        }
        Some(dir)
    }

    /// Forgets cached directories at or below `path` (renamed or removed).
    fn invalidate(&self, path: &str) {
        self.cache.lock().unwrap().invalidate(&vpath::normalize(path));
    }

    fn walk(&self, path: &str, follow: bool, op: &str) -> VfsResult<Resolved> {
        let enoent = || VfsError::op(errno::ENOENT, op, path);
        let mut pending: VecDeque<String> = vpath::components(path).map(str::to_string).collect();
        let mut stack: Vec<Fd> = vec![self.dup_root()?];
        let mut names: Vec<String> = Vec::new();
        let mut links = 0u32;
        // set once the final component was reached through a symlink
        let mut via_final_link = false;
        while let Some(comp) = pending.pop_front() {
            if comp.is_empty() || comp == "." {
                continue;
            }
            if comp == ".." {
                if stack.len() == 1 {
                    return Err(enoent());
                }
                stack.pop();
                names.pop();
                continue;
            }
            let is_last = pending.is_empty();
            let cur = stack.last().unwrap();
            if is_last && !follow {
                let vp = vpath::join(&format!("/{}", names.join("/")), &comp);
                return Ok(Resolved { dir: stack.pop().unwrap(), name: Some(comp), vpath: vp });
            }
            let st = match sys::statat(&**cur, comp.as_str(), true) {
                Ok(st) => st,
                Err(Errno::NOENT) if is_last => {
                    if via_final_link {
                        // dangling final symlink
                        return Err(enoent());
                    }
                    let vp = vpath::join(&format!("/{}", names.join("/")), &comp);
                    return Ok(Resolved { dir: stack.pop().unwrap(), name: Some(comp), vpath: vp });
                }
                Err(Errno::NOENT) => return Err(enoent()),
                Err(e) => return Err(map_errno(e, op, path)),
            };
            if is_symlink(&st) {
                links += 1;
                if links > MAX_SYMLINKS {
                    return Err(VfsError::op(errno::ELOOP, op, path));
                }
                let target =
                    sys::readlinkat(&**cur, comp.as_str()).map_err(|e| map_errno(e, op, path))?;
                let target = String::from_utf8_lossy(&target).into_owned();
                if is_last {
                    via_final_link = true;
                }
                let mut prefix: VecDeque<String> = if let Some(abs) = target.strip_prefix('/') {
                    let mapped = self.map_absolute(&format!("/{abs}")).ok_or_else(enoent)?;
                    stack.truncate(1);
                    names.clear();
                    vpath::components(&mapped).map(str::to_string).collect()
                } else {
                    target.split('/').filter(|c| !c.is_empty()).map(str::to_string).collect()
                };
                prefix.extend(pending.drain(..));
                pending = prefix;
                if pending.is_empty() {
                    // symlink to "/" (or ".") resolves to the current directory
                    break;
                }
                continue;
            }
            if is_last {
                let vp = vpath::join(&format!("/{}", names.join("/")), &comp);
                return Ok(Resolved { dir: stack.pop().unwrap(), name: Some(comp), vpath: vp });
            }
            if !is_dir(&st) {
                return Err(VfsError::op(errno::ENOTDIR, op, path));
            }
            let fd = sys::openat(&**cur, comp.as_str(), dir_flags(), 0).map_err(|e| match e {
                // swapped for a symlink since the stat
                Errno::LOOP | Errno::NOTDIR => enoent(),
                e => map_errno(e, op, path),
            })?;
            stack.push(Arc::new(fd));
            names.push(comp);
        }
        Ok(Resolved {
            dir: stack.pop().unwrap(),
            name: None,
            vpath: format!("/{}", names.join("/")),
        })
    }

    /// Maps an absolute host path inside the root to a root-relative path.
    fn map_absolute(&self, target: &str) -> Option<String> {
        let target = vpath::normalize(target);
        if target == self.path {
            return Some("/".into());
        }
        if self.path == "/" {
            return Some(target);
        }
        target.strip_prefix(&self.path).filter(|rest| rest.starts_with('/')).map(str::to_string)
    }
}

fn reopen_dir(dir: &OwnedFd, op: &str, path: &str) -> VfsResult<OwnedFd> {
    sys::openat(dir, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0).map_err(|e| map_errno(e, op, path))
}

/// Opens the resolved location itself (a file or directory) without following.
fn open_target(
    r: &Resolved,
    flags: libc::c_int,
    mode: libc::mode_t,
    op: &str,
    path: &str,
) -> VfsResult<OwnedFd> {
    match &r.name {
        Some(name) => sys::openat(&*r.dir, name.as_str(), flags | O_NOFOLLOW | O_CLOEXEC, mode)
            .map_err(|e| match e {
                Errno::LOOP => VfsError::op(errno::ENOENT, op, path),
                e => map_errno(e, op, path),
            }),
        None => {
            if flags & (O_WRONLY | O_RDWR) != 0 {
                return Err(VfsError::op(errno::EISDIR, op, path));
            }
            reopen_dir(&r.dir, op, path)
        }
    }
}

fn lstat_resolved(r: &Resolved, op: &str, path: &str) -> VfsResult<sys::Stat> {
    match &r.name {
        Some(name) => sys::statat(&*r.dir, name.as_str(), true),
        None => sys::fstat(&*r.dir),
    }
    .map_err(|e| map_errno(e, op, path))
}

thread_local! {
    static INLINE_BLOCKING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Runs `f` with host filesystem calls made inline on the current thread
/// (callers on their own threads, like the virtio-fs queues, that drive a
/// future with `block_on`): saves a thread hop per operation.
pub fn with_inline_blocking<T>(f: impl FnOnce() -> T) -> T {
    let previous = INLINE_BLOCKING.with(|c| c.replace(true));
    let result = f();
    INLINE_BLOCKING.with(|c| c.set(previous));
    result
}

/// Runs a blocking filesystem call on the blocking pool, or inline inside
/// [`with_inline_blocking`]. (`block_in_place` measured slower: it moves the
/// worker's core to another thread per call.)
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> VfsResult<T> + Send + 'static,
) -> VfsResult<T> {
    if INLINE_BLOCKING.with(|c| c.get()) {
        return f();
    }
    match tokio::task::spawn_blocking(f).await {
        Ok(r) => r,
        Err(e) => Err(VfsError::new(errno::EIO, format!("host fs task failed: {e}"))),
    }
}

impl HostProvider {
    /// Opens `root` (a directory on this machine).
    pub fn new(root: &str) -> VfsResult<HostProvider> {
        let canonical =
            std::fs::canonicalize(root).map_err(|e| VfsError::from_io(&e, "open", root))?;
        let fd = sys::open(&canonical, O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0)
            .map_err(|e| map_errno(e, "open", root))?;
        let path = canonical.to_string_lossy().into_owned();
        Ok(HostProvider {
            root: Arc::new(Root { fd: Arc::new(fd), path, cache: Default::default() }),
        })
    }

    pub fn root_path(&self) -> &str {
        &self.root.path
    }

    async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Root) -> VfsResult<T> + Send + 'static,
    ) -> VfsResult<T> {
        let root = self.root.clone();
        blocking(move || f(&root)).await
    }
}

impl Provider for HostProvider {
    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move {
            let path = path.to_string();
            self.run(move |root| {
                let r = root.resolve(&path, false, "lstat")?;
                Ok(stat_to_attr(&lstat_resolved(&r, "lstat", &path)?))
            })
            .await
        })
    }

    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move {
            let path = path.to_string();
            self.run(move |root| {
                let r = root.resolve(&path, true, "stat")?;
                Ok(stat_to_attr(&lstat_resolved(&r, "stat", &path)?))
            })
            .await
        })
    }

    fn readdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Vec<DirEntry>>> {
        Box::pin(async move {
            let path = path.to_string();
            self.run(move |root| {
                let r = root.resolve(&path, true, "scandir")?;
                let fd = open_target(&r, O_RDONLY | O_DIRECTORY, 0, "scandir", &path)?;
                let dir = sys::Dir::new(fd).map_err(|e| map_errno(e, "scandir", &path))?;
                let mut out = Vec::new();
                for entry in dir {
                    let (name, kind) = entry.map_err(|e| map_errno(e, "scandir", &path))?;
                    if name == b"." || name == b".." {
                        continue;
                    }
                    let kind = match kind {
                        sys::DirType::Dir => Some(EntryKind::Dir),
                        sys::DirType::Symlink => Some(EntryKind::Symlink),
                        sys::DirType::Unknown => None,
                        sys::DirType::Other => Some(EntryKind::File),
                    };
                    out.push(DirEntry { name: String::from_utf8_lossy(&name).into_owned(), kind });
                }
                Ok(out)
            })
            .await
        })
    }

    fn open<'a>(
        &'a self,
        path: &'a str,
        flags: OpenFlags,
        mode: u32,
    ) -> BoxFuture<'a, VfsResult<Handle>> {
        Box::pin(async move {
            let path = path.to_string();
            let file = self
                .run(move |root| {
                    let r = root.resolve(&path, true, "open")?;
                    let mut oflags = match (flags.read, flags.write || flags.append) {
                        (true, true) => O_RDWR,
                        (false, true) => O_WRONLY,
                        _ => O_RDONLY,
                    };
                    if flags.create {
                        oflags |= O_CREAT;
                    }
                    if flags.truncate {
                        oflags |= O_TRUNC;
                    }
                    if flags.append {
                        oflags |= O_APPEND;
                    }
                    let fd =
                        open_target(&r, oflags, (mode & 0o777) as libc::mode_t, "open", &path)?;
                    Ok(File::from(fd))
                })
                .await?;
            Ok::<Handle, VfsError>(Arc::new(HostHandle {
                file: Arc::new(file),
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
            let path = path.to_string();
            self.run(move |root| {
                let mode = (mode & 0o7777 & CHMOD_ALLOWED_BITS) as libc::mode_t;
                if recursive {
                    let mut current = String::from("/");
                    for comp in vpath::components(&vpath::normalize(&path))
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                    {
                        current = vpath::join(&current, &comp);
                        let r = root.resolve(&current, true, "mkdir")?;
                        if let Some(name) = &r.name {
                            match sys::mkdirat(&*r.dir, name.as_str(), mode) {
                                Ok(()) => {}
                                Err(Errno::EXIST) => {
                                    let st = sys::statat(&*r.dir, name.as_str(), true)
                                        .map_err(|e| map_errno(e, "mkdir", &path))?;
                                    if !is_dir(&st) {
                                        return Err(VfsError::op(errno::ENOTDIR, "mkdir", &path));
                                    }
                                }
                                Err(e) => return Err(map_errno(e, "mkdir", &path)),
                            }
                        }
                    }
                    return Ok(());
                }
                let r = root.resolve(&path, true, "mkdir")?;
                let name = r.name_or(errno::EEXIST, "mkdir", &path)?;
                sys::mkdirat(&*r.dir, name, mode).map_err(|e| map_errno(e, "mkdir", &path))
            })
            .await
        })
    }

    fn rmdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let path = path.to_string();
            self.run(move |root| {
                let r = root.resolve(&path, false, "rmdir")?;
                let name = r.name_or(errno::EBUSY, "rmdir", &path)?;
                let result =
                    sys::unlinkat(&*r.dir, name, true).map_err(|e| map_errno(e, "rmdir", &path));
                root.invalidate(&path);
                result
            })
            .await
        })
    }

    fn unlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let path = path.to_string();
            self.run(move |root| {
                let r = root.resolve(&path, false, "unlink")?;
                let name = r.name_or(errno::EISDIR, "unlink", &path)?;
                sys::unlinkat(&*r.dir, name, false).map_err(|e| map_errno(e, "unlink", &path))
            })
            .await
        })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let (from, to) = (from.to_string(), to.to_string());
            self.run(move |root| {
                let a = root.resolve(&from, false, "rename")?;
                let b = root.resolve(&to, false, "rename")?;
                let an = a.name_or(errno::EBUSY, "rename", &from)?;
                let bn = b.name_or(errno::EBUSY, "rename", &to)?;
                let result = sys::renameat(&*a.dir, an, &*b.dir, bn)
                    .map_err(|e| map_errno(e, "rename", &from));
                root.invalidate(&from);
                root.invalidate(&to);
                result
            })
            .await
        })
    }

    fn link<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let (from, to) = (from.to_string(), to.to_string());
            self.run(move |root| {
                let a = root.resolve(&from, true, "link")?;
                let b = root.resolve(&to, false, "link")?;
                let an = a.name_or(errno::EPERM, "link", &from)?;
                let bn = b.name_or(errno::EEXIST, "link", &to)?;
                sys::linkat(&*a.dir, an, &*b.dir, bn).map_err(|e| map_errno(e, "link", &from))
            })
            .await
        })
    }

    fn symlink<'a>(&'a self, target: &'a str, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let (target, path) = (target.to_string(), path.to_string());
            self.run(move |root| {
                let r = root.resolve(&path, true, "symlink")?;
                let name = r.name_or(errno::EEXIST, "symlink", &path)?;
                sys::symlinkat(target.as_str(), &*r.dir, name)
                    .map_err(|e| map_errno(e, "symlink", &path))
            })
            .await
        })
    }

    fn readlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<String>> {
        Box::pin(async move {
            let path = path.to_string();
            self.run(move |root| {
                let r = root.resolve(&path, false, "readlink")?;
                let name = r.name_or(errno::EINVAL, "readlink", &path)?;
                let target =
                    sys::readlinkat(&*r.dir, name).map_err(|e| map_errno(e, "readlink", &path))?;
                Ok(String::from_utf8_lossy(&target).into_owned())
            })
            .await
        })
    }

    fn chmod<'a>(&'a self, path: &'a str, mode: u32) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let path = path.to_string();
            self.run(move |root| {
                let r = root.resolve(&path, true, "chmod")?;
                let mode = (mode & CHMOD_ALLOWED_BITS) as libc::mode_t;
                match &r.name {
                    Some(name) => {
                        let st = sys::statat(&*r.dir, name.as_str(), true)
                            .map_err(|e| map_errno(e, "chmod", &path))?;
                        if is_symlink(&st) {
                            return Err(VfsError::op(errno::ENOENT, "chmod", &path));
                        }
                        sys::chmodat(&*r.dir, name.as_str(), mode)
                            .map_err(|e| map_errno(e, "chmod", &path))
                    }
                    None => {
                        let fd = reopen_dir(&r.dir, "chmod", &path)?;
                        sys::fchmod(&fd, mode).map_err(|e| map_errno(e, "chmod", &path))
                    }
                }
            })
            .await
        })
    }

    fn utimes<'a>(
        &'a self,
        path: &'a str,
        atime_ms: Option<Option<i64>>,
        mtime_ms: Option<Option<i64>>,
    ) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let path = path.to_string();
            self.run(move |root| {
                let r = root.resolve(&path, true, "utimes")?;
                let ts = |t: Option<Option<i64>>| match t {
                    None => sys::Timespec { tv_sec: 0, tv_nsec: libc::UTIME_OMIT as _ },
                    Some(None) => sys::Timespec { tv_sec: 0, tv_nsec: libc::UTIME_NOW as _ },
                    Some(Some(ms)) => sys::Timespec {
                        tv_sec: ms.div_euclid(1000) as _,
                        tv_nsec: (ms.rem_euclid(1000) * 1_000_000) as _,
                    },
                };
                let times = [ts(atime_ms), ts(mtime_ms)];
                let name = r.name.clone().unwrap_or_else(|| ".".into());
                sys::utimensat_nofollow(&*r.dir, name.as_str(), &times)
                    .map_err(|e| map_errno(e, "utimes", &path))
            })
            .await
        })
    }

    fn truncate<'a>(&'a self, path: &'a str, size: u64) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let path = path.to_string();
            self.run(move |root| {
                let r = root.resolve(&path, true, "truncate")?;
                let fd = open_target(&r, O_WRONLY, 0, "truncate", &path)?;
                sys::ftruncate(&fd, size).map_err(|e| map_errno(e, "truncate", &path))
            })
            .await
        })
    }

    fn access<'a>(&'a self, path: &'a str, mask: u32) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let path = path.to_string();
            self.run(move |root| {
                let r = root.resolve(&path, true, "access")?;
                // R_OK | W_OK | X_OK (same values everywhere); none: F_OK
                let access = (mask & 0o7) as libc::c_int;
                let name = r.name.clone().unwrap_or_else(|| ".".into());
                sys::accessat(&*r.dir, name.as_str(), access)
                    .map_err(|e| map_errno(e, "access", &path))
            })
            .await
        })
    }

    fn statfs<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<StatFs>> {
        Box::pin(async move {
            let path = path.to_string();
            self.run(move |root| {
                let r = root.resolve(&path, true, "statfs")?;
                let st = match &r.name {
                    Some(_) => {
                        let fd = open_target(&r, O_RDONLY, 0, "statfs", &path)?;
                        sys::fstatvfs(&fd)
                    }
                    None => sys::fstatvfs(&*r.dir),
                }
                .map_err(|e| map_errno(e, "statfs", &path))?;
                let frsize = if st.f_frsize > 0 { st.f_frsize } else { st.f_bsize } as u64;
                Ok(StatFs {
                    blocks: st.f_blocks as u64,
                    bfree: st.f_bfree as u64,
                    bavail: st.f_bavail as u64,
                    files: st.f_files as u64,
                    ffree: st.f_ffree as u64,
                    bsize: frsize,
                    frsize,
                    namelen: st.f_namemax as u64,
                })
            })
            .await
        })
    }

    fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<String>> {
        Box::pin(async move {
            let path = path.to_string();
            self.run(move |root| {
                let normalized = vpath::normalize(&path);
                // symlink-free paths (the common case, checked through the
                // directory cache) are their own real path
                if let Some(r) = root.resolve_fast(&normalized, true) {
                    lstat_resolved(&r, "realpath", &path)?;
                    return Ok(normalized);
                }
                let r = root.walk(&normalized, true, "realpath")?;
                if r.name.is_some() {
                    // must exist
                    lstat_resolved(&r, "realpath", &path)?;
                }
                Ok(r.vpath)
            })
            .await
        })
    }
}

/// Writes all of `data` at `offset` (appends write at the end).
fn write_all(file: &File, append: bool, offset: u64, data: &[u8]) -> VfsResult<usize> {
    let mut total = 0;
    while total < data.len() {
        let res = if append {
            sys::write(file_fd(file), &data[total..]).map_err(std::io::Error::from)
        } else {
            file.write_at(&data[total..], offset + total as u64)
        };
        match res {
            Ok(0) => return Err(VfsError::op(errno::EIO, "write", "")),
            Ok(n) => total += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(VfsError::from_io(&e, "write", "")),
        }
    }
    Ok(total)
}

struct HostHandle {
    file: Arc<File>,
    append: bool,
}

fn file_fd(file: &File) -> BorrowedFd<'_> {
    file.as_fd()
}

impl FileHandle for HostHandle {
    fn read<'a>(&'a self, offset: u64, len: usize) -> BoxFuture<'a, VfsResult<Vec<u8>>> {
        Box::pin(async move {
            let file = self.file.clone();
            blocking(move || {
                let mut buf = vec![0u8; len];
                let mut total = 0;
                while total < len {
                    match file.read_at(&mut buf[total..], offset + total as u64) {
                        Ok(0) => break,
                        Ok(n) => total += n,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(e) => return Err(VfsError::from_io(&e, "read", "")),
                    }
                }
                buf.truncate(total);
                Ok(buf)
            })
            .await
        })
    }

    fn write<'a>(&'a self, offset: u64, data: &'a [u8]) -> BoxFuture<'a, VfsResult<usize>> {
        Box::pin(async move {
            let file = self.file.clone();
            let data = data.to_vec();
            let append = self.append;
            blocking(move || write_all(&file, append, offset, &data)).await
        })
    }

    fn write_sync(&self, offset: u64, data: &[u8]) -> Option<VfsResult<usize>> {
        Some(write_all(&self.file, self.append, offset, data))
    }

    fn read_vectored_sync(&self, offset: u64, bufs: &mut [&mut [u8]]) -> Option<VfsResult<usize>> {
        let want: usize = bufs.iter().map(|b| b.len()).sum();
        let mut total = 0usize;
        while total < want {
            // skip what is already filled
            let mut skip = total;
            let mut iov: Vec<std::io::IoSliceMut<'_>> = Vec::with_capacity(bufs.len());
            for b in bufs.iter_mut() {
                if skip >= b.len() {
                    skip -= b.len();
                    continue;
                }
                iov.push(std::io::IoSliceMut::new(&mut b[skip..]));
                skip = 0;
                if iov.len() == 1024 {
                    break;
                }
            }
            match sys::preadv(file_fd(&self.file), &mut iov, offset + total as u64) {
                Ok(0) => break,
                Ok(n) => total += n,
                Err(Errno::INTR) => continue,
                Err(e) => return Some(Err(map_errno(e, "read", ""))),
            }
        }
        Some(Ok(total))
    }

    fn stat<'a>(&'a self) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move {
            let file = self.file.clone();
            blocking(move || {
                Ok(stat_to_attr(
                    &sys::fstat(&file_fd(&file)).map_err(|e| map_errno(e, "fstat", ""))?,
                ))
            })
            .await
        })
    }

    fn truncate<'a>(&'a self, size: u64) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let file = self.file.clone();
            blocking(move || {
                sys::ftruncate(&file_fd(&file), size).map_err(|e| map_errno(e, "ftruncate", ""))
            })
            .await
        })
    }

    fn sync<'a>(&'a self) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            let file = self.file.clone();
            blocking(move || file.sync_data().map_err(|e| VfsError::from_io(&e, "fsync", ""))).await
        })
    }

    fn close<'a>(&'a self) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            // the fd closes when the last reference drops
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        root: std::path::PathBuf,
        outside: std::path::PathBuf,
        p: HostProvider,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(tmp.path()).unwrap();
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        let p = HostProvider::new(root.to_str().unwrap()).unwrap();
        Fixture { _tmp: tmp, root, outside, p }
    }

    fn enoent<T: std::fmt::Debug>(r: VfsResult<T>) -> bool {
        matches!(r, Err(ref e) if e.is(errno::ENOENT))
    }

    #[test]
    fn basic_ops() {
        let f = fixture();
        rt().block_on(crate::test_timeout(async {
            let p = &f.p;
            p.mkdir("/d", 0o755, false).await.unwrap();
            let h = p.open("/d/a.txt", OpenFlags::parse("w+").unwrap(), 0o644).await.unwrap();
            h.write(0, b"hello").await.unwrap();
            assert_eq!(h.read(1, 100).await.unwrap(), b"ello");
            assert_eq!(h.stat().await.unwrap().size, 5);
            h.close().await.unwrap();
            assert_eq!(std::fs::read(f.root.join("d/a.txt")).unwrap(), b"hello");
            let names: Vec<_> =
                p.readdir("/d").await.unwrap().into_iter().map(|e| e.name).collect();
            assert_eq!(names, vec!["a.txt"]);
            p.rename("/d/a.txt", "/d/b.txt").await.unwrap();
            p.link("/d/b.txt", "/d/c.txt").await.unwrap();
            assert_eq!(p.stat("/d/b.txt").await.unwrap().nlink, 2);
            p.symlink("b.txt", "/d/l").await.unwrap();
            assert_eq!(p.readlink("/d/l").await.unwrap(), "b.txt");
            assert!(p.lstat("/d/l").await.unwrap().is_symlink());
            assert_eq!(p.stat("/d/l").await.unwrap().size, 5);
            assert_eq!(p.realpath("/d/l").await.unwrap(), "/d/b.txt");
            p.truncate("/d/b.txt", 2).await.unwrap();
            assert_eq!(std::fs::read(f.root.join("d/c.txt")).unwrap(), b"he");
            p.chmod("/d/b.txt", 0o6755).await.unwrap();
            let mode = std::fs::metadata(f.root.join("d/b.txt")).unwrap().permissions().mode();
            assert_eq!(mode & 0o7777, 0o755);
            assert!(p.rmdir("/d").await.unwrap_err().is(errno::ENOTEMPTY));
            p.unlink("/d/b.txt").await.unwrap();
            p.mkdir("/x/y/z", 0o755, true).await.unwrap();
            p.mkdir("/x/y/z", 0o755, true).await.unwrap();
            assert!(p.statfs("/").await.unwrap().blocks > 0);
            p.access("/d/c.txt", 4).await.unwrap();
            let a = p.open("/d/c.txt", OpenFlags::parse("a").unwrap(), 0).await.unwrap();
            a.write(0, b"!!").await.unwrap();
            assert_eq!(std::fs::read(f.root.join("d/c.txt")).unwrap(), b"he!!");
        }));
    }

    #[test]
    fn traversal_and_escaping_symlinks() {
        let f = fixture();
        symlink(f.outside.join("secret.txt"), f.root.join("escape-link")).unwrap();
        symlink(&f.outside, f.root.join("evil")).unwrap();
        symlink("../outside/secret.txt", f.root.join("rel-escape")).unwrap();
        rt().block_on(crate::test_timeout(async {
            let p = &f.p;
            assert!(enoent(p.open("/../outside/secret.txt", OpenFlags::READ, 0).await.map(|_| ())));
            assert!(enoent(p.open("/escape-link", OpenFlags::READ, 0).await.map(|_| ())));
            assert!(enoent(p.stat("/escape-link").await));
            assert!(enoent(p.stat("/rel-escape").await));
            assert!(enoent(p.readdir("/evil").await));
            assert!(enoent(
                p.open("/evil/new.txt", OpenFlags::parse("w").unwrap(), 0o644).await.map(|_| ())
            ));
            assert!(enoent(p.unlink("/evil/secret.txt").await));
            assert!(enoent(p.mkdir("/evil/sub", 0o755, false).await));
            assert!(enoent(p.rename("/escape-link", "/evil/x").await));
            assert!(enoent(p.link("/escape-link", "/copy").await));
            assert!(enoent(p.chmod("/escape-link", 0o777).await));
            assert!(enoent(p.realpath("/evil").await));
            // the link itself is fine
            assert!(p.lstat("/escape-link").await.unwrap().is_symlink());
            assert_eq!(
                p.readlink("/escape-link").await.unwrap(),
                f.outside.join("secret.txt").to_str().unwrap()
            );
            p.unlink("/escape-link").await.unwrap();
            assert_eq!(std::fs::read_to_string(f.outside.join("secret.txt")).unwrap(), "secret");
            assert_eq!(std::fs::read_dir(&f.outside).unwrap().count(), 1);
        }));
    }

    #[test]
    fn in_root_symlinks_and_dangling() {
        let f = fixture();
        std::fs::create_dir(f.root.join("a")).unwrap();
        std::fs::create_dir(f.root.join("b")).unwrap();
        std::fs::write(f.root.join("b/file.txt"), "in-root").unwrap();
        symlink("../b/file.txt", f.root.join("a/link")).unwrap();
        symlink(f.root.join("b/file.txt"), f.root.join("abs-link")).unwrap();
        symlink(f.root.join("b"), f.root.join("abs-dir")).unwrap();
        symlink("target.txt", f.root.join("safe-dangling")).unwrap();
        symlink(f.outside.join("nope"), f.root.join("dangling-escape")).unwrap();
        symlink("dangling-escape", f.root.join("level2")).unwrap();
        symlink("b", f.root.join("dir-link")).unwrap();
        rt().block_on(crate::test_timeout(async {
            let p = &f.p;
            let h = p.open("/a/link", OpenFlags::READ, 0).await.unwrap();
            assert_eq!(h.read(0, 100).await.unwrap(), b"in-root");
            let h = p.open("/abs-link", OpenFlags::READ, 0).await.unwrap();
            assert_eq!(h.read(0, 100).await.unwrap(), b"in-root");
            assert!(p.stat("/abs-dir/file.txt").await.unwrap().size == 7);
            assert!(enoent(
                p.open("/safe-dangling", OpenFlags::parse("w").unwrap(), 0o644).await.map(|_| ())
            ));
            assert!(!f.root.join("target.txt").exists());
            assert!(enoent(
                p.open("/dangling-escape", OpenFlags::parse("w").unwrap(), 0o644).await.map(|_| ())
            ));
            assert!(enoent(
                p.open("/level2", OpenFlags::parse("w").unwrap(), 0o644).await.map(|_| ())
            ));
            assert!(!f.outside.join("nope").exists());
            // rmdir/rename act on the link itself
            assert!(p.rmdir("/dir-link").await.unwrap_err().is(errno::ENOTDIR));
            assert!(f.root.join("b").exists());
            p.rename("/dir-link", "/renamed-link").await.unwrap();
            assert!(
                std::fs::symlink_metadata(f.root.join("renamed-link"))
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
        }));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn openat2_fast_path_and_fallbacks() {
        let f = fixture();
        std::fs::create_dir(f.root.join("d")).unwrap();
        symlink(f.root.join("d"), f.root.join("abs")).unwrap();
        symlink(&f.outside, f.root.join("evil")).unwrap();
        let root = f.p.root.clone();
        // plain paths resolve with openat2
        let r = root.resolve_fast("/d/x", false).expect("openat2 available");
        assert_eq!(r.name.as_deref(), Some("x"));
        // symlinked parents fall back to the walk and still resolve in-root
        assert!(root.resolve_fast("/abs/x", false).is_none());
        assert!(root.resolve("/abs/x", false, "open").is_ok());
        // escapes fall back and are rejected by the walk
        assert!(root.resolve_fast("/evil/x", false).is_none());
        assert!(root.resolve("/evil/x", false, "open").err().unwrap().is(errno::ENOENT));
    }

    #[test]
    fn dir_cache_hits_invalidates_and_expires() {
        let f = fixture();
        std::fs::create_dir_all(f.root.join("a/b")).unwrap();
        std::fs::write(f.root.join("a/b/c"), "c").unwrap();
        rt().block_on(crate::test_timeout(async {
            let p = &f.p;
            assert_eq!(p.stat("/a/b/c").await.unwrap().size, 1);
            assert!(p.root.cache.lock().unwrap().dirs.contains_key("/a/b"));
            // renaming an ancestor through the provider drops the cached fds
            p.rename("/a", "/z").await.unwrap();
            assert!(!p.root.cache.lock().unwrap().dirs.contains_key("/a/b"));
            assert!(enoent(p.stat("/a/b/c").await));
            assert_eq!(p.stat("/z/b/c").await.unwrap().size, 1);
            p.unlink("/z/b/c").await.unwrap();
            p.rmdir("/z/b").await.unwrap();
            assert!(!p.root.cache.lock().unwrap().dirs.contains_key("/z/b"));
            p.mkdir("/z/b", 0o755, false).await.unwrap();
            assert!(p.stat("/z/b").await.unwrap().is_dir());
        }));

        // a cached directory swapped for an escaping symlink on the host:
        // within the TTL creates still land in the (renamed) original
        // directory inside the root, afterwards the walk rejects the link
        std::fs::create_dir(f.root.join("x")).unwrap();
        rt().block_on(crate::test_timeout(async {
            let p = &f.p;
            p.stat("/x/missing").await.unwrap_err();
            assert!(p.root.cache.lock().unwrap().dirs.contains_key("/x"));
            std::fs::rename(f.root.join("x"), f.root.join("x-old")).unwrap();
            symlink(&f.outside, f.root.join("x")).unwrap();
            let h = p.open("/x/new", OpenFlags::parse("w").unwrap(), 0o644).await.unwrap();
            h.close().await.unwrap();
            assert!(f.root.join("x-old/new").exists());
            assert!(!f.outside.join("new").exists());
            tokio::time::sleep(DIR_CACHE_TTL + std::time::Duration::from_millis(50)).await;
            assert!(enoent(
                p.open("/x/new2", OpenFlags::parse("w").unwrap(), 0o644).await.map(|_| ())
            ));
            assert!(!f.outside.join("new2").exists());
        }));
    }

    #[test]
    fn dir_cache_is_bounded() {
        let f = fixture();
        for i in 0..(DIR_CACHE_BUDGET + 40) {
            std::fs::create_dir(f.root.join(format!("d{i}"))).unwrap();
        }
        rt().block_on(crate::test_timeout(async {
            for i in 0..(DIR_CACHE_BUDGET + 40) {
                f.p.stat(&format!("/d{i}/x")).await.unwrap_err();
            }
            let cache = f.p.root.cache.lock().unwrap();
            assert_eq!(cache.dirs.len(), DIR_CACHE_BUDGET);
            // the oldest entries were evicted
            assert!(!cache.dirs.contains_key("/d0"));
            assert!(cache.dirs.contains_key(&format!("/d{}", DIR_CACHE_BUDGET + 39)));
        }));
    }

    #[test]
    fn swapped_parent_cannot_escape() {
        // the RPC-level pipelined-rename race, as a direct swap between
        // resolution steps is impossible to hit deterministically: the walk
        // holds fds, so replacing a directory with an escaping symlink after
        // resolution keeps the create inside the old directory.
        let f = fixture();
        std::fs::create_dir(f.root.join("x")).unwrap();
        let root = f.p.root.clone();
        let r = root.resolve("/x/secret.txt", true, "open").unwrap();
        std::fs::rename(f.root.join("x"), f.root.join("x-old")).unwrap();
        symlink(&f.outside, f.root.join("x")).unwrap();
        let fd = open_target(&r, O_WRONLY | O_CREAT, 0o644, "open", "/x").unwrap();
        drop(fd);
        assert!(f.root.join("x-old/secret.txt").exists());
        assert_eq!(std::fs::read_to_string(f.outside.join("secret.txt")).unwrap(), "secret");
    }
}

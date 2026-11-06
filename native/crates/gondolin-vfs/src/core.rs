//! Inode-level filesystem over the mount table: the state both guest
//! transports share (the sandboxfs RPC in [`crate::rpc`] and virtio-fs in
//! [`crate::virtiofs`]).
//!
//! Semantics follow the node engine's `FsRpcService`: path-based inode
//! numbering (root is 1, new paths count up from 2, hard links share the inode
//! they were created from), a handle table, errno mapping, and node-style open
//! flags. In addition inodes carry FUSE lookup counts so `FORGET` can drop
//! them, directories can be opened with a listing snapshot (`opendir`), and
//! open handles commit on `flush`/`fsync`.
//!
//! All operations take `&self`; the tables use short internal locks, so
//! virtio-fs request queues can run concurrently. Host paths are resolved from
//! directory fds (see [`crate::host`]), so concurrent renames cannot redirect
//! an operation outside a mount.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::error::{VfsError, VfsResult, errno};
use crate::provider::{DynProvider, Handle};
use crate::router::MountRouter;
use crate::types::{Attr, DirEntry, EntryKind, OpenFlags, StatFs, dirent_type, linux_open, vpath};

pub const READDIR_CACHE_TTL: Duration = Duration::from_millis(5000);
pub const READDIR_CACHE_MAX_DIRS: usize = 128;

/// Request counters (`FsRpcMetrics`).
#[derive(Debug, Default, Clone)]
pub struct Metrics {
    pub requests: u64,
    pub errors: u64,
    pub bytes_read: u64,
    pub bytes_written: u64,
    pub ops: BTreeMap<String, u64>,
}

struct HandleEntry {
    handle: Handle,
    path: String,
}

#[derive(Default)]
struct Inodes {
    next: u64,
    path_to_ino: BTreeMap<String, u64>,
    ino_to_paths: HashMap<u64, Vec<String>>,
    /// FUSE lookup counts (virtio-fs); the sandboxfs RPC never forgets
    nlookup: HashMap<u64, u64>,
}

impl Inodes {
    fn new() -> Inodes {
        let mut i = Inodes { next: 2, ..Default::default() };
        i.path_to_ino.insert("/".into(), 1);
        i.ino_to_paths.insert(1, vec!["/".into()]);
        i
    }

    fn ensure(&mut self, path: &str, preferred: Option<u64>) -> u64 {
        if let Some(ino) = self.path_to_ino.get(path) {
            return *ino;
        }
        let ino = preferred.unwrap_or_else(|| {
            let i = self.next;
            self.next += 1;
            i
        });
        self.path_to_ino.insert(path.to_string(), ino);
        let paths = self.ino_to_paths.entry(ino).or_default();
        if !paths.iter().any(|p| p == path) {
            paths.push(path.to_string());
        }
        ino
    }

    /// `ensure` plus one lookup reference (a reply the kernel will FORGET).
    fn reference(&mut self, path: &str, preferred: Option<u64>) -> u64 {
        let ino = self.ensure(path, preferred);
        *self.nlookup.entry(ino).or_default() += 1;
        ino
    }

    fn forget(&mut self, ino: u64, n: u64) {
        if ino == 1 {
            return;
        }
        let Some(count) = self.nlookup.get_mut(&ino) else { return };
        *count = count.saturating_sub(n);
        if *count == 0 {
            self.nlookup.remove(&ino);
            for path in self.ino_to_paths.remove(&ino).unwrap_or_default() {
                if self.path_to_ino.get(&path) == Some(&ino) {
                    self.path_to_ino.remove(&path);
                }
            }
        }
    }

    fn path(&self, ino: u64) -> Option<&str> {
        self.ino_to_paths.get(&ino).and_then(|p| p.first()).map(String::as_str)
    }

    /// Keys equal to `path` or below it.
    fn subtree(&self, path: &str) -> Vec<(String, u64)> {
        let mut out = Vec::new();
        if let Some(ino) = self.path_to_ino.get(path) {
            out.push((path.to_string(), *ino));
        }
        let prefix = if path == "/" { "/".to_string() } else { format!("{path}/") };
        for (k, v) in self.path_to_ino.range(prefix.clone()..) {
            if !k.starts_with(&prefix) {
                break;
            }
            if k != path {
                out.push((k.clone(), *v));
            }
        }
        out
    }

    fn drop_key(&mut self, key: &str, ino: u64) {
        self.path_to_ino.remove(key);
        if let Some(paths) = self.ino_to_paths.get_mut(&ino) {
            paths.retain(|p| p != key);
            if paths.is_empty() {
                self.ino_to_paths.remove(&ino);
            }
        }
    }

    fn remove(&mut self, path: &str) {
        for (k, ino) in self.subtree(path) {
            self.drop_key(&k, ino);
        }
    }

    fn rename(&mut self, old: &str, new: &str) {
        let moved = self.subtree(old);
        for (k, ino) in self.subtree(new) {
            if vpath::is_under(&k, old) {
                continue;
            }
            self.drop_key(&k, ino);
        }
        for (k, ino) in &moved {
            self.drop_key(k, *ino);
        }
        for (k, ino) in moved {
            let new_key = format!("{new}{}", &k[old.len()..]);
            let new_key = if new_key.is_empty() { "/".to_string() } else { new_key };
            self.path_to_ino.insert(new_key.clone(), ino);
            let paths = self.ino_to_paths.entry(ino).or_default();
            if !paths.contains(&new_key) {
                paths.push(new_key);
            }
        }
    }
}

struct CachedDir {
    entries: Arc<Vec<DirEntry>>,
    expires: Instant,
    /// a mutation happened since the snapshot: new listings refetch
    stale: bool,
    /// names removed since the snapshot (skipped by continuations)
    removed: Arc<HashSet<String>>,
    /// insertion counter for LRU eviction
    seq: u64,
}

/// A directory listing snapshot handed to `readdir`.
pub struct Listing {
    pub entries: Arc<Vec<DirEntry>>,
    pub removed: Arc<HashSet<String>>,
}

/// Readdir cache of the sandboxfs RPC (which has no directory handles),
/// shared with the controller fs API (which invalidates it).
///
/// Offsets are indices into a listing snapshot. A listing starting at offset
/// 0 uses a fresh snapshot; continuations (offset > 0) keep using the
/// snapshot they started from even after mutations, skipping names removed
/// since. Re-listing after a mutation would shift indices and make the guest
/// skip live entries (`rm -rf` leaving "Directory not empty" behind).
#[derive(Default)]
pub struct ReaddirCache {
    dirs: HashMap<String, CachedDir>,
    seq: u64,
}

impl ReaddirCache {
    fn get(&mut self, path: &str, offset: usize, now: Instant) -> Option<Listing> {
        let seq = self.seq + 1;
        let usable = match self.dirs.get(path) {
            Some(_) if offset > 0 => true,
            Some(c) => !c.stale && c.expires > now,
            None => false,
        };
        if !usable {
            return None;
        }
        let c = self.dirs.get_mut(path).unwrap();
        // sliding TTL keeps active pagination warm
        c.expires = now + READDIR_CACHE_TTL;
        c.seq = seq;
        self.seq = seq;
        Some(Listing { entries: c.entries.clone(), removed: c.removed.clone() })
    }

    fn put(&mut self, path: &str, entries: Arc<Vec<DirEntry>>, now: Instant) {
        self.dirs.remove(path);
        if self.dirs.len() >= READDIR_CACHE_MAX_DIRS
            && let Some(oldest) =
                self.dirs.iter().min_by_key(|(_, c)| c.seq).map(|(k, _)| k.clone())
        {
            self.dirs.remove(&oldest);
        }
        self.seq += 1;
        self.dirs.insert(
            path.to_string(),
            CachedDir {
                entries,
                expires: now + READDIR_CACHE_TTL,
                stale: false,
                removed: Arc::default(),
                seq: self.seq,
            },
        );
    }

    /// An entry was added to (or changed in) directory `dir`.
    pub fn changed(&mut self, dir: &str) {
        if let Some(c) = self.dirs.get_mut(dir) {
            c.stale = true;
        }
    }

    /// Entry `name` was removed from directory `dir`.
    pub fn removed(&mut self, dir: &str, name: &str) {
        if let Some(c) = self.dirs.get_mut(dir) {
            c.stale = true;
            Arc::make_mut(&mut c.removed).insert(name.to_string());
        }
    }

    /// `path` was removed or replaced: forget it and everything below.
    pub fn forget_tree(&mut self, path: &str) {
        self.dirs.retain(|k, _| !vpath::is_under(k, path));
    }

    /// Marks `paths` stale (and with `descendants` drops everything below them).
    pub fn invalidate(&mut self, paths: &[&str], descendants: bool) {
        for p in paths {
            self.changed(p);
            if descendants {
                self.dirs.retain(|k, _| k == p || !vpath::is_under(k, p));
            }
        }
    }

    pub fn clear(&mut self) {
        self.dirs.clear();
    }

    pub fn len(&self) -> usize {
        self.dirs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.dirs.is_empty()
    }
}

/// An inode with its attributes (lookup/create/mkdir/... results).
#[derive(Debug, Clone)]
pub struct EntryOut {
    pub ino: u64,
    pub attr: Attr,
}

/// One directory entry as returned to the guest.
#[derive(Debug, Clone)]
pub struct DirItem {
    pub ino: u64,
    pub name: String,
    /// `DT_*` type
    pub kind: u32,
    /// cookie of the next entry
    pub offset: u64,
}

/// A page of a directory listing.
pub struct DirPage {
    pub entries: Vec<DirItem>,
    /// offset to continue from (0 at the end)
    pub next_offset: u64,
}

/// An open directory (virtio-fs `opendir`): a snapshot of the listing.
struct DirHandle {
    path: String,
    entries: Arc<Vec<DirEntry>>,
}

fn validate_name(name: &str, op: &str) -> VfsResult<()> {
    if name.is_empty() || name.contains('/') || name.contains('\0') {
        return Err(VfsError::op(errno::EINVAL, op, name));
    }
    Ok(())
}

fn checked_add(a: u64, b: u64, op: &str) -> VfsResult<u64> {
    a.checked_add(b)
        .filter(|v| *v < (1u64 << 53))
        .ok_or_else(|| VfsError::op(errno::EINVAL, op, ""))
}

/// Node flag semantics of `open` (`parseOpenFlagsForOpen`): the flags and
/// whether to truncate through the handle.
pub fn open_flags_for_open(flags: u64) -> VfsResult<(OpenFlags, bool)> {
    use linux_open::*;
    if flags & O_CREAT != 0 {
        return Err(VfsError::op(errno::EINVAL, "open", ""));
    }
    let truncate = flags & O_TRUNC != 0;
    let access = flags & O_ACCMODE;
    let append = flags & O_APPEND != 0 && access != O_RDONLY;
    let f = if append {
        OpenFlags {
            read: access == O_RDWR,
            write: true,
            append: true,
            create: true,
            truncate: false,
        }
    } else if access == O_RDWR || access == O_WRONLY {
        OpenFlags::READ_WRITE
    } else {
        OpenFlags::READ
    };
    Ok((f, truncate))
}

/// Node flag semantics of `create` (`openFlagsToString(flags, true)`).
pub fn open_flags_for_create(flags: u64) -> OpenFlags {
    use linux_open::*;
    let rw = flags & O_ACCMODE == O_RDWR;
    if flags & O_APPEND != 0 {
        OpenFlags { read: rw, write: true, append: true, create: true, truncate: false }
    } else {
        OpenFlags { read: rw, write: true, append: false, create: true, truncate: true }
    }
}

const R_OK: u64 = 4;
const W_OK: u64 = 2;
const X_OK: u64 = 1;

/// The shared inode-level state over the (hooked) mount table.
pub struct FsCore {
    root: DynProvider,
    router: Arc<MountRouter>,
    inodes: Mutex<Inodes>,
    handles: Mutex<HashMap<u64, HandleEntry>>,
    dirs: Mutex<HashMap<u64, DirHandle>>,
    next_handle: AtomicU64,
    readdir: Arc<Mutex<ReaddirCache>>,
    metrics: Mutex<Metrics>,
}

impl FsCore {
    pub fn new(root: DynProvider, router: Arc<MountRouter>) -> FsCore {
        FsCore {
            root,
            router,
            inodes: Mutex::new(Inodes::new()),
            handles: Mutex::new(HashMap::new()),
            dirs: Mutex::new(HashMap::new()),
            next_handle: AtomicU64::new(1),
            readdir: Arc::new(Mutex::new(ReaddirCache::default())),
            metrics: Mutex::new(Metrics::default()),
        }
    }

    /// The readdir cache, for invalidation by other mutators.
    pub fn readdir_cache(&self) -> Arc<Mutex<ReaddirCache>> {
        self.readdir.clone()
    }

    pub fn metrics(&self) -> Metrics {
        self.metrics.lock().unwrap().clone()
    }

    /// Counts one finished request.
    pub fn record(&self, op: &str, ok: bool) {
        let mut m = self.metrics.lock().unwrap();
        m.requests += 1;
        *m.ops.entry(op.to_string()).or_default() += 1;
        if !ok {
            m.errors += 1;
        }
    }

    fn require_path(&self, ino: u64, op: &str) -> VfsResult<String> {
        self.inodes
            .lock()
            .unwrap()
            .path(ino)
            .map(str::to_string)
            .ok_or_else(|| VfsError::op(errno::ENOENT, op, ""))
    }

    /// `(parent path, child path)` of `name` in directory `parent`.
    pub fn child_path(&self, parent: u64, name: &str, op: &str) -> VfsResult<(String, String)> {
        validate_name(name, op)?;
        let parent_path = self.require_path(parent, op)?;
        let path = vpath::join(&parent_path, name);
        Ok((parent_path, path))
    }

    fn dir_changed(&self, dir: &str) {
        self.readdir.lock().unwrap().changed(dir);
    }

    fn entry_removed(&self, path: &str, tree: bool) {
        let mut cache = self.readdir.lock().unwrap();
        cache.removed(vpath::parent(path), vpath::basename(path));
        if tree {
            cache.forget_tree(path);
        }
    }

    fn alloc_handle(&self, handle: Handle, path: String) -> u64 {
        let fh = self.next_handle.fetch_add(1, Ordering::Relaxed);
        self.handles.lock().unwrap().insert(fh, HandleEntry { handle, path });
        fh
    }

    fn handle(&self, fh: u64, op: &str) -> VfsResult<(Handle, String)> {
        self.handles
            .lock()
            .unwrap()
            .get(&fh)
            .map(|h| (h.handle.clone(), h.path.clone()))
            .ok_or_else(|| VfsError::op(errno::EBADF, op, ""))
    }

    fn entry(&self, path: &str, attr: Attr, preferred: Option<u64>) -> EntryOut {
        let ino = self.inodes.lock().unwrap().reference(path, preferred);
        EntryOut { ino, attr }
    }

    /// Ino of a path without a lookup reference (readdir entries).
    fn ino_of(&self, path: &str) -> u64 {
        self.inodes.lock().unwrap().ensure(path, None)
    }

    pub fn forget(&self, ino: u64, n: u64) {
        self.inodes.lock().unwrap().forget(ino, n);
    }

    pub async fn lookup(&self, parent: u64, name: &str) -> VfsResult<EntryOut> {
        let (_, path) = self.child_path(parent, name, "lookup")?;
        let attr = self.root.lstat(&path).await?;
        Ok(self.entry(&path, attr, None))
    }

    pub async fn getattr(&self, ino: u64) -> VfsResult<Attr> {
        let path = self.require_path(ino, "getattr")?;
        self.root.lstat(&path).await
    }

    /// Attributes through an open handle (works for unlinked files).
    pub async fn getattr_fh(&self, fh: u64) -> VfsResult<Attr> {
        let (handle, _) = self.handle(fh, "fstat")?;
        handle.stat().await
    }

    pub async fn readlink(&self, ino: u64) -> VfsResult<String> {
        let path = self.require_path(ino, "readlink")?;
        self.root.readlink(&path).await
    }

    async fn listing(&self, path: &str, offset: usize) -> VfsResult<Listing> {
        if let Some(l) = self.readdir.lock().unwrap().get(path, offset, Instant::now()) {
            return Ok(l);
        }
        let entries = Arc::new(self.root.readdir(path).await?);
        self.readdir.lock().unwrap().put(path, entries.clone(), Instant::now());
        Ok(Listing { entries, removed: Arc::default() })
    }

    async fn dir_items(
        &self,
        path: &str,
        entries: &[DirEntry],
        removed: &HashSet<String>,
        offset: usize,
        max_entries: usize,
    ) -> DirPage {
        let mut out = Vec::new();
        let mut index = offset.min(entries.len());
        while index < entries.len() && out.len() < max_entries {
            let entry = &entries[index];
            index += 1;
            if entry.name.is_empty() || entry.name.contains('/') || entry.name.contains('\0') {
                continue;
            }
            if removed.contains(&entry.name) {
                continue;
            }
            let child = vpath::join(path, &entry.name);
            let ino = self.ino_of(&child);
            let kind = match entry.kind {
                Some(k) => Some(k),
                None => self.root.lstat(&child).await.ok().and_then(|a| a.kind()),
            };
            out.push(DirItem {
                ino,
                name: entry.name.clone(),
                kind: dirent_type(kind),
                offset: index as u64,
            });
        }
        let next_offset = if index >= entries.len() { 0 } else { index as u64 };
        DirPage { entries: out, next_offset }
    }

    /// sandboxfs-style readdir without a directory handle (cached snapshots).
    pub async fn readdir(&self, ino: u64, offset: u64, max_entries: usize) -> VfsResult<DirPage> {
        let path = self.require_path(ino, "readdir")?;
        let Listing { entries, removed } = self.listing(&path, offset as usize).await?;
        Ok(self.dir_items(&path, &entries, &removed, offset as usize, max_entries).await)
    }

    /// Opens a directory: the listing is snapshotted for its whole lifetime.
    pub async fn opendir(&self, ino: u64) -> VfsResult<u64> {
        let path = self.require_path(ino, "opendir")?;
        let attr = self.root.stat(&path).await?;
        if !attr.is_dir() {
            return Err(VfsError::op(errno::ENOTDIR, "opendir", &path));
        }
        let fh = self.next_handle.fetch_add(1, Ordering::Relaxed);
        self.dirs.lock().unwrap().insert(fh, DirHandle { path, entries: Arc::new(Vec::new()) });
        Ok(fh)
    }

    /// Entries of an open directory from `offset`, including `.` and `..`
    /// (cookies 1 and 2; entry `i` of the listing has cookie `i + 3`).
    pub async fn readdir_handle(
        &self,
        dh: u64,
        offset: u64,
        max: usize,
    ) -> VfsResult<Vec<DirItem>> {
        let (path, mut entries) = {
            let dirs = self.dirs.lock().unwrap();
            let d = dirs.get(&dh).ok_or_else(|| VfsError::op(errno::EBADF, "readdir", ""))?;
            (d.path.clone(), d.entries.clone())
        };
        if offset == 0 {
            // (re)reading from the start takes a fresh snapshot (rewinddir)
            entries = Arc::new(self.root.readdir(&path).await?);
            if let Some(d) = self.dirs.lock().unwrap().get_mut(&dh) {
                d.entries = entries.clone();
            }
        }
        let mut out = Vec::new();
        if offset < 1 {
            out.push(DirItem {
                ino: self.ino_of(&path),
                name: ".".into(),
                kind: dirent_type(Some(EntryKind::Dir)),
                offset: 1,
            });
        }
        if offset < 2 {
            let parent = vpath::parent(&path).to_string();
            out.push(DirItem {
                ino: self.ino_of(&parent),
                name: "..".into(),
                kind: dirent_type(Some(EntryKind::Dir)),
                offset: 2,
            });
        }
        let start = offset.saturating_sub(2) as usize;
        let page = self.dir_items(&path, &entries, &HashSet::new(), start, max).await;
        out.extend(page.entries.into_iter().map(|mut e| {
            e.offset += 2;
            e
        }));
        Ok(out)
    }

    pub fn releasedir(&self, dh: u64) {
        self.dirs.lock().unwrap().remove(&dh);
    }

    /// Opens inode `ino` with Linux open `flags`.
    pub async fn open(&self, ino: u64, flags: u64) -> VfsResult<u64> {
        let path = self.require_path(ino, "open")?;
        let (open_flags, truncate) = open_flags_for_open(flags)?;
        // O_TRUNC needs a writable handle (read-only mounts answer EROFS)
        let open_flags =
            OpenFlags { create: false, write: open_flags.write || truncate, ..open_flags };
        let handle = self.root.open(&path, open_flags, 0o644).await?;
        if truncate && let Err(e) = handle.truncate(0).await {
            let _ = handle.close().await;
            return Err(e);
        }
        Ok(self.alloc_handle(handle, path))
    }

    pub async fn read(&self, fh: u64, offset: u64, size: usize) -> VfsResult<Vec<u8>> {
        let (handle, _) = self.handle(fh, "read")?;
        let data = handle.read(offset, size).await?;
        self.metrics.lock().unwrap().bytes_read += data.len() as u64;
        Ok(data)
    }

    pub async fn write(&self, fh: u64, offset: u64, data: &[u8]) -> VfsResult<usize> {
        let (handle, _) = self.handle(fh, "write")?;
        let written = handle.write(offset, data).await?;
        self.metrics.lock().unwrap().bytes_written += written as u64;
        Ok(written)
    }

    /// The provider handle of `fh` (zero-copy fast paths).
    pub fn file_handle(&self, fh: u64) -> VfsResult<Handle> {
        self.handle(fh, "fh").map(|(h, _)| h)
    }

    pub async fn create(
        &self,
        parent: u64,
        name: &str,
        mode: u32,
        flags: u64,
    ) -> VfsResult<(EntryOut, u64)> {
        let (parent_path, path) = self.child_path(parent, name, "create")?;
        let open_flags = open_flags_for_create(flags);
        let handle = self.root.open(&path, open_flags, mode & 0o7777).await?;
        let attr = match handle.stat().await {
            Ok(a) => a,
            Err(e) => {
                let _ = handle.close().await;
                return Err(e);
            }
        };
        let entry = self.entry(&path, attr, None);
        let fh = self.alloc_handle(handle, path);
        self.dir_changed(&parent_path);
        Ok((entry, fh))
    }

    pub async fn mkdir(&self, parent: u64, name: &str, mode: u32) -> VfsResult<EntryOut> {
        let (parent_path, path) = self.child_path(parent, name, "mkdir")?;
        self.root.mkdir(&path, mode & 0o7777, false).await?;
        let attr = self.root.stat(&path).await?;
        self.dir_changed(&parent_path);
        Ok(self.entry(&path, attr, None))
    }

    pub async fn symlink(&self, parent: u64, name: &str, target: &str) -> VfsResult<EntryOut> {
        let (parent_path, path) = self.child_path(parent, name, "symlink")?;
        self.root.symlink(target, &path).await?;
        self.dir_changed(&parent_path);
        let attr = self.root.lstat(&path).await?;
        Ok(self.entry(&path, attr, None))
    }

    pub async fn unlink(&self, parent: u64, name: &str, dir: bool) -> VfsResult<()> {
        let op = if dir { "rmdir" } else { "unlink" };
        let (_, path) = self.child_path(parent, name, op)?;
        if dir {
            self.root.rmdir(&path).await?;
        } else {
            self.root.unlink(&path).await?;
        }
        self.inodes.lock().unwrap().remove(&path);
        self.entry_removed(&path, dir);
        Ok(())
    }

    pub async fn rename(
        &self,
        old_parent: u64,
        old_name: &str,
        new_parent: u64,
        new_name: &str,
        flags: u64,
    ) -> VfsResult<()> {
        let (_, old_path) = self.child_path(old_parent, old_name, "rename")?;
        let (new_parent_path, new_path) = self.child_path(new_parent, new_name, "rename")?;
        if flags != 0 {
            return Err(VfsError::op(errno::EINVAL, "rename", ""));
        }
        self.root.rename(&old_path, &new_path).await?;
        self.inodes.lock().unwrap().rename(&old_path, &new_path);
        for h in self.handles.lock().unwrap().values_mut() {
            if vpath::is_under(&h.path, &old_path) {
                h.path = format!("{new_path}{}", &h.path[old_path.len()..]);
            }
        }
        for d in self.dirs.lock().unwrap().values_mut() {
            if vpath::is_under(&d.path, &old_path) {
                d.path = format!("{new_path}{}", &d.path[old_path.len()..]);
            }
        }
        self.entry_removed(&old_path, true);
        // the destination may have replaced an entry: same name, new object
        self.entry_removed(&new_path, true);
        self.dir_changed(&new_parent_path);
        Ok(())
    }

    pub async fn link(&self, old_ino: u64, new_parent: u64, new_name: &str) -> VfsResult<EntryOut> {
        let (new_parent_path, new_path) = self.child_path(new_parent, new_name, "link")?;
        let old_path = self.require_path(old_ino, "link")?;
        self.root.link(&old_path, &new_path).await?;
        let attr = self.root.lstat(&new_path).await?;
        self.dir_changed(&new_parent_path);
        Ok(self.entry(&new_path, attr, Some(old_ino)))
    }

    pub async fn access(&self, ino: u64, mask: u64, uid: u64, gid: u64) -> VfsResult<()> {
        if mask & !(R_OK | W_OK | X_OK) != 0 {
            return Err(VfsError::op(errno::EINVAL, "access", ""));
        }
        let path = self.require_path(ino, "access")?;
        match self.root.access(&path, mask as u32).await {
            Err(e) if e.is(errno::ENOSYS) => {}
            res => return res,
        }
        // mode-bit check (`checkAccessByStat`)
        let st = self.root.stat(&path).await?;
        if mask == 0 {
            return Ok(());
        }
        let deny = || VfsError::op(errno::EACCES, "access", &path);
        if mask & W_OK != 0 && self.router.readonly_at(&path) {
            return Err(VfsError::op(errno::EROFS, "access", &path));
        }
        let bits = st.mode & 0o777;
        if uid == 0 {
            if mask & X_OK != 0 && bits & 0o111 == 0 {
                return Err(deny());
            }
            return Ok(());
        }
        let shift = if uid == st.uid as u64 {
            6
        } else if gid == st.gid as u64 {
            3
        } else {
            0
        };
        let granted = (bits >> shift) & 7;
        if (mask & R_OK != 0 && granted & 4 == 0)
            || (mask & W_OK != 0 && granted & 2 == 0)
            || (mask & X_OK != 0 && granted & 1 == 0)
        {
            return Err(deny());
        }
        Ok(())
    }

    /// Path truncate, or through `fh` when given.
    pub async fn truncate(&self, ino: u64, fh: Option<u64>, size: u64) -> VfsResult<()> {
        if let Some(fh) = fh
            && let Ok((handle, _)) = self.handle(fh, "ftruncate")
        {
            return handle.truncate(size).await;
        }
        let path = self.require_path(ino, "truncate")?;
        self.root.truncate(&path, size).await
    }

    pub async fn chmod(&self, ino: u64, mode: u32) -> VfsResult<()> {
        let path = self.require_path(ino, "chmod")?;
        self.root.chmod(&path, mode & 0o7777).await
    }

    /// Sets access/modification times (`None`: now; unsupported providers ignore it).
    pub async fn utimes(
        &self,
        ino: u64,
        atime_ms: Option<Option<i64>>,
        mtime_ms: Option<Option<i64>>,
    ) -> VfsResult<()> {
        let path = self.require_path(ino, "utimes")?;
        match self.root.utimes(&path, atime_ms, mtime_ms).await {
            Err(e) if e.is(errno::ENOSYS) => Ok(()),
            r => r,
        }
    }

    pub async fn fallocate(&self, fh: u64, offset: u64, length: u64, mode: u64) -> VfsResult<()> {
        if mode != 0 {
            return Err(VfsError::op(errno::EOPNOTSUPP, "fallocate", ""));
        }
        let (handle, _) = self.handle(fh, "fallocate")?;
        let end = checked_add(offset, length, "fallocate")?;
        let st = handle.stat().await?;
        if end > st.size {
            handle.truncate(end).await?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn copy_file_range(
        &self,
        fh_in: u64,
        off_in: u64,
        fh_out: u64,
        off_out: u64,
        len: u64,
        flags: u64,
        chunk_max: usize,
    ) -> VfsResult<u64> {
        let op = "copy_file_range";
        if flags != 0 || len > 0xffff_ffff {
            return Err(VfsError::op(errno::EINVAL, op, ""));
        }
        let (src, src_path) = self.handle(fh_in, op)?;
        let (dst, dst_path) = self.handle(fh_out, op)?;
        if len == 0 {
            return Ok(0);
        }
        let src_end = checked_add(off_in, len, op)?;
        let dst_end = checked_add(off_out, len, op)?;
        if src_path == dst_path && off_in < dst_end && off_out < src_end {
            return Err(VfsError::op(errno::EINVAL, op, ""));
        }
        let chunk_limit = (len as usize).clamp(1, chunk_max);
        let mut copied: u64 = 0;
        while copied < len {
            let chunk = chunk_limit.min((len - copied) as usize);
            let data = src.read(checked_add(off_in, copied, op)?, chunk).await?;
            if data.is_empty() {
                break;
            }
            let mut written = 0usize;
            while written < data.len() {
                let pos = checked_add(checked_add(off_out, copied, op)?, written as u64, op)?;
                let n = dst.write(pos, &data[written..]).await?;
                if n == 0 {
                    return Err(VfsError::op(errno::EIO, op, ""));
                }
                written += n;
            }
            copied += written as u64;
            {
                let mut m = self.metrics.lock().unwrap();
                m.bytes_read += data.len() as u64;
                m.bytes_written += written as u64;
            }
            if data.len() < chunk {
                break;
            }
        }
        Ok(copied)
    }

    /// `close()` of a file descriptor: commits buffered data (object tier),
    /// so the error reaches the guest's `close()`.
    pub async fn flush(&self, fh: u64) -> VfsResult<()> {
        let (handle, _) = self.handle(fh, "flush")?;
        handle.flush().await
    }

    pub async fn fsync(&self, fh: u64) -> VfsResult<()> {
        let (handle, _) = self.handle(fh, "fsync")?;
        handle.sync().await
    }

    pub async fn release(&self, fh: u64) -> VfsResult<()> {
        let entry = self
            .handles
            .lock()
            .unwrap()
            .remove(&fh)
            .ok_or_else(|| VfsError::op(errno::EBADF, "release", ""))?;
        entry.handle.close().await
    }

    pub async fn statfs(&self, ino: u64) -> VfsResult<StatFs> {
        let path = self.require_path(ino, "statfs")?;
        match self.root.statfs(&path).await {
            Ok(s) => Ok(s.normalized()),
            Err(e) if e.is(errno::ENOSYS) => Ok(StatFs::SYNTHETIC),
            Err(e) => Err(e),
        }
    }

    /// Closes every open handle.
    pub async fn close(&self) {
        let handles: Vec<HandleEntry> =
            self.handles.lock().unwrap().drain().map(|(_, h)| h).collect();
        self.dirs.lock().unwrap().clear();
        self.readdir.lock().unwrap().clear();
        for h in handles {
            let _ = h.handle.close().await;
        }
    }

    /// Number of open file handles.
    pub fn open_handles(&self) -> usize {
        self.handles.lock().unwrap().len()
    }
}

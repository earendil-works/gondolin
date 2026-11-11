//! Object tier: a native cache in front of a whole-file provider that lives in
//! the controller (reached through [`ObjectBackend`]).
//!
//! The daemon serves every per-op semantic itself (handles, offsets, partial
//! I/O, attributes):
//! - stats, negative lookups and listings are cached for `cache.ttl_ms`
//!   (0 = revalidate on every lookup/open);
//! - file contents are fetched lazily in [`CHUNK`]-sized `read_file` calls
//!   when first read and kept while the file is open (clean contents of closed
//!   files stay cached up to `cache.max_bytes` and `ttl_ms`);
//! - with `commit: close` writes stay local and the whole file is committed
//!   with `write_file` (in chunks) when a dirty handle is released (or synced);
//!   the commit error is returned from that release; with `commit: write`
//!   every write/truncate is forwarded before the guest gets its reply;
//! - metadata mutations (mkdir, unlink, rename, ...) are forwarded at once.

use crate::BoxFuture;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gondolin_proto::vfs::{
    CommitMode, EntryKind, Enumeration, ObjectDirEntry, ObjectMountConfig, ObjectStat, VfsCall,
    VfsCallResult, VfsOp,
};

use crate::ObjectBackend;
use crate::error::{VfsError, VfsResult, errno};
use crate::provider::{FileHandle, Handle, Provider};
use crate::types::{Attr, DirEntry, OpenFlags, kind_mode, now_ms, vpath};

/// Transfer unit for `read_file` / `write_file`, in `bytes`.
pub const CHUNK: u64 = 1024 * 1024;
/// Most chunks fetched by one sequential `read_file` (fits a 4 MiB frame).
const MAX_READAHEAD: u64 = 3;
const MAX_SYMLINKS: u32 = 40;
/// Longest validity of a cached negative lookup (the node engine's negative
/// entry TTL).
const NEGATIVE_TTL: Duration = Duration::from_millis(250);

struct StatEntry {
    /// `None` for a cached negative lookup
    stat: Option<ObjectStat>,
    at: Instant,
}

struct DirCache {
    entries: Vec<ObjectDirEntry>,
    at: Instant,
}

struct Content {
    /// logical size in `bytes`
    size: u64,
    /// prefix of the file that exists on the controller side and can be fetched
    backend_size: u64,
    /// loaded chunks by index; each holds `min(CHUNK, size - index * CHUNK)` bytes
    chunks: BTreeMap<u64, Vec<u8>>,
    /// local changes not yet committed (`commit: close`)
    dirty: bool,
    /// created locally and not committed yet (`commit: close`)
    is_new: bool,
    /// removed while open: never commit
    unlinked: bool,
    perm: u32,
    mtime_ms: i64,
    /// when the backing stat/content was fetched
    fetched: Instant,
    /// the content no longer matches the backend (invalidated while open)
    stale: bool,
    /// end offset of the last read (sequential access detection)
    read_end: u64,
    /// chunks fetched per round trip; grows while reads are sequential
    readahead: u64,
}

impl Content {
    fn chunk_len(&self, idx: u64) -> usize {
        let start = idx * CHUNK;
        if start >= self.size { 0 } else { (self.size - start).min(CHUNK) as usize }
    }

    fn loaded_bytes(&self) -> u64 {
        self.chunks.values().map(|c| c.len() as u64).sum()
    }

    fn set_size(&mut self, size: u64) {
        if size < self.size {
            let keep = size.div_ceil(CHUNK);
            self.chunks.retain(|idx, _| *idx < keep);
            if !size.is_multiple_of(CHUNK)
                && let Some(last) = self.chunks.get_mut(&(size / CHUNK))
            {
                last.truncate((size % CHUNK) as usize);
            }
            self.backend_size = self.backend_size.min(size);
        } else if size > self.size {
            // the old last chunk grows with zeros
            if !self.size.is_multiple_of(CHUNK)
                && let Some(last) = self.chunks.get_mut(&(self.size / CHUNK))
            {
                let new_len = (size - (self.size / CHUNK) * CHUNK).min(CHUNK) as usize;
                last.resize(new_len, 0);
            }
        }
        self.size = size;
    }
}

struct FileNode {
    path: Mutex<String>,
    content: tokio::sync::Mutex<Content>,
    open: AtomicU64,
    last_used: AtomicU64,
}

#[derive(Default)]
struct State {
    stats: HashMap<String, StatEntry>,
    dirs: HashMap<String, DirCache>,
    files: HashMap<String, Arc<FileNode>>,
    /// entries the daemon has seen (`enumeration: materialized`)
    known: BTreeSet<String>,
    seq: u64,
}

struct Inner {
    cfg: ObjectMountConfig,
    backend: Arc<dyn ObjectBackend>,
    state: Mutex<State>,
    ttl: Duration,
    uid: u32,
    gid: u32,
}

/// An object-tier mount.
pub struct ObjectProvider {
    inner: Arc<Inner>,
}

fn erofs<T>(op: &str, path: &str) -> VfsResult<T> {
    Err(VfsError::op(errno::EROFS, op, path))
}

impl ObjectProvider {
    pub fn new(cfg: ObjectMountConfig, backend: Arc<dyn ObjectBackend>) -> ObjectProvider {
        let ttl = Duration::from_millis(cfg.cache.ttl_ms);
        ObjectProvider {
            inner: Arc::new(Inner {
                cfg,
                backend,
                state: Mutex::new(State::default()),
                ttl,
                uid: 0,
                gid: 0,
            }),
        }
    }

    pub fn mount_id(&self) -> u32 {
        self.inner.cfg.mount_id
    }

    /// Writes stay local until a handle is flushed/released.
    pub fn commits_on_close(&self) -> bool {
        self.inner.cfg.writable && self.inner.cfg.commit == CommitMode::Close
    }

    /// Drops cached stats, listings and clean contents at or below `path`
    /// (everything when `None`). Open files keep their contents.
    pub fn invalidate_path(&self, path: Option<&str>) {
        let path = path.map(vpath::normalize);
        let under = |k: &str| path.as_deref().is_none_or(|p| vpath::is_under(k, p));
        let mut st = self.inner.state.lock().unwrap();
        st.stats.retain(|k, _| !under(k));
        st.dirs.retain(|k, _| !under(k));
        if let Some(p) = &path {
            // the parent listing may include the invalidated entry
            st.dirs.remove(vpath::parent(p));
        }
        st.files.retain(|k, node| {
            if !under(k) {
                return true;
            }
            match node.content.try_lock() {
                Ok(mut c) => {
                    if c.dirty || node.open.load(Ordering::Relaxed) > 0 {
                        c.stale = true;
                        true
                    } else {
                        false
                    }
                }
                Err(_) => true,
            }
        });
    }

    fn check_writable(&self, op: &str, path: &str) -> VfsResult<()> {
        if self.inner.cfg.writable { Ok(()) } else { erofs(op, path) }
    }
}

impl Inner {
    async fn call(&self, op: VfsOp) -> VfsResult<VfsCallResult> {
        self.backend.call(VfsCall { mount_id: self.cfg.mount_id, op }).await
    }

    fn fresh(&self, at: Instant) -> bool {
        !self.ttl.is_zero() && at.elapsed() < self.ttl
    }

    fn attr_from(&self, s: &ObjectStat) -> Attr {
        let now = now_ms();
        let default_perm = match s.kind {
            EntryKind::Dir => 0o755,
            EntryKind::Symlink => 0o777,
            EntryKind::File => 0o644,
        };
        Attr {
            mode: kind_mode(s.kind) | (s.mode.unwrap_or(default_perm) & 0o7777),
            size: if s.kind == EntryKind::Dir { s.size.max(4096) } else { s.size },
            nlink: s.nlink.unwrap_or(1),
            uid: s.uid.unwrap_or(self.uid),
            gid: s.gid.unwrap_or(self.gid),
            atime_ms: s.atime_ms.or(s.mtime_ms).unwrap_or(now),
            mtime_ms: s.mtime_ms.unwrap_or(now),
            ctime_ms: s.ctime_ms.or(s.mtime_ms).unwrap_or(now),
        }
    }

    fn remember(&self, st: &mut State, path: &str) {
        if self.cfg.enumeration == Enumeration::Materialized {
            let mut p = path.to_string();
            while p != "/" {
                st.known.insert(p.clone());
                p = vpath::parent(&p).to_string();
            }
        }
    }

    /// Backend stat with caching (no symlink following).
    async fn backend_stat(&self, path: &str) -> VfsResult<ObjectStat> {
        {
            let st = self.state.lock().unwrap();
            if let Some(e) = st.stats.get(path)
                && self.fresh(e.at)
                && (e.stat.is_some() || e.at.elapsed() < NEGATIVE_TTL)
            {
                return e.stat.clone().ok_or_else(|| VfsError::op(errno::ENOENT, "stat", path));
            }
        }
        let inline = self.cfg.cache.inline_max_bytes;
        let res = self
            .call(VfsOp::Stat {
                path: path.to_string(),
                inline_max: (inline > 0).then_some(inline),
            })
            .await;
        if let Ok(r) = &res
            && let (Some(stat), Some(data)) = (&r.stat, &r.data)
            && stat.kind == EntryKind::File
            && data.len() as u64 == stat.size
        {
            self.store_inline(path, stat, data.to_vec()).await;
        }
        let mut st = self.state.lock().unwrap();
        match res {
            Ok(r) => {
                let stat = r.stat.ok_or_else(|| VfsError::op(errno::EIO, "stat", path))?;
                st.stats.insert(
                    path.to_string(),
                    StatEntry { stat: Some(stat.clone()), at: Instant::now() },
                );
                self.remember(&mut st, path);
                Ok(stat)
            }
            Err(e) => {
                if e.is(errno::ENOENT) {
                    st.stats.insert(path.to_string(), StatEntry { stat: None, at: Instant::now() });
                    st.known.remove(path);
                }
                Err(e)
            }
        }
    }

    /// Caches contents that came with a stat (closed, clean files only).
    async fn store_inline(&self, path: &str, stat: &ObjectStat, data: Vec<u8>) {
        let existing = self.state.lock().unwrap().files.get(path).cloned();
        let attr = self.attr_from(stat);
        let mut chunks = BTreeMap::new();
        if !data.is_empty() {
            chunks.insert(0, data);
        }
        let content = Content {
            size: attr.size,
            backend_size: attr.size,
            chunks,
            dirty: false,
            is_new: false,
            unlinked: false,
            perm: attr.perm(),
            mtime_ms: attr.mtime_ms,
            fetched: Instant::now(),
            stale: false,
            read_end: 0,
            readahead: 1,
        };
        if let Some(node) = existing {
            let mut c = node.content.lock().await;
            if c.dirty || node.open.load(Ordering::Relaxed) > 0 {
                return;
            }
            *c = content;
            return;
        }
        let node = Arc::new(FileNode {
            path: Mutex::new(path.to_string()),
            content: tokio::sync::Mutex::new(content),
            open: AtomicU64::new(0),
            last_used: AtomicU64::new(0),
        });
        self.state.lock().unwrap().files.insert(path.to_string(), node);
    }

    /// Attributes of `path`, preferring an open or dirty local file.
    async fn lstat(&self, path: &str) -> VfsResult<Attr> {
        let node = self.state.lock().unwrap().files.get(path).cloned();
        if let Some(node) = node {
            let c = node.content.lock().await;
            if (c.dirty || node.open.load(Ordering::Relaxed) > 0) && !c.unlinked {
                let now = now_ms();
                return Ok(Attr {
                    mode: kind_mode(EntryKind::File) | c.perm,
                    size: c.size,
                    nlink: 1,
                    uid: self.uid,
                    gid: self.gid,
                    atime_ms: now,
                    mtime_ms: c.mtime_ms,
                    ctime_ms: c.mtime_ms,
                });
            }
        }
        let stat = self.backend_stat(path).await?;
        Ok(self.attr_from(&stat))
    }

    /// Follows symlinks inside the mount.
    async fn resolve(&self, path: &str) -> VfsResult<String> {
        let mut current = vpath::normalize(path);
        for _ in 0..MAX_SYMLINKS {
            let attr = self.lstat(&current).await?;
            if !attr.is_symlink() {
                return Ok(current);
            }
            let r = self.call(VfsOp::Readlink { path: current.clone() }).await?;
            let target = r.target.ok_or_else(|| VfsError::op(errno::EIO, "readlink", &current))?;
            current = if target.starts_with('/') {
                vpath::normalize(&target)
            } else {
                vpath::normalize(&format!("{}/{}", vpath::parent(&current), target))
            };
        }
        Err(VfsError::op(errno::ELOOP, "stat", path))
    }

    /// Drops cached metadata for a mutated path.
    fn forget(&self, path: &str, descendants: bool) {
        let mut st = self.state.lock().unwrap();
        if descendants {
            st.stats.retain(|k, _| !vpath::is_under(k, path));
            st.dirs.retain(|k, _| !vpath::is_under(k, path));
        } else {
            st.stats.remove(path);
            st.dirs.remove(path);
        }
        st.dirs.remove(vpath::parent(path));
    }

    fn touch(&self, node: &FileNode) {
        let mut st = self.state.lock().unwrap();
        st.seq += 1;
        node.last_used.store(st.seq, Ordering::Relaxed);
    }

    /// Loads chunk `idx` (and, with readahead, the missing chunks after it)
    /// in one `read_file`.
    async fn ensure_chunk_run(
        &self,
        path: &str,
        c: &mut Content,
        idx: u64,
        run: u64,
    ) -> VfsResult<()> {
        if c.chunks.contains_key(&idx) {
            return Ok(());
        }
        let start = idx * CHUNK;
        if run <= 1 || start >= c.backend_size {
            return self.ensure_chunk(path, c, idx).await;
        }
        let mut count = 1;
        while count < run
            && !c.chunks.contains_key(&(idx + count))
            && (idx + count) * CHUNK < c.backend_size.min(c.size)
        {
            count += 1;
        }
        let want = ((idx + count) * CHUNK).min(c.backend_size).min(c.size) - start;
        let r = self
            .call(VfsOp::ReadFile { path: path.to_string(), offset: start, length: Some(want) })
            .await?;
        let data = r.data.unwrap_or_default();
        if (data.len() as u64) < want {
            // the file shrank on the controller side
            c.backend_size = start + data.len() as u64;
            if !c.dirty {
                c.size = c.backend_size;
            }
        }
        for i in 0..count {
            let from = (i * CHUNK) as usize;
            if from >= data.len() && idx + i > idx {
                break;
            }
            let len = c.chunk_len(idx + i);
            let mut chunk = data[from.min(data.len())..(from + len).min(data.len())].to_vec();
            chunk.resize(len, 0);
            if len > 0 || (idx + i) * CHUNK < c.size {
                c.chunks.insert(idx + i, chunk);
            }
        }
        Ok(())
    }

    /// Loads chunk `idx` if missing.
    async fn ensure_chunk(&self, path: &str, c: &mut Content, idx: u64) -> VfsResult<()> {
        if c.chunks.contains_key(&idx) {
            return Ok(());
        }
        let start = idx * CHUNK;
        let len = c.chunk_len(idx);
        let mut data = Vec::new();
        if start < c.backend_size {
            let want = (c.backend_size - start).min(len as u64);
            let r = self
                .call(VfsOp::ReadFile { path: path.to_string(), offset: start, length: Some(want) })
                .await?;
            data = r.data.unwrap_or_default();
            if (data.len() as u64) < want {
                // the file shrank on the controller side
                c.backend_size = start + data.len() as u64;
                if !c.dirty {
                    c.size = c.backend_size;
                }
            }
            data.truncate(want as usize);
        }
        let len = c.chunk_len(idx);
        data.resize(len, 0);
        if len > 0 || start < c.size {
            c.chunks.insert(idx, data);
        }
        Ok(())
    }

    async fn read_range(
        &self,
        path: &str,
        c: &mut Content,
        offset: u64,
        len: usize,
    ) -> VfsResult<Vec<u8>> {
        let end = offset.saturating_add(len as u64).min(c.size);
        if offset >= end {
            return Ok(Vec::new());
        }
        // sequential reads fetch more chunks per round trip (up to what fits
        // in one frame)
        if offset == c.read_end && offset > 0 {
            c.readahead = (c.readahead * 2).clamp(1, MAX_READAHEAD);
        } else {
            c.readahead = 1;
        }
        c.read_end = end;
        let mut out = Vec::with_capacity((end - offset) as usize);
        let mut pos = offset;
        while pos < end {
            let idx = pos / CHUNK;
            self.ensure_chunk_run(path, c, idx, c.readahead).await?;
            if pos >= c.size {
                break;
            }
            let chunk = &c.chunks[&idx];
            let from = (pos - idx * CHUNK) as usize;
            let to = ((end.min(c.size) - idx * CHUNK) as usize).min(chunk.len());
            if from >= to {
                break;
            }
            out.extend_from_slice(&chunk[from..to]);
            pos = idx * CHUNK + to as u64;
        }
        Ok(out)
    }

    /// Applies a write to the local content (loading touched chunks first).
    async fn write_local(
        &self,
        path: &str,
        c: &mut Content,
        offset: u64,
        data: &[u8],
    ) -> VfsResult<()> {
        let end = offset + data.len() as u64;
        // load chunks that will be partially overwritten while the old size still applies
        let first = offset / CHUNK;
        let last = (end.max(1) - 1) / CHUNK;
        for idx in [first, last] {
            if idx * CHUNK < c.size.min(c.backend_size) {
                self.ensure_chunk(path, c, idx).await?;
            }
        }
        if end > c.size {
            c.set_size(end);
        }
        let mut pos = offset;
        let mut src = 0usize;
        while src < data.len() {
            let idx = pos / CHUNK;
            let in_chunk = (pos - idx * CHUNK) as usize;
            let len = c.chunk_len(idx);
            if !c.chunks.contains_key(&idx) {
                if idx * CHUNK < c.backend_size {
                    self.ensure_chunk(path, c, idx).await?;
                } else {
                    c.chunks.insert(idx, vec![0; len]);
                }
            }
            let chunk = c.chunks.get_mut(&idx).unwrap();
            if chunk.len() < len {
                chunk.resize(len, 0);
            }
            let n = (len - in_chunk).min(data.len() - src);
            chunk[in_chunk..in_chunk + n].copy_from_slice(&data[src..src + n]);
            src += n;
            pos += n as u64;
        }
        c.mtime_ms = now_ms();
        Ok(())
    }

    /// Commits a dirty file with chunked `write_file` calls.
    async fn commit(&self, node: &FileNode, c: &mut Content) -> VfsResult<()> {
        if !c.dirty || c.unlinked {
            return Ok(());
        }
        let path = node.path.lock().unwrap().clone();
        let chunks = c.size.div_ceil(CHUNK).max(1);
        for idx in 0..chunks {
            self.ensure_chunk(&path, c, idx).await?;
            let data = c.chunks.get(&idx).cloned().unwrap_or_default();
            let last = idx + 1 == chunks;
            self.call(VfsOp::WriteFile {
                path: path.clone(),
                data,
                offset: idx * CHUNK,
                last,
                mode: if c.is_new { Some(c.perm) } else { None },
            })
            .await?;
        }
        c.dirty = false;
        c.is_new = false;
        c.backend_size = c.size;
        c.fetched = Instant::now();
        let mut st = self.state.lock().unwrap();
        st.stats.insert(
            path.clone(),
            StatEntry {
                stat: Some(ObjectStat {
                    kind: EntryKind::File,
                    size: c.size,
                    mode: Some(c.perm),
                    mtime_ms: Some(c.mtime_ms),
                    ctime_ms: None,
                    atime_ms: None,
                    nlink: None,
                    uid: None,
                    gid: None,
                }),
                at: Instant::now(),
            },
        );
        st.dirs.remove(vpath::parent(&path));
        Ok(())
    }

    fn check_size(&self, size: u64, op: &str, path: &str) -> VfsResult<()> {
        match self.cfg.max_file_bytes {
            Some(max) if size > max => Err(VfsError::op(errno::EFBIG, op, path)),
            _ => Ok(()),
        }
    }

    /// Drops clean contents of closed files beyond the byte budget.
    fn evict(&self) {
        let mut st = self.state.lock().unwrap();
        let mut total: u64 = 0;
        let mut candidates = Vec::new();
        for (k, node) in &st.files {
            if let Ok(c) = node.content.try_lock()
                && !c.dirty
            {
                let bytes = c.loaded_bytes();
                total += bytes;
                if node.open.load(Ordering::Relaxed) == 0 {
                    candidates.push((node.last_used.load(Ordering::Relaxed), k.clone(), bytes));
                }
            }
        }
        if total <= self.cfg.cache.max_bytes {
            return;
        }
        candidates.sort();
        for (_, k, bytes) in candidates {
            if total <= self.cfg.cache.max_bytes {
                break;
            }
            st.files.remove(&k);
            total -= bytes;
        }
    }
}

impl Provider for ObjectProvider {
    fn readonly(&self) -> bool {
        !self.inner.cfg.writable
    }

    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move { self.inner.lstat(&vpath::normalize(path)).await })
    }

    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move {
            let resolved = self.inner.resolve(path).await?;
            self.inner.lstat(&resolved).await
        })
    }

    fn readdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<Vec<DirEntry>>> {
        Box::pin(async move {
            let inner = &self.inner;
            let p = inner.resolve(path).await?;
            let attr = inner.lstat(&p).await?;
            if !attr.is_dir() {
                return Err(VfsError::op(errno::ENOTDIR, "scandir", path));
            }
            let mut entries: Vec<ObjectDirEntry> = match inner.cfg.enumeration {
                Enumeration::None => Vec::new(),
                Enumeration::Materialized => {
                    let st = inner.state.lock().unwrap();
                    let prefix = if p == "/" { "/".to_string() } else { format!("{p}/") };
                    st.known
                        .range(prefix.clone()..)
                        .take_while(|k| k.starts_with(&prefix))
                        .filter(|k| !k[prefix.len()..].contains('/'))
                        .map(|k| {
                            let kind = st
                                .stats
                                .get(k.as_str())
                                .and_then(|e| e.stat.as_ref().map(|s| s.kind))
                                .unwrap_or(EntryKind::Dir);
                            ObjectDirEntry { name: k[prefix.len()..].to_string(), kind }
                        })
                        .collect()
                }
                Enumeration::List => {
                    let cached = {
                        let st = inner.state.lock().unwrap();
                        st.dirs.get(&p).filter(|d| inner.fresh(d.at)).map(|d| d.entries.clone())
                    };
                    match cached {
                        Some(e) => e,
                        None => {
                            let r = inner.call(VfsOp::Readdir { path: p.clone() }).await?;
                            let entries = r.entries.unwrap_or_default();
                            let mut st = inner.state.lock().unwrap();
                            st.dirs.insert(
                                p.clone(),
                                DirCache { entries: entries.clone(), at: Instant::now() },
                            );
                            entries
                        }
                    }
                }
            };
            // files created locally and not committed yet
            if inner.cfg.enumeration != Enumeration::None {
                let nodes: Vec<(String, Arc<FileNode>)> = {
                    let st = inner.state.lock().unwrap();
                    st.files
                        .iter()
                        .filter(|(k, _)| vpath::parent(k) == p && k.as_str() != "/")
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect()
                };
                for (k, node) in nodes {
                    let c = node.content.lock().await;
                    let name = vpath::basename(&k).to_string();
                    if c.is_new && !c.unlinked && !entries.iter().any(|e| e.name == name) {
                        entries.push(ObjectDirEntry { name, kind: EntryKind::File });
                    }
                }
            }
            Ok(entries.into_iter().map(|e| DirEntry { name: e.name, kind: Some(e.kind) }).collect())
        })
    }

    fn open<'a>(
        &'a self,
        path: &'a str,
        flags: OpenFlags,
        mode: u32,
    ) -> BoxFuture<'a, VfsResult<Handle>> {
        Box::pin(async move {
            let inner = &self.inner;
            if flags.is_write() {
                self.check_writable("open", path)?;
            }
            let p = match inner.resolve(path).await {
                Ok(p) => p,
                Err(e) if e.is(errno::ENOENT) && flags.create => vpath::normalize(path),
                Err(e) => return Err(e),
            };
            let existing = inner.state.lock().unwrap().files.get(&p).cloned();
            let node = match existing {
                Some(node) => {
                    let (busy, usable, size, mtime, fetched) = {
                        let c = node.content.lock().await;
                        (
                            c.dirty || node.open.load(Ordering::Relaxed) > 0,
                            !c.unlinked && !c.stale,
                            c.size,
                            c.mtime_ms,
                            c.fetched,
                        )
                    };
                    let reuse = if busy {
                        usable
                    } else if !usable {
                        false
                    } else if inner.cfg.cache.revalidate_open {
                        // a fresh stat decides whether the cached content is current
                        inner.state.lock().unwrap().stats.remove(&p);
                        match inner.lstat(&p).await {
                            Ok(a) => a.size == size && a.mtime_ms == mtime,
                            Err(_) => false,
                        }
                    } else {
                        inner.fresh(fetched)
                    };
                    if reuse { Some(node) } else { None }
                }
                None => {
                    if inner.cfg.cache.revalidate_open {
                        inner.state.lock().unwrap().stats.remove(&p);
                    }
                    None
                }
            };
            let node = match node {
                Some(node) => node,
                None => {
                    let content = match inner.lstat(&p).await {
                        Ok(attr) => {
                            if attr.is_dir() {
                                return Err(VfsError::op(errno::EISDIR, "open", path));
                            }
                            Content {
                                size: attr.size,
                                backend_size: attr.size,
                                chunks: BTreeMap::new(),
                                dirty: false,
                                is_new: false,
                                unlinked: false,
                                perm: attr.perm(),
                                mtime_ms: attr.mtime_ms,
                                fetched: Instant::now(),
                                stale: false,
                                read_end: 0,
                                readahead: 1,
                            }
                        }
                        Err(e) if e.is(errno::ENOENT) && flags.create => {
                            let perm = mode & 0o7777;
                            let commit_now = inner.cfg.commit == CommitMode::Write;
                            if commit_now {
                                inner
                                    .call(VfsOp::WriteFile {
                                        path: p.clone(),
                                        data: Vec::new(),
                                        offset: 0,
                                        last: true,
                                        mode: Some(perm),
                                    })
                                    .await?;
                            }
                            inner.forget(&p, false);
                            let mut st = inner.state.lock().unwrap();
                            inner.remember(&mut st, &p);
                            drop(st);
                            Content {
                                size: 0,
                                backend_size: 0,
                                chunks: BTreeMap::new(),
                                dirty: !commit_now,
                                is_new: !commit_now,
                                unlinked: false,
                                perm,
                                mtime_ms: now_ms(),
                                fetched: Instant::now(),
                                stale: false,
                                read_end: 0,
                                readahead: 1,
                            }
                        }
                        Err(e) => return Err(e),
                    };
                    let node = Arc::new(FileNode {
                        path: Mutex::new(p.clone()),
                        content: tokio::sync::Mutex::new(content),
                        open: AtomicU64::new(0),
                        last_used: AtomicU64::new(0),
                    });
                    inner.state.lock().unwrap().files.insert(p.clone(), node.clone());
                    node
                }
            };
            if flags.truncate {
                let mut c = node.content.lock().await;
                if c.size != 0 {
                    if inner.cfg.commit == CommitMode::Write {
                        inner.call(VfsOp::Truncate { path: p.clone(), size: 0 }).await?;
                        inner.forget(&p, false);
                    } else {
                        c.dirty = true;
                    }
                    c.set_size(0);
                    c.mtime_ms = now_ms();
                } else if inner.cfg.commit == CommitMode::Close {
                    // `w` on an existing empty file still rewrites it on close
                    c.dirty = true;
                }
            }
            node.open.fetch_add(1, Ordering::Relaxed);
            inner.touch(&node);
            Ok::<Handle, VfsError>(Arc::new(ObjectHandle {
                inner: inner.clone(),
                node,
                flags,
                wrote: AtomicU64::new(0),
                closed: Mutex::new(false),
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
            self.check_writable("mkdir", path)?;
            let p = vpath::normalize(path);
            let inner = &self.inner;
            if recursive {
                let mut current = String::from("/");
                for comp in vpath::components(&p).map(str::to_string).collect::<Vec<_>>() {
                    current = vpath::join(&current, &comp);
                    match inner.lstat(&current).await {
                        Ok(a) if a.is_dir() => continue,
                        Ok(_) => return Err(VfsError::op(errno::ENOTDIR, "mkdir", path)),
                        Err(e) if e.is(errno::ENOENT) => {}
                        Err(e) => return Err(e),
                    }
                    inner
                        .call(VfsOp::Mkdir { path: current.clone(), mode: Some(mode & 0o7777) })
                        .await?;
                    inner.forget(&current, false);
                    let mut st = inner.state.lock().unwrap();
                    inner.remember(&mut st, &current);
                }
                return Ok(());
            }
            let res = inner.call(VfsOp::Mkdir { path: p.clone(), mode: Some(mode & 0o7777) }).await;
            inner.forget(&p, false);
            res?;
            let mut st = inner.state.lock().unwrap();
            inner.remember(&mut st, &p);
            Ok(())
        })
    }

    fn rmdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            self.check_writable("rmdir", path)?;
            let p = vpath::normalize(path);
            let res = self.inner.call(VfsOp::Rmdir { path: p.clone() }).await;
            self.inner.forget(&p, true);
            res?;
            self.inner.state.lock().unwrap().known.retain(|k| !vpath::is_under(k, &p));
            Ok(())
        })
    }

    fn unlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            self.check_writable("unlink", path)?;
            let p = vpath::normalize(path);
            let inner = &self.inner;
            let node = inner.state.lock().unwrap().files.get(&p).cloned();
            if let Some(node) = &node {
                let mut c = node.content.lock().await;
                if c.is_new && !c.unlinked {
                    // never reached the controller
                    c.unlinked = true;
                    drop(c);
                    let mut st = inner.state.lock().unwrap();
                    st.files.remove(&p);
                    st.known.remove(&p);
                    return Ok(());
                }
            }
            let res = inner.call(VfsOp::Unlink { path: p.clone() }).await;
            inner.forget(&p, false);
            res?;
            let mut st = inner.state.lock().unwrap();
            if let Some(node) = st.files.remove(&p)
                && let Ok(mut c) = node.content.try_lock()
            {
                c.unlinked = true;
            }
            st.known.remove(&p);
            Ok(())
        })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            self.check_writable("rename", from)?;
            let (a, b) = (vpath::normalize(from), vpath::normalize(to));
            let inner = &self.inner;
            let local_only = {
                let node = inner.state.lock().unwrap().files.get(&a).cloned();
                match node {
                    Some(n) => n.content.lock().await.is_new,
                    None => false,
                }
            };
            if !local_only {
                let res = inner.call(VfsOp::Rename { from: a.clone(), to: b.clone() }).await;
                inner.forget(&a, true);
                inner.forget(&b, true);
                res?;
            }
            let mut st = inner.state.lock().unwrap();
            // move local file nodes along (dirty contents commit to the new path)
            let moved: Vec<String> =
                st.files.keys().filter(|k| vpath::is_under(k, &a)).cloned().collect();
            let replaced: Vec<String> = st
                .files
                .keys()
                .filter(|k| vpath::is_under(k, &b) && !vpath::is_under(k, &a))
                .cloned()
                .collect();
            for k in replaced {
                if let Some(node) = st.files.remove(&k)
                    && let Ok(mut c) = node.content.try_lock()
                {
                    c.unlinked = true;
                }
            }
            for k in moved {
                if let Some(node) = st.files.remove(&k) {
                    let nk = format!("{b}{}", &k[a.len()..]);
                    *node.path.lock().unwrap() = nk.clone();
                    st.files.insert(nk, node);
                }
            }
            let known: Vec<String> =
                st.known.iter().filter(|k| vpath::is_under(k, &a)).cloned().collect();
            for k in known {
                st.known.remove(&k);
                st.known.insert(format!("{b}{}", &k[a.len()..]));
            }
            drop(st);
            if local_only {
                inner.forget(&a, false);
                inner.forget(&b, false);
            }
            let mut st = inner.state.lock().unwrap();
            inner.remember(&mut st, &b);
            Ok(())
        })
    }

    fn link<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            self.check_writable("link", to)?;
            let (a, b) = (vpath::normalize(from), vpath::normalize(to));
            let res = self.inner.call(VfsOp::Link { from: a.clone(), to: b.clone() }).await;
            self.inner.forget(&a, false);
            self.inner.forget(&b, false);
            res.map(|_| ())
        })
    }

    fn symlink<'a>(&'a self, target: &'a str, path: &'a str) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            self.check_writable("symlink", path)?;
            let p = vpath::normalize(path);
            let res = self
                .inner
                .call(VfsOp::Symlink { target: target.to_string(), path: p.clone() })
                .await;
            self.inner.forget(&p, false);
            res?;
            let mut st = self.inner.state.lock().unwrap();
            self.inner.remember(&mut st, &p);
            Ok(())
        })
    }

    fn readlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<String>> {
        Box::pin(async move {
            let p = vpath::normalize(path);
            let r = self.inner.call(VfsOp::Readlink { path: p.clone() }).await?;
            r.target.ok_or_else(|| VfsError::op(errno::EIO, "readlink", &p))
        })
    }

    fn chmod<'a>(&'a self, path: &'a str, mode: u32) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            self.check_writable("chmod", path)?;
            let p = self.inner.resolve(path).await?;
            let node = self.inner.state.lock().unwrap().files.get(&p).cloned();
            if let Some(node) = node {
                let mut c = node.content.lock().await;
                c.perm = mode & 0o7777;
                if c.is_new {
                    return Ok(());
                }
            }
            let res = self.inner.call(VfsOp::Chmod { path: p.clone(), mode: mode & 0o7777 }).await;
            self.inner.forget(&p, false);
            res.map(|_| ())
        })
    }

    fn truncate<'a>(&'a self, path: &'a str, size: u64) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            self.check_writable("truncate", path)?;
            self.inner.check_size(size, "truncate", path)?;
            let p = self.inner.resolve(path).await?;
            let node = self.inner.state.lock().unwrap().files.get(&p).cloned();
            if let Some(node) = node {
                let mut c = node.content.lock().await;
                if c.dirty || node.open.load(Ordering::Relaxed) > 0 {
                    if self.inner.cfg.commit == CommitMode::Write || !c.dirty {
                        if !c.is_new {
                            self.inner.call(VfsOp::Truncate { path: p.clone(), size }).await?;
                        }
                        self.inner.forget(&p, false);
                        c.set_size(size);
                        c.backend_size = c.backend_size.min(size);
                        return Ok(());
                    }
                    c.set_size(size);
                    c.mtime_ms = now_ms();
                    return Ok(());
                }
            }
            let res = self.inner.call(VfsOp::Truncate { path: p.clone(), size }).await;
            self.inner.forget(&p, false);
            self.inner.state.lock().unwrap().files.remove(&p);
            res.map(|_| ())
        })
    }

    fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, VfsResult<String>> {
        Box::pin(async move { self.inner.resolve(path).await })
    }

    fn invalidate(&self, path: Option<&str>) {
        self.invalidate_path(path)
    }

    fn close<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let nodes: Vec<Arc<FileNode>> =
                self.inner.state.lock().unwrap().files.values().cloned().collect();
            for node in nodes {
                let mut c = node.content.lock().await;
                if let Err(e) = self.inner.commit(&node, &mut c).await {
                    gondolin_log::warn!(
                        "vfs: object mount {} commit failed at shutdown: {e}",
                        self.inner.cfg.mount_id
                    );
                }
            }
        })
    }
}

struct ObjectHandle {
    inner: Arc<Inner>,
    node: Arc<FileNode>,
    flags: OpenFlags,
    /// bytes written through this handle
    wrote: AtomicU64,
    closed: Mutex<bool>,
}

impl ObjectHandle {
    fn check_open(&self, op: &str) -> VfsResult<()> {
        if *self.closed.lock().unwrap() { Err(VfsError::op(errno::EBADF, op, "")) } else { Ok(()) }
    }

    fn path(&self) -> String {
        self.node.path.lock().unwrap().clone()
    }
}

impl FileHandle for ObjectHandle {
    fn read<'a>(&'a self, offset: u64, len: usize) -> BoxFuture<'a, VfsResult<Vec<u8>>> {
        Box::pin(async move {
            self.check_open("read")?;
            let path = self.path();
            let mut c = self.node.content.lock().await;
            let out = self.inner.read_range(&path, &mut c, offset, len).await;
            drop(c);
            self.inner.touch(&self.node);
            self.inner.evict();
            out
        })
    }

    fn write<'a>(&'a self, offset: u64, data: &'a [u8]) -> BoxFuture<'a, VfsResult<usize>> {
        Box::pin(async move {
            self.check_open("write")?;
            if !(self.flags.write || self.flags.append) {
                return Err(VfsError::op(errno::EBADF, "write", ""));
            }
            let path = self.path();
            let mut c = self.node.content.lock().await;
            let offset = if self.flags.append { c.size } else { offset };
            let end = offset
                .checked_add(data.len() as u64)
                .ok_or_else(|| VfsError::op(errno::EFBIG, "write", &path))?;
            self.inner.check_size(end, "write", &path)?;
            if self.inner.cfg.commit == CommitMode::Write && !c.is_new {
                self.inner
                    .call(VfsOp::Write { path: path.clone(), offset, data: data.to_vec() })
                    .await?;
                self.inner.forget(&path, false);
                // keep loaded chunks coherent; unloaded ones are fetched again
                let first = offset / CHUNK;
                let last = (end.max(1) - 1) / CHUNK;
                let all_loaded =
                    (first..=last).all(|i| c.chunks.contains_key(&i) || i * CHUNK >= c.size);
                if all_loaded {
                    self.inner.write_local(&path, &mut c, offset, data).await?;
                } else {
                    for i in first..=last {
                        c.chunks.remove(&i);
                    }
                    if end > c.size {
                        c.set_size(end);
                    }
                }
                c.backend_size = c.backend_size.max(end);
                c.mtime_ms = now_ms();
            } else {
                self.inner.write_local(&path, &mut c, offset, data).await?;
                c.dirty = true;
            }
            self.wrote.fetch_add(data.len() as u64, Ordering::Relaxed);
            Ok(data.len())
        })
    }

    fn stat<'a>(&'a self) -> BoxFuture<'a, VfsResult<Attr>> {
        Box::pin(async move {
            self.check_open("fstat")?;
            let c = self.node.content.lock().await;
            let now = now_ms();
            Ok(Attr {
                mode: kind_mode(EntryKind::File) | c.perm,
                size: c.size,
                nlink: 1,
                uid: self.inner.uid,
                gid: self.inner.gid,
                atime_ms: now,
                mtime_ms: c.mtime_ms,
                ctime_ms: c.mtime_ms,
            })
        })
    }

    fn truncate<'a>(&'a self, size: u64) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            self.check_open("ftruncate")?;
            if !(self.flags.write || self.flags.append) {
                return Err(VfsError::op(errno::EBADF, "ftruncate", ""));
            }
            let path = self.path();
            self.inner.check_size(size, "ftruncate", &path)?;
            let mut c = self.node.content.lock().await;
            if self.inner.cfg.commit == CommitMode::Write && !c.is_new {
                self.inner.call(VfsOp::Truncate { path: path.clone(), size }).await?;
                self.inner.forget(&path, false);
                c.set_size(size);
            } else {
                c.set_size(size);
                c.dirty = true;
            }
            c.mtime_ms = now_ms();
            Ok(())
        })
    }

    fn sync<'a>(&'a self) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            self.check_open("fsync")?;
            let mut c = self.node.content.lock().await;
            self.inner.commit(&self.node, &mut c).await
        })
    }

    fn wants_flush(&self) -> bool {
        // `commit: write` commits with each write; only `commit: close`
        // buffers until flush/release
        (self.flags.write || self.flags.append) && self.inner.cfg.commit == CommitMode::Close
    }

    fn flush<'a>(&'a self) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            if !(self.flags.write || self.flags.append) {
                return Ok(());
            }
            self.sync().await
        })
    }

    fn close<'a>(&'a self) -> BoxFuture<'a, VfsResult<()>> {
        Box::pin(async move {
            {
                let mut closed = self.closed.lock().unwrap();
                if *closed {
                    return Ok(());
                }
                *closed = true;
            }
            let writer = self.flags.write || self.flags.append;
            let result = if writer {
                let mut c = self.node.content.lock().await;
                let r = self.inner.commit(&self.node, &mut c).await;
                if let Err(e) = &r {
                    gondolin_log::warn!(
                        "vfs: object mount {} commit of {} failed: {e}",
                        self.inner.cfg.mount_id,
                        self.node.path.lock().unwrap()
                    );
                }
                r
            } else {
                Ok(())
            };
            self.node.open.fetch_sub(1, Ordering::Relaxed);
            self.inner.evict();
            result
        })
    }
}

#[cfg(test)]
pub(crate) mod tests;

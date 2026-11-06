//! In-daemon memory filesystem (`memory` mounts, the upper layer of `tmpfs`
//! hide rules, and `static` mounts), following the node engine's vendored
//! `MemoryProvider` semantics: symlinks resolve inside the provider, hard
//! links share one node, creating a file creates missing parents.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use crate::error::{VfsError, VfsResult, errno};
use crate::provider::{FileHandle, Handle, Provider};
use crate::types::{
    Attr, DirEntry, EntryKind, OpenFlags, S_IFDIR, S_IFLNK, S_IFREG, now_ms, vpath,
};

const MAX_SYMLINK_DEPTH: u32 = 40;
const ROOT: u64 = 1;

enum Kind {
    File(Vec<u8>),
    Dir(BTreeMap<String, u64>),
    Symlink(String),
}

struct Node {
    kind: Kind,
    /// permission bits
    perm: u32,
    nlink: u32,
    mtime_ms: i64,
    ctime_ms: i64,
    /// open handles keeping an unlinked file alive
    open: u32,
}

impl Node {
    fn new(kind: Kind, perm: u32) -> Node {
        let now = now_ms();
        Node { kind, perm, nlink: 1, mtime_ms: now, ctime_ms: now, open: 0 }
    }
}

struct Inner {
    nodes: HashMap<u64, Node>,
    next_id: u64,
    uid: u32,
    gid: u32,
}

/// Memory filesystem; cheap to share (`Arc` inside).
#[derive(Clone)]
pub struct MemoryProvider {
    inner: Arc<Mutex<Inner>>,
    readonly: bool,
}

impl Default for MemoryProvider {
    fn default() -> Self {
        MemoryProvider::new()
    }
}

fn process_ids() -> (u32, u32) {
    #[cfg(unix)]
    {
        (rustix::process::getuid().as_raw(), rustix::process::getgid().as_raw())
    }
    #[cfg(not(unix))]
    {
        (0, 0)
    }
}

impl MemoryProvider {
    pub fn new() -> MemoryProvider {
        let mut nodes = HashMap::new();
        nodes.insert(ROOT, Node::new(Kind::Dir(BTreeMap::new()), 0o755));
        let (uid, gid) = process_ids();
        MemoryProvider {
            inner: Arc::new(Mutex::new(Inner { nodes, next_id: ROOT + 1, uid, gid })),
            readonly: false,
        }
    }

    /// A read-only provider holding `files` (parents are created).
    pub fn with_files<'a>(
        files: impl IntoIterator<Item = (&'a str, &'a [u8])>,
    ) -> VfsResult<MemoryProvider> {
        let provider = MemoryProvider::new();
        for (path, data) in files {
            provider.write_file_sync(&vpath::normalize(path), data, 0o644)?;
        }
        Ok(provider.into_readonly())
    }

    /// Marks the provider read-only (`setReadOnly`).
    pub fn into_readonly(mut self) -> MemoryProvider {
        self.readonly = true;
        self
    }

    /// Creates or replaces a file, creating parent directories.
    pub fn write_file_sync(&self, path: &str, data: &[u8], perm: u32) -> VfsResult<()> {
        let mut inner = self.inner.lock().unwrap();
        let id = inner.create_file(path, perm, true, "open")?;
        if let Some(node) = inner.nodes.get_mut(&id)
            && let Kind::File(content) = &mut node.kind
        {
            *content = data.to_vec();
            node.mtime_ms = now_ms();
        }
        Ok(())
    }

    /// `stat` without async (following symlinks); panics if missing.
    pub fn stat_sync(&self, path: &str) -> Attr {
        let inner = self.inner.lock().unwrap();
        let id = inner.resolve(path, true, "stat").expect("stat_sync");
        inner.attr(id)
    }

    /// Reads a whole file (following symlinks).
    pub fn read_file_sync(&self, path: &str) -> VfsResult<Vec<u8>> {
        let inner = self.inner.lock().unwrap();
        let id = inner.resolve(path, true, "open")?;
        match &inner.nodes[&id].kind {
            Kind::File(c) => Ok(c.clone()),
            Kind::Dir(_) => Err(VfsError::op(errno::EISDIR, "read", path)),
            Kind::Symlink(_) => Err(VfsError::op(errno::EINVAL, "read", path)),
        }
    }

    fn check_writable(&self, op: &str, path: &str) -> VfsResult<()> {
        if self.readonly { Err(VfsError::op(errno::EROFS, op, path)) } else { Ok(()) }
    }
}

impl Inner {
    fn alloc(&mut self, node: Node) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.nodes.insert(id, node);
        id
    }

    fn children(&self, id: u64) -> Option<&BTreeMap<String, u64>> {
        match &self.nodes.get(&id)?.kind {
            Kind::Dir(c) => Some(c),
            _ => None,
        }
    }

    fn children_mut(&mut self, id: u64) -> Option<&mut BTreeMap<String, u64>> {
        match &mut self.nodes.get_mut(&id)?.kind {
            Kind::Dir(c) => Some(c),
            _ => None,
        }
    }

    /// Resolves a symlink found at `link_path` with `target` to a path.
    fn symlink_target(link_path: &str, target: &str) -> String {
        if target.starts_with('/') {
            vpath::normalize(target)
        } else {
            vpath::normalize(&format!("{}/{}", vpath::parent(link_path), target))
        }
    }

    /// Resolves `path` to a node id and its resolved path.
    fn lookup(&self, path: &str, follow: bool, depth: u32, op: &str) -> VfsResult<(u64, String)> {
        let normalized = vpath::normalize(path);
        let mut current = ROOT;
        let mut current_path = String::from("/");
        let comps: Vec<&str> = vpath::components(&normalized).collect();
        for (i, comp) in comps.iter().enumerate() {
            let children = match self.children(current) {
                Some(c) => c,
                None => {
                    return Err(VfsError::op(errno::ENOTDIR, op, path));
                }
            };
            let child =
                *children.get(*comp).ok_or_else(|| VfsError::op(errno::ENOENT, op, path))?;
            let child_path = vpath::join(&current_path, comp);
            let last = i + 1 == comps.len();
            if let Kind::Symlink(target) = &self.nodes[&child].kind
                && (!last || follow)
            {
                if depth >= MAX_SYMLINK_DEPTH {
                    return Err(VfsError::op(errno::ELOOP, op, path));
                }
                let resolved = Self::symlink_target(&child_path, target);
                let (id, rpath) = self.lookup(&resolved, true, depth + 1, op)?;
                current = id;
                current_path = rpath;
                continue;
            }
            current = child;
            current_path = child_path;
        }
        Ok((current, current_path))
    }

    fn resolve(&self, path: &str, follow: bool, op: &str) -> VfsResult<u64> {
        self.lookup(path, follow, 0, op).map(|(id, _)| id)
    }

    /// Resolves the parent directory of `path` (following symlinks), creating
    /// missing directories when `create`. Returns the dir id and the name.
    fn parent_dir(&mut self, path: &str, create: bool, op: &str) -> VfsResult<(u64, String)> {
        let normalized = vpath::normalize(path);
        if normalized == "/" {
            return Err(VfsError::op(errno::EEXIST, op, path));
        }
        let name = vpath::basename(&normalized).to_string();
        let parent = vpath::parent(&normalized).to_string();
        match self.lookup(&parent, true, 0, op) {
            Ok((id, _)) => {
                if self.children(id).is_none() {
                    return Err(VfsError::op(errno::ENOTDIR, op, path));
                }
                Ok((id, name))
            }
            Err(e) if e.is(errno::ENOENT) && create => {
                let id = self.mkdir_p(&parent, 0o755, op)?;
                Ok((id, name))
            }
            Err(e) => Err(VfsError::op(e.errno, op, path)),
        }
    }

    fn mkdir_p(&mut self, path: &str, perm: u32, op: &str) -> VfsResult<u64> {
        let mut current = ROOT;
        let mut current_path = String::from("/");
        for comp in
            vpath::components(&vpath::normalize(path)).map(str::to_string).collect::<Vec<_>>()
        {
            let child_path = vpath::join(&current_path, &comp);
            let existing = self.children(current).and_then(|c| c.get(&comp).copied());
            current = match existing {
                Some(id) => match &self.nodes[&id].kind {
                    Kind::Dir(_) => id,
                    Kind::Symlink(_) => {
                        let (rid, _) = self.lookup(&child_path, true, 0, op)?;
                        if self.children(rid).is_none() {
                            return Err(VfsError::op(errno::ENOTDIR, op, path));
                        }
                        rid
                    }
                    Kind::File(_) => return Err(VfsError::op(errno::ENOTDIR, op, path)),
                },
                None => {
                    let id = self.alloc(Node::new(Kind::Dir(BTreeMap::new()), perm));
                    self.children_mut(current)
                        .ok_or_else(|| VfsError::op(errno::ENOTDIR, op, path))?
                        .insert(comp.clone(), id);
                    id
                }
            };
            current_path = child_path;
        }
        Ok(current)
    }

    /// Opens or creates the file at `path` and returns its node id.
    fn create_file(&mut self, path: &str, perm: u32, create: bool, op: &str) -> VfsResult<u64> {
        match self.lookup(path, true, 0, op) {
            Ok((id, _)) => match self.nodes[&id].kind {
                Kind::Dir(_) => Err(VfsError::op(errno::EISDIR, op, path)),
                Kind::Symlink(_) => Err(VfsError::op(errno::EINVAL, op, path)),
                Kind::File(_) => Ok(id),
            },
            Err(e) if e.is(errno::ENOENT) && create => {
                // A dangling final symlink creates its target.
                let mut target = vpath::normalize(path);
                for _ in 0..MAX_SYMLINK_DEPTH {
                    let next = match self.lookup(&target, false, 0, op) {
                        Ok((id, rpath)) => match &self.nodes[&id].kind {
                            Kind::Symlink(t) => Self::symlink_target(&rpath, t),
                            _ => break,
                        },
                        Err(_) => break,
                    };
                    target = next;
                }
                let (dir, name) = self.parent_dir(&target, true, op)?;
                let id = self.alloc(Node::new(Kind::File(Vec::new()), perm & 0o7777));
                self.children_mut(dir).unwrap().insert(name, id);
                Ok(id)
            }
            Err(e) => Err(e),
        }
    }

    fn attr(&self, id: u64) -> Attr {
        let node = &self.nodes[&id];
        let (type_bits, size) = match &node.kind {
            Kind::File(c) => (S_IFREG, c.len() as u64),
            Kind::Dir(_) => (S_IFDIR, 4096),
            Kind::Symlink(t) => (S_IFLNK, t.len() as u64),
        };
        Attr {
            mode: type_bits | node.perm,
            size,
            nlink: if matches!(node.kind, Kind::File(_)) { node.nlink.max(1) } else { 1 },
            uid: self.uid,
            gid: self.gid,
            atime_ms: now_ms(),
            mtime_ms: node.mtime_ms,
            ctime_ms: node.ctime_ms,
        }
    }

    /// Drops one directory reference to `id`.
    fn unref(&mut self, id: u64) {
        let remove = match self.nodes.get_mut(&id) {
            Some(node) => {
                node.nlink = node.nlink.saturating_sub(1);
                node.nlink == 0 && node.open == 0
            }
            None => false,
        };
        if remove {
            self.drop_tree(id);
        }
    }

    fn drop_tree(&mut self, id: u64) {
        if let Some(node) = self.nodes.remove(&id)
            && let Kind::Dir(children) = node.kind
        {
            for child in children.into_values() {
                self.unref(child);
            }
        }
    }

    fn is_ancestor(&self, ancestor: u64, mut path: &str) -> bool {
        // path-based check: walk the resolved path's prefixes
        loop {
            if let Ok((id, _)) = self.lookup(path, false, 0, "rename")
                && id == ancestor
            {
                return true;
            }
            if path == "/" {
                return false;
            }
            path = vpath::parent(path);
        }
    }
}

#[async_trait]
impl Provider for MemoryProvider {
    fn readonly(&self) -> bool {
        self.readonly
    }

    async fn lstat(&self, path: &str) -> VfsResult<Attr> {
        let inner = self.inner.lock().unwrap();
        let id = inner.resolve(path, false, "lstat")?;
        Ok(inner.attr(id))
    }

    async fn stat(&self, path: &str) -> VfsResult<Attr> {
        let inner = self.inner.lock().unwrap();
        let id = inner.resolve(path, true, "stat")?;
        Ok(inner.attr(id))
    }

    async fn readdir(&self, path: &str) -> VfsResult<Vec<DirEntry>> {
        let inner = self.inner.lock().unwrap();
        let id = inner.resolve(path, true, "scandir")?;
        let children =
            inner.children(id).ok_or_else(|| VfsError::op(errno::ENOTDIR, "scandir", path))?;
        Ok(children
            .iter()
            .map(|(name, child)| {
                let kind = match inner.nodes[child].kind {
                    Kind::File(_) => EntryKind::File,
                    Kind::Dir(_) => EntryKind::Dir,
                    Kind::Symlink(_) => EntryKind::Symlink,
                };
                DirEntry::new(name.clone(), kind)
            })
            .collect())
    }

    async fn open(&self, path: &str, flags: OpenFlags, mode: u32) -> VfsResult<Handle> {
        if flags.is_write() {
            self.check_writable("open", path)?;
        }
        let mut inner = self.inner.lock().unwrap();
        let id = inner.create_file(path, mode, flags.create, "open")?;
        let node = inner.nodes.get_mut(&id).unwrap();
        if flags.truncate
            && let Kind::File(c) = &mut node.kind
        {
            c.clear();
            node.mtime_ms = now_ms();
        }
        node.open += 1;
        Ok(Arc::new(MemoryHandle {
            inner: self.inner.clone(),
            id,
            append: flags.append,
            writable: flags.write || flags.append,
            closed: Mutex::new(false),
        }))
    }

    async fn mkdir(&self, path: &str, mode: u32, recursive: bool) -> VfsResult<()> {
        self.check_writable("mkdir", path)?;
        let mut inner = self.inner.lock().unwrap();
        if let Ok((id, _)) = inner.lookup(path, true, 0, "mkdir") {
            if recursive && inner.children(id).is_some() {
                return Ok(());
            }
            return Err(VfsError::op(errno::EEXIST, "mkdir", path));
        }
        if inner.lookup(path, false, 0, "mkdir").is_ok() {
            // dangling symlink
            return Err(VfsError::op(errno::EEXIST, "mkdir", path));
        }
        if recursive {
            inner.mkdir_p(path, mode & 0o7777, "mkdir")?;
            return Ok(());
        }
        let (dir, name) = inner.parent_dir(path, false, "mkdir")?;
        let id = inner.alloc(Node::new(Kind::Dir(BTreeMap::new()), mode & 0o7777));
        inner.children_mut(dir).unwrap().insert(name, id);
        Ok(())
    }

    async fn rmdir(&self, path: &str) -> VfsResult<()> {
        self.check_writable("rmdir", path)?;
        let mut inner = self.inner.lock().unwrap();
        let id = inner.resolve(path, false, "rmdir")?;
        match inner.children(id) {
            None => return Err(VfsError::op(errno::ENOTDIR, "rmdir", path)),
            Some(c) if !c.is_empty() => return Err(VfsError::op(errno::ENOTEMPTY, "rmdir", path)),
            Some(_) => {}
        }
        if id == ROOT {
            return Err(VfsError::op(errno::EBUSY, "rmdir", path));
        }
        let (dir, name) = inner.parent_dir(path, false, "rmdir")?;
        inner.children_mut(dir).unwrap().remove(&name);
        inner.unref(id);
        Ok(())
    }

    async fn unlink(&self, path: &str) -> VfsResult<()> {
        self.check_writable("unlink", path)?;
        let mut inner = self.inner.lock().unwrap();
        let id = inner.resolve(path, false, "unlink")?;
        if inner.children(id).is_some() {
            return Err(VfsError::op(errno::EISDIR, "unlink", path));
        }
        let (dir, name) = inner.parent_dir(path, false, "unlink")?;
        inner.children_mut(dir).unwrap().remove(&name);
        inner.unref(id);
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> VfsResult<()> {
        self.check_writable("rename", from)?;
        let mut inner = self.inner.lock().unwrap();
        let id = inner.resolve(from, false, "rename")?;
        let (old_dir, old_name) = inner.parent_dir(from, false, "rename")?;
        let (new_dir, new_name) = inner.parent_dir(to, true, "rename")?;
        let src_is_dir = inner.children(id).is_some();
        if src_is_dir
            && inner.is_ancestor(id, &vpath::normalize(vpath::parent(&vpath::normalize(to))))
        {
            return Err(VfsError::op(errno::EINVAL, "rename", from));
        }
        let replaced = inner.children(new_dir).unwrap().get(&new_name).copied();
        if let Some(rid) = replaced {
            if rid == id {
                return Ok(());
            }
            match (src_is_dir, inner.children(rid)) {
                (false, Some(_)) => return Err(VfsError::op(errno::EISDIR, "rename", to)),
                (true, None) => return Err(VfsError::op(errno::ENOTDIR, "rename", to)),
                (true, Some(c)) if !c.is_empty() => {
                    return Err(VfsError::op(errno::ENOTEMPTY, "rename", to));
                }
                _ => {}
            }
        }
        inner.children_mut(old_dir).unwrap().remove(&old_name);
        inner.children_mut(new_dir).unwrap().insert(new_name, id);
        if let Some(rid) = replaced {
            inner.unref(rid);
        }
        if let Some(node) = inner.nodes.get_mut(&id) {
            node.ctime_ms = now_ms();
        }
        Ok(())
    }

    async fn link(&self, from: &str, to: &str) -> VfsResult<()> {
        self.check_writable("link", to)?;
        let mut inner = self.inner.lock().unwrap();
        let id = inner.resolve(from, true, "link")?;
        if inner.children(id).is_some() {
            return Err(VfsError::op(errno::EISDIR, "link", from));
        }
        if inner.resolve(to, false, "link").is_ok() {
            return Err(VfsError::op(errno::EEXIST, "link", to));
        }
        let (dir, name) = inner.parent_dir(to, true, "link")?;
        inner.children_mut(dir).unwrap().insert(name, id);
        let node = inner.nodes.get_mut(&id).unwrap();
        node.nlink += 1;
        node.ctime_ms = now_ms();
        Ok(())
    }

    async fn symlink(&self, target: &str, path: &str) -> VfsResult<()> {
        self.check_writable("symlink", path)?;
        let mut inner = self.inner.lock().unwrap();
        if inner.resolve(path, false, "symlink").is_ok() {
            return Err(VfsError::op(errno::EEXIST, "symlink", path));
        }
        let (dir, name) = inner.parent_dir(path, true, "symlink")?;
        let id = inner.alloc(Node::new(Kind::Symlink(target.to_string()), 0o777));
        inner.children_mut(dir).unwrap().insert(name, id);
        Ok(())
    }

    async fn readlink(&self, path: &str) -> VfsResult<String> {
        let inner = self.inner.lock().unwrap();
        let id = inner.resolve(path, false, "readlink")?;
        match &inner.nodes[&id].kind {
            Kind::Symlink(t) => Ok(t.clone()),
            _ => Err(VfsError::op(errno::EINVAL, "readlink", path)),
        }
    }

    async fn chmod(&self, path: &str, mode: u32) -> VfsResult<()> {
        self.check_writable("chmod", path)?;
        let mut inner = self.inner.lock().unwrap();
        let id = inner.resolve(path, true, "chmod")?;
        let node = inner.nodes.get_mut(&id).unwrap();
        node.perm = mode & 0o7777;
        node.ctime_ms = now_ms();
        Ok(())
    }

    async fn utimes(
        &self,
        path: &str,
        _atime_ms: Option<Option<i64>>,
        mtime_ms: Option<Option<i64>>,
    ) -> VfsResult<()> {
        self.check_writable("utimes", path)?;
        let mut inner = self.inner.lock().unwrap();
        let id = inner.resolve(path, true, "utimes")?;
        let node = inner.nodes.get_mut(&id).unwrap();
        if let Some(m) = mtime_ms {
            node.mtime_ms = m.unwrap_or_else(now_ms);
        }
        node.ctime_ms = now_ms();
        Ok(())
    }

    async fn truncate(&self, path: &str, size: u64) -> VfsResult<()> {
        self.check_writable("truncate", path)?;
        let mut inner = self.inner.lock().unwrap();
        let id = inner.resolve(path, true, "truncate")?;
        let node = inner.nodes.get_mut(&id).unwrap();
        match &mut node.kind {
            Kind::File(c) => {
                c.resize(size as usize, 0);
                node.mtime_ms = now_ms();
                Ok(())
            }
            Kind::Dir(_) => Err(VfsError::op(errno::EISDIR, "truncate", path)),
            Kind::Symlink(_) => Err(VfsError::op(errno::EINVAL, "truncate", path)),
        }
    }

    async fn access(&self, path: &str, _mask: u32) -> VfsResult<()> {
        // VirtualProvider's default: existence only
        self.stat(path).await.map(|_| ())
    }

    async fn realpath(&self, path: &str) -> VfsResult<String> {
        let inner = self.inner.lock().unwrap();
        inner.lookup(path, true, 0, "realpath").map(|(_, p)| p)
    }
}

struct MemoryHandle {
    inner: Arc<Mutex<Inner>>,
    id: u64,
    append: bool,
    writable: bool,
    closed: Mutex<bool>,
}

impl MemoryHandle {
    fn with_content<T>(&self, op: &str, f: impl FnOnce(&mut Node) -> VfsResult<T>) -> VfsResult<T> {
        if *self.closed.lock().unwrap() {
            return Err(VfsError::op(errno::EBADF, op, ""));
        }
        let mut inner = self.inner.lock().unwrap();
        let node =
            inner.nodes.get_mut(&self.id).ok_or_else(|| VfsError::op(errno::EBADF, op, ""))?;
        f(node)
    }
}

#[async_trait]
impl FileHandle for MemoryHandle {
    async fn read(&self, offset: u64, len: usize) -> VfsResult<Vec<u8>> {
        self.with_content("read", |node| match &node.kind {
            Kind::File(c) => {
                let start = (offset as usize).min(c.len());
                let end = start.saturating_add(len).min(c.len());
                Ok(c[start..end].to_vec())
            }
            _ => Err(VfsError::op(errno::EISDIR, "read", "")),
        })
    }

    async fn write(&self, offset: u64, data: &[u8]) -> VfsResult<usize> {
        if !self.writable {
            return Err(VfsError::op(errno::EBADF, "write", ""));
        }
        let append = self.append;
        self.with_content("write", |node| match &mut node.kind {
            Kind::File(c) => {
                let pos = if append { c.len() } else { offset as usize };
                let end = pos
                    .checked_add(data.len())
                    .ok_or_else(|| VfsError::op(errno::EFBIG, "write", ""))?;
                if end > c.len() {
                    c.resize(end, 0);
                }
                c[pos..end].copy_from_slice(data);
                node.mtime_ms = now_ms();
                Ok(data.len())
            }
            _ => Err(VfsError::op(errno::EISDIR, "write", "")),
        })
    }

    async fn stat(&self) -> VfsResult<Attr> {
        if *self.closed.lock().unwrap() {
            return Err(VfsError::op(errno::EBADF, "fstat", ""));
        }
        let inner = self.inner.lock().unwrap();
        if !inner.nodes.contains_key(&self.id) {
            return Err(VfsError::op(errno::EBADF, "fstat", ""));
        }
        Ok(inner.attr(self.id))
    }

    async fn truncate(&self, size: u64) -> VfsResult<()> {
        self.with_content("ftruncate", |node| match &mut node.kind {
            Kind::File(c) => {
                c.resize(size as usize, 0);
                node.mtime_ms = now_ms();
                Ok(())
            }
            _ => Err(VfsError::op(errno::EISDIR, "ftruncate", "")),
        })
    }

    async fn close(&self) -> VfsResult<()> {
        let mut closed = self.closed.lock().unwrap();
        if *closed {
            return Ok(());
        }
        *closed = true;
        let mut inner = self.inner.lock().unwrap();
        let remove = match inner.nodes.get_mut(&self.id) {
            Some(node) => {
                node.open = node.open.saturating_sub(1);
                node.open == 0 && node.nlink == 0
            }
            None => false,
        };
        if remove {
            inner.nodes.remove(&self.id);
        }
        Ok(())
    }
}

impl Drop for MemoryHandle {
    fn drop(&mut self) {
        if !*self.closed.get_mut().unwrap()
            && let Ok(mut inner) = self.inner.lock()
            && let Some(node) = inner.nodes.get_mut(&self.id)
        {
            node.open = node.open.saturating_sub(1);
            if node.open == 0 && node.nlink == 0 {
                inner.nodes.remove(&self.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    #[test]
    fn files_dirs_links() {
        block(crate::test_timeout(async {
            let p = MemoryProvider::new();
            p.mkdir("/a", 0o755, false).await.unwrap();
            assert!(p.mkdir("/a", 0o755, false).await.unwrap_err().is(errno::EEXIST));
            p.mkdir("/a", 0o755, true).await.unwrap();
            assert!(p.mkdir("/x/y", 0o755, false).await.unwrap_err().is(errno::ENOENT));
            p.mkdir("/x/y", 0o700, true).await.unwrap();
            assert_eq!(p.stat("/x/y").await.unwrap().perm(), 0o700);

            let h = p.open("/a/f", OpenFlags::parse("w+").unwrap(), 0o640).await.unwrap();
            h.write(0, b"hello").await.unwrap();
            assert_eq!(h.read(1, 10).await.unwrap(), b"ello");
            h.close().await.unwrap();
            let st = p.stat("/a/f").await.unwrap();
            assert_eq!(st.size, 5);
            assert_eq!(st.mode, S_IFREG | 0o640);

            p.link("/a/f", "/a/g").await.unwrap();
            assert_eq!(p.stat("/a/f").await.unwrap().nlink, 2);
            p.unlink("/a/f").await.unwrap();
            assert_eq!(p.read_file_sync("/a/g").unwrap(), b"hello");
            assert_eq!(p.stat("/a/g").await.unwrap().nlink, 1);

            p.symlink("g", "/a/l").await.unwrap();
            assert!(p.lstat("/a/l").await.unwrap().is_symlink());
            assert_eq!(p.stat("/a/l").await.unwrap().size, 5);
            assert_eq!(p.readlink("/a/l").await.unwrap(), "g");
            assert_eq!(p.realpath("/a/l").await.unwrap(), "/a/g");
            assert!(p.readlink("/a/g").await.unwrap_err().is(errno::EINVAL));

            assert!(p.rmdir("/a").await.unwrap_err().is(errno::ENOTEMPTY));
            assert!(p.unlink("/a").await.unwrap_err().is(errno::EISDIR));
            p.rename("/a/g", "/x/g").await.unwrap();
            assert!(p.rename("/x", "/x/y/z").await.unwrap_err().is(errno::EINVAL));
            assert!(p.rename("/x/g", "/x/y").await.unwrap_err().is(errno::EISDIR));
            let names: Vec<_> =
                p.readdir("/x").await.unwrap().into_iter().map(|e| e.name).collect();
            assert_eq!(names, vec!["g", "y"]);
        }));
    }

    #[test]
    fn handles_see_truncates_and_unlinked_files_survive() {
        block(crate::test_timeout(async {
            let p = MemoryProvider::new();
            p.write_file_sync("/f", b"0123456789", 0o644).unwrap();
            let h = p.open("/f", OpenFlags::READ_WRITE, 0).await.unwrap();
            p.truncate("/f", 2).await.unwrap();
            h.write(4, b"x").await.unwrap();
            assert_eq!(p.read_file_sync("/f").unwrap(), b"01\0\0x");
            p.unlink("/f").await.unwrap();
            assert_eq!(h.read(0, 2).await.unwrap(), b"01");
            h.close().await.unwrap();
            assert!(p.inner.lock().unwrap().nodes.len() == 1);

            let a = p.open("/log", OpenFlags::parse("a").unwrap(), 0o644).await.unwrap();
            a.write(0, b"ab").await.unwrap();
            a.write(0, b"cd").await.unwrap();
            assert_eq!(p.read_file_sync("/log").unwrap(), b"abcd");
        }));
    }

    #[test]
    fn readonly_and_creates_parents() {
        block(crate::test_timeout(async {
            let p = MemoryProvider::new();
            let h = p.open("/deep/er/f", OpenFlags::parse("w").unwrap(), 0o644).await.unwrap();
            h.close().await.unwrap();
            assert!(p.stat("/deep/er").await.unwrap().is_dir());
            let ro = MemoryProvider::with_files([("/ca.crt", &b"pem"[..])]).unwrap();
            assert!(
                ro.open("/ca.crt", OpenFlags::READ_WRITE, 0).await.err().unwrap().is(errno::EROFS)
            );
            assert!(ro.mkdir("/x", 0o755, false).await.unwrap_err().is(errno::EROFS));
            let h = ro.open("/ca.crt", OpenFlags::READ, 0).await.unwrap();
            assert_eq!(h.read(0, 100).await.unwrap(), b"pem");
        }));
    }

    #[test]
    fn symlink_loops() {
        block(crate::test_timeout(async {
            let p = MemoryProvider::new();
            p.symlink("b", "/a").await.unwrap();
            p.symlink("a", "/b").await.unwrap();
            assert!(p.stat("/a").await.unwrap_err().is(errno::ELOOP));
            assert!(p.lstat("/a").await.is_ok());
        }));
    }
}

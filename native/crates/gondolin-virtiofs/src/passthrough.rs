//! Prototype passthrough filesystem over a host directory (path-based
//! inodes). Stands in for `gondolin-vfs`; not hardened (no `openat2`-style
//! containment, symlinks are followed by the host for non-final components).

use std::collections::HashMap;
use std::ffi::{CString, OsStr};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::fuse::{Attr, DirEntry, Entry, FileSystem, Result, SetAttr, StatFs, errno};

/// Host errno → Linux errno.
pub fn linux_errno(err: &io::Error) -> i32 {
    let Some(e) = err.raw_os_error() else { return errno::EIO };
    if cfg!(target_os = "linux") {
        return e;
    }
    match e {
        libc::EDEADLK => 35,
        libc::EAGAIN => 11,
        libc::ELOOP => 40,
        libc::ENAMETOOLONG => 36,
        libc::ENOTEMPTY => 39,
        libc::ENOSYS => 38,
        libc::ENOTSUP => 95,
        libc::EDQUOT => 122,
        libc::ENOLCK => 37,
        libc::EOVERFLOW => 75,
        #[cfg(target_os = "macos")]
        libc::ENOATTR => 61,
        e if e <= 34 => e,
        _ => errno::EIO,
    }
}

fn err(e: io::Error) -> i32 {
    linux_errno(&e)
}

struct Node {
    path: PathBuf,
    nlookup: u64,
    key: (u64, u64),
}

#[derive(Default)]
struct Inner {
    nodes: HashMap<u64, Node>,
    by_key: HashMap<(u64, u64), u64>,
    next_node: u64,
    files: HashMap<u64, std::sync::Arc<File>>,
    dirs: HashMap<u64, Vec<DirEntry>>,
    next_fh: u64,
}

/// Passthrough of a host directory.
pub struct Passthrough {
    inner: Mutex<Inner>,
    /// see [`crate::fuse::FuseServer::writeback`]
    pub writeback: bool,
}

fn attr_of(meta: &fs::Metadata) -> Attr {
    Attr {
        ino: meta.ino(),
        size: meta.size(),
        blocks: meta.blocks(),
        atime: (meta.atime(), meta.atime_nsec() as u32),
        mtime: (meta.mtime(), meta.mtime_nsec() as u32),
        ctime: (meta.ctime(), meta.ctime_nsec() as u32),
        mode: meta.mode(),
        nlink: meta.nlink() as u32,
        // The guest sees everything as owned by root.
        uid: 0,
        gid: 0,
        rdev: 0,
        blksize: meta.blksize() as u32,
    }
}

fn check_name(name: &OsStr) -> Result<()> {
    let b = name.as_bytes();
    if b.is_empty() || b == b"." || b == b".." || b.contains(&b'/') {
        return Err(errno::EINVAL);
    }
    Ok(())
}

/// Linux open flags → host `OpenOptions`. With the guest's writeback cache
/// the kernel may read through write-only handles and handles appends itself.
fn open_options(flags: u32, writeback: bool) -> OpenOptions {
    let mut o = OpenOptions::new();
    match flags & 3 {
        0 => o.read(true),
        1 if !writeback => o.write(true),
        _ => o.read(true).write(true),
    };
    if flags & 0o2000 != 0 && !writeback {
        o.append(true);
    }
    if flags & 0o1000 != 0 {
        o.truncate(true);
    }
    o
}

impl Passthrough {
    pub fn new(root: impl Into<PathBuf>) -> io::Result<Passthrough> {
        let root = root.into();
        let meta = fs::metadata(&root)?;
        let mut inner = Inner { next_node: 2, next_fh: 1, ..Default::default() };
        let key = (meta.dev(), meta.ino());
        inner.nodes.insert(1, Node { path: root, nlookup: 1, key });
        inner.by_key.insert(key, 1);
        Ok(Passthrough { inner: Mutex::new(inner), writeback: false })
    }

    fn path(&self, node: u64) -> Result<PathBuf> {
        self.inner.lock().unwrap().nodes.get(&node).map(|n| n.path.clone()).ok_or(errno::ENOENT)
    }

    fn child(&self, parent: u64, name: &OsStr) -> Result<PathBuf> {
        check_name(name)?;
        Ok(self.path(parent)?.join(name))
    }

    /// Registers a looked-up path (one more kernel reference).
    fn remember(&self, path: PathBuf, meta: &fs::Metadata) -> Entry {
        let key = (meta.dev(), meta.ino());
        let mut inner = self.inner.lock().unwrap();
        let nodeid = match inner.by_key.get(&key) {
            Some(&id) => id,
            None => {
                let id = inner.next_node;
                inner.next_node += 1;
                inner.by_key.insert(key, id);
                inner.nodes.insert(id, Node { path: path.clone(), nlookup: 0, key });
                id
            }
        };
        let node = inner.nodes.get_mut(&nodeid).expect("node");
        node.nlookup += 1;
        node.path = path;
        Entry { nodeid, attr: attr_of(meta) }
    }

    fn entry(&self, path: PathBuf) -> Result<Entry> {
        let meta = fs::symlink_metadata(&path).map_err(err)?;
        Ok(self.remember(path, &meta))
    }

    fn file(&self, fh: u64) -> Result<std::sync::Arc<File>> {
        self.inner.lock().unwrap().files.get(&fh).cloned().ok_or(errno::EBADF)
    }

    fn add_file(&self, file: File) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        let fh = inner.next_fh;
        inner.next_fh += 1;
        inner.files.insert(fh, std::sync::Arc::new(file));
        fh
    }

    /// Keeps node paths valid after a rename of `from` to `to`.
    fn renamed(&self, from: &Path, to: &Path) {
        let mut inner = self.inner.lock().unwrap();
        for node in inner.nodes.values_mut() {
            if let Ok(rest) = node.path.strip_prefix(from) {
                node.path =
                    if rest.as_os_str().is_empty() { to.to_path_buf() } else { to.join(rest) };
            }
        }
    }
}

fn cpath(path: &Path) -> Result<CString> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| errno::EINVAL)
}

fn set_times(path: &Path, set: &SetAttr) -> Result<()> {
    let ts = |t: &Option<Option<(i64, u32)>>| match t {
        None => libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_OMIT },
        Some(None) => libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_NOW },
        Some(Some((s, ns))) => libc::timespec { tv_sec: *s as _, tv_nsec: *ns as _ },
    };
    let times = [ts(&set.atime), ts(&set.mtime)];
    let c = cpath(path)?;
    let rc = unsafe {
        libc::utimensat(libc::AT_FDCWD, c.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW)
    };
    if rc != 0 {
        return Err(linux_errno(&io::Error::last_os_error()));
    }
    Ok(())
}

impl FileSystem for Passthrough {
    fn lookup(&self, parent: u64, name: &OsStr) -> Result<Entry> {
        self.entry(self.child(parent, name)?)
    }

    fn forget(&self, node: u64, nlookup: u64) {
        if node == 1 {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        let remove = match inner.nodes.get_mut(&node) {
            Some(n) => {
                n.nlookup = n.nlookup.saturating_sub(nlookup);
                (n.nlookup == 0).then_some(n.key)
            }
            None => None,
        };
        if let Some(key) = remove {
            inner.nodes.remove(&node);
            inner.by_key.remove(&key);
        }
    }

    fn getattr(&self, node: u64) -> Result<Attr> {
        Ok(attr_of(&fs::symlink_metadata(self.path(node)?).map_err(err)?))
    }

    fn setattr(&self, node: u64, fh: Option<u64>, set: &SetAttr) -> Result<Attr> {
        let path = self.path(node)?;
        if let Some(mode) = set.mode {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode & 0o7777)).map_err(err)?;
        }
        if let Some(size) = set.size {
            match fh.and_then(|fh| self.file(fh).ok()) {
                Some(f) => f.set_len(size).map_err(err)?,
                None => OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .and_then(|f| f.set_len(size))
                    .map_err(err)?,
            }
        }
        if set.atime.is_some() || set.mtime.is_some() {
            set_times(&path, set)?;
        }
        self.getattr(node)
    }

    fn readlink(&self, node: u64) -> Result<Vec<u8>> {
        Ok(fs::read_link(self.path(node)?).map_err(err)?.into_os_string().into_vec())
    }

    fn symlink(&self, parent: u64, name: &OsStr, target: &OsStr) -> Result<Entry> {
        let path = self.child(parent, name)?;
        std::os::unix::fs::symlink(target, &path).map_err(err)?;
        self.entry(path)
    }

    fn mkdir(&self, parent: u64, name: &OsStr, mode: u32) -> Result<Entry> {
        let path = self.child(parent, name)?;
        fs::DirBuilder::new().mode(mode & 0o7777).create(&path).map_err(err)?;
        self.entry(path)
    }

    fn unlink(&self, parent: u64, name: &OsStr) -> Result<()> {
        fs::remove_file(self.child(parent, name)?).map_err(err)
    }

    fn rmdir(&self, parent: u64, name: &OsStr) -> Result<()> {
        fs::remove_dir(self.child(parent, name)?).map_err(err)
    }

    fn rename(
        &self,
        parent: u64,
        name: &OsStr,
        newparent: u64,
        newname: &OsStr,
        flags: u32,
    ) -> Result<()> {
        if flags != 0 {
            return Err(errno::EINVAL);
        }
        let from = self.child(parent, name)?;
        let to = self.child(newparent, newname)?;
        fs::rename(&from, &to).map_err(err)?;
        self.renamed(&from, &to);
        Ok(())
    }

    fn link(&self, node: u64, newparent: u64, newname: &OsStr) -> Result<Entry> {
        let to = self.child(newparent, newname)?;
        fs::hard_link(self.path(node)?, &to).map_err(err)?;
        self.entry(to)
    }

    fn open(&self, node: u64, flags: u32) -> Result<u64> {
        let file = open_options(flags, self.writeback).open(self.path(node)?).map_err(err)?;
        Ok(self.add_file(file))
    }

    fn create(&self, parent: u64, name: &OsStr, mode: u32, flags: u32) -> Result<(Entry, u64)> {
        let path = self.child(parent, name)?;
        let mut o = open_options(flags, self.writeback);
        o.create(true).mode(mode & 0o7777);
        if flags & 0o200 != 0 {
            o.create_new(true);
        }
        if flags & 3 == 0 {
            o.write(true); // create needs write access on the host side
        }
        let file = o.open(&path).map_err(err)?;
        let entry = self.entry(path)?;
        Ok((entry, self.add_file(file)))
    }

    fn read(&self, _node: u64, fh: u64, offset: u64, buf: &mut [u8]) -> Result<usize> {
        let f = self.file(fh)?;
        let mut done = 0;
        while done < buf.len() {
            match f.read_at(&mut buf[done..], offset + done as u64) {
                Ok(0) => break,
                Ok(n) => done += n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(err(e)),
            }
        }
        Ok(done)
    }

    fn write(&self, _node: u64, fh: u64, offset: u64, data: &[u8]) -> Result<usize> {
        let f = self.file(fh)?;
        f.write_all_at(data, offset).map_err(err)?;
        Ok(data.len())
    }

    fn fsync(&self, _node: u64, fh: u64, datasync: bool) -> Result<()> {
        let f = self.file(fh)?;
        if datasync { f.sync_data() } else { f.sync_all() }.map_err(err)
    }

    fn release(&self, _node: u64, fh: u64) {
        self.inner.lock().unwrap().files.remove(&fh);
    }

    fn opendir(&self, node: u64) -> Result<u64> {
        let path = self.path(node)?;
        let mut entries = vec![
            DirEntry { ino: 1, offset: 1, kind: libc::DT_DIR as u32, name: b".".to_vec() },
            DirEntry { ino: 1, offset: 2, kind: libc::DT_DIR as u32, name: b"..".to_vec() },
        ];
        for e in fs::read_dir(&path).map_err(err)? {
            let e = e.map_err(err)?;
            let kind = match e.file_type() {
                Ok(t) if t.is_dir() => libc::DT_DIR,
                Ok(t) if t.is_symlink() => libc::DT_LNK,
                Ok(t) if t.is_file() => libc::DT_REG,
                _ => libc::DT_UNKNOWN,
            } as u32;
            let offset = entries.len() as u64 + 1;
            entries.push(DirEntry {
                ino: std::os::unix::fs::DirEntryExt::ino(&e),
                offset,
                kind,
                name: e.file_name().as_bytes().to_vec(),
            });
        }
        let mut inner = self.inner.lock().unwrap();
        let fh = inner.next_fh;
        inner.next_fh += 1;
        inner.dirs.insert(fh, entries);
        Ok(fh)
    }

    fn readdir(&self, _node: u64, fh: u64, offset: u64) -> Result<Vec<DirEntry>> {
        let inner = self.inner.lock().unwrap();
        let entries = inner.dirs.get(&fh).ok_or(errno::EBADF)?;
        Ok(entries.iter().skip(offset as usize).cloned().collect())
    }

    fn releasedir(&self, _node: u64, fh: u64) {
        self.inner.lock().unwrap().dirs.remove(&fh);
    }

    fn statfs(&self, node: u64) -> Result<StatFs> {
        let c = cpath(&self.path(node)?)?;
        let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
            return Err(linux_errno(&io::Error::last_os_error()));
        }
        Ok(StatFs {
            blocks: s.f_blocks as u64,
            bfree: s.f_bfree as u64,
            bavail: s.f_bavail as u64,
            files: s.f_files as u64,
            ffree: s.f_ffree as u64,
            bsize: s.f_bsize as u32,
            namelen: 255,
            frsize: s.f_frsize as u32,
        })
    }
}

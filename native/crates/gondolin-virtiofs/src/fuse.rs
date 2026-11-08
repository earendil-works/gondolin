//! FUSE (Linux ABI, protocol 7.31) request dispatch over virtio-fs queues to
//! a [`FileSystem`]. The guest is always Linux, so the wire format and errno
//! values are Linux's whatever the host OS is.

use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;

use crate::virtq::Writer;

/// Linux errno.
pub type Errno = i32;
pub type Result<T> = std::result::Result<T, Errno>;

pub mod errno {
    pub const EPERM: i32 = 1;
    pub const ENOENT: i32 = 2;
    pub const EIO: i32 = 5;
    pub const EBADF: i32 = 9;
    pub const EACCES: i32 = 13;
    pub const EEXIST: i32 = 17;
    pub const ENOTDIR: i32 = 20;
    pub const EISDIR: i32 = 21;
    pub const EINVAL: i32 = 22;
    pub const ERANGE: i32 = 34;
    pub const ENOSYS: i32 = 38;
    pub const ENOTEMPTY: i32 = 39;
    pub const ENOTTY: i32 = 25;
    pub const EOPNOTSUPP: i32 = 95;
    pub const ENODATA: i32 = 61;
}

/// File attributes (`fuse_attr`).
#[derive(Debug, Clone, Default)]
pub struct Attr {
    pub ino: u64,
    pub size: u64,
    pub blocks: u64,
    pub atime: (i64, u32),
    pub mtime: (i64, u32),
    pub ctime: (i64, u32),
    pub mode: u32,
    pub nlink: u32,
    pub uid: u32,
    pub gid: u32,
    pub rdev: u32,
    pub blksize: u32,
}

/// Result of a lookup/create.
#[derive(Debug, Clone)]
pub struct Entry {
    pub nodeid: u64,
    pub attr: Attr,
}

/// A directory entry; `offset` is the cookie of the *next* entry.
#[derive(Debug, Clone)]
pub struct DirEntry {
    pub ino: u64,
    pub offset: u64,
    pub kind: u32,
    pub name: Vec<u8>,
}

/// Attribute changes of a SETATTR.
#[derive(Debug, Clone, Default)]
pub struct SetAttr {
    pub mode: Option<u32>,
    pub size: Option<u64>,
    /// `None`: unchanged; `Some(None)`: now
    pub atime: Option<Option<(i64, u32)>>,
    pub mtime: Option<Option<(i64, u32)>>,
}

#[derive(Debug, Clone, Default)]
pub struct StatFs {
    pub blocks: u64,
    pub bfree: u64,
    pub bavail: u64,
    pub files: u64,
    pub ffree: u64,
    pub bsize: u32,
    pub namelen: u32,
    pub frsize: u32,
}

/// Inode-level filesystem served to the guest (implemented by `gondolin-vfs`
/// over its mount table, `gondolin-vfs/src/virtiofs.rs`). Node 1 is the root.
pub trait FileSystem: Send + Sync + 'static {
    fn lookup(&self, parent: u64, name: &OsStr) -> Result<Entry>;
    fn forget(&self, node: u64, nlookup: u64);
    fn getattr(&self, node: u64) -> Result<Attr>;
    fn setattr(&self, node: u64, fh: Option<u64>, set: &SetAttr) -> Result<Attr>;
    fn readlink(&self, node: u64) -> Result<Vec<u8>>;
    fn symlink(&self, parent: u64, name: &OsStr, target: &OsStr) -> Result<Entry>;
    fn mkdir(&self, parent: u64, name: &OsStr, mode: u32) -> Result<Entry>;
    fn unlink(&self, parent: u64, name: &OsStr) -> Result<()>;
    fn rmdir(&self, parent: u64, name: &OsStr) -> Result<()>;
    fn rename(
        &self,
        parent: u64,
        name: &OsStr,
        newparent: u64,
        newname: &OsStr,
        flags: u32,
    ) -> Result<()>;
    fn link(&self, node: u64, newparent: u64, newname: &OsStr) -> Result<Entry>;
    /// `flags`: Linux open flags
    fn open(&self, node: u64, flags: u32) -> Result<u64>;
    fn create(&self, parent: u64, name: &OsStr, mode: u32, flags: u32) -> Result<(Entry, u64)>;
    /// Reads into `buf`, returning the byte count.
    fn read(&self, node: u64, fh: u64, offset: u64, buf: &mut [u8]) -> Result<usize>;
    /// Reads straight into scattered (guest) buffers, returning the byte
    /// count; the default reads into a temporary buffer and copies.
    fn read_vectored(
        &self,
        node: u64,
        fh: u64,
        offset: u64,
        bufs: &mut [&mut [u8]],
    ) -> Result<usize> {
        let total = bufs.iter().map(|b| b.len()).sum();
        let mut tmp = vec![0u8; total];
        let n = self.read(node, fh, offset, &mut tmp)?;
        let mut done = 0;
        for b in bufs.iter_mut() {
            if done >= n {
                break;
            }
            let k = b.len().min(n - done);
            b[..k].copy_from_slice(&tmp[done..done + k]);
            done += k;
        }
        Ok(n)
    }
    fn write(&self, node: u64, fh: u64, offset: u64, data: &[u8]) -> Result<usize>;
    fn flush(&self, _node: u64, _fh: u64) -> Result<()> {
        Ok(())
    }
    fn fsync(&self, node: u64, fh: u64, datasync: bool) -> Result<()>;
    fn release(&self, node: u64, fh: u64);
    fn opendir(&self, node: u64) -> Result<u64>;
    /// Entries after cookie `offset` (0: from the start).
    fn readdir(&self, node: u64, fh: u64, offset: u64) -> Result<Vec<DirEntry>>;
    fn releasedir(&self, node: u64, fh: u64);
    fn statfs(&self, node: u64) -> Result<StatFs>;
}

mod op {
    pub const LOOKUP: u32 = 1;
    pub const FORGET: u32 = 2;
    pub const GETATTR: u32 = 3;
    pub const SETATTR: u32 = 4;
    pub const READLINK: u32 = 5;
    pub const SYMLINK: u32 = 6;
    pub const MKNOD: u32 = 8;
    pub const MKDIR: u32 = 9;
    pub const UNLINK: u32 = 10;
    pub const RMDIR: u32 = 11;
    pub const RENAME: u32 = 12;
    pub const LINK: u32 = 13;
    pub const OPEN: u32 = 14;
    pub const READ: u32 = 15;
    pub const WRITE: u32 = 16;
    pub const STATFS: u32 = 17;
    pub const RELEASE: u32 = 18;
    pub const FSYNC: u32 = 20;
    pub const SETXATTR: u32 = 21;
    pub const GETXATTR: u32 = 22;
    pub const LISTXATTR: u32 = 23;
    pub const REMOVEXATTR: u32 = 24;
    pub const FLUSH: u32 = 25;
    pub const INIT: u32 = 26;
    pub const OPENDIR: u32 = 27;
    pub const READDIR: u32 = 28;
    pub const RELEASEDIR: u32 = 29;
    pub const FSYNCDIR: u32 = 30;
    pub const ACCESS: u32 = 34;
    pub const CREATE: u32 = 35;
    pub const INTERRUPT: u32 = 36;
    pub const DESTROY: u32 = 38;
    pub const IOCTL: u32 = 39;
    pub const BATCH_FORGET: u32 = 42;
    pub const READDIRPLUS: u32 = 44;
    pub const RENAME2: u32 = 45;
}

const FUSE_ASYNC_READ: u32 = 1 << 0;
const FUSE_BIG_WRITES: u32 = 1 << 5;
const FUSE_DO_READDIRPLUS: u32 = 1 << 13;
const FUSE_READDIRPLUS_AUTO: u32 = 1 << 14;
const FUSE_PARALLEL_DIROPS: u32 = 1 << 18;
const FUSE_WRITEBACK_CACHE: u32 = 1 << 16;
const FUSE_MAX_PAGES: u32 = 1 << 22;

const OUT_HEADER: usize = 16;
const IN_HEADER: usize = 40;

/// Cache timeouts for entries and attributes.
#[derive(Debug, Clone, Copy)]
pub struct CachePolicy {
    pub entry_secs: u64,
    pub attr_secs: u64,
}

/// Reply payload of a request.
enum Payload {
    Bytes(Vec<u8>),
    /// `n` bytes already placed after the header (zero-copy reads)
    Direct(usize),
}

/// FUSE dispatcher; implements [`crate::vhost_user::QueueHandler`].
pub struct FuseServer<F: FileSystem> {
    fs: F,
    cache: CachePolicy,
    max_pages: u16,
    /// cache negative lookups for the entry timeout
    pub negative_cache: bool,
    /// guest page cache buffers writes (`FUSE_WRITEBACK_CACHE`); the
    /// filesystem must allow reads on write-only handles and ignore O_APPEND
    pub writeback: bool,
    /// forward FLUSH (every `close()`) to [`FileSystem::flush`] so its error
    /// reaches the guest; otherwise answer ENOSYS once and never see it again
    pub flush: bool,
    /// requests and time spent per opcode (diagnostics)
    stats: Vec<(std::sync::atomic::AtomicU64, std::sync::atomic::AtomicU64)>,
}

struct Rd<'a>(&'a [u8]);

impl<'a> Rd<'a> {
    fn u32(&self, off: usize) -> u32 {
        self.0.get(off..off + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).unwrap_or(0)
    }
    fn u64(&self, off: usize) -> u64 {
        self.0.get(off..off + 8).map(|b| u64::from_le_bytes(b.try_into().unwrap())).unwrap_or(0)
    }
    /// NUL-terminated name at `off`, and the offset after it.
    fn cstr(&self, off: usize) -> Option<(&'a OsStr, usize)> {
        let rest = self.0.get(off..)?;
        let end = rest.iter().position(|&b| b == 0)?;
        Some((OsStr::from_bytes(&rest[..end]), off + end + 1))
    }
}

fn put_attr(out: &mut Vec<u8>, a: &Attr) {
    for v in [a.ino, a.size, a.blocks, a.atime.0 as u64, a.mtime.0 as u64, a.ctime.0 as u64] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in [a.atime.1, a.mtime.1, a.ctime.1, a.mode, a.nlink, a.uid, a.gid, a.rdev, a.blksize, 0]
    {
        out.extend_from_slice(&v.to_le_bytes());
    }
}

impl<F: FileSystem> FuseServer<F> {
    pub fn new(fs: F, cache: CachePolicy) -> Self {
        FuseServer {
            fs,
            cache,
            max_pages: 256,
            negative_cache: false,
            writeback: false,
            flush: false,
            stats: (0..64).map(|_| Default::default()).collect(),
        }
    }

    /// `(opcode, count, total µs)` for every opcode seen.
    pub fn stats(&self) -> Vec<(u32, u64, u64)> {
        use std::sync::atomic::Ordering::Relaxed;
        self.stats
            .iter()
            .enumerate()
            .filter(|(_, s)| s.0.load(Relaxed) > 0)
            .map(|(op, s)| (op as u32, s.0.load(Relaxed), s.1.load(Relaxed)))
            .collect()
    }

    pub fn fs(&self) -> &F {
        &self.fs
    }

    fn entry_out(&self, out: &mut Vec<u8>, e: &Entry) {
        for v in [e.nodeid, 0, self.cache.entry_secs, self.cache.attr_secs] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&[0u8; 8]);
        put_attr(out, &e.attr);
    }

    fn attr_out(&self, out: &mut Vec<u8>, a: &Attr) {
        out.extend_from_slice(&self.cache.attr_secs.to_le_bytes());
        out.extend_from_slice(&[0u8; 8]);
        put_attr(out, a);
    }

    fn open_out(out: &mut Vec<u8>, fh: u64) {
        out.extend_from_slice(&fh.to_le_bytes());
        out.extend_from_slice(&[0u8; 8]);
    }

    /// Handles one request; `None` for requests without a reply (FORGET).
    fn dispatch(
        &self,
        opcode: u32,
        nodeid: u64,
        body: Rd<'_>,
        reply: &mut Writer<'_>,
        unique: u64,
    ) -> Option<Result<Payload>> {
        let fs = &self.fs;
        let mut out = Vec::new();
        let mut direct: Option<usize> = None;
        let r: Result<()> = (|| {
            match opcode {
                op::INIT => {
                    let (major, minor, readahead, flags) =
                        (body.u32(0), body.u32(4), body.u32(8), body.u32(12));
                    if major < 7 {
                        return Err(errno::EINVAL);
                    }
                    let want = FUSE_ASYNC_READ
                        | FUSE_BIG_WRITES
                        | FUSE_DO_READDIRPLUS
                        | FUSE_READDIRPLUS_AUTO
                        | FUSE_PARALLEL_DIROPS
                        | FUSE_MAX_PAGES
                        | if self.writeback { FUSE_WRITEBACK_CACHE } else { 0 };
                    out.extend_from_slice(&7u32.to_le_bytes());
                    out.extend_from_slice(&minor.min(31).to_le_bytes());
                    out.extend_from_slice(&readahead.to_le_bytes());
                    out.extend_from_slice(&(flags & want).to_le_bytes());
                    out.extend_from_slice(&16u16.to_le_bytes()); // max_background
                    out.extend_from_slice(&12u16.to_le_bytes()); // congestion_threshold
                    out.extend_from_slice(&(self.max_pages as u32 * 4096).to_le_bytes()); // max_write
                    out.extend_from_slice(&1u32.to_le_bytes()); // time_gran
                    out.extend_from_slice(&self.max_pages.to_le_bytes());
                    out.extend_from_slice(&0u16.to_le_bytes()); // map_alignment
                    out.extend_from_slice(&[0u8; 32]); // flags2, max_stack_depth, unused
                }
                op::DESTROY => {}
                op::LOOKUP => {
                    let (name, _) = body.cstr(0).ok_or(errno::EINVAL)?;
                    match fs.lookup(nodeid, name) {
                        Ok(e) => self.entry_out(&mut out, &e),
                        // Negative entry (nodeid 0): the kernel caches the miss.
                        Err(errno::ENOENT) if self.negative_cache => {
                            self.entry_out(&mut out, &Entry { nodeid: 0, attr: Attr::default() })
                        }
                        Err(e) => return Err(e),
                    }
                }
                op::GETATTR => {
                    let a = fs.getattr(nodeid)?;
                    self.attr_out(&mut out, &a);
                }
                op::SETATTR => {
                    let valid = body.u32(0);
                    let fh = (valid & (1 << 6) != 0).then(|| body.u64(8));
                    let time = |secs: usize, nsec: usize, set: u32, now: u32| {
                        if valid & now != 0 {
                            Some(None)
                        } else if valid & set != 0 {
                            Some(Some((body.u64(secs) as i64, body.u32(nsec))))
                        } else {
                            None
                        }
                    };
                    let set = SetAttr {
                        mode: (valid & 1 != 0).then(|| body.u32(68)),
                        size: (valid & 8 != 0).then(|| body.u64(16)),
                        atime: time(32, 56, 1 << 4, 1 << 7),
                        mtime: time(40, 60, 1 << 5, 1 << 8),
                    };
                    let a = fs.setattr(nodeid, fh, &set)?;
                    self.attr_out(&mut out, &a);
                }
                op::READLINK => out = fs.readlink(nodeid)?,
                op::SYMLINK => {
                    let (name, next) = body.cstr(0).ok_or(errno::EINVAL)?;
                    let (target, _) = body.cstr(next).ok_or(errno::EINVAL)?;
                    let e = fs.symlink(nodeid, name, target)?;
                    self.entry_out(&mut out, &e);
                }
                // Same answers as the guest's sandboxfs today.
                op::MKNOD | op::SETXATTR | op::GETXATTR | op::LISTXATTR | op::REMOVEXATTR => {
                    return Err(errno::EOPNOTSUPP);
                }
                op::IOCTL => return Err(errno::ENOTTY),
                op::MKDIR => {
                    let (name, _) = body.cstr(8).ok_or(errno::EINVAL)?;
                    let mode = body.u32(0) & !body.u32(4);
                    let e = fs.mkdir(nodeid, name, mode)?;
                    self.entry_out(&mut out, &e);
                }
                op::UNLINK => fs.unlink(nodeid, body.cstr(0).ok_or(errno::EINVAL)?.0)?,
                op::RMDIR => fs.rmdir(nodeid, body.cstr(0).ok_or(errno::EINVAL)?.0)?,
                op::RENAME | op::RENAME2 => {
                    let (start, flags) =
                        if opcode == op::RENAME { (8, 0) } else { (16, body.u32(8)) };
                    let newdir = body.u64(0);
                    let (old, next) = body.cstr(start).ok_or(errno::EINVAL)?;
                    let (new, _) = body.cstr(next).ok_or(errno::EINVAL)?;
                    fs.rename(nodeid, old, newdir, new, flags)?;
                }
                op::LINK => {
                    let (name, _) = body.cstr(8).ok_or(errno::EINVAL)?;
                    let e = fs.link(body.u64(0), nodeid, name)?;
                    self.entry_out(&mut out, &e);
                }
                op::OPEN => {
                    let fh = fs.open(nodeid, body.u32(0))?;
                    Self::open_out(&mut out, fh);
                }
                op::CREATE => {
                    let (name, _) = body.cstr(16).ok_or(errno::EINVAL)?;
                    let mode = body.u32(4) & !body.u32(8);
                    let (e, fh) = fs.create(nodeid, name, mode, body.u32(0))?;
                    self.entry_out(&mut out, &e);
                    Self::open_out(&mut out, fh);
                }
                op::READ => {
                    let (fh, offset, size) = (body.u64(0), body.u64(8), body.u32(16) as usize);
                    // Zero copy: read straight into the guest's buffers after
                    // the header, which is written once the length is known.
                    let size = size.min(reply.capacity().saturating_sub(OUT_HEADER));
                    let mut bufs = reply.reserve(OUT_HEADER, size);
                    direct = Some(fs.read_vectored(nodeid, fh, offset, &mut bufs)?);
                }
                op::WRITE => {
                    let (fh, offset, size) = (body.u64(0), body.u64(8), body.u32(16) as usize);
                    let data = body.0.get(40..40 + size).ok_or(errno::EINVAL)?;
                    let n = fs.write(nodeid, fh, offset, data)?;
                    out.extend_from_slice(&(n as u32).to_le_bytes());
                    out.extend_from_slice(&[0u8; 4]);
                }
                op::STATFS => {
                    let s = fs.statfs(nodeid)?;
                    for v in [s.blocks, s.bfree, s.bavail, s.files, s.ffree] {
                        out.extend_from_slice(&v.to_le_bytes());
                    }
                    for v in [s.bsize, s.namelen, s.frsize, 0] {
                        out.extend_from_slice(&v.to_le_bytes());
                    }
                    out.extend_from_slice(&[0u8; 24]);
                }
                op::RELEASE => fs.release(nodeid, body.u64(0)),
                // ENOSYS makes the kernel stop sending FLUSH (one round trip per close).
                op::FLUSH if !self.flush => return Err(errno::ENOSYS),
                op::FLUSH => fs.flush(nodeid, body.u64(0))?,
                op::FSYNC => fs.fsync(nodeid, body.u64(0), body.u32(8) & 1 != 0)?,
                op::FSYNCDIR => {}
                op::OPENDIR => {
                    let fh = fs.opendir(nodeid)?;
                    Self::open_out(&mut out, fh);
                }
                op::RELEASEDIR => fs.releasedir(nodeid, body.u64(0)),
                op::READDIR | op::READDIRPLUS => {
                    let (fh, offset, size) = (body.u64(0), body.u64(8), body.u32(16) as usize);
                    let size = size.min(reply.capacity().saturating_sub(OUT_HEADER));
                    for entry in fs.readdir(nodeid, fh, offset)? {
                        let mut rec = Vec::new();
                        if opcode == op::READDIRPLUS {
                            let dot = entry.name == b"." || entry.name == b"..";
                            let looked = if dot {
                                None
                            } else {
                                fs.lookup(nodeid, OsStr::from_bytes(&entry.name)).ok()
                            };
                            match &looked {
                                Some(e) => self.entry_out(&mut rec, e),
                                None => rec.extend_from_slice(&[0u8; 128]),
                            }
                        }
                        rec.extend_from_slice(&entry.ino.to_le_bytes());
                        rec.extend_from_slice(&entry.offset.to_le_bytes());
                        rec.extend_from_slice(&(entry.name.len() as u32).to_le_bytes());
                        rec.extend_from_slice(&entry.kind.to_le_bytes());
                        rec.extend_from_slice(&entry.name);
                        while rec.len() % 8 != 0 {
                            rec.push(0);
                        }
                        if out.len() + rec.len() > size {
                            if opcode == op::READDIRPLUS && rec.len() >= 128 {
                                // The entry is not returned: undo its lookup.
                                let nodeid = u64::from_le_bytes(rec[0..8].try_into().unwrap());
                                if nodeid != 0 {
                                    fs.forget(nodeid, 1);
                                }
                            }
                            break;
                        }
                        out.extend_from_slice(&rec);
                    }
                }
                op::ACCESS => {}
                _ => return Err(errno::ENOSYS),
            }
            Ok(())
        })();
        let _ = unique;
        Some(r.map(|()| match direct {
            Some(n) => Payload::Direct(n),
            None => Payload::Bytes(out),
        }))
    }
}

impl<F: FileSystem> crate::vhost_user::QueueHandler for FuseServer<F> {
    fn handle(&self, _queue: usize, request: &[u8], reply: &mut Writer<'_>) -> usize {
        if request.len() < IN_HEADER {
            return 0;
        }
        let h = Rd(request);
        let (opcode, unique, nodeid) = (h.u32(4), h.u64(8), h.u64(16));
        let body = Rd(&request[IN_HEADER..]);
        match opcode {
            op::FORGET => {
                self.fs.forget(nodeid, body.u64(0));
                return 0;
            }
            op::BATCH_FORGET => {
                let count = body.u32(0) as usize;
                for i in 0..count {
                    self.fs.forget(body.u64(8 + i * 16), body.u64(16 + i * 16));
                }
                return 0;
            }
            op::INTERRUPT => return 0,
            _ => {}
        }
        let started = std::time::Instant::now();
        // A panicking request answers EIO; the queue keeps serving.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.dispatch(opcode, nodeid, body, reply, unique)
        }))
        .unwrap_or(Some(Err(errno::EIO)))
        .unwrap_or(Err(errno::ENOSYS));
        if let Some(s) = self.stats.get(opcode as usize) {
            use std::sync::atomic::Ordering::Relaxed;
            s.0.fetch_add(1, Relaxed);
            s.1.fetch_add(started.elapsed().as_micros() as u64, Relaxed);
        }
        let header = |len: usize, error: i32| {
            let mut header = Vec::with_capacity(OUT_HEADER);
            header.extend_from_slice(&((OUT_HEADER + len) as u32).to_le_bytes());
            header.extend_from_slice(&error.to_le_bytes());
            header.extend_from_slice(&unique.to_le_bytes());
            header
        };
        match result {
            Ok(Payload::Bytes(payload)) => {
                reply.write(&header(payload.len(), 0));
                reply.write(&payload);
            }
            Ok(Payload::Direct(n)) => {
                let start = reply.written();
                reply.advance(OUT_HEADER + n);
                reply.patch(start, &header(n, 0));
            }
            Err(e) => {
                reply.write(&header(0, -e));
            }
        }
        reply.written()
    }
}

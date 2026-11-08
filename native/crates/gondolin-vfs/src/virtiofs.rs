//! The mount table served over virtio-fs: [`FsCore`] behind the inode-level
//! `FileSystem` trait of `gondolin-virtiofs` (FUSE over vhost-user).
//!
//! Requests arrive on the backend's queue threads (one per virtqueue, so
//! several request queues run concurrently); each operation is driven to
//! completion on the daemon's tokio runtime with `Handle::block_on`. Reads from
//! host files go straight into guest memory (`preadv`) when no hook needs to
//! see them.

use std::ffi::OsStr;
use std::future::Future;
use std::os::unix::ffi::OsStrExt;
use std::sync::Arc;

use gondolin_virtiofs::fuse::{self, FileSystem};
use tokio::runtime::Handle as RtHandle;

use crate::core::{EntryOut, FsCore};
use crate::error::{VfsError, VfsResult, errno};
use crate::types::{Attr, StatFs};

/// Largest directory page returned per READDIR (the FUSE layer packs what
/// fits and the guest continues from the last cookie).
const READDIR_PAGE: usize = 512;

/// Callback with every looked-up name.
type LookupHook = Box<dyn Fn(&str) + Send + Sync>;

/// [`FsCore`] as a virtio-fs filesystem.
pub struct VirtioFs {
    core: Arc<FsCore>,
    rt: RtHandle,
    /// called with every looked-up name (test fault injection)
    lookup_hook: Option<LookupHook>,
}

impl VirtioFs {
    /// `rt` drives the async filesystem operations (the queue threads are not
    /// runtime threads).
    pub fn new(core: Arc<FsCore>, rt: RtHandle) -> VirtioFs {
        VirtioFs { core, rt, lookup_hook: None }
    }

    /// Calls `hook` with the name of every lookup.
    pub fn with_lookup_hook(mut self, hook: impl Fn(&str) + Send + Sync + 'static) -> VirtioFs {
        self.lookup_hook = Some(Box::new(hook));
        self
    }

    fn run<T>(&self, op: &str, fut: impl Future<Output = VfsResult<T>>) -> fuse::Result<T> {
        // host calls run on this queue thread instead of the blocking pool
        let result = crate::host::with_inline_blocking(|| self.rt.block_on(fut));
        self.core.record(op, result.is_ok());
        result.map_err(|e| e.errno)
    }
}

fn name_str(name: &OsStr) -> fuse::Result<&str> {
    std::str::from_utf8(name.as_bytes()).map_err(|_| errno::EINVAL)
}

fn split_ms(ms: i64) -> (i64, u32) {
    (ms.div_euclid(1000), (ms.rem_euclid(1000) * 1_000_000) as u32)
}

fn fuse_attr(ino: u64, a: &Attr) -> fuse::Attr {
    fuse::Attr {
        ino,
        size: a.size,
        blocks: a.size.div_ceil(512),
        atime: split_ms(a.atime_ms),
        mtime: split_ms(a.mtime_ms),
        ctime: split_ms(a.ctime_ms),
        mode: a.mode,
        nlink: a.nlink,
        uid: a.uid,
        gid: a.gid,
        rdev: 0,
        blksize: 4096,
    }
}

fn fuse_entry(e: &EntryOut) -> fuse::Entry {
    fuse::Entry { nodeid: e.ino, attr: fuse_attr(e.ino, &e.attr) }
}

fn fuse_statfs(s: StatFs) -> fuse::StatFs {
    fuse::StatFs {
        blocks: s.blocks,
        bfree: s.bfree,
        bavail: s.bavail,
        files: s.files,
        ffree: s.ffree,
        bsize: s.bsize as u32,
        namelen: s.namelen as u32,
        frsize: s.frsize as u32,
    }
}

fn ms_of(t: (i64, u32)) -> i64 {
    t.0 * 1000 + (t.1 / 1_000_000) as i64
}

impl FileSystem for VirtioFs {
    fn lookup(&self, parent: u64, name: &OsStr) -> fuse::Result<fuse::Entry> {
        let name = name_str(name)?;
        if let Some(hook) = &self.lookup_hook {
            hook(name);
        }
        self.run("lookup", self.core.lookup(parent, name)).map(|e| fuse_entry(&e))
    }

    fn forget(&self, node: u64, nlookup: u64) {
        self.core.forget(node, nlookup);
    }

    fn getattr(&self, node: u64) -> fuse::Result<fuse::Attr> {
        self.run("getattr", self.core.getattr(node)).map(|a| fuse_attr(node, &a))
    }

    fn setattr(&self, node: u64, fh: Option<u64>, set: &fuse::SetAttr) -> fuse::Result<fuse::Attr> {
        let core = &self.core;
        self.run("setattr", async {
            if let Some(mode) = set.mode {
                match core.chmod(node, mode & 0o7777).await {
                    // like sandboxfs: providers without chmod keep their mode
                    Err(e) if e.is(errno::ENOSYS) => {}
                    r => r?,
                }
            }
            if let Some(size) = set.size {
                core.truncate(node, fh, size).await?;
            }
            if set.atime.is_some() || set.mtime.is_some() {
                let conv = |t: Option<Option<(i64, u32)>>| t.map(|t| t.map(ms_of));
                core.utimes(node, conv(set.atime), conv(set.mtime)).await?;
            }
            match fh {
                Some(fh) => match core.getattr(node).await {
                    Err(e) if e.is(errno::ENOENT) => core.getattr_fh(fh).await,
                    r => r,
                },
                None => core.getattr(node).await,
            }
        })
        .map(|a| fuse_attr(node, &a))
    }

    fn readlink(&self, node: u64) -> fuse::Result<Vec<u8>> {
        self.run("readlink", self.core.readlink(node)).map(String::into_bytes)
    }

    fn symlink(&self, parent: u64, name: &OsStr, target: &OsStr) -> fuse::Result<fuse::Entry> {
        let name = name_str(name)?;
        let target = name_str(target)?;
        self.run("symlink", self.core.symlink(parent, name, target)).map(|e| fuse_entry(&e))
    }

    fn mkdir(&self, parent: u64, name: &OsStr, mode: u32) -> fuse::Result<fuse::Entry> {
        let name = name_str(name)?;
        self.run("mkdir", self.core.mkdir(parent, name, mode & 0o7777)).map(|e| fuse_entry(&e))
    }

    fn unlink(&self, parent: u64, name: &OsStr) -> fuse::Result<()> {
        let name = name_str(name)?;
        self.run("unlink", self.core.unlink(parent, name, false))
    }

    fn rmdir(&self, parent: u64, name: &OsStr) -> fuse::Result<()> {
        let name = name_str(name)?;
        self.run("rmdir", self.core.unlink(parent, name, true))
    }

    fn rename(
        &self,
        parent: u64,
        name: &OsStr,
        newparent: u64,
        newname: &OsStr,
        flags: u32,
    ) -> fuse::Result<()> {
        if flags != 0 {
            // RENAME_NOREPLACE / EXCHANGE / WHITEOUT, like sandboxfs
            return Err(errno::EOPNOTSUPP);
        }
        let (name, newname) = (name_str(name)?, name_str(newname)?);
        self.run("rename", self.core.rename(parent, name, newparent, newname, 0))
    }

    fn link(&self, node: u64, newparent: u64, newname: &OsStr) -> fuse::Result<fuse::Entry> {
        let newname = name_str(newname)?;
        self.run("link", self.core.link(node, newparent, newname)).map(|e| fuse_entry(&e))
    }

    fn open(&self, node: u64, flags: u32) -> fuse::Result<u64> {
        self.run("open", self.core.open(node, flags as u64))
    }

    fn create(
        &self,
        parent: u64,
        name: &OsStr,
        mode: u32,
        flags: u32,
    ) -> fuse::Result<(fuse::Entry, u64)> {
        let name = name_str(name)?;
        self.run("create", self.core.create(parent, name, mode & 0o7777, flags as u64))
            .map(|(e, fh)| (fuse_entry(&e), fh))
    }

    fn read(&self, _node: u64, fh: u64, offset: u64, buf: &mut [u8]) -> fuse::Result<usize> {
        let data = self.run("read", self.core.read(fh, offset, buf.len()))?;
        buf[..data.len()].copy_from_slice(&data);
        Ok(data.len())
    }

    fn read_vectored(
        &self,
        node: u64,
        fh: u64,
        offset: u64,
        bufs: &mut [&mut [u8]],
    ) -> fuse::Result<usize> {
        let handle = self.core.file_handle(fh).map_err(|e| e.errno)?;
        if let Some(result) = handle.read_vectored_sync(offset, bufs) {
            self.core.record("read", result.is_ok());
            return result.map_err(|e: VfsError| e.errno);
        }
        let total = bufs.iter().map(|b| b.len()).sum();
        let data = self.run("read", self.core.read(fh, offset, total))?;
        let _ = node;
        let mut done = 0;
        for b in bufs.iter_mut() {
            if done >= data.len() {
                break;
            }
            let k = b.len().min(data.len() - done);
            b[..k].copy_from_slice(&data[done..done + k]);
            done += k;
        }
        Ok(data.len())
    }

    fn write(&self, _node: u64, fh: u64, offset: u64, data: &[u8]) -> fuse::Result<usize> {
        // host files: written straight from the request buffer
        let handle = self.core.file_handle(fh).map_err(|e| e.errno)?;
        if let Some(result) = handle.write_sync(offset, data) {
            self.core.record("write", result.is_ok());
            return result.map_err(|e: VfsError| e.errno);
        }
        self.run("write", self.core.write(fh, offset, data))
    }

    fn flush(&self, _node: u64, fh: u64) -> fuse::Result<()> {
        self.run("flush", self.core.flush(fh))
    }

    fn fsync(&self, _node: u64, fh: u64, _datasync: bool) -> fuse::Result<()> {
        self.run("fsync", self.core.fsync(fh))
    }

    fn release(&self, _node: u64, fh: u64) {
        if let Err(e) = self.run("release", self.core.release(fh)) {
            gondolin_log::debug!("virtiofs: release failed: errno {e}");
        }
    }

    fn opendir(&self, node: u64) -> fuse::Result<u64> {
        self.run("opendir", self.core.opendir(node))
    }

    fn readdir(&self, _node: u64, fh: u64, offset: u64) -> fuse::Result<Vec<fuse::DirEntry>> {
        let items = self.run("readdir", self.core.readdir_handle(fh, offset, READDIR_PAGE))?;
        Ok(items
            .into_iter()
            .map(|e| fuse::DirEntry {
                ino: e.ino,
                offset: e.offset,
                kind: e.kind,
                name: e.name.into_bytes(),
            })
            .collect())
    }

    fn releasedir(&self, _node: u64, fh: u64) {
        self.core.releasedir(fh);
    }

    fn statfs(&self, node: u64) -> fuse::Result<fuse::StatFs> {
        self.run("statfs", self.core.statfs(node)).map(fuse_statfs)
    }
}

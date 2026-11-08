//! Thin safe wrappers over the `libc` calls the host provider needs: `*at`
//! calls relative to directory fds, `openat2` on Linux, directory reading and
//! vectored reads. Errors are the raw `errno` ([`Errno`]).

use std::ffi::{CStr, CString};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;

pub use libc::{c_int, mode_t, stat as Stat, statvfs as StatVfs, timespec as Timespec};

/// A raw `errno` value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Errno(pub i32);

impl Errno {
    pub const NOENT: Errno = Errno(libc::ENOENT);
    pub const EXIST: Errno = Errno(libc::EEXIST);
    pub const LOOP: Errno = Errno(libc::ELOOP);
    pub const NOTDIR: Errno = Errno(libc::ENOTDIR);
    pub const INTR: Errno = Errno(libc::EINTR);
    pub const INVAL: Errno = Errno(libc::EINVAL);
    #[cfg(target_os = "linux")]
    pub const NOSYS: Errno = Errno(libc::ENOSYS);
    #[cfg(target_os = "linux")]
    pub const PERM: Errno = Errno(libc::EPERM);

    fn last() -> Errno {
        Errno(std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO))
    }

    pub fn raw_os_error(self) -> i32 {
        self.0
    }
}

impl From<Errno> for std::io::Error {
    fn from(e: Errno) -> Self {
        std::io::Error::from_raw_os_error(e.0)
    }
}

pub type Result<T> = std::result::Result<T, Errno>;

/// `0` → `Ok`, `-1` → the current `errno`.
fn check(ret: c_int) -> Result<()> {
    if ret == -1 { Err(Errno::last()) } else { Ok(()) }
}

fn check_fd(ret: c_int) -> Result<OwnedFd> {
    if ret < 0 {
        Err(Errno::last())
    } else {
        // SAFETY: a fresh descriptor returned by the kernel, owned by nobody else
        Ok(unsafe { OwnedFd::from_raw_fd(ret) })
    }
}

fn cstr(s: &str) -> Result<CString> {
    CString::new(s).map_err(|_| Errno::INVAL)
}

fn raw(fd: &impl AsFd) -> c_int {
    fd.as_fd().as_raw_fd()
}

pub fn open(path: &std::path::Path, flags: c_int, mode: mode_t) -> Result<OwnedFd> {
    let p = CString::new(path.as_os_str().as_bytes()).map_err(|_| Errno::INVAL)?;
    // SAFETY: valid NUL-terminated path; the variadic mode is passed as `c_uint`
    check_fd(unsafe { libc::open(p.as_ptr(), flags, mode as libc::c_uint) })
}

pub fn openat(dir: &impl AsFd, name: &str, flags: c_int, mode: mode_t) -> Result<OwnedFd> {
    let n = cstr(name)?;
    // SAFETY: valid fd and NUL-terminated name
    check_fd(unsafe { libc::openat(raw(dir), n.as_ptr(), flags, mode as libc::c_uint) })
}

/// `openat2(2)` with `resolve` flags (`RESOLVE_*`).
#[cfg(target_os = "linux")]
pub fn openat2(
    dir: &impl AsFd,
    path: &str,
    flags: c_int,
    mode: mode_t,
    resolve: u64,
) -> Result<OwnedFd> {
    let p = cstr(path)?;
    // SAFETY: zeroed is a valid open_how (all integer fields)
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = flags as u64;
    how.mode = mode as u64;
    how.resolve = resolve;
    // SAFETY: valid fd, path and open_how of the size passed
    let ret = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            raw(dir),
            p.as_ptr(),
            &how as *const libc::open_how,
            std::mem::size_of::<libc::open_how>(),
        )
    };
    check_fd(ret as c_int)
}

/// `fstatat`; `nofollow` acts on a final symlink itself.
pub fn statat(dir: &impl AsFd, name: &str, nofollow: bool) -> Result<Stat> {
    let n = cstr(name)?;
    let flags = if nofollow { libc::AT_SYMLINK_NOFOLLOW } else { 0 };
    let mut st = std::mem::MaybeUninit::<Stat>::uninit();
    // SAFETY: valid fd, name and output buffer
    check(unsafe { libc::fstatat(raw(dir), n.as_ptr(), st.as_mut_ptr(), flags) })?;
    // SAFETY: initialized by a successful fstatat
    Ok(unsafe { st.assume_init() })
}

pub fn fstat(fd: &impl AsFd) -> Result<Stat> {
    let mut st = std::mem::MaybeUninit::<Stat>::uninit();
    // SAFETY: valid fd and output buffer
    check(unsafe { libc::fstat(raw(fd), st.as_mut_ptr()) })?;
    // SAFETY: initialized by a successful fstat
    Ok(unsafe { st.assume_init() })
}

pub fn fstatvfs(fd: &impl AsFd) -> Result<StatVfs> {
    let mut st = std::mem::MaybeUninit::<StatVfs>::uninit();
    // SAFETY: valid fd and output buffer
    check(unsafe { libc::fstatvfs(raw(fd), st.as_mut_ptr()) })?;
    // SAFETY: initialized by a successful fstatvfs
    Ok(unsafe { st.assume_init() })
}

/// The target of the symlink `name` (raw bytes).
pub fn readlinkat(dir: &impl AsFd, name: &str) -> Result<Vec<u8>> {
    let n = cstr(name)?;
    let mut buf = vec![0u8; 256];
    loop {
        // SAFETY: valid fd, name and buffer of `buf.len()` bytes
        let len =
            unsafe { libc::readlinkat(raw(dir), n.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
        if len < 0 {
            return Err(Errno::last());
        }
        let len = len as usize;
        if len < buf.len() {
            buf.truncate(len);
            return Ok(buf);
        }
        // possibly truncated: retry larger
        buf.resize(buf.len() * 2, 0);
    }
}

pub fn mkdirat(dir: &impl AsFd, name: &str, mode: mode_t) -> Result<()> {
    let n = cstr(name)?;
    // SAFETY: valid fd and name
    check(unsafe { libc::mkdirat(raw(dir), n.as_ptr(), mode) })
}

/// `unlinkat`; `dir_entry` removes a directory (`AT_REMOVEDIR`).
pub fn unlinkat(dir: &impl AsFd, name: &str, dir_entry: bool) -> Result<()> {
    let n = cstr(name)?;
    let flags = if dir_entry { libc::AT_REMOVEDIR } else { 0 };
    // SAFETY: valid fd and name
    check(unsafe { libc::unlinkat(raw(dir), n.as_ptr(), flags) })
}

pub fn renameat(a: &impl AsFd, an: &str, b: &impl AsFd, bn: &str) -> Result<()> {
    let (an, bn) = (cstr(an)?, cstr(bn)?);
    // SAFETY: valid fds and names
    check(unsafe { libc::renameat(raw(a), an.as_ptr(), raw(b), bn.as_ptr()) })
}

/// `linkat` without following a symlink source.
pub fn linkat(a: &impl AsFd, an: &str, b: &impl AsFd, bn: &str) -> Result<()> {
    let (an, bn) = (cstr(an)?, cstr(bn)?);
    // SAFETY: valid fds and names
    check(unsafe { libc::linkat(raw(a), an.as_ptr(), raw(b), bn.as_ptr(), 0) })
}

pub fn symlinkat(target: &str, dir: &impl AsFd, name: &str) -> Result<()> {
    let (t, n) = (cstr(target)?, cstr(name)?);
    // SAFETY: valid fd and names
    check(unsafe { libc::symlinkat(t.as_ptr(), raw(dir), n.as_ptr()) })
}

pub fn chmodat(dir: &impl AsFd, name: &str, mode: mode_t) -> Result<()> {
    let n = cstr(name)?;
    // SAFETY: valid fd and name
    check(unsafe { libc::fchmodat(raw(dir), n.as_ptr(), mode, 0) })
}

pub fn fchmod(fd: &impl AsFd, mode: mode_t) -> Result<()> {
    // SAFETY: valid fd
    check(unsafe { libc::fchmod(raw(fd), mode) })
}

/// `utimensat` on `name` itself (never through a final symlink).
pub fn utimensat_nofollow(dir: &impl AsFd, name: &str, times: &[Timespec; 2]) -> Result<()> {
    let n = cstr(name)?;
    // SAFETY: valid fd, name and two timespecs
    check(unsafe {
        libc::utimensat(raw(dir), n.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW)
    })
}

/// `faccessat` with a mask of `R_OK | W_OK | X_OK` (`0`: existence).
pub fn accessat(dir: &impl AsFd, name: &str, mask: c_int) -> Result<()> {
    let n = cstr(name)?;
    // SAFETY: valid fd and name
    check(unsafe { libc::faccessat(raw(dir), n.as_ptr(), mask, 0) })
}

pub fn ftruncate(fd: &impl AsFd, size: u64) -> Result<()> {
    let size = libc::off_t::try_from(size).map_err(|_| Errno(libc::EFBIG))?;
    // SAFETY: valid fd
    check(unsafe { libc::ftruncate(raw(fd), size) })
}

/// One `write(2)` (appends use the file's own offset).
pub fn write(fd: BorrowedFd<'_>, data: &[u8]) -> Result<usize> {
    // SAFETY: valid fd and buffer
    let n = unsafe { libc::write(fd.as_raw_fd(), data.as_ptr().cast(), data.len()) };
    if n < 0 { Err(Errno::last()) } else { Ok(n as usize) }
}

/// One `preadv(2)` at `offset`.
pub fn preadv(
    fd: BorrowedFd<'_>,
    bufs: &mut [std::io::IoSliceMut<'_>],
    offset: u64,
) -> Result<usize> {
    let offset = libc::off_t::try_from(offset).map_err(|_| Errno::INVAL)?;
    let count = bufs.len().min(1024) as c_int;
    // SAFETY: IoSliceMut is ABI-compatible with iovec; valid fd
    let n = unsafe { libc::preadv(fd.as_raw_fd(), bufs.as_mut_ptr().cast(), count, offset) };
    if n < 0 { Err(Errno::last()) } else { Ok(n as usize) }
}

/// Kind of a directory entry (`d_type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirType {
    Dir,
    Symlink,
    Unknown,
    Other,
}

/// An open directory stream (`fdopendir`), closed on drop.
pub struct Dir(std::ptr::NonNull<libc::DIR>);

// SAFETY: the stream is used by one thread at a time (`&mut self`)
unsafe impl Send for Dir {}

impl Dir {
    /// Takes ownership of `fd` (a directory opened for reading).
    pub fn new(fd: OwnedFd) -> Result<Dir> {
        use std::os::fd::IntoRawFd;
        let raw = fd.into_raw_fd();
        // SAFETY: an owned directory fd; on success the stream owns it
        let dir = unsafe { libc::fdopendir(raw) };
        match std::ptr::NonNull::new(dir) {
            Some(d) => Ok(Dir(d)),
            None => {
                let e = Errno::last();
                // SAFETY: still ours after a failed fdopendir
                drop(unsafe { OwnedFd::from_raw_fd(raw) });
                Err(e)
            }
        }
    }
}

impl Iterator for Dir {
    /// name bytes and kind
    type Item = Result<(Vec<u8>, DirType)>;

    fn next(&mut self) -> Option<Self::Item> {
        // readdir signals errors only through errno
        set_errno(0);
        // SAFETY: an open stream
        let entry = unsafe { libc::readdir(self.0.as_ptr()) };
        if entry.is_null() {
            let e = Errno::last();
            return if e.0 == 0 { None } else { Some(Err(e)) };
        }
        // SAFETY: a valid dirent until the next readdir on this stream
        let (name, d_type) = unsafe {
            (CStr::from_ptr((*entry).d_name.as_ptr()).to_bytes().to_vec(), (*entry).d_type)
        };
        let kind = match d_type {
            libc::DT_DIR => DirType::Dir,
            libc::DT_LNK => DirType::Symlink,
            libc::DT_UNKNOWN => DirType::Unknown,
            _ => DirType::Other,
        };
        Some(Ok((name, kind)))
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        // SAFETY: an open stream, closed once
        unsafe { libc::closedir(self.0.as_ptr()) };
    }
}

fn set_errno(value: c_int) {
    // SAFETY: the thread's errno location
    unsafe {
        #[cfg(target_os = "linux")]
        {
            *libc::__errno_location() = value;
        }
        #[cfg(target_vendor = "apple")]
        {
            *libc::__error() = value;
        }
    }
}

pub fn getuid() -> u32 {
    // SAFETY: always succeeds
    unsafe { libc::getuid() }
}

pub fn getgid() -> u32 {
    // SAFETY: always succeeds
    unsafe { libc::getgid() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_calls_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let dir =
            open(tmp.path(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC, 0).unwrap();
        mkdirat(&dir, "d", 0o755).unwrap();
        assert_eq!(mkdirat(&dir, "d", 0o755), Err(Errno::EXIST));
        let long = "t/".repeat(400);
        symlinkat(&long, &dir, "l").unwrap();
        assert_eq!(readlinkat(&dir, "l").unwrap(), long.as_bytes());
        let st = statat(&dir, "l", true).unwrap();
        assert_eq!(st.st_mode & libc::S_IFMT, libc::S_IFLNK);
        assert_eq!(statat(&dir, "l", false).unwrap_err(), Errno::NOENT);
        let fd =
            openat(&dir, "f", libc::O_WRONLY | libc::O_CREAT | libc::O_CLOEXEC, 0o600).unwrap();
        assert_eq!(write(fd.as_fd(), b"hello").unwrap(), 5);
        ftruncate(&fd, 3).unwrap();
        assert_eq!(fstat(&fd).unwrap().st_size, 3);
        renameat(&dir, "f", &dir, "g").unwrap();
        linkat(&dir, "g", &dir, "h").unwrap();
        chmodat(&dir, "h", 0o640).unwrap();
        assert_eq!(statat(&dir, "g", true).unwrap().st_mode & 0o777, 0o640);
        accessat(&dir, "g", libc::R_OK).unwrap();
        let now = Timespec { tv_sec: 1_000_000, tv_nsec: 0 };
        utimensat_nofollow(&dir, "g", &[now, now]).unwrap();
        assert_eq!(statat(&dir, "g", true).unwrap().st_mtime, 1_000_000);
        let r = openat(&dir, "g", libc::O_RDONLY | libc::O_CLOEXEC, 0).unwrap();
        let (mut a, mut b) = ([0u8; 1], [0u8; 4]);
        let mut iov = [std::io::IoSliceMut::new(&mut a), std::io::IoSliceMut::new(&mut b)];
        assert_eq!(preadv(r.as_fd(), &mut iov, 0).unwrap(), 3);
        assert_eq!((&a, &b[..2]), (b"h", &b"el"[..]));
        assert!(fstatvfs(&dir).unwrap().f_blocks > 0);
        let rd =
            openat(&dir, ".", libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC, 0).unwrap();
        let mut names: Vec<_> =
            Dir::new(rd).unwrap().map_while(|e| e.ok()).map(|(n, _)| n).collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, [&b"."[..], b"..", b"d", b"g", b"h", b"l"]);
        unlinkat(&dir, "d", true).unwrap();
        unlinkat(&dir, "g", false).unwrap();
        assert_eq!(
            openat(&dir, "l", libc::O_RDONLY | libc::O_NOFOLLOW, 0).unwrap_err(),
            Errno::LOOP
        );
        assert_eq!(mkdirat(&dir, "x\0y", 0o755), Err(Errno::INVAL));
    }
}

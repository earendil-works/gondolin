//! Errors of filesystem operations, carried as Linux errno values (the guest
//! interprets errno numbers as Linux values whatever the host OS is).

use std::fmt;
use std::io;

/// Linux errno values and names (`host/src/vfs/linux-errno.ts`).
pub mod errno {
    pub const EPERM: i32 = 1;
    pub const ENOENT: i32 = 2;
    pub const EINTR: i32 = 4;
    pub const EIO: i32 = 5;
    pub const ENXIO: i32 = 6;
    pub const E2BIG: i32 = 7;
    pub const EBADF: i32 = 9;
    pub const EAGAIN: i32 = 11;
    pub const ENOMEM: i32 = 12;
    pub const EACCES: i32 = 13;
    pub const EFAULT: i32 = 14;
    pub const EBUSY: i32 = 16;
    pub const EEXIST: i32 = 17;
    pub const EXDEV: i32 = 18;
    pub const ENODEV: i32 = 19;
    pub const ENOTDIR: i32 = 20;
    pub const EISDIR: i32 = 21;
    pub const EINVAL: i32 = 22;
    pub const ENFILE: i32 = 23;
    pub const EMFILE: i32 = 24;
    pub const ENOTTY: i32 = 25;
    pub const ETXTBSY: i32 = 26;
    pub const EFBIG: i32 = 27;
    pub const ENOSPC: i32 = 28;
    pub const ESPIPE: i32 = 29;
    pub const EROFS: i32 = 30;
    pub const EMLINK: i32 = 31;
    pub const EPIPE: i32 = 32;
    pub const ERANGE: i32 = 34;
    pub const EDEADLK: i32 = 35;
    pub const ENAMETOOLONG: i32 = 36;
    pub const ENOLCK: i32 = 37;
    pub const ENOSYS: i32 = 38;
    pub const ENOTEMPTY: i32 = 39;
    pub const ELOOP: i32 = 40;
    pub const ENODATA: i32 = 61;
    pub const EOVERFLOW: i32 = 75;
    pub const EILSEQ: i32 = 84;
    pub const EOPNOTSUPP: i32 = 95;
    pub const ETIMEDOUT: i32 = 110;
    pub const ECONNREFUSED: i32 = 111;
    pub const ESTALE: i32 = 116;
    pub const EDQUOT: i32 = 122;
    pub const ECANCELED: i32 = 125;

    /// `(name, value)` pairs; aliases map to the same value.
    pub const NAMES: &[(&str, i32)] = &[
        ("EPERM", 1),
        ("ENOENT", 2),
        ("ESRCH", 3),
        ("EINTR", 4),
        ("EIO", 5),
        ("ENXIO", 6),
        ("E2BIG", 7),
        ("ENOEXEC", 8),
        ("EBADF", 9),
        ("ECHILD", 10),
        ("EAGAIN", 11),
        ("EWOULDBLOCK", 11),
        ("ENOMEM", 12),
        ("EACCES", 13),
        ("EFAULT", 14),
        ("ENOTBLK", 15),
        ("EBUSY", 16),
        ("EEXIST", 17),
        ("EXDEV", 18),
        ("ENODEV", 19),
        ("ENOTDIR", 20),
        ("EISDIR", 21),
        ("EINVAL", 22),
        ("ENFILE", 23),
        ("EMFILE", 24),
        ("ENOTTY", 25),
        ("ETXTBSY", 26),
        ("EFBIG", 27),
        ("ENOSPC", 28),
        ("ESPIPE", 29),
        ("EROFS", 30),
        ("EMLINK", 31),
        ("EPIPE", 32),
        ("EDOM", 33),
        ("ERANGE", 34),
        ("EDEADLK", 35),
        ("ENAMETOOLONG", 36),
        ("ENOLCK", 37),
        ("ENOSYS", 38),
        ("ENOTEMPTY", 39),
        ("ELOOP", 40),
        ("ENOMSG", 42),
        ("EIDRM", 43),
        ("ENODATA", 61),
        ("ETIME", 62),
        ("EPROTO", 71),
        ("EBADMSG", 74),
        ("EOVERFLOW", 75),
        ("EILSEQ", 84),
        ("ENOTSOCK", 88),
        ("EMSGSIZE", 90),
        ("EOPNOTSUPP", 95),
        ("ENOTSUP", 95),
        ("EAFNOSUPPORT", 97),
        ("EADDRINUSE", 98),
        ("EADDRNOTAVAIL", 99),
        ("ENETDOWN", 100),
        ("ENETUNREACH", 101),
        ("ECONNABORTED", 103),
        ("ECONNRESET", 104),
        ("ENOBUFS", 105),
        ("ENOTCONN", 107),
        ("ETIMEDOUT", 110),
        ("ECONNREFUSED", 111),
        ("EHOSTUNREACH", 113),
        ("EALREADY", 114),
        ("EINPROGRESS", 115),
        ("ESTALE", 116),
        ("EDQUOT", 122),
        ("ECANCELED", 125),
    ];

    /// Linux errno for a name (`"ENOENT"` → 2); `ERRNO_<n>` is accepted too.
    pub fn from_name(name: &str) -> Option<i32> {
        if let Some(rest) = name.strip_prefix("ERRNO_") {
            return rest.parse().ok().filter(|v: &i32| *v > 0 && *v < 4096);
        }
        NAMES.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
    }

    /// Canonical name of a Linux errno (`ERRNO_<n>` when unknown).
    pub fn name(value: i32) -> String {
        NAMES
            .iter()
            .find(|(_, v)| *v == value)
            .map(|(n, _)| (*n).to_string())
            .unwrap_or_else(|| format!("ERRNO_{value}"))
    }

    /// Translates a host OS errno into the Linux value.
    pub fn from_host(host: i32) -> i32 {
        #[cfg(target_os = "linux")]
        {
            host
        }
        #[cfg(not(target_os = "linux"))]
        {
            use libc as l;
            let table: &[(i32, i32)] = &[
                (l::EPERM, EPERM),
                (l::ENOENT, ENOENT),
                (l::EINTR, EINTR),
                (l::EIO, EIO),
                (l::ENXIO, ENXIO),
                (l::E2BIG, E2BIG),
                (l::EBADF, EBADF),
                (l::EAGAIN, EAGAIN),
                (l::ENOMEM, ENOMEM),
                (l::EACCES, EACCES),
                (l::EFAULT, EFAULT),
                (l::EBUSY, EBUSY),
                (l::EEXIST, EEXIST),
                (l::EXDEV, EXDEV),
                (l::ENODEV, ENODEV),
                (l::ENOTDIR, ENOTDIR),
                (l::EISDIR, EISDIR),
                (l::EINVAL, EINVAL),
                (l::ENFILE, ENFILE),
                (l::EMFILE, EMFILE),
                (l::ENOTTY, ENOTTY),
                (l::ETXTBSY, ETXTBSY),
                (l::EFBIG, EFBIG),
                (l::ENOSPC, ENOSPC),
                (l::ESPIPE, ESPIPE),
                (l::EROFS, EROFS),
                (l::EMLINK, EMLINK),
                (l::EPIPE, EPIPE),
                (l::ERANGE, ERANGE),
                (l::EDEADLK, EDEADLK),
                (l::ENAMETOOLONG, ENAMETOOLONG),
                (l::ENOLCK, ENOLCK),
                (l::ENOSYS, ENOSYS),
                (l::ENOTEMPTY, ENOTEMPTY),
                (l::ELOOP, ELOOP),
                (l::ENODATA, ENODATA),
                (l::EOVERFLOW, EOVERFLOW),
                (l::EILSEQ, EILSEQ),
                (l::EOPNOTSUPP, EOPNOTSUPP),
                (l::ENOTSUP, EOPNOTSUPP),
                (l::ETIMEDOUT, ETIMEDOUT),
                (l::ECONNREFUSED, ECONNREFUSED),
                (l::ESTALE, ESTALE),
                (l::EDQUOT, EDQUOT),
                (l::ECANCELED, ECANCELED),
                (l::ENOATTR, ENODATA),
            ];
            table.iter().find(|(h, _)| *h == host).map(|(_, v)| *v).unwrap_or(EIO)
        }
    }
}

/// Error of a filesystem operation: a Linux errno plus a diagnostic message.
#[derive(Clone, PartialEq, Eq)]
pub struct VfsError {
    /// Linux errno value (positive)
    pub errno: i32,
    pub message: String,
}

impl VfsError {
    pub fn new(errno: i32, message: impl Into<String>) -> Self {
        VfsError { errno, message: message.into() }
    }

    /// `ENOENT: <op> '<path>'` style error, like the node engine's
    /// `createErrnoError`.
    pub fn op(errno: i32, op: &str, path: &str) -> Self {
        let name = errno::name(errno);
        if path.is_empty() {
            VfsError { errno, message: format!("{name}: {op}") }
        } else {
            VfsError { errno, message: format!("{name}: {op} '{path}'") }
        }
    }

    pub fn code(&self) -> String {
        errno::name(self.errno)
    }

    /// Builds an error from an errno name received over the wire.
    pub fn from_code(code: &str, message: Option<String>) -> Self {
        let value = errno::from_name(code).unwrap_or(errno::EIO);
        VfsError { errno: value, message: message.unwrap_or_else(|| code.to_string()) }
    }

    pub fn is(&self, value: i32) -> bool {
        self.errno == value
    }

    pub fn from_io(err: &io::Error, op: &str, path: &str) -> Self {
        let value = err.raw_os_error().map(errno::from_host).unwrap_or(errno::EIO);
        VfsError::op(value, op, path)
    }
}

impl fmt::Debug for VfsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "VfsError({}, {:?})", errno::name(self.errno), self.message)
    }
}

impl fmt::Display for VfsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for VfsError {}

impl From<crate::sys::Errno> for VfsError {
    fn from(err: crate::sys::Errno) -> Self {
        let value = errno::from_host(err.raw_os_error());
        VfsError::new(value, errno::name(value))
    }
}

pub type VfsResult<T> = Result<T, VfsError>;

/// Shorthand for an errno-only error.
pub fn err<T>(value: i32, op: &str, path: &str) -> VfsResult<T> {
    Err(VfsError::op(value, op, path))
}

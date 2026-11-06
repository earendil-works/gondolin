//! The controller connection on stdin/stdout. When they are sockets or pipes
//! (always, when spawned by the SDK or over SSH) they are driven non-blocking
//! by the runtime's reactor; tokio's `stdin()`/`stdout()` would hand every read
//! and write to a blocking thread (two thread switches per frame).

use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::pin::Pin;

use tokio::io::{AsyncRead, AsyncWrite};

pub type Reader = Pin<Box<dyn AsyncRead + Send>>;
pub type Writer = Pin<Box<dyn AsyncWrite + Send>>;

enum Kind {
    Socket,
    Fifo,
    Other,
}

fn kind(fd: RawFd) -> Kind {
    // SAFETY: fstat on a descriptor we own for the process lifetime.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } != 0 {
        return Kind::Other;
    }
    match st.st_mode & libc::S_IFMT {
        libc::S_IFSOCK => Kind::Socket,
        libc::S_IFIFO => Kind::Fifo,
        _ => Kind::Other,
    }
}

/// Takes ownership of `fd` (a duplicate, so fds 0/1 stay valid for anything
/// else that writes to them, e.g. panic output goes to stderr anyway).
fn dup_owned(fd: RawFd) -> Option<OwnedFd> {
    // SAFETY: dup returns a new descriptor we own.
    let new = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    (new >= 0).then(|| unsafe { OwnedFd::from_raw_fd(new) })
}

/// The controller input (stdin).
pub fn reader() -> Reader {
    match kind(0) {
        Kind::Socket => {
            if let Some(fd) = dup_owned(0) {
                let std = std::os::unix::net::UnixStream::from(fd);
                if std.set_nonblocking(true).is_ok()
                    && let Ok(sock) = tokio::net::UnixStream::from_std(std)
                {
                    return Box::pin(sock);
                }
            }
        }
        Kind::Fifo => {
            if let Some(fd) = dup_owned(0)
                && let Ok(rx) = tokio::net::unix::pipe::Receiver::from_owned_fd(fd)
            {
                return Box::pin(rx);
            }
        }
        Kind::Other => {}
    }
    Box::pin(tokio::io::stdin())
}

/// The controller output (stdout).
pub fn writer() -> Writer {
    match kind(1) {
        Kind::Socket => {
            if let Some(fd) = dup_owned(1) {
                let std = std::os::unix::net::UnixStream::from(fd);
                if std.set_nonblocking(true).is_ok()
                    && let Ok(sock) = tokio::net::UnixStream::from_std(std)
                {
                    return Box::pin(sock);
                }
            }
        }
        Kind::Fifo => {
            if let Some(fd) = dup_owned(1)
                && let Ok(tx) = tokio::net::unix::pipe::Sender::from_owned_fd(fd)
            {
                return Box::pin(tx);
            }
        }
        Kind::Other => {}
    }
    Box::pin(tokio::io::stdout())
}

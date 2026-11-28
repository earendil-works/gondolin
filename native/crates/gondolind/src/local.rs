//! Private host-to-QEMU transports: Unix sockets on Unix, loopback TCP on
//! Windows (QEMU's Windows chardevs do not implement Unix sockets).
use std::io;
use std::path::{Path, PathBuf};

#[cfg(windows)]
pub use tokio::net::tcp::OwnedWriteHalf;
#[cfg(unix)]
pub use tokio::net::unix::OwnedWriteHalf;

#[cfg(windows)]
pub use tokio::net::{TcpListener as Listener, TcpStream as Stream};
#[cfg(unix)]
pub use tokio::net::{UnixListener as Listener, UnixStream as Stream};

/// Binds before QEMU starts, returning the actual endpoint, including the
/// OS-allocated port on Windows. The listener stays bound until shutdown.
pub fn bind(path: &Path) -> io::Result<(Listener, PathBuf)> {
    #[cfg(unix)]
    {
        Ok((Listener::bind(path)?, path.to_path_buf()))
    }
    #[cfg(windows)]
    {
        let _ = path;
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let endpoint = PathBuf::from(listener.local_addr()?.to_string());
        Ok((Listener::from_std(listener)?, endpoint))
    }
}

pub async fn connect(path: &Path) -> io::Result<Stream> {
    #[cfg(unix)]
    {
        Stream::connect(path).await
    }
    #[cfg(windows)]
    {
        let addr = path.to_str().ok_or_else(|| io::Error::other("invalid local endpoint"))?;
        let addr: std::net::SocketAddr = addr.parse().map_err(io::Error::other)?;
        if !addr.ip().is_loopback() {
            return Err(io::Error::other("local endpoint must be loopback"));
        }
        Stream::connect(addr).await
    }
}

/// QEMU listens on QMP itself, so reserve a candidate endpoint then release it.
/// A conflicting bind fails QEMU startup rather than selecting another host.
pub fn qmp_endpoint(path: &Path) -> io::Result<PathBuf> {
    #[cfg(unix)]
    {
        Ok(path.to_path_buf())
    }
    #[cfg(windows)]
    {
        let _ = path;
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        Ok(PathBuf::from(listener.local_addr()?.to_string()))
    }
}

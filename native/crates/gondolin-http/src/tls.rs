//! A small tokio adapter for rustls connections (client and server, incl.
//! lazily configured servers that look at the ClientHello first).

use std::future::poll_fn;
use std::io::{self, Read, Write};
use std::ops::{Deref, DerefMut};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, ready};

use rustls::pki_types::ServerName;
use rustls::server::{Accepted, Acceptor, ClientHello};
use rustls::{ClientConnection, ConnectionCommon, ServerConnection, SideData};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};

/// A TLS stream over `IO`.
pub struct TlsStream<IO, C> {
    io: IO,
    conn: C,
    /// no more plaintext will be read (close_notify or EOF seen)
    read_closed: bool,
    /// close_notify sent
    write_closed: bool,
}

pub type ClientTlsStream<IO> = TlsStream<IO, ClientConnection>;
pub type ServerTlsStream<IO> = TlsStream<IO, ServerConnection>;

struct SyncRead<'a, 'b, T> {
    io: &'a mut T,
    cx: &'a mut Context<'b>,
}

impl<T: AsyncRead + Unpin> Read for SyncRead<'_, '_, T> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut buf = ReadBuf::new(buf);
        match Pin::new(&mut *self.io).poll_read(self.cx, &mut buf) {
            Poll::Ready(Ok(())) => Ok(buf.filled().len()),
            Poll::Ready(Err(e)) => Err(e),
            Poll::Pending => Err(io::ErrorKind::WouldBlock.into()),
        }
    }
}

struct SyncWrite<'a, 'b, T> {
    io: &'a mut T,
    cx: &'a mut Context<'b>,
}

impl<T: AsyncWrite + Unpin> Write for SyncWrite<'_, '_, T> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match Pin::new(&mut *self.io).poll_write(self.cx, buf) {
            Poll::Ready(r) => r,
            Poll::Pending => Err(io::ErrorKind::WouldBlock.into()),
        }
    }

    fn write_vectored(&mut self, bufs: &[io::IoSlice<'_>]) -> io::Result<usize> {
        match Pin::new(&mut *self.io).poll_write_vectored(self.cx, bufs) {
            Poll::Ready(r) => r,
            Poll::Pending => Err(io::ErrorKind::WouldBlock.into()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match Pin::new(&mut *self.io).poll_flush(self.cx) {
            Poll::Ready(r) => r,
            Poll::Pending => Err(io::ErrorKind::WouldBlock.into()),
        }
    }
}

impl<IO, C, SD> TlsStream<IO, C>
where
    IO: AsyncRead + AsyncWrite + Unpin,
    C: DerefMut + Deref<Target = ConnectionCommon<SD>>,
    SD: SideData,
{
    fn new(io: IO, conn: C) -> Self {
        Self { io, conn, read_closed: false, write_closed: false }
    }

    /// The rustls connection (negotiated parameters).
    pub fn connection(&self) -> &C {
        &self.conn
    }

    /// Reads TLS records from the transport; `0` at EOF.
    fn read_io(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        let n = match self.conn.read_tls(&mut SyncRead { io: &mut self.io, cx }) {
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Poll::Pending,
            Err(e) => return Poll::Ready(Err(e)),
        };
        if let Err(err) = self.conn.process_new_packets() {
            // best effort: deliver the alert
            let _ = self.write_io(cx);
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::InvalidData, err)));
        }
        Poll::Ready(Ok(n))
    }

    fn write_io(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        match self.conn.write_tls(&mut SyncWrite { io: &mut self.io, cx }) {
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => Poll::Pending,
            r => Poll::Ready(r),
        }
    }

    /// Writes all pending TLS data and flushes the transport.
    fn poll_flush_tls(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        while self.conn.wants_write() {
            if ready!(self.write_io(cx))? == 0 {
                return Poll::Ready(Err(io::ErrorKind::WriteZero.into()));
            }
        }
        Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_handshake(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        loop {
            ready!(self.poll_flush_tls(cx))?;
            if !self.conn.is_handshaking() {
                return Poll::Ready(Ok(()));
            }
            if ready!(self.read_io(cx))? == 0 {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "tls handshake eof",
                )));
            }
        }
    }

    async fn handshake(mut self) -> io::Result<Self> {
        poll_fn(|cx| self.poll_handshake(cx)).await?;
        Ok(self)
    }
}

impl<IO, C, SD> AsyncRead for TlsStream<IO, C>
where
    IO: AsyncRead + AsyncWrite + Unpin,
    C: DerefMut + Deref<Target = ConnectionCommon<SD>> + Unpin,
    SD: SideData,
{
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.read_closed || buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        loop {
            match this.conn.reader().read(buf.initialize_unfilled()) {
                Ok(0) => {
                    // close_notify received
                    this.read_closed = true;
                    return Poll::Ready(Ok(()));
                }
                Ok(n) => {
                    buf.advance(n);
                    return Poll::Ready(Ok(()));
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) => {
                    this.read_closed = true;
                    return Poll::Ready(Err(e));
                }
            }
            // `0` (EOF) is recorded by rustls; the reader reports it next round
            ready!(this.read_io(cx))?;
        }
    }
}

impl<IO, C, SD> AsyncWrite for TlsStream<IO, C>
where
    IO: AsyncRead + AsyncWrite + Unpin,
    C: DerefMut + Deref<Target = ConnectionCommon<SD>> + Unpin,
    SD: SideData,
{
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let mut pos = 0;
        while pos != buf.len() {
            let mut would_block = false;
            pos += this.conn.writer().write(&buf[pos..])?;
            while this.conn.wants_write() {
                match this.write_io(cx) {
                    Poll::Ready(Ok(0)) | Poll::Pending => {
                        would_block = true;
                        break;
                    }
                    Poll::Ready(Ok(_)) => {}
                    Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                }
            }
            match (pos, would_block) {
                (0, true) => return Poll::Pending,
                (n, true) => return Poll::Ready(Ok(n)),
                (_, false) => {}
            }
        }
        Poll::Ready(Ok(pos))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        this.conn.writer().flush()?;
        this.poll_flush_tls(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if !this.write_closed {
            this.conn.send_close_notify();
            this.write_closed = true;
        }
        while this.conn.wants_write() {
            if ready!(this.write_io(cx))? == 0 {
                return Poll::Ready(Err(io::ErrorKind::WriteZero.into()));
            }
        }
        Poll::Ready(match ready!(Pin::new(&mut this.io).poll_shutdown(cx)) {
            Err(e) if e.kind() == io::ErrorKind::NotConnected => Ok(()),
            r => r,
        })
    }
}

/// The server name for `host` (a DNS name or IP literal, IPv6 with or without brackets).
pub fn server_name(host: &str) -> io::Result<ServerName<'static>> {
    let bare = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        return Ok(ServerName::IpAddress(ip.into()));
    }
    ServerName::try_from(bare.to_string())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

/// Performs a client handshake.
pub async fn connect<IO>(
    config: Arc<rustls::ClientConfig>,
    name: ServerName<'static>,
    io: IO,
) -> io::Result<ClientTlsStream<IO>>
where
    IO: AsyncRead + AsyncWrite + Unpin,
{
    let conn = ClientConnection::new(config, name).map_err(io::Error::other)?;
    TlsStream::new(io, conn).handshake().await
}

/// Performs a server handshake with a fixed configuration.
pub async fn accept<IO>(
    config: Arc<rustls::ServerConfig>,
    io: IO,
) -> io::Result<ServerTlsStream<IO>>
where
    IO: AsyncRead + AsyncWrite + Unpin,
{
    let conn = ServerConnection::new(config).map_err(io::Error::other)?;
    TlsStream::new(io, conn).handshake().await
}

/// A server connection after the ClientHello (choose the config from it).
pub struct StartHandshake<IO> {
    accepted: Accepted,
    io: IO,
}

/// Reads the ClientHello (`LazyConfigAcceptor`).
pub async fn read_client_hello<IO>(mut io: IO) -> io::Result<StartHandshake<IO>>
where
    IO: AsyncRead + AsyncWrite + Unpin,
{
    let mut acceptor = Acceptor::default();
    loop {
        let n = poll_fn(|cx| match acceptor.read_tls(&mut SyncRead { io: &mut io, cx }) {
            Ok(n) => Poll::Ready(Ok(n)),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => Poll::Pending,
            Err(e) => Poll::Ready(Err(e)),
        })
        .await?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "tls handshake eof"));
        }
        match acceptor.accept() {
            Ok(Some(accepted)) => return Ok(StartHandshake { accepted, io }),
            Ok(None) => {}
            Err((err, mut alert)) => {
                let mut out = Vec::new();
                let _ = alert.write_all(&mut out);
                let _ = io.write_all(&out).await;
                return Err(io::Error::new(io::ErrorKind::InvalidData, err));
            }
        }
    }
}

impl<IO> StartHandshake<IO>
where
    IO: AsyncRead + AsyncWrite + Unpin,
{
    pub fn client_hello(&self) -> ClientHello<'_> {
        self.accepted.client_hello()
    }

    /// Completes the handshake with `config`.
    pub async fn into_stream(
        self,
        config: Arc<rustls::ServerConfig>,
    ) -> io::Result<ServerTlsStream<IO>> {
        let StartHandshake { accepted, mut io } = self;
        match accepted.into_connection(config) {
            Ok(conn) => TlsStream::new(io, conn).handshake().await,
            Err((err, mut alert)) => {
                let mut out = Vec::new();
                let _ = alert.write_all(&mut out);
                let _ = io.write_all(&out).await;
                Err(io::Error::new(io::ErrorKind::InvalidData, err))
            }
        }
    }
}

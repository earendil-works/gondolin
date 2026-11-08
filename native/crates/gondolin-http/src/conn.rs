//! Connection plumbing shared by server and client: the buffered read side,
//! incoming bodies, framed body writing and upgraded connections.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll, ready};

use bytes::{Buf, Bytes, BytesMut};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::sync::oneshot;

use crate::BoxError;
use crate::body::{Body, BoxBody, SizeHint};
use crate::decode::{CHUNKED_END, Decoded, Decoder, chunk_header};
use crate::head::Framing;

/// A bidirectional byte stream.
pub trait Io: AsyncRead + AsyncWrite + Send + Unpin + 'static {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin + 'static> Io for T {}

pub type BoxIo = Box<dyn Io>;
pub type BoxRead = Box<dyn AsyncRead + Send + Unpin>;
pub type BoxWrite = Box<dyn AsyncWrite + Send + Unpin>;

/// Read sizes: reserve this much when less than [`MIN_READ_SPACE`] is free
const READ_RESERVE: usize = 64 * 1024;
const MIN_READ_SPACE: usize = 8 * 1024;
/// Small writes are coalesced up to this many `bytes`
const COALESCE_BYTES: usize = 64 * 1024;

/// The buffered read side of a connection.
pub struct ReadSide {
    pub io: BoxRead,
    /// bytes read but not consumed yet
    pub buf: BytesMut,
}

impl ReadSide {
    pub fn new(io: BoxRead) -> Self {
        Self { io, buf: BytesMut::new() }
    }

    /// Reads more into the buffer; `0` at EOF.
    pub fn poll_fill(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        poll_read_buf(&mut self.io, cx, &mut self.buf)
    }

    pub async fn fill(&mut self) -> io::Result<usize> {
        std::future::poll_fn(|cx| self.poll_fill(cx)).await
    }
}

fn poll_read_buf<R: AsyncRead + Unpin + ?Sized>(
    io: &mut R,
    cx: &mut Context<'_>,
    buf: &mut BytesMut,
) -> Poll<io::Result<usize>> {
    if buf.capacity() - buf.len() < MIN_READ_SPACE {
        buf.reserve(READ_RESERVE);
    }
    let spare = buf.spare_capacity_mut();
    let mut rb = ReadBuf::uninit(spare);
    let ptr = rb.filled().as_ptr();
    ready!(Pin::new(io).poll_read(cx, &mut rb))?;
    assert_eq!(ptr, rb.filled().as_ptr(), "reader swapped the read buffer");
    let n = rb.filled().len();
    // SAFETY: the reader initialized the first `n` bytes of the spare capacity
    unsafe { buf.set_len(buf.len() + n) };
    Poll::Ready(Ok(n))
}

type OnDone = Box<dyn FnOnce(ReadSide) + Send>;

/// An incoming message body read from a connection. When the body ends, the
/// read side is handed to the completion callback (connection reuse).
pub struct Incoming {
    inner: Option<Box<Inner>>,
}

struct Inner {
    read: Option<ReadSide>,
    decoder: Decoder,
    on_done: Option<OnDone>,
    /// asks the server to send `100 Continue` before the first read
    continue_tx: Option<oneshot::Sender<oneshot::Sender<()>>>,
    continue_wait: Option<oneshot::Receiver<()>>,
}

impl Inner {
    fn finish(&mut self) {
        if let (Some(read), Some(done)) = (self.read.take(), self.on_done.take()) {
            done(read);
        }
    }
}

impl Incoming {
    pub fn empty() -> Self {
        Self { inner: None }
    }

    pub(crate) fn new(
        read: ReadSide,
        framing: Framing,
        on_done: Option<OnDone>,
        continue_tx: Option<oneshot::Sender<oneshot::Sender<()>>>,
    ) -> Self {
        Self {
            inner: Some(Box::new(Inner {
                read: Some(read),
                decoder: Decoder::new(framing),
                on_done,
                continue_tx,
                continue_wait: None,
            })),
        }
    }

    pub fn boxed(self) -> BoxBody {
        BoxBody::new(self)
    }
}

impl std::fmt::Debug for Incoming {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Incoming")
    }
}

impl Body for Incoming {
    fn poll_data(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Bytes, BoxError>>> {
        let Some(inner) = self.inner.as_deref_mut() else {
            return Poll::Ready(None);
        };
        if let Some(tx) = inner.continue_tx.take() {
            let (ack, wait) = oneshot::channel();
            if tx.send(ack).is_ok() {
                inner.continue_wait = Some(wait);
            }
        }
        if let Some(wait) = inner.continue_wait.as_mut() {
            let _ = ready!(Pin::new(wait).poll(cx));
            inner.continue_wait = None;
        }
        loop {
            let Some(read) = inner.read.as_mut() else {
                return Poll::Ready(None);
            };
            match inner.decoder.decode(&mut read.buf) {
                Ok(Decoded::Data(data)) => {
                    if inner.decoder.is_done() {
                        inner.finish();
                    }
                    return Poll::Ready(Some(Ok(data)));
                }
                Ok(Decoded::Done) => {
                    inner.finish();
                    return Poll::Ready(None);
                }
                Ok(Decoded::NeedMore) => {}
                Err(e) => {
                    inner.read = None;
                    return Poll::Ready(Some(Err(Box::new(e))));
                }
            }
            match ready!(read.poll_fill(cx)) {
                Ok(0) => {
                    if let Err(e) = inner.decoder.eof() {
                        inner.read = None;
                        return Poll::Ready(Some(Err(Box::new(e))));
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    inner.read = None;
                    return Poll::Ready(Some(Err(Box::new(e))));
                }
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        match &self.inner {
            None => true,
            Some(inner) => inner.decoder.is_done(),
        }
    }

    fn size_hint(&self) -> SizeHint {
        match &self.inner {
            None => SizeHint::exact(0),
            Some(inner) => match inner.decoder.remaining() {
                Some(n) => SizeHint::exact(n),
                None => SizeHint::default(),
            },
        }
    }
}

use std::future::Future as _;

/// Failure writing a message body.
#[derive(Debug)]
pub enum WriteError {
    Io(io::Error),
    /// the body failed
    Body(BoxError),
    /// the body did not match its declared length
    Length,
}

impl From<io::Error> for WriteError {
    fn from(e: io::Error) -> Self {
        WriteError::Io(e)
    }
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteError::Io(e) => write!(f, "write failed: {e}"),
            WriteError::Body(e) => write!(f, "body failed: {e}"),
            WriteError::Length => f.write_str("body length does not match content-length"),
        }
    }
}

impl std::error::Error for WriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            WriteError::Io(e) => Some(e),
            WriteError::Body(e) => Some(e.as_ref()),
            WriteError::Length => None,
        }
    }
}

async fn put<W: AsyncWrite + Unpin + ?Sized>(
    wr: &mut W,
    out: &mut Vec<u8>,
    data: &[u8],
) -> io::Result<()> {
    if out.len() + data.len() <= COALESCE_BYTES {
        out.extend_from_slice(data);
        return Ok(());
    }
    if !out.is_empty() {
        wr.write_all(out).await?;
        out.clear();
    }
    wr.write_all(data).await
}

/// Writes `out` (a head) followed by `body` framed per `framing`, then
/// flushes. Small writes are coalesced; pending writes are flushed whenever
/// the body has no data ready. A length-delimited body is not polled past its
/// length.
pub async fn write_message<W: AsyncWrite + Unpin + ?Sized>(
    wr: &mut W,
    mut out: Vec<u8>,
    body: &mut BoxBody,
    framing: Framing,
) -> Result<(), WriteError> {
    let mut left = match framing {
        Framing::Length(n) => Some(n),
        _ => None,
    };
    if left == Some(0) {
        wr.write_all(&out).await?;
        wr.flush().await?;
        return Ok(());
    }
    loop {
        let ready = std::future::poll_fn(|cx| {
            Poll::Ready(match Pin::new(&mut *body).poll_data(cx) {
                Poll::Ready(next) => Some(next),
                Poll::Pending => None,
            })
        })
        .await;
        let next = match ready {
            Some(next) => next,
            None => {
                if !out.is_empty() {
                    wr.write_all(&out).await?;
                    out.clear();
                }
                wr.flush().await?;
                body.data().await
            }
        };
        match next {
            None => {
                if framing == Framing::Chunked {
                    out.extend_from_slice(CHUNKED_END);
                }
                wr.write_all(&out).await?;
                wr.flush().await?;
                if left.is_some_and(|l| l > 0) {
                    return Err(WriteError::Length);
                }
                return Ok(());
            }
            Some(Err(e)) => {
                let _ = wr.write_all(&out).await;
                let _ = wr.flush().await;
                return Err(WriteError::Body(e));
            }
            Some(Ok(mut data)) => {
                if data.is_empty() {
                    continue;
                }
                let mut over = false;
                if let Some(l) = left.as_mut() {
                    if data.len() as u64 > *l {
                        data.truncate(*l as usize);
                        over = true;
                    }
                    *l -= data.len() as u64;
                }
                if framing == Framing::Chunked {
                    out.extend_from_slice(&chunk_header(data.len()));
                    put(wr, &mut out, &data).await?;
                    out.extend_from_slice(b"\r\n");
                } else {
                    put(wr, &mut out, &data).await?;
                }
                if over || left == Some(0) {
                    wr.write_all(&out).await?;
                    wr.flush().await?;
                    return if over { Err(WriteError::Length) } else { Ok(()) };
                }
            }
        }
    }
}

/// A connection taken over after `101 Switching Protocols`: bytes the HTTP
/// layer already read come first.
pub struct Upgraded {
    prefix: Bytes,
    read: BoxRead,
    write: BoxWrite,
}

impl Upgraded {
    pub(crate) fn new(read: ReadSide, write: BoxWrite) -> Self {
        Self { prefix: read.buf.freeze(), read: read.io, write }
    }
}

impl AsyncRead for Upgraded {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if !self.prefix.is_empty() {
            let n = self.prefix.len().min(buf.remaining());
            buf.put_slice(&self.prefix[..n]);
            self.prefix.advance(n);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.read).poll_read(cx, buf)
    }
}

impl AsyncWrite for Upgraded {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.write).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.write).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.write).poll_shutdown(cx)
    }
}

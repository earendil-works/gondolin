//! Transports whose writes never wait for the peer.
//!
//! russh's session loop stops reading while it writes to its stream. Two such
//! loops writing bulk data at each other (our upstream client and an upstream
//! server that works the same way, or our guest-facing server and a russh
//! guest) both block in `write` once the socket buffers are full, and neither
//! reads again: a deadlock. Under each session we put a [`Pumped`] stream:
//! writes land in a buffer and a task drains it into the socket, so the loop
//! always gets back to reading. What sits in the buffer is bounded by the SSH
//! windows the peer granted (it only grants what it has read), plus small
//! control messages; [`HIGH_WATER`] is a backstop.

use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf, ReadHalf};
use tokio::sync::Notify;

/// Buffered bytes in `bytes` above which writes wait for the pump.
pub(crate) const HIGH_WATER: usize = 16 << 20;
/// How long the pump keeps flushing after the stream was dropped.
const LINGER: Duration = Duration::from_secs(10);

#[derive(Default)]
struct State {
    buf: Vec<u8>,
    /// the pump stopped on a write error (kind and message)
    error: Option<(io::ErrorKind, String)>,
    /// shutdown requested: flush, then shut the write side down
    shutdown: bool,
    /// the stream was dropped: flush (within [`LINGER`]) and stop
    dropped: bool,
    /// a writer waiting for the buffer to drain below [`HIGH_WATER`]
    writer: Option<Waker>,
}

struct Shared {
    state: Mutex<State>,
    /// wakes the pump (data, shutdown, drop)
    wake: Notify,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Reads from the stream directly; writes go through the pump task.
pub(crate) struct Pumped<S> {
    read: ReadHalf<S>,
    shared: Arc<Shared>,
}

impl<S> Pumped<S>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    /// Splits `stream` and spawns its pump (needs a tokio runtime).
    pub(crate) fn new(stream: S) -> Self {
        let (read, mut write) = tokio::io::split(stream);
        let shared = Arc::new(Shared { state: Mutex::new(State::default()), wake: Notify::new() });
        let pump = shared.clone();
        tokio::spawn(async move {
            let mut chunk = Vec::new();
            loop {
                let notified = pump.wake.notified();
                let (shutdown, dropped) = {
                    let mut st = pump.lock();
                    std::mem::swap(&mut chunk, &mut st.buf);
                    if let Some(w) = st.writer.take() {
                        w.wake();
                    }
                    (st.shutdown, st.dropped)
                };
                if chunk.is_empty() {
                    if shutdown || dropped {
                        let _ = write.shutdown().await;
                        return;
                    }
                    notified.await;
                    continue;
                }
                let result = if dropped {
                    match tokio::time::timeout(LINGER, write.write_all(&chunk)).await {
                        Ok(r) => r,
                        Err(_) => return,
                    }
                } else {
                    write.write_all(&chunk).await
                };
                chunk.clear();
                if let Err(e) = result {
                    let mut st = pump.lock();
                    st.error = Some((e.kind(), e.to_string()));
                    st.buf = Vec::new();
                    if let Some(w) = st.writer.take() {
                        w.wake();
                    }
                    return;
                }
            }
        });
        Pumped { read, shared }
    }
}

impl<S> Drop for Pumped<S> {
    fn drop(&mut self) {
        self.shared.lock().dropped = true;
        self.shared.wake.notify_one();
    }
}

fn pump_error(e: &(io::ErrorKind, String)) -> io::Error {
    io::Error::new(e.0, e.1.clone())
}

impl<S: AsyncRead + AsyncWrite> AsyncRead for Pumped<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.read).poll_read(cx, buf)
    }
}

impl<S> AsyncWrite for Pumped<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        let mut st = self.shared.lock();
        if let Some(e) = &st.error {
            return Poll::Ready(Err(pump_error(e)));
        }
        if st.shutdown {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        if st.buf.len() >= HIGH_WATER {
            st.writer = Some(cx.waker().clone());
            return Poll::Pending;
        }
        let was_empty = st.buf.is_empty();
        st.buf.extend_from_slice(data);
        drop(st);
        if was_empty {
            self.shared.wake.notify_one();
        }
        Poll::Ready(Ok(data.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // Handed to the pump: that is as flushed as the session needs.
        match &self.shared.lock().error {
            Some(e) => Poll::Ready(Err(pump_error(e))),
            None => Poll::Ready(Ok(())),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.shared.lock().shutdown = true;
        self.shared.wake.notify_one();
        Poll::Ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn writes_do_not_wait_for_the_reader() {
        // A 1 KiB pipe: a direct 1 MiB write would block until the peer reads.
        let (a, mut b) = tokio::io::duplex(1024);
        let mut pumped = Pumped::new(a);
        let data: Vec<u8> = (0..1 << 20).map(|i| i as u8).collect();
        tokio::time::timeout(Duration::from_secs(1), pumped.write_all(&data))
            .await
            .expect("write returned without the peer reading")
            .unwrap();
        pumped.flush().await.unwrap();
        pumped.shutdown().await.unwrap();
        let mut got = Vec::new();
        b.read_to_end(&mut got).await.unwrap();
        assert!(got == data);
    }

    #[tokio::test]
    async fn data_written_before_drop_is_delivered() {
        let (a, mut b) = tokio::io::duplex(1024);
        let mut pumped = Pumped::new(a);
        pumped.write_all(&[7u8; 100_000]).await.unwrap();
        drop(pumped);
        let mut got = Vec::new();
        b.read_to_end(&mut got).await.unwrap();
        assert_eq!(got.len(), 100_000);
    }

    #[tokio::test]
    async fn write_errors_surface() {
        let (a, b) = tokio::io::duplex(16);
        drop(b);
        let mut pumped = Pumped::new(a);
        let _ = pumped.write_all(b"hello").await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(pumped.write_all(b"again").await.is_err());
    }
}

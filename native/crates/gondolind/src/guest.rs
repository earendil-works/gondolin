//! Guest channels: the unix sockets QEMU's virtio-serial chardevs connect to
//! (`server=off`, QEMU is the client), with the queueing semantics of the
//! node engine's `VirtioBridge`:
//!
//! - frames are queued whole in an [`Outbox`]; `send` fails (returns `false`)
//!   when the queue already holds data and the frame would exceed its limit;
//!   frames sent while the guest is not connected wait in the queue;
//! - the owner is notified whenever queued data was written ("writable");
//! - a new connection replaces the previous one (QEMU restart);
//! - oversized or undecodable incoming frames disconnect the channel.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

struct OutboxState {
    queue: VecDeque<Vec<u8>>,
    /// queued bytes including the frame currently being written
    bytes: usize,
    closed: bool,
}

/// Outgoing frame queue of one guest channel.
pub struct Outbox {
    state: Mutex<OutboxState>,
    max_bytes: usize,
    wake: Notify,
    on_writable: Box<dyn Fn() + Send + Sync>,
}

impl Outbox {
    /// `on_writable` is called after queued data was written to the guest.
    pub fn new(max_bytes: usize, on_writable: impl Fn() + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Outbox {
            state: Mutex::new(OutboxState { queue: VecDeque::new(), bytes: 0, closed: false }),
            max_bytes,
            wake: Notify::new(),
            on_writable: Box::new(on_writable),
        })
    }

    /// Queues a framed message; `false` when the queue is full or closed.
    pub fn send_frame(&self, frame: Vec<u8>) -> bool {
        let mut st = self.state.lock().unwrap();
        if st.closed {
            return false;
        }
        if st.bytes > 0 && st.bytes + frame.len() > self.max_bytes {
            return false;
        }
        st.bytes += frame.len();
        st.queue.push_back(frame);
        drop(st);
        self.wake.notify_one();
        true
    }

    /// Encodes and queues `value` as one frame.
    pub fn send<T: gondolin_wire::ToValue + ?Sized>(&self, value: &T) -> bool {
        match gondolin_wire::encode(value).and_then(|p| gondolin_wire::frame(&p)) {
            Ok(frame) => self.send_frame(frame),
            Err(err) => {
                eprintln!("gondolind: cannot encode guest frame: {err}");
                false
            }
        }
    }

    /// Queued bytes not yet written.
    pub fn pending_bytes(&self) -> usize {
        self.state.lock().unwrap().bytes
    }

    /// Takes all queued frames, decoded (tests).
    #[cfg(test)]
    pub fn take_frames(&self) -> Vec<gondolin_wire::Value> {
        let mut st = self.state.lock().unwrap();
        st.bytes = 0;
        st.queue.drain(..).map(|f| gondolin_wire::decode(&f[4..]).unwrap()).collect()
    }

    /// Drops queued frames and refuses new ones.
    pub fn close(&self) {
        let mut st = self.state.lock().unwrap();
        st.closed = true;
        st.queue.clear();
        st.bytes = 0;
        drop(st);
        self.wake.notify_one();
    }

    async fn next_frame(&self) -> Option<Vec<u8>> {
        loop {
            let notified = self.wake.notified();
            {
                let mut st = self.state.lock().unwrap();
                if st.closed {
                    return None;
                }
                if let Some(frame) = st.queue.pop_front() {
                    return Some(frame);
                }
            }
            notified.await;
        }
    }

    fn written(&self, len: usize) {
        {
            let mut st = self.state.lock().unwrap();
            st.bytes = st.bytes.saturating_sub(len);
        }
        (self.on_writable)();
    }
}

/// Receives what a guest channel delivers.
pub trait PortHandler: Send + Sync + 'static {
    /// One complete incoming frame. An error disconnects the channel.
    fn frame<'a>(&'a self, frame: Bytes) -> crate::BoxFuture<'a, Result<(), String>>;
    /// A framing or decoding error (the channel is disconnected afterwards).
    fn error(&self, message: String);
    /// The guest side connected (QEMU started).
    fn connected(&self) {}
    /// The guest side went away (read EOF or error; not called when a new
    /// connection replaces the current one, see [`PortHandler::connected`]).
    fn disconnected(&self) {}
}

/// Aborts the task when dropped.
pub struct AbortOnDrop(pub JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// A listening guest channel.
pub struct GuestPort {
    pub name: &'static str,
    pub path: PathBuf,
    pub outbox: Arc<Outbox>,
    accept_task: JoinHandle<()>,
}

impl GuestPort {
    /// Binds `path` and serves connections until dropped/closed.
    pub fn listen(
        name: &'static str,
        path: &Path,
        outbox: Arc<Outbox>,
        handler: Arc<dyn PortHandler>,
    ) -> std::io::Result<Self> {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path)?;
        let task_outbox = outbox.clone();
        let accept_task = tokio::spawn(async move {
            // aborted with the accept task (dropping a JoinHandle would detach it)
            let mut current: Option<AbortOnDrop> = None;
            loop {
                let stream = match listener.accept().await {
                    Ok((stream, _)) => stream,
                    Err(err) => {
                        handler.error(format!("accept failed: {err}"));
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        continue;
                    }
                };
                drop(current.take());
                crate::timing::mark(format!("guest connected: {name}"));
                handler.connected();
                current = Some(AbortOnDrop(tokio::spawn(serve_connection(
                    stream,
                    task_outbox.clone(),
                    handler.clone(),
                ))));
            }
        });
        Ok(GuestPort { name, path: path.to_path_buf(), outbox, accept_task })
    }

    /// Stops listening and drops the connection and queued frames.
    pub fn close(&self) {
        self.accept_task.abort();
        self.outbox.close();
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Drop for GuestPort {
    fn drop(&mut self) {
        self.close();
    }
}

async fn serve_connection(stream: UnixStream, outbox: Arc<Outbox>, handler: Arc<dyn PortHandler>) {
    let (read, mut write) = stream.into_split();
    let reader = async {
        let mut read = tokio::io::BufReader::with_capacity(64 * 1024, read);
        loop {
            match read_guest_frame(&mut read).await {
                Ok(Some(frame)) => {
                    // one frame at a time: the fs channel relies on requests
                    // being handled in order (see `FsPortHandler`)
                    // a panicking handler costs this connection, not the daemon
                    match crate::panics::CatchUnwind::new(handler.frame(frame)).await {
                        Ok(Ok(())) => {}
                        Ok(Err(err)) => {
                            handler.error(err);
                            return;
                        }
                        Err(panic) => {
                            handler.error(format!("internal error: {panic}"));
                            return;
                        }
                    }
                }
                Ok(None) => return,
                Err(err) => {
                    handler.error(err);
                    return;
                }
            }
        }
    };
    let writer = async {
        while let Some(frame) = outbox.next_frame().await {
            let len = frame.len();
            let res = write.write_all(&frame).await;
            outbox.written(len);
            res?;
        }
        Ok::<(), std::io::Error>(())
    };
    if let crate::util::Either::Right(Err(err)) = crate::util::select2(reader, writer).await
        && err.kind() != std::io::ErrorKind::BrokenPipe
    {
        handler.error(err.to_string());
    }
    handler.disconnected();
}

/// Reads one frame; `None` on EOF (also inside a frame, which only happens
/// when the peer goes away). An oversized length is an error, like the node
/// engine's `FrameReader`.
async fn read_guest_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<Bytes>, String> {
    let mut header = [0u8; 4];
    match r.read_exact(&mut header).await {
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err.to_string()),
    }
    let len = u32::from_be_bytes(header) as usize;
    if len > gondolin_wire::MAX_FRAME {
        return Err(format!("Frame too large: {len}"));
    }
    let mut buf = vec![0u8; len];
    match r.read_exact(&mut buf).await {
        Ok(_) => Ok(Some(Bytes::from(buf))),
        Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// Handler that accepts a connection and ignores everything (channels whose
/// host side is not implemented yet; QEMU needs someone to connect to).
pub struct DiscardHandler;

impl PortHandler for DiscardHandler {
    fn frame<'a>(&'a self, _frame: Bytes) -> crate::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }
    fn error(&self, _message: String) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::mpsc;

    struct Collect(mpsc::UnboundedSender<Result<Bytes, String>>);

    impl PortHandler for Collect {
        fn frame<'a>(&'a self, frame: Bytes) -> crate::BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                let _ = self.0.send(Ok(frame));
                Ok(())
            })
        }
        fn error(&self, message: String) {
            let _ = self.0.send(Err(message));
        }
    }

    #[test]
    fn outbox_limits() {
        let writable = Arc::new(AtomicUsize::new(0));
        let w = writable.clone();
        let outbox = Outbox::new(10, move || {
            w.fetch_add(1, Ordering::Relaxed);
        });
        // the first frame is always accepted, even when larger than the limit
        assert!(outbox.send_frame(vec![0; 20]));
        assert!(!outbox.send_frame(vec![0; 1]));
        outbox.written(20);
        outbox.state.lock().unwrap().queue.clear();
        assert!(outbox.send_frame(vec![0; 6]));
        assert!(outbox.send_frame(vec![0; 4]));
        assert!(!outbox.send_frame(vec![0; 1]));
        assert_eq!(writable.load(Ordering::Relaxed), 1);
        outbox.close();
        assert!(!outbox.send_frame(vec![0; 1]));
    }

    #[tokio::test]
    async fn queues_until_connected_and_reconnects() {
        crate::test_timeout(async {
            let dir = std::env::temp_dir().join(format!("gondolind-test-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("port.sock");
            let outbox = Outbox::new(1 << 20, || {});
            let (tx, mut rx) = mpsc::unbounded_channel();
            let port =
                GuestPort::listen("test", &path, outbox.clone(), Arc::new(Collect(tx))).unwrap();

            assert!(outbox.send_frame(gondolin_wire::frame(b"early").unwrap()));
            let mut a = UnixStream::connect(&path).await.unwrap();
            let mut buf = [0u8; 9];
            tokio::io::AsyncReadExt::read_exact(&mut a, &mut buf).await.unwrap();
            assert_eq!(&buf[4..], b"early");

            a.write_all(&gondolin_wire::frame(b"hi").unwrap()).await.unwrap();
            assert_eq!(&rx.recv().await.unwrap().unwrap()[..], b"hi");

            // oversized frame disconnects
            a.write_all(&(gondolin_wire::MAX_FRAME as u32 + 1).to_be_bytes()).await.unwrap();
            assert_eq!(
                rx.recv().await.unwrap().unwrap_err(),
                format!("Frame too large: {}", gondolin_wire::MAX_FRAME + 1)
            );

            // a new connection takes over
            let mut b = UnixStream::connect(&path).await.unwrap();
            assert!(outbox.send_frame(gondolin_wire::frame(b"later").unwrap()));
            let mut buf = [0u8; 9];
            tokio::io::AsyncReadExt::read_exact(&mut b, &mut buf).await.unwrap();
            assert_eq!(&buf[4..], b"later");
            port.close();
            let _ = std::fs::remove_dir_all(&dir);
        })
        .await;
    }
}

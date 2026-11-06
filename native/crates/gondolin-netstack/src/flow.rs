//! [`TcpFlow`] streams backed by smoltcp sockets inside the stack state.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use smoltcp::socket::tcp;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::stack::{Entry, FlowKey, Phase, READ_HOLD, Shared, State};
use crate::{FlowAbort, FlowControl, FlowMeta, TcpFlow};

pub(crate) fn new_flow(shared: Arc<Shared>, session: u64, key: FlowKey, meta: FlowMeta) -> TcpFlow {
    let id = meta.id;
    let control =
        FlowControl::new(Arc::new(StackAbort { shared: shared.clone(), session, key, id }));
    TcpFlow { meta, stream: Box::pin(NetTcpStream { shared, session, key, id }), control }
}

/// Outcome of looking up the socket of a flow.
enum Lookup<'a> {
    Live(&'a mut Entry),
    Aborted,
    Gone,
}

fn lookup<'a>(st: &'a mut State, session: u64, key: FlowKey, id: u64) -> Lookup<'a> {
    if !st.running || st.session != session {
        return Lookup::Gone;
    }
    match st.entries.get_mut(&key) {
        Some(entry) if matches!(entry.phase, Phase::Open { id: open } if open == id) => {
            if entry.aborted {
                return Lookup::Aborted;
            }
            Lookup::Live(entry)
        }
        _ => Lookup::Gone,
    }
}

/// Guest TCP connection as an `AsyncRead + AsyncWrite` stream.
pub(crate) struct NetTcpStream {
    shared: Arc<Shared>,
    session: u64,
    key: FlowKey,
    id: u64,
}

fn aborted() -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionAborted, "flow aborted")
}

impl AsyncRead for NetTcpStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let mut st = this.shared.lock();
        let entry = match lookup(&mut st, this.session, this.key, this.id) {
            Lookup::Live(entry) => entry,
            Lookup::Aborted | Lookup::Gone => return Poll::Ready(Err(aborted())),
        };
        let push = entry.push;
        let socket = entry.socket();
        let queued = socket.recv_queue();
        if queued > 0 && queued < this.shared.read_hold_bytes && !push && socket.may_recv() {
            // More of the guest's write is on its way: wait for it (READ_HOLD).
            entry.read_waker = Some(cx.waker().clone());
            if entry.read_deadline.is_none() {
                let deadline = Instant::now() + READ_HOLD;
                entry.read_deadline = Some(deadline);
                st.schedule(this.key, deadline);
                if st.ticker_late() {
                    drop(st);
                    this.shared.poll_notify.notify_one();
                }
            }
            return Poll::Pending;
        }
        let mut read = 0;
        while buf.remaining() > 0 {
            let result = socket.recv(|data| {
                let n = data.len().min(buf.remaining());
                buf.put_slice(&data[..n]);
                (n, n)
            });
            match result {
                Ok(0) => break,
                Ok(n) => read += n,
                Err(tcp::RecvError::Finished) => {
                    if read == 0 {
                        return Poll::Ready(Ok(()));
                    }
                    break;
                }
                Err(tcp::RecvError::InvalidState) => {
                    if read == 0 {
                        return Poll::Ready(Err(io::Error::new(
                            io::ErrorKind::ConnectionReset,
                            "guest reset the connection",
                        )));
                    }
                    break;
                }
            }
        }
        if read > 0 {
            if socket.recv_queue() == 0 {
                entry.push = false;
            }
            entry.read_waker = None;
            entry.read_deadline = None;
            // Freed receive space may warrant a window update.
            st.mark_dirty(this.key);
            drop(st);
            this.shared.poll_notify.notify_one();
            return Poll::Ready(Ok(()));
        }
        socket.register_recv_waker(cx.waker());
        Poll::Pending
    }
}

impl AsyncWrite for NetTcpStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let mut st = this.shared.lock();
        let socket = match lookup(&mut st, this.session, this.key, this.id) {
            Lookup::Live(entry) => entry.socket(),
            Lookup::Aborted | Lookup::Gone => return Poll::Ready(Err(aborted())),
        };
        if data.is_empty() {
            return Poll::Ready(Ok(0));
        }
        if !socket.may_send() {
            let kind = if socket.state() == tcp::State::Closed {
                io::ErrorKind::ConnectionReset
            } else {
                io::ErrorKind::BrokenPipe
            };
            return Poll::Ready(Err(io::Error::new(kind, "connection cannot send")));
        }
        match socket.send_slice(data) {
            Ok(0) => {
                socket.register_send_waker(cx.waker());
                Poll::Pending
            }
            Ok(n) => {
                st.mark_dirty(this.key);
                drop(st);
                this.shared.poll_notify.notify_one();
                Poll::Ready(Ok(n))
            }
            Err(_) => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "connection cannot send",
            ))),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let mut st = this.shared.lock();
        match lookup(&mut st, this.session, this.key, this.id) {
            Lookup::Live(entry) => entry.socket().close(),
            Lookup::Aborted | Lookup::Gone => return Poll::Ready(Err(aborted())),
        }
        st.mark_dirty(this.key);
        drop(st);
        this.shared.poll_notify.notify_one();
        Poll::Ready(Ok(()))
    }
}

impl Drop for NetTcpStream {
    fn drop(&mut self) {
        let mut st = self.shared.lock();
        let linger = Duration::from_millis(self.shared_linger_ms());
        let socket = match lookup(&mut st, self.session, self.key, self.id) {
            Lookup::Live(entry) => {
                let socket = entry.socket();
                if socket.recv_queue() > 0 || std::thread::panicking() {
                    // Unread guest data: reset like a Linux socket would.
                    // Dropped while a flow handler panics: reset too, the
                    // guest must not mistake the end for a clean close.
                    socket.abort();
                } else {
                    socket.close();
                }
                true
            }
            Lookup::Aborted => true,
            Lookup::Gone => false,
        };
        if socket && let Some(entry) = st.entries.get_mut(&self.key) {
            entry.phase = Phase::Orphan { deadline: Instant::now() + linger };
            st.mark_dirty(self.key);
        }
        drop(st);
        self.shared.poll_notify.notify_one();
    }
}

impl NetTcpStream {
    fn shared_linger_ms(&self) -> u64 {
        self.shared.linger_ms()
    }
}

struct StackAbort {
    shared: Arc<Shared>,
    session: u64,
    key: FlowKey,
    id: u64,
}

impl FlowAbort for StackAbort {
    fn abort(&self) {
        let mut st = self.shared.lock();
        if let Lookup::Live(entry) = lookup(&mut st, self.session, self.key, self.id) {
            entry.socket().abort();
            entry.aborted = true;
            // a read held for a push sees the abort now
            entry.wake_reader();
            st.mark_dirty(self.key);
            drop(st);
            self.shared.poll_notify.notify_one();
        }
    }
}

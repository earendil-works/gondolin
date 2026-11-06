//! [`TcpFlow`] streams backed by smoltcp sockets inside the stack state.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use smoltcp::iface::SocketHandle;
use smoltcp::socket::tcp;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::stack::{Phase, Shared, State};
use crate::{FlowAbort, FlowControl, FlowMeta, TcpFlow};

pub(crate) fn new_flow(
    shared: Arc<Shared>,
    session: u64,
    handle: SocketHandle,
    meta: FlowMeta,
) -> TcpFlow {
    let id = meta.id;
    let control =
        FlowControl::new(Arc::new(StackAbort { shared: shared.clone(), session, handle, id }));
    TcpFlow { meta, stream: Box::pin(NetTcpStream { shared, session, handle, id }), control }
}

/// Outcome of looking up the socket of a flow.
enum Lookup<'a> {
    Live(&'a mut tcp::Socket<'static>),
    Aborted,
    Gone,
}

fn lookup<'a>(st: &'a mut State, session: u64, handle: SocketHandle, id: u64) -> Lookup<'a> {
    if !st.running || st.session != session {
        return Lookup::Gone;
    }
    match st.entries.get(&handle) {
        Some(entry) if matches!(entry.phase, Phase::Open { id: open } if open == id) => {
            if entry.aborted {
                return Lookup::Aborted;
            }
        }
        _ => return Lookup::Gone,
    }
    Lookup::Live(st.sockets.get_mut::<tcp::Socket>(handle))
}

/// Guest TCP connection as an `AsyncRead + AsyncWrite` stream.
pub(crate) struct NetTcpStream {
    shared: Arc<Shared>,
    session: u64,
    handle: SocketHandle,
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
        let socket = match lookup(&mut st, this.session, this.handle, this.id) {
            Lookup::Live(socket) => socket,
            Lookup::Aborted | Lookup::Gone => return Poll::Ready(Err(aborted())),
        };
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
            drop(st);
            // Freed receive space may warrant a window update.
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
        let socket = match lookup(&mut st, this.session, this.handle, this.id) {
            Lookup::Live(socket) => socket,
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
        match lookup(&mut st, this.session, this.handle, this.id) {
            Lookup::Live(socket) => socket.close(),
            Lookup::Aborted | Lookup::Gone => return Poll::Ready(Err(aborted())),
        }
        drop(st);
        this.shared.poll_notify.notify_one();
        Poll::Ready(Ok(()))
    }
}

impl Drop for NetTcpStream {
    fn drop(&mut self) {
        let mut st = self.shared.lock();
        let linger = Duration::from_millis(self.shared_linger_ms());
        let socket = match lookup(&mut st, self.session, self.handle, self.id) {
            Lookup::Live(socket) => {
                if socket.recv_queue() > 0 {
                    // Unread guest data: reset like a Linux socket would.
                    socket.abort();
                } else {
                    socket.close();
                }
                true
            }
            Lookup::Aborted => true,
            Lookup::Gone => false,
        };
        if socket && let Some(entry) = st.entries.get_mut(&self.handle) {
            entry.phase = Phase::Orphan { deadline: Instant::now() + linger };
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
    handle: SocketHandle,
    id: u64,
}

impl FlowAbort for StackAbort {
    fn abort(&self) {
        let mut st = self.shared.lock();
        if let Lookup::Live(socket) = lookup(&mut st, self.session, self.handle, self.id) {
            socket.abort();
            if let Some(entry) = st.entries.get_mut(&self.handle) {
                entry.aborted = true;
            }
            drop(st);
            self.shared.poll_notify.notify_one();
        }
    }
}

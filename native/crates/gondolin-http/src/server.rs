//! HTTP/1.x server connection over any tokio stream.
//!
//! Requests are handled one at a time. The request body is read lazily by
//! whoever polls it (`100 Continue` is sent on its first poll while the
//! handler runs); responses are framed like hyper's server (HTTP/1.0 peers
//! get HTTP/1.0 responses and close-delimited bodies of unknown size). The
//! read side is not polled while a request is handled, so a peer's half close
//! does not abort it. After `101 Switching Protocols` the connection is handed
//! to the request's [`OnUpgrade`].

use std::future::Future;
use std::io;
use std::pin::{Pin, pin};
use std::task::{Context, Poll};

use bytes::Buf;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::oneshot;

use crate::Header;
use crate::body::BoxBody;
use crate::conn::{Incoming, ReadSide, Upgraded, write_message};
use crate::head::{
    Framing, HeadLimits, ParseError, RequestHead, RequestInfo, Version, encode_response,
    parse_request, request_info,
};

/// Server connection settings.
#[derive(Debug, Clone, Copy)]
pub struct ServerConfig {
    /// serve more than one request per connection
    pub keep_alive: bool,
    pub limits: HeadLimits,
}

/// An incoming request.
pub struct Request {
    pub head: RequestHead,
    pub info: RequestInfo,
    pub body: Incoming,
    /// set when the request asks for a protocol upgrade
    pub upgrade: Option<OnUpgrade>,
}

/// A response to send.
pub struct Response {
    pub status: u16,
    /// reason phrase; the canonical one when `None`
    pub reason: Option<Vec<u8>>,
    pub headers: Vec<Header>,
    pub body: BoxBody,
}

impl Response {
    pub fn new(status: u16, headers: Vec<Header>, body: BoxBody) -> Self {
        Self { status, reason: None, headers, body }
    }
}

/// Resolves to the connection once a `101` response was sent.
pub struct OnUpgrade(oneshot::Receiver<Upgraded>);

impl Future for OnUpgrade {
    type Output = io::Result<Upgraded>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0)
            .poll(cx)
            .map(|r| r.map_err(|_| io::Error::other("connection was not upgraded")))
    }
}

/// Serves HTTP/1.x on `io` until the connection ends. `on_error` builds the
/// response to a malformed request head (sent with `connection: close`).
pub async fn serve<IO, H, F, E>(io: IO, config: ServerConfig, mut handler: H, mut on_error: E)
where
    IO: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    H: FnMut(Request) -> F,
    F: Future<Output = Response>,
    E: FnMut(&ParseError) -> Response,
{
    let (rd, mut wr) = tokio::io::split(io);
    let mut read = ReadSide::new(Box::new(rd));
    loop {
        let parsed = loop {
            if !read.buf.is_empty() {
                match parse_request(&read.buf, &config.limits) {
                    Ok(Some((head, len))) => {
                        read.buf.advance(len);
                        break Ok(head);
                    }
                    Ok(None) => {}
                    Err(e) => break Err(e),
                }
            }
            match read.fill().await {
                Ok(0) | Err(_) => {
                    let _ = wr.shutdown().await;
                    return;
                }
                Ok(_) => {}
            }
        };
        let (mut head, info) = match parsed.and_then(|mut head| {
            let info = request_info(&mut head)?;
            Ok((head, info))
        }) {
            Ok(v) => v,
            Err(err) => {
                let response = on_error(&err);
                let _ = send_error(&mut wr, response).await;
                return;
            }
        };
        let version = head.version;
        let is_head = head.method == "HEAD";

        let (upgrade_tx, upgrade) = if info.wants_upgrade {
            let (tx, rx) = oneshot::channel();
            (Some(tx), Some(OnUpgrade(rx)))
        } else {
            (None, None)
        };
        let mut kept = None;
        let mut done_rx = None;
        let mut continue_rx = None;
        let body = if info.framing == Framing::Length(0) {
            kept = Some(read);
            Incoming::empty()
        } else {
            let (done_tx, rx) = oneshot::channel();
            done_rx = Some(rx);
            let continue_tx = if info.expect_continue {
                let (tx, rx) = oneshot::channel();
                continue_rx = Some(rx);
                Some(tx)
            } else {
                None
            };
            Incoming::new(
                read,
                info.framing,
                Some(Box::new(move |read| {
                    let _ = done_tx.send(read);
                })),
                continue_tx,
            )
        };
        head.headers.shrink_to_fit();

        let mut fut = pin!(handler(Request { head, info, body, upgrade }));
        let response = match continue_rx {
            Some(mut rx) => {
                // the handler first: a ready response needs no interim one
                let first = std::future::poll_fn(|cx| {
                    if let Poll::Ready(r) = fut.as_mut().poll(cx) {
                        return Poll::Ready(Ok(r));
                    }
                    Pin::new(&mut rx).poll(cx).map(Err)
                })
                .await;
                match first {
                    Ok(r) => r,
                    Err(ack) => {
                        if let Ok(ack) = ack
                            && wr.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await.is_ok()
                            && wr.flush().await.is_ok()
                        {
                            let _ = ack.send(());
                        }
                        fut.await
                    }
                }
            }
            None => fut.await,
        };

        let Response { mut status, reason, mut headers, mut body } = response;
        if (100..200).contains(&status) && status != 101 {
            // interim responses cannot be returned from a handler (hyper: 500)
            status = 500;
            headers.clear();
            body = BoxBody::empty();
        }
        let mut keep_alive = config.keep_alive && info.keep_alive;
        if version == Version::Http10 && keep_alive {
            let conn_keep_alive = headers.iter().any(|h| {
                h.name.eq_ignore_ascii_case("connection")
                    && h.value
                        .split(|&b| b == b',')
                        .any(|t| t.trim_ascii().eq_ignore_ascii_case(b"keep-alive"))
            });
            if !conn_keep_alive {
                headers.retain(|h| !h.name.eq_ignore_ascii_case("connection"));
                headers.push(Header::new("connection", "keep-alive"));
            }
        }
        let mut out = Vec::with_capacity(256);
        let length = if status == 101 { crate::head::BodyLength::Empty } else { body.length() };
        let enc = encode_response(
            &mut out,
            version,
            status,
            reason.as_deref(),
            &headers,
            is_head,
            length,
        );
        drop(headers);
        if enc.close || enc.framing == Framing::Close {
            keep_alive = false;
        }

        if status == 101 {
            let _ = wr.write_all(&out).await;
            let _ = wr.flush().await;
            if let (Some(tx), Some(read)) = (upgrade_tx, kept) {
                let _ = tx.send(Upgraded::new(read, Box::new(wr)));
            }
            return;
        }
        let res = write_message(&mut wr, out, &mut body, enc.framing).await;
        drop(body);
        if res.is_err() {
            return;
        }
        let next = match kept {
            Some(read) => Some(read),
            None => done_rx.and_then(|mut rx| rx.try_recv().ok()),
        };
        match next {
            Some(next) if keep_alive => read = next,
            _ => {
                let _ = wr.shutdown().await;
                return;
            }
        }
    }
}

async fn send_error<W: AsyncWrite + Unpin>(wr: &mut W, response: Response) -> io::Result<()> {
    let Response { status, reason, mut headers, mut body } = response;
    headers.retain(|h| !h.name.eq_ignore_ascii_case("connection"));
    headers.push(Header::new("connection", "close"));
    let mut out = Vec::new();
    let enc = encode_response(
        &mut out,
        Version::Http11,
        status,
        reason.as_deref(),
        &headers,
        false,
        body.length(),
    );
    let _ = write_message(wr, out, &mut body, enc.framing).await;
    wr.shutdown().await
}

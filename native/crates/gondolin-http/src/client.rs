//! HTTP/1.1 client: one request on a [`Connection`] ([`send`]) and a pooled
//! [`Client`] over a pluggable [`Connect`]or with optional TLS.
//!
//! The request body is written while the response head is awaited (an early
//! response is returned even if the upload is still running). Connections go
//! back to the pool once both the request body was written and the response
//! body was read to its end, unless either side asked to close.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::pin::{Pin, pin};
use std::sync::{Arc, Mutex, Weak};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Buf;
use tokio::io::{AsyncRead, ReadBuf};

use crate::body::BoxBody;
use crate::conn::{BoxIo, BoxWrite, Incoming, ReadSide, Upgraded, WriteError, write_message};
use crate::head::{
    BodyLength, Framing, HeadLimits, ParseError, ResponseHead, ResponseInfo, encode_request,
    parse_response, response_info,
};
use crate::{BoxError, Header};

/// An idle or fresh client connection.
pub struct Connection {
    read: ReadSide,
    write: BoxWrite,
}

impl Connection {
    pub fn new(io: impl crate::Io) -> Self {
        let (rd, wr) = tokio::io::split(io);
        Self { read: ReadSide::new(Box::new(rd)), write: Box::new(wr) }
    }

    /// Whether an idle connection still looks usable: nothing to read, not closed.
    pub fn is_reusable(&mut self) -> bool {
        if !self.read.buf.is_empty() {
            return false;
        }
        let mut probe = [0u8; 1];
        let mut buf = ReadBuf::new(&mut probe);
        let mut cx = Context::from_waker(std::task::Waker::noop());
        matches!(Pin::new(&mut self.read.io).poll_read(&mut cx, &mut buf), Poll::Pending)
    }
}

/// A response received by [`send`].
pub struct ClientResponse {
    pub head: ResponseHead,
    pub info: ResponseInfo,
    pub body: Incoming,
    /// the connection after `101 Switching Protocols`
    pub upgraded: Option<Upgraded>,
}

/// Failure of [`send`].
#[derive(Debug)]
pub enum SendError {
    /// the request body failed
    Body(BoxError),
    Io(io::Error),
    /// invalid response head
    Parse(ParseError),
    /// the connection closed before a response; `untouched` when nothing at all was received
    Closed {
        untouched: bool,
    },
    /// the request body did not match its declared length
    Length,
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::Body(e) => write!(f, "request body failed: {e}"),
            SendError::Io(e) => write!(f, "connection error: {e}"),
            SendError::Parse(e) => write!(f, "invalid response: {e}"),
            SendError::Closed { .. } => f.write_str("connection closed before message completed"),
            SendError::Length => f.write_str("request body length mismatch"),
        }
    }
}

impl std::error::Error for SendError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SendError::Body(e) => Some(e.as_ref()),
            SendError::Io(e) => Some(e),
            SendError::Parse(e) => Some(e),
            _ => None,
        }
    }
}

type OnReusable = Box<dyn FnOnce(Connection) + Send>;

/// Halves of a connection coming back from the body writer and reader.
struct Slot {
    write: Option<BoxWrite>,
    read: Option<ReadSide>,
    failed: bool,
    on_reusable: Option<OnReusable>,
}

impl Slot {
    fn complete(slot: &Mutex<Slot>) {
        let mut s = slot.lock().unwrap();
        if s.failed || s.write.is_none() || s.read.is_none() || s.on_reusable.is_none() {
            return;
        }
        let read = s.read.take().unwrap();
        let write = s.write.take().unwrap();
        let cb = s.on_reusable.take().unwrap();
        drop(s);
        if read.buf.is_empty() {
            cb(Connection { read, write });
        }
    }
}

async fn read_head(
    read: &mut ReadSide,
    limits: &HeadLimits,
    method: &str,
) -> Result<(ResponseHead, ResponseInfo), SendError> {
    let mut received = false;
    loop {
        if !read.buf.is_empty() {
            received = true;
            match parse_response(&read.buf, limits) {
                Ok(Some((head, len))) => {
                    read.buf.advance(len);
                    match response_info(&head, method).map_err(SendError::Parse)? {
                        Some(info) => return Ok((head, info)),
                        None => continue,
                    }
                }
                Ok(None) => {}
                Err(e) => return Err(SendError::Parse(e)),
            }
        }
        match read.fill().await {
            Ok(0) => return Err(SendError::Closed { untouched: !received }),
            Ok(_) => {}
            // e.g. a reset of a stale pooled connection
            Err(_) if !received => return Err(SendError::Closed { untouched: true }),
            Err(e) => return Err(SendError::Io(e)),
        }
    }
}

type WriteFuture = Pin<Box<dyn Future<Output = (BoxWrite, Result<(), WriteError>)> + Send>>;

/// Sends one request on `conn` and returns the response once its head
/// arrived. `target` is the request-target (origin form); headers are sent as
/// given (see [`encode_request`] for framing). `on_reusable` receives the
/// connection when it can serve another request.
pub async fn send(
    conn: Connection,
    method: &str,
    target: &str,
    headers: &[Header],
    mut body: BoxBody,
    limits: &HeadLimits,
    on_reusable: Option<OnReusable>,
) -> Result<ClientResponse, SendError> {
    let Connection { mut read, write } = conn;
    let mut out = Vec::with_capacity(256);
    let length = body.length();
    let framing = encode_request(&mut out, method, target, headers, length);
    if length == BodyLength::Empty {
        // nothing to poll
        body = BoxBody::empty();
    }
    let slot = Arc::new(Mutex::new(Slot { write: None, read: None, failed: false, on_reusable }));
    let mut writer: Option<WriteFuture> = Some(Box::pin(async move {
        let mut write = write;
        let res = write_message(&mut write, out, &mut body, framing).await;
        (write, res)
    }));
    let mut write_err: Option<WriteError> = None;
    let head = {
        let mut reader = pin!(read_head(&mut read, limits, method));
        // the body writer and the response reader run together; the polling
        // order alternates so neither can starve the other
        let mut reader_first = false;
        loop {
            let event = std::future::poll_fn(|cx| {
                reader_first = !reader_first;
                for turn in 0..2 {
                    if (turn == 0) == reader_first {
                        if let Poll::Ready(r) = reader.as_mut().poll(cx) {
                            return Poll::Ready(Ok(r));
                        }
                    } else if let Some(w) = writer.as_mut()
                        && let Poll::Ready(done) = w.as_mut().poll(cx)
                    {
                        return Poll::Ready(Err(done));
                    }
                }
                Poll::Pending
            })
            .await;
            match event {
                Ok(r) => break r,
                Err((write, res)) => {
                    writer = None;
                    match res {
                        Ok(()) => slot.lock().unwrap().write = Some(write),
                        Err(WriteError::Body(e)) => return Err(SendError::Body(e)),
                        Err(e) => {
                            slot.lock().unwrap().failed = true;
                            write_err = Some(e);
                        }
                    }
                }
            }
        }
    };
    let (head, info) = match head {
        Ok(h) => h,
        Err(e) => {
            return Err(match write_err {
                Some(WriteError::Length) => SendError::Length,
                Some(WriteError::Io(io)) if !matches!(e, SendError::Closed { untouched: true }) => {
                    SendError::Io(io)
                }
                _ => e,
            });
        }
    };
    if let Some(writer) = writer {
        let slot = slot.clone();
        tokio::spawn(async move {
            let (write, res) = writer.await;
            {
                let mut s = slot.lock().unwrap();
                match res {
                    Ok(()) => s.write = Some(write),
                    Err(_) => s.failed = true,
                }
            }
            Slot::complete(&slot);
        });
    }
    if !info.keep_alive {
        slot.lock().unwrap().failed = true;
    }

    if info.upgrade {
        let write = slot.lock().unwrap().write.take();
        let upgraded = write.map(|w| Upgraded::new(read, w));
        return Ok(ClientResponse { head, info, body: Incoming::empty(), upgraded });
    }
    let body = if info.framing == Framing::Length(0) {
        slot.lock().unwrap().read = Some(read);
        Slot::complete(&slot);
        Incoming::empty()
    } else {
        let slot = slot.clone();
        Incoming::new(
            read,
            info.framing,
            Some(Box::new(move |read| {
                slot.lock().unwrap().read = Some(read);
                Slot::complete(&slot);
            })),
            None,
        )
    };
    Ok(ClientResponse { head, info, body, upgraded: None })
}

/// Destination of a request.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Target {
    pub https: bool,
    /// host as in the URL (IPv6 in brackets)
    pub host: String,
    pub port: u16,
}

impl Target {
    /// `host[:port]` with the port only when it is not the scheme's default.
    pub fn authority(&self) -> String {
        let default = if self.https { 443 } else { 80 };
        if self.port == default {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

pub type ConnectFuture<'a> = Pin<Box<dyn Future<Output = Result<BoxIo, BoxError>> + Send + 'a>>;

/// Opens transport connections for a [`Client`].
pub trait Connect: Send + Sync + 'static {
    fn connect<'a>(&'a self, target: &'a Target) -> ConnectFuture<'a>;
}

/// Pooled client settings.
#[derive(Debug, Clone, Copy)]
pub struct ClientConfig {
    pub limits: HeadLimits,
    /// how long an idle connection is kept
    pub idle_timeout: Duration,
    /// idle connections kept per target
    pub max_idle_per_target: usize,
}

/// Failure of [`Client::request`].
#[derive(Debug)]
pub enum ClientError {
    Connect(BoxError),
    Tls(io::Error),
    Send(SendError),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Connect(e) => write!(f, "connect failed: {e}"),
            ClientError::Tls(e) => write!(f, "tls handshake failed: {e}"),
            ClientError::Send(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for ClientError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ClientError::Connect(e) => Some(e.as_ref()),
            ClientError::Tls(e) => Some(e),
            ClientError::Send(e) => Some(e),
        }
    }
}

struct Idle {
    conn: Connection,
    since: Instant,
}

struct Pool {
    idle: Mutex<HashMap<Target, Vec<Idle>>>,
    reaper: Mutex<bool>,
    config: ClientConfig,
}

impl Pool {
    fn checkout(&self, target: &Target) -> Option<Connection> {
        let mut idle = self.idle.lock().unwrap();
        let list = idle.get_mut(target)?;
        let mut found = None;
        while let Some(mut entry) = list.pop() {
            if entry.since.elapsed() < self.config.idle_timeout && entry.conn.is_reusable() {
                found = Some(entry.conn);
                break;
            }
        }
        if list.is_empty() {
            idle.remove(target);
        }
        found
    }

    fn checkin(self: &Arc<Self>, target: Target, conn: Connection) {
        {
            let mut idle = self.idle.lock().unwrap();
            let list = idle.entry(target).or_default();
            if list.len() >= self.config.max_idle_per_target {
                return;
            }
            list.push(Idle { conn, since: Instant::now() });
        }
        let mut running = self.reaper.lock().unwrap();
        if !*running && let Ok(rt) = tokio::runtime::Handle::try_current() {
            *running = true;
            rt.spawn(reap(Arc::downgrade(self), self.config.idle_timeout));
        }
    }
}

/// Drops expired idle connections until the pool is empty.
async fn reap(pool: Weak<Pool>, every: Duration) {
    loop {
        tokio::time::sleep(every).await;
        let Some(pool) = pool.upgrade() else {
            return;
        };
        let mut idle = pool.idle.lock().unwrap();
        idle.retain(|_, list| {
            list.retain(|e| e.since.elapsed() < pool.config.idle_timeout);
            !list.is_empty()
        });
        if idle.is_empty() {
            *pool.reaper.lock().unwrap() = false;
            return;
        }
    }
}

/// A pooled HTTP/1.1 client.
#[derive(Clone)]
pub struct Client {
    connector: Arc<dyn Connect>,
    tls: Option<Arc<rustls::ClientConfig>>,
    pool: Arc<Pool>,
}

impl Client {
    /// `tls` is required for https targets.
    pub fn new(
        connector: Arc<dyn Connect>,
        tls: Option<Arc<rustls::ClientConfig>>,
        config: ClientConfig,
    ) -> Self {
        let pool =
            Arc::new(Pool { idle: Mutex::new(HashMap::new()), reaper: Mutex::new(false), config });
        Self { connector, tls, pool }
    }

    async fn open(&self, target: &Target) -> Result<Connection, ClientError> {
        let io = self.connector.connect(target).await.map_err(ClientError::Connect)?;
        if !target.https {
            return Ok(Connection::new(io));
        }
        let config = self.tls.clone().ok_or_else(|| {
            ClientError::Tls(io::Error::other("https is not configured for this client"))
        })?;
        let name = crate::tls::server_name(&target.host).map_err(ClientError::Tls)?;
        let tls = crate::tls::connect(config, name, io).await.map_err(ClientError::Tls)?;
        Ok(Connection::new(tls))
    }

    /// Sends a request. A `host` header is added from `target` when missing;
    /// `path` is the origin-form request-target.
    pub async fn request(
        &self,
        target: &Target,
        method: &str,
        path: &str,
        mut headers: Vec<Header>,
        body: BoxBody,
    ) -> Result<ClientResponse, ClientError> {
        if !headers.iter().any(|h| h.name.eq_ignore_ascii_case("host")) {
            headers.push(Header::new("host", target.authority()));
        }
        let empty = body.length() == BodyLength::Empty;
        let limits = self.pool.config.limits;
        let reuse = |pool: &Arc<Pool>| {
            let pool = pool.clone();
            let target = target.clone();
            Some(Box::new(move |conn| pool.checkin(target, conn)) as OnReusable)
        };
        if let Some(conn) = self.pool.checkout(target) {
            let body = if empty { BoxBody::empty() } else { body };
            match send(conn, method, path, &headers, body, &limits, reuse(&self.pool)).await {
                Ok(r) => return Ok(r),
                // a stale pooled connection: retry bodyless requests on a new one
                Err(SendError::Closed { untouched: true }) if empty => {}
                Err(e) => return Err(ClientError::Send(e)),
            }
            let conn = self.open(target).await?;
            return send(
                conn,
                method,
                path,
                &headers,
                BoxBody::empty(),
                &limits,
                reuse(&self.pool),
            )
            .await
            .map_err(ClientError::Send);
        }
        let conn = self.open(target).await?;
        send(conn, method, path, &headers, body, &limits, reuse(&self.pool))
            .await
            .map_err(ClientError::Send)
    }
}

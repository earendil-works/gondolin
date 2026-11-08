//! tokio adapter: drives a sans-io [`Connection`] over a byte stream.
//!
//! Each connection runs a reader task (input → protocol → events) and a
//! writer task (protocol output → stream). Reading never waits for writing,
//! so two peers sending bulk data at each other cannot deadlock on full
//! socket buffers; what the writer has not flushed yet is bounded by the
//! windows the peer granted (plus [`HIGH_WATER`] as a backstop).
//!
//! [`Client`], [`Server`] and [`Channel`] are handles; the connection is
//! closed (DISCONNECT, stream shut down) when the last one is dropped.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::agent::{self, AgentClient};
use super::connection::{
    AuthRequest, ChannelMsg, ChannelRequest, ConnEvent, Connection, ConnectionConfig,
};
use super::keys::{PrivateKey, PublicKey, RSA_SHA256, RSA_SHA512};
use super::transport::{Transport, TransportConfig};
use super::{Error, reason};

/// Unflushed output in `bytes` above which senders wait for the writer.
pub const HIGH_WATER: usize = 16 << 20;
/// How long the writer keeps flushing after the connection was closed.
const LINGER: Duration = Duration::from_secs(10);
const READ_BUF: usize = 64 * 1024;
/// Queued messages per channel (data coalesces up to [`COALESCE`] bytes).
const MAX_INBOX: usize = 4096;
/// Small data messages are merged up to this many `bytes`.
const COALESCE: usize = 64 * 1024;
/// Data encrypted per lock acquisition in `bytes`.
const SEND_CHUNK: usize = 64 * 1024;

/// Decides server-side authentication attempts.
pub type AuthPolicy = Arc<dyn Fn(&AuthRequest) -> bool + Send + Sync>;

/// Session options beyond the transport.
#[derive(Clone, Default)]
pub struct SessionConfig {
    pub connection: ConnectionConfig,
    /// client: send `keepalive@openssh.com` after this much silence
    pub keepalive_interval: Option<Duration>,
    /// client: unanswered keepalives before the connection is dropped
    pub keepalive_max: usize,
}

#[derive(Default)]
struct ChanState {
    inbox: VecDeque<ChannelMsg>,
    notify: Arc<Notify>,
    /// both sides closed (no more messages)
    freed: bool,
    /// the handle was dropped
    dropped: bool,
    /// open result (client channels)
    opened: Option<Result<(), String>>,
}

struct State {
    conn: Connection,
    chans: HashMap<u32, ChanState>,
    /// server: opened channels not yet accepted
    incoming: VecDeque<u32>,
    /// client: authentication progress
    auth_events: VecDeque<ConnEvent>,
    service_requested: bool,
    ready: Option<Option<PublicKey>>,
    /// the connection ended: `Some(None)` cleanly, else with an error
    ended: Option<Option<Error>>,
    /// keepalives without a reply
    keepalives_unanswered: usize,
    last_rx: Instant,
}

struct Shared {
    st: Mutex<State>,
    /// wakes the writer
    write_wake: Notify,
    /// output was flushed (senders above [`HIGH_WATER`])
    drained: Notify,
    /// connection-level progress (ready, auth, opens, incoming, end)
    conn_wake: Notify,
    auth: Option<AuthPolicy>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn end(&self, st: &mut State, error: Option<Error>) {
        if st.ended.is_none() {
            st.ended = Some(error);
        }
        for chan in st.chans.values() {
            chan.notify.notify_waiters();
        }
        self.conn_wake.notify_waiters();
        self.drained.notify_waiters();
        self.write_wake.notify_one();
    }

    /// Applies the connection's pending events.
    fn process(&self, st: &mut State) -> Result<(), Error> {
        loop {
            let ev = match st.conn.poll() {
                Ok(Some(ev)) => ev,
                Ok(None) => return Ok(()),
                Err(e) => return Err(e),
            };
            match ev {
                ConnEvent::Ready { host_key } => {
                    st.ready = Some(host_key);
                    self.conn_wake.notify_waiters();
                }
                ConnEvent::ServiceAccepted
                | ConnEvent::AuthSuccess
                | ConnEvent::AuthFailure { .. }
                | ConnEvent::AuthPkOk => {
                    st.auth_events.push_back(ev);
                    self.conn_wake.notify_waiters();
                }
                ConnEvent::Banner(_) => {}
                ConnEvent::AuthRequest(req) => {
                    let accept = self.auth.as_ref().is_some_and(|policy| policy(&req));
                    st.conn.auth_reply(accept)?;
                }
                ConnEvent::ChannelOpened(id) => {
                    st.chans.insert(id, ChanState::default());
                    st.incoming.push_back(id);
                    self.conn_wake.notify_waiters();
                }
                ConnEvent::OpenConfirmed(id) => {
                    if let Some(c) = st.chans.get_mut(&id) {
                        c.opened = Some(Ok(()));
                    }
                    self.conn_wake.notify_waiters();
                }
                ConnEvent::OpenFailed { id, description, .. } => {
                    if let Some(c) = st.chans.get_mut(&id) {
                        c.opened = Some(Err(description));
                        c.freed = true;
                    }
                    self.conn_wake.notify_waiters();
                }
                ConnEvent::Channel(id, m) => {
                    let Some(c) = st.chans.get_mut(&id) else { continue };
                    if c.dropped {
                        // nobody reads it: credit the window, refuse requests
                        match &m {
                            ChannelMsg::Data(d) | ChannelMsg::ExtendedData { data: d, .. } => {
                                let n = d.len();
                                st.conn.consumed(id, n)?;
                            }
                            ChannelMsg::Request { want_reply: true, .. } => {
                                st.conn.reply(id, false)?
                            }
                            _ => {}
                        }
                        continue;
                    }
                    // small data packets coalesce (bytes are bounded by the
                    // window, messages by this); anything else is capped
                    match (c.inbox.back_mut(), m) {
                        (Some(ChannelMsg::Data(last)), ChannelMsg::Data(d))
                            if last.len() + d.len() <= COALESCE =>
                        {
                            last.extend_from_slice(&d);
                        }
                        (_, m) => {
                            if c.inbox.len() >= MAX_INBOX {
                                return Err(Error::Protocol(
                                    "too many queued channel messages".into(),
                                ));
                            }
                            c.inbox.push_back(m);
                        }
                    }
                    c.notify.notify_waiters();
                }
                ConnEvent::WindowAdjusted(id) => {
                    if let Some(c) = st.chans.get(&id) {
                        c.notify.notify_waiters();
                    }
                }
                ConnEvent::ChannelFreed(id) => {
                    if let Some(c) = st.chans.get_mut(&id) {
                        c.freed = true;
                        c.notify.notify_waiters();
                        if c.dropped {
                            st.chans.remove(&id);
                        }
                    }
                }
                ConnEvent::GlobalReply(_) => st.keepalives_unanswered = 0,
            }
        }
    }
}

/// Closes the connection when the last handle goes away.
struct Guard {
    shared: Arc<Shared>,
    reader: JoinHandle<()>,
}

impl Drop for Guard {
    fn drop(&mut self) {
        {
            let mut st = self.shared.lock();
            if st.ended.is_none() {
                st.conn.disconnect(reason::BY_APPLICATION, "");
            }
            self.shared.end(&mut st, None);
        }
        self.reader.abort();
    }
}

fn start<S>(
    stream: S,
    conn: Connection,
    cfg: &SessionConfig,
    auth: Option<AuthPolicy>,
) -> Arc<Guard>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let shared = Arc::new(Shared {
        st: Mutex::new(State {
            conn,
            chans: HashMap::new(),
            incoming: VecDeque::new(),
            auth_events: VecDeque::new(),
            service_requested: false,
            ready: None,
            ended: None,
            keepalives_unanswered: 0,
            last_rx: Instant::now(),
        }),
        write_wake: Notify::new(),
        drained: Notify::new(),
        conn_wake: Notify::new(),
        auth,
    });
    let (mut rd, mut wr) = tokio::io::split(stream);

    let w = shared.clone();
    tokio::spawn(async move {
        loop {
            let notified = w.write_wake.notified();
            let (out, ended) = {
                let mut st = w.lock();
                (st.conn.take_output(), st.ended.is_some())
            };
            if !out.is_empty() {
                let write = wr.write_all(&out);
                let result = if ended {
                    tokio::time::timeout(LINGER, write).await.unwrap_or(Ok(()))
                } else {
                    write.await
                };
                w.drained.notify_waiters();
                if let Err(e) = result {
                    let mut st = w.lock();
                    w.end(&mut st, Some(Error::Io(e.to_string())));
                    return;
                }
                continue;
            }
            if ended {
                let _ = tokio::time::timeout(LINGER, wr.shutdown()).await;
                return;
            }
            notified.await;
        }
    });

    let r = shared.clone();
    let reader = tokio::spawn(async move {
        let mut buf = vec![0u8; READ_BUF];
        loop {
            // a peer that makes us answer (window adjusts, request replies,
            // UNIMPLEMENTED) but never reads is not read either
            loop {
                let drained = r.drained.notified();
                {
                    let st = r.lock();
                    if st.ended.is_some() || st.conn.transport.output_len() < 2 * HIGH_WATER {
                        break;
                    }
                }
                drained.await;
            }
            let n = match rd.read(&mut buf).await {
                Ok(0) => {
                    let mut st = r.lock();
                    r.end(&mut st, Some(Error::Closed));
                    return;
                }
                Ok(n) => n,
                Err(e) => {
                    let mut st = r.lock();
                    r.end(&mut st, Some(Error::Io(e.to_string())));
                    return;
                }
            };
            let mut st = r.lock();
            st.last_rx = Instant::now();
            st.conn.input(&buf[..n]);
            let result = r.process(&mut st);
            if st.conn.transport.has_output() {
                r.write_wake.notify_one();
            }
            if let Err(e) = result {
                r.end(&mut st, Some(e));
                return;
            }
        }
    });

    if let Some(interval) = cfg.keepalive_interval {
        let k = Arc::downgrade(&shared);
        let max = cfg.keepalive_max.max(1);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                let Some(s) = k.upgrade() else { return };
                let mut st = s.lock();
                if st.ended.is_some() {
                    return;
                }
                if st.last_rx.elapsed() < interval {
                    continue;
                }
                if st.keepalives_unanswered >= max {
                    st.conn.disconnect(reason::BY_APPLICATION, "keepalive timeout");
                    s.end(&mut st, Some(Error::Io("keepalive timeout".into())));
                    return;
                }
                st.keepalives_unanswered += 1;
                let _ = st.conn.global_request("keepalive@openssh.com", true);
                s.write_wake.notify_one();
            }
        });
    }

    Arc::new(Guard { shared, reader })
}

fn ended_error(e: &Option<Error>) -> Error {
    e.clone().unwrap_or(Error::Closed)
}

/// Waits on the connection-level condition `f` (`Some` ends the wait).
async fn wait_conn<T>(
    shared: &Shared,
    mut f: impl FnMut(&mut State) -> Option<Result<T, Error>>,
) -> Result<T, Error> {
    loop {
        let notified = shared.conn_wake.notified();
        {
            let mut st = shared.lock();
            if let Some(r) = f(&mut st) {
                return r;
            }
            if let Some(e) = &st.ended {
                return Err(ended_error(e));
            }
        }
        notified.await;
    }
}

/// Runs `f` on the connection and wakes the writer.
fn with_conn<T>(
    shared: &Shared,
    f: impl FnOnce(&mut Connection) -> Result<T, Error>,
) -> Result<T, Error> {
    let mut st = shared.lock();
    if let Some(e) = &st.ended {
        return Err(ended_error(e));
    }
    let r = f(&mut st.conn);
    if st.conn.transport.has_output() {
        shared.write_wake.notify_one();
    }
    r
}

// ---------------------------------------------------------------------------
// client

/// A client connection.
#[derive(Clone)]
pub struct Client {
    guard: Arc<Guard>,
    host_key: Option<PublicKey>,
}

impl Client {
    /// Runs the handshake over `stream`; verify [`Client::host_key`] before
    /// authenticating.
    pub async fn connect<S>(
        stream: S,
        transport: TransportConfig,
        cfg: SessionConfig,
    ) -> Result<Client, Error>
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let conn = Connection::new(Transport::new(transport)?, cfg.connection.clone());
        let guard = start(stream, conn, &cfg, None);
        guard.shared.write_wake.notify_one();
        let host_key = wait_conn(&guard.shared, |st| st.ready.clone().map(Ok)).await?;
        Ok(Client { guard, host_key })
    }

    fn shared(&self) -> &Shared {
        &self.guard.shared
    }

    /// The server's host key (verified signature over the exchange).
    pub fn host_key(&self) -> Option<&PublicKey> {
        self.host_key.as_ref()
    }

    /// Completed key exchanges (the first one and rekeys).
    pub fn key_exchanges(&self) -> u32 {
        self.shared().lock().conn.transport.key_exchanges()
    }

    /// The server's `server-sig-algs`, if it sent ext-info.
    pub fn server_sig_algs(&self) -> Option<Vec<String>> {
        self.shared().lock().conn.server_sig_algs().map(<[String]>::to_vec)
    }

    async fn service(&self) -> Result<(), Error> {
        let send = {
            let mut st = self.shared().lock();
            !std::mem::replace(&mut st.service_requested, true)
        };
        if send {
            with_conn(self.shared(), |c| c.request_service("ssh-userauth"))?;
            wait_conn(self.shared(), |st| {
                let pos = st.auth_events.iter().position(|e| *e == ConnEvent::ServiceAccepted)?;
                st.auth_events.remove(pos);
                Some(Ok(()))
            })
            .await?;
        }
        Ok(())
    }

    async fn auth_result(&self) -> Result<bool, Error> {
        wait_conn(self.shared(), |st| match st.auth_events.pop_front()? {
            ConnEvent::AuthSuccess => Some(Ok(true)),
            ConnEvent::AuthFailure { .. } => Some(Ok(false)),
            _ => Some(Err(Error::Protocol("unexpected authentication reply".into()))),
        })
        .await
    }

    pub async fn authenticate_none(&self, user: &str) -> Result<bool, Error> {
        self.service().await?;
        with_conn(self.shared(), |c| c.auth_none(user))?;
        self.auth_result().await
    }

    pub async fn authenticate_password(&self, user: &str, password: &str) -> Result<bool, Error> {
        self.service().await?;
        with_conn(self.shared(), |c| c.auth_password(user, password))?;
        self.auth_result().await
    }

    /// The signature algorithm for `key` the server accepts (RSA: SHA-2
    /// per `server-sig-algs`, `rsa-sha2-256` without ext-info).
    fn algorithm_for(&self, key: &PublicKey) -> &'static str {
        match key {
            PublicKey::Rsa { .. } => {
                let algs = self.server_sig_algs().unwrap_or_default();
                if algs.iter().any(|a| a == RSA_SHA512) { RSA_SHA512 } else { RSA_SHA256 }
            }
            other => other.signature_algorithms()[0],
        }
    }

    pub async fn authenticate_publickey(
        &self,
        user: &str,
        key: &PrivateKey,
    ) -> Result<bool, Error> {
        self.service().await?;
        let alg = self.algorithm_for(key.public_key());
        let blob = key.public_key().to_blob();
        with_conn(self.shared(), |c| {
            let data = c.signing_data(user, alg, &blob)?;
            let sig = key.sign(alg, &data)?;
            c.auth_publickey(user, alg, &blob, &sig)
        })?;
        self.auth_result().await
    }

    /// Public key authentication signed by an ssh-agent.
    pub async fn authenticate_agent(
        &self,
        user: &str,
        agent: &mut AgentClient,
        key: &PublicKey,
    ) -> Result<bool, Error> {
        self.service().await?;
        let alg = self.algorithm_for(key);
        let flags = match alg {
            RSA_SHA512 => agent::RSA_SHA2_512,
            RSA_SHA256 => agent::RSA_SHA2_256,
            _ => 0,
        };
        let blob = key.to_blob();
        let data = with_conn(self.shared(), |c| c.signing_data(user, alg, &blob))?;
        let sig = agent.sign(&blob, &data, flags).await?;
        with_conn(self.shared(), |c| c.auth_publickey(user, alg, &blob, &sig))?;
        self.auth_result().await
    }

    /// Opens a channel of `kind` (`extra`: type-specific open data).
    pub async fn open_channel(&self, kind: &str, extra: &[u8]) -> Result<Channel, Error> {
        let id = {
            let mut st = self.shared().lock();
            if let Some(e) = &st.ended {
                return Err(ended_error(e));
            }
            let id = st.conn.open_channel(kind, extra)?;
            st.chans.insert(id, ChanState::default());
            self.shared().write_wake.notify_one();
            id
        };
        let channel = Channel::new(self.guard.clone(), id);
        wait_conn(self.shared(), |st| match &st.chans.get(&id)?.opened {
            Some(Ok(())) => Some(Ok(())),
            Some(Err(text)) => Some(Err(Error::Protocol(format!("channel open failed: {text}")))),
            None => None,
        })
        .await?;
        Ok(channel)
    }

    pub async fn open_session(&self) -> Result<Channel, Error> {
        self.open_channel("session", &[]).await
    }

    /// Sends DISCONNECT and closes the connection.
    pub fn disconnect(&self) {
        let mut st = self.shared().lock();
        if st.ended.is_none() {
            st.conn.disconnect(reason::BY_APPLICATION, "");
        }
        self.shared().end(&mut st, None);
    }

    /// Waits until the connection ended; `Some` when it failed.
    pub async fn closed(&self) -> Option<Error> {
        closed(self.shared()).await
    }
}

async fn closed(shared: &Shared) -> Option<Error> {
    loop {
        let notified = shared.conn_wake.notified();
        if let Some(e) = &shared.lock().ended {
            return e.clone();
        }
        notified.await;
    }
}

// ---------------------------------------------------------------------------
// server

/// A server connection.
#[derive(Clone)]
pub struct Server {
    guard: Arc<Guard>,
}

impl Server {
    /// Starts serving `stream`; `auth` decides authentication attempts.
    pub fn start<S>(
        stream: S,
        transport: TransportConfig,
        cfg: SessionConfig,
        auth: AuthPolicy,
    ) -> Result<Server, Error>
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let conn = Connection::new(Transport::new(transport)?, cfg.connection.clone());
        let guard = start(stream, conn, &cfg, Some(auth));
        guard.shared.write_wake.notify_one();
        Ok(Server { guard })
    }

    fn shared(&self) -> &Shared {
        &self.guard.shared
    }

    /// The next session channel the client opened; `None` once the
    /// connection ended.
    pub async fn accept(&self) -> Option<Channel> {
        let id = wait_conn(self.shared(), |st| st.incoming.pop_front().map(Ok)).await.ok()?;
        Some(Channel::new(self.guard.clone(), id))
    }

    /// The user the client authenticated as.
    pub fn user(&self) -> Option<String> {
        self.shared().lock().conn.user().map(str::to_string)
    }

    /// Waits until the connection ended; `Some` for errors other than the
    /// peer disconnecting or closing the stream.
    pub async fn closed(&self) -> Option<Error> {
        match closed(self.shared()).await {
            Some(Error::Closed) | Some(Error::Disconnected(_)) | None => None,
            Some(e) => Some(e),
        }
    }

    pub fn disconnect(&self, description: &str) {
        let mut st = self.shared().lock();
        if st.ended.is_none() {
            st.conn.disconnect(reason::BY_APPLICATION, description);
        }
        self.shared().end(&mut st, None);
    }
}

// ---------------------------------------------------------------------------
// channels

/// A channel; usable from several tasks at once (one reading, one writing).
pub struct Channel {
    guard: Arc<Guard>,
    id: u32,
    notify: Arc<Notify>,
}

impl std::fmt::Debug for Channel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Channel({})", self.id)
    }
}

impl Channel {
    fn new(guard: Arc<Guard>, id: u32) -> Channel {
        let notify = guard.shared.lock().chans.entry(id).or_default().notify.clone();
        Channel { guard, id, notify }
    }

    fn shared(&self) -> &Shared {
        &self.guard.shared
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    /// The next message; `None` once the channel or connection is gone.
    pub async fn wait(&self) -> Option<ChannelMsg> {
        loop {
            let notified = self.notify.notified();
            {
                let mut st = self.shared().lock();
                let st = &mut *st;
                let chan = st.chans.get_mut(&self.id)?;
                if let Some(m) = chan.inbox.pop_front() {
                    if let ChannelMsg::Data(d) | ChannelMsg::ExtendedData { data: d, .. } = &m {
                        let n = d.len();
                        if st.conn.consumed(self.id, n).is_ok() && st.conn.transport.has_output() {
                            self.shared().write_wake.notify_one();
                        }
                    }
                    return Some(m);
                }
                if chan.freed || st.ended.is_some() {
                    return None;
                }
            }
            notified.await;
        }
    }

    async fn send(&self, ext: Option<u32>, data: &[u8]) -> Result<(), Error> {
        let mut off = 0;
        while off < data.len() {
            let notified = self.notify.notified();
            let drained = self.shared().drained.notified();
            let wait_for_drain = {
                let mut st = self.shared().lock();
                if let Some(e) = &st.ended {
                    return Err(ended_error(e));
                }
                if st.conn.transport.output_len() >= HIGH_WATER {
                    true
                } else {
                    // bounded work per lock: the reader gets in between
                    let start = off;
                    let end = data.len().min(off + SEND_CHUNK);
                    off += st.conn.send_data(self.id, ext, &data[off..end])?;
                    if st.conn.transport.has_output() {
                        self.shared().write_wake.notify_one();
                    }
                    if off == end && off < data.len() && end - start == SEND_CHUNK {
                        // a full chunk went out: more may fit the window
                        continue;
                    }
                    false
                }
            };
            if off == data.len() {
                break;
            }
            if wait_for_drain {
                drained.await;
            } else {
                notified.await;
            }
        }
        Ok(())
    }

    /// Sends data, waiting for window as needed.
    pub async fn data(&self, data: &[u8]) -> Result<(), Error> {
        self.send(None, data).await
    }

    /// Sends extended data (`ext` 1: stderr).
    pub async fn extended_data(&self, ext: u32, data: &[u8]) -> Result<(), Error> {
        self.send(Some(ext), data).await
    }

    pub fn eof(&self) -> Result<(), Error> {
        with_conn(self.shared(), |c| c.eof(self.id))
    }

    pub fn close(&self) -> Result<(), Error> {
        with_conn(self.shared(), |c| c.close(self.id))
    }

    /// Sends a request (answers arrive as [`ChannelMsg::Success`]/[`ChannelMsg::Failure`]).
    pub fn request(&self, request: &ChannelRequest, want_reply: bool) -> Result<(), Error> {
        with_conn(self.shared(), |c| c.request(self.id, request, want_reply))
    }

    pub fn exec(&self, want_reply: bool, command: &str) -> Result<(), Error> {
        self.request(&ChannelRequest::Exec { command: command.as_bytes().to_vec() }, want_reply)
    }

    /// Answers the oldest request that asked for a reply.
    pub fn reply(&self, ok: bool) -> Result<(), Error> {
        with_conn(self.shared(), |c| c.reply(self.id, ok))
    }

    pub fn exit_status(&self, code: u32) -> Result<(), Error> {
        self.request(&ChannelRequest::ExitStatus { code }, false)
    }

    /// Waits for the reply to a request sent with `want_reply`, skipping
    /// nothing else: other messages are returned as `Err(msg)`.
    pub async fn wait_reply(&self) -> Result<bool, Option<ChannelMsg>> {
        match self.wait().await {
            Some(ChannelMsg::Success) => Ok(true),
            Some(ChannelMsg::Failure) => Ok(false),
            other => Err(other),
        }
    }
}

impl Drop for Channel {
    fn drop(&mut self) {
        let shared = &self.guard.shared;
        let mut st = shared.lock();
        let st = &mut *st;
        let _ = st.conn.close(self.id);
        if let Some(chan) = st.chans.get_mut(&self.id) {
            chan.dropped = true;
            // credit what was never read and refuse unanswered requests
            for m in std::mem::take(&mut chan.inbox) {
                match m {
                    ChannelMsg::Data(d) | ChannelMsg::ExtendedData { data: d, .. } => {
                        let _ = st.conn.consumed(self.id, d.len());
                    }
                    ChannelMsg::Request { want_reply: true, .. } => {
                        let _ = st.conn.reply(self.id, false);
                    }
                    _ => {}
                }
            }
            if st.chans.get(&self.id).is_some_and(|c| c.freed) {
                st.chans.remove(&self.id);
            }
        }
        if st.conn.transport.has_output() {
            shared.write_wake.notify_one();
        }
    }
}

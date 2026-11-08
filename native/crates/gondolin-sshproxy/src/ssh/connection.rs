//! Sans-io user authentication (RFC 4252) and connection protocol
//! (RFC 4254) on top of [`Transport`].
//!
//! Receive windows are advertised as the application consumes data
//! ([`Connection::consumed`]), not on receipt: a peer can have at most one
//! window in flight beyond what the application took, so a slow consumer
//! only slows down its own channel.

use std::collections::{HashMap, VecDeque};

use super::keys::PublicKey;
use super::transport::{Event, Role, Transport};
use super::wire::{Reader, Writer};
use super::{Error, msg, reason};

/// Channel defaults.
#[derive(Debug, Clone)]
pub struct ConnectionConfig {
    /// receive window per channel in `bytes`
    pub window: u32,
    /// largest data packet we accept in `bytes`
    pub max_packet: u32,
    /// open channels per connection
    pub max_channels: usize,
}

impl Default for ConnectionConfig {
    fn default() -> Self {
        ConnectionConfig { window: 2 * 1024 * 1024, max_packet: 32 * 1024, max_channels: 64 }
    }
}

/// How a client tries to authenticate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthMethod {
    None,
    Password,
    /// `signed`: with a verified signature (else a query)
    PublicKey {
        key: PublicKey,
        algorithm: String,
        signed: bool,
    },
    KeyboardInteractive,
}

/// A client's authentication attempt (server side).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthRequest {
    pub user: String,
    pub method: AuthMethod,
}

/// A channel request (`SSH_MSG_CHANNEL_REQUEST`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelRequest {
    Exec { command: Vec<u8> },
    Pty { term: String, cols: u32, rows: u32 },
    Env { name: String, value: String },
    Shell,
    Subsystem { name: String },
    WindowChange { cols: u32, rows: u32 },
    Signal { name: String },
    ExitStatus { code: u32 },
    ExitSignal { name: String, core_dumped: bool, message: String, lang: String },
}

/// What arrives on a channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelMsg {
    Data(Vec<u8>),
    ExtendedData {
        ext: u32,
        data: Vec<u8>,
    },
    Eof,
    Close,
    /// a request; with `want_reply`, answer it with [`Connection::reply`]
    Request {
        request: ChannelRequest,
        want_reply: bool,
    },
    /// replies to our requests, in order
    Success,
    Failure,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnEvent {
    /// key exchange done (client: verify `host_key`, then authenticate)
    Ready {
        host_key: Option<PublicKey>,
    },
    ServiceAccepted,
    Banner(String),
    AuthSuccess,
    AuthFailure {
        methods: Vec<String>,
        partial: bool,
    },
    AuthPkOk,
    /// server: answer with [`Connection::auth_reply`]
    AuthRequest(AuthRequest),
    /// server: the peer opened a session channel (already confirmed)
    ChannelOpened(u32),
    OpenConfirmed(u32),
    OpenFailed {
        id: u32,
        reason: u32,
        description: String,
    },
    Channel(u32, ChannelMsg),
    /// the peer granted window (blocked writers may continue)
    WindowAdjusted(u32),
    /// both sides closed the channel; its id is free
    ChannelFreed(u32),
    /// reply to a global request we sent with `want_reply`
    GlobalReply(bool),
}

#[derive(Debug)]
struct Chan {
    remote_id: u32,
    /// open confirmed (ours) / accepted (theirs)
    open: bool,
    /// bytes we may still send
    remote_window: u64,
    remote_max_packet: u32,
    /// bytes the peer may still send us
    local_remaining: u32,
    /// consumed by the application, not yet advertised
    consumed: u32,
    sent_eof: bool,
    sent_close: bool,
    recv_close: bool,
    /// replies owed for the peer's requests, in order (`None`: undecided)
    replies: VecDeque<Option<bool>>,
}

const MAX_AUTH_ATTEMPTS: u32 = 32;
const MAX_PENDING_REPLIES: usize = 1024;

pub struct Connection {
    pub transport: Transport,
    cfg: ConnectionConfig,
    channels: HashMap<u32, Chan>,
    next_id: u32,
    events: VecDeque<ConnEvent>,
    authenticated: bool,
    pending_auth: Option<AuthRequest>,
    auth_attempts: u32,
    user: Option<String>,
    server_sig_algs: Option<Vec<String>>,
}

fn proto(msg: impl Into<String>) -> Error {
    Error::Protocol(msg.into())
}

impl Connection {
    pub fn new(transport: Transport, cfg: ConnectionConfig) -> Connection {
        Connection {
            transport,
            cfg,
            channels: HashMap::new(),
            next_id: 0,
            events: VecDeque::new(),
            authenticated: false,
            pending_auth: None,
            auth_attempts: 0,
            user: None,
            server_sig_algs: None,
        }
    }

    fn role(&self) -> Role {
        self.transport.role()
    }

    /// Server: the user name the client authenticated as.
    pub fn user(&self) -> Option<&str> {
        self.user.as_deref()
    }

    /// Client: the server's `server-sig-algs` (ext-info), when it sent them.
    pub fn server_sig_algs(&self) -> Option<&[String]> {
        self.server_sig_algs.as_deref()
    }

    pub fn input(&mut self, data: &[u8]) {
        self.transport.input(data);
    }

    pub fn take_output(&mut self) -> Vec<u8> {
        self.transport.take_output()
    }

    pub fn disconnect(&mut self, code: u32, description: &str) {
        self.transport.disconnect(code, description);
    }

    pub fn poll(&mut self) -> Result<Option<ConnEvent>, Error> {
        loop {
            if let Some(ev) = self.events.pop_front() {
                return Ok(Some(ev));
            }
            let Some(ev) = self.transport.poll()? else { return Ok(None) };
            let result = match ev {
                Event::Ready { host_key } => {
                    self.events.push_back(ConnEvent::Ready { host_key });
                    Ok(())
                }
                Event::Message { seq, payload } => self.handle(seq, &payload),
            };
            if let Err(e) = result {
                let text = e.to_string();
                self.transport.disconnect(reason::PROTOCOL_ERROR, &text);
                return Err(e);
            }
        }
    }

    fn handle(&mut self, seq: u32, payload: &[u8]) -> Result<(), Error> {
        let kind = payload[0];
        let mut r = Reader::new(&payload[1..]);
        let server = self.role() == Role::Server;
        match kind {
            msg::SERVICE_REQUEST if server => {
                if r.string()? == b"ssh-userauth" {
                    let mut w = Writer::msg(msg::SERVICE_ACCEPT);
                    w.string("ssh-userauth");
                    self.transport.send(w.finish())
                } else {
                    self.transport
                        .disconnect(reason::SERVICE_NOT_AVAILABLE, "service not available");
                    Err(proto("unknown service requested"))
                }
            }
            msg::SERVICE_ACCEPT if !server => {
                self.events.push_back(ConnEvent::ServiceAccepted);
                Ok(())
            }
            msg::EXT_INFO if !server => {
                let count = r.u32()?;
                for _ in 0..count.min(64) {
                    let name = r.string()?;
                    let value = r.string()?;
                    if name == b"server-sig-algs" {
                        let algs = String::from_utf8_lossy(value);
                        self.server_sig_algs = Some(algs.split(',').map(str::to_string).collect());
                    }
                }
                Ok(())
            }
            msg::USERAUTH_REQUEST if server => self.on_userauth_request(&mut r),
            msg::USERAUTH_SUCCESS if !server => {
                self.authenticated = true;
                self.events.push_back(ConnEvent::AuthSuccess);
                Ok(())
            }
            msg::USERAUTH_FAILURE if !server => {
                let methods = r.name_list()?;
                let partial = r.bool()?;
                self.events.push_back(ConnEvent::AuthFailure { methods, partial });
                Ok(())
            }
            msg::USERAUTH_BANNER if !server => {
                self.events.push_back(ConnEvent::Banner(r.text()?));
                Ok(())
            }
            msg::USERAUTH_60 if !server => {
                self.events.push_back(ConnEvent::AuthPkOk);
                Ok(())
            }
            50..=79 => {
                // userauth messages of the other role, or unsupported methods
                self.transport.unimplemented(seq);
                Ok(())
            }
            _ if !self.authenticated => Err(proto(format!("message {kind} before authentication"))),
            msg::GLOBAL_REQUEST => {
                let _name = r.string()?;
                if r.bool()? {
                    self.transport.send(vec![msg::REQUEST_FAILURE])?;
                }
                Ok(())
            }
            msg::REQUEST_SUCCESS | msg::REQUEST_FAILURE => {
                self.events.push_back(ConnEvent::GlobalReply(kind == msg::REQUEST_SUCCESS));
                Ok(())
            }
            msg::CHANNEL_OPEN => self.on_channel_open(&mut r),
            msg::CHANNEL_OPEN_CONFIRMATION => {
                let id = r.u32()?;
                let remote_id = r.u32()?;
                let window = r.u32()?;
                let max_packet = r.u32()?;
                let chan = self.chan_mut(id)?;
                if chan.open {
                    return Err(proto("duplicate open confirmation"));
                }
                chan.open = true;
                chan.remote_id = remote_id;
                chan.remote_window = window as u64;
                chan.remote_max_packet = max_packet.clamp(1, 256 * 1024);
                if chan.sent_close {
                    // abandoned while opening: close it now
                    let mut w = Writer::msg(msg::CHANNEL_CLOSE);
                    w.u32(remote_id);
                    return self.transport.send(w.finish());
                }
                self.events.push_back(ConnEvent::OpenConfirmed(id));
                Ok(())
            }
            msg::CHANNEL_OPEN_FAILURE => {
                let id = r.u32()?;
                let code = r.u32()?;
                let description = r.text().unwrap_or_default();
                let chan = self.chan_mut(id)?;
                if chan.open {
                    return Err(proto("open failure for an open channel"));
                }
                self.channels.remove(&id);
                self.events.push_back(ConnEvent::OpenFailed { id, reason: code, description });
                Ok(())
            }
            msg::CHANNEL_WINDOW_ADJUST => {
                let id = r.u32()?;
                let add = r.u32()?;
                let chan = self.chan_mut(id)?;
                chan.remote_window = (chan.remote_window + add as u64).min(u32::MAX as u64);
                self.events.push_back(ConnEvent::WindowAdjusted(id));
                Ok(())
            }
            msg::CHANNEL_DATA | msg::CHANNEL_EXTENDED_DATA => {
                let id = r.u32()?;
                let ext = if kind == msg::CHANNEL_EXTENDED_DATA { Some(r.u32()?) } else { None };
                let data = r.string()?;
                let chan = self.chan_mut(id)?;
                if data.len() as u64 > chan.local_remaining as u64 {
                    return Err(proto("channel window exceeded"));
                }
                chan.local_remaining -= data.len() as u32;
                if chan.sent_close {
                    // closing: nobody will consume it
                    chan.consumed += data.len() as u32;
                    return Ok(());
                }
                let data = data.to_vec();
                let m = match ext {
                    Some(ext) => ChannelMsg::ExtendedData { ext, data },
                    None => ChannelMsg::Data(data),
                };
                self.events.push_back(ConnEvent::Channel(id, m));
                Ok(())
            }
            msg::CHANNEL_EOF => {
                let id = r.u32()?;
                self.chan_mut(id)?;
                self.events.push_back(ConnEvent::Channel(id, ChannelMsg::Eof));
                Ok(())
            }
            msg::CHANNEL_CLOSE => {
                let id = r.u32()?;
                let chan = self.chan_mut(id)?;
                if chan.recv_close {
                    return Err(proto("duplicate channel close"));
                }
                chan.recv_close = true;
                let reply = !chan.sent_close;
                self.events.push_back(ConnEvent::Channel(id, ChannelMsg::Close));
                if reply {
                    self.close(id)?;
                } else {
                    self.free(id);
                }
                Ok(())
            }
            msg::CHANNEL_REQUEST => self.on_channel_request(&mut r),
            msg::CHANNEL_SUCCESS | msg::CHANNEL_FAILURE => {
                let id = r.u32()?;
                self.chan_mut(id)?;
                let m = if kind == msg::CHANNEL_SUCCESS {
                    ChannelMsg::Success
                } else {
                    ChannelMsg::Failure
                };
                self.events.push_back(ConnEvent::Channel(id, m));
                Ok(())
            }
            _ => {
                self.transport.unimplemented(seq);
                Ok(())
            }
        }
    }

    fn chan_mut(&mut self, id: u32) -> Result<&mut Chan, Error> {
        self.channels.get_mut(&id).ok_or_else(|| proto(format!("unknown channel {id}")))
    }

    fn free(&mut self, id: u32) {
        if let Some(chan) = self.channels.get(&id)
            && chan.sent_close
            && chan.recv_close
        {
            self.channels.remove(&id);
            self.events.push_back(ConnEvent::ChannelFreed(id));
        }
    }

    // ------------------------------------------------------------------
    // user authentication

    fn on_userauth_request(&mut self, r: &mut Reader<'_>) -> Result<(), Error> {
        if self.authenticated {
            return Ok(()); // RFC 4252: ignored after success
        }
        if self.pending_auth.is_some() {
            return Err(proto("pipelined authentication request"));
        }
        self.auth_attempts += 1;
        if self.auth_attempts > MAX_AUTH_ATTEMPTS {
            return Err(proto("too many authentication attempts"));
        }
        let user = r.text()?;
        let service = r.string()?;
        let method_name = r.string()?;
        if service != b"ssh-connection" {
            return self.auth_failure();
        }
        let method = match method_name {
            b"none" => AuthMethod::None,
            b"password" => AuthMethod::Password,
            b"keyboard-interactive" => AuthMethod::KeyboardInteractive,
            b"publickey" => {
                let signed = r.bool()?;
                let algorithm = r.utf8()?.to_string();
                let blob = r.string()?;
                let Ok(key) = PublicKey::from_blob(blob) else {
                    return self.auth_failure();
                };
                if !key.signature_algorithms().contains(&algorithm.as_str()) {
                    return self.auth_failure();
                }
                if signed {
                    let sig = r.string()?;
                    let data = self.signing_data(&user, &algorithm, blob)?;
                    if key.verify(&algorithm, &data, sig).is_err() {
                        return self.auth_failure();
                    }
                }
                AuthMethod::PublicKey { key, algorithm, signed }
            }
            _ => return self.auth_failure(),
        };
        let request = AuthRequest { user, method };
        self.pending_auth = Some(request.clone());
        self.events.push_back(ConnEvent::AuthRequest(request));
        Ok(())
    }

    fn auth_failure(&mut self) -> Result<(), Error> {
        let mut w = Writer::msg(msg::USERAUTH_FAILURE);
        w.name_list(&["publickey", "password", "keyboard-interactive"]).bool(false);
        self.transport.send(w.finish())
    }

    /// Server: answers the pending [`ConnEvent::AuthRequest`].
    pub fn auth_reply(&mut self, accept: bool) -> Result<(), Error> {
        let Some(req) = self.pending_auth.take() else {
            return Ok(());
        };
        if !accept {
            return self.auth_failure();
        }
        if let AuthMethod::PublicKey { key, algorithm, signed: false } = &req.method {
            let mut w = Writer::msg(msg::USERAUTH_60);
            w.string(algorithm).string(key.to_blob());
            return self.transport.send(w.finish());
        }
        self.authenticated = true;
        self.user = Some(req.user);
        self.transport.send(vec![msg::USERAUTH_SUCCESS])
    }

    /// Client: requests a service (`ssh-userauth`).
    pub fn request_service(&mut self, name: &str) -> Result<(), Error> {
        let mut w = Writer::msg(msg::SERVICE_REQUEST);
        w.string(name);
        self.transport.send(w.finish())
    }

    /// The data a public key authentication signature covers.
    pub fn signing_data(&self, user: &str, algorithm: &str, blob: &[u8]) -> Result<Vec<u8>, Error> {
        let session_id = self.transport.session_id().ok_or_else(|| proto("no session"))?;
        let mut w = Writer::new();
        w.string(session_id)
            .u8(msg::USERAUTH_REQUEST)
            .string(user)
            .string("ssh-connection")
            .string("publickey")
            .bool(true)
            .string(algorithm)
            .string(blob);
        Ok(w.finish())
    }

    pub fn auth_none(&mut self, user: &str) -> Result<(), Error> {
        let mut w = Writer::msg(msg::USERAUTH_REQUEST);
        w.string(user).string("ssh-connection").string("none");
        self.transport.send(w.finish())
    }

    pub fn auth_password(&mut self, user: &str, password: &str) -> Result<(), Error> {
        let mut w = Writer::msg(msg::USERAUTH_REQUEST);
        w.string(user).string("ssh-connection").string("password").bool(false).string(password);
        self.transport.send(w.finish())
    }

    /// Client: a signed public key request (`signature` from
    /// [`Connection::signing_data`]).
    pub fn auth_publickey(
        &mut self,
        user: &str,
        algorithm: &str,
        blob: &[u8],
        signature: &[u8],
    ) -> Result<(), Error> {
        let mut w = Writer::msg(msg::USERAUTH_REQUEST);
        w.string(user)
            .string("ssh-connection")
            .string("publickey")
            .bool(true)
            .string(algorithm)
            .string(blob)
            .string(signature);
        self.transport.send(w.finish())
    }

    // ------------------------------------------------------------------
    // channels

    fn alloc_id(&mut self) -> Result<u32, Error> {
        if self.channels.len() >= self.cfg.max_channels {
            return Err(proto("too many channels"));
        }
        while self.channels.contains_key(&self.next_id) {
            self.next_id = self.next_id.wrapping_add(1);
        }
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        Ok(id)
    }

    fn new_chan(&self, remote_id: u32, open: bool, window: u32, max_packet: u32) -> Chan {
        Chan {
            remote_id,
            open,
            remote_window: window as u64,
            remote_max_packet: max_packet.clamp(1, 256 * 1024),
            local_remaining: self.cfg.window,
            consumed: 0,
            sent_eof: false,
            sent_close: false,
            recv_close: false,
            replies: VecDeque::new(),
        }
    }

    fn on_channel_open(&mut self, r: &mut Reader<'_>) -> Result<(), Error> {
        let kind = r.string()?.to_vec();
        let sender = r.u32()?;
        let window = r.u32()?;
        let max_packet = r.u32()?;
        let refuse = |this: &mut Connection, code: u32, text: &str| {
            let mut w = Writer::msg(msg::CHANNEL_OPEN_FAILURE);
            w.u32(sender).u32(code).string(text).string("");
            this.transport.send(w.finish())
        };
        if kind != b"session" || self.role() != Role::Server {
            return refuse(self, 1, "channel type not supported");
        }
        let Ok(id) = self.alloc_id() else {
            return refuse(self, 4, "too many channels");
        };
        let chan = self.new_chan(sender, true, window, max_packet);
        self.channels.insert(id, chan);
        let mut w = Writer::msg(msg::CHANNEL_OPEN_CONFIRMATION);
        w.u32(sender).u32(id).u32(self.cfg.window).u32(self.cfg.max_packet);
        self.transport.send(w.finish())?;
        self.events.push_back(ConnEvent::ChannelOpened(id));
        Ok(())
    }

    fn on_channel_request(&mut self, r: &mut Reader<'_>) -> Result<(), Error> {
        let id = r.u32()?;
        let name = r.string()?.to_vec();
        let want_reply = r.bool()?;
        let request = match name.as_slice() {
            b"exec" => Some(ChannelRequest::Exec { command: r.string()?.to_vec() }),
            b"pty-req" => {
                let term = r.text()?;
                let cols = r.u32()?;
                let rows = r.u32()?;
                Some(ChannelRequest::Pty { term, cols, rows })
            }
            b"env" => Some(ChannelRequest::Env { name: r.text()?, value: r.text()? }),
            b"shell" => Some(ChannelRequest::Shell),
            b"subsystem" => Some(ChannelRequest::Subsystem { name: r.text()? }),
            b"window-change" => {
                let cols = r.u32()?;
                let rows = r.u32()?;
                Some(ChannelRequest::WindowChange { cols, rows })
            }
            b"signal" => Some(ChannelRequest::Signal { name: r.text()? }),
            b"exit-status" => Some(ChannelRequest::ExitStatus { code: r.u32()? }),
            b"exit-signal" => Some(ChannelRequest::ExitSignal {
                name: r.text()?,
                core_dumped: r.bool()?,
                message: r.text().unwrap_or_default(),
                lang: r.text().unwrap_or_default(),
            }),
            _ => None,
        };
        let chan = self.chan_mut(id)?;
        if want_reply {
            if chan.replies.len() >= MAX_PENDING_REPLIES {
                return Err(proto("too many unanswered channel requests"));
            }
            chan.replies.push_back(if request.is_some() { None } else { Some(false) });
        }
        match request {
            Some(request) => {
                self.events
                    .push_back(ConnEvent::Channel(id, ChannelMsg::Request { request, want_reply }));
                Ok(())
            }
            None => self.flush_replies(id),
        }
    }

    fn flush_replies(&mut self, id: u32) -> Result<(), Error> {
        let Some(chan) = self.channels.get_mut(&id) else { return Ok(()) };
        let mut out = Vec::new();
        while let Some(Some(ok)) = chan.replies.front().copied() {
            chan.replies.pop_front();
            if !chan.sent_close {
                let mut w =
                    Writer::msg(if ok { msg::CHANNEL_SUCCESS } else { msg::CHANNEL_FAILURE });
                w.u32(chan.remote_id);
                out.push(w.finish());
            }
        }
        for p in out {
            self.transport.send(p)?;
        }
        Ok(())
    }

    /// Answers the oldest undecided request of channel `id`.
    pub fn reply(&mut self, id: u32, ok: bool) -> Result<(), Error> {
        let Some(chan) = self.channels.get_mut(&id) else { return Ok(()) };
        if let Some(slot) = chan.replies.iter_mut().find(|s| s.is_none()) {
            *slot = Some(ok);
        }
        self.flush_replies(id)
    }

    /// Client: opens a channel of `kind` (`extra`: type-specific data).
    pub fn open_channel(&mut self, kind: &str, extra: &[u8]) -> Result<u32, Error> {
        let id = self.alloc_id()?;
        let chan = self.new_chan(0, false, 0, 1);
        self.channels.insert(id, chan);
        let mut w = Writer::msg(msg::CHANNEL_OPEN);
        w.string(kind).u32(id).u32(self.cfg.window).u32(self.cfg.max_packet).raw(extra);
        self.transport.send(w.finish())?;
        Ok(id)
    }

    fn open_chan(&mut self, id: u32) -> Result<&mut Chan, Error> {
        match self.channels.get_mut(&id) {
            Some(c) if c.open && !c.sent_close => Ok(c),
            _ => Err(Error::Closed),
        }
    }

    /// Sends a channel request.
    pub fn channel_request(
        &mut self,
        id: u32,
        name: &str,
        want_reply: bool,
        data: &[u8],
    ) -> Result<(), Error> {
        let remote = self.open_chan(id)?.remote_id;
        let mut w = Writer::msg(msg::CHANNEL_REQUEST);
        w.u32(remote).string(name).bool(want_reply).raw(data);
        self.transport.send(w.finish())
    }

    /// Sends a typed channel request.
    pub fn request(
        &mut self,
        id: u32,
        request: &ChannelRequest,
        want_reply: bool,
    ) -> Result<(), Error> {
        let mut w = Writer::new();
        let name = match request {
            ChannelRequest::Exec { command } => {
                w.string(command);
                "exec"
            }
            ChannelRequest::Pty { term, cols, rows } => {
                w.string(term).u32(*cols).u32(*rows).u32(0).u32(0).string([0u8]);
                "pty-req"
            }
            ChannelRequest::Env { name, value } => {
                w.string(name).string(value);
                "env"
            }
            ChannelRequest::Shell => "shell",
            ChannelRequest::Subsystem { name } => {
                w.string(name);
                "subsystem"
            }
            ChannelRequest::WindowChange { cols, rows } => {
                w.u32(*cols).u32(*rows).u32(0).u32(0);
                "window-change"
            }
            ChannelRequest::Signal { name } => {
                w.string(name);
                "signal"
            }
            ChannelRequest::ExitStatus { code } => {
                w.u32(*code);
                "exit-status"
            }
            ChannelRequest::ExitSignal { name, core_dumped, message, lang } => {
                w.string(name).bool(*core_dumped).string(message).string(lang);
                "exit-signal"
            }
        };
        self.channel_request(id, name, want_reply, &w.finish())
    }

    /// Bytes we may send on channel `id` now.
    pub fn send_window(&self, id: u32) -> u64 {
        self.channels.get(&id).filter(|c| c.open).map_or(0, |c| c.remote_window)
    }

    /// Sends as much of `data` as the window allows; returns the bytes sent.
    pub fn send_data(&mut self, id: u32, ext: Option<u32>, data: &[u8]) -> Result<usize, Error> {
        let mut sent = 0;
        while sent < data.len() {
            let chan = self.open_chan(id)?;
            if chan.sent_eof {
                return Err(Error::Closed);
            }
            let n = (data.len() - sent)
                .min(chan.remote_window as usize)
                .min(chan.remote_max_packet as usize);
            if n == 0 {
                break;
            }
            chan.remote_window -= n as u64;
            let remote = chan.remote_id;
            let mut w = match ext {
                Some(ext) => {
                    let mut w = Writer::msg(msg::CHANNEL_EXTENDED_DATA);
                    w.u32(remote).u32(ext);
                    w
                }
                None => {
                    let mut w = Writer::msg(msg::CHANNEL_DATA);
                    w.u32(remote);
                    w
                }
            };
            w.string(&data[sent..sent + n]);
            self.transport.send(w.finish())?;
            sent += n;
        }
        Ok(sent)
    }

    /// The application took `n` bytes of channel data: advertise window.
    pub fn consumed(&mut self, id: u32, n: usize) -> Result<(), Error> {
        let target = self.cfg.window;
        let Some(chan) = self.channels.get_mut(&id) else { return Ok(()) };
        chan.consumed = chan.consumed.saturating_add(n as u32);
        if chan.sent_close || chan.recv_close {
            return Ok(());
        }
        if chan.local_remaining < target / 2 && chan.consumed > 0 {
            let add = chan.consumed.min(target - chan.local_remaining);
            chan.consumed -= add;
            chan.local_remaining += add;
            let mut w = Writer::msg(msg::CHANNEL_WINDOW_ADJUST);
            w.u32(chan.remote_id).u32(add);
            self.transport.send(w.finish())?;
        }
        Ok(())
    }

    pub fn eof(&mut self, id: u32) -> Result<(), Error> {
        let chan = self.open_chan(id)?;
        if chan.sent_eof {
            return Ok(());
        }
        chan.sent_eof = true;
        let mut w = Writer::msg(msg::CHANNEL_EOF);
        w.u32(chan.remote_id);
        self.transport.send(w.finish())
    }

    /// Closes channel `id` (idempotent); an unconfirmed channel is closed
    /// once its confirmation arrives.
    pub fn close(&mut self, id: u32) -> Result<(), Error> {
        let Some(chan) = self.channels.get_mut(&id) else { return Ok(()) };
        if chan.sent_close {
            return Ok(());
        }
        if !chan.open {
            // can't address it before the confirmation; refuse it then
            chan.sent_close = true;
            return Ok(());
        }
        chan.sent_close = true;
        let mut w = Writer::msg(msg::CHANNEL_CLOSE);
        w.u32(chan.remote_id);
        self.transport.send(w.finish())?;
        self.free(id);
        Ok(())
    }

    /// Whether channel `id` still exists (not freed).
    pub fn has_channel(&self, id: u32) -> bool {
        self.channels.contains_key(&id)
    }

    pub fn global_request(&mut self, name: &str, want_reply: bool) -> Result<(), Error> {
        let mut w = Writer::msg(msg::GLOBAL_REQUEST);
        w.string(name).bool(want_reply);
        self.transport.send(w.finish())
    }
}

//! Sans-io SSH transport layer (RFC 4253): version exchange, binary packet
//! protocol, key exchange (initial and rekeying), strict-kex (the Terrapin
//! countermeasure) and ext-info.
//!
//! Feed received bytes with [`Transport::input`], drain events with
//! [`Transport::poll`], send connection-layer payloads with
//! [`Transport::send`] and write [`Transport::take_output`] to the peer.

use std::collections::VecDeque;

use super::cipher::{self, PacketCipher};
use super::kex::{self, Ephemeral, HashInput, KexInit, Negotiated};
use super::keys::{PrivateKey, PublicKey, RSA_SHA256, RSA_SHA512};
use super::wire::{Reader, Writer};
use super::{Error, msg, reason};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Client,
    Server,
}

/// Transport configuration.
#[derive(Debug, Clone)]
pub struct TransportConfig {
    pub role: Role,
    /// identification string without CR LF (`SSH-2.0-...`)
    pub ident: String,
    /// server: host keys (one per type)
    pub host_keys: Vec<PrivateKey>,
    /// client: acceptable host key algorithms, preferred first
    pub host_key_algorithms: Vec<String>,
    /// bytes in either direction after which we start a new key exchange
    pub rekey_after_bytes: u64,
}

/// Host key signature algorithms a client accepts by default, preferred first.
pub const DEFAULT_HOST_KEY_ALGORITHMS: &[&str] = &[
    super::keys::ED25519,
    super::keys::ECDSA_P256,
    super::keys::ECDSA_P384,
    RSA_SHA512,
    RSA_SHA256,
];

impl TransportConfig {
    pub fn client(ident: &str) -> TransportConfig {
        TransportConfig {
            role: Role::Client,
            ident: ident.to_string(),
            host_keys: Vec::new(),
            host_key_algorithms: DEFAULT_HOST_KEY_ALGORITHMS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            rekey_after_bytes: 1 << 30,
        }
    }

    pub fn server(ident: &str, host_keys: Vec<PrivateKey>) -> TransportConfig {
        TransportConfig {
            role: Role::Server,
            ident: ident.to_string(),
            host_keys,
            host_key_algorithms: Vec::new(),
            rekey_after_bytes: 1 << 30,
        }
    }
}

/// What the transport hands up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The first key exchange finished. Client: the server's host key, to be
    /// verified before authenticating.
    Ready { host_key: Option<PublicKey> },
    /// A message for the layers above (service, userauth, connection,
    /// ext-info) with its sequence number.
    Message { seq: u32, payload: Vec<u8> },
}

enum KexState {
    /// no key exchange in progress
    Idle,
    /// our KEXINIT sent, the peer's not yet received
    Sent { ours: KexInit },
    /// both KEXINITs exchanged; client: waiting for the ECDH reply
    Running { ours: KexInit, theirs: KexInit, neg: Negotiated, eph: Option<Ephemeral> },
    /// our NEWKEYS sent; the peer's switches the receiving direction
    AwaitNewKeys { recv: PacketCipher },
}

/// Maximum bytes before the identification line (other lines from servers).
const MAX_PREAMBLE: usize = 64 * 1024;

pub struct Transport {
    cfg: TransportConfig,
    inbuf: Vec<u8>,
    in_off: usize,
    out: Vec<u8>,
    local_ident: Vec<u8>,
    remote_ident: Option<Vec<u8>>,
    preamble: usize,
    send_cipher: PacketCipher,
    recv_cipher: PacketCipher,
    send_seq: u32,
    recv_seq: u32,
    sent_since_kex: u64,
    recv_since_kex: u64,
    session_id: Option<Vec<u8>>,
    kex: KexState,
    /// payloads sent during a key exchange, flushed after our NEWKEYS
    queued: VecDeque<Vec<u8>>,
    strict: bool,
    /// the first key exchange completed (both NEWKEYS)
    ready: bool,
    /// packets received so far (strict kex: KEXINIT must be the first)
    received_packets: u64,
    /// server: the client asked for ext-info (`ext-info-c`)
    peer_ext_info: bool,
    /// the host key of the first exchange (client: must not change on rekey)
    host_key: Option<PublicKey>,
    /// the peer's wrongly guessed kex packet to skip
    skip_guess: bool,
    /// completed key exchanges
    exchanges: u32,
    events: VecDeque<Event>,
    closed: Option<Error>,
}

impl Transport {
    pub fn new(cfg: TransportConfig) -> Result<Transport, Error> {
        let local_ident = cfg.ident.as_bytes().to_vec();
        let mut t = Transport {
            cfg,
            inbuf: Vec::new(),
            in_off: 0,
            out: Vec::new(),
            local_ident,
            remote_ident: None,
            preamble: 0,
            send_cipher: PacketCipher::none(),
            recv_cipher: PacketCipher::none(),
            send_seq: 0,
            recv_seq: 0,
            sent_since_kex: 0,
            recv_since_kex: 0,
            session_id: None,
            kex: KexState::Idle,
            queued: VecDeque::new(),
            strict: false,
            ready: false,
            received_packets: 0,
            peer_ext_info: false,
            host_key: None,
            skip_guess: false,
            exchanges: 0,
            events: VecDeque::new(),
            closed: None,
        };
        if t.cfg.role == Role::Server && t.cfg.host_keys.is_empty() {
            return Err(Error::Key("server without host keys".into()));
        }
        t.out.extend_from_slice(&t.local_ident);
        t.out.extend_from_slice(b"\r\n");
        t.start_kex()?;
        Ok(t)
    }

    pub fn role(&self) -> Role {
        self.cfg.role
    }

    /// The session identifier (`H` of the first exchange).
    pub fn session_id(&self) -> Option<&[u8]> {
        self.session_id.as_deref()
    }

    /// Whether the first key exchange completed.
    pub fn is_ready(&self) -> bool {
        self.ready
    }

    /// Completed key exchanges (the first one and rekeys).
    pub fn key_exchanges(&self) -> u32 {
        self.exchanges
    }

    /// The peer's identification string.
    pub fn remote_ident(&self) -> Option<&[u8]> {
        self.remote_ident.as_deref()
    }

    pub fn input(&mut self, data: &[u8]) {
        if self.in_off > 0 && self.in_off == self.inbuf.len() {
            self.inbuf.clear();
            self.in_off = 0;
        } else if self.in_off > 64 * 1024 && self.in_off * 2 > self.inbuf.len() {
            self.inbuf.drain(..self.in_off);
            self.in_off = 0;
        }
        self.inbuf.extend_from_slice(data);
    }

    /// Unprocessed input in `bytes`.
    pub fn buffered_input(&self) -> usize {
        self.inbuf.len() - self.in_off
    }

    pub fn has_output(&self) -> bool {
        !self.out.is_empty()
    }

    pub fn output_len(&self) -> usize {
        self.out.len()
    }

    pub fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.out)
    }

    /// Sends a connection-layer payload (queued during a key exchange).
    pub fn send(&mut self, payload: Vec<u8>) -> Result<(), Error> {
        if let Some(e) = &self.closed {
            return Err(e.clone());
        }
        if matches!(self.kex, KexState::Idle | KexState::AwaitNewKeys { .. })
            && self.queued.is_empty()
        {
            self.write_packet(&payload);
            self.maybe_rekey()?;
        } else {
            self.queued.push_back(payload);
        }
        Ok(())
    }

    /// Queues `SSH_MSG_DISCONNECT` and closes the transport.
    pub fn disconnect(&mut self, code: u32, description: &str) {
        if self.closed.is_some() {
            return;
        }
        let mut w = Writer::msg(msg::DISCONNECT);
        w.u32(code).string(description).string("");
        self.write_packet(&w.finish());
        self.closed = Some(Error::Closed);
    }

    /// Answers a message the layers above do not implement.
    pub fn unimplemented(&mut self, seq: u32) {
        let mut w = Writer::msg(msg::UNIMPLEMENTED);
        w.u32(seq);
        let _ = self.send(w.finish());
    }

    fn write_packet(&mut self, payload: &[u8]) {
        self.send_cipher.seal(self.send_seq, payload, &mut self.out);
        self.send_seq = self.send_seq.wrapping_add(1);
        self.sent_since_kex += payload.len() as u64;
    }

    fn host_key_names(&self) -> Vec<String> {
        match self.cfg.role {
            Role::Client => self.cfg.host_key_algorithms.clone(),
            Role::Server => {
                let mut names = Vec::new();
                for key in &self.cfg.host_keys {
                    for alg in key.signature_algorithms() {
                        if !names.iter().any(|n: &String| n == alg) {
                            names.push(alg.to_string());
                        }
                    }
                }
                names
            }
        }
    }

    fn start_kex(&mut self) -> Result<(), Error> {
        if !matches!(self.kex, KexState::Idle) {
            return Ok(());
        }
        let mut algs: Vec<&str> = kex::KEX_ALGORITHMS.to_vec();
        if self.session_id.is_none() {
            match self.cfg.role {
                Role::Client => algs.extend([kex::EXT_INFO_C, kex::STRICT_C]),
                Role::Server => algs.push(kex::STRICT_S),
            }
        }
        let ours = KexInit::build(&algs, &self.host_key_names())?;
        self.write_packet(&ours.raw);
        self.kex = KexState::Sent { ours };
        Ok(())
    }

    fn maybe_rekey(&mut self) -> Result<(), Error> {
        let limit = self.cfg.rekey_after_bytes;
        if self.ready
            && matches!(self.kex, KexState::Idle)
            && (self.sent_since_kex >= limit || self.recv_since_kex >= limit)
        {
            self.start_kex()?;
        }
        Ok(())
    }

    /// Processes buffered input until an event is available or more input is
    /// needed. Errors are final (a DISCONNECT is queued where appropriate).
    pub fn poll(&mut self) -> Result<Option<Event>, Error> {
        if let Some(ev) = self.events.pop_front() {
            return Ok(Some(ev));
        }
        if let Some(e) = &self.closed {
            return Err(e.clone());
        }
        match self.poll_inner() {
            Ok(()) => Ok(self.events.pop_front()),
            Err(e) => {
                let code = match &e {
                    Error::Negotiation(_) => reason::KEY_EXCHANGE_FAILED,
                    _ => reason::PROTOCOL_ERROR,
                };
                if !matches!(e, Error::Disconnected(_)) {
                    let text = e.to_string();
                    self.disconnect(code, &text);
                }
                self.closed = Some(e.clone());
                Err(e)
            }
        }
    }

    fn poll_inner(&mut self) -> Result<(), Error> {
        if self.remote_ident.is_none() && !self.read_ident()? {
            return Ok(());
        }
        while self.events.is_empty() {
            let seq = self.recv_seq;
            let opened = self.recv_cipher.open(seq, &mut self.inbuf[self.in_off..])?;
            let Some((payload, used)) = opened else { return Ok(()) };
            self.in_off += used;
            self.recv_seq = self.recv_seq.wrapping_add(1);
            self.recv_since_kex += payload.len() as u64;
            self.received_packets += 1;
            self.handle_packet(seq, payload)?;
            self.maybe_rekey()?;
        }
        Ok(())
    }

    fn read_ident(&mut self) -> Result<bool, Error> {
        loop {
            let pending = &self.inbuf[self.in_off..];
            let Some(nl) = pending.iter().position(|&b| b == b'\n') else {
                if pending.len() > 8192 || self.preamble + pending.len() > MAX_PREAMBLE {
                    return Err(Error::Protocol("identification line too long".into()));
                }
                return Ok(false);
            };
            let mut line = &pending[..nl];
            if let [rest @ .., b'\r'] = line {
                line = rest;
            }
            let line = line.to_vec();
            self.in_off += nl + 1;
            self.preamble += nl + 1;
            if line.starts_with(b"SSH-") {
                if !(line.starts_with(b"SSH-2.0-") || line.starts_with(b"SSH-1.99-")) {
                    return Err(Error::Protocol("unsupported protocol version".into()));
                }
                self.remote_ident = Some(line);
                return Ok(true);
            }
            if self.cfg.role == Role::Server {
                return Err(Error::Protocol("invalid identification string".into()));
            }
            if self.preamble > MAX_PREAMBLE {
                return Err(Error::Protocol("identification line not found".into()));
            }
        }
    }

    fn in_initial_kex(&self) -> bool {
        !self.ready
    }

    fn handle_packet(&mut self, seq: u32, payload: Vec<u8>) -> Result<(), Error> {
        let Some(&kind) = payload.first() else {
            return Err(Error::Protocol("empty packet".into()));
        };
        if self.received_packets == 1 && kind != msg::KEXINIT {
            // required for strict kex; every implementation starts with KEXINIT
            return Err(Error::Protocol(format!("expected KEXINIT, got message {kind}")));
        }
        let is_kex = matches!(kind, msg::KEXINIT | msg::NEWKEYS | 30..=49);
        if self.strict && self.in_initial_kex() && !is_kex {
            return Err(Error::Protocol(format!(
                "unexpected message {kind} during strict key exchange"
            )));
        }
        if self.skip_guess && matches!(kind, 30..=49) {
            self.skip_guess = false;
            return Ok(());
        }
        match kind {
            msg::DISCONNECT => {
                let mut r = Reader::new(&payload[1..]);
                let _code = r.u32().unwrap_or(0);
                let text = r.text().unwrap_or_default();
                Err(Error::Disconnected(text))
            }
            msg::IGNORE | msg::DEBUG | msg::UNIMPLEMENTED => Ok(()),
            msg::KEXINIT => self.on_kexinit(&payload),
            msg::KEX_ECDH_INIT if self.cfg.role == Role::Server => self.on_ecdh_init(&payload),
            msg::KEX_ECDH_REPLY if self.cfg.role == Role::Client => self.on_ecdh_reply(&payload),
            msg::NEWKEYS => self.on_newkeys(),
            8..=49 => {
                if self.in_initial_kex() {
                    return Err(Error::Protocol(format!("unexpected message {kind}")));
                }
                self.unimplemented(seq);
                Ok(())
            }
            _ => {
                if !self.ready {
                    return Err(Error::Protocol(format!("message {kind} before key exchange")));
                }
                self.events.push_back(Event::Message { seq, payload });
                Ok(())
            }
        }
    }

    fn on_kexinit(&mut self, payload: &[u8]) -> Result<(), Error> {
        if matches!(self.kex, KexState::Idle) {
            self.start_kex()?;
        }
        let ours = match std::mem::replace(&mut self.kex, KexState::Idle) {
            KexState::Sent { ours } => ours,
            _ => return Err(Error::Protocol("unexpected KEXINIT".into())),
        };
        let theirs = KexInit::parse(payload)?;
        let server = self.cfg.role == Role::Server;
        let (client_init, server_init) = if server { (&theirs, &ours) } else { (&ours, &theirs) };
        let neg = kex::negotiate(client_init, server_init, server)?;
        if self.session_id.is_none() {
            let (mine, peer) = if server {
                (kex::STRICT_S, kex::STRICT_C)
            } else {
                (kex::STRICT_C, kex::STRICT_S)
            };
            self.strict =
                ours.kex.iter().any(|k| k == mine) && theirs.kex.iter().any(|k| k == peer);
            if server {
                self.peer_ext_info = theirs.kex.iter().any(|k| k == kex::EXT_INFO_C);
            }
        }
        self.skip_guess = neg.ignore_guess;
        let eph = if server {
            None
        } else {
            let eph = Ephemeral::new(&neg.kex)?;
            let mut w = Writer::msg(msg::KEX_ECDH_INIT);
            w.string(&eph.public);
            self.write_packet(&w.finish());
            Some(eph)
        };
        self.kex = KexState::Running { ours, theirs, neg, eph };
        Ok(())
    }

    fn host_key_for(&self, alg: &str) -> Result<PrivateKey, Error> {
        self.cfg
            .host_keys
            .iter()
            .find(|k| k.signature_algorithms().contains(&alg))
            .cloned()
            .ok_or_else(|| Error::Negotiation(format!("no host key for {alg}")))
    }

    fn on_ecdh_init(&mut self, payload: &[u8]) -> Result<(), Error> {
        let KexState::Running { ours, theirs, neg, .. } =
            std::mem::replace(&mut self.kex, KexState::Idle)
        else {
            return Err(Error::Protocol("unexpected KEX_ECDH_INIT".into()));
        };
        let mut r = Reader::new(&payload[1..]);
        let q_c = r.string()?;
        let eph = Ephemeral::new(&neg.kex)?;
        let q_s = eph.public.clone();
        let (k, hash) = eph.agree(q_c)?;
        let host_key = self.host_key_for(&neg.host_key)?;
        let k_s = host_key.public_key().to_blob();
        let remote = self.remote_ident.clone().unwrap_or_default();
        let h = kex::exchange_hash(
            hash,
            &HashInput {
                v_c: &remote,
                v_s: &self.local_ident,
                i_c: &theirs.raw,
                i_s: &ours.raw,
                k_s: &k_s,
                q_c,
                q_s: &q_s,
                k: &k,
            },
        );
        let sig = host_key.sign(&neg.host_key, &h)?;
        let mut w = Writer::msg(msg::KEX_ECDH_REPLY);
        w.string(&k_s).string(&q_s).string(&sig);
        self.write_packet(&w.finish());
        self.finish_kex(&neg, hash, &k, &h)
    }

    fn on_ecdh_reply(&mut self, payload: &[u8]) -> Result<(), Error> {
        let KexState::Running { ours, theirs, neg, eph: Some(eph) } =
            std::mem::replace(&mut self.kex, KexState::Idle)
        else {
            return Err(Error::Protocol("unexpected KEX_ECDH_REPLY".into()));
        };
        let mut r = Reader::new(&payload[1..]);
        let k_s = r.string()?;
        let q_s = r.string()?;
        let sig = r.string()?;
        let host_key = PublicKey::from_blob(k_s)
            .map_err(|e| Error::Protocol(format!("unusable host key: {e}")))?;
        if let Some(first) = &self.host_key
            && first != &host_key
        {
            return Err(Error::Protocol("host key changed during rekey".into()));
        }
        let q_c = eph.public.clone();
        let (k, hash) = eph.agree(q_s)?;
        let remote = self.remote_ident.clone().unwrap_or_default();
        let h = kex::exchange_hash(
            hash,
            &HashInput {
                v_c: &self.local_ident,
                v_s: &remote,
                i_c: &ours.raw,
                i_s: &theirs.raw,
                k_s,
                q_c: &q_c,
                q_s,
                k: &k,
            },
        );
        host_key.verify(&neg.host_key, &h, sig)?;
        self.host_key = Some(host_key);
        self.finish_kex(&neg, hash, &k, &h)
    }

    /// Derives the new keys, sends NEWKEYS and switches the sending direction.
    fn finish_kex(
        &mut self,
        neg: &Negotiated,
        hash: &'static ring::digest::Algorithm,
        k: &[u8],
        h: &[u8],
    ) -> Result<(), Error> {
        let session_id = self.session_id.get_or_insert_with(|| h.to_vec()).clone();
        let client = self.cfg.role == Role::Client;
        let key = |letter: u8, len: usize| kex::derive(hash, k, h, letter, &session_id, len);
        let (c2s_key, c2s_iv) = cipher::key_sizes(&neg.enc_c2s);
        let (s2c_key, s2c_iv) = cipher::key_sizes(&neg.enc_s2c);
        let c2s = PacketCipher::new(&neg.enc_c2s, &key(b'C', c2s_key), &key(b'A', c2s_iv), client)?;
        let s2c =
            PacketCipher::new(&neg.enc_s2c, &key(b'D', s2c_key), &key(b'B', s2c_iv), !client)?;
        let (send, recv) = if client { (c2s, s2c) } else { (s2c, c2s) };

        self.write_packet(&[msg::NEWKEYS]);
        self.send_cipher = send;
        if self.strict {
            self.send_seq = 0;
        }
        self.sent_since_kex = 0;
        if !self.ready && self.cfg.role == Role::Server && self.peer_ext_info {
            let mut w = Writer::msg(msg::EXT_INFO);
            w.u32(1).string("server-sig-algs").name_list(&[
                super::keys::ED25519,
                super::keys::ECDSA_P256,
                super::keys::ECDSA_P384,
                RSA_SHA512,
                RSA_SHA256,
            ]);
            self.write_packet(&w.finish());
        }
        while let Some(p) = self.queued.pop_front() {
            self.write_packet(&p);
        }
        self.kex = KexState::AwaitNewKeys { recv };
        Ok(())
    }

    fn on_newkeys(&mut self) -> Result<(), Error> {
        let KexState::AwaitNewKeys { recv } = std::mem::replace(&mut self.kex, KexState::Idle)
        else {
            return Err(Error::Protocol("unexpected NEWKEYS".into()));
        };
        self.recv_cipher = recv;
        if self.strict {
            self.recv_seq = 0;
        }
        self.recv_since_kex = 0;
        self.exchanges += 1;
        if !self.ready {
            self.ready = true;
            self.events.push_back(Event::Ready { host_key: self.host_key.clone() });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shuttles bytes between two transports until neither has output.
    fn pump(a: &mut Transport, b: &mut Transport) -> (Vec<Event>, Vec<Event>) {
        let (mut ea, mut eb) = (Vec::new(), Vec::new());
        for _ in 0..100 {
            let (oa, ob) = (a.take_output(), b.take_output());
            if oa.is_empty() && ob.is_empty() {
                break;
            }
            b.input(&oa);
            a.input(&ob);
            while let Some(e) = a.poll().unwrap() {
                ea.push(e);
            }
            while let Some(e) = b.poll().unwrap() {
                eb.push(e);
            }
        }
        (ea, eb)
    }

    fn pair(rekey: u64) -> (Transport, Transport, PrivateKey) {
        let host = PrivateKey::from_ed25519_seed(&[5; 32]);
        let mut cc = TransportConfig::client("SSH-2.0-test-client");
        cc.rekey_after_bytes = rekey;
        let mut sc = TransportConfig::server("SSH-2.0-test-server", vec![host.clone()]);
        sc.rekey_after_bytes = rekey;
        (Transport::new(cc).unwrap(), Transport::new(sc).unwrap(), host)
    }

    #[test]
    fn handshake_and_messages() {
        let (mut c, mut s, host) = pair(1 << 30);
        let (ec, es) = pump(&mut c, &mut s);
        assert_eq!(ec[0], Event::Ready { host_key: Some(host.public_key().clone()) });
        assert!(matches!(&ec[1], Event::Message { payload, .. } if payload[0] == msg::EXT_INFO));
        assert_eq!(es, vec![Event::Ready { host_key: None }]);
        assert!(c.strict && s.strict);
        c.send(vec![msg::SERVICE_REQUEST, 1, 2, 3]).unwrap();
        let (_, es) = pump(&mut c, &mut s);
        assert!(
            matches!(&es[..], [Event::Message { payload, .. }] if payload == &[msg::SERVICE_REQUEST, 1, 2, 3])
        );
        assert_eq!(c.session_id(), s.session_id());
    }

    #[test]
    fn rekeys_after_the_byte_limit() {
        let (mut c, mut s, _) = pair(100_000);
        pump(&mut c, &mut s);
        let session_id = c.session_id().unwrap().to_vec();
        let mut received = 0;
        for i in 0..200u32 {
            c.send(vec![94; 1000 + (i as usize % 7)]).unwrap();
            s.send(vec![94; 900]).unwrap();
            let (ec, es) = pump(&mut c, &mut s);
            received += ec.len() + es.len();
        }
        assert_eq!(received, 400);
        assert_eq!(c.session_id().unwrap(), session_id.as_slice());
        assert!(c.send_seq < 200, "strict kex resets sequence numbers on rekey");
    }

    #[test]
    fn garbage_is_an_error() {
        let (_, mut s, _) = pair(1 << 30);
        s.input(b"SSH-2.0-x\r\n\x00\x00\x00\x0c\x0a\x15");
        s.input(&[0xff; 64]);
        assert!(s.poll().is_err());
        let (_, mut s, _) = pair(1 << 30);
        s.input(b"GET / HTTP/1.1\r\n");
        assert!(s.poll().is_err());
    }

    #[test]
    fn non_kex_message_first_is_rejected() {
        let (mut c, mut s, _) = pair(1 << 30);
        // drop the client's KEXINIT, deliver an IGNORE instead
        let out = c.take_output();
        let ident_end = out.iter().position(|&b| b == b'\n').unwrap() + 1;
        s.input(&out[..ident_end]);
        let mut p = Vec::new();
        PacketCipher::none().seal(0, &[msg::IGNORE, 0, 0, 0, 0], &mut p);
        s.input(&p);
        assert!(s.poll().is_err());
    }
}

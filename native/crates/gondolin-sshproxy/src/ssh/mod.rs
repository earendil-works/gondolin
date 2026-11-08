//! A small exec-oriented SSH implementation over ring (RFC 4250–4254).
//!
//! - [`transport`]: sans-io transport layer (version exchange, binary packet
//!   protocol, curve25519/ECDH key exchange with strict-kex, AEAD ciphers,
//!   rekeying, ext-info)
//! - [`connection`]: sans-io user authentication and connection protocol
//!   (session channels with consumption-based windows)
//! - [`session`]: the tokio adapter (client and server connections, channels)
//! - [`keys`], [`keyfile`], [`agent`]: keys, key files, ssh-agent client
//!
//! Algorithms: kex `curve25519-sha256`, `ecdh-sha2-nistp256/384`; host keys
//! `ssh-ed25519`, `ecdsa-sha2-nistp256/384`, `rsa-sha2-256/512`; ciphers
//! `chacha20-poly1305@openssh.com`, `aes128/256-gcm@openssh.com`; no
//! compression. Shells, subsystems and forwarding are the application's
//! business (the proxy refuses them).

pub mod agent;
pub mod connection;
pub mod crypto;
pub mod der;
pub mod keyfile;
pub mod keys;
pub mod session;
pub mod transport;
pub mod wire;

mod cipher;
mod kex;

pub use keyfile::decode_secret_key;
pub use keys::{PrivateKey, PublicKey};

/// SSH message numbers.
pub mod msg {
    pub const DISCONNECT: u8 = 1;
    pub const IGNORE: u8 = 2;
    pub const UNIMPLEMENTED: u8 = 3;
    pub const DEBUG: u8 = 4;
    pub const SERVICE_REQUEST: u8 = 5;
    pub const SERVICE_ACCEPT: u8 = 6;
    pub const EXT_INFO: u8 = 7;
    pub const KEXINIT: u8 = 20;
    pub const NEWKEYS: u8 = 21;
    pub const KEX_ECDH_INIT: u8 = 30;
    pub const KEX_ECDH_REPLY: u8 = 31;
    pub const USERAUTH_REQUEST: u8 = 50;
    pub const USERAUTH_FAILURE: u8 = 51;
    pub const USERAUTH_SUCCESS: u8 = 52;
    pub const USERAUTH_BANNER: u8 = 53;
    /// `SSH_MSG_USERAUTH_PK_OK` and `SSH_MSG_USERAUTH_INFO_REQUEST`
    pub const USERAUTH_60: u8 = 60;
    pub const USERAUTH_INFO_RESPONSE: u8 = 61;
    pub const GLOBAL_REQUEST: u8 = 80;
    pub const REQUEST_SUCCESS: u8 = 81;
    pub const REQUEST_FAILURE: u8 = 82;
    pub const CHANNEL_OPEN: u8 = 90;
    pub const CHANNEL_OPEN_CONFIRMATION: u8 = 91;
    pub const CHANNEL_OPEN_FAILURE: u8 = 92;
    pub const CHANNEL_WINDOW_ADJUST: u8 = 93;
    pub const CHANNEL_DATA: u8 = 94;
    pub const CHANNEL_EXTENDED_DATA: u8 = 95;
    pub const CHANNEL_EOF: u8 = 96;
    pub const CHANNEL_CLOSE: u8 = 97;
    pub const CHANNEL_REQUEST: u8 = 98;
    pub const CHANNEL_SUCCESS: u8 = 99;
    pub const CHANNEL_FAILURE: u8 = 100;
}

/// Disconnect reason codes (RFC 4250 section 4.2.2).
pub mod reason {
    pub const PROTOCOL_ERROR: u32 = 2;
    pub const KEY_EXCHANGE_FAILED: u32 = 3;
    pub const MAC_ERROR: u32 = 5;
    pub const SERVICE_NOT_AVAILABLE: u32 = 7;
    pub const HOST_KEY_NOT_VERIFIABLE: u32 = 9;
    pub const BY_APPLICATION: u32 = 11;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// the peer violated the protocol (or sent garbage)
    Protocol(String),
    /// no common algorithm
    Negotiation(String),
    /// a key could not be parsed or used
    Key(String),
    /// the peer disconnected (`SSH_MSG_DISCONNECT` description)
    Disconnected(String),
    /// transport I/O failed
    Io(String),
    /// the connection is closed
    Closed,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Protocol(m) => write!(f, "ssh protocol error: {m}"),
            Error::Negotiation(m) => write!(f, "ssh negotiation failed: {m}"),
            Error::Key(m) => write!(f, "{m}"),
            Error::Disconnected(m) if m.is_empty() => write!(f, "disconnected by peer"),
            Error::Disconnected(m) => write!(f, "disconnected by peer: {m}"),
            Error::Io(m) => write!(f, "{m}"),
            Error::Closed => write!(f, "connection closed"),
        }
    }
}

impl std::error::Error for Error {}

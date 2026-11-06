//! Sandbox clients: the `SandboxConnection` API of the node engine
//! (`host/src/sandbox/control-protocol.ts`), carried as CBOR with byte strings.
//!
//! The SDK multiplexes its connections (the VM itself, attached `gondolin
//! attach` sessions) as numbered *clients*. Client messages keep the field
//! names and semantics of `control-protocol.ts` and add `client`; the daemon
//! validates them exactly like `SandboxServer` does (exec ids are uint32 and
//! global across clients, errors go back to the sending client).
//!
//! | dir | type | payload |
//! |---|---|---|
//! | c→d | `client_open` | [`ClientRef`] |
//! | c→d | `client_close` | [`ClientRef`]: drops the client's execs (they keep running in the guest) |
//! | c→d | `boot` | [`Boot`]: boot (or reboot with a changed configuration) the VM |
//! | c→d | `exec` | [`Exec`] |
//! | c→d | `stdin` | [`Stdin`] |
//! | c→d | `pty_resize` | [`PtyResize`] |
//! | c→d | `exec_window` | [`ExecWindow`] |
//! | c→d | `lifecycle` | [`Lifecycle`] |
//! | c→d | `client_unknown` | [`ClientUnknown`]: a client message of another type (answered with `unknown_type`) |
//! | d→c | `client_status` | [`ClientStatus`]: status sent to one client |
//! | d→c | `client_error` | [`ClientError`] |
//! | d→c | `client_closed` | [`ClientRef`]: the daemon closed the client |
//! | d→c | `exec_output` | [`ExecOutput`] |
//! | d→c | `exec_response` | [`ExecResponse`] |
//!
//! Field types are validated leniently by the daemon (a wrongly typed field is
//! an `invalid_request` client error, not a protocol error), so the structs
//! below describe well-formed messages.

use serde::{Deserialize, Serialize};

use crate::session::State;

pub const CLIENT_OPEN: &str = "client_open";
pub const CLIENT_CLOSE: &str = "client_close";
pub const BOOT: &str = "boot";
pub const EXEC: &str = "exec";
pub const STDIN: &str = "stdin";
pub const PTY_RESIZE: &str = "pty_resize";
pub const EXEC_WINDOW: &str = "exec_window";
pub const LIFECYCLE: &str = "lifecycle";
pub const CLIENT_UNKNOWN: &str = "client_unknown";
pub const CLIENT_STATUS: &str = "client_status";
pub const CLIENT_ERROR: &str = "client_error";
pub const CLIENT_CLOSED: &str = "client_closed";
pub const EXEC_OUTPUT: &str = "exec_output";
pub const EXEC_RESPONSE: &str = "exec_response";

/// Client number chosen by the controller.
pub type ClientId = u32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientRef {
    pub client: ClientId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Boot {
    pub client: ClientId,
    /// guest mountpoint of the sandboxfs FUSE mount (default `/data`)
    #[serde(rename = "fuseMount", default, skip_serializing_if = "Option::is_none")]
    pub fuse_mount: Option<String>,
    /// guest paths bind-mounted from the FUSE mount
    #[serde(rename = "fuseBinds", default, skip_serializing_if = "Option::is_none")]
    pub fuse_binds: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Exec {
    pub client: ClientId,
    /// exec id (uint32, unique among running execs)
    pub id: u32,
    pub cmd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argv: Option<Vec<String>>,
    /// `KEY=VALUE` entries
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty: Option<bool>,
    /// initial stdout credit in `bytes` (0 = guest default)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_window: Option<u32>,
    /// initial stderr credit in `bytes` (0 = guest default)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_window: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stdin {
    pub client: ClientId,
    pub id: u32,
    #[serde(with = "serde_bytes", default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eof: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyResize {
    pub client: ClientId,
    pub id: u32,
    pub rows: u32,
    pub cols: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecWindow {
    pub client: ClientId,
    pub id: u32,
    /// additional stdout credit in `bytes`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout: Option<u32>,
    /// additional stderr credit in `bytes`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lifecycle {
    pub client: ClientId,
    /// `restart` or `shutdown` (stops the VM, not the daemon)
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientUnknown {
    pub client: ClientId,
    /// the client message's `type`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientStatus {
    pub client: ClientId,
    pub state: State,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientError {
    pub client: ClientId,
    /// exec id the error belongs to (absent for request-level errors)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u32>,
    pub code: String,
    pub message: String,
}

/// Output stream of an exec.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
}

impl Stream {
    pub fn as_str(self) -> &'static str {
        match self {
            Stream::Stdout => "stdout",
            Stream::Stderr => "stderr",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecOutput {
    pub client: ClientId,
    pub id: u32,
    pub stream: Stream,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecResponse {
    pub client: ClientId,
    pub id: u32,
    pub exit_code: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Envelope, RawEnvelope};
    use gondolin_wire::{decode, encode};

    #[test]
    fn exec_round_trip() {
        let exec = Exec {
            client: 1,
            id: 7,
            cmd: "/bin/sh".into(),
            argv: Some(vec!["-c".into(), "true".into()]),
            env: None,
            cwd: None,
            stdin: Some(true),
            pty: None,
            stdout_window: Some(0),
            stderr_window: None,
        };
        let bytes = encode(&Envelope::new(EXEC, 0, &exec)).unwrap();
        assert!(!bytes.windows(3).any(|w| w == b"env"));
        let env: RawEnvelope = decode(&bytes).unwrap();
        assert_eq!(env.payload::<Exec>().unwrap(), exec);
    }

    #[test]
    fn output_is_byte_string() {
        let out = ExecOutput { client: 1, id: 2, stream: Stream::Stderr, data: vec![9, 8, 7] };
        let bytes = encode(&out).unwrap();
        assert!(bytes.windows(4).any(|w| w == [0x43, 9, 8, 7]));
        assert_eq!(decode::<ExecOutput>(&bytes).unwrap(), out);
    }
}

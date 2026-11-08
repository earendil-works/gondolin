//! Controller <-> gondolind protocol (`native/DESIGN.md`, "Controller ⇄ daemon
//! protocol"). Messages are grouped by area; each area owns its module:
//!
//! - [`session`]: handshake, configuration, VM lifecycle, status/log/exit events
//! - [`exec`]: sandbox clients (the `SandboxConnection` API of the node engine):
//!   boot, exec, stdin, pty resize, output windows
//! - [`files`]: guest file operations used by `vm.fs`
//!
//! The VFS and network areas add their own modules (`vfs`, `net`).
//!
//! Conventions: every frame is a `{ v, t, id, p }` envelope ([`gondolin_wire`]).
//! Requests carry a non-zero `id` and are answered by `<t>_result` with the same
//! `id` and a payload of `{ ok: true, ... }` or `{ ok: false, code, message }`
//! ([`ResultError`]). Byte payloads are CBOR byte strings.

pub mod exec;
pub mod files;
pub mod net;
pub mod session;
pub mod vfs;

pub use gondolin_wire::{Envelope, RawEnvelope, Value};

/// Protocol version carried in every envelope (`v`) and in `hello`.
pub const PROTOCOL_VERSION: u32 = 1;

/// Suffix of response message types (`configure` -> `configure_result`).
pub const RESULT_SUFFIX: &str = "_result";

/// Returns the response type for request type `t`.
pub fn result_type(t: &str) -> String {
    format!("{t}{RESULT_SUFFIX}")
}

gondolin_wire::wire_struct! {
    /// Payload of a failed request (`<t>_result` with `ok: false`).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ResultError {
        /// always `false`
        pub ok: bool,
        /// stable error code (`invalid_request`, `unsupported`, ...)
        pub code: String,
        /// human-readable message; for file operations the exact error message the
        /// SDK surfaces
        pub message: String,
    }
}

impl std::fmt::Display for ResultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ResultError {}

impl ResultError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        ResultError { ok: false, code: code.into(), message: message.into() }
    }
}

gondolin_wire::wire_struct! {
    /// Payload of a successful request without further fields.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ResultOk {
        /// always `true`
        pub ok: bool,
    }
}

impl ResultOk {
    pub const fn new() -> Self {
        ResultOk { ok: true }
    }
}

impl Default for ResultOk {
    fn default() -> Self {
        Self::new()
    }
}

gondolin_wire::wire_struct! {
    /// Unsolicited `error` message (d→c). Also the answer to unknown message types
    /// (`code: "unsupported"`), with `id` set to the id of the offending message.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ErrorEvent {
        /// stable error code
        pub code: String,
        /// human-readable message
        pub message: String,
        /// message type that caused the error, when it was a reply to a message
        pub r#type: Option<String>,
    }
}

/// Inserts `ok: true` into a payload map (for results with extra fields).
pub fn ok_with(mut fields: Vec<(Value, Value)>) -> Value {
    fields.insert(0, (Value::Text("ok".into()), Value::Bool(true)));
    Value::Map(fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gondolin_wire::{decode, encode};

    #[test]
    fn result_shapes() {
        let err = ResultError::new("unsupported", "nope");
        let bytes = encode(&Envelope::new(result_type("configure"), 3, &err)).unwrap();
        let env: RawEnvelope = decode(&bytes).unwrap();
        assert_eq!(env.t, "configure_result");
        let back: ResultError = env.payload().unwrap();
        assert!(!back.ok);
        assert_eq!(back.code, "unsupported");

        let ok = ok_with(vec![(Value::Text("pid".into()), Value::Integer(5.into()))]);
        let map = ok.as_map().unwrap();
        assert_eq!(map[0].0, Value::Text("ok".into()));
        assert_eq!(map[0].1, Value::Bool(true));
    }
}

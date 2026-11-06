//! Host→guest messages of the sandboxd control protocol
//! (`guest/ARCHITECTURE.md` §4.1). Absent optional fields are omitted.

use gondolin_wire::Envelope;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExecRequest {
    pub cmd: String,
    pub argv: Vec<String>,
    pub env: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub stdin: bool,
    pub pty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_window: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_window: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StdinData<'a> {
    #[serde(with = "serde_bytes")]
    pub data: &'a [u8],
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub eof: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyResize {
    pub rows: u32,
    pub cols: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExecWindow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileReadRequest {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileWriteRequest {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub truncate: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileWriteData<'a> {
    #[serde(with = "serde_bytes")]
    pub data: &'a [u8],
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub eof: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileDeleteRequest {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimeSync {
    pub unix_ms: u64,
}

/// Builds a guest envelope.
pub fn envelope<P: Serialize>(t: &str, id: u32, p: P) -> Envelope<P> {
    Envelope::new(t, u64::from(id), p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_request_encoding() {
        let req = ExecRequest {
            cmd: "/bin/true".into(),
            argv: vec![],
            env: vec![],
            cwd: None,
            stdin: false,
            pty: false,
            stdout_window: Some(0),
            stderr_window: None,
        };
        let bytes = gondolin_wire::encode(&envelope("exec_request", 1, req)).unwrap();
        assert!(!bytes.windows(3).any(|w| w == b"cwd"));
        assert!(!bytes.windows(13).any(|w| w == b"stderr_window"));
        let data = StdinData { data: b"ab", eof: false };
        let bytes = gondolin_wire::encode(&data).unwrap();
        assert!(bytes.windows(3).any(|w| w == [0x42, b'a', b'b']));
        assert!(!bytes.windows(3).any(|w| w == b"eof"));
    }
}

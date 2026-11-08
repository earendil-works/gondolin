//! Host→guest messages of the sandboxd control protocol
//! (`guest/ARCHITECTURE.md` §4.1). Absent optional fields are omitted.

use gondolin_wire::Envelope;
use gondolin_wire::ToValue;

gondolin_wire::wire_struct! {
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ExecRequest {
        pub cmd: String,
        pub argv: Vec<String>,
        pub env: Vec<String>,
        pub cwd: Option<String>,
        pub stdin: bool,
        pub pty: bool,
        pub stdout_window: Option<u32>,
        pub stderr_window: Option<u32>,
    }
}

gondolin_wire::wire_encode! {
    #[derive(Debug, Clone)]
    pub struct StdinData<'a> {
        pub data: &'a [u8],
        pub eof: bool => skip_if std::ops::Not::not,
    }
}

gondolin_wire::wire_struct! {
    #[derive(Debug, Clone)]
    pub struct PtyResize {
        pub rows: u32,
        pub cols: u32,
    }
}

gondolin_wire::wire_struct! {
    /// `exec_signal`: signal the process group of an exec (guest feature
    /// `exec_signal`)
    #[derive(Debug, Clone)]
    pub struct ExecSignal {
        /// Linux signal number (1-64)
        pub signal: u32,
    }
}

gondolin_wire::wire_struct! {
    #[derive(Debug, Clone)]
    pub struct ExecWindow {
        pub stdout: Option<u32>,
        pub stderr: Option<u32>,
    }
}

gondolin_wire::wire_struct! {
    #[derive(Debug, Clone)]
    pub struct FileReadRequest {
        pub path: String,
        pub cwd: Option<String>,
        pub chunk_size: Option<u32>,
    }
}

gondolin_wire::wire_struct! {
    #[derive(Debug, Clone)]
    pub struct FileWriteRequest {
        pub path: String,
        pub cwd: Option<String>,
        pub truncate: bool,
    }
}

gondolin_wire::wire_encode! {
    #[derive(Debug, Clone)]
    pub struct FileWriteData<'a> {
        pub data: &'a [u8],
        pub eof: bool => skip_if std::ops::Not::not,
    }
}

gondolin_wire::wire_struct! {
    #[derive(Debug, Clone)]
    pub struct FileDeleteRequest {
        pub path: String,
        pub cwd: Option<String>,
        pub force: Option<bool>,
        pub recursive: Option<bool>,
    }
}

gondolin_wire::wire_struct! {
    #[derive(Debug, Clone)]
    pub struct TimeSync {
        pub unix_ms: u64,
    }
}

/// Builds a guest envelope.
pub fn envelope<P: ToValue>(t: &str, id: u32, p: P) -> Envelope<P> {
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

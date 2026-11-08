//! Guest file operations used by `vm.fs` (`guest/ARCHITECTURE.md` §4.5).
//!
//! The daemon serializes them exactly like `SandboxServer`: an operation waits
//! until no exec runs and no other file operation is active, holds the single
//! guest file-operation slot while it runs, and execs submitted meanwhile are
//! queued until it finishes. All messages of one operation use the
//! controller's request id as envelope `id`.
//!
//! | dir | type | payload |
//! |---|---|---|
//! | c→d | `file_read` (request) | [`FileRead`]; data arrives as `file_read_data` frames before `file_read_result` |
//! | d→c | `file_started` | `{}`: the guest request of the operation was sent (the operation left the queue) |
//! | d→c | `file_read_data` | [`FileData`] |
//! | c→d | `file_write` (request) | [`FileWrite`]; after `file_started` the controller sends the data |
//! | c→d | `file_write_data` | [`FileWriteData`]; the frame with `eof` completes the upload (`file_write_result`) |
//! | c→d | `file_delete` (request) | [`FileDelete`] |
//! | c→d | `file_cancel` | [`FileCancel`]: abort the operation with that id |
//!
//! Failures are `{ ok: false, code, message }` where `message` is the complete
//! error message the SDK surfaces (`file_read_failed: FileNotFound` for guest
//! errors, the sandbox exit diagnostics when the VM stops, ...).
//!
//! `file_write_data` is subject to backpressure: while the guest channel is
//! full the daemon stops reading controller messages, so the controller must
//! honour its pipe's backpressure (write callbacks/`drain`).

pub const FILE_READ: &str = "file_read";
pub const FILE_READ_DATA: &str = "file_read_data";
pub const FILE_WRITE: &str = "file_write";
pub const FILE_STARTED: &str = "file_started";
pub const FILE_WRITE_DATA: &str = "file_write_data";
pub const FILE_DELETE: &str = "file_delete";
pub const FILE_CANCEL: &str = "file_cancel";

gondolin_wire::wire_struct! {
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct FileRead {
        pub path: String,
        /// working directory for relative paths (guest path)
        pub cwd: Option<String>,
        /// preferred chunk size in `bytes` (guest clamps to [1 KiB, 1 MiB])
        pub chunk_size: Option<u32>,
    }
}

gondolin_wire::wire_struct! {
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct FileData {
        pub data: Vec<u8>,
    }
}

gondolin_wire::wire_struct! {
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct FileWrite {
        pub path: String,
        pub cwd: Option<String>,
    }
}

gondolin_wire::wire_struct! {
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct FileWriteData {
        pub data: Vec<u8>,
        pub eof: bool = Default::default() => skip_if std::ops::Not::not,
    }
}

gondolin_wire::wire_struct! {
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct FileDelete {
        pub path: String,
        pub cwd: Option<String>,
        pub force: Option<bool>,
        pub recursive: Option<bool>,
    }
}

gondolin_wire::wire_struct! {
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct FileCancel {
        /// error message the operation fails with (default `operation aborted`)
        pub message: Option<String>,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gondolin_wire::{decode, encode};

    #[test]
    fn write_data_omits_false_eof() {
        let d = FileWriteData { data: vec![1], eof: false };
        let bytes = encode(&d).unwrap();
        assert!(!bytes.windows(3).any(|w| w == b"eof"));
        assert_eq!(decode::<FileWriteData>(&bytes).unwrap(), d);
    }
}

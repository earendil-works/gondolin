//! Guest file operations for `vm.fs` (`readGuestFileStream`,
//! `writeGuestFile`, `deleteGuestFile` of `SandboxServer`).
//!
//! The guest handles one file operation at a time and expects upload data to
//! be contiguous, so operations wait until no exec runs and no other file
//! operation is active (`acquireFileOp`), hold the single slot while they run,
//! and execs submitted meanwhile are queued until the slot is released.

use std::collections::VecDeque;

use crate::ordmap::OrderedMap;
use gondolin_proto::files as pf;
use gondolin_wire::{RawEnvelope, Value};

use crate::controller::Controller;
use crate::fields::{self, Fields};
use crate::guestmsg::{self, FileDeleteRequest, FileReadRequest, FileWriteData, FileWriteRequest};
use crate::idle::Continuation;
use crate::session::Session;

/// Upload chunk size towards the guest in `bytes`.
const WRITE_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileKind {
    Read,
    Write,
    Delete,
}

impl FileKind {
    fn request_type(self) -> &'static str {
        match self {
            FileKind::Read => pf::FILE_READ,
            FileKind::Write => pf::FILE_WRITE,
            FileKind::Delete => pf::FILE_DELETE,
        }
    }
}

/// The guest request of an operation.
#[derive(Debug)]
pub(crate) enum GuestRequest {
    Read(FileReadRequest),
    Write(FileWriteRequest),
    Delete(FileDeleteRequest),
}

/// An admitted operation (keyed by its guest request id).
#[derive(Debug)]
pub(crate) struct FileOp {
    kind: FileKind,
    /// controller request id
    req: u64,
    request: Option<GuestRequest>,
    request_sent: bool,
    eof_sent: bool,
}

/// An operation waiting for the exec/file slot.
#[derive(Debug)]
struct FileWaiter {
    req: u64,
    kind: FileKind,
    request: GuestRequest,
}

/// Frames that could not be queued to the guest yet (the guest channel was
/// full); controller intake pauses until they are sent.
#[derive(Debug)]
pub(crate) struct Blocked {
    gid: u32,
    frames: VecDeque<Vec<u8>>,
    then: AfterSend,
}

#[derive(Debug, Clone, Copy)]
enum AfterSend {
    RequestSent,
    DataSent { eof: bool },
}

#[derive(Debug)]
pub(crate) struct FileState {
    next_id: u32,
    /// guest id of the operation holding the slot
    pub active: Option<u32>,
    pub ops: OrderedMap<u32, FileOp>,
    waiters: VecDeque<FileWaiter>,
    pub blocked: Option<Blocked>,
}

impl Default for FileState {
    fn default() -> Self {
        FileState {
            next_id: 1,
            active: None,
            ops: OrderedMap::new(),
            waiters: VecDeque::new(),
            blocked: None,
        }
    }
}

impl FileState {
    /// Fails operations that never got the slot.
    pub(crate) fn fail_waiters(&mut self, ctl: &Controller, message: &str) {
        for w in self.waiters.drain(..) {
            ctl.reply_err(w.kind.request_type(), w.req, "server_shutdown", message);
        }
    }
}

fn frame<P: gondolin_wire::ToValue>(t: &str, id: u32, p: P) -> Vec<u8> {
    let env = guestmsg::envelope(t, id, p);
    gondolin_wire::encode(&env).and_then(|b| gondolin_wire::frame(&b)).expect("guest frame encodes")
}

/// `assertGuestPath`.
fn guest_path(f: &Fields<'_>) -> Result<String, String> {
    match f.get("path").and_then(Value::as_text) {
        Some("") => Err("filePath must be a non-empty string".into()),
        Some(p) if p.contains('\0') => Err("filePath contains null bytes".into()),
        Some(p) => Ok(p.to_string()),
        None => Err("filePath must be a non-empty string".into()),
    }
}

fn optional_text(f: &Fields<'_>, key: &str) -> Result<Option<String>, String> {
    match f.get_some(key) {
        None => Ok(None),
        Some(v) => {
            v.as_text().map(|s| Some(s.to_string())).ok_or(format!("{key} must be a string"))
        }
    }
}

fn optional_bool(f: &Fields<'_>, key: &str) -> Result<Option<bool>, String> {
    match f.get_some(key) {
        None => Ok(None),
        Some(v) => v.as_bool().map(Some).ok_or(format!("{key} must be a boolean")),
    }
}

impl Session {
    pub(crate) fn handle_file_message(&mut self, msg: RawEnvelope) {
        let f = Fields::of(&msg.p);
        let t = msg.t.as_str();
        match t {
            pf::FILE_WRITE_DATA => return self.file_write_data(msg.id, &f),
            pf::FILE_CANCEL => {
                let message = f.text("message").unwrap_or("operation aborted").to_string();
                return self.file_cancel(msg.id, &message);
            }
            _ => {}
        }
        if msg.id == 0 {
            self.ctl.error_event(
                "invalid_request",
                "file operations require a request id",
                Some(t),
            );
            return;
        }
        let parsed = (|| -> Result<(FileKind, GuestRequest), String> {
            let path = guest_path(&f)?;
            let cwd = optional_text(&f, "cwd")?;
            Ok(match t {
                pf::FILE_READ => {
                    let chunk_size = match f.get_some("chunk_size") {
                        None => None,
                        Some(v) => {
                            Some(fields::request_id(Some(v)).ok_or("chunk_size must be a uint32")?)
                        }
                    };
                    (FileKind::Read, GuestRequest::Read(FileReadRequest { path, cwd, chunk_size }))
                }
                pf::FILE_WRITE => (
                    FileKind::Write,
                    GuestRequest::Write(FileWriteRequest { path, cwd, truncate: true }),
                ),
                _ => (
                    FileKind::Delete,
                    GuestRequest::Delete(FileDeleteRequest {
                        path,
                        cwd,
                        force: optional_bool(&f, "force")?,
                        recursive: optional_bool(&f, "recursive")?,
                    }),
                ),
            })
        })();
        let (kind, request) = match parsed {
            Ok(p) => p,
            Err(err) => {
                self.ctl.reply_err(t, msg.id, "invalid_request", &err);
                return;
            }
        };
        if !self.is_started() {
            self.ctl.reply_err(t, msg.id, "invalid_state", "sandbox server is not started");
            return;
        }
        self.f.waiters.push_back(FileWaiter { req: msg.id, kind, request });
    }

    /// `isExecIdle`.
    fn is_exec_idle(&self) -> bool {
        self.x.inflight.is_empty()
            && self.x.started_execs.is_empty()
            && self.f.active.is_none()
            && self.x.exec_queue.is_empty()
    }

    fn allocate_file_op_id(&mut self) -> Option<u32> {
        let mut id = self.f.next_id;
        for _ in 0..=u32::MAX as u64 {
            if !self.x.inflight.contains_key(&id)
                && !self.x.started_execs.contains(&id)
                && !self.f.ops.contains_key(&id)
            {
                self.f.next_id = id.checked_add(1).unwrap_or(1);
                return Some(id);
            }
            id = id.checked_add(1).unwrap_or(1);
        }
        None
    }

    /// Admits the next waiting operation when the slot is free.
    pub(crate) fn pump_file_waiters(&mut self) {
        while self.is_exec_idle() && !self.f.waiters.is_empty() {
            let waiter = self.f.waiters.pop_front().unwrap();
            let Some(gid) = self.allocate_file_op_id() else {
                self.ctl.reply_err(
                    waiter.kind.request_type(),
                    waiter.req,
                    "exhausted",
                    "no available request ids for file operations",
                );
                continue;
            };
            self.f.ops.insert(
                gid,
                FileOp {
                    kind: waiter.kind,
                    req: waiter.req,
                    request: Some(waiter.request),
                    request_sent: false,
                    eof_sent: false,
                },
            );
            self.f.active = Some(gid);
            self.resume_then(Continuation::FileSend { gid });
        }
    }

    /// Sends the guest request of an admitted operation (after the resume).
    pub(crate) fn file_send_request(&mut self, gid: u32) {
        let Some(op) = self.f.ops.get_mut(&gid) else { return };
        let Some(request) = op.request.take() else { return };
        let bytes = match request {
            GuestRequest::Read(r) => frame("file_read_request", gid, r),
            GuestRequest::Write(r) => frame("file_write_request", gid, r),
            GuestRequest::Delete(r) => frame("file_delete_request", gid, r),
        };
        self.send_blocking(gid, VecDeque::from([bytes]), AfterSend::RequestSent);
    }

    /// The resume before a file operation failed.
    pub(crate) fn file_resume_failed(&mut self, gid: u32, error: &str) {
        self.reject_file_op(gid, "sandbox_resume_failed", error);
    }

    /// Queues frames to the guest; when the channel is full the rest waits for
    /// it to drain (`sendControlMessage` + `waitForBridgeWritable`).
    fn send_blocking(&mut self, gid: u32, mut frames: VecDeque<Vec<u8>>, then: AfterSend) {
        while let Some(frame) = frames.pop_front() {
            if !self.guest.send_frame(frame.clone()) {
                frames.push_front(frame);
                self.f.blocked = Some(Blocked { gid, frames, then });
                return;
            }
        }
        self.after_send(gid, then);
    }

    /// Retries a blocked send after the guest channel drained.
    pub(crate) fn retry_blocked_send(&mut self) {
        if let Some(blocked) = self.f.blocked.take() {
            self.send_blocking(blocked.gid, blocked.frames, blocked.then);
        }
    }

    fn after_send(&mut self, gid: u32, then: AfterSend) {
        let Some(op) = self.f.ops.get_mut(&gid) else { return };
        match then {
            AfterSend::RequestSent => {
                op.request_sent = true;
                let req = op.req;
                self.ctl.send(pf::FILE_STARTED, req, &Value::Map(vec![]));
            }
            AfterSend::DataSent { eof } => {
                if eof {
                    op.eof_sent = true;
                }
            }
        }
    }

    fn file_write_data(&mut self, req: u64, f: &Fields<'_>) {
        let Some((&gid, op)) = self.f.ops.iter().find(|(_, op)| op.req == req) else {
            // the operation already failed (its result was sent)
            return;
        };
        if op.kind != FileKind::Write || !op.request_sent || op.eof_sent {
            self.ctl.error_event(
                "invalid_request",
                "unexpected file_write_data",
                Some(pf::FILE_WRITE_DATA),
            );
            return;
        }
        let data = f.bytes("data").unwrap_or(&[]);
        let eof = f.truthy("eof");
        let mut frames: VecDeque<Vec<u8>> = data
            .chunks(WRITE_CHUNK)
            .map(|chunk| frame("file_write_data", gid, FileWriteData { data: chunk, eof: false }))
            .collect();
        if eof {
            frames.push_back(frame("file_write_data", gid, FileWriteData { data: &[], eof: true }));
        }
        self.send_blocking(gid, frames, AfterSend::DataSent { eof });
    }

    fn file_cancel(&mut self, req: u64, message: &str) {
        if let Some(pos) = self.f.waiters.iter().position(|w| w.req == req) {
            let w = self.f.waiters.remove(pos).unwrap();
            self.ctl.reply_err(w.kind.request_type(), req, "aborted", message);
            return;
        }
        let Some((&gid, op)) = self.f.ops.iter().find(|(_, op)| op.req == req) else { return };
        if op.kind == FileKind::Write && op.request_sent && !op.eof_sent {
            if self.f.blocked.as_ref().is_some_and(|b| b.gid == gid) {
                self.f.blocked = None;
            }
            // best effort: close the upload so the guest leaves the file alone
            let _ = self.guest.send_frame(frame(
                "file_write_data",
                gid,
                FileWriteData { data: &[], eof: true },
            ));
        }
        self.reject_file_op(gid, "aborted", message);
    }

    pub(crate) fn guest_file_read_data(&mut self, gid: u32, p: &Fields<'_>) {
        let Some(op) = self.f.ops.get(&gid) else { return };
        if op.kind != FileKind::Read {
            return;
        }
        let req = op.req;
        let Some(data) = p.bytes("data") else {
            self.reject_file_op(gid, "protocol_error", "invalid file_read_data payload");
            return;
        };
        self.ctl.send(pf::FILE_READ_DATA, req, &pf::FileData { data: data.to_vec() });
    }

    /// `resolveFileOperation`.
    pub(crate) fn resolve_file_op(&mut self, gid: u32) {
        let Some(op) = self.f.ops.shift_remove(&gid) else { return };
        self.ctl.reply_ok(op.kind.request_type(), op.req, vec![]);
        self.release_file_slot(gid);
    }

    /// `rejectFileOperation`.
    pub(crate) fn reject_file_op(&mut self, gid: u32, code: &str, message: &str) {
        let Some(op) = self.f.ops.shift_remove(&gid) else { return };
        self.ctl.reply_err(op.kind.request_type(), op.req, code, message);
        self.release_file_slot(gid);
    }

    fn release_file_slot(&mut self, gid: u32) {
        if self.f.blocked.as_ref().is_some_and(|b| b.gid == gid) {
            self.f.blocked = None;
        }
        if self.f.active == Some(gid) {
            self.f.active = None;
            self.pump_exec_queue();
        }
        self.schedule_idle_pause();
    }

    /// `failFileOperations`.
    pub(crate) fn fail_file_operations(&mut self, code: &str, message: &str) {
        let ids: Vec<u32> = self.f.ops.keys().copied().collect();
        for gid in ids {
            self.reject_file_op(gid, code, message);
        }
        self.f.blocked = None;
    }
}

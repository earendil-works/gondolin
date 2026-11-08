//! Exec handling: admission limits, queueing while a file operation runs,
//! stdin queueing against guest-granted credit, pty resize and output window
//! forwarding with retries when the guest channel is full.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::ordmap::{OrderedMap, OrderedSet};
use gondolin_proto::exec::{self as px, ClientId, Stream};

use crate::fields::{self, Fields};
use crate::guestmsg::{ExecRequest, ExecSignal, ExecWindow, PtyResize, StdinData};
use crate::idle::Continuation;
use crate::session::Session;

/// A queued stdin chunk (data not yet sent to the guest).
#[derive(Debug)]
pub(crate) struct StdinChunk {
    data: Vec<u8>,
    /// bytes of `data` already sent
    offset: usize,
    eof: bool,
}

impl StdinChunk {
    fn remaining(&self) -> &[u8] {
        &self.data[self.offset..]
    }
}

/// An exec waiting for a file operation to finish.
#[derive(Debug)]
pub(crate) struct QueuedExec {
    pub client: ClientId,
    pub id: u32,
    pub request: ExecRequest,
}

/// Upper bound of one coalesced `exec_output` frame in `bytes`.
pub(crate) const OUTPUT_COALESCE_BYTES: usize = 64 * 1024;

/// Guest output waiting to be sent as one `exec_output`.
#[derive(Debug)]
pub(crate) struct PendingOutput {
    client: ClientId,
    id: u32,
    stream: Stream,
    data: Vec<u8>,
}

/// Exec bookkeeping (field names follow `SandboxServer`).
#[derive(Debug, Default)]
pub(crate) struct ExecState {
    /// accepted execs and the client owning them
    pub inflight: OrderedMap<u32, ClientId>,
    /// admission tokens while a resume is pending
    pub pending_admissions: HashMap<u32, u64>,
    next_admission: u64,
    /// execs accepted but not started because a file operation runs
    pub exec_queue: VecDeque<QueuedExec>,
    /// execs whose `exec_request` was sent to sandboxd
    pub started_execs: OrderedSet<u32>,
    pub stdin_allowed: HashSet<u32>,
    pub queued_stdin: OrderedMap<u32, VecDeque<StdinChunk>>,
    /// queued stdin per exec in `bytes`
    pub queued_stdin_bytes: HashMap<u32, u64>,
    /// queued stdin across execs in `bytes`
    pub queued_stdin_total: u64,
    /// stdin credit granted by the guest in `bytes`
    pub stdin_credits: HashMap<u32, u64>,
    pub queued_pty_resize: OrderedMap<u32, (u32, u32)>,
    /// signals not yet sent because the guest channel was full
    pub queued_signals: OrderedMap<u32, u32>,
    /// output credit not yet forwarded (stdout, stderr) in `bytes`
    pub pending_windows: OrderedMap<u32, (u64, u64)>,
    pub window_flush_scheduled: bool,
    pub io_flush_scheduled: bool,
    /// coalesced guest output not yet sent
    pub pending_output: Option<PendingOutput>,
}

impl ExecState {
    fn clear_queued_stdin(&mut self, id: u32) {
        if let Some(bytes) = self.queued_stdin_bytes.remove(&id) {
            self.queued_stdin_total = self.queued_stdin_total.saturating_sub(bytes);
        }
        self.queued_stdin.shift_remove(&id);
    }

    /// Drops all per-exec state of `id` except `started_execs`.
    pub(crate) fn forget(&mut self, id: u32) {
        self.inflight.shift_remove(&id);
        self.pending_admissions.remove(&id);
        self.stdin_allowed.remove(&id);
        self.stdin_credits.remove(&id);
        self.pending_windows.shift_remove(&id);
        self.clear_queued_stdin(id);
        self.queued_pty_resize.shift_remove(&id);
        self.queued_signals.shift_remove(&id);
    }

    /// `failInflight` part: forget everything.
    pub(crate) fn clear_all(&mut self) {
        self.inflight.clear();
        self.pending_admissions.clear();
        self.started_execs.clear();
        self.stdin_allowed.clear();
        self.stdin_credits.clear();
        self.pending_windows.clear();
        self.exec_queue.clear();
        self.queued_stdin.clear();
        self.queued_stdin_bytes.clear();
        self.queued_stdin_total = 0;
        self.queued_pty_resize.clear();
        self.queued_signals.clear();
    }

    /// `execPressure`: started execs plus accepted-but-not-started ones.
    fn pressure(&self) -> usize {
        self.started_execs.len()
            + self.inflight.keys().filter(|id| !self.started_execs.contains(*id)).count()
    }
}

fn clamp_u32(v: u64) -> u32 {
    u32::try_from(v).unwrap_or(u32::MAX)
}

/// A uint32 field that may be absent (`validWindow`).
fn optional_window(f: &Fields<'_>, key: &str) -> Result<Option<u32>, ()> {
    match f.get(key) {
        None => Ok(None),
        Some(v) => fields::request_id(Some(v)).map(Some).ok_or(()),
    }
}

impl Session {
    /// `disconnectClient`: forget the client's execs (they keep running in the
    /// guest) and queued exec starts.
    pub(crate) fn disconnect_client(&mut self, client: ClientId) {
        self.clients.shift_remove(&client);
        let owned: Vec<u32> =
            self.x.inflight.iter().filter(|(_, c)| **c == client).map(|(id, _)| *id).collect();
        for id in owned {
            self.x.forget(id);
        }
        self.x.exec_queue.retain(|e| e.client != client);
    }

    pub(crate) fn handle_exec(&mut self, client: ClientId, f: &Fields<'_>) {
        if self.debug_enabled("exec") {
            self.emit_debug("exec", describe_exec(f));
        }
        let id = fields::request_id(f.get("id"));
        let cmd = f.text("cmd").filter(|c| !c.is_empty());
        let (Some(id), Some(cmd)) = (id, cmd) else {
            self.client_error(client, None, "invalid_request", "exec requires uint32 id and cmd");
            return;
        };
        if cmd == "gondolind-test-panic" {
            crate::panics::test_panic(crate::panics::TestPanic::Session);
        }
        if self.x.inflight.contains_key(&id) || self.x.started_execs.contains(&id) {
            self.client_error(client, Some(id), "duplicate_id", "request id already in use");
            return;
        }
        let (Ok(stdout_window), Ok(stderr_window)) =
            (optional_window(f, "stdout_window"), optional_window(f, "stderr_window"))
        else {
            self.client_error(
                client,
                Some(id),
                "invalid_request",
                "stdout_window/stderr_window must be uint32 byte counts (0 = default)",
            );
            return;
        };
        let list = |key: &str| match f.get_some(key) {
            None => Some(Vec::new()),
            Some(v) => fields::string_list(v),
        };
        let cwd = match f.get_some("cwd") {
            None => Some(None),
            Some(v) => v.as_text().map(|s| Some(s.to_string())),
        };
        let (Some(argv), Some(env), Some(cwd)) = (list("argv"), list("env"), cwd) else {
            self.client_error(
                client,
                Some(id),
                "invalid_request",
                "exec argv/env must be string arrays and cwd a string",
            );
            return;
        };
        let max = self.limits.max_queued_execs as usize;
        if self.x.pressure() >= max {
            self.client_error(
                client,
                Some(id),
                "queue_full",
                &format!("too many concurrent exec requests (limit {max})"),
            );
            return;
        }

        self.x.next_admission += 1;
        let token = self.x.next_admission;
        self.x.inflight.insert(id, client);
        self.x.pending_admissions.insert(id, token);
        let stdin = f.truthy("stdin");
        if stdin {
            self.x.stdin_allowed.insert(id);
            self.x.stdin_credits.insert(id, 0);
        }
        let request = ExecRequest {
            cmd: cmd.to_string(),
            argv,
            env,
            cwd,
            stdin,
            pty: f.truthy("pty"),
            stdout_window,
            stderr_window,
        };
        self.resume_then(Continuation::ExecAdmission { client, id, token, request });
    }

    /// Continues `handleExec` after the VM was resumed.
    pub(crate) fn exec_admitted(
        &mut self,
        client: ClientId,
        id: u32,
        token: u64,
        request: ExecRequest,
    ) {
        let owns = self.x.pending_admissions.get(&id) == Some(&token);
        if !owns || self.x.inflight.get(&id) != Some(&client) {
            if owns {
                self.x.pending_admissions.remove(&id);
            }
            self.schedule_idle_pause();
            return;
        }
        self.x.pending_admissions.remove(&id);
        let entry = QueuedExec { client, id, request };
        // keep file operations mutually exclusive with exec start
        if self.f.active.is_some() {
            self.x.exec_queue.push_back(entry);
            return;
        }
        self.start_exec_now(entry);
    }

    /// The resume before an exec failed (`sandbox_resume_failed`).
    pub(crate) fn exec_admission_failed(
        &mut self,
        client: ClientId,
        id: u32,
        token: u64,
        error: &str,
    ) {
        let owns = self.x.pending_admissions.get(&id) == Some(&token);
        if owns {
            let owner = self.x.inflight.get(&id).copied();
            self.x.forget(id);
            if owner == Some(client) {
                self.client_error(client, Some(id), "sandbox_resume_failed", error);
            }
        }
        self.schedule_idle_pause();
    }

    fn start_exec_now(&mut self, entry: QueuedExec) {
        let id = entry.id;
        if !self.guest_send("exec_request", id, &entry.request) {
            self.x.forget(id);
            self.x.started_execs.shift_remove(&id);
            self.client_error(entry.client, Some(id), "queue_full", "virtio bridge queue exceeded");
            self.schedule_idle_pause();
            return;
        }
        self.x.started_execs.insert(id);
        self.flush_pty_resize_for(id);
        self.flush_stdin_for(id);
        self.flush_window_for(id);
        if self.x.queued_stdin.get(&id).is_some_and(|q| !q.is_empty())
            || self.x.queued_pty_resize.contains_key(&id)
        {
            self.x.io_flush_scheduled = true;
        }
    }

    /// `pumpExecQueue`: start execs that waited for a file operation.
    pub(crate) fn pump_exec_queue(&mut self) {
        if self.f.active.is_some() {
            return;
        }
        while let Some(next) = self.x.exec_queue.pop_front() {
            if !self.x.inflight.contains_key(&next.id) {
                // the client disconnected while the exec was queued
                self.x.started_execs.shift_remove(&next.id);
                self.x.forget(next.id);
                continue;
            }
            self.start_exec_now(next);
        }
    }

    pub(crate) fn handle_stdin(&mut self, client: ClientId, f: &Fields<'_>) {
        let data: &[u8] = f.bytes("data").unwrap_or(&[]);
        let eof = f.truthy("eof");
        if self.debug_enabled("exec") {
            let id = f.int("id").map(|i| i.to_string()).unwrap_or_default();
            self.emit_debug(
                "exec",
                format!("stdin id={id} bytes={}{}", data.len(), if eof { " eof" } else { "" }),
            );
        }
        let Some(id) = fields::request_id(f.get("id")) else {
            self.client_error(client, None, "invalid_request", "stdin requires a uint32 id");
            return;
        };
        if !self.x.inflight.contains_key(&id) {
            self.client_error(client, Some(id), "unknown_id", "request id not found");
            return;
        }
        if !self.x.stdin_allowed.contains(&id) {
            self.client_error(
                client,
                Some(id),
                "stdin_disabled",
                "stdin was not enabled for this request",
            );
            return;
        }
        if f.get_some("data").is_some_and(|v| v.as_bytes().is_none()) {
            self.client_error(client, Some(id), "invalid_request", "stdin data must be bytes");
            return;
        }
        if data.len() as u64 > self.limits.max_stdin_bytes {
            self.client_error(
                client,
                Some(id),
                "payload_too_large",
                "stdin chunk exceeds size limit",
            );
            return;
        }
        if !self.x.started_execs.contains(&id) {
            self.queue_stdin_chunk(client, id, data, eof, true);
            return;
        }
        if data.is_empty() && !eof {
            return;
        }
        if !self.queue_stdin_chunk(client, id, data, eof, false) {
            return;
        }
        if !self.flush_stdin_for(id) {
            self.x.io_flush_scheduled = true;
        }
    }

    fn queue_stdin_chunk(
        &mut self,
        client: ClientId,
        id: u32,
        data: &[u8],
        eof: bool,
        cancel: bool,
    ) -> bool {
        let queued = self.x.queued_stdin_bytes.get(&id).copied().unwrap_or(0);
        let next = queued + data.len() as u64;
        let next_total = self.x.queued_stdin_total + data.len() as u64;
        let overflow = if next > self.limits.max_queued_stdin_bytes {
            Some(format!(
                "queued stdin exceeds limit ({} bytes)",
                self.limits.max_queued_stdin_bytes
            ))
        } else if next_total > self.limits.max_total_queued_stdin_bytes {
            Some(format!(
                "total queued stdin exceeds limit ({} bytes)",
                self.limits.max_total_queued_stdin_bytes
            ))
        } else {
            None
        };
        if let Some(message) = overflow {
            self.client_error(client, Some(id), "payload_too_large", &message);
            if cancel && !self.x.started_execs.contains(&id) {
                // cancel queued execs on stdin overflow to avoid running with partial stdin
                self.x.forget(id);
                self.x.started_execs.shift_remove(&id);
                self.x.exec_queue.retain(|e| e.id != id);
            }
            return false;
        }
        self.x.queued_stdin.entry_or_insert_with(id, Default::default).push_back(StdinChunk {
            data: data.to_vec(),
            offset: 0,
            eof,
        });
        self.x.queued_stdin_bytes.insert(id, next);
        self.x.queued_stdin_total = next_total;
        true
    }

    pub(crate) fn handle_pty_resize(&mut self, client: ClientId, f: &Fields<'_>) {
        if self.debug_enabled("exec") {
            self.emit_debug(
                "exec",
                format!(
                    "pty_resize id={} rows={} cols={}",
                    f.int("id").map(|i| i.to_string()).unwrap_or_default(),
                    f.number("rows").unwrap_or(f64::NAN),
                    f.number("cols").unwrap_or(f64::NAN)
                ),
            );
        }
        let Some(id) = fields::request_id(f.get("id")) else {
            self.client_error(client, None, "invalid_request", "pty_resize requires a uint32 id");
            return;
        };
        if !self.x.inflight.contains_key(&id) {
            self.client_error(client, Some(id), "unknown_id", "request id not found");
            return;
        }
        let (Some(rows), Some(cols)) = (f.number("rows"), f.number("cols")) else {
            self.client_error(
                client,
                Some(id),
                "invalid_request",
                "pty_resize requires positive rows and cols",
            );
            return;
        };
        if rows < 1.0 || cols < 1.0 {
            self.client_error(
                client,
                Some(id),
                "invalid_request",
                "pty_resize requires positive rows and cols",
            );
            return;
        }
        let rows = clamp_u32(rows.trunc() as u64);
        let cols = clamp_u32(cols.trunc() as u64);
        if !self.x.started_execs.contains(&id) {
            self.x.queued_pty_resize.insert(id, (rows, cols));
            return;
        }
        if !self.guest_send("pty_resize", id, PtyResize { rows, cols }) {
            // retry once the guest channel drains
            self.x.queued_pty_resize.insert(id, (rows, cols));
            self.x.io_flush_scheduled = true;
        }
    }

    /// `exec_signal`: signal a running exec's process group in the guest, or
    /// drop an exec that has not started yet (answered like a command killed
    /// by the signal).
    pub(crate) fn handle_exec_signal(&mut self, client: ClientId, f: &Fields<'_>) {
        let Some(id) = fields::request_id(f.get("id")) else {
            self.client_error(client, None, "invalid_request", "exec_signal requires a uint32 id");
            return;
        };
        let signal = match fields::request_id(f.get("signal")) {
            Some(s @ 1..=64) => s,
            _ => {
                self.client_error(
                    client,
                    Some(id),
                    "invalid_request",
                    "exec_signal requires a signal number between 1 and 64",
                );
                return;
            }
        };
        match self.x.inflight.get(&id) {
            // the exec already finished, or it is not this client's
            None => return,
            Some(owner) if *owner != client => return,
            Some(_) => {}
        }
        if self.debug_enabled("exec") {
            self.emit_debug("exec", format!("exec_signal id={id} signal={signal}"));
        }
        if !self.x.started_execs.contains(&id) {
            // not sent to the guest yet: drop it
            self.x.exec_queue.retain(|e| e.id != id);
            self.x.forget(id);
            let code = 128 + signal as i32;
            let resp =
                px::ExecResponse { client, id, exit_code: code, signal: Some(signal as i32) };
            self.ctl.send(px::EXEC_RESPONSE, 0, &resp);
            self.schedule_idle_pause();
            return;
        }
        if !self.guest_features.iter().any(|f| f == "exec_signal") {
            let message = "the guest image cannot signal commands (its sandboxd predates exec_signal; rebuild the image); the command keeps running".to_string();
            gondolin_log::warn!("{message}");
            self.ctl.send(
                gondolin_proto::session::LOG,
                0,
                &gondolin_proto::session::Log { component: "exec".into(), message },
            );
            return;
        }
        self.x.queued_signals.insert(id, signal);
        if !self.flush_signal_for(id) {
            self.x.io_flush_scheduled = true;
        }
    }

    fn flush_signal_for(&mut self, id: u32) -> bool {
        let Some(&signal) = self.x.queued_signals.get(&id) else {
            return true;
        };
        if !self.x.started_execs.contains(&id) {
            self.x.queued_signals.shift_remove(&id);
            return true;
        }
        if !self.guest_send("exec_signal", id, ExecSignal { signal }) {
            return false;
        }
        self.x.queued_signals.shift_remove(&id);
        true
    }

    fn flush_signals(&mut self) {
        let ids: Vec<u32> = self.x.queued_signals.keys().copied().collect();
        for id in ids {
            if !self.flush_signal_for(id) {
                return;
            }
        }
    }

    pub(crate) fn handle_exec_window(&mut self, client: ClientId, f: &Fields<'_>) {
        let Some(id) = fields::request_id(f.get("id")) else {
            self.client_error(client, None, "invalid_request", "exec_window requires a uint32 id");
            return;
        };
        match self.x.inflight.get(&id) {
            // the exec may have exited, or the credit is not from its owner
            None => return,
            Some(owner) if *owner != client => return,
            Some(_) => {}
        }
        let credit = |key: &str| -> Result<u64, ()> {
            match f.get(key) {
                None => Ok(0),
                Some(v) => match fields::request_id(Some(v)) {
                    Some(n) if n > 0 => Ok(u64::from(n)),
                    _ => Err(()),
                },
            }
        };
        let (Ok(out), Ok(err)) = (credit("stdout"), credit("stderr")) else {
            self.client_error(
                client,
                Some(id),
                "invalid_request",
                "exec_window requires positive integer credits",
            );
            return;
        };
        if out == 0 && err == 0 {
            return;
        }
        let entry = self.x.pending_windows.entry_or_insert_with(id, || (0, 0));
        entry.0 = (entry.0 + out).min(u64::from(u32::MAX));
        entry.1 = (entry.1 + err).min(u64::from(u32::MAX));
        self.flush_windows();
    }

    // ---- flushing --------------------------------------------------------

    /// Runs the flushes scheduled during the last event.
    pub(crate) fn run_scheduled_flushes(&mut self) {
        if std::mem::take(&mut self.x.window_flush_scheduled) {
            self.flush_windows();
        }
        if std::mem::take(&mut self.x.io_flush_scheduled) {
            self.flush_signals();
            self.flush_pty_resizes();
            self.flush_stdin();
        }
    }

    fn flush_pty_resize_for(&mut self, id: u32) -> bool {
        let Some(&(rows, cols)) = self.x.queued_pty_resize.get(&id) else {
            return true;
        };
        if !self.x.inflight.contains_key(&id) {
            self.x.queued_pty_resize.shift_remove(&id);
            return true;
        }
        if !self.x.started_execs.contains(&id) {
            return true;
        }
        if !self.guest_send("pty_resize", id, PtyResize { rows, cols }) {
            return false;
        }
        self.x.queued_pty_resize.shift_remove(&id);
        true
    }

    fn flush_pty_resizes(&mut self) {
        let ids: Vec<u32> = self.x.queued_pty_resize.keys().copied().collect();
        for id in ids {
            if !self.flush_pty_resize_for(id) {
                return;
            }
        }
    }

    /// `flushQueuedStdinFor`: sends queued stdin within guest credit and channel
    /// capacity. Returns `true` when nothing is left queued.
    fn flush_stdin_for(&mut self, id: u32) -> bool {
        if self.x.queued_stdin.get(&id).is_none_or(|q| q.is_empty()) {
            return true;
        }
        if !self.x.inflight.contains_key(&id) {
            self.x.clear_queued_stdin(id);
            return true;
        }
        if !self.x.started_execs.contains(&id) {
            return true;
        }
        let mut credit = self.x.stdin_credits.get(&id).copied().unwrap_or(0);
        let mut remaining = self.x.queued_stdin_bytes.get(&id).copied().unwrap_or(0);
        let queued_before = remaining;
        let mut progressed = false;
        // take the queue out of the map without changing the map's order
        let mut queue = std::mem::take(self.x.queued_stdin.get_mut(&id).expect("queued stdin"));
        while let Some(chunk) = queue.front_mut() {
            if chunk.remaining().is_empty() {
                // EOF with an empty payload is allowed without credit
                if chunk.eof {
                    if !self.guest_send("stdin_data", id, StdinData { data: &[], eof: true }) {
                        break;
                    }
                    progressed = true;
                }
                queue.pop_front();
                continue;
            }
            if credit == 0 {
                break;
            }
            let len = chunk.remaining().len();
            let to_send = (len as u64).min(credit) as usize;
            let eof = chunk.eof && to_send == len;
            let part = &chunk.remaining()[..to_send];
            if !self.guest_send("stdin_data", id, StdinData { data: part, eof }) {
                break;
            }
            progressed = true;
            credit -= to_send as u64;
            self.x.stdin_credits.insert(id, credit);
            remaining = remaining.saturating_sub(to_send as u64);
            self.x.queued_stdin_total = self.x.queued_stdin_total.saturating_sub(to_send as u64);
            if to_send < len {
                chunk.offset += to_send;
                break;
            }
            queue.pop_front();
        }
        let empty = queue.is_empty();
        *self.x.queued_stdin.get_mut(&id).expect("queued stdin") = queue;
        if !progressed {
            return false;
        }
        let acked = queued_before.saturating_sub(remaining);
        if acked > 0
            && let Some(&client) = self.x.inflight.get(&id)
        {
            self.ctl.send(px::CLIENT_STDIN_ACK, 0, &px::StdinAck { client, id, bytes: acked });
        }
        if empty {
            self.x.queued_stdin.shift_remove(&id);
            self.x.queued_stdin_bytes.remove(&id);
            return true;
        }
        self.x.queued_stdin_bytes.insert(id, remaining);
        false
    }

    fn flush_stdin(&mut self) {
        let ids: Vec<u32> = self.x.queued_stdin.keys().copied().collect();
        for id in ids {
            if !self.flush_stdin_for(id) {
                return;
            }
        }
    }

    fn flush_window_for(&mut self, id: u32) -> bool {
        let Some(&(out, err)) = self.x.pending_windows.get(&id) else {
            return true;
        };
        if !self.x.inflight.contains_key(&id) {
            self.x.pending_windows.shift_remove(&id);
            return true;
        }
        if !self.x.started_execs.contains(&id) {
            return true;
        }
        let stdout = (out > 0).then(|| clamp_u32(out));
        let stderr = (err > 0).then(|| clamp_u32(err));
        if stdout.is_none() && stderr.is_none() {
            self.x.pending_windows.shift_remove(&id);
            return true;
        }
        if !self.guest_send("exec_window", id, ExecWindow { stdout, stderr }) {
            return false;
        }
        self.x.pending_windows.shift_remove(&id);
        true
    }

    fn flush_windows(&mut self) {
        let ids: Vec<u32> = self.x.pending_windows.keys().copied().collect();
        for id in ids {
            if !self.flush_window_for(id) {
                return;
            }
        }
    }

    // ---- guest messages ----------------------------------------------------

    /// Guest output is coalesced per exec and stream while frames arrive
    /// back to back (sandboxd sends at most 8 KiB per frame); the batch is
    /// sent at the end of the event round or before anything else is sent.
    pub(crate) fn guest_exec_output(&mut self, id: u32, p: &Fields<'_>) {
        let Some(&client) = self.x.inflight.get(&id) else { return };
        let Some(data) = p.bytes("data") else { return };
        let stream =
            if p.text("stream") == Some("stdout") { Stream::Stdout } else { Stream::Stderr };
        if let Some(pending) = &mut self.x.pending_output
            && pending.client == client
            && pending.id == id
            && pending.stream == stream
            && pending.data.len() + data.len() <= OUTPUT_COALESCE_BYTES
        {
            pending.data.extend_from_slice(data);
            return;
        }
        self.flush_output();
        let mut buf = Vec::with_capacity(OUTPUT_COALESCE_BYTES.min(data.len().max(64 * 1024)));
        buf.extend_from_slice(data);
        self.x.pending_output = Some(PendingOutput { client, id, stream, data: buf });
    }

    /// Sends coalesced guest output.
    pub(crate) fn flush_output(&mut self) {
        let Some(pending) = self.x.pending_output.take() else { return };
        let out = px::ExecOutputRef {
            client: pending.client,
            id: pending.id,
            stream: pending.stream,
            data: &pending.data,
        };
        if !self.ctl.send(px::EXEC_OUTPUT, 0, &out) {
            self.x.inflight.shift_remove(&pending.id);
            self.x.stdin_allowed.remove(&pending.id);
            self.x.stdin_credits.remove(&pending.id);
        }
    }

    pub(crate) fn guest_exec_response(&mut self, id: u32, p: &Fields<'_>) {
        let exit_code = p.int("exit_code").and_then(|c| i32::try_from(c).ok());
        let signal = p.int("signal").and_then(|s| i32::try_from(s).ok());
        if self.debug_enabled("exec") {
            let sig = signal.map(|s| format!(" signal={s}")).unwrap_or_default();
            self.emit_debug(
                "exec",
                format!(
                    "exec done id={id} exit={}{sig}",
                    exit_code.map(|c| c.to_string()).unwrap_or_default()
                ),
            );
        }
        if let Some(&client) = self.x.inflight.get(&id) {
            let resp = px::ExecResponse { client, id, exit_code: exit_code.unwrap_or(1), signal };
            self.ctl.send(px::EXEC_RESPONSE, 0, &resp);
        }
        self.x.forget(id);
        self.x.started_execs.shift_remove(&id);
        self.schedule_idle_pause();
    }

    pub(crate) fn guest_stdin_window(&mut self, id: u32, p: &Fields<'_>) {
        let Some(credits) = p.number("stdin") else { return };
        if credits <= 0.0 {
            return;
        }
        if !self.x.inflight.contains_key(&id) {
            return;
        }
        let prev = self.x.stdin_credits.get(&id).copied().unwrap_or(0);
        let next = (prev + credits.trunc() as u64).min(u64::from(u32::MAX));
        self.x.stdin_credits.insert(id, next);
        if !self.flush_stdin_for(id) {
            self.x.io_flush_scheduled = true;
        }
    }

    /// The exec part of the guest `error` handler; returns after routing the
    /// error to an exec or a file operation.
    pub(crate) fn guest_exec_or_file_error(&mut self, id: u32, code: &str, message: &str) {
        let client = self.x.inflight.get(&id).copied();
        let tracked = self.x.started_execs.contains(&id) || client.is_some();
        if tracked && matches!(code, "stdin_backpressure" | "stdin_chunk_too_large") {
            // advisory: the exec keeps running
            return;
        }
        if let Some(client) = client {
            self.client_error(client, Some(id), code, message);
            self.x.forget(id);
            self.x.started_execs.shift_remove(&id);
        } else if self.f.ops.contains_key(&id) {
            self.reject_file_op(id, code, &format!("{code}: {message}"));
        } else if self.x.started_execs.contains(&id) {
            // orphaned exec (client disconnected)
            self.x.forget(id);
            self.x.started_execs.shift_remove(&id);
        } else if id == 0
            && let Some(active) = self.f.active
        {
            self.reject_file_op(active, code, &format!("{code}: {message}"));
        }
    }
}

fn describe_exec(f: &Fields<'_>) -> String {
    let id = f.int("id").map(|i| i.to_string()).unwrap_or_default();
    let cmd = f.text("cmd").unwrap_or("");
    let cwd = f.text("cwd").map(|c| format!(" cwd={c}")).unwrap_or_default();
    let argv = f
        .get("argv")
        .and_then(fields::string_list)
        .filter(|a| !a.is_empty())
        .map(|a| format!(" argv={}", json_list(&a)))
        .unwrap_or_default();
    let env_keys: Vec<String> = f
        .get("env")
        .and_then(fields::string_list)
        .unwrap_or_default()
        .iter()
        .map(|e| e.split('=').next().unwrap_or("").to_string())
        .filter(|k| !k.is_empty())
        .collect();
    let env = if env_keys.is_empty() {
        String::new()
    } else {
        format!(" envKeys={}", json_list(&env_keys))
    };
    let stdin = if f.truthy("stdin") { " stdin" } else { "" };
    let pty = if f.truthy("pty") { " pty" } else { "" };
    format!("exec start id={id} cmd={cmd}{cwd}{argv}{env}{stdin}{pty}")
}

fn json_list(items: &[String]) -> String {
    gondolin_wire::json::to_string(&gondolin_wire::ToValue::to_value(items))
}

//! Idle pause (port of the QMP parts of `SandboxController`): pause the VM via
//! QMP `stop` after a period without guest activity and resume it (`cont`
//! plus a guest clock sync) before the next guest interaction.
//!
//! Work that must wait for the resume is expressed as a [`Continuation`]; the
//! resume either completes them all or fails them all.

use std::collections::VecDeque;
use std::time::Duration;

use gondolin_proto::exec::ClientId;
use gondolin_proto::session::State;
use gondolin_wire::Value as Json;
use tokio::sync::oneshot;

use crate::guestmsg::{ExecRequest, TimeSync};
use crate::qmp::{self, QmpError};
use crate::session::{Event, Session, Timer};

/// Time to wait for `time_sync_done`.
pub const TIME_SYNC_TIMEOUT: Duration = Duration::from_millis(3000);

/// Work that waits for the VM to be resumed.
#[derive(Debug)]
pub(crate) enum Continuation {
    /// finish admitting an exec
    ExecAdmission { client: ClientId, id: u32, token: u64, request: ExecRequest },
    /// send the guest request of an admitted file operation
    FileSend { gid: u32 },
    /// a guest filesystem request (or another subsystem) waits
    External(oneshot::Sender<Result<(), String>>),
    /// re-arm the idle timer afterwards (network activity)
    ScheduleIdle,
}

/// A finished QMP command.
#[derive(Debug)]
pub struct QmpDone {
    pub command: &'static str,
    pub generation: u64,
    pub result: Result<Json, QmpError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResumeStage {
    /// waiting for `cont`
    Cont,
    /// `cont` failed, waiting for `query-status`
    Query,
    /// waiting for the guest clock sync
    TimeSync,
}

#[derive(Debug)]
struct ResumeOp {
    generation: u64,
    stage: ResumeStage,
    /// error of a failed `cont`
    cont_error: Option<String>,
    waiters: Vec<Continuation>,
}

#[derive(Debug)]
pub(crate) struct IdleState {
    /// idle timeout in `ms` (none: idle pause disabled)
    pause_ms: Option<u64>,
    paused: bool,
    pause_in_progress: bool,
    sync_pending: bool,
    /// set after a failed pause (`qmpIdleDisabled`)
    disabled: bool,
    /// `qmpGeneration`: bumped whenever the VMM changes
    generation: u64,
    timer_token: u64,
    timer_armed: bool,
    resume: Option<ResumeOp>,
    /// pending time sync request id
    time_sync: Option<u32>,
    next_time_sync_id: u32,
    qmp_queue: VecDeque<(&'static str, u64)>,
    qmp_running: bool,
    /// continuations completed outside the current call stack
    deferred: Vec<Continuation>,
}

impl Default for IdleState {
    fn default() -> Self {
        IdleState {
            pause_ms: None,
            paused: false,
            pause_in_progress: false,
            sync_pending: false,
            disabled: false,
            generation: 0,
            timer_token: 0,
            timer_armed: false,
            resume: None,
            time_sync: None,
            next_time_sync_id: 0x8000_0000,
            qmp_queue: VecDeque::new(),
            qmp_running: false,
            deferred: Vec::new(),
        }
    }
}

impl IdleState {
    pub(crate) fn configure(&mut self, pause_ms: Option<u64>) {
        self.pause_ms = pause_ms.filter(|ms| *ms > 0);
    }

    pub(crate) fn enabled(&self) -> bool {
        self.pause_ms.is_some()
    }

    pub(crate) fn time_sync_pending(&self) -> Option<u32> {
        self.time_sync
    }

    /// State reset when a new VMM starts.
    pub(crate) fn reset_for_start(&mut self) {
        self.invalidate();
        self.paused = false;
        self.pause_in_progress = false;
        self.sync_pending = false;
        self.disabled = false;
        self.qmp_queue.clear();
    }

    /// Bumps the generation; a pending resume completes (late QMP answers are
    /// ignored like stale generations in the node engine).
    pub(crate) fn invalidate(&mut self) {
        self.generation += 1;
        if let Some(op) = self.resume.take() {
            self.deferred.extend(op.waiters);
        }
    }
}

impl Session {
    /// `resumeControllerForActivity` followed by `cont`.
    pub(crate) fn resume_then(&mut self, cont: Continuation) {
        if !self.idle.enabled() {
            return self.run_continuation(cont, Ok(()));
        }
        self.cancel_idle_pause();
        if let Some(op) = self.idle.resume.as_mut() {
            op.waiters.push(cont);
            return;
        }
        if !self.idle.paused && !self.idle.pause_in_progress && !self.idle.sync_pending {
            return self.run_continuation(cont, Ok(()));
        }
        let generation = self.idle.generation;
        if self.idle.paused || self.idle.pause_in_progress {
            self.idle.resume = Some(ResumeOp {
                generation,
                stage: ResumeStage::Cont,
                cont_error: None,
                waiters: vec![cont],
            });
            self.qmp_command("cont");
        } else {
            self.idle.resume = Some(ResumeOp {
                generation,
                stage: ResumeStage::TimeSync,
                cont_error: None,
                waiters: vec![cont],
            });
            self.start_time_sync();
        }
    }

    fn run_continuation(&mut self, cont: Continuation, result: Result<(), String>) {
        match cont {
            Continuation::ExecAdmission { client, id, token, request } => match result {
                Ok(()) => self.exec_admitted(client, id, token, request),
                Err(err) => self.exec_admission_failed(client, id, token, &err),
            },
            Continuation::FileSend { gid } => match result {
                Ok(()) => self.file_send_request(gid),
                Err(err) => self.file_resume_failed(gid, &err),
            },
            Continuation::External(tx) => {
                let _ = tx.send(result);
            }
            Continuation::ScheduleIdle => {
                if let Err(err) = result {
                    self.emit_error(err);
                }
                self.schedule_idle_pause();
            }
        }
    }

    fn finish_resume(&mut self, result: Result<(), String>) {
        if let Some(op) = self.idle.resume.take() {
            for cont in op.waiters {
                self.run_continuation(cont, result.clone());
            }
        }
    }

    /// Runs continuations deferred by [`IdleState::invalidate`].
    pub(crate) fn run_deferred_continuations(&mut self) {
        for cont in std::mem::take(&mut self.idle.deferred) {
            self.run_continuation(cont, Ok(()));
        }
    }

    /// `scheduleControllerIdlePause`.
    pub(crate) fn schedule_idle_pause(&mut self) {
        if self.has_active_guest_activity() {
            return;
        }
        let i = &self.idle;
        if !i.enabled()
            || i.disabled
            || self.vm.child.is_none()
            || self.vm_state() != State::Running
            || i.paused
            || i.pause_in_progress
            || i.sync_pending
        {
            return;
        }
        self.cancel_idle_pause();
        self.idle.timer_armed = true;
        let token = self.idle.timer_token;
        let ms = self.idle.pause_ms.unwrap_or(0);
        let events = self.events.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            let _ = events.send(Event::Timer(Timer::IdlePause(token)));
        });
    }

    pub(crate) fn cancel_idle_pause(&mut self) {
        self.idle.timer_token += 1;
        self.idle.timer_armed = false;
    }

    /// `pauseForIdle`.
    pub(crate) fn idle_timer_fired(&mut self, token: u64) {
        if !self.idle.timer_armed || token != self.idle.timer_token {
            return;
        }
        self.idle.timer_armed = false;
        let i = &self.idle;
        if !i.enabled()
            || i.disabled
            || self.vm.child.is_none()
            || self.vm_state() != State::Running
            || i.paused
            || i.pause_in_progress
        {
            return;
        }
        self.idle.pause_in_progress = true;
        self.qmp_command("stop");
    }

    fn qmp_command(&mut self, command: &'static str) {
        self.idle.qmp_queue.push_back((command, self.idle.generation));
        self.pump_qmp();
    }

    fn pump_qmp(&mut self) {
        if self.idle.qmp_running {
            return;
        }
        let Some((command, generation)) = self.idle.qmp_queue.pop_front() else { return };
        let Some(path) = self.qmp_path() else {
            let result = Err(QmpError {
                reason: qmp::QmpErrorReason::SocketError,
                message: "qmp socket unavailable".into(),
                command_sent: false,
            });
            let _ = self.events.send(Event::Qmp(QmpDone { command, generation, result }));
            self.idle.qmp_running = true;
            return;
        };
        self.idle.qmp_running = true;
        let events = self.events.clone();
        tokio::spawn(async move {
            let result = qmp::execute(&path, command).await;
            let _ = events.send(Event::Qmp(QmpDone { command, generation, result }));
        });
    }

    pub(crate) fn qmp_done(&mut self, done: QmpDone) {
        self.idle.qmp_running = false;
        let current = done.generation == self.idle.generation;
        match done.command {
            "stop" => self.pause_done(current, done.result),
            "cont" => self.cont_done(current, done.result),
            "query-status" => self.query_done(current, done.result),
            _ => {}
        }
        self.pump_qmp();
    }

    fn pause_done(&mut self, current: bool, result: Result<Json, QmpError>) {
        if !current {
            return;
        }
        match result {
            Ok(_) => {
                if self.vm.child.is_some() && self.vm_state() == State::Running {
                    self.idle.paused = true;
                }
            }
            Err(err) => {
                self.idle.disabled = true;
                if err.unknown_outcome()
                    && self.vm.child.is_some()
                    && self.vm_state() == State::Running
                {
                    // it may be paused: keep paused=true so activity retries `cont`
                    self.idle.paused = true;
                    self.idle.pause_in_progress = false;
                    self.resume_then(Continuation::ScheduleIdle);
                }
                let line = format!("qmp idle pause disabled: {}", err.message);
                self.record_vmm_log_line(&line);
            }
        }
        self.idle.pause_in_progress = false;
    }

    fn resume_stage(&self) -> Option<(u64, ResumeStage)> {
        self.idle.resume.as_ref().map(|op| (op.generation, op.stage))
    }

    fn cont_done(&mut self, current: bool, result: Result<Json, QmpError>) {
        let Some((generation, ResumeStage::Cont)) = self.resume_stage() else { return };
        if !current || generation != self.idle.generation {
            return self.finish_resume(Ok(()));
        }
        match result {
            Ok(_) => self.resumed(),
            Err(err) => {
                let op = self.idle.resume.as_mut().unwrap();
                op.stage = ResumeStage::Query;
                op.cont_error = Some(err.message);
                self.qmp_command("query-status");
            }
        }
    }

    fn query_done(&mut self, current: bool, result: Result<Json, QmpError>) {
        let Some((generation, ResumeStage::Query)) = self.resume_stage() else { return };
        if !current || generation != self.idle.generation {
            return self.finish_resume(Ok(()));
        }
        let running = result.ok().as_ref().and_then(qmp::running_from_status);
        if running == Some(true) {
            self.resumed();
        } else {
            let err = self.idle.resume.as_mut().and_then(|op| op.cont_error.take());
            self.finish_resume(Err(err.unwrap_or_else(|| "qmp cont failed".into())));
        }
    }

    /// `cont` succeeded: sync the guest clock next.
    fn resumed(&mut self) {
        self.idle.paused = false;
        self.idle.pause_in_progress = false;
        self.idle.sync_pending = true;
        if let Some(op) = self.idle.resume.as_mut() {
            op.stage = ResumeStage::TimeSync;
        }
        self.start_time_sync();
    }

    /// `syncGuestClock`.
    fn start_time_sync(&mut self) {
        let id = self.idle.next_time_sync_id;
        self.idle.next_time_sync_id = if id == u32::MAX { 0x8000_0000 } else { id + 1 };
        self.idle.time_sync = Some(id);
        let unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if !self.guest_send("time_sync", id, TimeSync { unix_ms }) {
            self.reject_time_sync("virtio bridge queue exceeded during time sync");
            return;
        }
        let events = self.events.clone();
        tokio::spawn(async move {
            tokio::time::sleep(TIME_SYNC_TIMEOUT).await;
            let _ = events.send(Event::Timer(Timer::TimeSync(id)));
        });
    }

    pub(crate) fn time_sync_done(&mut self, id: u32) {
        if self.idle.time_sync != Some(id) {
            return;
        }
        self.idle.time_sync = None;
        if let Some((generation, ResumeStage::TimeSync)) = self.resume_stage() {
            if generation == self.idle.generation {
                self.idle.sync_pending = false;
            }
            self.finish_resume(Ok(()));
        }
    }

    pub(crate) fn time_sync_timeout(&mut self, id: u32) {
        if self.idle.time_sync == Some(id) {
            self.reject_time_sync("guest time sync timed out (update sandbox helpers)");
        }
    }

    pub(crate) fn reject_time_sync(&mut self, message: &str) {
        if self.idle.time_sync.take().is_none() {
            return;
        }
        if let Some((_, ResumeStage::TimeSync)) = self.resume_stage() {
            self.finish_resume(Err(message.to_string()));
        }
    }
}

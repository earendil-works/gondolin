//! The controller connection: framed CBOR envelopes on stdin/stdout.
//!
//! - [`Controller`] queues outgoing frames (never blocks the caller) and
//!   correlates daemon→controller requests with their `<t>_result` answers.
//!   Producers that can generate unbounded traffic (guest channel readers)
//!   call [`Controller::wait_capacity`] before reading more input, which keeps
//!   the queue bounded and pushes backpressure into the guest.
//! - [`Dispatcher`] routes incoming messages: answers to daemon requests,
//!   handlers registered by subsystems ([`ControllerHandler`], keyed by message
//!   type), and everything else to the session actor, which answers unknown
//!   types with `error { code: "unsupported" }`.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gondolin_proto::{ErrorEvent, PROTOCOL_VERSION, RESULT_SUFFIX, ResultError, Value};
#[cfg(test)]
use gondolin_wire::Envelope;
use gondolin_wire::ToValue;
use gondolin_wire::{FrameReader, RawEnvelope, WireError};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Notify, mpsc, oneshot};

use crate::panics::CatchUnwind;

/// Soft limit of queued outgoing bytes before producers are throttled.
pub const OUTGOING_SOFT_LIMIT: usize = 8 * 1024 * 1024;

/// Error of a daemon→controller request.
#[derive(Debug, Clone)]
pub enum CallError {
    /// the controller answered `ok: false`
    Remote(ResultError),
    /// the controller went away before answering
    Disconnected,
    Invalid(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Remote(e) => e.fmt(f),
            CallError::Disconnected => f.write_str("controller disconnected"),
            CallError::Invalid(m) => write!(f, "invalid response: {m}"),
        }
    }
}

impl std::error::Error for CallError {}

struct Outgoing {
    queue: VecDeque<Vec<u8>>,
    /// queued bytes not yet written
    bytes: usize,
    closed: bool,
}

/// Sending half of the controller connection (shared).
pub struct Controller {
    out: Mutex<Outgoing>,
    /// wakes the writer task
    writer_wake: Notify,
    /// wakes producers waiting for capacity
    capacity: Notify,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, CallError>>>>,
    next_id: AtomicU64,
    /// the controller stopped sending (its input reached EOF): requests to
    /// it can never be answered
    deaf: std::sync::atomic::AtomicBool,
}

impl Controller {
    pub fn new() -> Arc<Self> {
        Arc::new(Controller {
            out: Mutex::new(Outgoing { queue: VecDeque::new(), bytes: 0, closed: false }),
            writer_wake: Notify::new(),
            capacity: Notify::new(),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            deaf: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// The controller will send nothing more: fails pending and later
    /// requests at once (they could only wait forever) while output keeps
    /// flowing until [`Controller::close`].
    pub fn stop_requests(&self) {
        self.deaf.store(true, Ordering::SeqCst);
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err(CallError::Disconnected));
        }
    }

    /// Queues one message. Returns `false` when the connection is closed or the
    /// message could not be encoded (logged to stderr).
    pub fn send<P: ToValue + ?Sized>(&self, t: &str, id: u64, p: &P) -> bool {
        let frame = match encode_frame(t, id, p) {
            Ok(frame) => frame,
            Err(err) => {
                eprintln!("gondolind: dropping {t} message: {err}");
                return false;
            }
        };
        self.send_frame(frame)
    }

    /// Queues a `log` message without blocking (panic hook: the panicking
    /// thread may hold the queue lock already).
    pub fn try_send_log(&self, component: &str, message: &str) {
        let log =
            gondolin_proto::session::Log { component: component.into(), message: message.into() };
        let Ok(frame) = encode_frame(gondolin_proto::session::LOG, 0, &log) else { return };
        let Ok(mut out) = self.out.try_lock() else { return };
        if out.closed {
            return;
        }
        out.bytes += frame.len();
        out.queue.push_back(frame);
        drop(out);
        self.writer_wake.notify_one();
    }

    /// Queues an already framed message.
    pub fn send_frame(&self, frame: Vec<u8>) -> bool {
        let mut out = self.out.lock().unwrap();
        if out.closed {
            return false;
        }
        out.bytes += frame.len();
        out.queue.push_back(frame);
        drop(out);
        self.writer_wake.notify_one();
        true
    }

    /// Answers request `id` of type `t` with `ok: true` plus `fields`.
    pub fn reply_ok(&self, t: &str, id: u64, fields: Vec<(Value, Value)>) {
        self.send(&result_name(t), id, &gondolin_proto::ok_with(fields));
    }

    /// Answers request `id` of type `t` with an error.
    pub fn reply_err(&self, t: &str, id: u64, code: &str, message: &str) {
        self.send(&result_name(t), id, &ResultError::new(code, message));
    }

    /// Sends an unsolicited `error`.
    pub fn error_event(&self, code: &str, message: &str, of_type: Option<&str>) {
        let ev = ErrorEvent {
            code: code.into(),
            message: message.into(),
            r#type: of_type.map(str::to_string),
        };
        self.send(gondolin_proto::session::ERROR, 0, &ev);
    }

    /// Sends a request to the controller and waits for its `<t>_result`.
    /// Resolves to the result payload (with `ok: true`).
    pub async fn request<P: ToValue + ?Sized>(&self, t: &str, p: &P) -> Result<Value, CallError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            // checked under the lock `stop_requests` drains
            let mut pending = self.pending.lock().unwrap();
            if self.deaf.load(Ordering::SeqCst) {
                return Err(CallError::Disconnected);
            }
            pending.insert(id, tx);
        }
        if !self.send(t, id, p) {
            self.pending.lock().unwrap().remove(&id);
            return Err(CallError::Disconnected);
        }
        rx.await.unwrap_or(Err(CallError::Disconnected))
    }

    /// Waits until the outgoing queue is below [`OUTGOING_SOFT_LIMIT`].
    pub async fn wait_capacity(&self) {
        loop {
            let notified = self.capacity.notified();
            {
                let out = self.out.lock().unwrap();
                if out.closed || out.bytes < OUTGOING_SOFT_LIMIT {
                    return;
                }
            }
            notified.await;
        }
    }

    /// Takes the next queued frame (in-process controllers, instead of
    /// [`Controller::run_writer`]); `None` once the connection is closed.
    pub async fn next_frame(&self) -> Option<Vec<u8>> {
        loop {
            let notified = self.writer_wake.notified();
            {
                let mut out = self.out.lock().unwrap();
                if let Some(frame) = out.queue.pop_front() {
                    out.bytes = out.bytes.saturating_sub(frame.len());
                    drop(out);
                    self.capacity.notify_waiters();
                    return Some(frame);
                }
                if out.closed {
                    return None;
                }
            }
            notified.await;
        }
    }

    /// Bytes queued but not yet written.
    pub fn queued_bytes(&self) -> usize {
        self.out.lock().unwrap().bytes
    }

    /// Takes all queued frames (tests).
    #[cfg(test)]
    pub fn take_frames(&self) -> Vec<RawEnvelope> {
        let mut out = self.out.lock().unwrap();
        out.bytes = 0;
        out.queue.drain(..).map(|f| gondolin_wire::decode(&f[4..]).unwrap()).collect()
    }

    /// Completes a pending daemon request; returns `false` if `id` is unknown.
    fn complete(&self, id: u64, payload: Value) -> bool {
        let Some(tx) = self.pending.lock().unwrap().remove(&id) else {
            return false;
        };
        let ok = map_get(&payload, "ok").and_then(Value::as_bool).unwrap_or(false);
        let result = if ok {
            Ok(payload)
        } else {
            let code =
                map_get(&payload, "code").and_then(Value::as_text).unwrap_or("error").to_string();
            let message = map_get(&payload, "message")
                .and_then(Value::as_text)
                .unwrap_or("controller request failed")
                .to_string();
            Err(CallError::Remote(ResultError::new(code, message)))
        };
        let _ = tx.send(result);
        true
    }

    /// Marks the connection closed: fails pending requests, drops queued output.
    pub fn close(&self) {
        {
            let mut out = self.out.lock().unwrap();
            out.closed = true;
            out.queue.clear();
            out.bytes = 0;
        }
        self.writer_wake.notify_one();
        self.capacity.notify_waiters();
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err(CallError::Disconnected));
        }
    }

    /// Writes queued frames to `w` until the connection is closed and drained
    /// or a write fails.
    pub async fn run_writer<W: AsyncWrite + Unpin>(self: Arc<Self>, mut w: W) {
        // queued frames are written together (one write per batch, not per
        // frame): exec output arrives as many frames
        let mut batch: Vec<u8> = Vec::with_capacity(WRITE_BATCH);
        loop {
            let notified = self.writer_wake.notified();
            batch.clear();
            let mut single: Option<Vec<u8>> = None;
            let closed = {
                let mut out = self.out.lock().unwrap();
                while let Some(front) = out.queue.front() {
                    if !batch.is_empty() && batch.len() + front.len() > WRITE_BATCH {
                        break;
                    }
                    let frame = out.queue.pop_front().unwrap();
                    if batch.is_empty() && frame.len() >= WRITE_BATCH {
                        single = Some(frame);
                        break;
                    }
                    batch.extend_from_slice(&frame);
                }
                out.closed
            };
            if batch.is_empty() && single.is_none() {
                if closed {
                    return;
                }
                notified.await;
                continue;
            }
            let data: &[u8] = single.as_deref().unwrap_or(&batch);
            let len = data.len();
            let mut res = w.write_all(data).await;
            if res.is_ok() {
                res = w.flush().await;
            }
            {
                let mut out = self.out.lock().unwrap();
                out.bytes = out.bytes.saturating_sub(len);
            }
            self.capacity.notify_waiters();
            if res.is_err() {
                self.close();
                return;
            }
        }
    }
}

/// Bytes of queued frames written to the controller in one write.
const WRITE_BATCH: usize = 256 * 1024;

fn result_name(t: &str) -> String {
    gondolin_proto::result_type(t)
}

/// Encodes one framed envelope (length prefix and CBOR in one buffer).
pub fn encode_frame<P: ToValue + ?Sized>(t: &str, id: u64, p: &P) -> Result<Vec<u8>, WireError> {
    let env = Value::Map(vec![
        (Value::Text("v".into()), Value::Integer(PROTOCOL_VERSION.into())),
        (Value::Text("t".into()), Value::Text(t.into())),
        (Value::Text("id".into()), Value::Integer(id.into())),
        (Value::Text("p".into()), p.to_value()),
    ]);
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(&[0u8; 4]);
    gondolin_wire::cbor::encode_into(&env, &mut out);
    let len = out.len() - 4;
    if len > gondolin_wire::MAX_FRAME {
        return Err(WireError::FrameTooLarge(len));
    }
    out[..4].copy_from_slice(&(len as u32).to_be_bytes());
    Ok(out)
}

/// Looks up a text key in a CBOR map value.
pub fn map_get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_map()?.iter().find(|(k, _)| k.as_text() == Some(key)).map(|(_, v)| v)
}

/// Handler for controller messages of registered types (subsystems). It runs
/// on the controller reader task, so it must not block: spawn for anything
/// that waits. Requests (`id != 0`) must be answered with `<t>_result`.
pub trait ControllerHandler: Send + Sync + 'static {
    fn handle<'a>(&'a self, msg: RawEnvelope, ctl: &'a Arc<Controller>)
    -> crate::BoxFuture<'a, ()>;
}

/// Routes incoming controller messages. Clones share the handler table, so
/// subsystems can register handlers while the reader runs (at `configure`).
#[derive(Clone, Default)]
pub struct Dispatcher {
    handlers: Arc<std::sync::RwLock<HashMap<String, Arc<dyn ControllerHandler>>>>,
}

impl Dispatcher {
    /// Registers `handler` for message type `t` (replacing an earlier one).
    pub fn register(&self, t: impl Into<String>, handler: Arc<dyn ControllerHandler>) {
        self.handlers.write().unwrap().insert(t.into(), handler);
    }

    fn handler(&self, t: &str) -> Option<Arc<dyn ControllerHandler>> {
        self.handlers.read().unwrap().get(t).cloned()
    }

    /// Reads the controller input until EOF, routing messages. Returns when the
    /// input ends (or fails); the caller then shuts the session down.
    pub async fn run_reader<R: AsyncRead + Unpin>(
        &self,
        r: R,
        ctl: Arc<Controller>,
        session: mpsc::Sender<RawEnvelope>,
    ) -> Result<(), WireError> {
        let result = self.read_frames(r, &ctl, &session).await;
        // whatever ended the input (EOF, an error, the session gone), the
        // controller can no longer answer: shutdown work such as committing
        // dirty object files must not wait for it
        ctl.stop_requests();
        result
    }

    async fn read_frames<R: AsyncRead + Unpin>(
        &self,
        r: R,
        ctl: &Arc<Controller>,
        session: &mpsc::Sender<RawEnvelope>,
    ) -> Result<(), WireError> {
        let mut reader = FrameReader::new(r);
        loop {
            let skipped = reader.skipped_frames;
            let Some(frame) = reader.read_frame().await? else {
                return Ok(());
            };
            if reader.skipped_frames != skipped {
                ctl.error_event("invalid_request", "oversized frame skipped", None);
            }
            let msg: RawEnvelope = match gondolin_wire::decode(&frame) {
                Ok(m) => m,
                Err(err) => {
                    ctl.error_event("invalid_request", &format!("invalid message: {err}"), None);
                    continue;
                }
            };
            if !self.dispatch(msg, ctl, session).await {
                return Ok(());
            }
        }
    }

    /// Routes one controller message: answers to daemon requests, registered
    /// handlers, everything else to the session. Returns `false` once the
    /// session is gone.
    pub async fn dispatch(
        &self,
        msg: RawEnvelope,
        ctl: &Arc<Controller>,
        session: &mpsc::Sender<RawEnvelope>,
    ) -> bool {
        if msg.t.ends_with(RESULT_SUFFIX) && msg.id != 0 {
            if !ctl.complete(msg.id, msg.p.clone()) {
                ctl.error_event("unknown_id", "response for an unknown request", Some(&msg.t));
            }
            return true;
        }
        if let Some(handler) = self.handler(&msg.t) {
            let (t, id) = (msg.t.clone(), msg.id);
            // a panicking handler answers its request with an error
            // instead of leaving the controller waiting
            if let Err(panic) = CatchUnwind::new(handler.handle(msg, ctl)).await {
                let text = format!("internal error handling {t}: {panic}");
                if id != 0 {
                    ctl.reply_err(&t, id, "internal_error", &text);
                } else {
                    ctl.error_event("internal_error", &text, Some(&t));
                }
            }
            return true;
        }
        session.send(msg).await.is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gondolin_wire::FrameWriter;

    struct Echo;

    struct Panics;

    impl ControllerHandler for Panics {
        fn handle<'a>(
            &'a self,
            _msg: RawEnvelope,
            _ctl: &'a Arc<Controller>,
        ) -> crate::BoxFuture<'a, ()> {
            Box::pin(async move {
                panic!("handler bug");
            })
        }
    }

    impl ControllerHandler for Echo {
        fn handle<'a>(
            &'a self,
            msg: RawEnvelope,
            ctl: &'a Arc<Controller>,
        ) -> crate::BoxFuture<'a, ()> {
            Box::pin(async move {
                ctl.reply_ok(&msg.t, msg.id, vec![(Value::Text("echo".into()), msg.p)]);
            })
        }
    }

    #[tokio::test]
    async fn routing_and_requests() {
        crate::test_timeout(async {
            let (c_side, d_side) = tokio::io::duplex(64 * 1024);
            let (d_read, d_write) = tokio::io::split(d_side);
            let ctl = Controller::new();
            let dispatcher = Dispatcher::default();
            dispatcher.register("echo", Arc::new(Echo));
            dispatcher.register("boom", Arc::new(Panics));
            let (tx, mut rx) = mpsc::channel(4);
            let writer = tokio::spawn(ctl.clone().run_writer(d_write));
            let reader = {
                let ctl = ctl.clone();
                tokio::spawn(async move { dispatcher.run_reader(d_read, ctl, tx).await })
            };

            let (c_read, c_write) = tokio::io::split(c_side);
            let mut cw = FrameWriter::new(c_write);
            let mut cr = FrameReader::new(c_read);

            // daemon -> controller request, answered by the controller
            let req = {
                let ctl = ctl.clone();
                tokio::spawn(async move { ctl.request("vfs_call", &Value::Map(vec![])).await })
            };
            let msg = cr.read_envelope().await.unwrap().unwrap();
            assert_eq!(msg.t, "vfs_call");
            let answer = Envelope::new(
                "vfs_call_result",
                msg.id,
                Value::Map(vec![
                    (Value::Text("ok".into()), Value::Bool(false)),
                    (Value::Text("code".into()), Value::Text("EIO".into())),
                    (Value::Text("message".into()), Value::Text("x".into())),
                ]),
            );
            cw.write_message(&answer).await.unwrap();
            match req.await.unwrap() {
                Err(CallError::Remote(e)) => assert_eq!(e.code, "EIO"),
                other => panic!("unexpected {other:?}"),
            }

            // registered handler
            cw.write_message(&Envelope::new("echo", 9, Value::Integer(5.into()))).await.unwrap();
            let msg = cr.read_envelope().await.unwrap().unwrap();
            assert_eq!(msg.t, "echo_result");
            assert_eq!(msg.id, 9);
            assert_eq!(map_get(&msg.p, "echo"), Some(&Value::Integer(5.into())));

            // a panicking handler answers with an error and the reader keeps going
            cw.write_message(&Envelope::new("boom", 11, Value::Map(vec![]))).await.unwrap();
            let msg = cr.read_envelope().await.unwrap().unwrap();
            assert_eq!(msg.t, "boom_result");
            assert_eq!(msg.id, 11);
            assert_eq!(map_get(&msg.p, "code").and_then(Value::as_text), Some("internal_error"));

            // everything else goes to the session
            cw.write_message(&Envelope::new("start", 3, Value::Map(vec![]))).await.unwrap();
            assert_eq!(rx.recv().await.unwrap().t, "start");

            cw.into_inner().shutdown().await.unwrap();
            reader.await.unwrap().unwrap();
            ctl.close();
            writer.await.unwrap();
        })
        .await;
    }

    #[tokio::test]
    async fn requests_fail_once_the_controller_stopped_sending() {
        {
            let ctl = Controller::new();
            let pending = {
                let ctl = ctl.clone();
                tokio::spawn(async move { ctl.request("vfs_call", &Value::Null).await })
            };
            // wait for the request to be queued
            while ctl.pending.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
            ctl.stop_requests();
            assert!(matches!(pending.await.unwrap(), Err(CallError::Disconnected)));
            assert!(matches!(
                ctl.request("vfs_call", &Value::Null).await,
                Err(CallError::Disconnected)
            ));
        }
    }
}

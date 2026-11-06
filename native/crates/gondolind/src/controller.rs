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

use async_trait::async_trait;
use gondolin_proto::{ErrorEvent, PROTOCOL_VERSION, RESULT_SUFFIX, ResultError, Value};
use gondolin_wire::{Envelope, FrameReader, RawEnvelope, WireError};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Notify, mpsc, oneshot};

/// Soft limit of queued outgoing bytes before producers are throttled.
pub const OUTGOING_SOFT_LIMIT: usize = 8 * 1024 * 1024;

/// Error of a daemon→controller request.
#[derive(Debug, Clone, thiserror::Error)]
pub enum CallError {
    /// the controller answered `ok: false`
    #[error("{0}")]
    Remote(ResultError),
    /// the controller went away before answering
    #[error("controller disconnected")]
    Disconnected,
    #[error("invalid response: {0}")]
    Invalid(String),
}

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
}

impl Controller {
    pub fn new() -> Arc<Self> {
        Arc::new(Controller {
            out: Mutex::new(Outgoing { queue: VecDeque::new(), bytes: 0, closed: false }),
            writer_wake: Notify::new(),
            capacity: Notify::new(),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        })
    }

    /// Queues one message. Returns `false` when the connection is closed or the
    /// message could not be encoded (logged to stderr).
    pub fn send<P: Serialize + ?Sized>(&self, t: &str, id: u64, p: &P) -> bool {
        let frame = match encode_frame(t, id, p) {
            Ok(frame) => frame,
            Err(err) => {
                eprintln!("gondolind: dropping {t} message: {err}");
                return false;
            }
        };
        self.send_frame(frame)
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
    pub async fn request<P: Serialize + ?Sized>(&self, t: &str, p: &P) -> Result<Value, CallError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
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
        loop {
            let notified = self.writer_wake.notified();
            let frame = {
                let mut out = self.out.lock().unwrap();
                match out.queue.pop_front() {
                    Some(f) => Some(f),
                    None if out.closed => return,
                    None => None,
                }
            };
            let Some(frame) = frame else {
                notified.await;
                continue;
            };
            let len = frame.len();
            let res = w.write_all(&frame).await;
            let res = match res {
                Ok(()) if self.out.lock().unwrap().queue.is_empty() => w.flush().await,
                other => other,
            };
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

fn result_name(t: &str) -> String {
    gondolin_proto::result_type(t)
}

/// Encodes one framed envelope.
pub fn encode_frame<P: Serialize + ?Sized>(t: &str, id: u64, p: &P) -> Result<Vec<u8>, WireError> {
    let payload =
        gondolin_wire::encode(&Envelope { v: PROTOCOL_VERSION, t: t.to_string(), id, p })?;
    gondolin_wire::frame(&payload)
}

/// Looks up a text key in a CBOR map value.
pub fn map_get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_map()?.iter().find(|(k, _)| k.as_text() == Some(key)).map(|(_, v)| v)
}

/// Handler for controller messages of registered types (subsystems). It runs
/// on the controller reader task, so it must not block: spawn for anything
/// that waits. Requests (`id != 0`) must be answered with `<t>_result`.
#[async_trait]
pub trait ControllerHandler: Send + Sync + 'static {
    async fn handle(&self, msg: RawEnvelope, ctl: &Arc<Controller>);
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
            if msg.t.ends_with(RESULT_SUFFIX) && msg.id != 0 {
                if !ctl.complete(msg.id, msg.p.clone()) {
                    ctl.error_event("unknown_id", "response for an unknown request", Some(&msg.t));
                }
                continue;
            }
            if let Some(handler) = self.handler(&msg.t) {
                handler.handle(msg, &ctl).await;
                continue;
            }
            if session.send(msg).await.is_err() {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gondolin_wire::FrameWriter;

    struct Echo;

    #[async_trait]
    impl ControllerHandler for Echo {
        async fn handle(&self, msg: RawEnvelope, ctl: &Arc<Controller>) {
            ctl.reply_ok(&msg.t, msg.id, vec![(Value::Text("echo".into()), msg.p)]);
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
                tokio::spawn(async move { ctl.request("vfs_rpc", &Value::Map(vec![])).await })
            };
            let msg = cr.read_envelope().await.unwrap().unwrap();
            assert_eq!(msg.t, "vfs_rpc");
            let answer = Envelope::new(
                "vfs_rpc_result",
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
}

//! The guest's `virtio-fs` channel (sandboxfs RPC, `guest/ARCHITECTURE.md`
//! §6): framing, the `mounts` boot-configuration op, idle-pause resume and
//! activity accounting. Every other op goes to the configured
//! [`VfsBackend`]; without one the answer is `ENOSYS` (node engine with
//! `vfs: null`).

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use gondolin_wire::Value;
use tokio::sync::{mpsc, oneshot};

use crate::bootcfg::SandboxFsConfig;
use crate::controller::Controller;
use crate::fields::{self, Fields};
use crate::guest::{Outbox, PortHandler};
use crate::session::Event;
use crate::subsystem::{FsReply, VfsBackend, errno};

pub struct FsPortHandler {
    outbox: Arc<Outbox>,
    backend: Option<Arc<dyn VfsBackend>>,
    boot: Arc<Mutex<Option<SandboxFsConfig>>>,
    events: mpsc::UnboundedSender<Event>,
    /// set when `protocol` debugging is enabled
    debug: Option<Arc<Controller>>,
    /// per-op host time while `timing` debugging is on, reported when the
    /// guest disconnects ([`OpStats`])
    stats: Mutex<std::collections::BTreeMap<String, OpStats>>,
}

/// Host time of one fs op: from receiving the request to queueing the
/// response, and the part spent waiting for the session to admit it
/// (`VfsBegin`, the idle-pause gate).
#[derive(Default)]
struct OpStats {
    count: u64,
    total: std::time::Duration,
    gate: std::time::Duration,
    max: std::time::Duration,
}

impl FsPortHandler {
    pub fn new(
        outbox: Arc<Outbox>,
        backend: Option<Arc<dyn VfsBackend>>,
        boot: Arc<Mutex<Option<SandboxFsConfig>>>,
        events: mpsc::UnboundedSender<Event>,
        debug: Option<Arc<Controller>>,
    ) -> Self {
        FsPortHandler { outbox, backend, boot, events, debug, stats: Default::default() }
    }

    fn mounts_reply(&self) -> FsReply {
        match self.boot.lock().unwrap().as_ref() {
            Some(config) => FsReply::ok(Value::Map(vec![
                (Value::Text("mount".into()), Value::Text(config.fuse_mount.clone())),
                // the backend serves `readdirplus` (sandboxfs READDIRPLUS)
                (Value::Text("readdirplus".into()), Value::Bool(true)),
                // ... and `flush`/`fsync` (sandboxfs forwards FLUSH and FSYNC
                // instead of answering them itself)
                (Value::Text("flush".into()), Value::Bool(true)),
                // largest read/write the backend takes (sandboxfs: 60 KiB without it)
                (
                    Value::Text("max_data".into()),
                    Value::Integer((gondolin_vfs::rpc::MAX_RPC_DATA as u64).into()),
                ),
                (
                    Value::Text("binds".into()),
                    Value::Array(
                        config.fuse_binds.iter().map(|b| Value::Text(b.clone())).collect(),
                    ),
                ),
            ])),
            None => FsReply::error(errno::EAGAIN, "boot configuration unavailable"),
        }
    }

    async fn serve(&self, op: &str, req: Value) -> FsReply {
        if op == "lookup" && Fields::of(&req).text("name") == Some("gondolind-test-panic") {
            crate::panics::test_panic(crate::panics::TestPanic::Vfs);
        }
        if op == "mounts" {
            // boot configuration, served here rather than by the VFS backend
            return self.mounts_reply();
        }
        match &self.backend {
            None => FsReply::error(errno::ENOSYS, "filesystem service unavailable"),
            Some(backend) => backend.handle(op, req).await,
        }
    }
}

/// Moves the value of `key` out of the map `value` (`Null` when absent): the
/// request and response carry up to 1 MiB of data, which is never cloned.
fn take_field(value: &mut Value, key: &str) -> Value {
    if let Value::Map(entries) = value {
        for (k, v) in entries.iter_mut() {
            if matches!(k, Value::Text(t) if t == key) {
                return std::mem::take(v);
            }
        }
    }
    Value::Null
}

/// The `fs_response` envelope `{ v, t, id, p: { op, err, res?, message? } }`.
fn fs_response(id: u32, op: String, reply: FsReply) -> Value {
    let text = |s: &str| Value::Text(s.into());
    let mut p =
        vec![(text("op"), Value::Text(op)), (text("err"), Value::Integer(reply.err.into()))];
    if let Some(res) = reply.res {
        p.push((text("res"), res));
    }
    if let Some(message) = reply.message {
        p.push((text("message"), Value::Text(message)));
    }
    Value::Map(vec![
        (text("v"), Value::Integer(1)),
        (text("t"), text("fs_response")),
        (text("id"), Value::Integer(id.into())),
        (text("p"), Value::Map(p)),
    ])
}

/// Requests are handled one at a time, in the order the guest sent them
/// (`serve_connection` awaits each `frame` before reading the next), and
/// their responses are queued in that order. sandboxfs relies on it: it
/// answers RELEASE to the kernel without waiting for the host
/// (`sendUnanswered`), so a later request on the same file (an `open`
/// after a `commit: close` release, say) must not be handled before the
/// release. Handling requests concurrently would need sandboxfs to wait for
/// releases again, or per-file ordering here.
impl PortHandler for FsPortHandler {
    fn frame<'a>(&'a self, frame: Bytes) -> crate::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let mut msg: Value = gondolin_wire::decode_guest(&frame).map_err(|e| e.to_string())?;
            drop(frame);
            let f = Fields::of(&msg);
            let t = f.text("t").unwrap_or("").to_string();
            let id = fields::request_id(f.get("id"));
            let mut p = take_field(&mut msg, "p");
            let op = Fields::of(&p).text("op").unwrap_or("").to_string();
            if let Some(ctl) = &self.debug {
                let id_text = id.map(|i| i.to_string()).unwrap_or_else(|| "?".into());
                let extra = if t == "fs_request" { format!(" op={op}") } else { String::new() };
                let log = gondolin_proto::session::Log {
                    component: "protocol".into(),
                    message: format!("virtiofs rx t={t} id={id_text}{extra}"),
                };
                ctl.send(gondolin_proto::session::LOG, 0, &log);
            }
            let Some(id) = id else { return Ok(()) };
            if t != "fs_request" {
                return Ok(());
            }
            let req = match take_field(&mut p, "req") {
                Value::Null => Value::Map(vec![]),
                req => req,
            };

            let started = crate::timing::enabled().then(std::time::Instant::now);
            let (tx, rx) = oneshot::channel();
            let _ = self.events.send(Event::VfsBegin(tx));
            let admitted = rx.await;
            let gate = started.map(|s| s.elapsed());
            let reply = match admitted {
                // a panicking request fails with EIO; sandboxfs keeps serving
                Ok(Ok(())) => match crate::panics::CatchUnwind::new(self.serve(&op, req)).await {
                    Ok(reply) => reply,
                    Err(panic) => FsReply::error(errno::EIO, format!("internal error: {panic}")),
                },
                Ok(Err(err)) => FsReply::error(errno::EIO, err),
                Err(_) => FsReply::error(errno::EIO, "session closed"),
            };
            let _ = self.events.send(Event::VfsEnd);

            let timed_op = started.map(|_| op.clone());
            let sent = match gondolin_wire::frame_value(&fs_response(id, op, reply)) {
                Ok(frame) => self.outbox.send_frame(frame),
                Err(err) => {
                    eprintln!("gondolind: cannot encode fs_response: {err}");
                    false
                }
            };
            if !sent {
                let _ = self.events.send(Event::PortError {
                    port: "fs",
                    message: "virtio bridge queue exceeded".into(),
                });
            }
            if let (Some(started), Some(op)) = (started, timed_op) {
                let total = started.elapsed();
                let mut stats = self.stats.lock().unwrap();
                let s = stats.entry(op).or_default();
                s.count += 1;
                s.total += total;
                s.gate += gate.unwrap_or_default();
                s.max = s.max.max(total);
            }
            Ok(())
        })
    }

    fn error(&self, message: String) {
        let _ = self.events.send(Event::PortError { port: "fs", message });
    }

    fn disconnected(&self) {
        self.report_timing();
    }
}

impl FsPortHandler {
    /// Reports (once) the per-op host times collected while `timing`
    /// debugging is on.
    pub(crate) fn report_timing(&self) {
        let stats = std::mem::take(&mut *self.stats.lock().unwrap());
        for (op, s) in stats {
            let us = |d: std::time::Duration| d.as_micros() / u128::from(s.count.max(1));
            crate::timing::mark(format!(
                "fs {op}: {} requests, host {} µs each (session gate {} µs), max {} µs",
                s.count,
                us(s.total),
                us(s.gate),
                s.max.as_micros()
            ));
        }
    }
}

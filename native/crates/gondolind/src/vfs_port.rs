//! The guest's `virtio-fs` channel (sandboxfs RPC, `guest/ARCHITECTURE.md`
//! §6): framing, the `mounts` boot-configuration op, idle-pause resume and
//! activity accounting. Every other op goes to the configured
//! [`VfsBackend`]; without one the answer is `ENOSYS` (node engine with
//! `vfs: null`).

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use gondolin_wire::{Envelope, Value};
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
}

impl FsPortHandler {
    pub fn new(
        outbox: Arc<Outbox>,
        backend: Option<Arc<dyn VfsBackend>>,
        boot: Arc<Mutex<Option<SandboxFsConfig>>>,
        events: mpsc::UnboundedSender<Event>,
        debug: Option<Arc<Controller>>,
    ) -> Self {
        FsPortHandler { outbox, backend, boot, events, debug }
    }

    fn mounts_reply(&self) -> FsReply {
        match self.boot.lock().unwrap().as_ref() {
            Some(config) => FsReply::ok(Value::Map(vec![
                (Value::Text("mount".into()), Value::Text(config.fuse_mount.clone())),
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

gondolin_wire::wire_encode! {
    struct FsResponse<'a> {
        op: &'a str,
        err: i64,
        res: Option<Value>,
        message: Option<String>,
    }
}

impl PortHandler for FsPortHandler {
    fn frame<'a>(&'a self, frame: Bytes) -> crate::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let msg: Value = gondolin_wire::decode_guest(&frame).map_err(|e| e.to_string())?;
            let f = Fields::of(&msg);
            let t = f.text("t").unwrap_or("");
            let id = fields::request_id(f.get("id"));
            let p = f.get("p").cloned().unwrap_or(Value::Null);
            let pf = Fields::of(&p);
            let op = pf.text("op").unwrap_or("").to_string();
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
            let req = pf.get("req").cloned().unwrap_or(Value::Map(vec![]));

            let (tx, rx) = oneshot::channel();
            let _ = self.events.send(Event::VfsBegin(tx));
            let reply = match rx.await {
                // a panicking request fails with EIO; sandboxfs keeps serving
                Ok(Ok(())) => match crate::panics::CatchUnwind::new(self.serve(&op, req)).await {
                    Ok(reply) => reply,
                    Err(panic) => FsReply::error(errno::EIO, format!("internal error: {panic}")),
                },
                Ok(Err(err)) => FsReply::error(errno::EIO, err),
                Err(_) => FsReply::error(errno::EIO, "session closed"),
            };
            let _ = self.events.send(Event::VfsEnd);

            let response = Envelope::new(
                "fs_response",
                u64::from(id),
                FsResponse { op: &op, err: reply.err, res: reply.res, message: reply.message },
            );
            if !self.outbox.send(&response) {
                let _ = self.events.send(Event::PortError {
                    port: "fs",
                    message: "virtio bridge queue exceeded".into(),
                });
            }
            Ok(())
        })
    }

    fn error(&self, message: String) {
        let _ = self.events.send(Event::PortError { port: "fs", message });
    }
}

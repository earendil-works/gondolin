//! Session-level tests: exec queueing, stdin credit, file operations and
//! clients, ported from `host/test/sandbox-server-queueing.test.ts` where the
//! node engine has the same case.

use std::sync::Arc;

use gondolin_proto::session::{Configure, Limits, VmConfig};
use gondolin_wire::{Envelope, RawEnvelope, Value};

use crate::bootcfg::SandboxFsConfig;
use crate::controller::{Controller, Dispatcher};
use crate::fields::Fields;
use crate::qemu::HostInfo;
use crate::session::{ControlEvent, Session};

fn text(s: &str) -> Value {
    Value::Text(s.into())
}

fn int(i: i64) -> Value {
    Value::Integer(i.into())
}

fn map(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(entries.into_iter().map(|(k, v)| (text(k), v)).collect())
}

/// A minimal VM configuration for tests.
pub(crate) fn test_vm() -> VmConfig {
    VmConfig {
        qemu_path: "/bin/false".into(),
        image: None,
        vmm: None,
        krun_runner_path: None,
        firecracker_path: None,
        nitro: None,
        arch: None,
        kernel_path: "/k".into(),
        initrd_path: "/i".into(),
        root_disk: None,
        memory: "256M".into(),
        cpus: 1,
        machine_type: None,
        accel: None,
        cpu: None,
        console: Some("none".into()),
        append: None,
        append_extra: vec![],
        mac: None,
        auto_restart: false,
        idle_pause_ms: None,
    }
}

struct Harness {
    s: Session,
    ctl: Arc<Controller>,
}

impl Harness {
    fn new(limits: Limits) -> Self {
        let ctl = Controller::new();
        let host = HostInfo { os: "linux".into(), arch: "x64".into(), kvm_available: true };
        let (mut s, _channels) = Session::new(ctl.clone(), Dispatcher::default(), host);
        s.apply_configure(Configure { vm: test_vm(), limits, debug: vec![], vfs: None, net: None })
            .unwrap();
        s.boot_config = Some(SandboxFsConfig { fuse_mount: "/data".into(), fuse_binds: vec![] });
        Harness { s, ctl }
    }

    fn open(&mut self, client: u32) {
        self.msg("client_open", 0, map(vec![("client", int(client.into()))]));
        self.ctl.take_frames();
    }

    fn msg(&mut self, t: &str, id: u64, p: Value) {
        let bytes = gondolin_wire::encode(&Envelope::new(t, id, p)).unwrap();
        let env: RawEnvelope = gondolin_wire::decode(&bytes).unwrap();
        self.s.handle_controller(env);
        self.s.after_event();
    }

    fn exec(&mut self, client: u32, id: u32, extra: Vec<(&str, Value)>) {
        let mut fields = vec![
            ("client", int(client.into())),
            ("id", int(id.into())),
            ("cmd", text("/bin/sh")),
            ("argv", Value::Array(vec![text("-lc"), text("echo hi")])),
            ("env", Value::Array(vec![])),
            ("stdin", Value::Bool(true)),
            ("pty", Value::Bool(false)),
        ];
        for (k, v) in extra {
            fields.retain(|(key, _)| *key != k);
            fields.push((k, v));
        }
        self.msg("exec", 0, map(fields));
    }

    fn stdin(&mut self, client: u32, id: u32, data: &[u8], eof: bool) {
        self.msg(
            "stdin",
            0,
            map(vec![
                ("client", int(client.into())),
                ("id", int(id.into())),
                ("data", Value::Bytes(data.to_vec())),
                ("eof", Value::Bool(eof)),
            ]),
        );
    }

    fn guest(&mut self, t: &str, id: u32, p: Value) {
        let v = map(vec![("v", int(1)), ("t", text(t)), ("id", int(id.into())), ("p", p)]);
        self.s.handle_control(ControlEvent::Frame(v));
        self.s.after_event();
    }

    /// Frames sent to the guest as `(t, id, p)`.
    fn guest_frames(&self) -> Vec<(String, u32, Value)> {
        self.s
            .guest
            .take_frames()
            .into_iter()
            .filter_map(|v| {
                let f = Fields::of(&v);
                let t = f.text("t")?.to_string();
                if t == "filler" {
                    return None;
                }
                Some((t, f.int("id")? as u32, f.get("p").cloned().unwrap_or(Value::Null)))
            })
            .collect()
    }

    /// Fills the guest channel so further sends fail.
    fn jam(&self) {
        let filler = Envelope::new("filler", 0, Value::Bytes(vec![0; 8 * 1024 * 1024]));
        let frame = gondolin_wire::frame(&gondolin_wire::encode(&filler).unwrap());
        // the 4 MiB frame limit does not matter for the queue
        let frame = frame.unwrap_or_else(|_| {
            let payload = gondolin_wire::encode(&filler).unwrap();
            let mut out = (payload.len() as u32).to_be_bytes().to_vec();
            out.extend(payload);
            out
        });
        assert!(self.s.guest.send_frame(frame));
    }

    fn controller_frames(&self) -> Vec<RawEnvelope> {
        self.ctl.take_frames()
    }
}

fn client_errors(frames: &[RawEnvelope], id: u32) -> Vec<String> {
    frames
        .iter()
        .filter(|f| f.t == "client_error")
        .filter(|f| Fields::of(&f.p).int("id") == Some(id.into()))
        .map(|f| Fields::of(&f.p).text("code").unwrap_or("").to_string())
        .collect()
}

#[test]
fn execs_start_concurrently_without_file_operation() {
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.open(2);
    h.exec(1, 1, vec![]);
    h.exec(2, 2, vec![]);
    let frames = h.guest_frames();
    assert!(frames.iter().any(|(t, id, _)| t == "exec_request" && *id == 1));
    assert!(frames.iter().any(|(t, id, _)| t == "exec_request" && *id == 2));
    assert!(h.s.x.started_execs.contains(&1) && h.s.x.started_execs.contains(&2));
    // the request carries argv/env/stdin/pty and omits absent fields
    let p = &frames[0].2;
    let f = Fields::of(p);
    assert_eq!(f.text("cmd"), Some("/bin/sh"));
    assert_eq!(f.bool("stdin"), Some(true));
    assert!(f.get("cwd").is_none());
}

#[test]
fn max_queued_execs_caps_pressure() {
    let mut h = Harness::new(Limits { max_queued_execs: 1, ..Limits::default() });
    h.open(1);
    h.open(2);
    h.exec(1, 1, vec![]);
    h.exec(2, 2, vec![]);
    assert!(h.s.x.started_execs.contains(&1));
    assert!(!h.s.x.inflight.contains_key(&2));
    assert_eq!(client_errors(&h.controller_frames(), 2), vec!["queue_full"]);
}

#[test]
fn invalid_exec_and_duplicate_ids() {
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.msg("exec", 0, map(vec![("client", int(1)), ("id", Value::Float(1.5)), ("cmd", text("x"))]));
    let frames = h.controller_frames();
    let f = Fields::of(&frames[0].p);
    assert_eq!(f.text("code"), Some("invalid_request"));
    assert_eq!(f.text("message"), Some("exec requires uint32 id and cmd"));
    assert!(f.get("id").is_none());

    h.exec(1, 4, vec![("stdout_window", Value::Null)]);
    assert_eq!(client_errors(&h.controller_frames(), 4), vec!["invalid_request"]);

    h.exec(1, 5, vec![]);
    h.exec(1, 5, vec![]);
    assert_eq!(client_errors(&h.controller_frames(), 5), vec!["duplicate_id"]);
}

#[test]
fn missing_boot_and_unknown_clients() {
    let mut h = Harness::new(Limits::default());
    h.s.boot_config = None;
    h.open(1);
    h.exec(1, 1, vec![]);
    let frames = h.controller_frames();
    assert_eq!(Fields::of(&frames[0].p).text("code"), Some("missing_boot"));
    // messages of unknown clients are ignored
    h.exec(9, 2, vec![]);
    assert!(h.controller_frames().is_empty());
}

#[test]
fn started_exec_stdin_stays_buffered_under_queue_pressure() {
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.exec(1, 1, vec![]);
    h.guest("stdin_window", 1, map(vec![("stdin", int(1024))]));
    h.guest_frames();
    h.jam();
    h.stdin(1, 1, b"hello", false);
    assert!(h.s.x.queued_stdin.contains_key(&1), "stdin stays buffered after send failure");
    assert!(h.s.x.inflight.contains_key(&1));
    assert!(client_errors(&h.controller_frames(), 1).is_empty());

    h.guest_frames(); // drain
    h.s.handle_event(crate::session::Event::GuestWritable);
    h.s.after_event();
    let frames = h.guest_frames();
    let data: Vec<_> = frames.iter().filter(|(t, id, _)| t == "stdin_data" && *id == 1).collect();
    assert_eq!(data.len(), 1);
    assert_eq!(Fields::of(&data[0].2).bytes("data"), Some(&b"hello"[..]));
    assert!(!h.s.x.queued_stdin.contains_key(&1));
}

#[test]
fn stdin_is_gated_by_guest_credit() {
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.exec(1, 10, vec![]);
    h.guest_frames();
    h.stdin(1, 10, b"hello", true);
    assert!(h.guest_frames().is_empty());
    h.guest("stdin_window", 10, map(vec![("stdin", int(2))]));
    let frames = h.guest_frames();
    assert_eq!(frames.len(), 1);
    let f = Fields::of(&frames[0].2);
    assert_eq!(f.bytes("data"), Some(&b"he"[..]));
    assert!(f.get("eof").is_none());
    h.guest("stdin_window", 10, map(vec![("stdin", int(3))]));
    let frames = h.guest_frames();
    let f = Fields::of(&frames[0].2);
    assert_eq!(f.bytes("data"), Some(&b"llo"[..]));
    assert_eq!(f.bool("eof"), Some(true));
    assert!(!h.s.x.queued_stdin.contains_key(&10));
    assert_eq!(h.s.x.queued_stdin_total, 0);
}

#[test]
fn empty_eof_needs_no_credit_and_stdin_errors() {
    let mut h = Harness::new(Limits { max_stdin_bytes: 4, ..Limits::default() });
    h.open(1);
    h.exec(1, 1, vec![]);
    h.exec(1, 2, vec![("stdin", Value::Bool(false))]);
    h.guest_frames();
    h.stdin(1, 1, b"", true);
    let frames = h.guest_frames();
    assert_eq!(frames.len(), 1);
    assert_eq!(Fields::of(&frames[0].2).bool("eof"), Some(true));
    h.stdin(1, 1, b"12345", false);
    h.stdin(1, 2, b"x", false);
    h.stdin(1, 3, b"x", false);
    let frames = h.controller_frames();
    assert_eq!(client_errors(&frames, 1), vec!["payload_too_large"]);
    assert_eq!(client_errors(&frames, 2), vec!["stdin_disabled"]);
    assert_eq!(client_errors(&frames, 3), vec!["unknown_id"]);
}

#[test]
fn stdin_backpressure_errors_are_advisory() {
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.exec(1, 3, vec![]);
    for code in ["stdin_backpressure", "stdin_chunk_too_large"] {
        h.guest("error", 3, map(vec![("code", text(code)), ("message", text("x"))]));
    }
    assert!(client_errors(&h.controller_frames(), 3).is_empty());
    assert!(h.s.x.inflight.contains_key(&3) && h.s.x.started_execs.contains(&3));
    h.guest(
        "exec_output",
        3,
        map(vec![("stream", text("stdout")), ("data", Value::Bytes(b"ok".to_vec()))]),
    );
    let frames = h.controller_frames();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].t, "exec_output");
    assert_eq!(Fields::of(&frames[0].p).int("client"), Some(1));
    h.guest("exec_response", 3, map(vec![("exit_code", int(0))]));
    let frames = h.controller_frames();
    assert_eq!(frames[0].t, "exec_response");
    assert!(!h.s.x.inflight.contains_key(&3) && !h.s.x.started_execs.contains(&3));
}

#[test]
fn terminal_guest_error_fails_exec() {
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.exec(1, 3, vec![]);
    h.guest(
        "error",
        3,
        map(vec![("code", text("exec_failed")), ("message", text("failed to execute"))]),
    );
    assert_eq!(client_errors(&h.controller_frames(), 3), vec!["exec_failed"]);
    assert!(!h.s.x.inflight.contains_key(&3) && !h.s.x.started_execs.contains(&3));
}

#[test]
fn queued_exec_stdin_is_bounded_while_file_op_blocks_start() {
    let mut h = Harness::new(Limits::default());
    // resolved options as the node test uses them (bypassing the >= max_stdin_bytes rule)
    h.s.limits.max_queued_stdin_bytes = 10;
    h.open(1);
    h.s.f.active = Some(99);
    h.exec(1, 2, vec![]);
    h.stdin(1, 2, b"12345678", false);
    h.stdin(1, 2, b"abcde", false);
    assert_eq!(client_errors(&h.controller_frames(), 2), vec!["payload_too_large"]);
    assert!(!h.s.x.inflight.contains_key(&2));
    assert!(!h.s.x.started_execs.contains(&2));
    assert!(h.s.x.exec_queue.iter().all(|e| e.id != 2));
    assert!(!h.s.x.queued_stdin.contains_key(&2));
}

#[test]
fn queued_pty_resize_retries_after_queued_exec_starts() {
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.s.f.active = Some(100);
    h.exec(1, 2, vec![("pty", Value::Bool(true))]);
    h.msg(
        "pty_resize",
        0,
        map(vec![
            ("client", int(1)),
            ("id", int(2)),
            ("rows", int(40)),
            ("cols", Value::Float(100.7)),
        ]),
    );
    assert_eq!(h.s.x.queued_pty_resize.get(&2), Some(&(40, 100)));
    assert!(h.guest_frames().is_empty());

    // release the file operation; the exec starts, the resize cannot be sent
    h.s.f.active = None;
    h.jam();
    h.s.pump_exec_queue();
    assert!(!h.s.x.started_execs.contains(&2), "exec start fails while the channel is jammed");
    assert_eq!(client_errors(&h.controller_frames(), 2), vec!["queue_full"]);

    // again with a drained channel: exec request first, then the queued resize
    h.guest_frames();
    h.s.f.active = Some(100);
    h.exec(1, 2, vec![("pty", Value::Bool(true))]);
    h.msg(
        "pty_resize",
        0,
        map(vec![("client", int(1)), ("id", int(2)), ("rows", int(40)), ("cols", int(100))]),
    );
    h.s.f.active = None;
    h.s.pump_exec_queue();
    let frames = h.guest_frames();
    assert_eq!(frames[0].0, "exec_request");
    assert_eq!(frames[1].0, "pty_resize");
    assert!(!h.s.x.queued_pty_resize.contains_key(&2));
}

#[test]
fn queued_execs_bounded_by_max_queued_execs() {
    let mut h = Harness::new(Limits { max_queued_execs: 1, ..Limits::default() });
    h.open(1);
    h.open(2);
    h.s.f.active = Some(7);
    h.exec(1, 1, vec![]);
    h.exec(2, 2, vec![]);
    assert!(h.s.x.exec_queue.iter().any(|e| e.id == 1));
    assert_eq!(client_errors(&h.controller_frames(), 2), vec!["queue_full"]);
}

#[test]
fn total_queued_stdin_cap_applies_across_execs() {
    let mut h = Harness::new(Limits {
        max_queued_stdin_bytes: 100,
        max_total_queued_stdin_bytes: 10,
        ..Limits::default()
    });
    // apply_configure raises the total cap to at least the per-exec cap
    h.s.limits.max_total_queued_stdin_bytes = 10;
    h.open(2);
    h.open(3);
    h.s.f.active = Some(42);
    h.exec(2, 2, vec![]);
    h.exec(3, 3, vec![]);
    h.stdin(2, 2, b"123456", false);
    h.stdin(3, 3, b"abcdef", false);
    assert_eq!(client_errors(&h.controller_frames(), 3), vec!["payload_too_large"]);
    assert!(h.s.x.inflight.contains_key(&2));
    assert!(!h.s.x.inflight.contains_key(&3));
    assert_eq!(h.s.x.queued_stdin_total, 6);
}

#[test]
fn disconnect_keeps_started_ids_reserved_until_guest_finishes() {
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.open(2);
    h.exec(1, 11, vec![]);
    h.msg("client_close", 0, map(vec![("client", int(1))]));
    assert!(!h.s.x.inflight.contains_key(&11));
    assert!(h.s.x.started_execs.contains(&11));
    h.exec(2, 11, vec![]);
    assert_eq!(client_errors(&h.controller_frames(), 11), vec!["duplicate_id"]);
    // output of the orphan is dropped, its error clears the lifecycle
    h.guest(
        "exec_output",
        11,
        map(vec![("stream", text("stdout")), ("data", Value::Bytes(b"x".to_vec()))]),
    );
    assert!(h.controller_frames().is_empty());
    h.guest("error", 11, map(vec![("code", text("exec_failed")), ("message", text("failed"))]));
    assert!(!h.s.x.started_execs.contains(&11));
}

#[test]
fn exec_window_is_forwarded_only_for_the_owner() {
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.open(2);
    h.exec(1, 1, vec![]);
    h.guest_frames();
    h.msg("exec_window", 0, map(vec![("client", int(2)), ("id", int(1)), ("stdout", int(10))]));
    assert!(h.guest_frames().is_empty());
    h.msg("exec_window", 0, map(vec![("client", int(1)), ("id", int(1)), ("stdout", int(0))]));
    assert_eq!(client_errors(&h.controller_frames(), 1), vec!["invalid_request"]);
    h.jam();
    h.msg("exec_window", 0, map(vec![("client", int(1)), ("id", int(1)), ("stdout", int(10))]));
    h.msg("exec_window", 0, map(vec![("client", int(1)), ("id", int(1)), ("stderr", int(5))]));
    assert!(h.guest_frames().is_empty());
    h.s.handle_event(crate::session::Event::GuestWritable);
    h.s.after_event();
    let frames = h.guest_frames();
    assert_eq!(frames.len(), 1);
    let f = Fields::of(&frames[0].2);
    assert_eq!((f.int("stdout"), f.int("stderr")), (Some(10), Some(5)));
}

fn signal(h: &mut Harness, client: u32, id: u32, signal: i64) {
    h.msg(
        "exec_signal",
        0,
        map(vec![("client", int(client.into())), ("id", int(id.into())), ("signal", int(signal))]),
    );
}

#[test]
fn exec_signal_is_forwarded_when_the_guest_supports_it() {
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.open(2);
    h.exec(1, 1, vec![]);
    h.guest_frames();
    h.controller_frames();

    // an older guest (no features) is not sent the message
    signal(&mut h, 1, 1, 15);
    assert!(h.guest_frames().is_empty());
    assert!(h.controller_frames().iter().any(|f| f.t == "log"));

    h.guest("vfs_ready", 0, map(vec![("features", Value::Array(vec![text("exec_signal")]))]));
    // other clients and invalid signals are refused
    signal(&mut h, 2, 1, 15);
    assert!(h.guest_frames().is_empty());
    signal(&mut h, 1, 1, 0);
    assert_eq!(client_errors(&h.controller_frames(), 1), vec!["invalid_request"]);

    // retried once the guest channel drains
    h.jam();
    signal(&mut h, 1, 1, 9);
    assert!(h.guest_frames().is_empty());
    h.s.handle_event(crate::session::Event::GuestWritable);
    h.s.after_event();
    let frames = h.guest_frames();
    assert_eq!(frames.len(), 1);
    assert_eq!((frames[0].0.as_str(), frames[0].1), ("exec_signal", 1));
    assert_eq!(Fields::of(&frames[0].2).int("signal"), Some(9));
}

#[test]
fn exec_signal_drops_a_queued_exec() {
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.s.f.active = Some(100);
    h.exec(1, 2, vec![]);
    assert!(h.s.x.exec_queue.iter().any(|e| e.id == 2));
    h.controller_frames();
    signal(&mut h, 1, 2, 9);
    assert!(h.s.x.exec_queue.iter().all(|e| e.id != 2));
    assert!(!h.s.x.inflight.contains_key(&2));
    let frames = h.controller_frames();
    let resp = frames.iter().find(|f| f.t == "exec_response").expect("exec_response");
    let f = Fields::of(&resp.p);
    assert_eq!((f.int("id"), f.int("exit_code"), f.int("signal")), (Some(2), Some(137), Some(9)));
    h.s.f.active = None;
    h.s.pump_exec_queue();
    assert!(h.guest_frames().iter().all(|(t, _, _)| t != "exec_request"));
}

#[test]
fn file_operations_wait_for_exec_idle_and_block_execs() {
    let mut h = Harness::new(Limits::default());
    h.s.force_started_for_tests();
    h.open(1);
    h.exec(1, 1, vec![]);
    h.guest_frames();
    // the read waits for the running exec
    h.msg("file_read", 77, map(vec![("path", text("/etc/hostname"))]));
    assert!(h.guest_frames().is_empty());
    h.guest("exec_response", 1, map(vec![("exit_code", int(0))]));
    let frames = h.guest_frames();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].0, "file_read_request");
    let gid = frames[0].1;
    // allocateFileOpId skips ids in use by execs
    assert_ne!(gid, 0);
    let ctl = h.controller_frames();
    assert!(ctl.iter().any(|f| f.t == "file_started" && f.id == 77));

    // an exec submitted now is queued until the read finishes
    h.exec(1, 2, vec![]);
    assert!(h.guest_frames().is_empty());
    h.guest("file_read_data", gid, map(vec![("data", Value::Bytes(b"host\n".to_vec()))]));
    h.guest("file_read_done", gid, map(vec![]));
    let ctl = h.controller_frames();
    assert_eq!(ctl[0].t, "file_read_data");
    assert_eq!(ctl[0].id, 77);
    assert_eq!(ctl[1].t, "file_read_result");
    assert_eq!(Fields::of(&ctl[1].p).bool("ok"), Some(true));
    let frames = h.guest_frames();
    assert_eq!(frames[0].0, "exec_request");
    assert_eq!(frames[0].1, 2);
}

#[test]
fn file_errors_and_id_zero_errors_reject_the_active_operation() {
    let mut h = Harness::new(Limits::default());
    h.s.force_started_for_tests();
    h.msg("file_delete", 5, map(vec![("path", text("/x")), ("force", Value::Bool(true))]));
    let gid = h.guest_frames()[0].1;
    h.guest(
        "error",
        gid,
        map(vec![("code", text("file_delete_failed")), ("message", text("FileNotFound"))]),
    );
    let ctl = h.controller_frames();
    let result = ctl.iter().find(|f| f.t == "file_delete_result").unwrap();
    assert_eq!(Fields::of(&result.p).text("message"), Some("file_delete_failed: FileNotFound"));

    h.msg("file_read", 6, map(vec![("path", text("/x"))]));
    h.guest_frames();
    h.guest(
        "error",
        0,
        map(vec![
            ("code", text("invalid_request")),
            ("message", text("invalid file_read_request")),
        ]),
    );
    let ctl = h.controller_frames();
    let result = ctl.iter().find(|f| f.t == "file_read_result").unwrap();
    assert_eq!(result.id, 6);
    assert_eq!(Fields::of(&result.p).text("code"), Some("invalid_request"));
    assert!(h.s.f.active.is_none());
}

#[test]
fn file_write_streams_data_and_blocks_on_full_channel() {
    let mut h = Harness::new(Limits::default());
    h.s.force_started_for_tests();
    h.msg("file_write", 8, map(vec![("path", text("/tmp/x"))]));
    let frames = h.guest_frames();
    assert_eq!(frames[0].0, "file_write_request");
    assert_eq!(Fields::of(&frames[0].2).bool("truncate"), Some(true));
    let gid = frames[0].1;
    h.jam();
    h.msg("file_write_data", 8, map(vec![("data", Value::Bytes(vec![1; 100_000]))]));
    assert!(h.s.f.blocked.is_some(), "controller intake pauses while the guest channel is full");
    h.guest_frames();
    h.s.handle_event(crate::session::Event::GuestWritable);
    h.s.after_event();
    assert!(h.s.f.blocked.is_none());
    h.msg(
        "file_write_data",
        8,
        map(vec![("data", Value::Bytes(vec![])), ("eof", Value::Bool(true))]),
    );
    let frames = h.guest_frames();
    // 100000 bytes in 64 KiB chunks, then the eof frame
    let sizes: Vec<_> =
        frames.iter().map(|(_, _, p)| Fields::of(p).bytes("data").unwrap().len()).collect();
    assert_eq!(sizes, vec![65536, 34464, 0]);
    h.guest("file_write_done", gid, map(vec![]));
    let ctl = h.controller_frames();
    assert!(ctl.iter().any(|f| f.t == "file_write_result" && f.id == 8));
}

#[test]
fn file_cancel_before_and_after_admission() {
    let mut h = Harness::new(Limits::default());
    h.s.force_started_for_tests();
    h.open(1);
    h.exec(1, 1, vec![]);
    h.msg("file_read", 9, map(vec![("path", text("/x"))]));
    h.msg("file_cancel", 9, map(vec![]));
    let ctl = h.controller_frames();
    let result = ctl.iter().find(|f| f.t == "file_read_result").unwrap();
    assert_eq!(Fields::of(&result.p).text("message"), Some("operation aborted"));

    h.guest("exec_response", 1, map(vec![("exit_code", int(0))]));
    h.guest_frames();
    h.msg("file_write", 10, map(vec![("path", text("/tmp/y"))]));
    let gid = h.guest_frames()[0].1;
    h.msg("file_cancel", 10, map(vec![("message", text("operation aborted"))]));
    let frames = h.guest_frames();
    assert_eq!(frames[0].0, "file_write_data");
    assert_eq!(frames[0].1, gid);
    assert_eq!(Fields::of(&frames[0].2).bool("eof"), Some(true));
    assert!(h.s.f.active.is_none());
}

#[test]
fn vfs_error_closes_clients() {
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.guest("vfs_error", 0, map(vec![("message", text("  mount failed \n"))]));
    let ctl = h.controller_frames();
    let ts: Vec<_> = ctl.iter().map(|f| f.t.as_str()).collect();
    assert_eq!(ts, vec!["error", "client_error", "client_closed"]);
    assert_eq!(Fields::of(&ctl[0].p).text("message"), Some("[vfs] mount failed"));
    assert!(h.s.clients.is_empty());
}

#[test]
fn unknown_types_are_unsupported() {
    let mut h = Harness::new(Limits::default());
    h.msg("bogus", 3, map(vec![]));
    h.msg("bogus_event", 0, map(vec![]));
    let ctl = h.controller_frames();
    assert_eq!(ctl[0].t, "bogus_result");
    assert_eq!(Fields::of(&ctl[0].p).text("code"), Some("unsupported"));
    assert_eq!(ctl[1].t, "error");
    assert_eq!(Fields::of(&ctl[1].p).text("type"), Some("bogus_event"));
}

#[test]
fn back_to_back_output_is_coalesced_in_order() {
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.exec(1, 3, vec![]);
    h.controller_frames();
    let out = |stream: &str, data: &[u8]| {
        ControlEvent::Frame(map(vec![
            ("v", int(1)),
            ("t", text("exec_output")),
            ("id", int(3)),
            ("p", map(vec![("stream", text(stream)), ("data", Value::Bytes(data.to_vec()))])),
        ]))
    };
    // one round: stdout, stdout, stderr, stdout, then the response
    h.s.handle_control(out("stdout", b"a"));
    h.s.handle_control(out("stdout", b"b"));
    h.s.handle_control(out("stderr", b"c"));
    h.s.handle_control(out("stdout", b"d"));
    h.s.handle_control(ControlEvent::Frame(map(vec![
        ("v", int(1)),
        ("t", text("exec_response")),
        ("id", int(3)),
        ("p", map(vec![("exit_code", int(0))])),
    ])));
    h.s.after_event();
    let frames = h.controller_frames();
    let got: Vec<(String, Option<String>, Option<Vec<u8>>)> = frames
        .iter()
        .map(|f| {
            let p = Fields::of(&f.p);
            (f.t.clone(), p.text("stream").map(str::to_string), p.bytes("data").map(<[u8]>::to_vec))
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("exec_output".into(), Some("stdout".into()), Some(b"ab".to_vec())),
            ("exec_output".into(), Some("stderr".into()), Some(b"c".to_vec())),
            ("exec_output".into(), Some("stdout".into()), Some(b"d".to_vec())),
            ("exec_response".into(), None, None),
        ]
    );

    // a chunk that would exceed the bound starts a new frame
    let mut h = Harness::new(Limits::default());
    h.open(1);
    h.exec(1, 4, vec![]);
    h.controller_frames();
    let big = vec![7u8; crate::exec::OUTPUT_COALESCE_BYTES - 1];
    for data in [&big[..], b"xy"] {
        h.s.handle_control(ControlEvent::Frame(map(vec![
            ("v", int(1)),
            ("t", text("exec_output")),
            ("id", int(4)),
            ("p", map(vec![("stream", text("stdout")), ("data", Value::Bytes(data.to_vec()))])),
        ])));
    }
    h.s.after_event();
    let sizes: Vec<usize> = h
        .controller_frames()
        .iter()
        .map(|f| Fields::of(&f.p).bytes("data").map_or(0, <[u8]>::len))
        .collect();
    assert_eq!(sizes, vec![big.len(), 2]);
}

/// A crafted checkpoint (an external data file naming a host file) imported
/// in place is refused at `start`, before anything is attached or rewritten.
#[test]
fn crafted_checkpoint_is_refused_at_start() {
    use gondolin_proto::session::RootDisk;
    use gondolin_qcow2::header::{EXT_DATA_FILE, Extension, INCOMPAT_DATA_FILE};

    let dir = std::env::temp_dir().join(format!("gondolind-crafted-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let rootfs = dir.join("rootfs.ext4");
    std::fs::write(&rootfs, vec![0u8; 1 << 20]).unwrap();
    let ckpt = dir.join("ckpt.qcow2");
    crate::rootdisk::craft_qcow2(&ckpt, 1 << 20, Some(("/elsewhere/rootfs.ext4", "raw")), |h| {
        h.incompatible_features |= INCOMPAT_DATA_FILE;
        h.extensions.push(Extension { kind: EXT_DATA_FILE, data: b"/etc/passwd".to_vec() });
    });
    let before = std::fs::read(&ckpt).unwrap();

    let ctl = Controller::new();
    let host = HostInfo { os: "linux".into(), arch: "x64".into(), kvm_available: true };
    let (mut s, _channels) = Session::new(ctl.clone(), Dispatcher::default(), host);
    let mut vm = test_vm();
    vm.root_disk = Some(RootDisk {
        path: rootfs.display().to_string(),
        format: "raw".into(),
        read_only: false,
        snapshot: false,
        mode: Some("checkpoint".into()),
        size: None,
    });
    s.apply_configure(Configure {
        vm,
        limits: Limits::default(),
        debug: vec![],
        vfs: None,
        net: None,
    })
    .unwrap();
    let mut h = Harness { s, ctl };
    h.msg("checkpoint_import", 7, map(vec![("path", text(&ckpt.display().to_string()))]));
    let frames = h.controller_frames();
    let import = frames.iter().find(|f| f.t == "checkpoint_import_result").unwrap();
    assert_eq!(Fields::of(&import.p).bool("ok"), Some(true));

    h.msg("start", 8, map(vec![]));
    let frames = h.controller_frames();
    let start = frames.iter().find(|f| f.t == "start_result").unwrap();
    let f = Fields::of(&start.p);
    assert_eq!(f.bool("ok"), Some(false));
    let message = f.text("message").unwrap_or("");
    assert!(message.contains("external data file"), "{message}");
    assert!(std::fs::read(&ckpt).unwrap() == before);
    drop(h);
    // imported in place: the controller's file stays
    assert!(ckpt.exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// After `checkpoint_export` the VM stays stopped: restarts (lifecycle,
/// boot, auto-restart) and a second export fail with `invalid_state`.
#[test]
fn no_restart_after_checkpoint_export() {
    let mut h = Harness::new(Limits::default());
    h.s.ckpt.overlay =
        Some(crate::rootdisk::Overlay { path: "/nonexistent.qcow2".into(), base: None });
    h.s.ckpt.exported = true;
    h.msg("checkpoint_export", 3, map(vec![("path", text("/tmp/never.qcow2"))]));
    let frames = h.controller_frames();
    let res = frames.iter().find(|f| f.t == "checkpoint_export_result").unwrap();
    assert_eq!(Fields::of(&res.p).text("code"), Some("invalid_state"));

    h.s.restart_vm();
    h.s.start_vm();
    let frames = h.controller_frames();
    let errors: Vec<_> = frames
        .iter()
        .filter(|f| f.t == "error")
        .map(|f| Fields::of(&f.p).text("code").unwrap_or("").to_string())
        .collect();
    assert_eq!(errors, vec!["invalid_state", "invalid_state"]);
    assert!(h.s.vm.child.is_none());
}

/// An export while the VMM is still stopping (e.g. a restart in flight)
/// waits for it to exit before touching the disk.
#[tokio::test]
async fn checkpoint_export_waits_for_a_stopping_vmm() {
    let mut h = Harness::new(Limits::default());
    let dir = std::env::temp_dir().join(format!("gondolind-export-wait-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let disk = dir.join("rootfs.qcow2");
    std::fs::write(&disk, gondolin_qcow2::new_image(1 << 20, None).unwrap()).unwrap();
    h.s.ckpt.overlay = Some(crate::rootdisk::Overlay { path: disk.clone(), base: None });
    // a stop is pending: the child was taken, its exit not seen yet
    let generation = h.s.vm.generation;
    h.s.vm.stop_waiters.insert(generation, Vec::new());
    let dest = dir.join("ckpt.qcow2");
    h.msg("checkpoint_export", 4, map(vec![("path", text(&dest.display().to_string()))]));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(h.controller_frames().iter().all(|f| f.t != "checkpoint_export_result"));
    assert!(disk.exists() && !dest.exists(), "nothing moved while the VMM runs");

    h.s.vmm_exited(generation, Some(0), None);
    let mut result = None;
    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        if let Some(f) =
            h.controller_frames().into_iter().find(|f| f.t == "checkpoint_export_result")
        {
            result = Some(f);
            break;
        }
    }
    let result = result.expect("export answered after the exit");
    assert_eq!(Fields::of(&result.p).bool("ok"), Some(true), "{:?}", result.p);
    assert!(dest.exists() && !disk.exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Uploaded checkpoints are private files (mode 0600, not 0666 & umask).
#[test]
fn uploaded_checkpoints_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let mut h = Harness::new(Limits::default());
    h.msg("checkpoint_import", 9, map(vec![]));
    h.msg(
        "checkpoint_data",
        9,
        map(vec![("data", Value::Bytes(b"QFI\xfb".to_vec())), ("eof", Value::Bool(true))]),
    );
    let frames = h.controller_frames();
    let res = frames.iter().find(|f| f.t == "checkpoint_import_result").unwrap();
    assert_eq!(Fields::of(&res.p).bool("ok"), Some(true));
    let path = h.s.ckpt.imported.clone().unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    drop(h);
    assert!(!path.exists(), "an upload is removed with the session");
}

//! The session actor: one task owning all session state (originally a port of
//! the removed node engine's `SandboxServer` and `SandboxController`).
//!
//! Everything that changes state runs on this task, in the order events
//! arrive, which gives the same ordering guarantees as the single-threaded
//! node engine. Helpers on other tasks (guest channel readers, the QEMU
//! process, QMP commands, timers) only post [`Event`]s.
//!
//! Exec handling lives in `exec.rs`, guest file operations in `files.rs`, the
//! idle pause in `idle.rs`; this file has the event loop, configuration,
//! clients, boot, status and the VMM lifecycle.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::ordmap::OrderedSet;
use bytes::Bytes;
use gondolin_proto::exec as px;
use gondolin_proto::session::{self as ps, Configure, Limits, State};
use gondolin_wire::ToValue;
use gondolin_wire::{RawEnvelope, Value};
use tokio::sync::{mpsc, oneshot};

use crate::bootcfg::{self, RawBind, SandboxFsConfig};
use crate::controller::{Controller, Dispatcher};
use crate::exec::ExecState;
use crate::fields::{self, Fields};
use crate::files::FileState;
use crate::guest::{AbortOnDrop, GuestPort, Outbox, PortHandler};
use crate::idle::IdleState;
use crate::qemu::{self, ChardevPaths, HostInfo, LogTail, QemuArgs};
use crate::subsystem::{self, NetSetup, SubsystemContext, VfsBackend};
use crate::tcpfwd::{self, FwdDispatch, TcpForwarder};
use crate::vmm::{self, VmmEvent, VmmProcess};

/// Size limit of the control channel queue in `bytes` (`maxPendingBytes` of
/// the node engine: at least 8 MiB, twice `maxStdinBytes`).
fn control_queue_limit(limits: &Limits) -> usize {
    (8 * 1024 * 1024).max((limits.max_stdin_bytes as usize).saturating_mul(2))
}

/// Control channel events handled per round after the first (output coalescing).
const CONTROL_BATCH: usize = 256;

/// Delay before an automatic restart after an unexpected VM exit.
const AUTO_RESTART_DELAY: Duration = Duration::from_millis(1000);
/// How long a Firecracker guest may take to send its first control message
/// (healthy ones take ~1 s): an image without the vsock transport never does,
/// and would otherwise only hit the caller's much longer start timeout.
const FIRECRACKER_GUEST_DEADLINE: Duration = Duration::from_secs(30);

/// Events posted to the session task.
#[derive(Debug)]
pub enum Event {
    /// queued guest control frames were written
    GuestWritable,
    /// the VMM process of `generation` was spawned
    VmmSpawned(u64),
    /// a timer fired
    Timer(Timer),
    /// a QMP command finished
    Qmp(crate::idle::QmpDone),
    /// controller-side or subsystem activity changed (idle pause)
    Activity { source: String, active: bool },
    /// a guest filesystem request starts; answered once the VM is resumed
    VfsBegin(oneshot::Sender<Result<(), String>>),
    /// a guest filesystem request finished
    VfsEnd,
    /// a subsystem waits for the VM to be resumed (idle pause)
    Resume(oneshot::Sender<Result<(), String>>),
    /// `configure` with an image selector finished resolving
    ImageResolved { id: u64, result: Box<Result<(Configure, Value), String>> },
    /// a guest channel reported an error
    PortError { port: &'static str, message: String },
}

/// Timers, tagged so stale ones can be ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timer {
    /// idle pause timer with its token
    IdlePause(u64),
    /// automatic restart with its token
    Restart(u64),
    /// time sync timeout for the request id
    TimeSync(u32),
    /// the guest of this VMM generation must have spoken by now
    GuestDeadline(u64),
}

/// Events of the control channel (sandboxd).
#[derive(Debug)]
pub enum ControlEvent {
    Frame(Value),
    Error(String),
}

/// Handle subsystems use to report activity (keeps the VM from idling).
#[derive(Clone)]
pub struct ActivityHandle {
    events: mpsc::UnboundedSender<Event>,
}

impl ActivityHandle {
    pub fn set(&self, source: impl Into<String>, active: bool) {
        let _ = self.events.send(Event::Activity { source: source.into(), active });
    }
}

/// Private socket directory (removed on drop).
struct SocketDir(PathBuf);

impl Drop for SocketDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Resources that exist between `start` and shutdown.
struct Runtime {
    chardevs: ChardevPaths,
    ports: Vec<GuestPort>,
    /// netdev socket path when the network is served by the daemon
    netdev_path: Option<PathBuf>,
    netdev_task: Option<tokio::task::JoinHandle<()>>,
    qmp_path: Option<PathBuf>,
    /// vhost-user-fs device served by the daemon
    virtiofs: Option<VirtioFsRuntime>,
    /// the fs channel's handler (its `timing` statistics)
    fs_handler: Arc<crate::vfs_port::FsPortHandler>,
    /// Firecracker: the network namespace holding the guest NIC's tap (gone,
    /// with the tap, once dropped and the VMM has exited)
    #[cfg(target_os = "linux")]
    tap: Option<crate::tap::TapNet>,
    dir: SocketDir,
}

/// The virtio-fs socket and its accept thread.
struct VirtioFsRuntime {
    path: PathBuf,
    queues: usize,
    memory_backend: &'static str,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for VirtioFsRuntime {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Listens for the VMM's virtio-fs connection (one at a time; a restarted
/// VMM reconnects) and serves it on a dedicated thread: vhost-user for QEMU,
/// FUSE over the socket (`fuse_socket`) for krun.
fn spawn_virtiofs(
    path: &std::path::Path,
    service: Arc<dyn crate::subsystem::VirtioFsService>,
    fuse_socket: bool,
    stop: Arc<std::sync::atomic::AtomicBool>,
) -> std::io::Result<()> {
    let listener = std::os::unix::net::UnixListener::bind(path)?;
    listener.set_nonblocking(true)?;
    std::thread::Builder::new().name("virtiofs-accept".into()).spawn(move || {
        use std::sync::atomic::Ordering;
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((conn, _)) => {
                    let _ = conn.set_nonblocking(false);
                    if fuse_socket {
                        service.serve_socket(conn);
                    } else {
                        service.serve(conn);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
            }
        }
    })?;
    Ok(())
}

/// VMM lifecycle state (`SandboxController`).
#[derive(Default)]
pub(crate) struct VmState {
    pub(crate) state: Option<State>,
    pub(crate) child: Option<VmmProcess>,
    /// generation of the newest process
    pub(crate) generation: u64,
    /// the current process is being stopped on purpose
    manual_stop: bool,
    restart_token: u64,
    restart_pending: bool,
    /// generations being stopped and what to do once they exited
    pub(crate) stop_waiters: HashMap<u64, Vec<AfterStop>>,
    /// kernel command line of the next start
    append: String,
    /// the current generation's guest sent a control message
    guest_seen: bool,
    /// why the daemon stopped the current generation (reported with its exit)
    exit_reason: Option<String>,
}

/// What to do once a stopped VMM exited.
#[derive(Debug)]
pub(crate) enum AfterStop {
    /// start again (restart / boot with a changed configuration)
    Start,
    /// answer `shutdown` and exit
    Shutdown { id: u64 },
    /// export the root disk overlay (`checkpoint_export`; to `dest`, else streamed)
    Export { id: u64, dest: Option<PathBuf> },
}

/// The session.
pub struct Session {
    pub(crate) ctl: Arc<Controller>,
    dispatcher: Dispatcher,
    pub(crate) guest: Arc<Outbox>,
    guest_writable: Arc<AtomicBool>,
    pub(crate) events: mpsc::UnboundedSender<Event>,
    control_tx: mpsc::Sender<ControlEvent>,
    vmm_tx: mpsc::Sender<(u64, VmmEvent)>,
    host: HostInfo,

    configured: Option<Configure>,
    debug: HashSet<String>,
    pub(crate) limits: Limits,
    base_append: String,
    vfs: Option<Arc<dyn VfsBackend>>,
    net: NetSetup,
    runtime: Option<Runtime>,
    boot_shared: Arc<Mutex<Option<SandboxFsConfig>>>,

    pub(crate) clients: OrderedSet<px::ClientId>,
    pub(crate) boot_config: Option<SandboxFsConfig>,
    pub(crate) status: State,
    vfs_ready: bool,
    /// optional protocol features sandboxd announced (`vfs_ready`/`vfs_error`)
    pub(crate) guest_features: Vec<String>,

    pub(crate) x: ExecState,
    pub(crate) f: FileState,
    pub(crate) vm: VmState,
    pub(crate) idle: IdleState,
    log_tail: LogTail,
    active_vfs_requests: usize,
    activity_sources: HashMap<String, bool>,
    /// set once the session should end (shutdown answered or controller gone)
    pub(crate) finished: bool,
    /// shutdown in progress
    shutting_down: bool,
    /// tests: pretend `start` happened
    test_started: bool,
    /// root disk checkpoints (`checkpoint.rs`)
    pub(crate) ckpt: crate::checkpoint::CheckpointState,
}

/// Receivers of a session's event sources.
pub struct SessionChannels {
    pub events: mpsc::UnboundedReceiver<Event>,
    pub control: mpsc::Receiver<ControlEvent>,
    pub vmm: mpsc::Receiver<(u64, VmmEvent)>,
}

impl Session {
    pub fn new(
        ctl: Arc<Controller>,
        dispatcher: Dispatcher,
        host: HostInfo,
    ) -> (Self, SessionChannels) {
        crate::timing::start();
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (control_tx, control_rx) = mpsc::channel(64);
        let (vmm_tx, vmm_rx) = mpsc::channel(256);
        let guest_writable = Arc::new(AtomicBool::new(false));
        let limits = Limits::default();
        let guest = {
            let flag = guest_writable.clone();
            let events = events_tx.clone();
            Outbox::new(control_queue_limit(&limits), move || {
                if !flag.swap(true, Ordering::AcqRel) {
                    let _ = events.send(Event::GuestWritable);
                }
            })
        };
        let session = Session {
            ctl,
            dispatcher,
            guest,
            guest_writable,
            events: events_tx,
            control_tx,
            vmm_tx,
            host,
            configured: None,
            debug: HashSet::new(),
            limits,
            base_append: String::new(),
            vfs: None,
            net: NetSetup::None,
            runtime: None,
            boot_shared: Arc::new(Mutex::new(None)),
            clients: OrderedSet::new(),
            boot_config: None,
            status: State::Stopped,
            vfs_ready: false,
            guest_features: Vec::new(),
            x: ExecState::default(),
            f: FileState::default(),
            vm: VmState::default(),
            idle: IdleState::default(),
            log_tail: LogTail::default(),
            active_vfs_requests: 0,
            activity_sources: HashMap::new(),
            finished: false,
            shutting_down: false,
            test_started: false,
            ckpt: Default::default(),
        };
        (session, SessionChannels { events: events_rx, control: control_rx, vmm: vmm_rx })
    }

    /// Runs the session until it finished. `ctl_rx` carries controller messages
    /// that are not handled elsewhere; it closing means the controller is gone.
    pub async fn run(mut self, mut ch: SessionChannels, mut ctl_rx: mpsc::Receiver<RawEnvelope>) {
        let mut controller_gone = false;
        enum Next {
            Event(Event),
            Vmm(u64, VmmEvent),
            Control(ControlEvent),
            Controller(Option<RawEnvelope>),
        }
        while !self.finished {
            // biased: session events, VMM, guest control, then the controller
            let intake = !controller_gone && !self.intake_blocked();
            let next = std::future::poll_fn(|cx| {
                use std::task::Poll;
                if let Poll::Ready(Some(ev)) = ch.events.poll_recv(cx) {
                    return Poll::Ready(Next::Event(ev));
                }
                if let Poll::Ready(Some((generation, ev))) = ch.vmm.poll_recv(cx) {
                    return Poll::Ready(Next::Vmm(generation, ev));
                }
                if let Poll::Ready(Some(ev)) = ch.control.poll_recv(cx) {
                    return Poll::Ready(Next::Control(ev));
                }
                if intake && let Poll::Ready(msg) = ctl_rx.poll_recv(cx) {
                    return Poll::Ready(Next::Controller(msg));
                }
                Poll::Pending
            })
            .await;
            match next {
                Next::Event(ev) => self.handle_event(ev),
                Next::Vmm(generation, ev) => self.handle_vmm(generation, ev),
                Next::Control(ev) => {
                    self.handle_control(ev);
                    // handle what else is queued in the same round, so back
                    // to back output frames are coalesced
                    for _ in 0..CONTROL_BATCH {
                        if self.finished {
                            break;
                        }
                        let Ok(ev) = ch.control.try_recv() else { break };
                        self.handle_control(ev);
                    }
                }
                Next::Controller(Some(msg)) => self.handle_controller(msg),
                Next::Controller(None) => {
                    controller_gone = true;
                    self.controller_gone();
                }
            }
            self.after_event();
        }
        self.cleanup().await;
    }

    /// Work deferred to the end of an event (`setImmediate` in the node engine).
    pub(crate) fn after_event(&mut self) {
        self.flush_output();
        self.run_deferred_continuations();
        self.run_scheduled_flushes();
        self.pump_file_waiters();
    }

    // ---- helpers -------------------------------------------------------

    pub(crate) fn debug_enabled(&self, flag: &str) -> bool {
        self.debug.contains(flag)
    }

    /// Emits a debug event (`emitDebug`).
    pub(crate) fn emit_debug(&self, component: &str, message: impl Into<String>) {
        let message = message.into();
        let message = message.strip_suffix('\n').unwrap_or(&message).to_string();
        self.ctl.send(ps::LOG, 0, &ps::Log { component: component.into(), message });
    }

    /// Emits an `error` event (`this.emit("error", err)`); also logged as a
    /// debug `error` component like `SandboxServer` does.
    pub(crate) fn emit_error(&self, message: impl Into<String>) {
        let message = message.into();
        self.ctl.error_event("error", &message, None);
    }

    pub(crate) fn send_client<P: ToValue>(&self, t: &str, p: &P) {
        self.ctl.send(t, 0, p);
    }

    /// `sendError(client, { id?, code, message })`.
    pub(crate) fn client_error(
        &self,
        client: px::ClientId,
        id: Option<u32>,
        code: &str,
        message: &str,
    ) {
        self.send_client(
            px::CLIENT_ERROR,
            &px::ClientError { client, id, code: code.into(), message: message.into() },
        );
    }

    /// Queues a guest control message (`bridge.send`).
    pub(crate) fn guest_send<P: ToValue>(&self, t: &str, id: u32, p: P) -> bool {
        self.guest.send(&crate::guestmsg::envelope(t, id, p))
    }

    /// Controller intake is paused while a file upload waits for the guest
    /// channel to drain.
    fn intake_blocked(&self) -> bool {
        self.f.blocked.is_some()
    }

    // ---- event dispatch ------------------------------------------------

    pub(crate) fn handle_event(&mut self, ev: Event) {
        self.flush_output();
        match ev {
            Event::GuestWritable => {
                self.guest_writable.store(false, Ordering::Release);
                // bridge.onWritable
                self.x.window_flush_scheduled = true;
                self.x.io_flush_scheduled = true;
                self.retry_blocked_send();
            }
            Event::VmmSpawned(generation) => {
                if generation == self.vm.generation && self.vm.child.is_some() {
                    self.set_vm_state(State::Running);
                }
            }
            Event::Timer(timer) => match timer {
                Timer::IdlePause(token) => self.idle_timer_fired(token),
                Timer::Restart(token) => {
                    if self.vm.restart_pending && token == self.vm.restart_token {
                        self.vm.restart_pending = false;
                        self.start_vm();
                    }
                }
                Timer::TimeSync(id) => self.time_sync_timeout(id),
                Timer::GuestDeadline(generation) => self.guest_deadline(generation),
            },
            Event::Qmp(done) => self.qmp_done(done),
            Event::Activity { source, active } => self.external_activity(source, active),
            Event::VfsBegin(reply) => {
                self.cancel_idle_pause();
                self.active_vfs_requests += 1;
                self.resume_then(crate::idle::Continuation::External(reply));
            }
            Event::Resume(reply) => {
                self.resume_then(crate::idle::Continuation::External(reply));
            }
            Event::VfsEnd => {
                self.active_vfs_requests = self.active_vfs_requests.saturating_sub(1);
                self.schedule_idle_pause();
            }
            Event::PortError { port, message } => self.port_error(port, message),
            Event::ImageResolved { id, result } => self.configure_resolved(id, *result),
        }
    }

    fn port_error(&mut self, port: &'static str, message: String) {
        match port {
            "control" => {
                self.emit_error(format!("[virtio] bridge error: {message}"));
                let hint = self.log_tail.format_hint_for(self.vmm_label());
                self.fail_inflight(
                    "protocol_error",
                    &format!("virtio bridge error: {message}{hint}"),
                );
            }
            "fs" => self.emit_error(format!("[fs] virtio bridge error: {message}")),
            other => self.emit_error(format!("[{other}] virtio bridge error: {message}")),
        }
    }

    pub(crate) fn handle_controller(&mut self, msg: RawEnvelope) {
        self.flush_output();
        let t = msg.t.as_str();
        match t {
            ps::CONFIGURE => self.handle_configure(msg),
            ps::START => self.handle_start(msg.id),
            ps::SHUTDOWN => self.handle_shutdown(msg.id),
            ps::ACTIVITY => {
                let f = Fields::of(&msg.p);
                if let (Some(source), Some(active)) = (f.text("source"), f.bool("active")) {
                    self.external_activity(source.to_string(), active);
                }
            }
            px::CLIENT_OPEN
            | px::CLIENT_CLOSE
            | px::BOOT
            | px::EXEC
            | px::STDIN
            | px::PTY_RESIZE
            | px::EXEC_WINDOW
            | px::EXEC_SIGNAL
            | px::LIFECYCLE
            | px::CLIENT_UNKNOWN => self.handle_client_message(msg),
            crate::checkpoint::CHECKPOINT_EXPORT
            | crate::checkpoint::CHECKPOINT_IMPORT
            | crate::checkpoint::CHECKPOINT_DATA => self.handle_checkpoint_message(msg),
            gondolin_proto::files::FILE_READ
            | gondolin_proto::files::FILE_WRITE
            | gondolin_proto::files::FILE_DELETE
            | gondolin_proto::files::FILE_WRITE_DATA
            | gondolin_proto::files::FILE_CANCEL => self.handle_file_message(msg),
            _ => {
                if msg.id != 0 {
                    self.ctl.reply_err(
                        t,
                        msg.id,
                        "unsupported",
                        &format!("unsupported message type: {t}"),
                    );
                } else {
                    self.ctl.error_event(
                        "unsupported",
                        &format!("unsupported message type: {t}"),
                        Some(t),
                    );
                }
            }
        }
    }

    // ---- configure / start / shutdown ------------------------------------

    fn handle_configure(&mut self, msg: RawEnvelope) {
        if self.configured.is_some() {
            self.ctl.reply_err(
                ps::CONFIGURE,
                msg.id,
                "invalid_state",
                "session is already configured",
            );
            return;
        }
        let cfg: Configure = match msg.payload() {
            Ok(cfg) => cfg,
            Err(err) => {
                self.ctl.reply_err(
                    ps::CONFIGURE,
                    msg.id,
                    "invalid_request",
                    &format!("invalid configure: {err}"),
                );
                return;
            }
        };
        if crate::image::needs_resolution(&cfg.vm) {
            crate::image::resolve_async(
                cfg,
                msg.id,
                self.host.clone(),
                self.ctl.clone(),
                self.events.clone(),
            );
            return;
        }
        if let Err(err) = self.apply_configure(cfg) {
            self.ctl.reply_err(ps::CONFIGURE, msg.id, "invalid_request", &err);
            return;
        }
        self.ctl.reply_ok(ps::CONFIGURE, msg.id, vec![]);
    }

    fn configure_resolved(&mut self, id: u64, result: Result<(Configure, Value), String>) {
        let (cfg, image) = match result {
            Ok(r) => r,
            Err(err) => {
                self.ctl.reply_err(ps::CONFIGURE, id, "image_unavailable", &err);
                return;
            }
        };
        if self.configured.is_some() {
            self.ctl.reply_err(ps::CONFIGURE, id, "invalid_state", "session is already configured");
            return;
        }
        let build_id = crate::fields::Fields::of(&image).text("build_id").map(str::to_string);
        match self.apply_configure(cfg) {
            Ok(()) => {
                self.ckpt.image_build_id = build_id;
                self.ctl.reply_ok(ps::CONFIGURE, id, vec![(Value::Text("image".into()), image)])
            }
            Err(err) => self.ctl.reply_err(ps::CONFIGURE, id, "invalid_request", &err),
        }
    }

    pub(crate) fn apply_configure(&mut self, mut cfg: Configure) -> Result<(), String> {
        match cfg.vm.vmm.as_deref() {
            None | Some("qemu") => {
                if cfg.vm.qemu_path.is_empty() {
                    return Err("vm.qemu_path is required (or vm.image)".into());
                }
            }
            Some("krun") => crate::krun::validate(&cfg.vm)?,
            // checked by `firecracker::prepare` below
            Some("firecracker") => {}
            Some(other) => return Err(format!("unsupported vmm: {other}")),
        }
        if cfg.vm.root_disk.as_ref().is_some_and(|d| d.path.is_empty()) {
            return Err("vm.root_disk.path is required (or vm.image)".into());
        }
        if cfg.vm.kernel_path.is_empty()
            || (cfg.vm.initrd_path.is_empty() && !qemu::is_krun(&cfg.vm))
        {
            return Err("vm.kernel_path and vm.initrd_path are required".into());
        }
        if crate::firecracker::is_firecracker(&cfg.vm) {
            crate::firecracker::prepare(&mut cfg.vm)?;
        }
        if qemu::uses_qemu(&cfg.vm)
            && let Some(machine) = qemu::machine_fallback(&cfg.vm, &self.host)
        {
            gondolin_log::debug!("{} has no microvm machine; using {machine}", cfg.vm.qemu_path);
            cfg.vm.machine_type = Some(machine.to_string());
        }
        if cfg.vm.cpus == 0 {
            return Err("vm.cpus must be at least 1".into());
        }
        if let Some(disk) = &cfg.vm.root_disk
            && disk.format != "raw"
            && disk.format != "qcow2"
        {
            return Err(format!("unsupported root disk format: {}", disk.format));
        }
        if let Some(console) = &cfg.vm.console
            && console != "stdio"
            && console != "none"
        {
            return Err(format!("unsupported console mode: {console}"));
        }
        let ctx = SubsystemContext {
            ctl: self.ctl.clone(),
            dispatcher: self.dispatcher.clone(),
            activity: ActivityHandle { events: self.events.clone() },
            debug: cfg.debug.clone(),
        };
        let vfs = subsystem::build_vfs(cfg.vfs.as_ref(), &ctx)?;
        let net = subsystem::build_net(cfg.net.as_ref(), &ctx)?;
        self.limits = Limits {
            max_queued_stdin_bytes: cfg
                .limits
                .max_queued_stdin_bytes
                .max(cfg.limits.max_stdin_bytes),
            max_total_queued_stdin_bytes: cfg
                .limits
                .max_total_queued_stdin_bytes
                .max(cfg.limits.max_queued_stdin_bytes.max(cfg.limits.max_stdin_bytes)),
            ..cfg.limits
        };
        self.guest = {
            let flag = self.guest_writable.clone();
            let events = self.events.clone();
            Outbox::new(control_queue_limit(&self.limits), move || {
                if !flag.swap(true, Ordering::AcqRel) {
                    let _ = events.send(Event::GuestWritable);
                }
            })
        };
        self.debug = cfg.debug.iter().cloned().collect();
        crate::timing::enable(self.debug_enabled("timing").then(|| self.ctl.clone()));
        crate::timing::mark("configured");
        self.base_append = qemu::quiet_boot(
            qemu::base_append(&cfg.vm, &self.host),
            &cfg.vm,
            self.debug_enabled("protocol"),
        );
        if let Some(arg) = match &net {
            NetSetup::Native(backend) => backend.guest_net_arg(),
            NetSetup::None => None,
        } {
            self.base_append = format!("{} {arg}", self.base_append);
        }
        self.vm.append = self.base_append.clone();
        self.idle.configure(if qemu::uses_qemu(&cfg.vm) { cfg.vm.idle_pause_ms } else { None });
        self.vfs = vfs;
        self.net = net;
        self.configured = Some(cfg);
        Ok(())
    }

    fn handle_start(&mut self, id: u64) {
        if self.configured.is_none() {
            self.ctl.reply_err(ps::START, id, "invalid_state", "configure the session first");
            return;
        }
        if let Some(rt) = &self.runtime {
            let dir = rt.dir.0.display().to_string();
            self.ctl.reply_ok(
                ps::START,
                id,
                vec![(Value::Text("socket_dir".into()), Value::Text(dir))],
            );
            return;
        }
        match self.start_runtime() {
            Ok(()) => {
                let dir = self.runtime.as_ref().unwrap().dir.0.display().to_string();
                self.ctl.reply_ok(
                    ps::START,
                    id,
                    vec![(Value::Text("socket_dir".into()), Value::Text(dir))],
                );
            }
            Err(err) => self.ctl.reply_err(ps::START, id, "start_failed", &err),
        }
    }

    fn start_runtime(&mut self) -> Result<(), String> {
        let dir = make_socket_dir().map_err(|e| format!("cannot create socket directory: {e}"))?;
        let mut firecracker = false;
        if let Some(cfg) = self.configured.as_mut() {
            firecracker = crate::firecracker::is_firecracker(&cfg.vm);
            if firecracker {
                crate::rootdisk::prepare_raw(&mut cfg.vm, &dir.0)?;
                self.ckpt.overlay = None;
                self.ckpt.export_blocker = Some(
                    "cannot checkpoint: checkpoints are not supported with vmm=firecracker".into(),
                );
            } else {
                let krun = qemu::is_krun(&cfg.vm);
                self.ckpt.overlay = crate::rootdisk::prepare(
                    &mut cfg.vm,
                    &dir.0,
                    krun,
                    self.ckpt.imported.as_deref(),
                )?;
                self.ckpt.export_blocker =
                    crate::rootdisk::export_blocker(cfg.vm.root_disk.as_ref());
            }
            check_vmm_binary(&cfg.vm)?;
        }
        crate::timing::mark("root disk ready");
        let path = |name: &str| dir.0.join(name);
        let chardevs = if firecracker {
            // where Firecracker forwards the guest's vsock connections
            crate::firecracker::chardev_paths(&dir.0)
        } else {
            ChardevPaths {
                control: path("control.sock"),
                fs: path("fs.sock"),
                ssh: path("ssh.sock"),
                ingress: path("ingress.sock"),
            }
        };
        let mut ports = Vec::new();
        let control_handler =
            Arc::new(ControlHandler { tx: self.control_tx.clone(), ctl: self.ctl.clone() });
        ports.push(
            GuestPort::listen("control", &chardevs.control, self.guest.clone(), control_handler)
                .map_err(|e| format!("cannot listen on the control channel: {e}"))?,
        );
        let fs_outbox = Outbox::new(8 * 1024 * 1024, || {});
        let fs_handler = Arc::new(crate::vfs_port::FsPortHandler::new(
            fs_outbox.clone(),
            self.vfs.clone(),
            self.boot_shared.clone(),
            self.events.clone(),
            self.debug_enabled("protocol").then(|| self.ctl.clone()),
        ));
        ports.push(
            GuestPort::listen("fs", &chardevs.fs, fs_outbox, fs_handler.clone())
                .map_err(|e| format!("cannot listen on the fs channel: {e}"))?,
        );
        let mut forwarders = Vec::new();
        for (name, p) in [("ssh", &chardevs.ssh), ("ingress", &chardevs.ingress)] {
            // long-lived, high-throughput streams: a larger queue like the node engine
            let outbox = Outbox::new(64 * 1024 * 1024, || {});
            let fwd =
                TcpForwarder::new(name, outbox.clone(), self.ctl.clone(), self.events.clone());
            ports.push(
                GuestPort::listen(name, p, outbox, fwd.clone())
                    .map_err(|e| format!("cannot listen on the {name} channel: {e}"))?,
            );
            forwarders.push(fwd);
        }
        let dispatch =
            Arc::new(FwdDispatch { ssh: forwarders[0].clone(), ingress: forwarders[1].clone() });
        for t in [
            tcpfwd::FWD_OPEN,
            tcpfwd::FWD_DATA,
            tcpfwd::FWD_EOF,
            tcpfwd::FWD_CLOSE,
            tcpfwd::FWD_WINDOW,
        ] {
            self.dispatcher.register(t, dispatch.clone());
        }
        #[cfg(target_os = "linux")]
        let mut tap = None;
        let (netdev_path, netdev_task) = match &self.net {
            #[cfg(target_os = "linux")]
            NetSetup::Native(backend) if firecracker => {
                // Firecracker attaches the guest NIC to a tap; the stack
                // reads the guest's frames with a packet socket on it
                let name = crate::tap::tap_name(std::process::id(), next_tap_id());
                let mut created = crate::tap::TapNet::create(&name).map_err(|e| e.to_string())?;
                let socket = created.take_socket().map_err(|e| format!("tap {name}: {e}"))?;
                let backend = backend.clone();
                let task =
                    tokio::spawn(async move { backend.serve_frames(Arc::new(socket)).await });
                tap = Some(created);
                crate::timing::mark("tap ready");
                (None, Some(task))
            }
            NetSetup::Native(backend) => {
                let p = path("net.sock");
                let listener = tokio::net::UnixListener::bind(&p)
                    .map_err(|e| format!("cannot listen on the netdev socket: {e}"))?;
                let backend = backend.clone();
                let task = tokio::spawn(async move {
                    let mut current: Option<AbortOnDrop> = None;
                    while let Ok((stream, _)) = listener.accept().await {
                        drop(current.take());
                        let backend = backend.clone();
                        current =
                            Some(AbortOnDrop(tokio::spawn(
                                async move { backend.serve(stream).await },
                            )));
                    }
                });
                (Some(p), Some(task))
            }
            _ => (None, None),
        };
        let qmp_path = self.idle.enabled().then(|| path("qmp.sock"));
        let virtiofs = self.setup_virtiofs(&path("virtiofs.sock"))?;
        self.runtime = Some(Runtime {
            chardevs,
            ports,
            netdev_path,
            netdev_task,
            qmp_path,
            virtiofs,
            fs_handler,
            #[cfg(target_os = "linux")]
            tap,
            dir,
        });
        Ok(())
    }

    /// Serves the VFS over virtio-fs when the backend offers it and the QEMU
    /// binary supports vhost-user-fs with shared RAM; otherwise the guest
    /// keeps using sandboxfs over virtio-serial.
    fn setup_virtiofs(&self, sock: &std::path::Path) -> Result<Option<VirtioFsRuntime>, String> {
        let Some(service) = self.vfs.as_ref().and_then(|v| v.virtio_fs()) else {
            return Ok(None);
        };
        let Some(cfg) = self.configured.as_ref() else { return Ok(None) };
        if crate::firecracker::is_firecracker(&cfg.vm) {
            // Firecracker has no virtio-fs device: sandboxfs over vsock
            let message = "virtio-fs unavailable with vmm=firecracker; using sandboxfs";
            if service.required() {
                gondolin_log::warn!("{message}");
            } else {
                gondolin_log::debug!("{message}");
            }
            return Ok(None);
        }
        if qemu::is_krun(&cfg.vm) {
            let runner = crate::krun::runner_path(&cfg.vm);
            if !crate::krun::runner_capabilities(&runner)
                .iter()
                .any(|c| c == crate::krun::CAP_VIRTIOFS_SOCKET)
            {
                let message = format!(
                    "virtio-fs unavailable ({runner} lacks the virtiofs-socket capability); using sandboxfs"
                );
                if service.required() {
                    gondolin_log::warn!("{message}");
                    let log = gondolin_proto::session::Log { component: "vfs".into(), message };
                    self.ctl.send(gondolin_proto::session::LOG, 0, &log);
                } else {
                    self.emit_debug("vfs", message);
                }
                return Ok(None);
            }
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            spawn_virtiofs(sock, service.clone(), true, stop.clone())
                .map_err(|e| format!("cannot listen on the virtio-fs socket: {e}"))?;
            self.emit_debug("vfs", "serving the VFS over virtio-fs (krun)");
            return Ok(Some(VirtioFsRuntime {
                path: sock.to_path_buf(),
                queues: 1,
                memory_backend: "",
                stop,
            }));
        }
        let vm = &cfg.vm;
        let target_arch = qemu::detect_target_arch(&vm.qemu_path, &self.host);
        let accel = vm
            .accel
            .clone()
            .unwrap_or_else(|| qemu::select_accel(&target_arch, &self.host).to_string());
        let machine = vm.machine_type.clone().unwrap_or_else(|| {
            qemu::select_machine_type(&target_arch, Some(&accel), &self.host).to_string()
        });
        let support = qemu::probe_virtiofs(&vm.qemu_path, &self.host);
        if !support.usable(&machine) {
            let message = format!(
                "virtio-fs unavailable ({} lacks vhost-user-fs or a shared memory backend); using sandboxfs",
                vm.qemu_path
            );
            if service.required() {
                gondolin_log::warn!("{message}");
                let log = gondolin_proto::session::Log { component: "vfs".into(), message };
                self.ctl.send(gondolin_proto::session::LOG, 0, &log);
            } else {
                self.emit_debug("vfs", message);
            }
            return Ok(None);
        }
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        spawn_virtiofs(sock, service.clone(), false, stop.clone())
            .map_err(|e| format!("cannot listen on the virtio-fs socket: {e}"))?;
        self.emit_debug("vfs", "serving the VFS over virtio-fs");
        Ok(Some(VirtioFsRuntime {
            path: sock.to_path_buf(),
            queues: (vm.cpus as usize).clamp(1, service.request_queues()),
            memory_backend: support.memory_backend.unwrap_or("memory-backend-memfd"),
            stop,
        }))
    }

    fn handle_shutdown(&mut self, id: u64) {
        if self.shutting_down {
            // answer duplicates once the first one completes
            if self.vm.stop_waiters.contains_key(&self.vm.generation) {
                self.add_stop_waiter(AfterStop::Shutdown { id });
            } else {
                self.finish_shutdown(id);
            }
            return;
        }
        crate::timing::mark("shutdown requested");
        if let Some(rt) = &self.runtime {
            rt.fs_handler.report_timing();
        }
        self.shutting_down = true;
        self.close_server();
        if self.close_vm() {
            self.add_stop_waiter(AfterStop::Shutdown { id });
        } else {
            self.finish_shutdown(id);
        }
    }

    /// `closeInternal` minus the VMM: fail everything, drop clients, stop
    /// listening.
    fn close_server(&mut self) {
        self.cancel_idle_pause();
        self.fail_inflight("server_shutdown", "server is shutting down");
        self.f.fail_waiters(&self.ctl, "server is shutting down");
        let clients: Vec<_> = self.clients.iter().copied().collect();
        for client in clients {
            self.close_client(client);
        }
        if let Some(rt) = &mut self.runtime {
            for port in &rt.ports {
                port.close();
            }
            if let Some(task) = rt.netdev_task.take() {
                task.abort();
            }
        }
    }

    fn finish_shutdown(&mut self, id: u64) {
        self.ctl.reply_ok(ps::SHUTDOWN, id, vec![]);
        self.finished = true;
    }

    /// The controller closed its end: kill the VM and exit.
    fn controller_gone(&mut self) {
        self.shutting_down = true;
        self.close_server();
        if let Some(child) = self.vm.child.as_mut() {
            child.stop(true);
        }
        self.finished = true;
    }

    async fn cleanup(&mut self) {
        if let Some(child) = self.vm.child.as_mut() {
            child.stop(true);
        }
        vmm::kill_current();
        if let Some(vfs) = self.vfs.take() {
            vfs.close().await;
        }
        if let NetSetup::Native(net) = &self.net {
            net.close().await;
        }
        self.runtime = None;
    }

    // ---- clients -------------------------------------------------------

    fn handle_client_message(&mut self, msg: RawEnvelope) {
        let f = Fields::of(&msg.p);
        let Some(client) = fields::request_id(f.get("client")) else {
            self.ctl.error_event(
                "invalid_request",
                "client messages require a uint32 client",
                Some(&msg.t),
            );
            return;
        };
        match msg.t.as_str() {
            px::CLIENT_OPEN => {
                // attachClient
                self.clients.insert(client);
                self.send_client(
                    px::CLIENT_STATUS,
                    &px::ClientStatus { client, state: self.status },
                );
                return;
            }
            px::CLIENT_CLOSE => {
                self.disconnect_client(client);
                return;
            }
            _ => {}
        }
        if !self.clients.contains(&client) {
            return;
        }
        if self.debug_enabled("protocol") {
            self.emit_debug("protocol", describe_client_message(&msg.t, &f));
        }
        if msg.t == px::BOOT {
            self.handle_boot(client, &f);
            return;
        }
        if self.boot_config.is_none() {
            self.client_error(
                client,
                None,
                "missing_boot",
                "boot configuration required before commands",
            );
            return;
        }
        match msg.t.as_str() {
            px::EXEC => self.handle_exec(client, &f),
            px::STDIN => self.handle_stdin(client, &f),
            px::PTY_RESIZE => self.handle_pty_resize(client, &f),
            px::EXEC_WINDOW => self.handle_exec_window(client, &f),
            px::EXEC_SIGNAL => self.handle_exec_signal(client, &f),
            px::LIFECYCLE => match f.text("action") {
                Some("restart") => self.restart_vm(),
                Some("shutdown") => {
                    self.close_vm();
                }
                _ => {}
            },
            _ => self.client_error(client, None, "unknown_type", "unsupported message type"),
        }
    }

    /// `closeClient`: forget the client and tell the controller.
    pub(crate) fn close_client(&mut self, client: px::ClientId) {
        self.disconnect_client(client);
        self.send_client(px::CLIENT_CLOSED, &px::ClientRef { client });
    }

    fn handle_boot(&mut self, client: px::ClientId, f: &Fields<'_>) {
        let mount = f.get_some("fuseMount").map(|v| v.as_text().ok_or(()));
        let binds = f.get_some("fuseBinds").map(|v| {
            v.as_array()
                .map(|list| {
                    list.iter()
                        .map(|e| e.as_text().map(RawBind::Text).unwrap_or(RawBind::Invalid))
                        .collect::<Vec<_>>()
                })
                .ok_or(())
        });
        let config = match bootcfg::normalize(mount, binds) {
            Ok(c) => c,
            Err(err) => {
                self.client_error(client, None, "invalid_request", &err);
                return;
            }
        };
        let changed = self.boot_config.as_ref() != Some(&config);
        self.vm.append = bootcfg::sandboxfs_append(&self.base_append, &config);
        *self.boot_shared.lock().unwrap() = Some(config.clone());
        self.boot_config = Some(config);

        let state = self.vm_state();
        if changed && matches!(state, State::Running | State::Starting) {
            self.restart_vm();
            return;
        }
        let mut spawn_error = None;
        if state == State::Stopped {
            match self.start_vm_inner() {
                Ok(()) => {}
                Err(StartError::Fatal(err)) => {
                    self.boot_config = None;
                    *self.boot_shared.lock().unwrap() = None;
                    self.client_error(client, None, "sandbox_start_failed", &err);
                    self.emit_error(err);
                    self.close_client(client);
                    // `void this.close()`: stop serving (the daemon stays up)
                    self.fail_inflight("server_shutdown", "server is shutting down");
                    return;
                }
                Err(StartError::Exported) => {
                    self.client_error(client, None, "invalid_state", EXPORTED);
                }
                Err(StartError::Spawn(err)) => spawn_error = Some(err),
            }
        }
        self.send_client(px::CLIENT_STATUS, &px::ClientStatus { client, state: self.status });
        if let Some(err) = spawn_error {
            self.vm_spawn_failed(err);
        }
    }

    // ---- status --------------------------------------------------------

    pub(crate) fn vm_state(&self) -> State {
        self.vm.state.unwrap_or(State::Stopped)
    }

    fn broadcast_status(&mut self) {
        let vmm_pid = self.vm.child.as_ref().map(|c| c.pid);
        self.ctl.send(ps::STATUS, 0, &ps::Status { state: self.status, vmm_pid });
    }

    /// `SandboxController.setState` plus the server's `state` listener.
    fn set_vm_state(&mut self, state: State) {
        if self.vm.state == Some(state) {
            return;
        }
        self.vm.state = Some(state);
        match state {
            State::Stopped => {
                self.reject_time_sync("sandbox stopped during time sync");
                self.vfs_ready = false;
                self.status = State::Stopped;
            }
            State::Starting => {
                // clear the previous run's logs so hints stay scoped to this VM
                self.log_tail.clear();
                self.vfs_ready = false;
                self.guest_features.clear();
                self.status = State::Starting;
            }
            State::Running => self.status = State::Running,
        }
        self.broadcast_status();
        if self.status == State::Running {
            self.schedule_idle_pause();
        }
    }

    // ---- guest control channel -------------------------------------------

    pub(crate) fn handle_control(&mut self, ev: ControlEvent) {
        match ev {
            ControlEvent::Error(message) => {
                self.flush_output();
                self.port_error("control", message)
            }
            ControlEvent::Frame(v) => self.handle_guest_message(v),
        }
    }

    fn handle_guest_message(&mut self, v: Value) {
        self.vm.guest_seen = true;
        let f = Fields::of(&v);
        let t = f.text("t").unwrap_or("");
        if t != "exec_output" {
            // keep output ordered before responses/errors of the same exec
            self.flush_output();
        }
        let id = fields::request_id(f.get("id"));
        let p = f.get("p").map(Fields::of).unwrap_or_else(|| Fields::of(&Value::Null));
        if t != "exec_output" && crate::timing::enabled() {
            crate::timing::mark(format!("guest message: {t}"));
        }
        if self.debug_enabled("protocol") {
            let id_text = id.map(|i| i.to_string()).unwrap_or_else(|| "?".into());
            let extra = match t {
                "exec_output" => format!(
                    " stream={} bytes={}",
                    p.text("stream").unwrap_or(""),
                    p.bytes("data").map(<[u8]>::len).unwrap_or(0)
                ),
                "exec_response" => format!(" exit={}", p.int("exit_code").unwrap_or(0)),
                "file_read_data" => {
                    format!(" bytes={}", p.bytes("data").map(<[u8]>::len).unwrap_or(0))
                }
                "error" => format!(
                    " code={} message={}",
                    p.text("code").unwrap_or(""),
                    p.text("message").unwrap_or("")
                ),
                _ => String::new(),
            };
            self.emit_debug("protocol", format!("virtio rx t={t} id={id_text}{extra}"));
        }
        let Some(id) = id else { return };
        match t {
            "exec_output" => self.guest_exec_output(id, &p),
            "exec_response" => self.guest_exec_response(id, &p),
            "stdin_window" => self.guest_stdin_window(id, &p),
            "file_read_data" => self.guest_file_read_data(id, &p),
            "file_read_done" | "file_write_done" | "file_delete_done" => self.resolve_file_op(id),
            "time_sync_done" => self.time_sync_done(id),
            "error" => self.guest_error(id, &p),
            "vfs_ready" => {
                self.guest_features = features_of(&p);
                self.handle_vfs_ready();
            }
            "vfs_error" => {
                self.guest_features = features_of(&p);
                let message = p.text("message").unwrap_or("").to_string();
                self.handle_vfs_error(&message);
            }
            _ => {}
        }
    }

    fn handle_vfs_ready(&mut self) {
        if self.debug_enabled("vfs") {
            self.emit_debug("vfs", "vfs_ready");
        }
        if self.vfs_ready {
            return;
        }
        self.vfs_ready = true;
        if self.vm_state() == State::Running && self.status != State::Running {
            self.status = State::Running;
            self.broadcast_status();
        }
        self.schedule_idle_pause();
    }

    fn handle_vfs_error(&mut self, message: &str) {
        if self.debug_enabled("vfs") {
            self.emit_debug("vfs", format!("vfs_error code=vfs_error message={message}"));
        }
        self.vfs_ready = false;
        let trimmed = message.trim();
        let detail = if trimmed.is_empty() { "vfs not ready" } else { trimmed };
        self.emit_error(format!("[vfs] {detail}"));
        let clients: Vec<_> = self.clients.iter().copied().collect();
        for client in clients {
            self.client_error(client, None, "vfs_error", detail);
            self.close_client(client);
        }
    }

    fn guest_error(&mut self, id: u32, p: &Fields<'_>) {
        let code = p.text("code").unwrap_or("").to_string();
        let message = p.text("message").unwrap_or("").to_string();
        if self.idle.time_sync_pending() == Some(id) {
            self.reject_time_sync(&format!("guest time sync failed: {message}"));
            return;
        }
        self.guest_exec_or_file_error(id, &code, &message);
        self.schedule_idle_pause();
    }

    // ---- activity --------------------------------------------------------

    /// `hasActiveGuestActivity`.
    pub(crate) fn has_active_guest_activity(&self) -> bool {
        !self.x.inflight.is_empty()
            || !self.x.started_execs.is_empty()
            || !self.x.exec_queue.is_empty()
            || !self.f.ops.is_empty()
            || self.f.active.is_some()
            || self.active_vfs_requests > 0
            || self.activity_sources.values().any(|a| *a)
    }

    fn external_activity(&mut self, source: String, active: bool) {
        let was = self.activity_sources.get(&source).copied().unwrap_or(false);
        if active {
            self.activity_sources.insert(source, true);
        } else {
            self.activity_sources.remove(&source);
        }
        if active && !was {
            // guest-activity-change(true): resume, then re-arm the idle timer
            self.resume_then(crate::idle::Continuation::ScheduleIdle);
        } else if !active {
            self.schedule_idle_pause();
        }
    }

    // ---- VMM lifecycle -----------------------------------------------------

    /// `SandboxController.start` (no-op while a VMM runs).
    pub(crate) fn start_vm(&mut self) {
        match self.start_vm_inner() {
            Ok(()) => {}
            Err(StartError::Exported) => {
                self.ctl.error_event("invalid_state", EXPORTED, None);
            }
            Err(StartError::Spawn(err)) | Err(StartError::Fatal(err)) => self.vm_spawn_failed(err),
        }
    }

    fn start_vm_inner(&mut self) -> Result<(), StartError> {
        if self.vm.child.is_some() {
            return Ok(());
        }
        if self.ckpt.exported {
            return Err(StartError::Exported);
        }
        if self.configured.is_none() {
            return Err(StartError::Fatal("session is not configured".into()));
        }
        if self.runtime.is_none() {
            return Err(StartError::Fatal("session is not started".into()));
        }
        self.cancel_idle_pause();
        self.idle.reset_for_start();
        self.vm.manual_stop = false;
        self.vm.restart_pending = false;
        self.vm.generation += 1;
        let generation = self.vm.generation;
        let cfg = self.configured.as_ref().unwrap();
        let rt = self.runtime.as_ref().unwrap();
        let net_socket = match &self.net {
            NetSetup::None => None,
            NetSetup::Native(_) => rt.netdev_path.as_ref().map(|p| p.display().to_string()),
        };
        let qmp = rt.qmp_path.as_ref().map(|p| p.display().to_string());
        if let Some(q) = &rt.qmp_path {
            let _ = std::fs::remove_file(q);
        }
        // tells the guest's init to mount the virtio-fs tag (older images ignore it)
        let virtiofs_append = |append: &str| match &rt.virtiofs {
            Some(_) => format!("{append} sandboxfs.virtiofs={}", qemu::VIRTIOFS_TAG),
            None => append.to_string(),
        };
        let (qemu_path, args) = if crate::firecracker::is_firecracker(&cfg.vm) {
            let uds = crate::firecracker::vsock_uds(&rt.dir.0);
            // Firecracker binds the vsock socket itself (a previous run's is stale)
            let _ = std::fs::remove_file(&uds);
            #[cfg(target_os = "linux")]
            let tap = rt.tap.as_ref().map(|t| t.name().to_string());
            #[cfg(not(target_os = "linux"))]
            let tap: Option<String> = None;
            let mac = cfg.vm.mac.clone().unwrap_or_else(|| qemu::DEFAULT_MAC.to_string());
            let config = crate::firecracker::config(
                &cfg.vm,
                &crate::firecracker::ConfigArgs {
                    append: &self.vm.append,
                    vsock_uds: &uds,
                    tap: tap.as_deref(),
                    mac: &mac,
                    console: crate::firecracker::wants_console(
                        &cfg.vm,
                        self.debug_enabled("protocol"),
                    ),
                },
            )
            .map_err(StartError::Fatal)?;
            let config_path = rt.dir.0.join(format!("firecracker-{generation}.json"));
            let log_path = rt.dir.0.join(format!("firecracker-{generation}.log"));
            std::fs::write(&config_path, gondolin_wire::json::to_string(&config))
                .and_then(|()| std::fs::write(&log_path, b""))
                .map_err(|e| StartError::Fatal(format!("cannot write firecracker config: {e}")))?;
            let program = crate::firecracker::binary_path(&cfg.vm);
            (program, crate::firecracker::args(&config_path, &log_path))
        } else if qemu::is_krun(&cfg.vm) {
            let virtio_fs = rt.virtiofs.as_ref().map(|v| crate::krun::VirtioFsDevice {
                socket: v.path.to_str().unwrap_or_default(),
                tag: qemu::VIRTIOFS_TAG,
            });
            let runner = crate::krun::runner_config(
                &cfg.vm,
                &virtiofs_append(&self.vm.append),
                &rt.chardevs,
                net_socket.as_deref(),
                virtio_fs,
                &rt.dir.0,
            )
            .map_err(StartError::Fatal)?;
            let path = rt.dir.0.join(format!("krun-{generation}.json"));
            let json = gondolin_wire::json::to_string(&gondolin_wire::ToValue::to_value(&runner));
            std::fs::write(&path, json)
                .map_err(|e| StartError::Fatal(format!("cannot write krun config: {e}")))?;
            let program = crate::krun::runner_path(&cfg.vm);
            (program, vec!["--config".to_string(), path.display().to_string()])
        } else {
            let virtiofs = rt.virtiofs.as_ref().map(|v| qemu::VirtioFsArgs {
                socket: v.path.to_str().unwrap_or_default(),
                queues: v.queues,
                memory_backend: v.memory_backend,
            });
            let append = virtiofs_append(&self.vm.append);
            let args = qemu::build_qemu_args(&QemuArgs {
                vm: &cfg.vm,
                append: &append,
                virtiofs,
                chardevs: &rt.chardevs,
                net_socket: net_socket.as_deref(),
                qmp_socket: qmp.as_deref(),
                host: &self.host,
            });
            (cfg.vm.qemu_path.clone(), args)
        };
        // Firecracker runs in the namespace of its tap
        #[cfg(target_os = "linux")]
        let netns = rt.tap.as_ref().map(|t| t.netns());
        #[cfg(not(target_os = "linux"))]
        let netns = None;
        let guest_deadline = crate::firecracker::is_firecracker(&cfg.vm);
        self.set_vm_state(State::Starting);
        match VmmProcess::spawn_in(&qemu_path, &args, generation, self.vmm_tx.clone(), netns) {
            Ok(child) => {
                crate::timing::mark("vmm spawned");
                self.vm.child = Some(child);
                self.vm.guest_seen = false;
                self.vm.exit_reason = None;
                let _ = self.events.send(Event::VmmSpawned(generation));
                if guest_deadline {
                    let events = self.events.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(FIRECRACKER_GUEST_DEADLINE).await;
                        let _ = events.send(Event::Timer(Timer::GuestDeadline(generation)));
                    });
                }
                Ok(())
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Err(StartError::Spawn(format!("spawn {qemu_path} ENOENT")))
            }
            Err(err) => Err(StartError::Spawn(format!("spawn {qemu_path}: {err}"))),
        }
    }

    /// The VMM could not be spawned (`child.on("error")`).
    fn vm_spawn_failed(&mut self, error: String) {
        self.cancel_idle_pause();
        self.idle.invalidate();
        self.cleanup_qmp_socket();
        self.vm.child = None;
        self.set_vm_state(State::Stopped);
        self.vm_exited_server(None, None, Some(error));
    }

    /// `SandboxController.close`: stops the VMM. Returns whether a VMM is
    /// stopping (its exit completes waiters added with `add_stop_waiter`).
    pub(crate) fn close_vm(&mut self) -> bool {
        self.cancel_idle_pause();
        self.idle.invalidate();
        self.vm.restart_pending = false;
        let Some(mut child) = self.vm.child.take() else {
            self.cleanup_qmp_socket();
            return false;
        };
        self.vm.manual_stop = true;
        child.stop(false);
        self.vm.stop_waiters.entry(self.vm.generation).or_default();
        true
    }

    /// The guest of `generation` never sent a control message: stop the VM
    /// and say why (no automatic restart, it would not get further).
    fn guest_deadline(&mut self, generation: u64) {
        if generation != self.vm.generation || self.vm.guest_seen {
            return;
        }
        let Some(child) = self.vm.child.as_mut() else { return };
        let message = format!(
            "the guest did not connect within {} s; images for vmm=firecracker need the guest \
             helpers' vsock transport (built with this version of Gondolin)",
            FIRECRACKER_GUEST_DEADLINE.as_secs()
        );
        gondolin_log::warn!("{message}");
        self.vm.exit_reason = Some(message);
        self.vm.manual_stop = true;
        child.stop(true);
    }

    /// A VMM was told to stop and has not exited yet (`close_vm` took it).
    pub(crate) fn vm_stopping(&self) -> bool {
        self.vm.child.is_none() && self.vm.stop_waiters.contains_key(&self.vm.generation)
    }

    pub(crate) fn add_export_waiter(&mut self, id: u64, dest: Option<PathBuf>) {
        self.add_stop_waiter(AfterStop::Export { id, dest });
    }

    fn add_stop_waiter(&mut self, after: AfterStop) {
        self.vm.stop_waiters.entry(self.vm.generation).or_default().push(after);
    }

    /// `SandboxController.restart`: close, then start once the VMM exited.
    pub(crate) fn restart_vm(&mut self) {
        if self.ckpt.exported {
            self.ctl.error_event("invalid_state", EXPORTED, None);
            return;
        }
        if self.close_vm() {
            self.add_stop_waiter(AfterStop::Start);
        } else {
            self.start_vm();
        }
    }

    fn handle_vmm(&mut self, generation: u64, ev: VmmEvent) {
        self.flush_output();
        match ev {
            VmmEvent::Log { stderr, chunk } => {
                if generation != self.vm.generation {
                    return;
                }
                let lines = self.log_tail.push(stderr, &chunk);
                if self.debug_enabled("protocol") {
                    for line in lines {
                        let msg = if stderr { line } else { format!("stdout: {line}") };
                        self.emit_debug("qemu", msg);
                    }
                }
            }
            VmmEvent::Exited { code, signal } => self.vmm_exited(generation, code, signal),
        }
    }

    pub(crate) fn vmm_exited(&mut self, generation: u64, code: Option<i32>, signal: Option<i32>) {
        crate::timing::mark("vmm exited");
        let waiters = self.vm.stop_waiters.remove(&generation).unwrap_or_default();
        if generation == self.vm.generation {
            // SandboxController's exit handler
            self.cancel_idle_pause();
            self.idle.invalidate();
            self.cleanup_qmp_socket();
            self.vm.child = None;
            self.set_vm_state(State::Stopped);
            let reason = self.vm.exit_reason.take();
            self.vm_exited_server(code, signal.map(vmm::signal_name), reason);
            if self.vm.manual_stop {
                self.vm.manual_stop = false;
            } else if self.configured.as_ref().is_some_and(|c| c.vm.auto_restart)
                && !self.shutting_down
                && !self.ckpt.exported
            {
                self.vm.restart_token += 1;
                self.vm.restart_pending = true;
                let token = self.vm.restart_token;
                let events = self.events.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(AUTO_RESTART_DELAY).await;
                    let _ = events.send(Event::Timer(Timer::Restart(token)));
                });
            }
        }
        for waiter in waiters {
            match waiter {
                AfterStop::Start => {
                    if !self.shutting_down {
                        self.start_vm();
                    }
                }
                AfterStop::Shutdown { id } => self.finish_shutdown(id),
                AfterStop::Export { id, dest } => self.export_overlay(id, dest),
            }
        }
    }

    /// The server's `exit` handler: diagnostics, failing inflight work, and
    /// the `exit` event.
    fn vm_exited_server(
        &mut self,
        code: Option<i32>,
        signal: Option<String>,
        error: Option<String>,
    ) {
        for (stderr, line) in self.log_tail.flush() {
            if self.debug_enabled("protocol") {
                let msg = if stderr { line } else { format!("stdout: {line}") };
                self.emit_debug("qemu", msg);
            }
        }
        let detail = match (&code, &signal) {
            (Some(c), _) => format!("code={c}"),
            (None, Some(s)) => format!("signal={s}"),
            _ => String::new(),
        };
        let base = if detail.is_empty() {
            "sandbox exited".to_string()
        } else {
            format!("sandbox exited ({detail})")
        };
        let base = match &error {
            Some(error) => format!("{base}: {error}"),
            None => base,
        };
        let message = format!("{base}{}", self.log_tail.format_hint_for(self.vmm_label()));
        self.fail_inflight("sandbox_stopped", &message);
        self.ctl.send(ps::EXIT, 0, &ps::Exit { code, signal, error });
    }

    /// Records a VMM log line produced by the daemon itself (like the node
    /// controller's synthetic `log` events).
    pub(crate) fn record_vmm_log_line(&mut self, line: &str) {
        let lines = self.log_tail.push(true, format!("{line}\n").as_bytes());
        if self.debug_enabled("protocol") {
            for line in lines {
                self.emit_debug("qemu", line);
            }
        }
    }

    pub(crate) fn cleanup_qmp_socket(&self) {
        if let Some(path) = self.runtime.as_ref().and_then(|rt| rt.qmp_path.as_ref()) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Backend name used in diagnostics.
    fn vmm_label(&self) -> &'static str {
        match self.configured.as_ref() {
            Some(c) if qemu::is_krun(&c.vm) => "krun",
            Some(c) if crate::firecracker::is_firecracker(&c.vm) => "firecracker",
            _ => "qemu",
        }
    }

    pub(crate) fn is_started(&self) -> bool {
        self.runtime.is_some() || self.test_started
    }

    /// Lets tests run file operations without sockets.
    #[cfg(test)]
    pub(crate) fn force_started_for_tests(&mut self) {
        self.test_started = true;
    }

    pub(crate) fn qmp_path(&self) -> Option<PathBuf> {
        self.runtime.as_ref().and_then(|rt| rt.qmp_path.clone())
    }

    /// `failInflight`: error every exec, fail file operations, release waiters.
    pub(crate) fn fail_inflight(&mut self, code: &str, message: &str) {
        let inflight: Vec<_> = self.x.inflight.iter().map(|(id, c)| (*id, *c)).collect();
        for (id, client) in inflight {
            self.client_error(client, Some(id), code, message);
        }
        self.x.clear_all();
        self.fail_file_operations(code, message);
    }
}

/// Why a VM whose root disk went to a checkpoint does not start again
const EXPORTED: &str =
    "the vm was checkpointed (its root disk was exported) and cannot be started again";

enum StartError {
    /// the VMM could not be spawned (reported like a VMM exit)
    Spawn(String),
    /// the root disk was exported for a checkpoint (`invalid_state`)
    Exported,
    /// the session cannot boot at all
    Fatal(String),
}

/// Control channel handler: forwards frames to the session, throttled by the
/// controller queue.
struct ControlHandler {
    tx: mpsc::Sender<ControlEvent>,
    ctl: Arc<Controller>,
}

impl PortHandler for ControlHandler {
    fn frame<'a>(&'a self, frame: Bytes) -> crate::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let value: Value = gondolin_wire::decode_guest(&frame).map_err(|e| e.to_string())?;
            self.ctl.wait_capacity().await;
            let _ = self.tx.send(ControlEvent::Frame(value)).await;
            Ok(())
        })
    }

    fn error(&self, message: String) {
        let _ = self.tx.try_send(ControlEvent::Error(message));
    }
}

/// `features` of a `vfs_ready`/`vfs_error` payload (absent on older guests).
fn features_of(p: &Fields<'_>) -> Vec<String> {
    p.get_some("features").and_then(crate::fields::string_list).unwrap_or_default()
}

fn describe_client_message(t: &str, f: &Fields<'_>) -> String {
    let id = f.int("id").map(|i| i.to_string()).unwrap_or_default();
    let extra = match t {
        px::EXEC => format!(" id={id} cmd={}", f.text("cmd").unwrap_or("")),
        px::STDIN => format!(
            " id={id} bytes={}{}",
            f.bytes("data").map(<[u8]>::len).unwrap_or(0),
            if f.truthy("eof") { " eof" } else { "" }
        ),
        px::PTY_RESIZE => format!(
            " id={id} rows={} cols={}",
            f.number("rows").unwrap_or(0.0),
            f.number("cols").unwrap_or(0.0)
        ),
        px::BOOT => format!(
            " fuseMount={} binds={}",
            f.text("fuseMount").unwrap_or(""),
            f.get("fuseBinds").and_then(Value::as_array).map(Vec::len).unwrap_or(0)
        ),
        px::LIFECYCLE => format!(" action={}", f.text("action").unwrap_or("")),
        _ => String::new(),
    };
    let ty = if t == px::CLIENT_UNKNOWN { f.text("type").unwrap_or("?") } else { t };
    format!("client rx type={ty}{extra}")
}

/// Fails early (with a clear message) when the VMM binary cannot run.
fn check_vmm_binary(vm: &gondolin_proto::session::VmConfig) -> Result<(), String> {
    let program = if qemu::is_krun(vm) {
        crate::krun::runner_path(vm)
    } else if crate::firecracker::is_firecracker(vm) {
        crate::firecracker::binary_path(vm)
    } else {
        vm.qemu_path.clone()
    };
    match std::process::Command::new(&program)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
    {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("{program} --version failed ({status})")),
        Err(err) => Err(format!("cannot run {program}: {err}")),
    }
}

/// Distinguishes the taps of one daemon (Firecracker sessions).
#[cfg(target_os = "linux")]
fn next_tap_id() -> u32 {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Creates the private socket directory (mode 0700). macOS uses `/tmp`
/// because of the short `sun_path` limit.
fn make_socket_dir() -> std::io::Result<SocketDir> {
    let base: PathBuf = if cfg!(target_os = "macos") {
        PathBuf::from("/tmp")
    } else {
        let tmp = std::env::temp_dir();
        if tmp.as_os_str().len() > 60 { PathBuf::from("/tmp") } else { tmp }
    };
    let template = base.join("gondolind-XXXXXX");
    let mut bytes = template.into_os_string().into_encoded_bytes();
    bytes.push(0);
    // SAFETY: `bytes` is a NUL-terminated, writable template buffer.
    let ptr = unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast()) };
    if ptr.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    bytes.pop();
    // SAFETY: mkdtemp only replaced the XXXXXX with filename characters.
    let path = PathBuf::from(unsafe { std::ffi::OsString::from_encoded_bytes_unchecked(bytes) });
    Ok(SocketDir(path))
}

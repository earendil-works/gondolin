//! The VM: the CLI's counterpart of `VM` (`host/src/vm/core.ts`) for what
//! the commands use: start (configure, boot, readiness), sandbox clients with
//! execs, checkpoints and close.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gondolin_proto::exec as px;
use tokio::sync::{mpsc, watch};

use crate::configure::{Prepared, json_to_cbor};
use crate::engine::{ClientEvent, Engine};
use crate::etc_mount::EtcStore;

/// `VFS_READY_ATTEMPTS` x `VFS_READY_SLEEP_SECONDS` (30 s): the mounts land a
/// few ms after the guest reports the VFS ready, so poll often
const VFS_READY_ATTEMPTS: u32 = 3000;
const VFS_READY_SLEEP_SECONDS: &str = "0.01";
/// Default output window of an exec in `bytes` (`DEFAULT_WINDOW_BYTES`)
pub const DEFAULT_WINDOW_BYTES: u32 = 256 * 1024;
/// stdin message size in `bytes` (the server's per-message limit)
const STDIN_CHUNK: usize = 64 * 1024;
/// Unacknowledged stdin before writers wait, in `bytes`
const STDIN_HIGH_WATER: u64 = 1024 * 1024;
/// Startup timeout (`DEFAULT_START_TIMEOUT_MS`)
const START_TIMEOUT: Duration = Duration::from_secs(60);

/// [`START_TIMEOUT`], or `$GONDOLIN_START_TIMEOUT_MS` (as the node engine's
/// VM honours it; slow hosts such as nested virtualization need more).
fn start_timeout() -> Duration {
    std::env::var("GONDOLIN_START_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map_or(START_TIMEOUT, Duration::from_millis)
}

/// Events of one exec.
#[derive(Debug)]
pub enum ExecEvent {
    Output {
        stdout: bool,
        data: Vec<u8>,
    },
    /// the exec finished
    Exit {
        exit_code: i32,
        signal: Option<i32>,
    },
    /// a terminal error (the exec is gone)
    Error {
        code: String,
        message: String,
    },
    StdinAck(u64),
}

/// One sandbox client (a `SandboxConnection`) with its execs.
pub struct Client {
    engine: Arc<Engine>,
    pub id: u32,
    execs: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<ExecEvent>>>>,
    status: watch::Receiver<String>,
}

impl Client {
    /// Opens client `id`.
    pub async fn open(engine: Arc<Engine>, id: u32) -> Arc<Client> {
        let mut events = engine.register_client(id);
        let execs: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<ExecEvent>>>> = Arc::default();
        let (status_tx, status) = watch::channel(String::new());
        {
            let execs = execs.clone();
            tokio::spawn(async move {
                while let Some(ev) = events.recv().await {
                    let route = |id: u32, ev: ExecEvent| {
                        if let Some(tx) = execs.lock().unwrap().get(&id) {
                            let _ = tx.send(ev);
                        }
                    };
                    match ev {
                        ClientEvent::Status(s) => {
                            let _ = status_tx.send(s);
                        }
                        ClientEvent::Output { id, stdout, data } => {
                            route(id, ExecEvent::Output { stdout, data })
                        }
                        ClientEvent::Response { id, exit_code, signal } => {
                            route(id, ExecEvent::Exit { exit_code, signal });
                            execs.lock().unwrap().remove(&id);
                        }
                        ClientEvent::StdinAck { id, bytes } => {
                            route(id, ExecEvent::StdinAck(bytes))
                        }
                        ClientEvent::Error { id: Some(id), code, message } => {
                            // advisory stdin errors do not end the exec
                            let terminal = !matches!(
                                code.as_str(),
                                "stdin_backpressure" | "stdin_chunk_too_large"
                            );
                            route(id, ExecEvent::Error { code, message });
                            if terminal {
                                execs.lock().unwrap().remove(&id);
                            }
                        }
                        ClientEvent::Error { id: None, code, message } => {
                            eprintln!("gondolin: {code}: {message}");
                        }
                        ClientEvent::Closed => break,
                    }
                }
                for (_, tx) in execs.lock().unwrap().drain() {
                    let _ = tx.send(ExecEvent::Error {
                        code: "closed".into(),
                        message: "sandbox connection closed".into(),
                    });
                }
                let _ = status_tx.send("stopped".into());
            });
        }
        engine.send(px::CLIENT_OPEN, &px::ClientRef { client: id }).await;
        Arc::new(Client { engine, id, execs, status })
    }

    /// Status updates of this client.
    pub fn status(&self) -> watch::Receiver<String> {
        self.status.clone()
    }

    /// Sends a client message (`client` is filled in).
    pub async fn send(&self, t: &str, mut payload: gondolin_wire::Value) -> bool {
        {
            let obj = &mut payload;
            obj.insert("client", self.id);
        }
        self.engine.send(t, &json_to_cbor(&payload)).await
    }

    /// Starts an exec with exec id `id`.
    pub async fn exec(self: &Arc<Self>, id: u32, req: &ExecRequest) -> ExecHandle {
        let (tx, rx) = mpsc::unbounded_channel();
        self.execs.lock().unwrap().insert(id, tx);
        let msg = px::Exec {
            client: self.id,
            id,
            cmd: req.cmd.clone(),
            argv: (!req.argv.is_empty()).then(|| req.argv.clone()),
            env: (!req.env.is_empty()).then(|| req.env.clone()),
            cwd: req.cwd.clone(),
            stdin: req.stdin.then_some(true),
            pty: req.pty.then_some(true),
            stdout_window: Some(req.window),
            stderr_window: Some(req.window),
        };
        self.engine.send(px::EXEC, &msg).await;
        ExecHandle { client: self.clone(), id, events: rx, unacked: 0 }
    }

    /// Closes the client (its execs keep running in the guest).
    pub async fn close(&self) {
        self.engine.send(px::CLIENT_CLOSE, &px::ClientRef { client: self.id }).await;
        self.engine.unregister_client(self.id);
    }
}

/// An exec to start.
#[derive(Debug, Clone, Default)]
pub struct ExecRequest {
    pub cmd: String,
    pub argv: Vec<String>,
    pub env: Vec<String>,
    pub cwd: Option<String>,
    pub stdin: bool,
    pub pty: bool,
    /// initial output window in `bytes`
    pub window: u32,
}

/// A running exec.
pub struct ExecHandle {
    client: Arc<Client>,
    pub id: u32,
    events: mpsc::UnboundedReceiver<ExecEvent>,
    /// stdin bytes sent but not acknowledged
    unacked: u64,
}

/// How an exec ended.
#[derive(Debug, Clone)]
pub struct ExecResult {
    pub exit_code: i32,
    pub signal: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl ExecHandle {
    /// The next event; `None` once the exec is gone.
    pub async fn next(&mut self) -> Option<ExecEvent> {
        let ev = self.events.recv().await;
        if let Some(ExecEvent::StdinAck(n)) = &ev {
            self.unacked = self.unacked.saturating_sub(*n);
        }
        ev
    }

    /// Returns consumed output credit to the guest.
    pub async fn grant(&self, stdout: u32, stderr: u32) {
        if stdout == 0 && stderr == 0 {
            return;
        }
        let mut msg = gondolin_wire::value!({ "id": self.id });
        if stdout > 0 {
            msg["stdout"] = stdout.into();
        }
        if stderr > 0 {
            msg["stderr"] = stderr.into();
        }
        self.client.send(px::EXEC_WINDOW, msg).await;
    }

    /// Writes stdin (chunked); call [`ExecHandle::next`] concurrently for acks.
    pub async fn write(&mut self, data: &[u8]) -> bool {
        for chunk in data.chunks(STDIN_CHUNK) {
            let msg = px::Stdin {
                client: self.client.id,
                id: self.id,
                data: Some(chunk.to_vec()),
                eof: None,
            };
            if !self.client.engine.send(px::STDIN, &msg).await {
                return false;
            }
            self.unacked += chunk.len() as u64;
        }
        true
    }

    /// Whether more stdin should wait for acknowledgements.
    pub fn stdin_full(&self) -> bool {
        self.unacked >= STDIN_HIGH_WATER
    }

    /// Closes stdin.
    pub async fn eof(&self) {
        let msg = px::Stdin { client: self.client.id, id: self.id, data: None, eof: Some(true) };
        self.client.engine.send(px::STDIN, &msg).await;
    }

    pub async fn resize(&self, rows: u16, cols: u16) {
        let msg = px::PtyResize {
            client: self.client.id,
            id: self.id,
            rows: rows.into(),
            cols: cols.into(),
        };
        self.client.engine.send(px::PTY_RESIZE, &msg).await;
    }

    /// Runs to completion, buffering output.
    pub async fn collect(mut self) -> Result<ExecResult, String> {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        while let Some(ev) = self.next().await {
            match ev {
                ExecEvent::Output { stdout: is_out, data } => {
                    let n = data.len() as u32;
                    if is_out {
                        stdout.extend_from_slice(&data);
                        self.grant(n, 0).await;
                    } else {
                        stderr.extend_from_slice(&data);
                        self.grant(0, n).await;
                    }
                }
                ExecEvent::Exit { exit_code, signal } => {
                    return Ok(ExecResult { exit_code, signal, stdout, stderr });
                }
                ExecEvent::Error { message, .. } => return Err(message),
                ExecEvent::StdinAck(_) => {}
            }
        }
        Err("exec ended without a result".into())
    }
}

/// A started VM.
pub struct Vm {
    pub engine: Arc<Engine>,
    pub prepared: Prepared,
    pub client: Arc<Client>,
    next_exec_id: AtomicU32,
    next_client_id: AtomicU32,
    pub etc: Arc<EtcStore>,
}

impl Vm {
    /// Configures, boots and waits for the guest (and its mounts).
    pub async fn start(prepared: Prepared) -> Result<Arc<Vm>, String> {
        check_vmm(&prepared)?;
        let engine = Engine::start();
        let etc = Arc::new(EtcStore::new());
        if prepared.etc_mount_id.is_some() {
            let etc = etc.clone();
            engine.handle_request("vfs_call", Arc::new(move |p| etc.handle(p)));
        }
        let debug = prepared.configure["debug"].as_array().is_some_and(|a| !a.is_empty());
        engine.log.store(debug, Ordering::Relaxed);
        let timeout = start_timeout();
        let result = tokio::time::timeout(timeout, async {
            engine
                .request_value("configure", json_to_cbor(&prepared.configure))
                .await
                .map_err(|e| e.message)?;
            if let Some(path) = &prepared.checkpoint {
                // the session uses the checkpoint file in place
                let path = path.display().to_string();
                engine
                    .request_value("checkpoint_import", gondolin_wire::value!({ "path": path }))
                    .await
                    .map_err(|e| e.message)?;
            }
            engine.request("start", &gondolin_wire::Value::map()).await.map_err(|e| e.message)?;
            let client = Client::open(engine.clone(), 1).await;
            client
                .send(
                    px::BOOT,
                    gondolin_wire::value!({
                        "fuseMount": prepared.fuse_mount,
                        "fuseBinds": prepared.fuse_binds,
                    }),
                )
                .await;
            wait_running(&engine, &client).await?;
            Ok::<_, String>(client)
        })
        .await;
        let client = match result {
            Ok(Ok(client)) => client,
            Ok(Err(e)) => {
                engine.shutdown().await;
                return Err(e);
            }
            Err(_) => {
                engine.shutdown().await;
                return Err(format!(
                    "vm startup timed out after {}ms while waiting for guest readiness",
                    timeout.as_millis()
                ));
            }
        };
        let vm = Vm {
            engine,
            prepared,
            client,
            next_exec_id: AtomicU32::new(1),
            next_client_id: AtomicU32::new(2),
            etc,
        };
        if let Err(e) = vm.ready().await {
            vm.engine.shutdown().await;
            return Err(e);
        }
        Ok(Arc::new(vm))
    }

    /// `ensureRootfsResized` + `ensureVfsReady`
    async fn ready(&self) -> Result<(), String> {
        if self.prepared.rootfs_resize_pending {
            let r = self
                .run(&[
                    "/bin/sh",
                    "-c",
                    "if ! command -v resize2fs >/dev/null 2>&1; then\n  echo 'rootfs.size requires resize2fs in the guest image (Alpine: install e2fsprogs-extra)' >&2;\n  exit 127;\nfi;\nresize2fs /dev/vda",
                ])
                .await?;
            if r.exit_code != 0 {
                let detail = String::from_utf8_lossy(if r.stderr.is_empty() {
                    &r.stdout
                } else {
                    &r.stderr
                })
                .trim()
                .to_string();
                let suffix = if detail.is_empty() { String::new() } else { format!(": {detail}") };
                return Err(format!(
                    "failed to resize rootfs inside guest (exit {}){suffix}",
                    r.exit_code
                ));
            }
        }
        let fuse = self.prepared.fuse_mount.clone();
        let check = "{ grep -qF -- \" $2 fuse.sandboxfs \" /proc/mounts || grep -qF -- \" $2 virtiofs \" /proc/mounts; }";
        let script = format!(
            "for i in $(seq 1 {VFS_READY_ATTEMPTS}); do {check} && exit 0; sleep {VFS_READY_SLEEP_SECONDS}; done; exit 1"
        );
        let r =
            self.run(&["/bin/sh", "-c", &script, "sh", &fuse, &escape_proc_mounts(&fuse)]).await?;
        if r.exit_code != 0 {
            return Err(format!(
                "vfs mount {fuse} not ready (exit {}): {}",
                r.exit_code,
                String::from_utf8_lossy(&r.stderr).trim()
            ));
        }
        for bind in &self.prepared.fuse_binds {
            if *bind == fuse {
                continue;
            }
            let source = format!("{fuse}{bind}");
            let script = format!(
                // bind it ourselves when the guest's init hasn't yet, and
                // check again right away (not only after the next sleep)
                "for i in $(seq 1 {VFS_READY_ATTEMPTS}); do if grep -qF -- \" $3 \" /proc/mounts; then exit 0; fi; mkdir -p \"$1\"; mount --bind \"$2\" \"$1\" > /dev/null 2>&1 || true; if grep -qF -- \" $3 \" /proc/mounts; then exit 0; fi; sleep {VFS_READY_SLEEP_SECONDS}; done; exit 1"
            );
            let r = self
                .run(&["/bin/sh", "-c", &script, "sh", bind, &source, &escape_proc_mounts(bind)])
                .await?;
            if r.exit_code != 0 {
                return Err(format!(
                    "vfs mount {bind} not ready (exit {}): {}",
                    r.exit_code,
                    String::from_utf8_lossy(&r.stderr).trim()
                ));
            }
        }
        Ok(())
    }

    /// A fresh exec id (unique among this VM's execs).
    pub fn exec_id(&self) -> u32 {
        self.next_exec_id.fetch_add(1, Ordering::Relaxed)
    }

    /// A fresh client id (attach connections).
    pub fn client_id(&self) -> u32 {
        self.next_client_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Starts an exec on the main client. The default environment
    /// (`VMOptions.env`) is merged in front of `req.env`.
    pub async fn exec(&self, mut req: ExecRequest) -> ExecHandle {
        req.env = merge_env(&self.prepared.env, &req.env);
        if req.window == 0 {
            req.window = DEFAULT_WINDOW_BYTES;
        }
        self.client.exec(self.exec_id(), &req).await
    }

    /// Runs a command to completion (internal checks).
    pub async fn run(&self, argv: &[&str]) -> Result<ExecResult, String> {
        let req = ExecRequest {
            cmd: argv[0].to_string(),
            argv: argv[1..].iter().map(|s| s.to_string()).collect(),
            window: DEFAULT_WINDOW_BYTES,
            ..Default::default()
        };
        self.client.exec(self.exec_id(), &req).await.collect().await
    }

    /// Stops the VM and ends the session (the root disk overlay is removed
    /// when the `Vm` is dropped).
    pub async fn close(&self) {
        self.engine.shutdown().await;
    }

    /// Writes a disk checkpoint to `path` and stops the VM
    /// (`checkpointInternal`). Returns `(path, name)`.
    pub async fn checkpoint(&self, path: &str) -> Result<(String, String), String> {
        let target = std::path::PathBuf::from(path);
        if !target.is_absolute() {
            return Err(format!("checkpointPath must be an absolute path (got: {path})"));
        }
        let disk = self.prepared.root_disk.clone().ok_or("vm has no root disk")?;
        let krun = self.prepared.configure["vm"]["vmm"].as_str() == Some("krun");
        let mode = disk.mode.as_deref().unwrap_or("");
        if mode == "memory" && !krun && disk.size.is_none() {
            return Err("cannot checkpoint: root disk is running in ephemeral snapshot mode".into());
        }
        if mode == "readonly" {
            return Err(format!(
                "cannot checkpoint: root disk must be qcow2 (got {})",
                disk.format
            ));
        }
        let build_id = self.prepared.image.build_id.clone().ok_or(
            "cannot checkpoint: guest assets are missing manifest buildId (rebuild guest assets with a newer gondolin build)",
        )?;
        // best-effort flush of guest buffers (the VMM is stopped abruptly)
        let _ = tokio::time::timeout(
            Duration::from_secs(10),
            self.run(&["/bin/sh", "-c", "sync; sync"]),
        )
        .await;
        // the session stops the VM, collapses a resumed checkpoint's chain
        // onto the rootfs and moves the disk next to the target; the target
        // is replaced only once the trailer is written (it may be the
        // checkpoint this session was resumed from)
        let file_name =
            target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let partial = target.with_file_name(format!(".{file_name}.partial-{}", std::process::id()));
        let exported = self
            .engine
            .request_value(
                "checkpoint_export",
                gondolin_wire::value!({ "path": partial.display().to_string() }),
            )
            .await
            .map_err(|e| e.message);
        self.engine.shutdown().await;
        if let Err(err) = exported {
            let _ = std::fs::remove_file(&partial);
            return Err(err);
        }
        let name = target.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let vmm = self.prepared.configure["vm"]["vmm"].as_str().unwrap_or("qemu").to_string();
        let compatible = if self.prepared.image.krun_kernel.is_some() || vmm == "krun" {
            vec!["qemu".to_string(), "krun".into()]
        } else {
            vec!["qemu".to_string()]
        };
        let data = crate::checkpoint::CheckpointData {
            version: 1,
            name: name.clone(),
            created_at: crate::checkpoint::iso_now(),
            disk_file: target
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            guest_asset_build_id: build_id,
            snapshot_kind: Some("disk".into()),
            created_with_vmm: Some(vmm),
            compatible_vmm: Some(compatible),
        };
        let finish = || -> Result<(), String> {
            crate::checkpoint::write_trailer(&partial, &data)?;
            std::fs::rename(&partial, &target)
                .map_err(|e| format!("cannot write {}: {e}", target.display()))?;
            if let Some(dir) = target.parent() {
                crate::checkpoint::sync_dir(dir);
            }
            Ok(())
        };
        if let Err(err) = finish() {
            let _ = std::fs::remove_file(&partial);
            return Err(err);
        }
        Ok((target.display().to_string(), name))
    }
}

/// `mergeEnvInputs`: later entries override earlier keys, order of first use.
pub fn merge_env(base: &[String], extra: &[String]) -> Vec<String> {
    let mut out: Vec<(String, String)> = Vec::new();
    for entry in base.iter().chain(extra) {
        let (k, v) = entry.split_once('=').unwrap_or((entry.as_str(), ""));
        match out.iter_mut().find(|(key, _)| key == k) {
            Some(e) => e.1 = v.to_string(),
            None => out.push((k.to_string(), v.to_string())),
        }
    }
    out.into_iter().map(|(k, v)| format!("{k}={v}")).collect()
}

/// Escapes a path like the kernel prints it in `/proc/mounts`.
fn escape_proc_mounts(p: &str) -> String {
    let mut out = String::new();
    for ch in p.chars() {
        match ch {
            ' ' | '\t' | '\n' | '\\' => out.push_str(&format!("\\{:03o}", ch as u32)),
            c => out.push(c),
        }
    }
    out
}

/// `ensureVmmAvailable`: the VMM binary must run.
fn check_vmm(prepared: &Prepared) -> Result<(), String> {
    let vm = &prepared.configure["vm"];
    let krun = vm["vmm"].as_text() == Some("krun");
    if vm["vmm"].as_text() == Some("firecracker") {
        // the daemon checks the binary (and reports a missing one) at start
        return Ok(());
    }
    let path = if krun {
        vm["krun_runner_path"].as_str().unwrap_or("gondolin-krun-runner")
    } else {
        vm["qemu_path"].as_str().unwrap_or("qemu-system-aarch64")
    };
    if krun {
        return Ok(());
    }
    match std::process::Command::new(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
    {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("{path} --version failed ({s})")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let apt = if path.contains("x86_64") { "qemu-system-x86" } else { "qemu-system-arm" };
            Err(format!(
                "{path} not found: install QEMU (macOS: brew install qemu; Debian/Ubuntu: apt install {apt}) or use --vmm krun"
            ))
        }
        Err(e) => Err(format!("cannot run {path}: {e}")),
    }
}

async fn wait_running(engine: &Engine, client: &Client) -> Result<(), String> {
    let mut status = client.status();
    let mut state = engine.state();
    loop {
        if status.borrow().as_str() == "running" {
            return Ok(());
        }
        if let Some(exit) = state.borrow().exit.clone() {
            return Err(exit);
        }
        match gondolind::util::select2(status.changed(), state.changed()).await {
            gondolind::util::Either::Left(Err(_)) => return Err("sandbox connection closed".into()),
            gondolind::util::Either::Right(Err(_)) => return Err("session ended".into()),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_merge() {
        let base = vec!["A=1".to_string(), "B=2".into()];
        assert_eq!(merge_env(&base, &["A=3".into(), "C=4".into()]), vec!["A=3", "B=2", "C=4"]);
        assert_eq!(escape_proc_mounts("/a b"), "/a\\040b");
    }
}

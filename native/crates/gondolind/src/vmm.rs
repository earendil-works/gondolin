//! The QEMU child process: spawning, log forwarding, termination
//! (`terminateChild` in `host/src/sandbox/child-process.ts`).

use std::process::Stdio;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::mpsc;

/// Delay between SIGTERM and SIGKILL when stopping QEMU.
pub const SIGKILL_AFTER: Duration = Duration::from_millis(3000);
/// Hard cap on waiting for QEMU to exit after SIGTERM.
pub const CLOSE_TIMEOUT: Duration = Duration::from_millis(10_000);

/// pid of the running VMM (0: none), killed by the panic hook.
static CURRENT_PID: AtomicI32 = AtomicI32::new(0);

/// SIGKILLs the current VMM process (best effort; used on daemon exit/panic).
pub fn kill_current() {
    let pid = CURRENT_PID.swap(0, Ordering::SeqCst);
    if pid > 0 {
        // SAFETY: plain kill(2) on a pid we spawned.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

/// Events of one VMM process, tagged with its generation by the owner.
#[derive(Debug)]
pub enum VmmEvent {
    /// stdout/stderr output
    Log { stderr: bool, chunk: Vec<u8> },
    /// the process exited (or termination gave up waiting)
    Exited { code: Option<i32>, signal: Option<i32> },
}

/// Handle to a running VMM process.
pub struct VmmProcess {
    pub pid: u32,
    stop_tx: Option<tokio::sync::oneshot::Sender<bool>>,
}

impl VmmProcess {
    /// Spawns `program args`; events are delivered through `events` as
    /// `(generation, event)`.
    pub fn spawn(
        program: &str,
        args: &[String],
        generation: u64,
        events: mpsc::Sender<(u64, VmmEvent)>,
    ) -> std::io::Result<Self> {
        let mut cmd = Command::new(program);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "linux")]
        {
            // SAFETY: prctl is async-signal-safe; kill QEMU if the daemon dies.
            unsafe {
                cmd.pre_exec(|| {
                    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                    Ok(())
                });
            }
        }
        let mut child = cmd.spawn()?;
        let pid = child.id().unwrap_or(0);
        CURRENT_PID.store(pid as i32, Ordering::SeqCst);
        // macOS has no PR_SET_PDEATHSIG: a helper kills QEMU if we die
        let watchdog = spawn_watchdog(pid);

        let mut readers = Vec::new();
        for (stderr, pipe) in [
            (
                false,
                child
                    .stdout
                    .take()
                    .map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
            ),
            (
                true,
                child
                    .stderr
                    .take()
                    .map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
            ),
        ] {
            let Some(mut pipe) = pipe else { continue };
            let events = events.clone();
            readers.push(tokio::spawn(async move {
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    match pipe.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => {
                            let ev = VmmEvent::Log { stderr, chunk: buf[..n].to_vec() };
                            if events.send((generation, ev)).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            }));
        }

        let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<bool>();
        tokio::spawn(async move {
            let status = tokio::select! {
                status = child.wait() => status.ok(),
                req = &mut stop_rx => {
                    let force = req.unwrap_or(true);
                    terminate(&mut child, pid, force).await
                }
            };
            let _ = CURRENT_PID.compare_exchange(pid as i32, 0, Ordering::SeqCst, Ordering::SeqCst);
            if let Some(mut w) = watchdog {
                // closing its stdin after QEMU is gone just lets it exit
                drop(w.stdin.take());
                let _ = tokio::time::timeout(Duration::from_millis(500), w.wait()).await;
            }
            // let the log readers drain so exit diagnostics see the last lines
            let drain = async {
                for r in readers {
                    let _ = r.await;
                }
            };
            let _ = tokio::time::timeout(Duration::from_millis(500), drain).await;
            let (code, signal) = match status {
                Some(status) => exit_parts(status),
                None => (None, None),
            };
            let _ = events.send((generation, VmmEvent::Exited { code, signal })).await;
        });

        Ok(VmmProcess { pid, stop_tx: Some(stop_tx) })
    }

    /// Asks the process to stop: SIGTERM (SIGKILL when `force`), then SIGKILL
    /// after [`SIGKILL_AFTER`]; the `Exited` event follows.
    pub fn stop(&mut self, force: bool) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(force);
        }
    }
}

/// Starts `gondolind --vmm-watchdog <pid>` with a pipe on its stdin (macOS).
fn spawn_watchdog(pid: u32) -> Option<tokio::process::Child> {
    if !cfg!(target_os = "macos") || cfg!(test) || pid == 0 {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    Command::new(exe)
        .arg("--vmm-watchdog")
        .arg(pid.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .ok()
}

/// Body of `gondolind --vmm-watchdog <pid>`: SIGKILLs `pid` when stdin reaches
/// EOF (the daemon exited, however it died) and exits when `pid` exits first.
/// Uses kqueue `NOTE_EXIT`, so a recycled pid is never signalled.
#[cfg(target_os = "macos")]
pub fn run_watchdog(pid: i32) -> i32 {
    // SAFETY: plain kqueue/kevent/read calls on fds we own.
    unsafe {
        let kq = libc::kqueue();
        if kq < 0 {
            return 1;
        }
        let mut changes: [libc::kevent; 2] = std::mem::zeroed();
        changes[0].ident = pid as usize;
        changes[0].filter = libc::EVFILT_PROC;
        changes[0].flags = libc::EV_ADD;
        changes[0].fflags = libc::NOTE_EXIT;
        changes[1].ident = 0;
        changes[1].filter = libc::EVFILT_READ;
        changes[1].flags = libc::EV_ADD;
        if libc::kevent(kq, changes.as_ptr(), 2, std::ptr::null_mut(), 0, std::ptr::null()) < 0 {
            // the process is already gone
            return 0;
        }
        loop {
            let mut ev: libc::kevent = std::mem::zeroed();
            let n = libc::kevent(kq, std::ptr::null(), 0, &mut ev, 1, std::ptr::null());
            if n < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return 1;
            }
            if n == 0 {
                continue;
            }
            if ev.filter == libc::EVFILT_PROC {
                return 0;
            }
            let mut buf = [0u8; 256];
            let r = libc::read(0, buf.as_mut_ptr().cast(), buf.len());
            if r == 0
                || (r < 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted)
            {
                libc::kill(pid, libc::SIGKILL);
                return 0;
            }
        }
    }
}

async fn terminate(
    child: &mut tokio::process::Child,
    pid: u32,
    force: bool,
) -> Option<std::process::ExitStatus> {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    // SAFETY: kill(2) on our own child.
    unsafe {
        libc::kill(pid as i32, signal);
    }
    match tokio::time::timeout(SIGKILL_AFTER, child.wait()).await {
        Ok(status) => return status.ok(),
        Err(_) => {
            let _ = child.start_kill();
        }
    }
    match tokio::time::timeout(CLOSE_TIMEOUT.saturating_sub(SIGKILL_AFTER), child.wait()).await {
        Ok(status) => status.ok(),
        Err(_) => None,
    }
}

fn exit_parts(status: std::process::ExitStatus) -> (Option<i32>, Option<i32>) {
    use std::os::unix::process::ExitStatusExt;
    (status.code(), status.signal())
}

/// Node-style signal name (`SIGTERM`).
pub fn signal_name(sig: i32) -> String {
    let name = match sig {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGCHLD => "SIGCHLD",
        libc::SIGCONT => "SIGCONT",
        libc::SIGSTOP => "SIGSTOP",
        libc::SIGTSTP => "SIGTSTP",
        libc::SIGXCPU => "SIGXCPU",
        libc::SIGXFSZ => "SIGXFSZ",
        libc::SIGSYS => "SIGSYS",
        _ => return format!("SIG{sig}"),
    };
    name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawn_log_and_exit() {
        crate::test_timeout(async {
            let (tx, mut rx) = mpsc::channel(16);
            let _p = VmmProcess::spawn(
                "/bin/sh",
                &["-c".into(), "echo out; echo err >&2; exit 3".into()],
                7,
                tx,
            )
            .unwrap();
            let mut out = Vec::new();
            let mut err = Vec::new();
            loop {
                let (generation, ev) = rx.recv().await.unwrap();
                assert_eq!(generation, 7);
                match ev {
                    VmmEvent::Log { stderr: false, chunk } => out.extend(chunk),
                    VmmEvent::Log { stderr: true, chunk } => err.extend(chunk),
                    VmmEvent::Exited { code, signal } => {
                        assert_eq!(code, Some(3));
                        assert_eq!(signal, None);
                        break;
                    }
                }
            }
            assert_eq!(out, b"out\n");
            assert_eq!(err, b"err\n");
        })
        .await;
    }

    #[tokio::test]
    async fn stop_terminates() {
        crate::test_timeout(async {
            let (tx, mut rx) = mpsc::channel(16);
            let mut p = VmmProcess::spawn("/bin/sleep", &["30".into()], 1, tx).unwrap();
            p.stop(false);
            loop {
                if let (_, VmmEvent::Exited { code, signal }) = rx.recv().await.unwrap() {
                    assert_eq!(code, None);
                    assert_eq!(signal, Some(libc::SIGTERM));
                    break;
                }
            }
            assert_eq!(signal_name(libc::SIGTERM), "SIGTERM");
        })
        .await;
    }
}

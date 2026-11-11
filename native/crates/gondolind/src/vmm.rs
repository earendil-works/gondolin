//! The VMM child process (QEMU or the krun runner): spawning, log forwarding,
//! termination.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

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
    stop_tx: Option<oneshot::Sender<bool>>,
}

/// Signals a child that may have exited: never after the waiter thread saw
/// the exit (the zombie is reaped only after `exited` is set under the lock,
/// so the pid cannot be recycled while we hold it).
#[derive(Clone)]
struct Signaller {
    pid: i32,
    exited: Arc<Mutex<bool>>,
}

impl Signaller {
    fn kill(&self, signal: i32) {
        let exited = self.exited.lock().unwrap();
        if !*exited {
            // SAFETY: kill(2) on our own, not yet reaped child.
            unsafe {
                libc::kill(self.pid, signal);
            }
        }
    }
}

/// Setup of [`VmmProcess::spawn_with`] beyond the command line (Linux only).
#[derive(Debug, Default)]
pub struct SpawnExtra {
    /// network namespace to run in (an open `/proc/.../ns/net` descriptor)
    pub netns: Option<std::os::fd::RawFd>,
    /// bind mounts made in a private mount namespace before exec
    pub binds: Vec<crate::jailer::Bind>,
    /// start the watchdog that kills the VMM when the daemon dies (always on
    /// macOS)
    pub watchdog: bool,
}

impl VmmProcess {
    /// Spawns `program args`; events are delivered through `events` as
    /// `(generation, event)`. The child is watched by std threads (one waiter,
    /// one reader per output pipe).
    pub fn spawn(
        program: &str,
        args: &[String],
        generation: u64,
        events: mpsc::Sender<(u64, VmmEvent)>,
    ) -> std::io::Result<Self> {
        Self::spawn_in(program, args, generation, events, None)
    }

    /// [`VmmProcess::spawn`] inside the network namespace `netns` (an open
    /// `/proc/.../ns/net` descriptor; Linux only).
    pub fn spawn_in(
        program: &str,
        args: &[String],
        generation: u64,
        events: mpsc::Sender<(u64, VmmEvent)>,
        netns: Option<std::os::fd::RawFd>,
    ) -> std::io::Result<Self> {
        let extra = SpawnExtra { netns, ..Default::default() };
        Self::spawn_with(program, args, generation, events, &extra)
    }

    /// [`VmmProcess::spawn`] with the Linux-only `extra` setup.
    pub fn spawn_with(
        program: &str,
        args: &[String],
        generation: u64,
        events: mpsc::Sender<(u64, VmmEvent)>,
        extra: &SpawnExtra,
    ) -> std::io::Result<Self> {
        let mut cmd = Command::new(program);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let netns = extra.netns;
        #[cfg(target_os = "linux")]
        {
            use std::ffi::CString;
            use std::os::unix::ffi::OsStrExt;
            use std::os::unix::process::CommandExt;
            let cstr = |p: &std::path::Path| {
                CString::new(p.as_os_str().as_bytes())
                    .map_err(|_| std::io::Error::other(format!("NUL in {}", p.display())))
            };
            let binds = extra
                .binds
                .iter()
                .map(|b| Ok((cstr(&b.source)?, cstr(&b.target)?, b.read_only)))
                .collect::<std::io::Result<Vec<_>>>()?;
            // SAFETY: prctl, setns, unshare and mount are async-signal-safe
            // and the closure allocates nothing; kill the VMM if the daemon
            // dies. `netns` is still open in the child before exec.
            unsafe {
                cmd.pre_exec(move || {
                    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                    if let Some(fd) = netns
                        && libc::setns(fd, libc::CLONE_NEWNET) != 0
                    {
                        return Err(std::io::Error::last_os_error());
                    }
                    if !binds.is_empty() {
                        // the bind mounts exist only in this process's own
                        // mount namespace and go away with it
                        let null = std::ptr::null();
                        if libc::unshare(libc::CLONE_NEWNS) != 0
                            || libc::mount(
                                null,
                                c"/".as_ptr(),
                                null,
                                libc::MS_REC | libc::MS_PRIVATE,
                                null.cast(),
                            ) != 0
                        {
                            return Err(std::io::Error::last_os_error());
                        }
                        for (source, target, read_only) in &binds {
                            if libc::mount(
                                source.as_ptr(),
                                target.as_ptr(),
                                null,
                                libc::MS_BIND,
                                null.cast(),
                            ) != 0
                            {
                                return Err(std::io::Error::last_os_error());
                            }
                            if *read_only
                                && libc::mount(
                                    null,
                                    target.as_ptr(),
                                    null,
                                    libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY,
                                    null.cast(),
                                ) != 0
                            {
                                return Err(std::io::Error::last_os_error());
                            }
                        }
                    }
                    Ok(())
                });
            }
        }
        #[cfg(not(target_os = "linux"))]
        if netns.is_some() || !extra.binds.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "network and mount namespaces are Linux-only",
            ));
        }
        let mut child = cmd.spawn()?;
        let pid = child.id();
        CURRENT_PID.store(pid as i32, Ordering::SeqCst);
        // macOS has no PR_SET_PDEATHSIG, and a process that changes its
        // credentials (the jailer) loses it: a helper kills the VMM if we die
        let watchdog = spawn_watchdog(pid, extra.watchdog);

        // log readers: one thread per pipe; each reports when it is done
        let mut readers = Vec::new();
        let pipes: [(bool, Option<Box<dyn Read + Send>>); 2] = [
            (false, child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>)),
            (true, child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)),
        ];
        for (stderr, pipe) in pipes {
            let Some(mut pipe) = pipe else { continue };
            let events = events.clone();
            let (done_tx, done_rx) = oneshot::channel::<()>();
            readers.push(done_rx);
            std::thread::Builder::new().name("vmm-log".into()).spawn(move || {
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    match pipe.read(&mut buf) {
                        Ok(0) => break,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                        Ok(n) => {
                            let ev = VmmEvent::Log { stderr, chunk: buf[..n].to_vec() };
                            if events.blocking_send((generation, ev)).is_err() {
                                break;
                            }
                        }
                    }
                }
                let _ = done_tx.send(());
            })?;
        }

        // waiter: observes the exit without reaping (WNOWAIT), marks it under
        // the signaller's lock, then reaps
        let signaller = Signaller { pid: pid as i32, exited: Arc::new(Mutex::new(false)) };
        let (exit_tx, exit_rx) = oneshot::channel::<Option<std::process::ExitStatus>>();
        {
            let signaller = signaller.clone();
            std::thread::Builder::new().name("vmm-wait".into()).spawn(move || {
                wait_exit_nowait(pid as i32);
                let status = {
                    let mut exited = signaller.exited.lock().unwrap();
                    *exited = true;
                    child.wait().ok()
                };
                let _ = exit_tx.send(status);
            })?;
        }

        let (stop_tx, stop_rx) = oneshot::channel::<bool>();
        tokio::spawn(async move {
            let mut exit_rx = exit_rx;
            let status = match crate::util::select2(&mut exit_rx, stop_rx).await {
                crate::util::Either::Left(status) => status.ok().flatten(),
                crate::util::Either::Right(req) => {
                    let force = req.unwrap_or(true);
                    terminate(&signaller, &mut exit_rx, force).await
                }
            };
            let _ = CURRENT_PID.compare_exchange(pid as i32, 0, Ordering::SeqCst, Ordering::SeqCst);
            if let Some(mut w) = watchdog {
                // closing its stdin after QEMU is gone just lets it exit
                drop(w.stdin.take());
                std::thread::spawn(move || {
                    let _ = w.wait();
                });
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

/// Blocks until child `pid` exited, leaving it unreaped.
fn wait_exit_nowait(pid: i32) {
    loop {
        // SAFETY: waitid on our own child with a zeroed siginfo.
        let r = unsafe {
            let mut info: libc::siginfo_t = std::mem::zeroed();
            libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT)
        };
        if r == 0 || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return;
        }
    }
}

/// Starts `gondolind --vmm-watchdog <pid>` with a pipe on its stdin (macOS,
/// and on Linux when `needed`).
fn spawn_watchdog(pid: u32, needed: bool) -> Option<std::process::Child> {
    let wanted = cfg!(target_os = "macos") || (cfg!(target_os = "linux") && needed);
    if !wanted || cfg!(test) || pid == 0 {
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

/// Body of `gondolind --vmm-watchdog <pid>` on Linux: as on macOS, with a
/// pidfd for the process, so a recycled pid is never signalled.
#[cfg(target_os = "linux")]
pub fn run_watchdog(pid: i32) -> i32 {
    // SAFETY: plain pidfd_open/poll/read/pidfd_send_signal calls on fds we own.
    unsafe {
        let pidfd = libc::syscall(libc::SYS_pidfd_open, pid, 0) as libc::c_int;
        if pidfd < 0 {
            // the process is already gone
            return 0;
        }
        loop {
            let mut fds = [
                libc::pollfd { fd: 0, events: libc::POLLIN, revents: 0 },
                libc::pollfd { fd: pidfd, events: libc::POLLIN, revents: 0 },
            ];
            if libc::poll(fds.as_mut_ptr(), 2, -1) < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return 1;
            }
            if fds[1].revents != 0 {
                return 0;
            }
            if fds[0].revents == 0 {
                continue;
            }
            let mut buf = [0u8; 256];
            let r = libc::read(0, buf.as_mut_ptr().cast(), buf.len());
            if r == 0
                || (r < 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted)
            {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    pidfd,
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                );
                return 0;
            }
        }
    }
}

async fn terminate(
    signaller: &Signaller,
    exit_rx: &mut oneshot::Receiver<Option<std::process::ExitStatus>>,
    force: bool,
) -> Option<std::process::ExitStatus> {
    signaller.kill(if force { libc::SIGKILL } else { libc::SIGTERM });
    if let Ok(status) = tokio::time::timeout(SIGKILL_AFTER, &mut *exit_rx).await {
        return status.ok().flatten();
    }
    signaller.kill(libc::SIGKILL);
    match tokio::time::timeout(CLOSE_TIMEOUT.saturating_sub(SIGKILL_AFTER), exit_rx).await {
        Ok(status) => status.ok().flatten(),
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

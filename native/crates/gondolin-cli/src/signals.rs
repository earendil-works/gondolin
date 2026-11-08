//! Process signals for the CLI through a self-pipe (instead of tokio's
//! `signal` feature): the async-signal-safe handler writes the signal number
//! to a pipe, a thread forwards it to a broadcast channel.
//!
//! A signal is caught from the first [`subscribe`] that names it for the rest
//! of the process (like tokio's signal handling).

use std::sync::{Mutex, OnceLock};

use tokio::sync::broadcast;

/// Write end of the self-pipe (`-1` before setup).
static PIPE_WRITE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

struct State {
    tx: broadcast::Sender<i32>,
    installed: Mutex<Vec<i32>>,
}

fn state() -> &'static State {
    static STATE: OnceLock<State> = OnceLock::new();
    STATE.get_or_init(|| {
        let (tx, _) = broadcast::channel(64);
        let mut fds = [0i32; 2];
        // SAFETY: pipe(2) into a local array; flags on fds we own.
        unsafe {
            if libc::pipe(fds.as_mut_ptr()) == 0 {
                for fd in fds {
                    libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
                }
                let flags = libc::fcntl(fds[1], libc::F_GETFL);
                libc::fcntl(fds[1], libc::F_SETFL, flags | libc::O_NONBLOCK);
                PIPE_WRITE.store(fds[1], std::sync::atomic::Ordering::SeqCst);
                let tx = tx.clone();
                let read_fd = fds[0];
                std::thread::Builder::new()
                    .name("signals".into())
                    .spawn(move || {
                        let mut buf = [0u8; 64];
                        loop {
                            // SAFETY: read(2) into our buffer.
                            let n = libc::read(read_fd, buf.as_mut_ptr().cast(), buf.len());
                            if n < 0 {
                                if std::io::Error::last_os_error().kind()
                                    == std::io::ErrorKind::Interrupted
                                {
                                    continue;
                                }
                                return;
                            }
                            if n == 0 {
                                return;
                            }
                            for &sig in &buf[..n as usize] {
                                let _ = tx.send(sig as i32);
                            }
                        }
                    })
                    .expect("signal thread");
            }
        }
        State { tx, installed: Mutex::new(Vec::new()) }
    })
}

extern "C" fn on_signal(sig: libc::c_int) {
    let fd = PIPE_WRITE.load(std::sync::atomic::Ordering::Relaxed);
    if fd >= 0 {
        let b = sig as u8;
        // SAFETY: write(2) is async-signal-safe; a full pipe drops the byte.
        unsafe {
            libc::write(fd, (&b as *const u8).cast(), 1);
        }
    }
}

/// Receives the given signals from now on.
pub fn subscribe(signals: &[i32]) -> Receiver {
    let st = state();
    let rx = st.tx.subscribe();
    let mut installed = st.installed.lock().unwrap();
    for &sig in signals {
        if installed.contains(&sig) {
            continue;
        }
        // SAFETY: installing a handler that only writes to the self-pipe.
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = on_signal as *const () as libc::sighandler_t;
            action.sa_flags = libc::SA_RESTART;
            libc::sigemptyset(&mut action.sa_mask);
            libc::sigaction(sig, &action, std::ptr::null_mut());
        }
        installed.push(sig);
    }
    Receiver { rx, signals: signals.to_vec() }
}

/// Signals of one subscription.
pub struct Receiver {
    rx: broadcast::Receiver<i32>,
    signals: Vec<i32>,
}

impl Receiver {
    /// The next of the subscribed signals.
    pub async fn recv(&mut self) -> i32 {
        loop {
            match self.rx.recv().await {
                Ok(sig) if self.signals.contains(&sig) => return sig,
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => std::future::pending().await,
            }
        }
    }
}

//! Terminal handling for interactive commands (`attachTty`): raw mode,
//! window size, SIGWINCH and a stdin reader with the Ctrl-] escape.

use tokio::sync::mpsc;

/// Detach byte (Ctrl-])
pub const ESCAPE_BYTE: u8 = 0x1d;

/// Puts fd 0 into raw mode while alive (only when it is a TTY).
pub struct RawMode {
    saved: Option<libc::termios>,
}

impl RawMode {
    pub fn enable() -> RawMode {
        // SAFETY: plain termios calls on fd 0.
        unsafe {
            if libc::isatty(0) != 1 {
                return RawMode { saved: None };
            }
            let mut t: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(0, &mut t) != 0 {
                return RawMode { saved: None };
            }
            let saved = t;
            libc::cfmakeraw(&mut t);
            // keep output post-processing off like node's setRawMode
            libc::tcsetattr(0, libc::TCSANOW, &t);
            RawMode { saved: Some(saved) }
        }
    }

    pub fn restore(&mut self) {
        if let Some(t) = self.saved.take() {
            // SAFETY: restoring the saved attributes of fd 0.
            unsafe {
                libc::tcsetattr(0, libc::TCSANOW, &t);
            }
        }
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        self.restore();
    }
}

/// `(rows, cols)` of the terminal on stdout, if it is one.
pub fn window_size() -> Option<(u16, u16)> {
    // SAFETY: TIOCGWINSZ fills a winsize.
    unsafe {
        if libc::isatty(1) != 1 {
            return None;
        }
        let mut ws: libc::winsize = std::mem::zeroed();
        if libc::ioctl(1, libc::TIOCGWINSZ, &mut ws) != 0 || ws.ws_row == 0 || ws.ws_col == 0 {
            return None;
        }
        Some((ws.ws_row, ws.ws_col))
    }
}

/// What the stdin reader produces.
#[derive(Debug)]
pub enum Input {
    Data(Vec<u8>),
    /// Ctrl-] (bytes before it were delivered as `Data`)
    Escape,
    Eof,
}

/// Reads stdin on a thread (blocking reads), splitting at the escape byte.
pub fn stdin_reader() -> mpsc::Receiver<Input> {
    let (tx, rx) = mpsc::channel(16);
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            // SAFETY: reading into our buffer.
            let n = unsafe { libc::read(0, buf.as_mut_ptr().cast(), buf.len()) };
            if n < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                let _ = tx.blocking_send(Input::Eof);
                return;
            }
            if n == 0 {
                let _ = tx.blocking_send(Input::Eof);
                return;
            }
            let chunk = &buf[..n as usize];
            if let Some(idx) = chunk.iter().position(|b| *b == ESCAPE_BYTE) {
                if idx > 0 {
                    let _ = tx.blocking_send(Input::Data(chunk[..idx].to_vec()));
                }
                let _ = tx.blocking_send(Input::Escape);
                return;
            }
            if tx.blocking_send(Input::Data(chunk.to_vec())).is_err() {
                return;
            }
        }
    });
    rx
}

/// `getDefaultInteractiveShellCommand`
pub fn default_shell() -> Vec<String> {
    vec![
        "/bin/sh".into(),
        "-lc".into(),
        "if command -v bash >/dev/null 2>&1; then exec bash -i; else exec /bin/sh -i; fi".into(),
    ]
}

/// `buildShellEnv`: the merged env plus `TERM` from the host.
pub fn shell_env(base: &[String], extra: &[String]) -> Vec<String> {
    let mut env = crate::vm::merge_env(base, extra);
    if !env.iter().any(|e| e.starts_with("TERM=")) {
        let term = std::env::var("TERM").ok().filter(|t| !t.is_empty() && t != "xterm-ghostty");
        env.push(format!("TERM={}", term.unwrap_or_else(|| "xterm-256color".into())));
    }
    env
}

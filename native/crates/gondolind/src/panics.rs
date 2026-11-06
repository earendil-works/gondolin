//! Panic containment (release builds unwind).
//!
//! - Per-flow and per-request work is wrapped in [`CatchUnwind`]: a panic
//!   there aborts that flow or answers that request with an error, and the VM
//!   keeps running.
//! - The session task owns all session state; a panic there fails closed (the
//!   caller kills the VMM, reports `exit`, and the daemon exits).
//! - The panic hook reports every panic as a `log` message (component `error`)
//!   to the controller, besides the default stderr output.
//!
//! Test hooks ([`test_panic`]) inject panics at chosen points; they exist only
//! in debug builds and only when `GONDOLIND_TEST_PANICS=1`.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};

use crate::controller::Controller;

/// Polls a future inside `catch_unwind`; resolves to `Err(message)` when it
/// panicked. The future is dropped only after the caller saw the panic, so it
/// can e.g. reset a connection before the stream's `Drop` closes it cleanly.
pub struct CatchUnwind<F>(Pin<Box<F>>);

impl<F: Future> CatchUnwind<F> {
    pub fn new(fut: F) -> Self {
        CatchUnwind(Box::pin(fut))
    }
}

impl<F: Future> Future for CatchUnwind<F> {
    type Output = Result<F::Output, String>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let fut = self.0.as_mut();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fut.poll(cx))) {
            Ok(Poll::Pending) => Poll::Pending,
            Ok(Poll::Ready(out)) => Poll::Ready(Ok(out)),
            Err(payload) => Poll::Ready(Err(payload_message(payload.as_ref()))),
        }
    }
}

/// Runs a closure, turning a panic into `Err(message)`.
pub fn catch<T>(f: impl FnOnce() -> T) -> Result<T, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .map_err(|payload| payload_message(payload.as_ref()))
}

/// The message of a panic payload.
pub fn payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic".to_string()
    }
}

static SINK: OnceLock<Arc<Controller>> = OnceLock::new();

/// Installs the panic hook (stderr via the default hook, plus a `log`
/// message to the controller once [`set_sink`] was called).
pub fn install_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = payload_message(info.payload());
        let location =
            info.location().map(|l| format!(" at {}:{}", l.file(), l.line())).unwrap_or_default();
        let message = format!("gondolind: panic: {payload}{location}");
        if let Some(ctl) = SINK.get() {
            ctl.try_send_log("error", &message);
        }
        default_hook(info);
    }));
}

/// Routes panic reports to the controller.
pub fn set_sink(ctl: Arc<Controller>) {
    let _ = SINK.set(ctl);
}

/// Fails closed after a panic that may have left shared state inconsistent:
/// kills the VMM, reports `exit` and an `error` to the controller, and exits
/// the daemon once the report was written (bounded wait).
pub fn fail_closed(reason: &str) {
    crate::vmm::kill_current();
    let message = format!("gondolind internal error, VM stopped: {reason}");
    eprintln!("{message}");
    if let Some(ctl) = SINK.get() {
        ctl.send(
            gondolin_proto::session::EXIT,
            0,
            &gondolin_proto::session::Exit {
                code: None,
                signal: None,
                error: Some(message.clone()),
            },
        );
        ctl.error_event("internal_error", &message, None);
        let ctl = ctl.clone();
        std::thread::spawn(move || {
            for _ in 0..200 {
                if ctl.queued_bytes() == 0 {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            crate::vmm::kill_current();
            std::process::exit(70);
        });
    } else {
        std::process::exit(70);
    }
}

/// Points where tests can inject a panic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestPanic {
    /// a guest TCP flow to port 9 (discard)
    Flow,
    /// a sandboxfs `lookup` of the name `gondolind-test-panic`
    Vfs,
    /// an exec of the command `gondolind-test-panic` (session task)
    Session,
}

/// Whether an injected panic is enabled (debug builds with
/// `GONDOLIND_TEST_PANICS=1` only).
pub fn test_panics_enabled() -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("GONDOLIND_TEST_PANICS").as_deref() == Ok("1"))
}

/// Panics when injected panics are enabled.
pub fn test_panic(point: TestPanic) {
    if test_panics_enabled() {
        panic!("injected test panic: {point:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn catch_unwind_future() {
        let ok = CatchUnwind::new(async { 5 }).await;
        assert_eq!(ok, Ok(5));
        let err = CatchUnwind::new(async {
            tokio::task::yield_now().await;
            panic!("boom {}", 1);
        })
        .await;
        assert_eq!(err.map(|_: ()| ()), Err("boom 1".to_string()));
        assert_eq!(catch(|| -> u8 { panic!("x") }), Err("x".to_string()));
    }
}

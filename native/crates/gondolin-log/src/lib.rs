//! Minimal logging facade for the Gondolin native crates (no dependencies).
//!
//! Crates log with [`error!`], [`warn!`], [`debug!`] and [`trace!`]
//! (`format!` syntax, optional `target: "..."` first); the process installs
//! one sink with [`set_sink`]. Disabled levels cost an atomic load: the
//! message is only formatted when a sink wants it. gondolind forwards records
//! of `gondolin*` targets to the controller as `log` messages (component
//! `net` for the network crates), the way it did for `tracing` events.
//!
//! The target defaults to the calling module's path (`module_path!()`).

use std::fmt;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU8, Ordering};

/// Severity, most severe first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum Level {
    Error = 1,
    Warn = 2,
    Debug = 3,
    Trace = 4,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warn => "warn",
            Level::Debug => "debug",
            Level::Trace => "trace",
        }
    }
}

impl fmt::Display for Level {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One log record.
#[derive(Debug, Clone, Copy)]
pub struct Record<'a> {
    pub level: Level,
    /// `module_path!()` or the explicit `target:`
    pub target: &'a str,
    pub args: fmt::Arguments<'a>,
}

/// Receives the records of every enabled level.
pub type Sink = Box<dyn Fn(&Record<'_>) + Send + Sync>;

static SINK: OnceLock<Sink> = OnceLock::new();
/// Most verbose level a sink wants (0 = none)
static MAX_LEVEL: AtomicU8 = AtomicU8::new(0);

/// Installs the process-wide sink and its most verbose level (first call
/// wins; returns `false` if a sink was installed already).
pub fn set_sink(max_level: Level, sink: Sink) -> bool {
    if SINK.set(sink).is_err() {
        return false;
    }
    MAX_LEVEL.store(max_level as u8, Ordering::Release);
    true
}

/// Changes the most verbose level delivered to the sink.
pub fn set_max_level(level: Option<Level>) {
    MAX_LEVEL.store(level.map_or(0, |l| l as u8), Ordering::Release);
}

/// Whether records of `level` reach a sink.
#[inline]
pub fn enabled(level: Level) -> bool {
    (level as u8) <= MAX_LEVEL.load(Ordering::Relaxed)
}

#[doc(hidden)]
pub fn __log(level: Level, target: &str, args: fmt::Arguments<'_>) {
    if let Some(sink) = SINK.get() {
        sink(&Record { level, target, args });
    }
}

#[doc(hidden)]
#[macro_export]
macro_rules! __log {
    ($level:expr, target: $target:expr, $($arg:tt)+) => {
        if $crate::enabled($level) {
            $crate::__log($level, $target, format_args!($($arg)+));
        }
    };
    ($level:expr, $($arg:tt)+) => {
        $crate::__log!($level, target: module_path!(), $($arg)+)
    };
}

/// Logs at [`Level::Error`].
#[macro_export]
macro_rules! error {
    ($($arg:tt)+) => { $crate::__log!($crate::Level::Error, $($arg)+) };
}

/// Logs at [`Level::Warn`].
#[macro_export]
macro_rules! warn {
    ($($arg:tt)+) => { $crate::__log!($crate::Level::Warn, $($arg)+) };
}

/// Logs at [`Level::Debug`].
#[macro_export]
macro_rules! debug {
    ($($arg:tt)+) => { $crate::__log!($crate::Level::Debug, $($arg)+) };
}

/// Logs at [`Level::Trace`].
#[macro_export]
macro_rules! trace {
    ($($arg:tt)+) => { $crate::__log!($crate::Level::Trace, $($arg)+) };
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

    #[test]
    fn levels_targets_and_lazy_formatting() {
        assert!(!enabled(Level::Error));
        // nothing is formatted without a sink
        struct Boom;
        impl fmt::Display for Boom {
            fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
                panic!("formatted while disabled")
            }
        }
        debug!("{}", Boom);
        assert!(set_sink(
            Level::Debug,
            Box::new(|r| SEEN.lock().unwrap().push(format!("{} {} {}", r.level, r.target, r.args)))
        ));
        assert!(!set_sink(Level::Trace, Box::new(|_| {})));
        debug!(target: "gondolin::net", "flow {} closed", 7);
        warn!("plain");
        trace!("{}", Boom);
        set_max_level(None);
        error!("{}", Boom);
        let seen = SEEN.lock().unwrap();
        assert_eq!(
            *seen,
            vec![
                "debug gondolin::net flow 7 closed".to_string(),
                format!("warn {} plain", module_path!()),
            ]
        );
    }
}

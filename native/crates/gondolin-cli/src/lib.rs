//! The static `gondolin` CLI: `bash`, `exec`, `list`, `attach`, `snapshot`
//! and `image` without Node, on an in-process controller over the gondolind
//! session library (`gondolind::embed`). See `docs/cli.md`.
//!
//! Multi-call: invoked as `gondolind*` (or `gondolin daemon ...`) the binary
//! is the daemon speaking the controller protocol on stdio.

pub mod args;
pub mod checkpoint;
pub mod commands;
pub mod configure;
pub mod engine;
pub mod etc_mount;
pub mod fwd;
pub mod ingress;
pub mod netcfg;
pub mod registry;
pub mod session;
pub mod signals;
pub mod ssh;
pub mod util;
pub mod vm;

/// Process entry point.
pub fn main() {
    let mut argv = std::env::args();
    let program = argv.next().unwrap_or_default();
    let args: Vec<String> = argv.collect();
    let name = std::path::Path::new(&program)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if name.starts_with("gondolind") {
        gondolind::main_with_args(args);
        return;
    }
    // the VMM watchdog re-executes the current binary (macOS, jailed
    // Firecracker on Linux)
    if args.first().map(String::as_str) == Some("--vmm-watchdog") {
        gondolind::main_with_args(args);
        return;
    }
    if args.first().map(String::as_str) == Some("daemon") {
        gondolind::main_with_args(args[1..].to_vec());
        return;
    }
    // SAFETY: writes to a closed pipe fail with EPIPE instead of killing us.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    gondolind::panics::install_hook();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("gondolin")
        .build()
        .expect("tokio runtime");
    let code = runtime.block_on(commands::run(args));
    gondolind::vmm::kill_current();
    runtime.shutdown_background();
    std::process::exit(code);
}

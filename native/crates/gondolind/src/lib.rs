//! gondolind: Gondolin's native host engine. Speaks the controller protocol on
//! stdin/stdout (`native/DESIGN.md`); stderr carries free-form diagnostics.
//!
//! Module map:
//! - [`controller`]: controller framing, request correlation, handler registry
//! - [`session`]: the session actor (configuration, clients, boot, VMM lifecycle)
//! - `exec`, `files`, `idle`: exec handling, guest file operations, idle pause
//! - [`guest`], [`guestmsg`], [`vfs_port`]: guest channels and messages
//! - [`qemu`], [`vmm`], [`qmp`]: QEMU command line, process, monitor
//! - [`subsystem`]: VFS/network integration points
//! - [`net`]: native network (netstack + egress + SSH proxy, tier-3 hooks)

pub mod bootcfg;
mod checkpoint;
pub mod controller;
pub mod embed;
mod exec;
pub mod fields;
mod files;
pub mod firecracker;
pub mod guest;
pub mod guestmsg;
pub mod idle;
pub mod image;
pub mod jailer;
pub mod krun;
pub mod mitm_ca;
pub mod net;
mod netlog;
pub(crate) mod ordmap;
pub mod panics;
pub mod qemu;
pub mod qmp;
pub mod rootdisk;
pub mod session;
mod stdio;
pub mod subsystem;
pub mod tap;
pub mod tcpfwd;
pub mod timing;
pub mod util;
pub mod vfs;
pub mod vfs_port;
pub mod vmm;

#[cfg(test)]
mod tests;

/// Runs a test future with a deadline so a deadlock fails instead of hanging.
#[cfg(test)]
pub(crate) async fn test_timeout<F: std::future::Future>(f: F) -> F::Output {
    tokio::time::timeout(std::time::Duration::from_secs(20), f).await.expect("test timed out")
}

use gondolin_proto::PROTOCOL_VERSION;
use gondolin_proto::session::{HELLO, Hello};

use crate::controller::{Controller, Dispatcher};
use crate::qemu::HostInfo;
use crate::session::Session;

/// A boxed future (async methods of object-safe traits).
pub type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// Optional features announced in `hello`.
const FEATURES: &[&str] = &[
    "exec",
    "files",
    "idle_pause",
    "vfs.controller",
    "net.external",
    "tcp_forward",
    "mitm_ca",
    "image",
    "net.native",
];

/// Usage for unknown arguments (without arguments the daemon speaks the
/// controller protocol on stdio).
const USAGE: &str = "usage: gondolind                     speak the controller protocol on stdio
       gondolind --version | -V      print the version
       gondolind assets ...          manage guest images (assets --help)
       gondolind --mitm-ca [DIR]     load or create the MITM CA, print its certificate
       gondolind --qemu-args         print the QEMU argv for a configure payload (JSON on stdin)
       gondolind --disk-info PATH    print a disk image's format, virtual size and backing file (JSON)
       gondolind --vmm-watchdog PID  (internal) kill the VMM PID when the daemon exits";

/// Process entry point (argument handling, runtime setup).
pub fn main() {
    main_with_args(std::env::args().skip(1).collect());
}

/// Daemon entry point with explicit arguments (without the program name);
/// the multi-call `gondolin` binary runs it as `gondolin daemon ...` or when
/// invoked as `gondolind`.
pub fn main_with_args(args: Vec<String>) {
    match args.first().map(String::as_str) {
        Some("--version") | Some("-V") => {
            println!("gondolind {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Some("assets") => {
            // image management (`gondolind assets ...`), shares the node engine's cache
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            let code = runtime.block_on(gondolin_assets::cli::run(&args[1..]));
            runtime.shutdown_background();
            std::process::exit(code);
        }
        Some("--mitm-ca") => {
            // load or create the MITM CA (default: node's cache dir) and print its certificate
            let dir =
                args.get(1).map(std::path::PathBuf::from).unwrap_or_else(mitm_ca::default_dir);
            match mitm_ca::load_or_create(&dir) {
                Ok(ca) => {
                    print!("{}", ca.cert_pem);
                    return;
                }
                Err(err) => {
                    eprintln!("gondolind: {err}");
                    std::process::exit(1);
                }
            }
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        Some("--vmm-watchdog") => {
            let pid = args.get(1).and_then(|p| p.parse::<i32>().ok()).unwrap_or(0);
            std::process::exit(if pid > 0 { vmm::run_watchdog(pid) } else { 2 });
        }
        Some("--qemu-args") => {
            // debugging/parity helper: print the QEMU argv for a configure payload (JSON on stdin)
            std::process::exit(print_qemu_args());
        }
        Some("--disk-info") => {
            // debugging/test helper: what `qemu-img info` reports, without qemu-img
            std::process::exit(match args.get(1) {
                Some(path) => print_disk_info(std::path::Path::new(path)),
                None => {
                    eprintln!("{USAGE}");
                    2
                }
            });
        }
        Some(other) => {
            eprintln!("gondolind: unknown argument {other}");
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
        None => {}
    }

    // report panics (they are contained where possible, see `panics.rs`)
    panics::install_hook();
    // SAFETY: ignoring SIGPIPE so writes to a closed pipe fail with EPIPE.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("gondolind")
        .build()
        .expect("tokio runtime");
    runtime.block_on(run());
    vmm::kill_current();
    // stdin may be read on a blocking thread that would keep the runtime alive
    runtime.shutdown_background();
    std::process::exit(0);
}

async fn run() {
    let ctl = Controller::new();
    let dispatcher = Dispatcher::default();
    let writer = tokio::spawn(ctl.clone().run_writer(stdio::writer()));

    send_hello(&ctl);

    dispatcher.register(mitm_ca::MITM_CA, std::sync::Arc::new(mitm_ca::MitmCaHandler));
    let (session, channels) = Session::new(ctl.clone(), dispatcher.clone(), HostInfo::detect());
    let (session_tx, session_rx) = tokio::sync::mpsc::channel(64);
    let reader = {
        let ctl = ctl.clone();
        let dispatcher = dispatcher.clone();
        tokio::spawn(async move {
            if let Err(err) = dispatcher.run_reader(stdio::reader(), ctl, session_tx).await {
                eprintln!("gondolind: controller input failed: {err}");
            }
        })
    };

    panics::set_sink(ctl.clone());
    // The session task is the single owner of session state: if it panics,
    // nothing it guarded can be trusted any more. Fail closed: kill the VMM,
    // report why, exit.
    let session_task = tokio::spawn(session.run(channels, session_rx));
    if let Err(err) = session_task.await {
        let reason = match err.try_into_panic() {
            Ok(payload) => {
                format!("session task panicked: {}", panics::payload_message(payload.as_ref()))
            }
            Err(err) => format!("session task failed: {err}"),
        };
        vmm::kill_current();
        let message = format!("gondolind internal error, VM stopped: {reason}");
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
        flush_controller(&ctl).await;
        ctl.close();
        let _ = writer.await;
        vmm::kill_current();
        std::process::exit(70);
    }
    reader.abort();
    flush_controller(&ctl).await;
    ctl.close();
    let _ = writer.await;
}

/// Queues the `hello` frame.
pub(crate) fn send_hello(ctl: &Controller) {
    ctl.send(
        HELLO,
        0,
        &Hello {
            protocol: PROTOCOL_VERSION,
            version: env!("CARGO_PKG_VERSION").to_string(),
            features: FEATURES
                .iter()
                .map(|f| f.to_string())
                .chain(panics::test_panics_enabled().then(|| "test_panics".to_string()))
                // tier-2 hooks (`configure.net.djs_hooks`)
                .chain(cfg!(feature = "djs-hooks").then(|| "djs_hooks".to_string()))
                .collect(),
            pid: std::process::id(),
        },
    );
}

/// Waits (bounded) until queued controller output was written.
async fn flush_controller(ctl: &Controller) {
    let flush = async {
        while ctl.queued_bytes() > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    };
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), flush).await;
}

/// `--disk-info`: `{ format, virtual_size, backing_file?, backing_format?,
/// full_backing_file? }` (the format is probed by magic).
fn print_disk_info(path: &std::path::Path) -> i32 {
    let info = match gondolin_qcow2::info(path) {
        Ok(info) => info,
        Err(err) => {
            eprintln!("gondolind: {err}");
            return 1;
        }
    };
    let mut out = gondolin_wire::value!({
        "format": info.format.name(),
        "virtual_size": info.virtual_size,
    });
    if let Some(b) = &info.backing_file {
        out["backing_file"] = gondolin_wire::Value::Text(b.clone());
        let full = gondolin_qcow2::resolve_backing(path, b);
        out["full_backing_file"] = gondolin_wire::Value::Text(full.display().to_string());
    }
    if let Some(f) = info.backing_format {
        out["backing_format"] = gondolin_wire::Value::Text(f);
    }
    println!("{}", gondolin_wire::json::to_string(&out));
    0
}

fn print_qemu_args() -> i32 {
    use std::io::Read;
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return 1;
    }
    let json = match gondolin_wire::json::parse(&input) {
        Ok(v) => v,
        Err(err) => {
            eprintln!("invalid JSON: {err}");
            return 1;
        }
    };
    let vm: gondolin_proto::session::VmConfig = match gondolin_wire::from_value(&json["vm"]) {
        Ok(v) => v,
        Err(err) => {
            eprintln!("invalid vm config: {err}");
            return 1;
        }
    };
    let s = |key: &str| json[key].as_text().map(str::to_string);
    let chardevs = qemu::ChardevPaths {
        control: s("control").unwrap_or_default().into(),
        fs: s("fs").unwrap_or_default().into(),
        ssh: s("ssh").unwrap_or_default().into(),
        ingress: s("ingress").unwrap_or_default().into(),
    };
    let append = s("append").unwrap_or_else(|| qemu::base_append(&vm, &HostInfo::detect()));
    let net = s("net_socket");
    let qmp = s("qmp_socket");
    let host = HostInfo::detect();
    let args = qemu::build_qemu_args(&qemu::QemuArgs {
        vm: &vm,
        append: &append,
        chardevs: &chardevs,
        net_socket: net.as_deref(),
        qmp_socket: qmp.as_deref(),
        virtiofs: None,
        host: &host,
    });
    println!("{}", gondolin_wire::json::to_string(&gondolin_wire::ToValue::to_value(&args)));
    0
}

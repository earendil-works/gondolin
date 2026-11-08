//! `gondolind assets ...` subcommands.
//!
//! ```text
//! gondolind assets resolve [SELECTOR] [--arch ARCH] [--offline] [--json]
//! gondolind assets pull SELECTOR [--arch ARCH] [--json]
//! gondolind assets list [--json]
//! ```
//!
//! `resolve` without a selector resolves the default guest image. Progress
//! goes to stderr; results to stdout.

use std::io::{IsTerminal, Write};

use gondolin_wire::ToValue;

use crate::{Arch, Assets, ProgressEvent, ResolvedImage};

const USAGE: &str = "usage:
  gondolind assets resolve [SELECTOR] [--arch ARCH] [--offline] [--json]
  gondolind assets pull SELECTOR [--arch ARCH] [--json]
  gondolind assets list [--json]";

struct Args {
    command: String,
    selector: Option<String>,
    arch: Option<Arch>,
    offline: bool,
    json: bool,
}

fn parse(args: &[String]) -> Result<Args, String> {
    let mut it = args.iter();
    let command = it.next().ok_or("missing subcommand")?.clone();
    let mut out = Args { command, selector: None, arch: None, offline: false, json: false };
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => out.json = true,
            "--offline" => out.offline = true,
            "--arch" => {
                let v = it.next().ok_or("--arch needs a value")?;
                out.arch = Some(Arch::normalize(v).ok_or_else(|| format!("invalid arch: {v}"))?);
            }
            "-h" | "--help" => return Err(String::new()),
            s if s.starts_with("--") => return Err(format!("unknown option: {s}")),
            s if out.selector.is_none() => out.selector = Some(s.to_string()),
            s => return Err(format!("unexpected argument: {s}")),
        }
    }
    Ok(out)
}

fn human_bytes(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < units.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 { format!("{n}B") } else { format!("{v:.1}{}", units[u]) }
}

fn progress_printer() -> impl Fn(ProgressEvent) + Send + Sync {
    let tty = std::io::stderr().is_terminal();
    move |event| {
        let mut err = std::io::stderr();
        let _ = match event {
            ProgressEvent::FetchRegistry { url } => writeln!(err, "fetching image registry {url}"),
            ProgressEvent::DownloadStart { label, total, .. } => match total {
                Some(t) => writeln!(err, "downloading {label} ({})", human_bytes(t)),
                None => writeln!(err, "downloading {label}"),
            },
            ProgressEvent::DownloadProgress { label, downloaded, total } if tty => {
                let total = total.map(|t| format!("/{}", human_bytes(t))).unwrap_or_default();
                write!(err, "\r\x1b[2K  {label} {}{total}", human_bytes(downloaded))
            }
            ProgressEvent::DownloadProgress { .. } => Ok(()),
            ProgressEvent::DownloadDone { label, bytes, elapsed_ms } => {
                let prefix = if tty { "\r\x1b[2K" } else { "" };
                writeln!(
                    err,
                    "{prefix}downloaded {label} {} in {:.1}s",
                    human_bytes(bytes),
                    elapsed_ms as f64 / 1000.0
                )
            }
            ProgressEvent::Verifying { label } => writeln!(err, "verifying {label}"),
            ProgressEvent::Installed { build_id, created } => {
                writeln!(
                    err,
                    "{} {build_id}",
                    if created { "installed" } else { "already installed" }
                )
            }
            ProgressEvent::WaitingForLock { build_id } => {
                writeln!(err, "waiting for another download of {build_id}")
            }
        };
    }
}

fn print_image(image: &ResolvedImage, json: bool) {
    if json {
        println!("{}", gondolin_wire::json::to_string_pretty(&image.to_value()));
        return;
    }
    println!("selector: {}", image.selector);
    println!("source:   {}", image.source.as_str());
    if let Some(id) = &image.build_id {
        println!("build id: {id}");
    }
    if let Some(arch) = image.arch {
        println!("arch:     {arch}");
    }
    println!("dir:      {}", image.asset_dir.display());
    println!("kernel:   {}", image.kernel.display());
    println!("initrd:   {}", image.initrd.display());
    println!("rootfs:   {}", image.rootfs.display());
    if let Some(mode) = image.rootfs_mode {
        println!("rootfs mode: {}", mode.as_str());
    }
}

/// Runs `gondolind assets <args>`; returns the process exit code.
pub async fn run(args: &[String]) -> i32 {
    let args = match parse(args) {
        Ok(a) => a,
        Err(msg) => {
            if !msg.is_empty() {
                eprintln!("gondolind assets: {msg}");
            }
            eprintln!("{USAGE}");
            return 2;
        }
    };
    let assets = Assets::from_env();
    let progress = progress_printer();
    let result = match args.command.as_str() {
        "resolve" => match (&args.selector, args.offline) {
            (Some(s), true) => assets.resolve_local(s, args.arch),
            (Some(s), false) => assets.resolve(s, args.arch, Some(&progress)).await,
            (None, true) => assets.resolve_default_local().and_then(|r| {
                r.ok_or_else(|| {
                    crate::AssetsError::invalid("default guest image is not available locally")
                })
            }),
            (None, false) => assets.resolve_default(Some(&progress)).await,
        },
        "pull" => match &args.selector {
            Some(s) => assets.pull(s, args.arch, Some(&progress)).await,
            None => {
                eprintln!("{USAGE}");
                return 2;
            }
        },
        "list" => {
            let refs = assets.store().list_refs();
            if args.json {
                println!("{}", gondolin_wire::json::to_string_pretty(&refs.to_value()));
            } else {
                for r in refs {
                    let targets: Vec<String> =
                        r.targets.iter().map(|(a, id)| format!("{a}={id}")).collect();
                    println!("{} {}", r.reference, targets.join(" "));
                }
            }
            return 0;
        }
        other => {
            eprintln!("gondolind assets: unknown subcommand {other}\n{USAGE}");
            return 2;
        }
    };
    match result {
        Ok(image) => {
            print_image(&image, args.json);
            0
        }
        Err(err) => {
            eprintln!("gondolind assets: {err}");
            1
        }
    }
}

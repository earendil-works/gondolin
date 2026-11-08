//! Command dispatch.

use crate::args::ParseError;

pub mod attach;
pub mod bash;
pub mod exec;
pub mod image;
pub mod list;
pub mod snapshot;
pub mod tty;
pub mod usage;

/// Prints a parse error (and usage); returns the exit code.
pub fn parse_failure(err: ParseError, usage: &str) -> i32 {
    match err {
        ParseError::Help => {
            println!("{usage}");
            0
        }
        ParseError::Usage(msg) => {
            if !msg.is_empty() {
                eprintln!("{msg}");
            }
            println!("{usage}");
            1
        }
        ParseError::Message(msg) => {
            eprintln!("{msg}");
            1
        }
    }
}

/// `renderCliError`
pub fn render_error(err: &str) {
    eprintln!("Error: {err}");
}

/// Host environment lookup for parsers.
pub fn host_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// Strips the Node CLI's engine flags (only `native` exists here).
fn engine_flags(args: &mut Vec<String>) -> Result<(), String> {
    while let Some(first) = args.first().cloned() {
        let (flag, inline) = match first.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (first.clone(), None),
        };
        match flag.as_str() {
            "--engine" => {
                let value = match inline {
                    Some(v) => v,
                    None => {
                        if args.len() < 2 {
                            return Err("--engine requires a value".into());
                        }
                        args.remove(1)
                    }
                };
                if value == "node" {
                    return Err("--engine node: the node engine has been removed; Gondolin always uses the native engine".into());
                }
                if !matches!(value.as_str(), "native" | "auto") {
                    return Err(format!("invalid --engine: {value} (expected native or auto)"));
                }
                args.remove(0);
            }
            "--native-command" | "--remote" => {
                return Err(format!("{flag} needs the Node CLI (npx @earendil-works/gondolin)"));
            }
            _ => break,
        }
    }
    Ok(())
}

/// Runs a command; returns the exit code.
pub async fn run(mut args: Vec<String>) -> i32 {
    if let Err(e) = engine_flags(&mut args) {
        eprintln!("{e}");
        return 1;
    }
    let Some(command) = args.first().cloned() else {
        println!("{}", usage::MAIN);
        return 1;
    };
    let rest = args[1..].to_vec();
    match command.as_str() {
        "exec" => exec::run(rest).await,
        "bash" => bash::run(rest).await,
        "list" => list::run(rest).await,
        "attach" => attach::run(rest).await,
        "snapshot" => snapshot::run(rest).await,
        "image" => image::run(rest).await,
        "help" | "--help" | "-h" => {
            println!("{}", usage::MAIN);
            0
        }
        "--version" | "-V" | "version" => {
            println!("gondolin {} (static)", env!("CARGO_PKG_VERSION"));
            0
        }
        "build" | "tools" => {
            eprintln!(
                "gondolin {command} needs the Node CLI: npx @earendil-works/gondolin {command}"
            );
            2
        }
        other => {
            eprintln!("Unknown command: {other}");
            println!("{}", usage::MAIN);
            1
        }
    }
}

/// Resolves when the process gets SIGINT, SIGTERM or SIGHUP.
pub async fn termination() -> i32 {
    let mut rx = crate::signals::subscribe(&[libc::SIGTERM, libc::SIGHUP, libc::SIGINT]);
    // the shell's convention: 128 + signal number
    128 + rx.recv().await
}

//! `gondolin exec`: VM mode (in-process VM) and socket mode (a running
//! session's IPC socket).

use std::io::Write;

use super::{host_env, parse_failure, render_error, usage};
use crate::args::{ExecArgs, parse_exec};
use crate::configure;
use crate::registry::{IpcClient, ServerMessage, next_message, resolve_socket};
use crate::session::{Session, label};
use crate::vm::{ExecEvent, ExecRequest};

/// `EXEC_OUTPUT_WINDOW_BYTES`
const SOCKET_WINDOW_BYTES: u32 = 1024 * 1024;

pub async fn run(argv: Vec<String>) -> i32 {
    let args = match parse_exec(&argv, &host_env) {
        Ok(a) => a,
        Err(e) => return parse_failure(e, &usage::exec()),
    };
    if args.commands.is_empty() && !args.common.print_configure {
        println!("{}", usage::exec());
        return 1;
    }
    if let Some(sock) = &args.sock {
        return match resolve_socket(sock).await {
            Ok(path) => run_socket(&args, &path).await,
            Err(e) => {
                render_error(&e);
                1
            }
        };
    }
    run_vm(&args).await
}

/// Prints the configure payload (`--print-configure`).
pub async fn print_configure(prepared: Result<configure::Prepared, String>) -> i32 {
    match prepared {
        Ok(p) => {
            let out = gondolin_wire::json::to_string_pretty(&configure::printable(&p));
            println!("{out}");
            0
        }
        Err(e) => {
            render_error(&e);
            1
        }
    }
}

async fn run_vm(args: &ExecArgs) -> i32 {
    let prepared = configure::prepare(&args.common, None).await;
    if args.common.print_configure {
        return print_configure(prepared).await;
    }
    let prepared = match prepared {
        Ok(p) => p,
        Err(e) => {
            render_error(&e);
            return 1;
        }
    };
    let session = match Session::start(prepared, label()).await {
        Ok(s) => s,
        Err(e) => {
            render_error(&e);
            return 1;
        }
    };
    let run = async {
        let mut exit_code = 0;
        for command in &args.commands {
            let mut proc = session
                .vm
                .exec(ExecRequest {
                    cmd: command.cmd.clone(),
                    argv: command.argv.clone(),
                    env: command.env.clone(),
                    cwd: command.cwd.clone(),
                    ..Default::default()
                })
                .await;
            let (code, signal) = loop {
                match proc.next().await {
                    Some(ExecEvent::Output { stdout, data }) => {
                        let n = data.len() as u32;
                        if stdout {
                            let mut out = std::io::stdout().lock();
                            let _ = out.write_all(&data).and_then(|_| out.flush());
                            proc.grant(n, 0).await;
                        } else {
                            let mut err = std::io::stderr().lock();
                            let _ = err.write_all(&data);
                            proc.grant(0, n).await;
                        }
                    }
                    Some(ExecEvent::Exit { exit_code, signal }) => break (exit_code, signal),
                    Some(ExecEvent::Error { message, .. }) => return Err(message),
                    Some(ExecEvent::StdinAck(_)) => {}
                    None => return Err("exec ended without a result".to_string()),
                }
            };
            if let Some(sig) = signal {
                eprintln!("process exited due to signal {sig}");
            }
            if code != 0 && exit_code == 0 {
                exit_code = code;
            }
        }
        Ok(exit_code)
    };
    let snapshotting = &session;
    let main = async {
        match run.await {
            Ok(code) => code,
            Err(e) => {
                if !snapshotting.is_snapshotting() {
                    render_error(&e);
                }
                1
            }
        }
    };
    let code = session.run(main).await.unwrap_or(0);
    session.close().await;
    code
}

async fn run_socket(args: &ExecArgs, path: &str) -> i32 {
    let mut client = match IpcClient::connect(path).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("socket error: {e}");
            return 1;
        }
    };
    let mut exit_code = 0;
    for command in &args.commands {
        let mut msg =
            gondolin_wire::value!({ "type": "exec", "id": command.id, "cmd": command.cmd });
        if !command.argv.is_empty() {
            msg["argv"] = gondolin_wire::value!(command.argv);
        }
        if !command.env.is_empty() {
            msg["env"] = gondolin_wire::value!(command.env);
        }
        if let Some(cwd) = &command.cwd {
            msg["cwd"] = gondolin_wire::value!(cwd);
        }
        msg["stdout_window"] = SOCKET_WINDOW_BYTES.into();
        msg["stderr_window"] = SOCKET_WINDOW_BYTES.into();
        if let Err(e) = client.send(&msg).await {
            eprintln!("socket error: {e}");
            return 1;
        }
        loop {
            match next_message(&mut client.reader).await {
                Ok(Some(ServerMessage::Output { id, stdout, data })) if id == command.id => {
                    let key = if stdout { "stdout" } else { "stderr" };
                    if stdout {
                        let mut out = std::io::stdout().lock();
                        let _ = out.write_all(&data).and_then(|_| out.flush());
                    } else {
                        let _ = std::io::stderr().lock().write_all(&data);
                    }
                    let _ = client
                        .send(&gondolin_wire::value!({ "type": "exec_window", "id": id, (key): data.len() }))
                        .await;
                }
                Ok(Some(ServerMessage::Output { .. })) => {}
                Ok(Some(ServerMessage::Json(v))) => match v["type"].as_str() {
                    Some("exec_response") if v["id"].as_u64() == Some(command.id.into()) => {
                        if let Some(sig) = v.get("signal").filter(|s| !s.is_null()) {
                            eprintln!("process exited due to signal {sig}");
                        }
                        let code = v["exit_code"].as_i64().unwrap_or(1) as i32;
                        if code != 0 && exit_code == 0 {
                            exit_code = code;
                        }
                        break;
                    }
                    Some("error") => {
                        if v.get("id").is_some_and(|id| id.as_u64() != Some(command.id.into())) {
                            continue;
                        }
                        eprintln!(
                            "error {}: {}",
                            v["code"].as_str().unwrap_or(""),
                            v["message"].as_str().unwrap_or("")
                        );
                        return if exit_code == 0 { 1 } else { exit_code };
                    }
                    _ => {}
                },
                Ok(None) => {
                    eprintln!("session connection closed before the command finished");
                    return if exit_code == 0 { 1 } else { exit_code };
                }
                Err(e) => {
                    eprintln!("socket error: {e}");
                    return if exit_code == 0 { 1 } else { exit_code };
                }
            }
        }
    }
    exit_code
}

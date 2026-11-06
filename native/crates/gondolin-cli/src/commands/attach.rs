//! `gondolin attach`: an interactive command in a running session (over
//! its IPC socket, so sessions of either CLI work).

use std::io::Write;

use base64::Engine as _;
use serde_json::json;

use super::tty::{self, Input, RawMode};
use super::{parse_failure, render_error, usage};
use crate::args::parse_attach;
use crate::registry::{self, IpcClient, ServerMessage, next_message};

const REQUEST_ID: u32 = 1;
/// stdin chunk size in `bytes` (the server's per-message limit)
const STDIN_CHUNK: usize = 48 * 1024;

pub async fn run(argv: Vec<String>) -> i32 {
    let args = match parse_attach(&argv) {
        Ok(a) => a,
        Err(e) => return parse_failure(e, usage::ATTACH),
    };
    registry::gc().await;
    let session = match registry::find(&args.session).await {
        Ok(Some(s)) if s.alive => s,
        Ok(_) => {
            render_error(&format!("session not found or not running: {}", args.session));
            return 1;
        }
        Err(e) => {
            render_error(&e);
            return 1;
        }
    };
    let command = args.command.clone().unwrap_or_else(tty::default_shell);
    if command.is_empty() {
        render_error("attach command must not be empty");
        return 1;
    }
    let IpcClient { mut writer, mut reader } =
        match IpcClient::connect(&session.info.socket_path).await {
            Ok(c) => c,
            Err(e) => {
                render_error(&e);
                return 1;
            }
        };
    let mut exec = json!({
        "type": "exec",
        "id": REQUEST_ID,
        "cmd": command[0],
        "argv": command[1..],
        "stdin": true,
        "pty": true,
        "stdout_window": 1024 * 1024,
        "stderr_window": 1024 * 1024,
    });
    if !args.env.is_empty() {
        exec["env"] = json!(args.env);
    }
    if let Some(cwd) = &args.cwd {
        exec["cwd"] = json!(cwd);
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    let writer_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if registry::write_client_frame(&mut writer, &msg).await.is_err() {
                break;
            }
        }
    });
    let _ = tx.send(exec);
    let mut raw = RawMode::enable();
    if let Some((rows, cols)) = tty::window_size() {
        let _ =
            tx.send(json!({ "type": "pty_resize", "id": REQUEST_ID, "rows": rows, "cols": cols }));
    }
    let mut winch =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change()).ok();
    let mut input = tty::stdin_reader();
    let mut input_open = true;
    let code = loop {
        tokio::select! {
            msg = next_message(&mut reader) => match msg {
                Ok(Some(ServerMessage::Output { id, stdout, data })) if id == REQUEST_ID => {
                    if stdout {
                        let mut out = std::io::stdout().lock();
                        let _ = out.write_all(&data).and_then(|_| out.flush());
                    } else {
                        let mut err = std::io::stderr().lock();
                        let _ = err.write_all(&data).and_then(|_| err.flush());
                    }
                    let key = if stdout { "stdout" } else { "stderr" };
                    let _ = tx.send(json!({ "type": "exec_window", "id": REQUEST_ID, key: data.len() }));
                }
                Ok(Some(ServerMessage::Output { .. })) => {}
                Ok(Some(ServerMessage::Json(v))) => match v["type"].as_str() {
                    Some("exec_response") if v["id"].as_u64() == Some(REQUEST_ID.into()) => {
                        raw.restore();
                        if let Some(sig) = v.get("signal").filter(|s| !s.is_null()) {
                            eprintln!("process exited due to signal {sig}");
                        }
                        break v["exit_code"].as_i64().unwrap_or(1) as i32;
                    }
                    Some("error") => {
                        let id = v.get("id").and_then(|i| i.as_u64());
                        if id.is_some_and(|i| i != u64::from(REQUEST_ID)) {
                            continue;
                        }
                        let code = v["code"].as_str().unwrap_or("");
                        if id.is_some() && matches!(code, "stdin_backpressure" | "stdin_chunk_too_large") {
                            continue;
                        }
                        raw.restore();
                        render_error(&format!("error {code}: {}", v["message"].as_str().unwrap_or("")));
                        break 1;
                    }
                    _ => {}
                },
                Ok(None) | Err(_) => {
                    raw.restore();
                    render_error("session connection closed");
                    break 1;
                }
            },
            item = input.recv(), if input_open => match item {
                Some(Input::Data(data)) => {
                    for chunk in data.chunks(STDIN_CHUNK) {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(chunk);
                        let _ = tx.send(json!({ "type": "stdin", "id": REQUEST_ID, "data": b64 }));
                    }
                }
                Some(Input::Escape) => {
                    raw.restore();
                    eprintln!("\n[gondolin] detached (Ctrl-])");
                    break 130;
                }
                Some(Input::Eof) | None => {
                    input_open = false;
                    let _ = tx.send(json!({ "type": "stdin", "id": REQUEST_ID, "eof": true }));
                }
            },
            _ = async { match winch.as_mut() { Some(w) => { w.recv().await; } None => std::future::pending().await } } => {
                if let Some((rows, cols)) = tty::window_size() {
                    let _ = tx.send(json!({ "type": "pty_resize", "id": REQUEST_ID, "rows": rows, "cols": cols }));
                }
            }
        }
    };
    drop(tx);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), writer_task).await;
    code
}

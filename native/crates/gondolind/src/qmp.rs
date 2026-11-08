//! Minimal QMP client for the idle pause: one connection per command, a 2 s
//! timeout, and enough error detail to tell whether the command may have run.

use std::path::Path;
use std::time::Duration;

use gondolin_wire::Value as Json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

pub const QMP_COMMAND_TIMEOUT: Duration = Duration::from_millis(2000);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QmpErrorReason {
    Timeout,
    Closed,
    SocketError,
    QmpError,
    InvalidResponse,
}

#[derive(Debug, Clone)]
pub struct QmpError {
    pub reason: QmpErrorReason,
    pub message: String,
    /// whether the command itself was sent (its outcome may be unknown)
    pub command_sent: bool,
}

impl std::fmt::Display for QmpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for QmpError {}

impl QmpError {
    /// `isUnknownQmpOutcome`: the command was sent but no definite answer came.
    pub fn unknown_outcome(&self) -> bool {
        self.command_sent && self.reason != QmpErrorReason::QmpError
    }
}

/// Runs one QMP command and returns its `return` value.
pub async fn execute(socket: &Path, command: &str) -> Result<Json, QmpError> {
    let mut sent = false;
    let res = tokio::time::timeout(QMP_COMMAND_TIMEOUT, run(socket, command, &mut sent)).await;
    match res {
        Ok(r) => r,
        Err(_) => Err(QmpError {
            reason: QmpErrorReason::Timeout,
            message: format!("qmp {command} timed out"),
            command_sent: sent,
        }),
    }
}

async fn run(socket: &Path, command: &str, sent: &mut bool) -> Result<Json, QmpError> {
    let err =
        |reason, message: String, sent: bool| QmpError { reason, message, command_sent: sent };
    let stream = UnixStream::connect(socket)
        .await
        .map_err(|e| err(QmpErrorReason::SocketError, e.to_string(), false))?;
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    #[derive(PartialEq)]
    enum Stage {
        Greeting,
        Capabilities,
        Command,
    }
    let mut stage = Stage::Greeting;
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => {
                return Err(err(
                    QmpErrorReason::Closed,
                    format!("qmp {command} connection closed"),
                    *sent,
                ));
            }
            Err(e) => return Err(err(QmpErrorReason::SocketError, e.to_string(), *sent)),
        };
        let raw = line.trim();
        if raw.is_empty() {
            continue;
        }
        let message: Json = gondolin_wire::json::parse(raw).map_err(|_| {
            err(
                QmpErrorReason::InvalidResponse,
                format!("invalid qmp response for {command}"),
                *sent,
            )
        })?;
        if let Some(error) = message.get("error") {
            let desc = error.get("desc").and_then(Json::as_text).unwrap_or("unknown qmp error");
            let text = match error.get("class").and_then(Json::as_text) {
                Some(class) => format!("qmp {command} failed ({class}): {desc}"),
                None => format!("qmp {command} failed: {desc}"),
            };
            return Err(err(QmpErrorReason::QmpError, text, *sent));
        }
        match stage {
            Stage::Greeting => {
                if message.get("QMP").is_none() {
                    continue;
                }
                stage = Stage::Capabilities;
                send(&mut write, "qmp_capabilities")
                    .await
                    .map_err(|e| err(QmpErrorReason::SocketError, e.to_string(), *sent))?;
            }
            Stage::Capabilities => {
                if message.get("return").is_none() {
                    continue;
                }
                stage = Stage::Command;
                *sent = true;
                send(&mut write, command)
                    .await
                    .map_err(|e| err(QmpErrorReason::SocketError, e.to_string(), *sent))?;
            }
            Stage::Command => {
                if let Some(ret) = message.get("return") {
                    return Ok(ret.clone());
                }
            }
        }
    }
}

/// Interprets a `query-status` result: `Some(true)` running, `Some(false)` paused.
pub fn running_from_status(result: &Json) -> Option<bool> {
    if let Some(running) = result.get("running").and_then(Json::as_bool) {
        return Some(running);
    }
    match result.get("status").and_then(Json::as_text) {
        Some("running") => Some(true),
        Some("paused") => Some(false),
        _ => None,
    }
}

async fn send(write: &mut tokio::net::unix::OwnedWriteHalf, cmd: &str) -> std::io::Result<()> {
    let line = format!("{}\r\n", gondolin_wire::value!({ "execute": cmd }));
    write.write_all(line.as_bytes()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn command_round_trip() {
        crate::test_timeout(async {
            let dir = std::env::temp_dir().join(format!("gondolind-qmp-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("qmp.sock");
            let _ = std::fs::remove_file(&path);
            let listener = UnixListener::bind(&path).unwrap();
            let server = tokio::spawn(async move {
                for answer in [
                    r#"{"return": {"running": false, "status": "paused"}}"#,
                    r#"{"error": {"class": "GenericError", "desc": "nope"}}"#,
                ] {
                    let (s, _) = listener.accept().await.unwrap();
                    let (r, mut w) = s.into_split();
                    let mut lines = BufReader::new(r).lines();
                    w.write_all(b"{\"QMP\": {}}\r\n").await.unwrap();
                    let l = lines.next_line().await.unwrap().unwrap();
                    assert!(l.contains("qmp_capabilities"));
                    w.write_all(b"{\"return\": {}}\r\n{\"event\": \"X\"}\r\n").await.unwrap();
                    let l = lines.next_line().await.unwrap().unwrap();
                    assert!(l.contains("query-status") || l.contains("stop"));
                    w.write_all(answer.as_bytes()).await.unwrap();
                    w.write_all(b"\r\n").await.unwrap();
                }
            });
            let ret = execute(&path, "query-status").await.unwrap();
            assert_eq!(running_from_status(&ret), Some(false));
            let e = execute(&path, "stop").await.unwrap_err();
            assert_eq!(e.reason, QmpErrorReason::QmpError);
            assert_eq!(e.message, "qmp stop failed (GenericError): nope");
            assert!(!e.unknown_outcome());
            server.await.unwrap();
            let e = execute(&dir.join("missing.sock"), "cont").await.unwrap_err();
            assert_eq!(e.reason, QmpErrorReason::SocketError);
            let _ = std::fs::remove_dir_all(&dir);
        })
        .await;
    }
}

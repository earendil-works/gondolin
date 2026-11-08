//! `gondolin snapshot`: checkpoint a running session (either CLI's) and stop it.

use std::time::Duration;

use super::{parse_failure, render_error, usage};
use crate::args::parse_snapshot;
use crate::checkpoint;
use crate::registry::{self, IpcClient, ServerMessage, next_message};

const REQUEST_ID: u32 = 1;

pub async fn run(argv: Vec<String>) -> i32 {
    let args = match parse_snapshot(&argv) {
        Ok(a) => a,
        Err(e) => return parse_failure(e, usage::SNAPSHOT),
    };
    match snapshot(&args).await {
        Ok(()) => 0,
        Err(e) => {
            render_error(&e);
            1
        }
    }
}

async fn snapshot(args: &crate::args::SnapshotArgs) -> Result<(), String> {
    registry::gc().await;
    let session = match registry::find(&args.session).await? {
        Some(s) if s.alive => s,
        _ => return Err(format!("session not found or not running: {}", args.session)),
    };
    let path = checkpoint::snapshot_path(args.output.as_deref(), args.name.as_deref())?;
    let path_str = path.display().to_string();
    let mut client = IpcClient::connect(&session.info.socket_path).await?;
    client
        .send(&gondolin_wire::value!({ "type": "snapshot", "id": REQUEST_ID, "path": path_str }))
        .await?;
    let result_path = loop {
        match next_message(&mut client.reader).await {
            Ok(Some(ServerMessage::Json(v))) => match v["type"].as_str() {
                Some("snapshot_response") if v["id"].as_u64() == Some(REQUEST_ID.into()) => {
                    break v["path"].as_str().unwrap_or(&path_str).to_string();
                }
                Some("error") => {
                    if v.get("id")
                        .and_then(|i| i.as_u64())
                        .is_some_and(|i| i != u64::from(REQUEST_ID))
                    {
                        continue;
                    }
                    return Err(format!(
                        "error {}: {}",
                        v["code"].as_str().unwrap_or(""),
                        v["message"].as_str().unwrap_or("")
                    ));
                }
                _ => {}
            },
            Ok(Some(ServerMessage::Output { .. })) => {}
            Ok(None) | Err(_) => {
                // the session may close before the response arrives
                if wait_ready(&path).await {
                    break path_str.clone();
                }
                return Err("session connection closed".into());
            }
        }
    };
    let result = std::path::PathBuf::from(&result_path);
    let id = result.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let default_dir = std::path::absolute(checkpoint::base_dir()).unwrap_or_default();
    let resume_arg = if result.parent() == Some(default_dir.as_path()) {
        id.clone()
    } else {
        result_path.clone()
    };
    println!("Snapshot created:");
    println!("  ID: {id}");
    println!("  PATH: {result_path}");
    println!("Resume with:");
    println!("  gondolin bash --resume {resume_arg}");
    Ok(())
}

/// `waitForCheckpointReady`
async fn wait_ready(path: &std::path::Path) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if path.exists() && checkpoint::read_trailer(path).is_ok() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

//! The session registry shared with the Node CLI
//! (`host/src/session-registry.ts`): `<sessions>/<uuid>.json` metadata plus a
//! `<uuid>.sock` IPC socket.
//!
//! IPC framing: client → server `u32be length + JSON ClientMessage`; server →
//! client `u8 type + u32be length + payload` with type 0 = JSON
//! `ServerMessage`, type 1 = an output frame `[u8 stream (1 stdout, 2
//! stderr)][u32be id][data]`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gondolin_wire::Value as Json;
use gondolin_wire::{FromValue, ToValue};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

use crate::engine::{ClientEvent, Engine};

gondolin_wire::wire_struct! {
    /// Persisted session metadata (`SessionInfo`).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct SessionInfo {
        pub id: String,
        pub pid: i64,
        pub socket_path: String as "socketPath",
        pub created_at: String as "createdAt",
        pub label: Option<String>,
    }
}

/// A discovered session (`SessionEntry`).
#[derive(Debug, Clone)]
pub struct SessionEntry {
    pub info: SessionInfo,
    pub alive: bool,
}

/// `GONDOLIN_SESSIONS_DIR`, else `<cache>/gondolin/sessions`.
pub fn sessions_dir() -> PathBuf {
    std::env::var_os("GONDOLIN_SESSIONS_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| gondolin_assets::store::gondolin_cache_dir().join("sessions"))
}

fn ensure_dir() -> PathBuf {
    let dir = sessions_dir();
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn pid_alive(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    // SAFETY: signal 0 only checks for existence/permission.
    pid > 0 && unsafe { libc::kill(pid, 0) } == 0
}

async fn socket_alive(path: &str) -> bool {
    if !Path::new(path).exists() {
        return false;
    }
    matches!(
        tokio::time::timeout(Duration::from_millis(500), UnixStream::connect(path)).await,
        Ok(Ok(_))
    )
}

/// Registers a live session (`registerSession`).
pub fn register(id: &str, label: Option<String>) -> Result<SessionInfo, String> {
    let dir = ensure_dir();
    let info = SessionInfo {
        id: id.into(),
        pid: std::process::id() as i64,
        socket_path: dir.join(format!("{id}.sock")).display().to_string(),
        created_at: crate::checkpoint::iso_now(),
        label,
    };
    let mut json = gondolin_wire::json::to_string_pretty(&info.to_value());
    json.push('\n');
    std::fs::write(dir.join(format!("{id}.json")), json)
        .map_err(|e| format!("cannot register session: {e}"))?;
    Ok(info)
}

/// Removes a session's files (`unregisterSession`).
pub fn unregister(id: &str) {
    let dir = sessions_dir();
    let _ = std::fs::remove_file(dir.join(format!("{id}.json")));
    let _ = std::fs::remove_file(dir.join(format!("{id}.sock")));
}

fn read_infos() -> Vec<(String, Option<SessionInfo>)> {
    let dir = ensure_dir();
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".json") else { continue };
        let info = std::fs::read_to_string(e.path())
            .ok()
            .and_then(|s| gondolin_wire::json::parse(&s).ok())
            .and_then(|v| SessionInfo::from_value(&v).ok())
            .filter(|i| !i.id.is_empty() && !i.socket_path.is_empty());
        out.push((stem.to_string(), info));
    }
    out
}

/// Known sessions, newest first (`listSessions`).
pub async fn list() -> Vec<SessionEntry> {
    let mut out = Vec::new();
    for (_, info) in read_infos() {
        let Some(info) = info else { continue };
        let alive = pid_alive(info.pid) && socket_alive(&info.socket_path).await;
        out.push(SessionEntry { info, alive });
    }
    out.sort_by_key(|e| {
        std::cmp::Reverse(crate::checkpoint::parse_iso_millis(&e.info.created_at).unwrap_or(0))
    });
    out
}

/// Removes stale sessions and orphan sockets (`gcSessions`).
pub async fn gc() -> usize {
    let dir = ensure_dir();
    let mut stale: HashSet<String> = HashSet::new();
    let mut known: HashSet<String> = HashSet::new();
    for (stem, info) in read_infos() {
        let Some(info) = info else {
            stale.insert(stem);
            continue;
        };
        known.insert(info.id.clone());
        if !pid_alive(info.pid) || !socket_alive(&info.socket_path).await {
            stale.insert(info.id);
        }
    }
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(id) = name.strip_suffix(".sock")
                && !known.contains(id)
            {
                stale.insert(id.to_string());
            }
        }
    }
    for id in &stale {
        unregister(id);
    }
    stale.len()
}

/// Finds a session by id or unique prefix (`findSession`).
pub async fn find(query: &str) -> Result<Option<SessionEntry>, String> {
    let sessions = list().await;
    let needle = query.to_lowercase();
    if let Some(e) = sessions.iter().find(|s| s.info.id == needle) {
        return Ok(Some(e.clone()));
    }
    let matches: Vec<&SessionEntry> =
        sessions.iter().filter(|s| s.info.id.starts_with(&needle)).collect();
    match matches.len() {
        0 => Ok(None),
        1 => Ok(Some(matches[0].clone())),
        n => Err(format!(
            "ambiguous session prefix '{query}' matches {n} sessions:\n{}",
            matches.iter().map(|s| format!("  {}", s.info.id)).collect::<Vec<_>>().join("\n")
        )),
    }
}

// ---------------------------------------------------------------- framing

/// Writes a server frame (`sendFramed`).
pub async fn write_server_frame<W: AsyncWrite + Unpin>(
    w: &mut W,
    kind: u8,
    payload: &[u8],
) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(5 + payload.len());
    buf.push(kind);
    buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    buf.extend_from_slice(payload);
    w.write_all(&buf).await
}

/// Reads a server frame: `(type, payload)`; `None` at EOF.
pub async fn read_server_frame<R: AsyncRead + Unpin>(
    r: &mut R,
) -> std::io::Result<Option<(u8, Vec<u8>)>> {
    let mut head = [0u8; 5];
    match r.read_exact(&mut head).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(head[1..].try_into().unwrap()) as usize;
    if len > MAX_IPC_FRAME {
        return Err(std::io::Error::other("ipc frame too large"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    Ok(Some((head[0], buf)))
}

/// Largest IPC frame accepted in `bytes`
const MAX_IPC_FRAME: usize = 16 * 1024 * 1024;

/// Writes a client frame (`u32be length + JSON`).
pub async fn write_client_frame<W: AsyncWrite + Unpin>(
    w: &mut W,
    msg: &Json,
) -> std::io::Result<()> {
    let payload = gondolin_wire::json::to_string(msg).into_bytes();
    let mut buf = Vec::with_capacity(4 + payload.len());
    buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    buf.extend_from_slice(&payload);
    w.write_all(&buf).await
}

async fn read_client_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let mut head = [0u8; 4];
    match r.read_exact(&mut head).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(head) as usize;
    if len > MAX_IPC_FRAME {
        return Err(std::io::Error::other("ipc frame too large"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

/// `encodeOutputFrame`
pub fn output_frame(id: u32, stdout: bool, data: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(5 + data.len());
    f.push(if stdout { 1 } else { 2 });
    f.extend_from_slice(&id.to_be_bytes());
    f.extend_from_slice(data);
    f
}

/// `decodeOutputFrame`: `(id, stdout, data)`
pub fn parse_output_frame(f: &[u8]) -> Option<(u32, bool, &[u8])> {
    if f.len() < 5 {
        return None;
    }
    let stdout = match f[0] {
        1 => true,
        2 => false,
        _ => return None,
    };
    Some((u32::from_be_bytes(f[1..5].try_into().ok()?), stdout, &f[5..]))
}

// ---------------------------------------------------------------- server

/// Handles a `snapshot` IPC request: returns `(path, name)`; the session is
/// stopped afterwards by the owner.
pub type SnapshotFn = Arc<
    dyn Fn(String) -> futures_lite::BoxedFuture<Result<(String, String), String>> + Send + Sync,
>;

/// Shared id allocation of IPC clients.
struct Ids {
    /// internal exec ids in use (allocated from `0xffffffff` down)
    allocated: HashSet<u32>,
    next: u32,
}

const INTERNAL_ID_FLOOR: u32 = 0x8000_0000;

impl Ids {
    fn allocate(&mut self) -> Option<u32> {
        for _ in 0..=u32::MAX / 2 {
            if self.next < INTERNAL_ID_FLOOR {
                self.next = u32::MAX;
            }
            let candidate = self.next;
            self.next = self.next.wrapping_sub(1);
            if self.allocated.insert(candidate) {
                return Some(candidate);
            }
        }
        None
    }
}

/// The session IPC server (`SessionIpcServer`).
pub struct IpcServer {
    path: PathBuf,
    task: tokio::task::JoinHandle<()>,
}

/// What the IPC server needs from the VM.
pub struct IpcContext {
    pub engine: Arc<Engine>,
    /// allocates daemon client ids
    pub next_client: Arc<dyn Fn() -> u32 + Send + Sync>,
    pub snapshot: Option<SnapshotFn>,
    /// notified after a snapshot response was written (stop the session)
    pub snapshot_done: mpsc::UnboundedSender<()>,
}

impl IpcServer {
    /// Listens on `path` (replacing a stale socket).
    pub fn start(path: &Path, ctx: IpcContext) -> Result<IpcServer, String> {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path)
            .map_err(|e| format!("cannot listen on {}: {e}", path.display()))?;
        let ctx = Arc::new(ctx);
        let ids = Arc::new(Mutex::new(Ids { allocated: HashSet::new(), next: u32::MAX }));
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (ctx, ids) = (ctx.clone(), ids.clone());
                tokio::spawn(async move { serve_connection(stream, ctx, ids).await });
            }
        });
        Ok(IpcServer { path: path.to_path_buf(), task })
    }

    pub fn close(self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.path);
    }
}

fn error_json(code: &str, message: &str, id: Option<u32>) -> Json {
    let mut v = gondolin_wire::value!({ "type": "error", "code": code, "message": message });
    if let Some(id) = id {
        v["id"] = id.into();
    }
    v
}

/// external → internal and internal → external exec ids
type IdMap = (HashMap<u32, u32>, HashMap<u32, u32>);

async fn serve_connection(stream: UnixStream, ctx: Arc<IpcContext>, ids: Arc<Mutex<Ids>>) {
    let (mut rd, wr) = stream.into_split();
    // all writes go through one task (ordering)
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(u8, Vec<u8>, bool)>();
    let snapshot_done = ctx.snapshot_done.clone();
    let writer = tokio::spawn(async move {
        let mut wr = wr;
        while let Some((kind, payload, snapshot)) = out_rx.recv().await {
            if write_server_frame(&mut wr, kind, &payload).await.is_err() {
                if snapshot {
                    let _ = snapshot_done.send(());
                }
                break;
            }
            if snapshot {
                let _ = wr.flush().await;
                let _ = snapshot_done.send(());
            }
        }
    });
    let send_json = {
        let out = out_tx.clone();
        move |v: Json| {
            let _ = out.send((0, gondolin_wire::json::to_string(&v).into_bytes(), false));
        }
    };
    // external <-> internal exec ids
    let map: Arc<Mutex<IdMap>> = Arc::default();
    let mut client: Option<u32> = None;
    let mut pump: Option<tokio::task::JoinHandle<()>> = None;

    let release = |map: &Mutex<IdMap>, internal: u32| {
        let mut m = map.lock().unwrap();
        if let Some(ext) = m.1.remove(&internal) {
            m.0.remove(&ext);
        }
        ids.lock().unwrap().allocated.remove(&internal);
    };

    loop {
        let frame = match read_client_frame(&mut rd).await {
            Ok(Some(f)) => f,
            _ => break,
        };
        let Ok(msg) = std::str::from_utf8(&frame)
            .map_err(|_| ())
            .and_then(|t| gondolin_wire::json::parse(t).map_err(|_| ()))
        else {
            send_json(error_json("invalid_request", "invalid framed JSON message", None));
            continue;
        };
        let t = msg["type"].as_str().unwrap_or("");
        let ext_id = msg["id"].as_u64().and_then(|v| u32::try_from(v).ok());
        match t {
            "boot" => {}
            "exec" => {
                let Some(ext) = ext_id else {
                    send_json(error_json("invalid_request", "exec requires a uint32 id", None));
                    continue;
                };
                if map.lock().unwrap().0.contains_key(&ext) {
                    send_json(error_json("duplicate_id", "request id already in use", Some(ext)));
                    continue;
                }
                let Some(internal) = ids.lock().unwrap().allocate() else {
                    send_json(error_json(
                        "queue_full",
                        "no available internal request ids",
                        Some(ext),
                    ));
                    continue;
                };
                {
                    let mut m = map.lock().unwrap();
                    m.0.insert(ext, internal);
                    m.1.insert(internal, ext);
                }
                let c = match client {
                    Some(c) => c,
                    None => {
                        let c = (ctx.next_client)();
                        let mut events = ctx.engine.register_client(c);
                        ctx.engine
                            .send("client_open", &gondolin_proto::exec::ClientRef { client: c })
                            .await;
                        let (map2, ids2, out2) = (map.clone(), ids.clone(), out_tx.clone());
                        pump = Some(tokio::spawn(async move {
                            let send = |v: Json| {
                                let _ = out2.send((
                                    0,
                                    gondolin_wire::json::to_string(&v).into_bytes(),
                                    false,
                                ));
                            };
                            let release = |internal: u32| {
                                let mut m = map2.lock().unwrap();
                                if let Some(ext) = m.1.remove(&internal) {
                                    m.0.remove(&ext);
                                }
                                ids2.lock().unwrap().allocated.remove(&internal);
                            };
                            while let Some(ev) = events.recv().await {
                                let external = |id: u32| map2.lock().unwrap().1.get(&id).copied();
                                match ev {
                                    ClientEvent::Output { id, stdout, data } => {
                                        if let Some(ext) = external(id) {
                                            let _ = out2.send((
                                                1,
                                                output_frame(ext, stdout, &data),
                                                false,
                                            ));
                                        }
                                    }
                                    ClientEvent::Response { id, exit_code, signal } => {
                                        if let Some(ext) = external(id) {
                                            let mut v = gondolin_wire::value!({ "type": "exec_response", "id": ext, "exit_code": exit_code });
                                            if let Some(s) = signal {
                                                v["signal"] = s.into();
                                            }
                                            send(v);
                                            release(id);
                                        }
                                    }
                                    ClientEvent::StdinAck { id, bytes } => {
                                        if let Some(ext) = external(id) {
                                            send(
                                                gondolin_wire::value!({ "type": "stdin_ack", "id": ext, "bytes": bytes }),
                                            );
                                        }
                                    }
                                    ClientEvent::Error { id: Some(id), code, message } => {
                                        if let Some(ext) = external(id) {
                                            send(error_json(&code, &message, Some(ext)));
                                            if !matches!(
                                                code.as_str(),
                                                "stdin_backpressure" | "stdin_chunk_too_large"
                                            ) {
                                                release(id);
                                            }
                                        }
                                    }
                                    ClientEvent::Error { id: None, code, message } => {
                                        send(error_json(&code, &message, None));
                                    }
                                    ClientEvent::Status(state) => {
                                        send(
                                            gondolin_wire::value!({ "type": "status", "state": state }),
                                        );
                                    }
                                    ClientEvent::Closed => break,
                                }
                            }
                        }));
                        client = Some(c);
                        c
                    }
                };
                let mut payload = msg.clone();
                {
                    let obj = &mut payload;
                    obj.remove("type");
                    obj.insert("id", internal);
                    obj.insert("client", c);
                }
                ctx.engine.send("exec", &crate::configure::json_to_cbor(&payload)).await;
            }
            "stdin" | "pty_resize" | "exec_window" => {
                let internal = ext_id.and_then(|e| map.lock().unwrap().0.get(&e).copied());
                let (Some(internal), Some(c)) = (internal, client) else {
                    send_json(error_json("unknown_id", "request id not found", ext_id));
                    continue;
                };
                let mut payload = msg.clone();
                {
                    let obj = &mut payload;
                    obj.remove("type");
                    obj.insert("id", internal);
                    obj.insert("client", c);
                    // stdin data is base64 over IPC, bytes for the daemon
                    if t == "stdin"
                        && let Some(Json::Text(data)) = obj.get("data")
                    {
                        let bytes = gondolin_wire::base64::decode(data).unwrap_or_default();
                        obj.insert("data", crate::configure::b64(&bytes));
                    }
                }
                ctx.engine.send(t, &crate::configure::json_to_cbor(&payload)).await;
            }
            "snapshot" => {
                let Some(ext) = ext_id else {
                    send_json(error_json("invalid_request", "snapshot requires a uint32 id", None));
                    continue;
                };
                let Some(path) = msg["path"].as_str().filter(|p| !p.is_empty()).map(str::to_string)
                else {
                    send_json(error_json(
                        "invalid_request",
                        "snapshot requires a non-empty output path",
                        Some(ext),
                    ));
                    continue;
                };
                let Some(snapshot) = ctx.snapshot.clone() else {
                    send_json(error_json(
                        "unsupported",
                        "snapshot actions are not supported for this session",
                        Some(ext),
                    ));
                    continue;
                };
                let out = out_tx.clone();
                tokio::spawn(async move {
                    match snapshot(path).await {
                        Ok((path, name)) => {
                            let v = gondolin_wire::value!({ "type": "snapshot_response", "id": ext, "path": path, "name": name });
                            let _ = out.send((
                                0,
                                gondolin_wire::json::to_string(&v).into_bytes(),
                                true,
                            ));
                        }
                        Err(e) => {
                            let v = error_json("snapshot_failed", &e, Some(ext));
                            let _ = out.send((
                                0,
                                gondolin_wire::json::to_string(&v).into_bytes(),
                                false,
                            ));
                        }
                    }
                });
            }
            "lifecycle" => send_json(error_json(
                "unsupported",
                "lifecycle actions are not supported over attach IPC",
                None,
            )),
            _ => {}
        }
    }
    // cleanup: free ids, close the daemon client
    let internals: Vec<u32> = map.lock().unwrap().1.keys().copied().collect();
    for internal in internals {
        release(&map, internal);
    }
    if let Some(c) = client {
        ctx.engine.send("client_close", &gondolin_proto::exec::ClientRef { client: c }).await;
        ctx.engine.unregister_client(c);
    }
    if let Some(p) = pump {
        p.abort();
    }
    drop(out_tx);
    let _ = writer.await;
}

// ---------------------------------------------------------------- client

/// A connection to a session socket (`connectToSession`).
pub struct IpcClient {
    pub writer: tokio::net::unix::OwnedWriteHalf,
    pub reader: tokio::net::unix::OwnedReadHalf,
}

/// A message from a session.
#[derive(Debug)]
pub enum ServerMessage {
    Json(Json),
    Output { id: u32, stdout: bool, data: Vec<u8> },
}

impl IpcClient {
    pub async fn connect(path: &str) -> Result<IpcClient, String> {
        let s = UnixStream::connect(path)
            .await
            .map_err(|e| format!("cannot connect to session socket {path}: {e}"))?;
        let (reader, writer) = s.into_split();
        Ok(IpcClient { writer, reader })
    }

    pub async fn send(&mut self, msg: &Json) -> Result<(), String> {
        write_client_frame(&mut self.writer, msg).await.map_err(|e| e.to_string())
    }
}

/// Reads the next server message; `None` at EOF.
pub async fn next_message(
    reader: &mut tokio::net::unix::OwnedReadHalf,
) -> Result<Option<ServerMessage>, String> {
    loop {
        let Some((kind, payload)) = read_server_frame(reader).await.map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        match kind {
            0 => {
                if let Ok(v) = std::str::from_utf8(&payload)
                    .map_err(|_| ())
                    .and_then(|t| gondolin_wire::json::parse(t).map_err(|_| ()))
                {
                    return Ok(Some(ServerMessage::Json(v)));
                }
            }
            1 => {
                if let Some((id, stdout, data)) = parse_output_frame(&payload) {
                    return Ok(Some(ServerMessage::Output { id, stdout, data: data.to_vec() }));
                }
            }
            _ => {}
        }
    }
}

/// Resolves `--sock` (`resolveExecSocketPath`): a socket path, else a
/// session id or prefix of a running session.
pub async fn resolve_socket(value: &str) -> Result<String, String> {
    if value.contains('/') || Path::new(value).exists() {
        return Ok(value.to_string());
    }
    gc().await;
    match find(value).await? {
        Some(s) if s.alive => Ok(s.info.socket_path),
        _ => Err(format!("session not found or not running: {value}")),
    }
}

/// Futures without extra dependencies.
pub mod futures_lite {
    /// A boxed, sendable future.
    pub type BoxedFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_and_ids() {
        let f = output_frame(7, false, b"hi");
        assert_eq!(parse_output_frame(&f), Some((7, false, &b"hi"[..])));
        let mut ids = Ids { allocated: HashSet::new(), next: u32::MAX };
        assert_eq!(ids.allocate(), Some(u32::MAX));
        assert_eq!(ids.allocate(), Some(u32::MAX - 1));
    }

    #[test]
    fn info_format() {
        let info = SessionInfo {
            id: "x".into(),
            pid: 1,
            socket_path: "/s".into(),
            created_at: "2024-01-01T00:00:00.000Z".into(),
            label: None,
        };
        let s = gondolin_wire::json::to_string(&info.to_value());
        assert_eq!(
            s,
            r#"{"id":"x","pid":1,"socketPath":"/s","createdAt":"2024-01-01T00:00:00.000Z"}"#
        );
    }

    #[tokio::test]
    async fn server_frames_roundtrip() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        write_server_frame(&mut a, 0, b"{}").await.unwrap();
        assert_eq!(read_server_frame(&mut b).await.unwrap(), Some((0, b"{}".to_vec())));
    }
}

//! The in-process controller: speaks the controller protocol with an
//! embedded gondolind session (`gondolind::embed`), correlates requests,
//! routes client events and serves daemon→controller requests.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gondolin_wire::ToValue;
use gondolin_wire::{Envelope, RawEnvelope, Value};
use gondolind::embed::{Embedded, EmbeddedSender};
use tokio::sync::{mpsc, oneshot, watch};

/// A result error (`ok: false` or a lost session).
#[derive(Debug, Clone)]
pub struct EngineError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<EngineError> for String {
    fn from(e: EngineError) -> String {
        e.message
    }
}

/// Events of one sandbox client.
#[derive(Debug)]
pub enum ClientEvent {
    Status(String),
    Error { id: Option<u32>, code: String, message: String },
    Closed,
    Output { id: u32, stdout: bool, data: Vec<u8> },
    Response { id: u32, exit_code: i32, signal: Option<i32> },
    StdinAck { id: u32, bytes: u64 },
}

/// VM-level state.
#[derive(Debug, Clone, Default)]
pub struct VmState {
    /// `starting`, `running` or `stopped`
    pub state: String,
    pub vmm_pid: Option<u32>,
    /// set once the VMM exited
    pub exit: Option<String>,
}

/// Events of a guest TCP stream (`fwd_*`).
#[derive(Debug)]
pub enum FwdEvent {
    Opened(Result<(), String>),
    Data(Vec<u8>),
    /// the guest side closed (with an error message, if any)
    Closed(Option<String>),
}

/// Registered guest TCP streams by `(channel, stream)`.
type FwdStreams = Mutex<HashMap<(String, u32), mpsc::UnboundedSender<FwdEvent>>>;

/// Handler for daemon→controller requests (answers the result payload).
pub type RequestHandler = Arc<dyn Fn(&Value) -> Value + Send + Sync>;

type Pending = Mutex<HashMap<u64, oneshot::Sender<Result<Value, EngineError>>>>;

/// Map lookup in a CBOR map.
pub fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_map()?.iter().find(|(k, _)| k.as_text() == Some(key)).map(|(_, v)| v)
}

pub fn get_text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    get(v, key)?.as_text()
}

pub fn get_int(v: &Value, key: &str) -> Option<i128> {
    get(v, key)?.as_integer()
}

/// The controller side of an embedded session.
pub struct Engine {
    sender: EmbeddedSender,
    pending: Arc<Pending>,
    next_id: AtomicU64,
    clients: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<ClientEvent>>>>,
    handlers: Arc<Mutex<HashMap<String, RequestHandler>>>,
    fwd: Arc<FwdStreams>,
    next_fwd: std::sync::atomic::AtomicU32,
    state: watch::Receiver<VmState>,
    reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// print `log` messages (debug flags)
    pub log: Arc<std::sync::atomic::AtomicBool>,
}

impl Engine {
    /// Starts an embedded session and its message pump.
    pub fn start() -> Arc<Engine> {
        let embedded = Embedded::start();
        let sender = embedded.sender();
        let pending: Arc<Pending> = Arc::default();
        let clients: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<ClientEvent>>>> = Arc::default();
        let handlers: Arc<Mutex<HashMap<String, RequestHandler>>> = Arc::default();
        let fwd: Arc<FwdStreams> = Arc::default();
        let (state_tx, state) = watch::channel(VmState::default());
        let log = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = {
            let (pending, clients, handlers, log, fwd) =
                (pending.clone(), clients.clone(), handlers.clone(), log.clone(), fwd.clone());
            let sender = sender.clone();
            tokio::spawn(async move {
                while let Some(msg) = embedded.next().await {
                    if msg.t.starts_with("fwd_") {
                        route_fwd(&msg, &fwd);
                        continue;
                    }
                    route(msg, &pending, &clients, &handlers, &state_tx, &sender, &log).await;
                }
                for (_, tx) in fwd.lock().unwrap().drain() {
                    let _ = tx.send(FwdEvent::Closed(Some("session ended".into())));
                }
                for (_, tx) in pending.lock().unwrap().drain() {
                    let _ = tx.send(Err(EngineError {
                        code: "closed".into(),
                        message: "session ended".into(),
                    }));
                }
                for (_, tx) in clients.lock().unwrap().drain() {
                    let _ = tx.send(ClientEvent::Closed);
                }
                state_tx.send_modify(|s| {
                    s.state = "stopped".into();
                    s.exit.get_or_insert_with(|| "session ended".into());
                });
                drop(sender);
                embedded.close().await;
            })
        };
        Arc::new(Engine {
            sender,
            pending,
            next_id: AtomicU64::new(1),
            clients,
            handlers,
            fwd,
            next_fwd: std::sync::atomic::AtomicU32::new(1),
            state,
            reader: Mutex::new(Some(reader)),
            log,
        })
    }

    /// Sends an unsolicited message.
    pub async fn send<P: ToValue + ?Sized>(&self, t: &str, p: &P) -> bool {
        let Ok(p) = gondolin_wire::to_value(p) else { return false };
        self.sender.send(Envelope::new(t, 0, p)).await
    }

    /// Sends a request and waits for its `<t>_result`.
    pub async fn request<P: ToValue + ?Sized>(&self, t: &str, p: &P) -> Result<Value, EngineError> {
        let p = gondolin_wire::to_value(p)
            .map_err(|e| EngineError { code: "invalid".into(), message: e.to_string() })?;
        self.request_value(t, p).await
    }

    /// [`Engine::request`] with a CBOR payload.
    pub async fn request_value(&self, t: &str, p: Value) -> Result<Value, EngineError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if !self.sender.send(Envelope::new(t, id, p)).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(EngineError { code: "closed".into(), message: "session ended".into() });
        }
        rx.await
            .unwrap_or(Err(EngineError { code: "closed".into(), message: "session ended".into() }))
    }

    /// Registers the event channel of client `client`.
    pub fn register_client(&self, client: u32) -> mpsc::UnboundedReceiver<ClientEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.clients.lock().unwrap().insert(client, tx);
        rx
    }

    pub fn unregister_client(&self, client: u32) {
        self.clients.lock().unwrap().remove(&client);
    }

    /// Serves daemon→controller requests of type `t`.
    pub fn handle_request(&self, t: &str, handler: RequestHandler) {
        self.handlers.lock().unwrap().insert(t.into(), handler);
    }

    /// Opens a guest TCP stream on `channel` (`ssh` or `ingress`); returns
    /// its id and events (the first is `Opened`).
    pub async fn fwd_open(
        &self,
        channel: &str,
        host: &str,
        port: u16,
    ) -> (u32, mpsc::UnboundedReceiver<FwdEvent>) {
        let id = self.next_fwd.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        self.fwd.lock().unwrap().insert((channel.to_string(), id), tx);
        let p =
            gondolin_wire::value!({ "channel": channel, "stream": id, "host": host, "port": port });
        if !self.send("fwd_open", &crate::configure::json_to_cbor(&p)).await {
            self.fwd_forget(channel, id);
        }
        (id, rx)
    }

    /// Stops routing events of a stream.
    pub fn fwd_forget(&self, channel: &str, id: u32) {
        self.fwd.lock().unwrap().remove(&(channel.to_string(), id));
    }

    /// VM state updates.
    pub fn state(&self) -> watch::Receiver<VmState> {
        self.state.clone()
    }

    /// Stops the VM and ends the session (bounded).
    pub async fn shutdown(&self) {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            self.request("shutdown", &gondolin_wire::Value::map()),
        )
        .await;
        let reader = self.reader.lock().unwrap().take();
        if let Some(reader) = reader {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), reader).await;
        }
        gondolind::vmm::kill_current();
    }
}

fn route_fwd(msg: &RawEnvelope, fwd: &FwdStreams) {
    let p = &msg.p;
    let (Some(channel), Some(stream)) =
        (get_text(p, "channel"), get_int(p, "stream").and_then(|s| u32::try_from(s).ok()))
    else {
        return;
    };
    let key = (channel.to_string(), stream);
    let mut streams = fwd.lock().unwrap();
    let Some(tx) = streams.get(&key) else { return };
    match msg.t.as_str() {
        "fwd_opened" => {
            let ok = matches!(get(p, "ok"), Some(Value::Bool(true)));
            let _ = tx.send(FwdEvent::Opened(if ok {
                Ok(())
            } else {
                Err(get_text(p, "message").unwrap_or("tcp_open failed").to_string())
            }));
            if !ok {
                streams.remove(&key);
            }
        }
        "fwd_data" => {
            if let Some(Value::Bytes(b)) = get(p, "data") {
                let _ = tx.send(FwdEvent::Data(b.clone()));
            }
        }
        "fwd_close" => {
            let _ = tx.send(FwdEvent::Closed(get_text(p, "message").map(str::to_string)));
            streams.remove(&key);
        }
        _ => {}
    }
}

async fn route(
    msg: RawEnvelope,
    pending: &Pending,
    clients: &Mutex<HashMap<u32, mpsc::UnboundedSender<ClientEvent>>>,
    handlers: &Mutex<HashMap<String, RequestHandler>>,
    state: &watch::Sender<VmState>,
    sender: &EmbeddedSender,
    log: &std::sync::atomic::AtomicBool,
) {
    let p = &msg.p;
    if msg.t.ends_with("_result") && msg.id != 0 {
        let Some(tx) = pending.lock().unwrap().remove(&msg.id) else { return };
        let ok = matches!(get(p, "ok"), Some(Value::Bool(true)));
        let _ = tx.send(if ok {
            Ok(msg.p)
        } else {
            Err(EngineError {
                code: get_text(p, "code").unwrap_or("error").into(),
                message: get_text(p, "message").unwrap_or("request failed").into(),
            })
        });
        return;
    }
    if msg.id != 0 {
        // a daemon→controller request
        let handler = handlers.lock().unwrap().get(&msg.t).cloned();
        let result = match handler {
            Some(h) => h(p),
            None => Value::Map(vec![
                (Value::Text("ok".into()), Value::Bool(false)),
                (Value::Text("code".into()), Value::Text("unsupported".into())),
                (
                    Value::Text("message".into()),
                    Value::Text(format!("unsupported request: {}", msg.t)),
                ),
            ]),
        };
        sender.send(Envelope::new(format!("{}_result", msg.t), msg.id, result)).await;
        return;
    }
    let client = get_int(p, "client").and_then(|c| u32::try_from(c).ok());
    let to_client = |client: Option<u32>, ev: ClientEvent| {
        if let Some(c) = client
            && let Some(tx) = clients.lock().unwrap().get(&c)
        {
            let _ = tx.send(ev);
        }
    };
    let id = get_int(p, "id").and_then(|i| u32::try_from(i).ok());
    match msg.t.as_str() {
        "exec_output" => {
            let data = match get(p, "data") {
                Some(Value::Bytes(b)) => b.clone(),
                _ => Vec::new(),
            };
            to_client(
                client,
                ClientEvent::Output {
                    id: id.unwrap_or(0),
                    stdout: get_text(p, "stream") == Some("stdout"),
                    data,
                },
            );
        }
        "exec_response" => to_client(
            client,
            ClientEvent::Response {
                id: id.unwrap_or(0),
                exit_code: get_int(p, "exit_code").unwrap_or(1) as i32,
                signal: get_int(p, "signal").map(|s| s as i32),
            },
        ),
        "client_stdin_ack" => to_client(
            client,
            ClientEvent::StdinAck {
                id: id.unwrap_or(0),
                bytes: get_int(p, "bytes").unwrap_or(0) as u64,
            },
        ),
        "client_status" => {
            to_client(client, ClientEvent::Status(get_text(p, "state").unwrap_or("").into()))
        }
        "client_error" => to_client(
            client,
            ClientEvent::Error {
                id,
                code: get_text(p, "code").unwrap_or("error").into(),
                message: get_text(p, "message").unwrap_or("").into(),
            },
        ),
        "client_closed" => {
            if let Some(c) = client
                && let Some(tx) = clients.lock().unwrap().remove(&c)
            {
                let _ = tx.send(ClientEvent::Closed);
            }
        }
        "status" => {
            let s = get_text(p, "state").unwrap_or("").to_string();
            let pid = get_int(p, "vmm_pid").and_then(|v| u32::try_from(v).ok());
            state.send_modify(|st| {
                st.state = s.clone();
                st.vmm_pid = pid;
            });
            // global status goes to every client (as the SDK broadcasts it)
            for tx in clients.lock().unwrap().values() {
                let _ = tx.send(ClientEvent::Status(s.clone()));
            }
        }
        "exit" => {
            let reason = get_text(p, "error").map(str::to_string).unwrap_or_else(|| {
                match (get_int(p, "code"), get_text(p, "signal")) {
                    (_, Some(sig)) => format!("VM exited with signal {sig}"),
                    (Some(code), None) => format!("VM exited with code {code}"),
                    _ => "VM exited".into(),
                }
            });
            state.send_modify(|st| st.exit = Some(reason));
        }
        "log" => {
            if log.load(Ordering::Relaxed) {
                let component = get_text(p, "component").unwrap_or("");
                let message = get_text(p, "message").unwrap_or("").trim_end();
                if component != "assets" {
                    eprintln!("[{component}] {message}");
                }
            }
        }
        "error" if log.load(Ordering::Relaxed) => {
            eprintln!(
                "[error] {}: {}",
                get_text(p, "code").unwrap_or(""),
                get_text(p, "message").unwrap_or("")
            );
        }
        _ => {}
    }
}

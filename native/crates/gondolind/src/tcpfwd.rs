//! Host side of the guest TCP forwarders (`virtio-ssh`, `virtio-ingress`;
//! `guest/ARCHITECTURE.md` §7), relayed to the controller, which owns the
//! streams (`vm.enableSsh()`, the ingress gateway). Port of the
//! `tcpStreams`/`ingressTcpStreams` handling of `SandboxServer`.
//!
//! Controller protocol (every payload carries `channel`: `ssh` | `ingress`,
//! and the controller-chosen `stream` id, which is the guest stream id):
//!
//! | dir | type | payload |
//! |---|---|---|
//! | c→d | `fwd_open` | `{ host, port }`: answered by `fwd_opened` |
//! | d→c | `fwd_opened` | `{ ok, message? }` |
//! | both | `fwd_data` | `{ data }` |
//! | c→d | `fwd_eof` | `{}`: half-close towards the guest service |
//! | both | `fwd_close` | `{ message? }`: the stream is gone |
//! | c→d | `fwd_window` | `{ bytes }`: the controller consumed `bytes` of output |
//!
//! Guest→controller data is credit based: each stream may have
//! [`STREAM_WINDOW`] bytes unacknowledged by `fwd_window`; more is queued in
//! the daemon, and once a channel queues more than [`CHANNEL_QUEUE_LIMIT`]
//! the channel stops reading from the guest (the guest forwarder then stops
//! reading its sockets). Controller→guest data goes into the channel queue
//! (64 MiB, like the node engine); a stream whose data does not fit is closed.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use gondolin_wire::ToValue;
use gondolin_wire::{RawEnvelope, Value};
use tokio::sync::{Notify, mpsc, oneshot};

use crate::controller::{Controller, ControllerHandler};
use crate::fields::{self, Fields};
use crate::guest::{Outbox, PortHandler};
use crate::guestmsg;
use crate::session::Event;

pub const FWD_OPEN: &str = "fwd_open";
pub const FWD_OPENED: &str = "fwd_opened";
pub const FWD_DATA: &str = "fwd_data";
pub const FWD_EOF: &str = "fwd_eof";
pub const FWD_CLOSE: &str = "fwd_close";
pub const FWD_WINDOW: &str = "fwd_window";

/// Unacknowledged guest→controller bytes per stream.
pub const STREAM_WINDOW: u64 = 256 * 1024;
/// Queued guest→controller bytes per channel before reading pauses.
pub const CHANNEL_QUEUE_LIMIT: usize = 1024 * 1024;
/// Data per `fwd_data` frame towards the guest in `bytes`.
const GUEST_CHUNK: usize = 64 * 1024;

#[derive(Default)]
struct StreamState {
    /// bytes the controller may still receive
    credit: u64,
    queue: VecDeque<Vec<u8>>,
    /// the guest closed the stream; send `fwd_close` once the queue drained
    closing: bool,
}

#[derive(Default)]
struct State {
    streams: HashMap<u32, StreamState>,
    queued: usize,
}

/// One forwarder channel.
pub struct TcpForwarder {
    channel: &'static str,
    outbox: Arc<Outbox>,
    ctl: Arc<Controller>,
    events: mpsc::UnboundedSender<Event>,
    state: Mutex<State>,
    drained: Notify,
}

struct Fwd<'a, P: ToValue> {
    channel: &'a str,
    stream: u32,
    /// fields merged into the message
    p: P,
}

impl<P: ToValue> ToValue for Fwd<'_, P> {
    fn to_value(&self) -> Value {
        let mut out = vec![
            (Value::Text("channel".into()), Value::Text(self.channel.into())),
            (Value::Text("stream".into()), Value::Integer(self.stream.into())),
        ];
        gondolin_wire::convert::merge_into(&mut out, self.p.to_value());
        Value::Map(out)
    }
}

gondolin_wire::wire_struct! {
    struct Opened {
        ok: bool,
        message: Option<String>,
    }
}

gondolin_wire::wire_encode! {
    struct Data<'a> {
        data: &'a [u8],
    }
}

gondolin_wire::wire_struct! {
    struct Closed {
        message: Option<String>,
    }
}

gondolin_wire::wire_encode! {
    struct Empty {}
}

gondolin_wire::wire_encode! {
    struct GuestOpen<'a> {
        host: &'a str,
        port: u16,
    }
}

impl TcpForwarder {
    pub fn new(
        channel: &'static str,
        outbox: Arc<Outbox>,
        ctl: Arc<Controller>,
        events: mpsc::UnboundedSender<Event>,
    ) -> Arc<Self> {
        Arc::new(TcpForwarder {
            channel,
            outbox,
            ctl,
            events,
            state: Mutex::new(State::default()),
            drained: Notify::new(),
        })
    }

    /// The stream table; a panic while it was held is contained (see
    /// `panics.rs`), the table stays usable.
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn to_ctl<P: ToValue>(&self, t: &str, stream: u32, p: P) {
        self.ctl.send(t, 0, &Fwd { channel: self.channel, stream, p });
    }

    fn to_guest<P: ToValue>(&self, t: &str, stream: u32, p: P) -> bool {
        self.outbox.send(&guestmsg::envelope(t, stream, p))
    }

    fn activity_source(&self) -> String {
        format!("tcp:{}", self.channel)
    }

    fn update_activity(&self, st: &State) {
        let _ = self.events.send(Event::Activity {
            source: self.activity_source(),
            active: !st.streams.is_empty(),
        });
    }

    /// Forgets a stream; returns whether it existed.
    fn remove(&self, stream: u32) -> bool {
        let mut st = self.lock();
        let Some(s) = st.streams.remove(&stream) else { return false };
        st.queued -= s.queue.iter().map(Vec::len).sum::<usize>();
        self.update_activity(&st);
        drop(st);
        self.drained.notify_waiters();
        true
    }

    /// Drops every stream (guest channel reset), telling the controller.
    fn reset(&self, message: &str) {
        let ids: Vec<u32> = {
            let mut st = self.lock();
            let ids = st.streams.keys().copied().collect();
            st.streams.clear();
            st.queued = 0;
            self.update_activity(&st);
            ids
        };
        self.drained.notify_waiters();
        for id in ids {
            self.to_ctl(FWD_CLOSE, id, Closed { message: Some(message.into()) });
        }
    }

    /// Sends queued data within credit; returns frames to send.
    fn flush_stream(&self, st: &mut State, stream: u32) -> (Vec<Vec<u8>>, bool) {
        let mut out = Vec::new();
        let Some(s) = st.streams.get_mut(&stream) else { return (out, false) };
        let mut released = 0;
        while let Some(front) = s.queue.front() {
            if (front.len() as u64) > s.credit {
                break;
            }
            let chunk = s.queue.pop_front().unwrap();
            s.credit -= chunk.len() as u64;
            released += chunk.len();
            out.push(chunk);
        }
        let close = s.closing && s.queue.is_empty();
        st.queued -= released;
        if close {
            st.streams.remove(&stream);
            self.update_activity(st);
        }
        (out, close)
    }

    fn guest_message(&self, t: &str, stream: u32, p: &Fields<'_>) {
        match t {
            "tcp_opened" => {
                let ok = p.bool("ok").unwrap_or(false);
                if !self.lock().streams.contains_key(&stream) {
                    return;
                }
                let message =
                    (!ok).then(|| p.text("message").unwrap_or("tcp_open failed").to_string());
                if !ok {
                    self.remove(stream);
                }
                self.to_ctl(FWD_OPENED, stream, Opened { ok, message });
            }
            "tcp_data" => {
                let Some(data) = p.bytes("data") else { return };
                let mut st = self.lock();
                let Some(s) = st.streams.get_mut(&stream) else { return };
                if s.queue.is_empty() && s.credit >= data.len() as u64 {
                    s.credit -= data.len() as u64;
                    drop(st);
                    self.to_ctl(FWD_DATA, stream, Data { data });
                } else {
                    s.queue.push_back(data.to_vec());
                    st.queued += data.len();
                }
            }
            "tcp_close" => {
                let mut st = self.lock();
                let Some(s) = st.streams.get_mut(&stream) else { return };
                if s.queue.is_empty() {
                    st.streams.remove(&stream);
                    self.update_activity(&st);
                    drop(st);
                    self.to_ctl(FWD_CLOSE, stream, Closed { message: None });
                } else {
                    s.closing = true;
                }
            }
            _ => {}
        }
    }

    fn controller_message(self: &Arc<Self>, t: &str, stream: u32, p: &Fields<'_>) {
        match t {
            FWD_OPEN => {
                let host = p.text("host").unwrap_or("").to_string();
                let port = p.int("port").and_then(|v| u16::try_from(v).ok()).filter(|v| *v > 0);
                let Some(port) = port else {
                    self.to_ctl(
                        FWD_OPENED,
                        stream,
                        Opened { ok: false, message: Some("invalid guest port".into()) },
                    );
                    return;
                };
                {
                    let mut st = self.lock();
                    st.streams.insert(
                        stream,
                        StreamState { credit: STREAM_WINDOW, ..Default::default() },
                    );
                    self.update_activity(&st);
                }
                // resume an idle-paused VM before talking to the guest
                let (tx, rx) = oneshot::channel();
                let _ = self.events.send(Event::Resume(tx));
                let this = self.clone();
                tokio::spawn(async move {
                    let failure = crate::panics::CatchUnwind::new(async {
                        let resumed = rx.await.unwrap_or_else(|_| Err("session closed".into()));
                        match resumed {
                            Err(err) => Some(err),
                            Ok(())
                                if !this.to_guest(
                                    "tcp_open",
                                    stream,
                                    GuestOpen { host: &host, port },
                                ) =>
                            {
                                Some("virtio tcp queue exceeded".to_string())
                            }
                            Ok(()) => None,
                        }
                    })
                    .await
                    .unwrap_or_else(|panic| Some(format!("internal error: {panic}")));
                    if let Some(message) = failure
                        && this.remove(stream)
                    {
                        this.to_ctl(
                            FWD_OPENED,
                            stream,
                            Opened { ok: false, message: Some(message) },
                        );
                    }
                });
            }
            FWD_DATA => {
                let Some(data) = p.bytes("data") else { return };
                if !self.lock().streams.contains_key(&stream) {
                    return;
                }
                for chunk in data.chunks(GUEST_CHUNK) {
                    if !self.to_guest("tcp_data", stream, Data { data: chunk }) {
                        self.remove(stream);
                        let _ = self.to_guest("tcp_close", stream, Empty {});
                        self.to_ctl(
                            FWD_CLOSE,
                            stream,
                            Closed { message: Some("virtio tcp queue exceeded".into()) },
                        );
                        return;
                    }
                }
            }
            FWD_EOF => {
                if self.lock().streams.contains_key(&stream) {
                    let _ = self.to_guest("tcp_eof", stream, Empty {});
                }
            }
            FWD_CLOSE => {
                if self.remove(stream) {
                    let _ = self.to_guest("tcp_close", stream, Empty {});
                }
            }
            FWD_WINDOW => {
                let bytes = p.int("bytes").and_then(|b| u64::try_from(b).ok()).unwrap_or(0);
                let (frames, close) = {
                    let mut st = self.lock();
                    let Some(s) = st.streams.get_mut(&stream) else { return };
                    s.credit = s.credit.saturating_add(bytes).min(16 * STREAM_WINDOW);
                    self.flush_stream(&mut st, stream)
                };
                for data in frames {
                    self.to_ctl(FWD_DATA, stream, Data { data: &data });
                }
                if close {
                    self.to_ctl(FWD_CLOSE, stream, Closed { message: None });
                }
                self.drained.notify_waiters();
            }
            _ => {}
        }
    }

    async fn wait_queue_room(&self) {
        loop {
            let notified = self.drained.notified();
            if self.lock().queued <= CHANNEL_QUEUE_LIMIT {
                return;
            }
            notified.await;
        }
    }
}

impl PortHandler for TcpForwarder {
    fn frame<'a>(&'a self, frame: Bytes) -> crate::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let v: Value = gondolin_wire::decode_guest(&frame).map_err(|e| e.to_string())?;
            let f = Fields::of(&v);
            let (Some(t), Some(id)) = (f.text("t"), fields::request_id(f.get("id"))) else {
                return Ok(());
            };
            let p = f.get("p").map(Fields::of).unwrap_or_else(|| Fields::of(&Value::Null));
            self.ctl.wait_capacity().await;
            self.guest_message(t, id, &p);
            self.wait_queue_room().await;
            Ok(())
        })
    }

    fn error(&self, message: String) {
        let _ = self.events.send(Event::PortError { port: self.channel, message });
        self.reset(&format!("{} virtio bridge error", self.channel));
    }

    fn connected(&self) {
        self.reset("tcp stream closed");
    }

    fn disconnected(&self) {
        self.reset("tcp stream closed");
    }
}

/// Routes `fwd_*` controller messages to the channel's forwarder.
pub struct FwdDispatch {
    pub ssh: Arc<TcpForwarder>,
    pub ingress: Arc<TcpForwarder>,
}

impl ControllerHandler for FwdDispatch {
    fn handle<'a>(
        &'a self,
        msg: RawEnvelope,
        ctl: &'a Arc<Controller>,
    ) -> crate::BoxFuture<'a, ()> {
        Box::pin(async move {
            let f = Fields::of(&msg.p);
            let fwd = match f.text("channel") {
                Some("ssh") => &self.ssh,
                Some("ingress") => &self.ingress,
                _ => {
                    ctl.error_event("invalid_request", "unknown forwarder channel", Some(&msg.t));
                    return;
                }
            };
            let Some(stream) = fields::request_id(f.get("stream")) else {
                ctl.error_event(
                    "invalid_request",
                    "forwarder messages need a uint32 stream",
                    Some(&msg.t),
                );
                return;
            };
            if let Err(panic) = crate::panics::catch(|| fwd.controller_message(&msg.t, stream, &f))
            {
                // the stream may be half updated: drop it on both sides
                fwd.remove(stream);
                let _ = fwd.to_guest("tcp_close", stream, Empty {});
                fwd.to_ctl(
                    FWD_CLOSE,
                    stream,
                    Closed { message: Some(format!("internal error: {panic}")) },
                );
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guest_frame(t: &str, id: u32, p: Value) -> Bytes {
        let env = gondolin_wire::Envelope::new(t, u64::from(id), p);
        Bytes::from(gondolin_wire::encode(&env).unwrap())
    }

    fn map(entries: Vec<(&str, Value)>) -> Value {
        Value::Map(entries.into_iter().map(|(k, v)| (Value::Text(k.into()), v)).collect())
    }

    #[tokio::test]
    async fn credit_queue_and_close_ordering() {
        crate::test_timeout(async {
            let ctl = Controller::new();
            let outbox = Outbox::new(64 * 1024 * 1024, || {});
            let (tx, mut rx) = mpsc::unbounded_channel();
            let fwd = TcpForwarder::new("ssh", outbox.clone(), ctl.clone(), tx);
            let open = map(vec![
                ("channel", Value::Text("ssh".into())),
                ("stream", Value::Integer(7.into())),
                ("host", Value::Text("127.0.0.1".into())),
                ("port", Value::Integer(22.into())),
            ]);
            fwd.controller_message(FWD_OPEN, 7, &Fields::of(&open));
            // answer the resume request
            loop {
                match rx.recv().await.unwrap() {
                    Event::Resume(reply) => {
                        let _ = reply.send(Ok(()));
                        break;
                    }
                    _ => continue,
                }
            }
            for _ in 0..50 {
                if !outbox.take_frames().is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
            fwd.frame(guest_frame("tcp_opened", 7, map(vec![("ok", Value::Bool(true))])))
                .await
                .unwrap();
            // a full window passes, then data queues
            let big = vec![1u8; STREAM_WINDOW as usize];
            fwd.frame(guest_frame("tcp_data", 7, map(vec![("data", Value::Bytes(big))])))
                .await
                .unwrap();
            fwd.frame(guest_frame("tcp_data", 7, map(vec![("data", Value::Bytes(vec![2; 10]))])))
                .await
                .unwrap();
            fwd.frame(guest_frame("tcp_close", 7, map(vec![]))).await.unwrap();
            let ts: Vec<String> = ctl.take_frames().into_iter().map(|f| f.t).collect();
            assert_eq!(ts, vec![FWD_OPENED, FWD_DATA]);
            let window = map(vec![("bytes", Value::Integer(10.into()))]);
            fwd.controller_message(FWD_WINDOW, 7, &Fields::of(&window));
            let frames = ctl.take_frames();
            let ts: Vec<&str> = frames.iter().map(|f| f.t.as_str()).collect();
            assert_eq!(ts, vec![FWD_DATA, FWD_CLOSE]);
            assert_eq!(Fields::of(&frames[0].p).bytes("data"), Some(&[2u8; 10][..]));
            assert!(fwd.state.lock().unwrap().streams.is_empty());
        })
        .await;
    }
}

//! Interim network mode for remote sessions (`configure.net = { mode:
//! "relay" }`): QEMU's stream netdev connects to the daemon and its bytes are
//! relayed to the controller, where the node engine's network stack runs
//! (like `external`, but without a socket shared between the machines).
//! Replaced by the native network stack as it lands.
//!
//! | dir | type | payload |
//! |---|---|---|
//! | d→c | `netdev_open` | `{ conn }`: QEMU connected (a new `conn` replaces the old one) |
//! | both | `netdev_data` | `{ conn, data }`: netdev stream bytes (length-prefixed frames) |
//! | d→c | `netdev_window` | `{ conn, bytes }`: bytes written to QEMU (controller credit) |
//! | d→c | `netdev_close` | `{ conn }` |
//!
//! Controller→QEMU data is limited by credit: the controller may have
//! [`RELAY_WINDOW`] bytes in flight. QEMU→controller data is throttled by the
//! controller queue (`Controller::wait_capacity`).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use gondolin_wire::RawEnvelope;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

use crate::controller::{Controller, ControllerHandler};
use crate::fields::{self, Fields};
use crate::subsystem::NetBackend;

pub const NETDEV_OPEN: &str = "netdev_open";
pub const NETDEV_DATA: &str = "netdev_data";
pub const NETDEV_WINDOW: &str = "netdev_window";
pub const NETDEV_CLOSE: &str = "netdev_close";

/// Controller→QEMU bytes in flight (the controller honours this).
pub const RELAY_WINDOW: usize = 1024 * 1024;

#[derive(Serialize)]
struct Conn {
    conn: u32,
}

#[derive(Serialize)]
struct Data<'a> {
    conn: u32,
    #[serde(with = "serde_bytes")]
    data: &'a [u8],
}

#[derive(Serialize)]
struct Window {
    conn: u32,
    bytes: u64,
}

/// The relay backend; also handles `netdev_data` from the controller.
pub struct NetRelay {
    ctl: Arc<Controller>,
    next_conn: AtomicU32,
    /// current connection and its writer queue
    current: Mutex<Option<(u32, mpsc::UnboundedSender<Vec<u8>>)>>,
}

impl NetRelay {
    pub fn new(ctl: Arc<Controller>) -> Arc<Self> {
        Arc::new(NetRelay { ctl, next_conn: AtomicU32::new(1), current: Mutex::new(None) })
    }
}

#[async_trait]
impl NetBackend for NetRelay {
    async fn serve(&self, stream: UnixStream) {
        let conn = self.next_conn.fetch_add(1, Ordering::Relaxed);
        // bounded by the controller's credit window, not by this channel
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        *self.current.lock().unwrap() = Some((conn, tx));
        self.ctl.send(NETDEV_OPEN, 0, &Conn { conn });
        let (mut read, mut write) = stream.into_split();
        let ctl = self.ctl.clone();
        let reader = async {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                ctl.wait_capacity().await;
                match read.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        ctl.send(NETDEV_DATA, 0, &Data { conn, data: &buf[..n] });
                    }
                }
            }
        };
        let writer = async {
            while let Some(data) = rx.recv().await {
                if write.write_all(&data).await.is_err() {
                    return;
                }
                ctl.send(NETDEV_WINDOW, 0, &Window { conn, bytes: data.len() as u64 });
            }
        };
        tokio::select! {
            _ = reader => {}
            _ = writer => {}
        }
        let mut current = self.current.lock().unwrap();
        if current.as_ref().is_some_and(|(c, _)| *c == conn) {
            *current = None;
        }
        drop(current);
        self.ctl.send(NETDEV_CLOSE, 0, &Conn { conn });
    }
}

#[async_trait]
impl ControllerHandler for NetRelay {
    async fn handle(&self, msg: RawEnvelope, ctl: &Arc<Controller>) {
        let f = Fields::of(&msg.p);
        let (Some(conn), Some(data)) = (fields::request_id(f.get("conn")), f.bytes("data")) else {
            ctl.error_event("invalid_request", "netdev_data needs conn and data", Some(&msg.t));
            return;
        };
        let current = self.current.lock().unwrap();
        if let Some((c, tx)) = current.as_ref()
            && *c == conn
        {
            let _ = tx.send(data.to_vec());
        }
    }
}

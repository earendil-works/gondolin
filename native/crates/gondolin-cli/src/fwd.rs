//! Guest TCP streams (`fwd_*`, the daemon's relay of the guest's
//! `virtio-ssh`/`virtio-ingress` forwarders) as tokio byte streams, for the
//! SSH port forward (`--ssh`) and the ingress gateway (`--listen`).

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

use crate::configure::{b64, json_to_cbor};
use crate::engine::{Engine, FwdEvent};

/// Data per `fwd_data` message in `bytes`
const CHUNK: usize = 64 * 1024;
/// In-process buffer between the stream user and the pumps in `bytes`
const BUFFER: usize = 256 * 1024;

/// Opens a stream to `host:port` in the guest on `channel`; the returned
/// duplex is the stream (EOF = guest closed; dropping it closes the stream).
pub async fn open(
    engine: &Arc<Engine>,
    channel: &'static str,
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<DuplexStream, String> {
    let (id, mut events) = engine.fwd_open(channel, host, port).await;
    let opened = tokio::time::timeout(timeout, events.recv()).await;
    match opened {
        Ok(Some(FwdEvent::Opened(Ok(())))) => {}
        Ok(Some(FwdEvent::Opened(Err(e)))) => return Err(e),
        Ok(Some(FwdEvent::Closed(m))) => {
            return Err(m.unwrap_or_else(|| "tcp stream closed".into()));
        }
        Ok(_) => return Err("tcp stream closed".into()),
        Err(_) => {
            send(engine, "fwd_close", channel, id, gondolin_wire::value!({})).await;
            engine.fwd_forget(channel, id);
            return Err("tcp_open timeout".into());
        }
    }
    let (user, pump) = tokio::io::duplex(BUFFER);
    let (mut pump_rd, mut pump_wr) = tokio::io::split(pump);
    // guest -> user, returning credit as the user consumes
    let down = {
        let engine = engine.clone();
        tokio::spawn(async move {
            let mut closed_by_guest = false;
            while let Some(ev) = events.recv().await {
                match ev {
                    FwdEvent::Data(data) => {
                        let n = data.len();
                        if pump_wr.write_all(&data).await.is_err() {
                            break;
                        }
                        send(
                            &engine,
                            "fwd_window",
                            channel,
                            id,
                            gondolin_wire::value!({ "bytes": n }),
                        )
                        .await;
                    }
                    FwdEvent::Closed(_) => {
                        closed_by_guest = true;
                        break;
                    }
                    FwdEvent::Opened(_) => {}
                }
            }
            let _ = pump_wr.shutdown().await;
            closed_by_guest
        })
    };
    // user -> guest
    let engine2 = engine.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match pump_rd.read(&mut buf).await {
                Ok(0) | Err(_) => {
                    send(&engine2, "fwd_eof", channel, id, gondolin_wire::value!({})).await;
                    break;
                }
                Ok(n) => {
                    send(
                        &engine2,
                        "fwd_data",
                        channel,
                        id,
                        gondolin_wire::value!({ "data": b64(&buf[..n]) }),
                    )
                    .await;
                }
            }
        }
        // wait for the guest side, then make sure the stream is gone
        let closed_by_guest = down.await.unwrap_or(false);
        if !closed_by_guest {
            send(&engine2, "fwd_close", channel, id, gondolin_wire::value!({})).await;
        }
        engine2.fwd_forget(channel, id);
    });
    Ok(user)
}

async fn send(engine: &Engine, t: &str, channel: &str, id: u32, mut p: gondolin_wire::Value) {
    p["channel"] = channel.into();
    p["stream"] = id.into();
    engine.send(t, &json_to_cbor(&p)).await;
}

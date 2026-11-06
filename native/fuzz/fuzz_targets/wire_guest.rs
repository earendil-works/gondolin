//! Guest channel framing and messages: the `u32` length + CBOR frame reader,
//! CBOR decoding into values/envelopes, and gondolind's guest-facing frame
//! handlers (sandboxfs RPC port, TCP forwarder ports) on arbitrary frames.
#![no_main]

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use gondolin_wire::{FrameReader, RawEnvelope, Value};
use gondolind::controller::Controller;
use gondolind::guest::{Outbox, PortHandler};
use gondolind::tcpfwd::TcpForwarder;
use gondolind::vfs_port::FsPortHandler;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = gondolin_wire::decode::<Value>(data);
    let _ = gondolin_wire::decode::<RawEnvelope>(data);

    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        // framing
        let mut reader = FrameReader::new(data);
        for _ in 0..64 {
            match reader.read_frame().await {
                Ok(Some(frame)) => {
                    let _ = gondolin_wire::decode::<Value>(&frame);
                }
                _ => break,
            }
        }

        // guest-facing handlers on the raw frame
        let frame = Bytes::copy_from_slice(data);
        let ctl = Controller::new();
        let (events, _rx) = tokio::sync::mpsc::unbounded_channel();
        let fs = FsPortHandler::new(
            Outbox::new(1 << 20, || {}),
            None,
            Arc::new(Mutex::new(None)),
            events.clone(),
            None,
        );
        let _ = fs.frame(frame.clone()).await;
        for channel in ["ssh", "ingress"] {
            let fwd = TcpForwarder::new(
                channel,
                Outbox::new(1 << 20, || {}),
                ctl.clone(),
                events.clone(),
            );
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(5), fwd.frame(frame.clone()))
                    .await
                    .expect("forwarder frame hung");
        }
    });
});

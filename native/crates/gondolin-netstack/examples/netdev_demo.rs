//! Serves a QEMU stream netdev on a unix socket with test endpoints, for
//! checking the stack against a real Linux guest:
//!
//! ```text
//! cargo run --release -p gondolin-netstack --example netdev_demo -- /tmp/net.sock
//! qemu-system-aarch64 ... -netdev stream,id=net0,server=off,addr.type=unix,addr.path=/tmp/net.sock \
//!     -device virtio-net-pci,netdev=net0,mac=02:00:00:00:00:01
//! ```
//!
//! Any destination IP works. Ports: `7` echo, `9000` sink (reports MB/s),
//! `9001` HTTP response with a 512 MiB body, everything else: closed.

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use gondolin_netstack::{FlowHandler, NetConfig, NetStack, TcpFlow};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Demo;

const DOWNLOAD: usize = 512 << 20;

#[async_trait]
impl FlowHandler for Demo {
    async fn handle_tcp(&self, flow: TcpFlow) {
        let meta = flow.meta.clone();
        eprintln!("flow {} {} -> {}", meta.id, meta.src, meta.dst);
        let mut stream = flow.stream;
        match meta.dst.port() {
            7 => {
                let (mut rd, mut wr) = tokio::io::split(stream);
                let n = tokio::io::copy(&mut rd, &mut wr).await;
                let _ = wr.shutdown().await;
                eprintln!("flow {} echo done: {n:?}", meta.id);
            }
            9000 => {
                let mut buf = vec![0u8; 256 * 1024];
                let mut total = 0usize;
                let mut start = None;
                loop {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            start.get_or_insert_with(Instant::now);
                            total += n;
                        }
                    }
                }
                let secs = start.map(|s| s.elapsed().as_secs_f64()).unwrap_or(0.0);
                eprintln!(
                    "flow {} sink: {} bytes in {:.2}s = {:.1} MB/s",
                    meta.id,
                    total,
                    secs,
                    total as f64 / secs.max(1e-9) / 1e6
                );
            }
            9001 => {
                let mut req = Vec::new();
                let mut buf = [0u8; 4096];
                while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => req.extend_from_slice(&buf[..n]),
                    }
                }
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {DOWNLOAD}\r\nConnection: close\r\n\r\n"
                );
                if stream.write_all(head.as_bytes()).await.is_err() {
                    return;
                }
                let chunk = vec![b'x'; 64 * 1024];
                let start = Instant::now();
                let mut sent = 0;
                while sent < DOWNLOAD {
                    if stream.write_all(&chunk).await.is_err() {
                        break;
                    }
                    sent += chunk.len();
                }
                let _ = stream.shutdown().await;
                let mut rest = Vec::new();
                let _ = stream.read_to_end(&mut rest).await;
                eprintln!(
                    "flow {} source: {} bytes in {:.2}s",
                    meta.id,
                    sent,
                    start.elapsed().as_secs_f64()
                );
            }
            _ => flow.control.abort(),
        }
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "/tmp/gondolin-net.sock".into());
    let _ = std::fs::remove_file(&path);
    let listener = tokio::net::UnixListener::bind(&path)?;
    let stack = NetStack::new(NetConfig::default(), Arc::new(Demo)).expect("netstack");
    eprintln!("listening on {path}");
    loop {
        let (conn, _) = listener.accept().await?;
        eprintln!("qemu connected");
        let result = stack.serve(conn).await;
        eprintln!("qemu disconnected: {result:?} stats={:?}", stack.stats());
    }
}

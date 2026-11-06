//! HTTPS through the MITM: download throughput (MB/s) and small-request rate
//! (req/s, one TLS handshake + request per flow like the guest does with
//! `connection: close`). No VM: guest flows are in-memory duplex streams, the
//! upstream is a local rustls/hyper server.
//!
//! `cargo bench -p gondolin-egress --bench mitm_throughput [-- --json]`

#[path = "../tests/common/mod.rs"]
mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use http::Response;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const BODY_BYTES: usize = 64 * 1024 * 1024;
const DOWNLOADS: usize = 4;
const SMALL_REQUESTS: usize = 2000;
const CONCURRENCY: usize = 16;

async fn read_response_len<S: tokio::io::AsyncRead + Unpin>(s: &mut S) -> usize {
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0;
    loop {
        match s.read(&mut buf).await {
            Ok(0) | Err(_) => return total,
            Ok(n) => total += n,
        }
    }
}

fn main() {
    let json = std::env::args().any(|a| a == "--json");
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(async move {
        let ca = TestCa::new("gondolin-mitm-ca");
        let up = TestCa::new("upstream-ca");
        let big = bytes::Bytes::from(vec![0x5au8; BODY_BYTES]);
        let addr = upstream(
            handler(move |req| {
                let big = big.clone();
                async move {
                    if req.uri().path() == "/big" {
                        Response::new(body(big))
                    } else {
                        Response::new(body("ok"))
                    }
                }
            }),
            Some(up.server_config(&["bench.test"])),
        )
        .await;
        let mut cfg = config(Some(open_rules()), Some(&ca));
        cfg.upstream_ca_pems = vec![up.cert_pem.clone()];
        let h = Arc::new(Harness::new(cfg, Arc::new(gondolin_egress::NoHooks)));
        let ca = Arc::new(ca);
        let port = addr.port();

        // warm up (leaf cert, pool)
        {
            let mut tls = h.tls(&ca, "bench.test").await;
            tls.write_all(format!("GET /small HTTP/1.1\r\nHost: bench.test:{port}\r\n\r\n").as_bytes())
                .await
                .unwrap();
            read_response_len(&mut tls).await;
        }

        let start = Instant::now();
        let mut bytes = 0usize;
        for _ in 0..DOWNLOADS {
            let mut tls = h.tls(&ca, "bench.test").await;
            tls.write_all(format!("GET /big HTTP/1.1\r\nHost: bench.test:{port}\r\n\r\n").as_bytes())
                .await
                .unwrap();
            bytes += read_response_len(&mut tls).await;
        }
        let elapsed = start.elapsed();
        assert!(bytes >= DOWNLOADS * BODY_BYTES);
        let mbps = bytes as f64 / (1024.0 * 1024.0) / elapsed.as_secs_f64();

        let start = Instant::now();
        let per_task = SMALL_REQUESTS / CONCURRENCY;
        let mut tasks = Vec::new();
        for _ in 0..CONCURRENCY {
            let h = h.clone();
            let ca = ca.clone();
            tasks.push(tokio::spawn(async move {
                for _ in 0..per_task {
                    let mut tls = h.tls(&ca, "bench.test").await;
                    tls.write_all(format!("GET /small HTTP/1.1\r\nHost: bench.test:{port}\r\n\r\n").as_bytes())
                        .await
                        .unwrap();
                    assert!(read_response_len(&mut tls).await > 0);
                }
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        let req_elapsed = start.elapsed();
        let rps = (per_task * CONCURRENCY) as f64 / req_elapsed.as_secs_f64();

        if json {
            println!(
                "{{\"bench\":\"egress_mitm\",\"download_mb_per_s\":{mbps:.1},\"download_bytes\":{bytes},\"small_requests\":{},\"concurrency\":{CONCURRENCY},\"requests_per_s\":{rps:.1}}}",
                per_task * CONCURRENCY
            );
        } else {
            println!("https download through MITM: {mbps:.1} MB/s ({bytes} bytes in {elapsed:?})");
            println!(
                "https small requests (new flow + TLS handshake each, {CONCURRENCY} concurrent): {rps:.1} req/s ({} in {req_elapsed:?})",
                per_task * CONCURRENCY
            );
        }
        let _ = Duration::ZERO;
    });
}

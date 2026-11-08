//! gondolin-http connections on arbitrary peer bytes: the server (requests
//! with bodies, 100-continue, upgrades, keep-alive) and the client (response
//! heads and bodies from an untrusted upstream).
#![no_main]

use bytes::Bytes;
use gondolin_http::client::{self, Connection};
use gondolin_http::server::{Request, Response, ServerConfig, serve};
use gondolin_http::{BoxBody, HeadLimits, Header};
use libfuzzer_sys::fuzz_target;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const LIMITS: HeadLimits = HeadLimits { max_bytes: 8 * 1024, max_headers: 32 };

async fn handler(req: Request) -> Response {
    let target = req.head.target.clone();
    if let Some(upgrade) = req.upgrade {
        tokio::spawn(async move {
            if let Ok(mut io) = upgrade.await {
                let mut buf = [0u8; 64];
                let _ = io.read(&mut buf).await;
            }
        });
        return Response::new(101, vec![Header::new("upgrade", "x")], BoxBody::empty());
    }
    let body = req.body.boxed().collect().await.unwrap_or_default();
    let body = if target.len() % 2 == 0 {
        BoxBody::full(body)
    } else {
        gondolin_http::body::from_chunks(vec![body.clone(), Bytes::from_static(b"x")])
    };
    Response::new(200, vec![], body)
}

fuzz_target!(|data: &[u8]| {
    let Some((&ctl, data)) = data.split_first() else {
        return;
    };
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let (mut peer, ours) = tokio::io::duplex(4096);
        let data = data.to_vec();
        let feed = tokio::spawn(async move {
            let _ = peer.write_all(&data).await;
            let _ = peer.shutdown().await;
            let mut sink = Vec::new();
            let _ = peer.read_to_end(&mut sink).await;
        });
        let work = async {
            if ctl & 1 == 0 {
                let config = ServerConfig { keep_alive: ctl & 2 == 0, limits: LIMITS };
                serve(ours, config, handler, |_| Response::new(400, vec![], BoxBody::empty()))
                    .await;
            } else {
                let body = match ctl >> 2 & 3 {
                    0 => BoxBody::empty(),
                    1 => BoxBody::full(vec![b'a'; 3000]),
                    _ => gondolin_http::body::from_chunks(vec![Bytes::from_static(b"ab"); 3]),
                };
                let method = if ctl & 0x10 != 0 { "HEAD" } else { "POST" };
                if let Ok(resp) =
                    client::send(Connection::new(ours), method, "/", &[], body, &LIMITS, None).await
                {
                    let _ = resp.body.boxed().collect().await;
                }
            }
        };
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), work).await;
        let _ = feed.await;
    });
});

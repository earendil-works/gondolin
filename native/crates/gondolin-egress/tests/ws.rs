mod common;

use std::sync::Arc;

use common::*;
use http::Response;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn echo_ws_handler() -> Handler {
    handler(|mut req| async move {
        let key = header_text(&req, "sec-websocket-key");
        if header_text(&req, "upgrade").as_deref() != Some("websocket") || key.is_none() {
            let mut resp = Response::new(body("not a websocket"));
            *resp.status_mut() = http::StatusCode::BAD_REQUEST;
            return resp;
        }
        let on_upgrade = hyper::upgrade::on(&mut req);
        tokio::spawn(async move {
            let Ok(upgraded) = on_upgrade.await else {
                return;
            };
            let mut io = TokioIo::new(upgraded);
            let mut buf = [0u8; 1024];
            loop {
                match io.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        let mut out = b"echo:".to_vec();
                        out.extend_from_slice(&buf[..n]);
                        if io.write_all(&out).await.is_err() {
                            return;
                        }
                    }
                }
            }
        });
        let mut resp = Response::new(body(""));
        *resp.status_mut() = http::StatusCode::SWITCHING_PROTOCOLS;
        resp.headers_mut().insert("connection", "upgrade".parse().unwrap());
        resp.headers_mut().insert("upgrade", "websocket".parse().unwrap());
        resp.headers_mut().insert("sec-websocket-accept", "accept".parse().unwrap());
        resp
    })
}

const HANDSHAKE: &str = "GET /chat HTTP/1.1\r\nHost: ws.test:{port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";

#[tokio::test]
async fn websocket_upgrade_is_tunneled() {
    let addr = upstream(echo_ws_handler(), None).await;
    let h = Harness::simple(Some(open_rules()));
    let (mut guest, _) = h.open(80);
    guest
        .write_all(HANDSHAKE.replace("{port}", &addr.port().to_string()).as_bytes())
        .await
        .unwrap();

    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut b = [0u8; 1];
        guest.read_exact(&mut b).await.unwrap();
        head.push(b[0]);
    }
    let head = String::from_utf8(head).unwrap();
    assert!(head.starts_with("HTTP/1.1 101 "), "{head}");
    assert!(head.to_lowercase().contains("sec-websocket-accept: accept"), "{head}");

    guest.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 9];
    guest.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"echo:ping");
}

#[tokio::test]
async fn websocket_non_101_response_is_forwarded() {
    let addr = upstream(
        handler(|_req| async move {
            let mut resp = Response::new(body("denied"));
            *resp.status_mut() = http::StatusCode::FORBIDDEN;
            resp
        }),
        None,
    )
    .await;
    let h = Harness::simple(Some(open_rules()));
    let raw = h.raw(HANDSHAKE.replace("{port}", &addr.port().to_string()).as_bytes()).await;
    let r = parse(&raw);
    assert_eq!(r.status, 403);
    assert_eq!(r.text(), "denied");
}

#[tokio::test]
async fn websocket_disabled_is_501() {
    let mut cfg = config(Some(open_rules()), None);
    cfg.policy.allow_websockets = false;
    let h = Harness::new(cfg, Arc::new(gondolin_egress::NoHooks));
    let r = parse(&h.raw(HANDSHAKE.replace("{port}", "80").as_bytes()).await);
    assert_eq!(r.status, 501);
}

#[tokio::test]
async fn websocket_policy_and_validation() {
    let h = Harness::simple(Some(gondolin_proto::net::HttpRules {
        allowed_hosts: vec!["allowed.test".into()],
        ..Default::default()
    }));
    let r = parse(&h.raw(HANDSHAKE.replace("{port}", "80").as_bytes()).await);
    assert_eq!(r.status, 403);
    assert_eq!(r.text(), "403 Forbidden: blocked by policy: ws.test\n");

    let h = Harness::simple(Some(open_rules()));
    let req = HANDSHAKE.replace("{port}", "80").replace("GET /chat", "POST /chat");
    let r = parse(&h.raw(req.as_bytes()).await);
    assert_eq!(r.status, 400);
    assert_eq!(r.text(), "400 Bad Request: websocket upgrade requires GET\n");

    let req = HANDSHAKE.replace("{port}", "80").replace("HTTP/1.1", "HTTP/1.0");
    let r = parse(&h.raw(req.as_bytes()).await);
    assert_eq!(r.status, 501);
}

#[tokio::test]
async fn websocket_header_timeout() {
    // upstream accepts but never answers
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((s, _)) = listener.accept().await {
            held.push(s);
        }
    });
    let mut cfg = config(Some(open_rules()), None);
    cfg.limits.websocket_header_timeout_ms = 100;
    let h = Harness::new(cfg, Arc::new(gondolin_egress::NoHooks));
    let r = parse(&h.raw(HANDSHAKE.replace("{port}", &port.to_string()).as_bytes()).await);
    assert_eq!(r.status, 400);
}

#[tokio::test]
async fn websocket_raw_upstream_101() {
    // an upstream that answers the upgrade with a hand-written 101 (like node's
    // `upgrade` event handlers) and echoes afterwards
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut b = [0u8; 1];
            s.read_exact(&mut b).await.unwrap();
            head.push(b[0]);
        }
        s.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: test\r\n\r\n").await.unwrap();
        let mut buf = [0u8; 64];
        let n = s.read(&mut buf).await.unwrap();
        let mut out = b"echo:".to_vec();
        out.extend_from_slice(&buf[..n]);
        s.write_all(&out).await.unwrap();
    });
    let h = Harness::simple(Some(open_rules()));
    let (mut guest, _) = h.open(80);
    guest.write_all(HANDSHAKE.replace("{port}", &port.to_string()).as_bytes()).await.unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut b = [0u8; 1];
        guest.read_exact(&mut b).await.unwrap();
        head.push(b[0]);
    }
    let head = String::from_utf8(head).unwrap();
    assert!(head.starts_with("HTTP/1.1 101 "), "{head}");
    guest.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 9];
    guest.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"echo:ping");
}

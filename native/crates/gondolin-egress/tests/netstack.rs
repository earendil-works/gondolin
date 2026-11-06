//! End to end without a VM: a smoltcp "guest" speaks Ethernet over the netdev
//! pipe to the real `NetStack`, whose flows go to `Egress`, which bridges to a
//! local upstream (plain HTTP and HTTPS through the MITM).

mod common;
#[path = "../../gondolin-netstack/tests/common/mod.rs"]
mod netcommon;

use std::io::{Read, Write};
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use common::*;
use gondolin_egress::NoHooks;
use http::Response;
use smoltcp::socket::tcp;

const T: Duration = Duration::from_secs(20);
const REMOTE: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 1);

fn upstream_handler() -> Handler {
    handler(|req| async move {
        let size: usize = req
            .uri()
            .query()
            .and_then(|q| q.strip_prefix("size="))
            .map_or(0, |s| s.parse().unwrap());
        if size > 0 {
            return Response::new(body(netcommon::pattern(0, size)));
        }
        let text = format!(
            "{} {} host={}",
            req.method(),
            req.uri(),
            header_text(&req, "host").unwrap_or_default()
        );
        Response::new(body(text))
    })
}

fn start(egress: gondolin_egress::Egress) -> netcommon::Harness {
    netcommon::start(gondolin_netstack::NetConfig::default(), Arc::new(egress))
}

/// Plain HTTP: writes the request, reads until the stack closes the flow.
async fn http_exchange(guest: &mut netcommon::Guest, port: u16, request: &[u8]) -> Vec<u8> {
    let s = guest.connect_established(REMOTE, port, 256 * 1024).await;
    let mut sent = 0;
    let mut received = Vec::new();
    guest
        .run_until(T, |g| {
            let sock = g.tcp(s);
            if sent < request.len() && sock.can_send() {
                sent += sock.send_slice(&request[sent..]).unwrap();
            }
            let mut buf = [0u8; 65536];
            while sock.can_recv() {
                let n = sock.recv_slice(&mut buf).unwrap();
                received.extend_from_slice(&buf[..n]);
            }
            (!sock.may_recv() && sent == request.len()).then_some(())
        })
        .await;
    guest.tcp(s).close();
    received
}

/// HTTPS: a rustls client driven over the smoltcp socket.
async fn https_exchange(
    guest: &mut netcommon::Guest,
    ca: &TestCa,
    sni: &str,
    request: &[u8],
) -> Vec<u8> {
    let s = guest.connect_established(REMOTE, 443, 256 * 1024).await;
    let mut tls = rustls::ClientConnection::new(
        Arc::new(ca.client_config()),
        rustls::pki_types::ServerName::try_from(sni.to_string()).unwrap(),
    )
    .unwrap();
    tls.writer().write_all(request).unwrap();
    let mut received = Vec::new();
    let mut outgoing: Vec<u8> = Vec::new();
    let mut eof = false;
    guest
        .run_until(T, |g| {
            let sock = g.tcp(s);
            while tls.wants_write() {
                tls.write_tls(&mut outgoing).unwrap();
            }
            if !outgoing.is_empty() && sock.can_send() {
                let n = sock.send_slice(&outgoing).unwrap();
                outgoing.drain(..n);
            }
            let mut buf = [0u8; 65536];
            let mut plain = [0u8; 65536];
            let mut drain =
                |tls: &mut rustls::ClientConnection, received: &mut Vec<u8>, eof: &mut bool| loop {
                    match tls.reader().read(&mut plain) {
                        Ok(0) => {
                            *eof = true;
                            break;
                        }
                        Ok(n) => received.extend_from_slice(&plain[..n]),
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(e) => panic!("tls read: {e}"),
                    }
                };
            while sock.can_recv() {
                let n = sock.recv_slice(&mut buf).unwrap();
                let mut slice = &buf[..n];
                while !slice.is_empty() {
                    tls.read_tls(&mut slice).unwrap();
                    tls.process_new_packets().expect("tls");
                    drain(&mut tls, &mut received, &mut eof);
                }
            }
            drain(&mut tls, &mut received, &mut eof);
            (eof || !sock.may_recv()).then_some(())
        })
        .await;
    guest.tcp(s).close();
    received
}

#[tokio::test]
async fn http_through_netstack_and_egress() {
    let addr = upstream(upstream_handler(), None).await;
    let h = Harness::simple(Some(open_rules()));
    let mut stack = start(h.egress.clone());
    let mut guest = netcommon::Guest::new(&mut stack);

    let raw = http_exchange(
        &mut guest,
        80,
        format!("GET /hello HTTP/1.1\r\nHost: a.test:{}\r\n\r\n", addr.port()).as_bytes(),
    )
    .await;
    let r = parse(&raw);
    assert_eq!(r.status, 200, "{}", r.raw_head);
    assert_eq!(r.text(), format!("GET /hello host=a.test:{}", addr.port()));

    // 4 MiB download through the TCP window
    let size = 4 * 1024 * 1024;
    let raw = http_exchange(
        &mut guest,
        80,
        format!("GET /big?size={size} HTTP/1.1\r\nHost: a.test:{}\r\n\r\n", addr.port()).as_bytes(),
    )
    .await;
    let r = parse(&raw);
    assert_eq!(r.body.len(), size);
    assert!(r.body == netcommon::pattern(0, size));
}

#[tokio::test]
async fn non_http_flows_are_reset_through_netstack() {
    let h = Harness::simple(Some(open_rules()));
    let mut stack = start(h.egress.clone());
    let mut guest = netcommon::Guest::new(&mut stack);
    let s = guest.connect_established(REMOTE, 5432, 64 * 1024).await;
    let mut sent = false;
    guest
        .run_until(T, |g| {
            let sock = g.tcp(s);
            if !sent && sock.can_send() {
                sock.send_slice(b"\x00\x01\x02\x03garbage").unwrap();
                sent = true;
            }
            (sock.state() == tcp::State::Closed).then_some(())
        })
        .await;
}

#[tokio::test]
async fn https_through_netstack_and_mitm() {
    let ca = TestCa::new("gondolin-mitm-ca");
    let up = TestCa::new("upstream-ca");
    let addr = upstream(upstream_handler(), Some(up.server_config(&["secure.test"]))).await;
    let mut cfg = config(Some(open_rules()), Some(&ca));
    cfg.upstream_ca_pems = vec![up.cert_pem.clone()];
    let h = Harness::new(cfg, Arc::new(NoHooks));
    let mut stack = start(h.egress.clone());
    let mut guest = netcommon::Guest::new(&mut stack);

    let raw = https_exchange(
        &mut guest,
        &ca,
        "secure.test",
        format!("GET /x HTTP/1.1\r\nHost: secure.test:{}\r\n\r\n", addr.port()).as_bytes(),
    )
    .await;
    let r = parse(&raw);
    assert_eq!(r.status, 200, "{}", r.raw_head);
    assert_eq!(r.text(), format!("GET /x host=secure.test:{}", addr.port()));

    let size = 2 * 1024 * 1024;
    let raw = https_exchange(
        &mut guest,
        &ca,
        "secure.test",
        format!("GET /big?size={size} HTTP/1.1\r\nHost: secure.test:{}\r\n\r\n", addr.port())
            .as_bytes(),
    )
    .await;
    let r = parse(&raw);
    assert_eq!(r.body.len(), size);
    assert!(r.body == netcommon::pattern(0, size));
}

#[tokio::test]
async fn rejected_upload_still_delivers_the_response() {
    let h = Harness::simple(Some(gondolin_proto::net::HttpRules {
        allowed_hosts: vec!["allowed.test".into()],
        ..Default::default()
    }));
    let mut stack = start(h.egress.clone());
    let mut guest = netcommon::Guest::new(&mut stack);
    let mut request =
        b"POST / HTTP/1.1\r\nHost: denied.test\r\nContent-Length: 1048576\r\n\r\n".to_vec();
    request.extend(netcommon::pattern(0, 1 << 20));
    let s = guest.connect_established(REMOTE, 80, 256 * 1024).await;
    let mut sent = 0;
    let mut received = Vec::new();
    guest
        .run_until(T, |g| {
            let sock = g.tcp(s);
            if sent < request.len() && sock.can_send() {
                sent += sock.send_slice(&request[sent..]).unwrap();
            }
            let mut buf = [0u8; 65536];
            while sock.can_recv() {
                let n = sock.recv_slice(&mut buf).unwrap();
                received.extend_from_slice(&buf[..n]);
            }
            (!sock.may_recv() || !sock.is_open()).then_some(())
        })
        .await;
    let r = parse(&received);
    assert_eq!(r.status, 403);
    assert_eq!(r.text(), "403 Forbidden: blocked by policy: denied.test\n");
}

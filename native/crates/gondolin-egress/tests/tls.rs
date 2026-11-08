mod common;

use std::sync::Arc;

use common::*;
use http::Response;
use tokio::io::AsyncWriteExt;

#[tokio::test]
async fn https_round_trip_through_mitm() {
    let ca = TestCa::new("gondolin-mitm-ca");
    let up = TestCa::new("upstream-ca");
    let addr = upstream(
        handler(|req| async move {
            let text = format!(
                "{} {} host={}",
                req.method(),
                req.uri(),
                header_text(&req, "host").unwrap_or_default()
            );
            Response::new(body(text))
        }),
        Some(up.server_config(&["secure.test"])),
    )
    .await;
    let mut cfg = config(Some(open_rules()), Some(&ca));
    cfg.upstream_ca_pems = vec![up.cert_pem.clone()];
    let h = Harness::new(cfg, Arc::new(gondolin_egress::NoHooks));

    let mut tls = h.tls(&ca, "secure.test").await;
    tls.write_all(
        format!("GET /x HTTP/1.1\r\nHost: secure.test:{}\r\n\r\n", addr.port()).as_bytes(),
    )
    .await
    .unwrap();
    let r = parse(&read_to_end(&mut tls).await);
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.text(), format!("GET /x host=secure.test:{}", addr.port()));

    // the leaf presented to the guest names the SNI host and chains to the CA
    let certs = tls.get_ref().1.peer_certificates().unwrap();
    assert_eq!(certs.len(), 2);
}

#[tokio::test]
async fn https_alpn_is_http11() {
    let ca = TestCa::new("gondolin-mitm-ca");
    let h = Harness::new(config(Some(open_rules()), Some(&ca)), Arc::new(gondolin_egress::NoHooks));
    let (guest, _) = h.open(443);
    let mut client = ca.client_config();
    client.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let tls = tokio_rustls::TlsConnector::from(Arc::new(client))
        .connect(rustls::pki_types::ServerName::try_from("a.test").unwrap(), guest)
        .await
        .unwrap();
    assert_eq!(tls.get_ref().1.alpn_protocol(), Some(&b"http/1.1"[..]));
}

#[tokio::test]
async fn untrusted_upstream_certificate_is_502() {
    let ca = TestCa::new("gondolin-mitm-ca");
    let rogue = TestCa::new("rogue");
    let addr = upstream(
        handler(|_req| async move { Response::new(body("nope")) }),
        Some(rogue.server_config(&["secure.test"])),
    )
    .await;
    let h = Harness::new(config(Some(open_rules()), Some(&ca)), Arc::new(gondolin_egress::NoHooks));
    let mut tls = h.tls(&ca, "secure.test").await;
    tls.write_all(
        format!("GET / HTTP/1.1\r\nHost: secure.test:{}\r\n\r\n", addr.port()).as_bytes(),
    )
    .await
    .unwrap();
    let r = parse(&read_to_end(&mut tls).await);
    assert_eq!(r.status, 502);
}

#[tokio::test]
async fn tls_without_ca_is_blocked() {
    let h = Harness::simple(Some(open_rules()));
    let (guest, abort) = h.open(443);
    let ca = TestCa::new("x");
    let res = tokio_rustls::TlsConnector::from(Arc::new(ca.client_config()))
        .connect(rustls::pki_types::ServerName::try_from("a.test").unwrap(), guest)
        .await;
    assert!(res.is_err());
    assert!(abort.0.load(std::sync::atomic::Ordering::SeqCst));
}

#[tokio::test]
async fn https_large_download() {
    let ca = TestCa::new("gondolin-mitm-ca");
    let up = TestCa::new("upstream-ca");
    let addr = upstream(
        handler(|_req| async move { Response::new(body(vec![7u8; 16 * 1024 * 1024])) }),
        Some(up.server_config(&["big.test"])),
    )
    .await;
    let mut cfg = config(Some(open_rules()), Some(&ca));
    cfg.upstream_ca_pems = vec![up.cert_pem.clone()];
    let h = Harness::new(cfg, Arc::new(gondolin_egress::NoHooks));
    let mut tls = h.tls(&ca, "big.test").await;
    tls.write_all(format!("GET / HTTP/1.1\r\nHost: big.test:{}\r\n\r\n", addr.port()).as_bytes())
        .await
        .unwrap();
    let r = parse(&read_to_end(&mut tls).await);
    assert_eq!(r.status, 200);
    assert_eq!(r.body.len(), 16 * 1024 * 1024);
    assert!(r.body.iter().all(|b| *b == 7));
}

/// A CA written by the node engine (`host/src/mitm.ts`: RSA 2048, PKCS#1 key).
#[tokio::test]
async fn node_engine_ca_is_accepted() {
    let cert = include_str!("fixtures/node-ca.crt");
    let key = include_str!("fixtures/node-ca.key");
    let ca =
        gondolin_egress::MitmAuthority::from_pem(cert, key, 4, std::time::Duration::from_secs(60))
            .unwrap();
    let config = ca.server_config("example.com").unwrap();
    assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);

    // full handshake against a client trusting only that CA
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca.ca_der().clone()).unwrap();
    let client = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    let (a, b) = tokio::io::duplex(64 * 1024);
    let server =
        tokio::spawn(
            async move { tokio_rustls::TlsAcceptor::from(config).accept(b).await.map(|_| ()) },
        );
    let client = tokio_rustls::TlsConnector::from(Arc::new(client))
        .connect(rustls::pki_types::ServerName::try_from("example.com").unwrap(), a)
        .await;
    let server = server.await.unwrap();
    assert!(
        client.is_ok() && server.is_ok(),
        "client={:?} server={:?}",
        client.err(),
        server.err()
    );
}

#[tokio::test]
async fn upstream_connections_are_pooled() {
    let ca = TestCa::new("gondolin-mitm-ca");
    let up = TestCa::new("upstream-ca");
    let (addr, accepted) = upstream_counted(
        handler(|_req| async move { Response::new(body("ok")) }),
        Some(up.server_config(&["secure.test"])),
    )
    .await;
    let mut cfg = config(Some(open_rules()), Some(&ca));
    cfg.upstream_ca_pems = vec![up.cert_pem.clone()];
    let h = Harness::new(cfg, Arc::new(gondolin_egress::NoHooks));
    for _ in 0..3 {
        let mut tls = h.tls(&ca, "secure.test").await;
        tls.write_all(
            format!("GET / HTTP/1.1\r\nHost: secure.test:{}\r\n\r\n", addr.port()).as_bytes(),
        )
        .await
        .unwrap();
        let r = parse(&read_to_end(&mut tls).await);
        assert_eq!(r.text(), "ok");
    }
    assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 1);
}

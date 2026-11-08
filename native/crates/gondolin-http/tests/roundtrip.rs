use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use bytes::Bytes;
use gondolin_http::body::from_chunks;
use gondolin_http::client::{self, ClientConfig, Connect, ConnectFuture, Connection, Target};
use gondolin_http::server::{Request, Response, ServerConfig, serve};
use gondolin_http::{BoxBody, HeadLimits, Header, header};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

const LIMITS: HeadLimits = HeadLimits { max_bytes: 64 * 1024, max_headers: 100 };

fn config(keep_alive: bool) -> ServerConfig {
    ServerConfig { keep_alive, limits: LIMITS }
}

/// Echo server: body back, request line in `x-req`.
async fn echo(req: Request) -> Response {
    let line = format!("{} {}", req.head.method, req.head.target);
    let body = req.body.boxed().collect().await.unwrap();
    let mut headers = vec![Header::new("x-req", line)];
    if req.head.target == "/chunked" {
        return Response::new(
            200,
            headers,
            from_chunks(vec![body.slice(..body.len() / 2), body.slice(body.len() / 2..)]),
        );
    }
    headers.push(Header::new("x-len", body.len().to_string()));
    Response::new(200, headers, BoxBody::full(body))
}

fn bad_request(_: &gondolin_http::ParseError) -> Response {
    Response::new(400, vec![], BoxBody::full("bad\n"))
}

fn spawn_server(keep_alive: bool) -> DuplexStream {
    let (a, b) = tokio::io::duplex(1 << 16);
    tokio::spawn(serve(b, config(keep_alive), echo, bad_request));
    a
}

async fn raw(keep_alive: bool, input: &[u8]) -> String {
    let mut s = spawn_server(keep_alive);
    s.write_all(input).await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut out)).await.unwrap().unwrap();
    String::from_utf8_lossy(&out).into_owned()
}

#[tokio::test]
async fn server_framing() {
    let out = raw(false, b"POST /a HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello").await;
    assert_eq!(
        out,
        "HTTP/1.1 200 OK\r\nx-req: POST /a\r\nx-len: 5\r\ncontent-length: 5\r\n\r\nhello"
    );
    let out = raw(
        false,
        b"POST /chunked HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n0\r\n\r\n",
    )
    .await;
    assert_eq!(
        out,
        "HTTP/1.1 200 OK\r\nx-req: POST /chunked\r\ntransfer-encoding: chunked\r\n\r\n2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n"
    );
    // HTTP/1.0: close-delimited
    let out = raw(true, b"POST /chunked HTTP/1.0\r\nContent-Length: 2\r\n\r\nxy").await;
    assert_eq!(out, "HTTP/1.0 200 OK\r\nx-req: POST /chunked\r\n\r\nxy");
    let out = raw(false, b"HEAD / HTTP/1.1\r\n\r\n").await;
    assert_eq!(out, "HTTP/1.1 200 OK\r\nx-req: HEAD /\r\nx-len: 0\r\n\r\n");
    let out = raw(false, b"GET / HTTP/1.1\r\nA : b\r\n\r\n").await;
    assert_eq!(
        out,
        "HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 4\r\n\r\nbad\n"
    );
}

#[tokio::test]
async fn server_keep_alive_and_pipelining() {
    let out = raw(
        true,
        b"GET /1 HTTP/1.1\r\n\r\nPOST /2 HTTP/1.1\r\nContent-Length: 1\r\n\r\nxGET /3 HTTP/1.1\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(out.matches("HTTP/1.1 200 OK").count(), 3, "{out}");
    assert!(out.contains("x-req: GET /3"));
    // keep-alive disabled: one response
    let out = raw(false, b"GET /1 HTTP/1.1\r\n\r\nGET /2 HTTP/1.1\r\n\r\n").await;
    assert_eq!(out.matches("HTTP/1.1 200 OK").count(), 1, "{out}");
    // HTTP/1.0 keep-alive gets the header back
    let mut s = spawn_server(true);
    s.write_all(b"GET /1 HTTP/1.0\r\nConnection: keep-alive\r\n\r\n").await.unwrap();
    let mut buf = vec![0u8; 1024];
    let n = s.read(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).contains("connection: keep-alive"));
}

#[tokio::test]
async fn expect_continue_only_when_body_is_read() {
    // handler that never reads the body: no 100
    let (mut a, b) = tokio::io::duplex(1 << 16);
    tokio::spawn(serve(
        b,
        config(false),
        |_req: Request| async { Response::new(403, vec![], BoxBody::empty()) },
        bad_request,
    ));
    a.write_all(b"POST / HTTP/1.1\r\nExpect: 100-continue\r\nContent-Length: 3\r\n\r\n")
        .await
        .unwrap();
    let mut out = Vec::new();
    a.read_to_end(&mut out).await.unwrap();
    assert!(String::from_utf8_lossy(&out).starts_with("HTTP/1.1 403 Forbidden\r\n"));

    let mut s = spawn_server(false);
    s.write_all(b"POST / HTTP/1.1\r\nExpect: 100-continue\r\nContent-Length: 3\r\n\r\n")
        .await
        .unwrap();
    let mut buf = [0u8; 25];
    s.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"HTTP/1.1 100 Continue\r\n\r\n");
    s.write_all(b"abc").await.unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).await.unwrap();
    assert!(String::from_utf8_lossy(&out).ends_with("\r\n\r\nabc"));
}

#[tokio::test]
async fn upgrade_hands_over_the_connection() {
    let (mut a, b) = tokio::io::duplex(1 << 16);
    tokio::spawn(serve(
        b,
        config(false),
        |req: Request| async move {
            let upgrade = req.upgrade.unwrap();
            tokio::spawn(async move {
                let mut io = upgrade.await.unwrap();
                let mut buf = [0u8; 4];
                io.read_exact(&mut buf).await.unwrap();
                io.write_all(&buf).await.unwrap();
                io.shutdown().await.unwrap();
            });
            Response::new(101, vec![Header::new("upgrade", "x")], BoxBody::empty())
        },
        bad_request,
    ));
    // the first tunnel bytes arrive together with the request
    a.write_all(b"GET / HTTP/1.1\r\nUpgrade: x\r\nConnection: upgrade\r\n\r\nping").await.unwrap();
    let mut out = Vec::new();
    a.read_to_end(&mut out).await.unwrap();
    assert_eq!(
        String::from_utf8_lossy(&out),
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: x\r\n\r\nping"
    );
}

#[tokio::test]
async fn client_send_and_reuse() {
    let s = spawn_server(true);
    let reused = Arc::new(std::sync::Mutex::new(None));
    let r2 = reused.clone();
    let resp = client::send(
        Connection::new(s),
        "POST",
        "/chunked",
        &[Header::new("host", "x")],
        from_chunks(vec![Bytes::from_static(b"hello "), Bytes::from_static(b"world")]),
        &LIMITS,
        Some(Box::new(move |c| *r2.lock().unwrap() = Some(c))),
    )
    .await
    .unwrap();
    assert_eq!(resp.head.status, 200);
    assert_eq!(header(&resp.head.headers, "x-req"), Some(&b"POST /chunked"[..]));
    let body = resp.body.boxed().collect().await.unwrap();
    assert_eq!(&body[..], b"hello world");
    tokio::task::yield_now().await;
    let conn = reused.lock().unwrap().take().expect("connection reusable");
    let resp =
        client::send(conn, "GET", "/again", &[], BoxBody::empty(), &LIMITS, None).await.unwrap();
    assert_eq!(header(&resp.head.headers, "x-req"), Some(&b"GET /again"[..]));
    assert_eq!(resp.body.boxed().collect().await.unwrap().len(), 0);
}

#[tokio::test]
async fn client_early_response_and_body_errors() {
    // the server answers without reading the body
    let (a, b) = tokio::io::duplex(1024);
    tokio::spawn(serve(
        b,
        config(false),
        |_req: Request| async { Response::new(413, vec![], BoxBody::full("no")) },
        bad_request,
    ));
    let big = Bytes::from(vec![b'x'; 1 << 20]);
    let resp =
        client::send(Connection::new(a), "POST", "/", &[], BoxBody::full(big), &LIMITS, None)
            .await
            .unwrap();
    assert_eq!(resp.head.status, 413);

    struct Failing;
    impl gondolin_http::Body for Failing {
        fn poll_data(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<Bytes, gondolin_http::BoxError>>> {
            std::task::Poll::Ready(Some(Err("boom".into())))
        }
    }
    let s = spawn_server(false);
    let err =
        client::send(Connection::new(s), "POST", "/", &[], BoxBody::new(Failing), &LIMITS, None)
            .await
            .err()
            .unwrap();
    assert!(matches!(err, client::SendError::Body(e) if e.to_string() == "boom"));
}

struct DuplexConnector {
    connects: AtomicUsize,
}

impl Connect for DuplexConnector {
    fn connect<'a>(&'a self, _target: &'a Target) -> ConnectFuture<'a> {
        self.connects.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(Box::new(spawn_server(true)) as gondolin_http::BoxIo) })
    }
}

#[tokio::test]
async fn pooled_client() {
    let connector = Arc::new(DuplexConnector { connects: AtomicUsize::new(0) });
    let client = client::Client::new(
        connector.clone(),
        None,
        ClientConfig {
            limits: LIMITS,
            idle_timeout: Duration::from_secs(30),
            max_idle_per_target: 4,
        },
    );
    let target = Target { https: false, host: "a.test".into(), port: 8080 };
    for i in 0..3 {
        let resp = client
            .request(&target, "GET", &format!("/{i}"), vec![], BoxBody::empty())
            .await
            .unwrap();
        assert_eq!(resp.body.boxed().collect().await.unwrap().len(), 0);
        tokio::task::yield_now().await;
    }
    assert_eq!(connector.connects.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn tls_round_trip() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cert = rcgen::generate_simple_self_signed(vec!["a.test".to_string()]).unwrap();
    let der = cert.cert.der().clone();
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(cert.signing_key.serialize_der().into());
    let server = Arc::new(
        rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![der.clone()], key)
            .unwrap(),
    );
    let mut roots = rustls::RootCertStore::empty();
    roots.add(der).unwrap();
    let client_cfg = Arc::new(
        rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth(),
    );

    let (a, b) = tokio::io::duplex(1 << 16);
    tokio::spawn(async move {
        let start = gondolin_http::tls::read_client_hello(b).await.unwrap();
        assert_eq!(start.client_hello().server_name(), Some("a.test"));
        let tls = start.into_stream(server).await.unwrap();
        serve(tls, config(false), echo, bad_request).await;
    });
    let tls = gondolin_http::tls::connect(
        client_cfg,
        gondolin_http::tls::server_name("a.test").unwrap(),
        a,
    )
    .await
    .unwrap();
    let payload = Bytes::from(vec![7u8; 200_000]);
    let resp = client::send(
        Connection::new(tls),
        "POST",
        "/chunked",
        &[],
        BoxBody::full(payload.clone()),
        &LIMITS,
        None,
    )
    .await
    .unwrap();
    assert_eq!(resp.body.boxed().collect().await.unwrap(), payload);
}

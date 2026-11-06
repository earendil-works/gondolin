mod common;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use common::*;
use gondolin_proto::net::{HttpRules, SecretRule, SshEgressConfig};
use http::Response;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn ok_handler() -> Handler {
    handler(|req| async move {
        let text = format!("{} {}", req.method(), req.uri());
        Response::new(body(text))
    })
}

#[tokio::test]
async fn classification_denies_unknown_and_connect() {
    let h = Harness::simple(None);
    for data in [
        &b"\x00\x01\x02\x03garbage"[..],
        b"CONNECT example.com:443 HTTP/1.1\r\n\r\n",
        b"SSH-2.0-OpenSSH_9\r\n",
    ] {
        let (mut guest, abort) = h.open(22);
        guest.write_all(data).await.unwrap();
        let out = read_to_end(&mut guest).await;
        assert!(out.is_empty(), "{:?}", String::from_utf8_lossy(&out));
        assert!(abort.0.load(Ordering::SeqCst), "{data:?}");
    }

    // sniff limit: an endless partial method never classifies
    let (mut guest, abort) = h.open(80);
    let mut data = b"GET /".to_vec();
    data.extend(std::iter::repeat_n(b'a', 9000));
    guest.write_all(&data).await.unwrap();
    let out = read_to_end(&mut guest).await;
    assert!(out.is_empty());
    assert!(abort.0.load(Ordering::SeqCst));
}

#[tokio::test]
async fn ssh_banner_recognized_only_on_ssh_ports() {
    let mut cfg = config(None, None);
    cfg.ssh = Some(SshEgressConfig { ports: vec![22], ..Default::default() });
    let h = Harness::new(cfg, Arc::new(gondolin_egress::NoHooks));
    let (mut guest, abort) = h.open(22);
    guest.write_all(b"SSH-2.0-x\r\n").await.unwrap();
    assert!(read_to_end(&mut guest).await.is_empty());
    // not implemented yet: still blocked
    assert!(abort.0.load(Ordering::SeqCst));
}

#[tokio::test]
async fn http_round_trip() {
    let addr = upstream(ok_handler(), None).await;
    let h = Harness::simple(Some(open_rules()));
    let raw = h
        .raw(
            format!(
                "GET /hello?x=1 HTTP/1.1\r\nHost: example.test:{}\r\nUser-Agent: t\r\n\r\n",
                addr.port()
            )
            .as_bytes(),
        )
        .await;
    let r = parse(&raw);
    assert_eq!(r.status, 200, "{}", r.raw_head);
    assert_eq!(r.header("connection"), Some("close"));
    assert_eq!(r.text(), "GET /hello?x=1");
}

#[tokio::test]
async fn http10_client_gets_close_delimited_body() {
    let addr = upstream(
        handler(|_req| async move {
            let stream = futures_util::stream::iter(vec![Ok::<
                _,
                Box<dyn std::error::Error + Send + Sync>,
            >(http_body::Frame::data(
                Bytes::from_static(b"streamed"),
            ))]);
            Response::new(http_body_util::BodyExt::boxed(http_body_util::StreamBody::new(stream)))
        }),
        None,
    )
    .await;
    let h = Harness::simple(Some(open_rules()));
    let raw = h
        .raw(format!("GET / HTTP/1.0\r\nHost: example.test:{}\r\n\r\n", addr.port()).as_bytes())
        .await;
    let r = parse(&raw);
    assert!(r.status_line.starts_with("HTTP/1.0 200"), "{}", r.raw_head);
    assert_eq!(r.header("transfer-encoding"), None);
    assert_eq!(r.text(), "streamed");

    let raw = h
        .raw(format!("GET / HTTP/1.1\r\nHost: example.test:{}\r\n\r\n", addr.port()).as_bytes())
        .await;
    let r = parse(&raw);
    assert_eq!(r.header("transfer-encoding"), Some("chunked"));
    assert_eq!(r.text(), "streamed");
}

#[tokio::test]
async fn default_policy_blocks_internal_ranges() {
    let addr = upstream(ok_handler(), None).await;
    let h = Harness::simple(None);
    let raw = h
        .raw(format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", addr.port()).as_bytes())
        .await;
    let r = parse(&raw);
    assert_eq!(r.status, 403);
    assert_eq!(
        r.text(),
        "403 Forbidden: blocked by policy: 127.0.0.1 (internal address; provide httpHooks.isIpAllowed to allow)\n"
    );
    assert_eq!(r.header("content-type"), Some("text/plain"));
}

#[tokio::test]
async fn allowlist_and_internal_hosts() {
    let addr = upstream(ok_handler(), None).await;
    let rules = HttpRules {
        allowed_hosts: vec!["allowed.test".into(), "internal.test".into()],
        allowed_internal_hosts: vec!["internal.test".into()],
        ..HttpRules::default()
    };
    let h = Harness::simple(Some(rules));
    for (host, status, text) in [
        ("other.test", 403, "403 Forbidden: blocked by policy: other.test\n"),
        // allowed but resolves to 127.0.0.1 (internal)
        ("allowed.test", 403, "403 Forbidden: blocked by policy: allowed.test\n"),
        ("internal.test", 200, "GET /"),
    ] {
        let raw = h
            .raw(format!("GET / HTTP/1.1\r\nHost: {host}:{}\r\n\r\n", addr.port()).as_bytes())
            .await;
        let r = parse(&raw);
        assert_eq!(r.status, status, "{host}");
        assert_eq!(r.text(), text, "{host}");
    }
}

#[tokio::test]
async fn dns_failure_is_502_with_reason() {
    let h = Harness::simple(Some(open_rules()));
    h.resolver.fail.lock().unwrap().push("missing.test".into());
    let r = parse(&h.raw(b"GET / HTTP/1.1\r\nHost: missing.test\r\n\r\n").await);
    assert_eq!(r.status, 502);
    assert_eq!(r.text(), "502 Bad Gateway: host dns lookup failed for missing.test (ENOTFOUND)\n");
}

#[tokio::test]
async fn dns_rebinding_is_checked_at_connect() {
    let addr = upstream(ok_handler(), None).await;
    let h = Harness::simple(Some(HttpRules::default()));
    // policy check sees a public address, the connect-time lookup an internal one
    h.resolver.set("rebind.test", vec![vec!["203.0.113.10"], vec!["127.0.0.1"]]);
    let r = parse(
        &h.raw(format!("GET / HTTP/1.1\r\nHost: rebind.test:{}\r\n\r\n", addr.port()).as_bytes())
            .await,
    );
    assert_eq!(r.status, 502, "{}", r.text());
    assert_eq!(h.resolver.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn head_validation_errors() {
    let h = Harness::simple(Some(open_rules()));
    let r = parse(&h.raw(b"OPTIONS * HTTP/1.1\r\nHost: a.test\r\n\r\n").await);
    assert_eq!(r.status, 501);
    assert_eq!(r.text(), "501 Not Implemented\n");

    let r = parse(&h.raw(b"GET / HTTP/1.1\r\nHost: a.test\r\nExpect: foo\r\n\r\n").await);
    assert_eq!(r.status, 417);
    assert_eq!(r.text(), "417 Expectation Failed: unsupported expect token(s): foo\n");

    let r = parse(
        &h.raw(
            b"POST / HTTP/1.1\r\nHost: a.test\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n",
        )
        .await,
    );
    assert_eq!(r.status, 501);

    let r = parse(
        &h.raw(b"GET / HTTP/1.1\r\nHost: a.test\r\nUpgrade: h2c\r\nConnection: upgrade\r\n\r\n")
            .await,
    );
    assert_eq!(r.status, 501);

    let r = parse(&h.raw(b"GET / HTTP/1.1\r\n\r\n").await);
    assert_eq!(r.status, 400);

    let mut big = b"GET / HTTP/1.1\r\nHost: a.test\r\nX-Big: ".to_vec();
    big.extend(std::iter::repeat_n(b'a', 70 * 1024));
    big.extend_from_slice(b"\r\n\r\n");
    let r = parse(&h.raw(&big).await);
    assert_eq!(r.status, 431);
}

#[tokio::test]
async fn request_body_limits() {
    let addr = upstream(
        handler(|req| async move {
            let b = body_bytes(req).await;
            Response::new(body(format!("{}", b.len())))
        }),
        None,
    )
    .await;
    let mut cfg = config(Some(open_rules()), None);
    cfg.limits.max_request_body_bytes = 1000;
    let h = Harness::new(cfg, Arc::new(gondolin_egress::NoHooks));

    let r = parse(
        &h.raw(
            format!(
                "POST / HTTP/1.1\r\nHost: a.test:{}\r\nContent-Length: 2000\r\n\r\n",
                addr.port()
            )
            .as_bytes(),
        )
        .await,
    );
    assert_eq!(r.status, 413);
    assert_eq!(r.text(), "413 Payload Too Large: request body exceeds 1000 bytes\n");

    let mut req = format!(
        "POST / HTTP/1.1\r\nHost: a.test:{}\r\nTransfer-Encoding: chunked\r\n\r\n",
        addr.port()
    )
    .into_bytes();
    for _ in 0..3 {
        req.extend_from_slice(b"1f4\r\n");
        req.extend(std::iter::repeat_n(b'x', 500));
        req.extend_from_slice(b"\r\n");
    }
    req.extend_from_slice(b"0\r\n\r\n");
    let r = parse(&h.raw(&req).await);
    assert_eq!(r.status, 413, "{}", r.text());

    // within the limit
    let mut req =
        format!("POST / HTTP/1.1\r\nHost: a.test:{}\r\nContent-Length: 900\r\n\r\n", addr.port())
            .into_bytes();
    req.extend(std::iter::repeat_n(b'y', 900));
    let r = parse(&h.raw(&req).await);
    assert_eq!(r.status, 200);
    assert_eq!(r.text(), "900");
}

#[tokio::test]
async fn streaming_upload_and_download() {
    let addr = upstream(
        handler(|req| async move {
            let b = body_bytes(req).await;
            let sum: u64 = b.iter().map(|x| *x as u64).sum();
            let payload = vec![b'z'; 8 * 1024 * 1024];
            let mut resp = Response::new(body(payload));
            resp.headers_mut().insert("x-upload", format!("{}:{sum}", b.len()).parse().unwrap());
            resp
        }),
        None,
    )
    .await;
    let h = Harness::simple(Some(open_rules()));
    let (mut guest, _) = h.open(80);
    let size = 5 * 1024 * 1024;
    let head = format!(
        "PUT /up HTTP/1.1\r\nHost: a.test:{}\r\nContent-Length: {size}\r\n\r\n",
        addr.port()
    );
    let writer = tokio::spawn(async move {
        guest.write_all(head.as_bytes()).await.unwrap();
        let chunk = vec![1u8; 64 * 1024];
        let mut left = size;
        while left > 0 {
            let n = left.min(chunk.len());
            guest.write_all(&chunk[..n]).await.unwrap();
            left -= n;
        }
        let mut out = Vec::new();
        guest.read_to_end(&mut out).await.unwrap();
        out
    });
    let raw = writer.await.unwrap();
    let r = parse(&raw);
    assert_eq!(r.status, 200);
    assert_eq!(r.header("x-upload"), Some(format!("{size}:{size}").as_str()));
    assert_eq!(r.body.len(), 8 * 1024 * 1024);
    assert_eq!(r.header("content-length"), Some("8388608"));
}

#[tokio::test]
async fn expect_continue_denied_before_body() {
    let h = Harness::simple(Some(HttpRules {
        allowed_hosts: vec!["allowed.test".into()],
        ..HttpRules::default()
    }));
    let (mut guest, _) = h.open(80);
    guest
        .write_all(b"POST / HTTP/1.1\r\nHost: denied.test\r\nExpect: 100-continue\r\nContent-Length: 5\r\n\r\n")
        .await
        .unwrap();
    let raw = read_to_end(&mut guest).await;
    let text = String::from_utf8_lossy(&raw);
    assert!(!text.contains("100 Continue"), "{text}");
    assert!(text.starts_with("HTTP/1.1 403 "), "{text}");
}

#[tokio::test]
async fn expect_continue_allowed_gets_interim_response() {
    let addr =
        upstream(handler(|req| async move { Response::new(body(body_bytes(req).await)) }), None)
            .await;
    let h = Harness::simple(Some(open_rules()));
    let (mut guest, _) = h.open(80);
    guest
        .write_all(
            format!(
                "POST / HTTP/1.1\r\nHost: a.test:{}\r\nExpect: 100-continue\r\nContent-Length: 5\r\n\r\n",
                addr.port()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut buf = [0u8; 25];
    guest.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"HTTP/1.1 100 Continue\r\n\r\n");
    guest.write_all(b"hello").await.unwrap();
    let r = parse(&read_to_end(&mut guest).await);
    assert_eq!(r.status, 200);
    assert_eq!(r.text(), "hello");
}

#[tokio::test]
async fn hop_by_hop_headers_are_stripped() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen2 = seen.clone();
    let addr = upstream(
        handler(move |req| {
            let seen = seen2.clone();
            async move {
                let mut names: Vec<String> = req.headers().keys().map(|k| k.to_string()).collect();
                names.sort();
                *seen.lock().unwrap() = names;
                let mut resp = Response::new(body("x"));
                resp.headers_mut().insert("connection", "x-hop".parse().unwrap());
                resp.headers_mut().insert("x-hop", "1".parse().unwrap());
                resp.headers_mut().insert("keep-alive", "timeout=5".parse().unwrap());
                resp.headers_mut().append("set-cookie", "a=1".parse().unwrap());
                resp.headers_mut().append("set-cookie", "b=2".parse().unwrap());
                resp
            }
        }),
        None,
    )
    .await;
    let h = Harness::simple(Some(open_rules()));
    let r = parse(
        &h.raw(
            format!(
                "GET / HTTP/1.1\r\nHost: a.test:{}\r\nConnection: keep-alive, x-drop\r\nX-Drop: 1\r\nX-Keep: 1\r\nProxy-Authorization: x\r\nTE: trailers\r\n\r\n",
                addr.port()
            )
            .as_bytes(),
        )
        .await,
    );
    assert_eq!(r.status, 200);
    assert_eq!(*seen.lock().unwrap(), vec!["host".to_string(), "x-keep".to_string()]);
    assert_eq!(r.header("x-hop"), None);
    assert_eq!(r.header("keep-alive"), None);
    assert_eq!(r.headers.iter().filter(|(k, _)| k == "set-cookie").count(), 2);
}

#[tokio::test]
async fn head_and_no_content_responses() {
    let addr = upstream(
        handler(|req| async move {
            let status = req.uri().path().trim_start_matches('/').parse::<u16>().unwrap_or(200);
            let mut resp = Response::new(body(if status == 200 { "hello" } else { "" }));
            *resp.status_mut() = http::StatusCode::from_u16(status).unwrap();
            resp
        }),
        None,
    )
    .await;
    let h = Harness::simple(Some(open_rules()));
    let r = parse(
        &h.raw(format!("HEAD /200 HTTP/1.1\r\nHost: a.test:{}\r\n\r\n", addr.port()).as_bytes())
            .await,
    );
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-length"), Some("5"));
    assert!(r.body.is_empty());

    for status in [204, 304] {
        let r = parse(
            &h.raw(
                format!("GET /{status} HTTP/1.1\r\nHost: a.test:{}\r\n\r\n", addr.port())
                    .as_bytes(),
            )
            .await,
        );
        assert_eq!(r.status, status);
        assert!(r.body.is_empty());
    }
}

fn secret_rules(value: &str, hosts: &[&str]) -> (HttpRules, String) {
    let marker = "ab".repeat(24);
    let placeholder = format!("{marker}.api_key");
    (
        HttpRules {
            block_internal_ranges: false,
            marker: Some(marker),
            secrets: vec![SecretRule {
                name: "API_KEY".into(),
                identifier: "api_key".into(),
                placeholder: placeholder.clone(),
                value: value.into(),
                hosts: hosts.iter().map(|s| s.to_string()).collect(),
                ..SecretRule::default()
            }],
            ..HttpRules::default()
        },
        placeholder,
    )
}

#[tokio::test]
async fn secrets_are_substituted_for_allowed_hosts_only() {
    let addr = upstream(
        handler(|req| async move {
            Response::new(body(header_text(&req, "authorization").unwrap_or_default()))
        }),
        None,
    )
    .await;
    let (rules, placeholder) = secret_rules("secret-value", &["api.test"]);
    let h = Harness::simple(Some(rules));
    let r = parse(
        &h.raw(
            format!(
                "GET / HTTP/1.1\r\nHost: api.test:{}\r\nAuthorization: Bearer {placeholder}\r\n\r\n",
                addr.port()
            )
            .as_bytes(),
        )
        .await,
    );
    assert_eq!(r.text(), "Bearer secret-value");

    let r = parse(
        &h.raw(
            format!(
                "GET / HTTP/1.1\r\nHost: other.test:{}\r\nAuthorization: Bearer {placeholder}\r\n\r\n",
                addr.port()
            )
            .as_bytes(),
        )
        .await,
    );
    assert_eq!(r.status, 403);
    assert_eq!(r.text(), "403 Forbidden: secret API_KEY not allowed for host: other.test\n");

    // runtime update: rotate the value
    let mut policy = (*h.egress.policy()).clone();
    policy.rules.as_mut().unwrap().secrets[0].value = "rotated".into();
    h.egress.update_policy(policy);
    let r = parse(
        &h.raw(
            format!(
                "GET / HTTP/1.1\r\nHost: api.test:{}\r\nAuthorization: Bearer {placeholder}\r\n\r\n",
                addr.port()
            )
            .as_bytes(),
        )
        .await,
    );
    assert_eq!(r.text(), "Bearer rotated");
}

#[tokio::test]
async fn redirects_are_followed_and_revalidated() {
    let addr = upstream(
        handler(|req| async move {
            let path = req.uri().path().to_string();
            let method = req.method().to_string();
            let auth = header_text(&req, "authorization").unwrap_or_default();
            let data = body_bytes(req).await;
            let mut resp = Response::new(body(format!(
                "{method} {path} auth={auth} body={}",
                String::from_utf8_lossy(&data)
            )));
            match path.as_str() {
                "/post-302" => {
                    *resp.status_mut() = http::StatusCode::FOUND;
                    resp.headers_mut().insert("location", "/final".parse().unwrap());
                }
                "/put-307" => {
                    *resp.status_mut() = http::StatusCode::TEMPORARY_REDIRECT;
                    resp.headers_mut().insert("location", "/final".parse().unwrap());
                }
                "/cross" => {
                    *resp.status_mut() = http::StatusCode::FOUND;
                    resp.headers_mut()
                        .insert("location", "http://denied.test/final".parse().unwrap());
                }
                "/loop" => {
                    *resp.status_mut() = http::StatusCode::FOUND;
                    resp.headers_mut().insert("location", "/loop".parse().unwrap());
                }
                _ => {}
            }
            resp
        }),
        None,
    )
    .await;
    let rules = HttpRules {
        allowed_hosts: vec!["a.test".into()],
        allowed_internal_hosts: vec!["a.test".into()],
        ..HttpRules::default()
    };
    let h = Harness::simple(Some(rules));
    let port = addr.port();
    let r = parse(
        &h.raw(format!("POST /post-302 HTTP/1.1\r\nHost: a.test:{port}\r\nAuthorization: x\r\nContent-Length: 3\r\n\r\nabc").as_bytes())
            .await,
    );
    assert_eq!(r.text(), "GET /final auth=x body=");

    let r = parse(
        &h.raw(
            format!("PUT /put-307 HTTP/1.1\r\nHost: a.test:{port}\r\nContent-Length: 3\r\n\r\nabc")
                .as_bytes(),
        )
        .await,
    );
    assert_eq!(r.text(), "PUT /final auth= body=abc");

    // redirect target is checked against the allowlist
    let r = parse(
        &h.raw(format!("GET /cross HTTP/1.1\r\nHost: a.test:{port}\r\n\r\n").as_bytes()).await,
    );
    assert_eq!(r.status, 403);
    assert_eq!(r.text(), "403 Forbidden: blocked by policy: denied.test\n");

    let r = parse(
        &h.raw(format!("GET /loop HTTP/1.1\r\nHost: a.test:{port}\r\n\r\n").as_bytes()).await,
    );
    assert_eq!(r.status, 508);
    assert_eq!(r.text(), "508 Loop Detected: too many redirects\n");
}

#[tokio::test]
async fn upstream_connect_failure_is_502() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let h = Harness::simple(Some(open_rules()));
    let r =
        parse(&h.raw(format!("GET / HTTP/1.1\r\nHost: a.test:{port}\r\n\r\n").as_bytes()).await);
    assert_eq!(r.status, 502);
    assert_eq!(r.text(), "502 Bad Gateway\n");
}

#[tokio::test]
async fn absolute_form_targets() {
    let addr = upstream(
        handler(|req| async move {
            Response::new(body(format!(
                "{} {} host={}",
                req.method(),
                req.uri(),
                header_text(&req, "host").unwrap_or_default()
            )))
        }),
        None,
    )
    .await;
    let h = Harness::simple(Some(open_rules()));
    let r = parse(
        &h.raw(
            format!("GET http://a.test:{}/abs HTTP/1.1\r\nHost: ignored\r\n\r\n", addr.port())
                .as_bytes(),
        )
        .await,
    );
    assert_eq!(r.status, 200);
    assert_eq!(r.text(), format!("GET /abs host=a.test:{}", addr.port()));
}

#[tokio::test]
async fn guest_keep_alive_serves_several_requests() {
    let addr = upstream(ok_handler(), None).await;
    let mut cfg = config(Some(open_rules()), None);
    cfg.limits.guest_keep_alive = true;
    let h = Harness::new(cfg, Arc::new(gondolin_egress::NoHooks));
    let (mut guest, _) = h.open(80);
    let port = addr.port();
    guest
        .write_all(format!("GET /one HTTP/1.1\r\nHost: a.test:{port}\r\n\r\nGET /two HTTP/1.1\r\nHost: a.test:{port}\r\nConnection: close\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let raw = String::from_utf8(read_to_end(&mut guest).await).unwrap();
    assert!(raw.contains("GET /one") && raw.contains("GET /two"), "{raw}");
    assert_eq!(raw.matches("HTTP/1.1 200").count(), 2);
}

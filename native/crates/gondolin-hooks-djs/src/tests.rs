use super::*;
use gondolin_egress::{HookBody, PullableBody};
use std::collections::BTreeMap;
use std::pin::Pin;
use std::task::{Context, Poll};

/// Bounds every test that awaits a hook (a hung engine fails instead of hanging)
async fn bounded<F: Future>(f: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(20), f).await.expect("test timed out")
}

fn config(source: &str) -> DjsHooksConfig {
    DjsHooksConfig { source: source.into(), ..Default::default() }
}

fn hooks(source: &str) -> DjsHooks {
    DjsHooks::new(&config(source), &NetLimits::default()).unwrap()
}

fn compile_err(cfg: DjsHooksConfig) -> String {
    DjsHooks::new(&cfg, &NetLimits::default()).unwrap_err().to_string()
}

fn get(url: &str) -> RequestHead {
    RequestHead {
        method: "GET".into(),
        url: url.into(),
        headers: vec![("host".into(), "example.com".into()), ("x-a".into(), "1".into())],
    }
}

fn post(url: &str) -> RequestHead {
    RequestHead { method: "POST".into(), ..get(url) }
}

fn pullable(data: impl Into<bytes::Bytes>) -> PullableBody {
    PullableBody::new(HookBody::full(data.into()), 1 << 20, Blocked::forbidden("too large"))
}

fn response(status: u16, headers: &[(&str, &str)]) -> ResponseHead {
    ResponseHead {
        status,
        status_text: "OK".into(),
        headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    }
}

async fn on_request(h: &DjsHooks, head: RequestHead, body: Option<&[u8]>) -> RequestDecision {
    match try_on_request(h, head, body).await {
        Ok(d) => d,
        Err(e) => panic!("hook failed: {e}"),
    }
}

async fn try_on_request(
    h: &DjsHooks,
    head: RequestHead,
    body: Option<&[u8]>,
) -> Result<RequestDecision, HookError> {
    let p = body.map(|b| pullable(b.to_vec()));
    bounded(h.on_request(head, p.as_ref().map(PullableBody::handle))).await
}

async fn bytes_of(choice: BodyChoice) -> Vec<u8> {
    match choice {
        BodyChoice::Body(mut b) => {
            let mut out = Vec::new();
            while let Some(chunk) =
                std::future::poll_fn(|cx| gondolin_http::Body::poll_data(Pin::new(&mut b), cx))
                    .await
            {
                out.extend_from_slice(&chunk.unwrap());
            }
            out
        }
        c => panic!("expected a body, got {c:?}"),
    }
}

fn failed(r: Result<impl std::fmt::Debug, HookError>) -> String {
    match r {
        Err(HookError::Failed(m)) => m,
        r => panic!("expected a failure, got {r:?}"),
    }
}

fn blocked_err(r: Result<impl std::fmt::Debug, HookError>) -> Blocked {
    match r {
        Err(HookError::Blocked(b)) => b,
        r => panic!("expected a block, got {r:?}"),
    }
}

// ---- compile and phases ----

#[test]
fn phases_are_what_the_policy_defines() {
    assert_eq!(hooks("").phases(), Phases::default());
    assert_eq!(hooks("").registrations(), HookRegistrations::default());
    let h = hooks("function onRequest() {} const isIpAllowed = () => true;");
    assert_eq!(h.phases(), Phases { on_request: true, is_ip_allowed: true, ..Default::default() });
    let regs = h.registrations();
    assert!(regs.is_ip_allowed && !regs.is_request_allowed && regs.on_response.is_none());
    assert_eq!(regs.on_request, Some(BodyHookRegistration { body: true }));
    // non-functions don't count
    assert_eq!(hooks("var onRequest = 1;").phases(), Phases::default());
}

#[test]
fn module_policies_and_imports() {
    let mut modules = BTreeMap::new();
    modules.insert("lib/hosts.js".to_string(), "export const ok = (h) => h === 'a.test';".into());
    let cfg = DjsHooksConfig {
        source: "import { ok } from './lib/hosts.js';\n\
                 export function isRequestAllowed(r) { return ok(new URL(r.url).hostname); }\n\
                 export async function onResponse() {}"
            .into(),
        filename: Some("policy.mjs".into()),
        kind: DjsSourceKind::Module,
        modules,
        ..Default::default()
    };
    let h = DjsHooks::new(&cfg, &NetLimits::default()).unwrap();
    assert_eq!(
        h.phases(),
        Phases { is_request_allowed: true, on_response: true, ..Default::default() }
    );
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        assert!(bounded(h.is_request_allowed(&get("http://a.test/"))).await.unwrap());
        assert!(!bounded(h.is_request_allowed(&get("http://b.test/"))).await.unwrap());
    });
}

#[test]
fn compile_errors() {
    let e = compile_err(config("function onRequest( {"));
    assert!(e.contains("policy.js"), "{e}");
    let e = compile_err(config("throw new Error('boom at load')"));
    assert!(e.contains("boom at load"), "{e}");
    let e = compile_err(DjsHooksConfig {
        kind: DjsSourceKind::Module,
        ..config("import { x } from 'missing';")
    });
    assert!(e.contains("missing"), "{e}");
    let mut modules = BTreeMap::new();
    modules.insert("a.js".to_string(), "export {}".to_string());
    let e = compile_err(DjsHooksConfig { modules, ..config("") });
    assert!(e.contains("module policy"), "{e}");
    let e = compile_err(DjsHooksConfig {
        limits: gondolin_proto::net::DjsHookLimits { fuel: Some(0), ..Default::default() },
        ..config("")
    });
    assert!(e.contains("fuel"), "{e}");
    // a top level that never ends is bounded by the setup budget
    let e = compile_err(config("for (;;) {}"));
    assert!(e.contains("fuel"), "{e}");
}

// ---- onRequest ----

#[tokio::test]
async fn untouched_request_continues() {
    let h = hooks("function onRequest(req) { req.headers.get('x-a'); }");
    assert!(matches!(on_request(&h, get("http://a.test/"), None).await, RequestDecision::Continue));
    let h = hooks("async function onRequest(req) { return req; }");
    assert!(matches!(on_request(&h, get("http://a.test/"), None).await, RequestDecision::Continue));
}

#[tokio::test]
async fn in_place_header_rewrite_keeps_body() {
    let h = hooks(
        "function onRequest(req) {\n\
           req.headers.set('X-Policy', ' v1 ');\n\
           req.headers.delete('x-a');\n\
           req.headers.append('x-list', 'a'); req.headers.append('x-list', 'b');\n\
         }",
    );
    let d = on_request(&h, post("http://a.test/"), Some(b"payload")).await;
    let RequestDecision::Request { head, body } = d else { panic!("{d:?}") };
    assert_eq!(head.header("x-policy"), Some("v1"));
    assert_eq!(head.header("x-a"), None);
    assert_eq!(head.header("x-list"), Some("a, b"));
    assert_eq!(head.method, "POST");
    assert!(matches!(body, BodyChoice::Original));
}

#[tokio::test]
async fn new_request_with_body() {
    let h = hooks(
        "async function onRequest(req) {\n\
           const url = new URL(req.url); url.pathname = '/v2'; url.searchParams.set('k', 'a b');\n\
           return new Request(url, { method: 'put', headers: req.headers, body: 'hé' });\n\
         }",
    );
    let d = on_request(&h, get("http://a.test/v1?x=1"), None).await;
    let RequestDecision::Request { head, body } = d else { panic!("{d:?}") };
    assert_eq!(head.method, "PUT");
    assert_eq!(head.url, "http://a.test/v2?x=1&k=a+b");
    assert_eq!(head.header("x-a"), Some("1"));
    assert_eq!(head.header("content-type"), Some("text/plain;charset=UTF-8"));
    assert_eq!(bytes_of(body).await, "hé".as_bytes());

    let h = hooks(
        "function onRequest(req) { return new Request(req.url, { method: 'POST', body: new Uint8Array([0, 255]) }); }",
    );
    let RequestDecision::Request { body, .. } = on_request(&h, get("http://a.test/"), None).await
    else {
        panic!()
    };
    assert_eq!(bytes_of(body).await, vec![0, 255]);

    // new Request(req) keeps the original body; dropping the body is `none`
    let h =
        hooks("function onRequest(req) { return new Request(req, { headers: { 'x-n': '1' } }); }");
    let d = on_request(&h, post("http://a.test/"), Some(b"x")).await;
    let RequestDecision::Request { head, body } = d else { panic!() };
    assert_eq!(head.headers, vec![("x-n".to_string(), "1".to_string())]);
    assert!(matches!(body, BodyChoice::Original));
    let h = hooks("function onRequest(req) { return new Request(req.url, { method: 'POST' }); }");
    let d = on_request(&h, post("http://a.test/"), Some(b"x")).await;
    assert!(matches!(d, RequestDecision::Request { body: BodyChoice::None, .. }), "{d:?}");
}

#[tokio::test]
async fn respond_short_circuits() {
    let h = hooks(
        "function onRequest(req) {\n\
           if (req.url.endsWith('/json')) return Response.json({ ok: true }, { status: 201 });\n\
           return new Response('denied', { status: 403, statusText: 'Nope', headers: [['x-r', '1']] });\n\
         }",
    );
    let d = on_request(&h, get("http://a.test/"), None).await;
    let RequestDecision::Respond { head, body } = d else { panic!("{d:?}") };
    assert_eq!((head.status, head.status_text.as_str()), (403, "Nope"));
    assert_eq!(head.header("x-r"), Some("1"));
    assert_eq!(head.header("content-type"), Some("text/plain;charset=UTF-8"));
    assert_eq!(bytes_of(body).await, b"denied");
    let d = on_request(&h, get("http://a.test/json"), None).await;
    let RequestDecision::Respond { head, body } = d else { panic!("{d:?}") };
    assert_eq!(head.status, 201);
    assert_eq!(head.header("content-type"), Some("application/json"));
    assert_eq!(bytes_of(body).await, br#"{"ok":true}"#);
}

#[tokio::test]
async fn blocked_error_keeps_status() {
    let h = hooks(
        "function onRequest(req) { throw new HttpRequestBlockedError('no ' + req.method, 451, 'Unavailable'); }",
    );
    let b = blocked_err(try_on_request(&h, get("http://a.test/"), None).await);
    assert_eq!(
        (b.status, b.status_text.as_str(), b.message.as_str()),
        (451, "Unavailable", "no GET")
    );
    let h = hooks("async function onRequest() { throw new HttpRequestBlockedError(); }");
    let b = blocked_err(try_on_request(&h, get("http://a.test/"), None).await);
    assert_eq!((b.status, b.message.as_str()), (403, "request blocked"));
}

#[tokio::test]
async fn body_reading() {
    let h = hooks(
        "async function onRequest(req) {\n\
           const a = await req.clone().text();\n\
           const b = await req.clone().json();\n\
           const c = await req.clone().bytes();\n\
           const d = await req.clone().arrayBuffer();\n\
           req.headers.set('x-seen', `${a.length}:${b.n}:${c.length}:${d.byteLength}:${req.bodyUsed}`);\n\
         }",
    );
    let d = on_request(&h, post("http://a.test/"), Some(br#"{"n":42}"#)).await;
    let RequestDecision::Request { head, body } = d else { panic!("{d:?}") };
    assert_eq!(head.header("x-seen"), Some("8:42:8:8:false"));
    assert!(matches!(body, BodyChoice::Original));

    // invalid UTF-8 is replaced, as Body.text()
    let h = hooks(
        "async function onRequest(req) { return new Response(String((await req.text()).length) + (await req.clone === undefined)); }",
    );
    let d = on_request(&h, post("http://a.test/"), Some(&[0x61, 0xff, 0x62])).await;
    let RequestDecision::Respond { body, .. } = d else { panic!() };
    assert_eq!(bytes_of(body).await, b"3false");

    // no body: empty values
    let h = hooks(
        "async function onRequest(req) { return new Response(`${req.body === null}:${(await req.text()).length}`); }",
    );
    let d = on_request(&h, get("http://a.test/"), None).await;
    let RequestDecision::Respond { body, .. } = d else { panic!() };
    assert_eq!(bytes_of(body).await, b"true:0");
}

#[tokio::test]
async fn consumed_body_rules_match_node() {
    // reading the original and forwarding it: node's 400
    let h = hooks("async function onRequest(req) { await req.text(); }");
    let b = blocked_err(try_on_request(&h, post("http://a.test/"), Some(b"x")).await);
    assert_eq!(b.status, 400);
    assert!(b.message.contains("consumed the request body"), "{}", b.message);
    // a second read throws
    let h = hooks("async function onRequest(req) { await req.text(); await req.text(); }");
    let m = failed(try_on_request(&h, post("http://a.test/"), Some(b"x")).await);
    assert!(m.contains("already been read"), "{m}");
    // read and forwarded as a new body
    let h = hooks(
        "async function onRequest(req) { const t = await req.text(); return new Request(req.url, { method: 'POST', body: t.toUpperCase() }); }",
    );
    let d = on_request(&h, post("http://a.test/"), Some(b"abc")).await;
    let RequestDecision::Request { body, .. } = d else { panic!() };
    assert_eq!(bytes_of(body).await, b"ABC");
    // GET with a body is refused by the constructor
    let h = hooks("function onRequest(req) { return new Request(req.url, { body: 'x' }); }");
    let m = failed(try_on_request(&h, get("http://a.test/"), None).await);
    assert!(m.contains("GET/HEAD"), "{m}");
}

#[tokio::test]
async fn invalid_heads_fail_closed() {
    for src in [
        "function onRequest(req) { req.headers.set('bad name', 'x'); }",
        "function onRequest(req) { req.headers.set('x', 'a\\r\\nInjected: 1'); }",
        "function onRequest(req) { return new Request('ftp://a.test/'); }",
        "function onRequest(req) { return new Request('not a url'); }",
        "function onRequest(req) { return 42; }",
        "function onRequest(req) { return new Response('x', { status: 99 }); }",
        "function onRequest(req) { return new Request(req.url, { method: 'GE T' }); }",
    ] {
        let m = failed(try_on_request(&hooks(src), get("http://a.test/"), None).await);
        assert!(m.starts_with("tier-2 hook:"), "{src}: {m}");
    }
}

// ---- fail closed ----

fn limited(source: &str, fuel: Option<u64>, memory: Option<u64>, timeout: Option<u64>) -> DjsHooks {
    let cfg = DjsHooksConfig {
        limits: gondolin_proto::net::DjsHookLimits {
            fuel,
            memory_bytes: memory,
            timeout_ms: timeout,
        },
        ..config(source)
    };
    DjsHooks::new(&cfg, &NetLimits::default()).unwrap()
}

#[tokio::test]
async fn budgets_fail_closed() {
    let h = limited("function onRequest() { for (;;) {} }", Some(1_000_000), None, None);
    let m = failed(try_on_request(&h, get("http://a.test/"), None).await);
    assert!(m.contains("fuel"), "{m}");

    // memory: uncatchable, even by a policy that tries
    let h = limited(
        "function onRequest() { const a = []; try { for (;;) a.push('x'.repeat(1000) + a.length); } catch (e) { return new Response('swallowed'); } }",
        None,
        Some(4 << 20),
        None,
    );
    let m = failed(try_on_request(&h, get("http://a.test/"), None).await);
    assert!(m.contains("memory"), "{m}");

    // wall clock
    let h = limited("function onRequest() { for (;;) {} }", Some(u64::MAX / 2), None, Some(100));
    let started = std::time::Instant::now();
    let m = failed(try_on_request(&h, get("http://a.test/"), None).await);
    assert!(m.contains("time limit"), "{m}");
    assert!(started.elapsed() < Duration::from_secs(5));

    // the same backend still serves calls after failures
    let h = limited(
        "function onRequest(req) { if (req.url.endsWith('/spin')) for (;;) {} }",
        Some(1_000_000),
        None,
        None,
    );
    for _ in 0..3 {
        failed(try_on_request(&h, get("http://a.test/spin"), None).await);
        assert!(matches!(
            on_request(&h, get("http://a.test/"), None).await,
            RequestDecision::Continue
        ));
    }
}

#[tokio::test]
async fn exceptions_and_unsettled_promises_fail_closed() {
    let m = failed(
        try_on_request(
            &hooks("function onRequest() { throw new Error('boom'); }"),
            get("http://a.test/"),
            None,
        )
        .await,
    );
    assert!(m.contains("boom"), "{m}");
    let m = failed(
        try_on_request(
            &hooks("async function onRequest() { await Promise.reject(new TypeError('nope')); }"),
            get("http://a.test/"),
            None,
        )
        .await,
    );
    assert!(m.contains("nope"), "{m}");
    let m = failed(
        try_on_request(
            &hooks("function onRequest() { return new Promise(() => {}); }"),
            get("http://a.test/"),
            None,
        )
        .await,
    );
    assert!(m.contains("never settles"), "{m}");
    // a thrown non-Error
    let m = failed(
        try_on_request(&hooks("function onRequest() { throw 7; }"), get("http://a.test/"), None)
            .await,
    );
    assert!(m.contains('7'), "{m}");
}

/// A body that never yields data (a stalled guest upload).
struct Stalled;

impl gondolin_http::Body for Stalled {
    fn poll_data(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<bytes::Bytes, gondolin_egress::BoxError>>> {
        Poll::Pending
    }
}

#[tokio::test]
async fn stalled_body_read_times_out() {
    let h = limited("async function onRequest(req) { await req.text(); }", None, None, Some(200));
    let p = PullableBody::new(HookBody::new(Stalled), 1 << 20, Blocked::forbidden("x"));
    let r = bounded(h.on_request(post("http://a.test/"), Some(p.handle()))).await;
    let m = failed(r);
    assert!(m.contains("time limit"), "{m}");
}

#[tokio::test]
async fn body_over_limit_fails() {
    let h = hooks("async function onRequest(req) { await req.clone().text(); }");
    let p = PullableBody::new(
        HookBody::full(vec![b'a'; 100]),
        10,
        Blocked::forbidden("over the limit"),
    );
    let r = bounded(h.on_request(post("http://a.test/"), Some(p.handle()))).await;
    let m = failed(r);
    assert!(m.contains("over the limit"), "{m}");
}

#[tokio::test]
async fn calls_are_isolated() {
    // globals a call changes are gone in the next call (instances reset)
    let h = hooks(
        "globalThis.count = 0;\n\
         function onRequest() { count++; try { Array.prototype.evil = 1; } catch {} return new Response(String(count) + [].evil); }",
    );
    for _ in 0..3 {
        let d = on_request(&h, get("http://a.test/"), None).await;
        let RequestDecision::Respond { body, .. } = d else { panic!() };
        assert_eq!(bytes_of(body).await, b"1undefined");
    }
}

#[tokio::test]
async fn concurrent_calls() {
    let h = std::sync::Arc::new(hooks(
        "async function onRequest(req) { const t = await req.clone().text(); req.headers.set('x-len', String(t.length)); }",
    ));
    let mut tasks = Vec::new();
    for i in 0..32usize {
        let h = h.clone();
        tasks.push(tokio::spawn(async move {
            let body = vec![b'z'; i * 100];
            let d = on_request(&h, post("http://a.test/"), Some(&body)).await;
            let RequestDecision::Request { head, .. } = d else { panic!() };
            assert_eq!(head.header("x-len"), Some((i * 100).to_string().as_str()));
        }));
    }
    for t in tasks {
        bounded(t).await.unwrap();
    }
}

// ---- other phases ----

#[tokio::test]
async fn request_and_ip_policies() {
    let h = hooks(
        "function isRequestAllowed(req) { return req.method !== 'DELETE' && req.body === null; }\n\
         async function isIpAllowed(info) { return info.family === 4 && info.port === 443 && info.protocol === 'https' && info.hostname === 'a.test' && info.ip === '10.0.0.1'; }",
    );
    assert!(bounded(h.is_request_allowed(&get("http://a.test/"))).await.unwrap());
    let del = RequestHead { method: "DELETE".into(), ..get("http://a.test/") };
    assert!(!bounded(h.is_request_allowed(&del)).await.unwrap());
    let mut info = IpAllowInfo {
        hostname: "a.test".into(),
        ip: "10.0.0.1".parse().unwrap(),
        port: 443,
        protocol: "https",
    };
    assert!(bounded(h.is_ip_allowed(&info)).await.unwrap());
    info.port = 80;
    assert!(!bounded(h.is_ip_allowed(&info)).await.unwrap());
    // truthiness like node's Boolean()
    let h = hooks("function isRequestAllowed() {}");
    assert!(!bounded(h.is_request_allowed(&get("http://a.test/"))).await.unwrap());
    let h = hooks("function isRequestAllowed() { throw new HttpRequestBlockedError('x', 401); }");
    assert_eq!(
        blocked_err(bounded(h.is_request_allowed(&get("http://a.test/"))).await).status,
        401
    );
}

#[tokio::test]
async fn response_rewrite() {
    let h = hooks(
        "async function onResponse(res, req) {\n\
           if (res.status === 204) return;\n\
           if (req.url.endsWith('/keep')) { const r = new Response(res.body, res); r.headers.set('x-k', '1'); return r; }\n\
           const text = await res.text();\n\
           return new Response(text.replace('secret', '[redacted]'), { status: res.status, headers: res.headers });\n\
         }",
    );
    let p = pullable(&b"the secret value"[..]);
    let head = response(200, &[("content-type", "text/plain"), ("content-length", "16")]);
    let d = bounded(h.on_response(head.clone(), Some(p.handle()), get("http://a.test/")))
        .await
        .unwrap();
    let ResponseDecision::Response { head: out, body } = d else { panic!("{d:?}") };
    assert_eq!(out.status, 200);
    assert_eq!(out.header("content-type"), Some("text/plain"));
    assert_eq!(bytes_of(body).await, b"the [redacted] value");

    let p = pullable(&b"x"[..]);
    let d =
        bounded(h.on_response(head, Some(p.handle()), get("http://a.test/keep"))).await.unwrap();
    let ResponseDecision::Response { head: out, body } = d else { panic!("{d:?}") };
    assert_eq!(out.header("x-k"), Some("1"));
    assert!(matches!(body, BodyChoice::Original));

    let d = bounded(h.on_response(response(204, &[]), None, get("http://a.test/"))).await.unwrap();
    assert!(matches!(d, ResponseDecision::Continue));
}

#[tokio::test]
async fn encoded_responses_are_decoded_for_the_hook() {
    let mut gz = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3];
    gz.extend(miniz_oxide::deflate::compress_to_vec(b"compressed text", 6));
    gz.extend_from_slice(&[0; 8]);
    let head =
        response(200, &[("content-encoding", "gzip"), ("content-length", &gz.len().to_string())]);
    let h = hooks(
        "async function onResponse(res) {\n\
           const t = await res.clone().text();\n\
           const r = new Response(res.body, res);\n\
           r.headers.set('x-text', t + ':' + res.headers.has('content-encoding'));\n\
           return r;\n\
         }",
    );
    let p = pullable(gz.clone());
    let d = bounded(h.on_response(head.clone(), Some(p.handle()), get("http://a.test/")))
        .await
        .unwrap();
    let ResponseDecision::Response { head: out, body } = d else { panic!("{d:?}") };
    assert_eq!(out.header("x-text"), Some("compressed text:false"));
    // the original (encoded) body is forwarded with its coding restored
    assert_eq!(out.header("content-encoding"), Some("gzip"));
    assert!(matches!(body, BodyChoice::Original));

    // a replaced body goes out decoded, without the coding
    let h = hooks(
        "async function onResponse(res) { return new Response((await res.text()).toUpperCase(), res); }",
    );
    let p = pullable(gz);
    let d = bounded(h.on_response(head, Some(p.handle()), get("http://a.test/"))).await.unwrap();
    let ResponseDecision::Response { head: out, body } = d else { panic!() };
    assert_eq!(out.header("content-encoding"), None);
    assert_eq!(bytes_of(body).await, b"COMPRESSED TEXT");
}

// ---- shim semantics ----

/// Runs `expr` (an expression over `req`) in onRequest and returns its JSON.
async fn eval(expr: &str) -> String {
    let src = format!(
        "async function onRequest(req) {{ return new Response(JSON.stringify(await (async () => {expr})())); }}"
    );
    let d =
        on_request(&hooks(&src), get("http://user:pw@A.test:8080/p/../q?x=1&y=%20#f"), None).await;
    let RequestDecision::Respond { body, .. } = d else { panic!() };
    String::from_utf8(bytes_of(body).await).unwrap()
}

#[tokio::test]
async fn url_semantics() {
    assert_eq!(
        eval("{ const u = new URL(req.url); return [u.href, u.origin, u.protocol, u.username, u.password, u.host, u.hostname, u.port, u.pathname, u.search, u.hash]; }").await,
        r##"["http://user:pw@a.test:8080/q?x=1&y=%20#f","http://a.test:8080","http:","user","pw","a.test:8080","a.test","8080","/q","?x=1&y=%20","#f"]"##
    );
    assert_eq!(
        eval("{ const u = new URL('../b?z', 'https://h.test/a/c'); return [u.href, URL.canParse('nope'), URL.parse('x') === null]; }").await,
        r#"["https://h.test/b?z",false,true]"#
    );
    assert_eq!(
        eval("{ const u = new URL('https://h.test:443/'); u.hostname = 'other.test'; u.port = '8443'; u.hash = 'h'; return u.href; }").await,
        r##""https://other.test:8443/#h""##
    );
    assert_eq!(
        eval("{ const p = new URL(req.url).searchParams; return [p.get('x'), p.get('y'), p.has('z'), [...p.keys()], p.toString()]; }").await,
        r#"["1"," ",false,["x","y"],"x=1&y=+"]"#
    );
    assert!(
        eval("{ try { new URL('/rel'); return 'parsed'; } catch (e) { return e.name; } }")
            .await
            .contains("TypeError")
    );
}

#[tokio::test]
async fn headers_semantics() {
    assert_eq!(
        eval("{ const h = new Headers({ B: '2', a: '1' }); h.append('set-cookie', 'a=1'); h.append('Set-Cookie', 'b=2'); h.append('b', '3');\n\
              return [[...h], h.get('B'), h.getSetCookie(), h.has('A'), h.get('nope')]; }").await,
        r#"[[["a","1"],["b","2, 3"],["set-cookie","a=1"],["set-cookie","b=2"]],"2, 3",["a=1","b=2"],true,null]"#
    );
    assert_eq!(
        eval(
            "{ const out = []; req.headers.forEach((v, k) => out.push(k + '=' + v)); return out; }"
        )
        .await,
        r#"["host=example.com","x-a=1"]"#
    );
    assert!(
        eval("{ try { new Headers([['a', 'b', 'c']]); } catch (e) { return e.name; } }")
            .await
            .contains("TypeError")
    );
}

#[tokio::test]
async fn environment() {
    // TextEncoder/TextDecoder, atob/btoa and a host-set clock exist; no fetch
    assert_eq!(
        eval("[new TextDecoder().decode(new TextEncoder().encode('é')), atob(btoa('x')), Date.now() > 1.6e12, typeof fetch, typeof setTimeout, typeof __body_read]").await,
        r#"["é","x",true,"undefined","undefined","undefined"]"#
    );
    // console goes to the daemon log and does not fail the call
    assert_eq!(
        eval("{ console.log('hi', { a: 1 }); console.error(new Error('e')); return 1; }").await,
        "1"
    );
}

#[tokio::test]
async fn host_functions_cannot_be_reached_or_replaced() {
    // policies can't call the shim's internals or re-bind phases after setup
    assert_eq!(
        eval("[typeof __gondolin_bind, typeof __url_parse, (() => { try { globalThis.__gondolin_on_request = null; } catch { } return typeof globalThis.__gondolin_on_request; })()]").await,
        r#"["undefined","undefined","function"]"#
    );
}

#[tokio::test]
async fn idle_instances_give_back_large_heaps() {
    let h = hooks("async function onRequest(req) { await req.clone().text(); }");
    let big = vec![b'a'; 900 << 10];
    assert!(matches!(
        on_request(&h, post("http://a.test/"), Some(&big)).await,
        RequestDecision::Continue
    ));
    let sizes = h.idle_heap_sizes();
    assert_eq!(sizes.len(), 1);
    assert!(sizes[0] <= engine::IDLE_HEAP_CAP, "{sizes:?}");
    // the shrunk instance serves the next large call
    assert!(matches!(
        on_request(&h, post("http://a.test/"), Some(&big)).await,
        RequestDecision::Continue
    ));
    assert!(h.idle_heap_sizes()[0] <= engine::IDLE_HEAP_CAP);
    // without the cap the reset instance would keep the grown heap
    h.set_idle_heap_cap(usize::MAX);
    assert!(matches!(
        on_request(&h, post("http://a.test/"), Some(&big)).await,
        RequestDecision::Continue
    ));
    assert!(h.idle_heap_sizes()[0] > engine::IDLE_HEAP_CAP, "{:?}", h.idle_heap_sizes());
}

#[tokio::test]
async fn typescript_and_json_modules() {
    let mut modules = BTreeMap::new();
    modules.insert(
        "lib/hosts.ts".to_string(),
        "export const allowed = (h: string): boolean => (h as string).endsWith('.test');"
            .to_string(),
    );
    modules.insert("data/deny.json".to_string(), r#"["/admin", "/internal"]"#.to_string());
    let cfg = DjsHooksConfig {
        source: "import { allowed } from './lib/hosts.ts';\n\
                 import deny from './data/deny.json' with { type: 'json' };\n\
                 interface Head { url: string }\n\
                 export async function onRequest(req: Request): Promise<Response | undefined> {\n\
                   const u = new URL((req as Head).url);\n\
                   if (!allowed(u.hostname) || deny.some((p: string) => u.pathname.startsWith(p))) {\n\
                     return new Response('no', { status: 403 });\n\
                   }\n\
                   return undefined;\n\
                 }"
            .into(),
        kind: DjsSourceKind::TypeScript,
        modules,
        ..Default::default()
    };
    let h = DjsHooks::new(&cfg, &NetLimits::default()).unwrap();
    assert_eq!(h.phases(), Phases { on_request: true, ..Default::default() });
    assert!(matches!(
        on_request(&h, get("http://a.test/ok"), None).await,
        RequestDecision::Continue
    ));
    for url in ["http://a.test/admin/x", "http://a.example/"] {
        let d = on_request(&h, get(url), None).await;
        assert!(matches!(d, RequestDecision::Respond { .. }), "{url}: {d:?}");
    }
    // a type error is not a compile error (types are erased), a syntax error is
    let e = compile_err(DjsHooksConfig {
        source: "export function onRequest(req: ) {}".into(),
        kind: DjsSourceKind::TypeScript,
        ..Default::default()
    });
    assert!(e.contains("policy.ts"), "{e}");
}

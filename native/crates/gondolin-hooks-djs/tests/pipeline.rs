//! Tier-2 hooks in the egress pipeline: secrets, tier order with tier 3,
//! bodies and fail-closed answers, against a local upstream.

#[path = "../../gondolin-egress/tests/common/mod.rs"]
mod common;

use common::*;
use gondolin_egress::{
    BodyHandle, ChainedHooks, HookBackend, HookError, RequestDecision, RequestHead,
    ResponseDecision, ResponseHead,
};
use gondolin_hooks_djs::DjsHooks;
use gondolin_proto::net::{
    BodyHookRegistration, DjsHooksConfig, HookRegistrations, HttpRules, NetLimits, SecretRule,
};
use http::Response;
use std::sync::{Arc, Mutex};

fn tier2(source: &str) -> Arc<DjsHooks> {
    let cfg = DjsHooksConfig { source: source.into(), ..Default::default() };
    Arc::new(DjsHooks::new(&cfg, &NetLimits::default()).unwrap())
}

fn echo() -> Handler {
    handler(|req| async move {
        let auth = header_text(&req, "authorization").unwrap_or_else(|| "-".into());
        let seen = header_text(&req, "x-seen").unwrap_or_else(|| "-".into());
        let t3 = header_text(&req, "x-tier3").unwrap_or_else(|| "-".into());
        let path = req.uri().path().to_string();
        let data = body_bytes(req).await;
        Response::new(body(format!(
            "path={path} auth={auth} seen={seen} t3={t3} body={}",
            String::from_utf8_lossy(&data)
        )))
    })
}

fn secret_rules(marker: &str) -> HttpRules {
    HttpRules {
        block_internal_ranges: false,
        marker: Some(marker.to_string()),
        secrets: vec![SecretRule {
            name: "API_KEY".into(),
            identifier: "api_key".into(),
            placeholder: format!("{marker}.api_key"),
            value: "secret-value".into(),
            hosts: vec!["a.test".into()],
            ..Default::default()
        }],
        ..HttpRules::default()
    }
}

async fn get(h: &Harness, port: u16, path: &str, extra: &str) -> Parsed {
    let req = format!("GET {path} HTTP/1.1\r\nHost: a.test:{port}\r\n{extra}\r\n");
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        parse(&h.raw(req.as_bytes()).await)
    })
    .await
    .expect("request timed out")
}

#[tokio::test]
async fn hooks_see_placeholders_and_secrets_are_substituted_after() {
    let addr = upstream(echo(), None).await;
    let marker = "ab".repeat(24);
    let policy = format!(
        "function onRequest(req) {{\n\
           const auth = req.headers.get('authorization');\n\
           req.headers.set('x-seen', auth === null ? 'none' : auth.includes('secret-value') ? 'secret' : auth.includes('{marker}.api_key') ? 'placeholder' : 'other');\n\
           if (new URL(req.url).pathname === '/inject') req.headers.set('authorization', 'Bearer {marker}.api_key');\n\
         }}"
    );
    let h = Harness::new(config(Some(secret_rules(&marker)), None), tier2(&policy));
    let r =
        get(&h, addr.port(), "/a", &format!("Authorization: Bearer {marker}.api_key\r\n")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    // the hook saw the placeholder, upstream got the secret
    assert_eq!(r.text(), "path=/a auth=Bearer secret-value seen=placeholder t3=- body=");
    // a placeholder the hook adds is substituted too
    let r = get(&h, addr.port(), "/inject", "").await;
    assert_eq!(r.text(), "path=/inject auth=Bearer secret-value seen=none t3=- body=");
}

#[tokio::test]
async fn body_read_by_the_hook_is_forwarded() {
    let addr = upstream(echo(), None).await;
    let policy = "async function onRequest(req) {\n\
                    const t = await req.clone().text();\n\
                    if (t.includes('forbidden')) throw new HttpRequestBlockedError('body policy', 422, 'Unprocessable');\n\
                    req.headers.set('x-seen', String(t.length));\n\
                  }";
    let h = Harness::new(config(Some(open_rules()), None), tier2(policy));
    let payload = "x".repeat(100_000);
    let req = format!(
        "POST /up HTTP/1.1\r\nHost: a.test:{}\r\nContent-Length: {}\r\n\r\n{payload}",
        addr.port(),
        payload.len()
    );
    let r = parse(&h.raw(req.as_bytes()).await);
    assert_eq!(r.status, 200);
    assert_eq!(r.text(), format!("path=/up auth=- seen=100000 t3=- body={payload}"));
    let req = format!(
        "POST /up HTTP/1.1\r\nHost: a.test:{}\r\nContent-Length: 9\r\n\r\nforbidden",
        addr.port()
    );
    let r = parse(&h.raw(req.as_bytes()).await);
    assert_eq!(r.status, 422);
}

#[tokio::test]
async fn failures_answer_502_and_responses_are_rewritten() {
    let addr = upstream(echo(), None).await;
    let policy = "function onRequest(req) { if (req.url.endsWith('/boom')) throw new Error('boom'); }\n\
                  async function onResponse(res) { const t = await res.text(); return new Response(t.toUpperCase(), { status: 201, headers: { 'x-r': '1' } }); }";
    let h = Harness::new(config(Some(open_rules()), None), tier2(policy));
    let r = get(&h, addr.port(), "/boom", "").await;
    assert_eq!(r.status, 502);
    let r = get(&h, addr.port(), "/ok", "").await;
    assert_eq!(r.status, 201);
    assert_eq!(r.header("x-r"), Some("1"));
    assert_eq!(r.text(), "PATH=/OK AUTH=- SEEN=- T3=- BODY=");
}

#[tokio::test]
async fn declarative_policy_runs_before_and_after_tier_2() {
    let addr = upstream(echo(), None).await;
    // a request the hook redirects to a host the allowlist does not admit is denied
    let policy = "function onRequest(req) {\n\
                    const u = new URL(req.url);\n\
                    if (u.pathname === '/evil') { u.hostname = 'b.test'; return new Request(u, req); }\n\
                  }";
    let rules = HttpRules {
        allowed_hosts: vec!["a.test".into()],
        block_internal_ranges: false,
        ..HttpRules::default()
    };
    let h = Harness::new(config(Some(rules), None), tier2(policy));
    assert_eq!(get(&h, addr.port(), "/fine", "").await.status, 200);
    assert_eq!(get(&h, addr.port(), "/evil", "").await.status, 403);
}

/// A tier-3 stand-in recording what it saw.
#[derive(Default)]
struct Tier3 {
    seen: Mutex<Vec<String>>,
}

impl HookBackend for Tier3 {
    fn registrations(&self) -> HookRegistrations {
        HookRegistrations {
            is_request_allowed: true,
            on_request: Some(BodyHookRegistration { body: true }),
            on_response: Some(BodyHookRegistration { body: false }),
            ..Default::default()
        }
    }

    fn is_request_allowed<'a>(
        &'a self,
        request: &'a RequestHead,
    ) -> gondolin_egress::BoxFuture<'a, Result<bool, HookError>> {
        Box::pin(async move {
            self.seen.lock().unwrap().push(format!("allowed? {}", request.url));
            Ok(true)
        })
    }

    fn on_request<'a>(
        &'a self,
        mut request: RequestHead,
        body: Option<BodyHandle>,
    ) -> gondolin_egress::BoxFuture<'a, Result<RequestDecision, HookError>> {
        Box::pin(async move {
            let text = match &body {
                Some(b) => String::from_utf8_lossy(&b.read_to_end().await.unwrap()).into_owned(),
                None => "-".into(),
            };
            self.seen.lock().unwrap().push(format!(
                "on_request {} x-seen={} body={text}",
                request.url,
                request.header("x-seen").unwrap_or("-")
            ));
            request.set_header("x-tier3", "yes");
            Ok(RequestDecision::Request {
                head: request,
                body: gondolin_egress::BodyChoice::Original,
            })
        })
    }

    fn on_response<'a>(
        &'a self,
        response: ResponseHead,
        _body: Option<BodyHandle>,
        _request: RequestHead,
    ) -> gondolin_egress::BoxFuture<'a, Result<ResponseDecision, HookError>> {
        Box::pin(async move {
            self.seen.lock().unwrap().push(format!(
                "on_response {} x-t2={}",
                response.status,
                response.header("x-t2").unwrap_or("-")
            ));
            Ok(ResponseDecision::Continue)
        })
    }
}

#[tokio::test]
async fn tier_2_runs_before_tier_3() {
    let addr = upstream(echo(), None).await;
    let policy = "function isRequestAllowed(req) { return !req.url.endsWith('/deny'); }\n\
                  async function onRequest(req) {\n\
                    if (req.method === 'POST') return new Request(req.url, { method: 'POST', headers: { 'x-seen': 't2' }, body: (await req.text()) + '+t2' });\n\
                    req.headers.set('x-seen', 't2');\n\
                  }\n\
                  function onResponse(res) { const r = new Response(res.body, res); r.headers.set('x-t2', '1'); return r; }";
    let t3 = Arc::new(Tier3::default());
    let chain = ChainedHooks::new(vec![tier2(policy), t3.clone()], &NetLimits::default());
    let regs = chain.registrations();
    assert!(regs.is_request_allowed && !regs.is_ip_allowed);
    assert_eq!(regs.on_response, Some(BodyHookRegistration { body: true }));
    let h = Harness::new(config(Some(open_rules()), None), Arc::new(chain));

    let url = format!("http://a.test:{}", addr.port());
    let r = get(&h, addr.port(), "/a", "").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.text(), "path=/a auth=- seen=t2 t3=yes body=");
    assert_eq!(r.header("x-t2"), Some("1"));
    assert_eq!(
        std::mem::take(&mut *t3.seen.lock().unwrap()),
        vec![
            format!("on_request {url}/a x-seen=t2 body=-"),
            format!("allowed? {url}/a"),
            "on_response 200 x-t2=1".to_string(),
        ]
    );

    // tier 3 pulls the body tier 2 replaced
    let req =
        format!("POST /p HTTP/1.1\r\nHost: a.test:{}\r\nContent-Length: 3\r\n\r\nabc", addr.port());
    let r = parse(&h.raw(req.as_bytes()).await);
    assert_eq!(r.text(), "path=/p auth=- seen=t2 t3=yes body=abc+t2");
    assert_eq!(t3.seen.lock().unwrap()[0], format!("on_request {url}/p x-seen=t2 body=abc+t2"));
    t3.seen.lock().unwrap().clear();

    // a tier-2 deny ends the phase: tier 3 is not asked
    let r = get(&h, addr.port(), "/deny", "").await;
    assert_eq!(r.status, 403);
    assert!(
        !t3.seen.lock().unwrap().iter().any(|s| s.starts_with("allowed?")),
        "{:?}",
        t3.seen.lock().unwrap()
    );
}

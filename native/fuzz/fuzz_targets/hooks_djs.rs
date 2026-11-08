//! Tier-2 hooks at the script↔host boundary with guest-controlled input:
//! request/response heads and bodies go into fixed policies, some of which
//! echo guest data back into their decisions (headers, status, URL, method,
//! body), so the shim's and the host's decision validation see arbitrary
//! values. Every call must end in a decision or a `HookError`, never a panic.
#![no_main]

use std::sync::OnceLock;

use arbitrary::Arbitrary;
use gondolin_egress::{
    Blocked, HookBackend, HookBody, PullableBody, RequestHead, ResponseHead,
};
use gondolin_hooks_djs::DjsHooks;
use gondolin_proto::net::{DjsHookLimits, DjsHooksConfig, NetLimits};
use libfuzzer_sys::fuzz_target;

const POLICIES: &[&str] = &[
    // echo: the guest's body says what to decide
    r#"async function onRequest(req) {
        let d; try { d = JSON.parse(await req.clone().text()); } catch { d = null; }
        if (d === null || typeof d !== "object") { req.headers.set("x-raw", req.url); return; }
        if (d.block) throw new HttpRequestBlockedError(d.message, d.status, d.statusText);
        if (d.respond) return new Response(d.body ?? null, { status: d.status, statusText: d.statusText, headers: d.headers });
        return new Request(d.url ?? req.url, { method: d.method, headers: d.headers ?? req.headers, body: d.body });
    }
    async function onResponse(res, req) {
        const t = await res.text();
        return new Response(t, { status: res.status, headers: [...res.headers, ["x-url", req.url]] });
    }"#,
    // URL and header plumbing on guest values
    r#"function onRequest(req) {
        const u = new URL(req.url);
        for (const [k, v] of req.headers) {
            if (k === "x-path") u.pathname = v;
            if (k === "x-host") u.host = v;
            if (k === "x-search") u.search = v;
            u.searchParams.append(k, v);
        }
        req.headers.append("x-origin", u.origin);
        return new Request(u.href, req);
    }
    function isRequestAllowed(req) { return new URLSearchParams(new URL(req.url).search).has("ok"); }"#,
    // bytes and text views of the body
    r#"async function onRequest(req) {
        const b = await req.clone().bytes();
        const t = new TextDecoder().decode(b);
        return new Response(new TextEncoder().encode(t + b.length), { headers: { "x-len": String(t.length) } });
    }
    async function onResponse(res) { return new Response(await res.arrayBuffer(), res); }"#,
];

fn backends() -> &'static Vec<DjsHooks> {
    static B: OnceLock<Vec<DjsHooks>> = OnceLock::new();
    B.get_or_init(|| {
        POLICIES
            .iter()
            .map(|p| {
                let cfg = DjsHooksConfig {
                    source: (*p).into(),
                    limits: DjsHookLimits {
                        fuel: Some(5_000_000),
                        memory_bytes: Some(8 << 20),
                        timeout_ms: Some(5_000),
                    },
                    ..Default::default()
                };
                DjsHooks::new(&cfg, &NetLimits::default()).expect("fuzz policy compiles")
            })
            .collect()
    })
}

fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    })
}

#[derive(Debug, Arbitrary)]
struct Input {
    policy: u8,
    response: bool,
    gzip: bool,
    status: u16,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fuzz_target!(|input: Input| {
    let hooks = &backends()[input.policy as usize % POLICIES.len()];
    let url = if input.url.starts_with("http") { input.url.clone() } else { format!("http://a.test/{}", input.url) };
    let head = RequestHead { method: input.method.clone(), url, headers: input.headers.clone() };
    let body = PullableBody::new(HookBody::full(input.body.clone()), 1 << 20, Blocked::forbidden("limit"));
    runtime().block_on(async {
        if input.response {
            let mut headers = input.headers.clone();
            if input.gzip {
                headers.push(("content-encoding".into(), "gzip".into()));
            }
            let res = ResponseHead { status: input.status, status_text: "OK".into(), headers };
            let _ = hooks.on_response(res, Some(body.handle()), head).await;
        } else {
            let _ = hooks.is_request_allowed(&head).await;
            let _ = hooks.on_request(head, Some(body.handle())).await;
        }
    });
    drop(body);
});

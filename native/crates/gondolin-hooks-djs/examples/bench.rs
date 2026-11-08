//! Per-call cost of tier-2 hooks in process (no VM, no network): the
//! prototype's policies (native/docs/djs-hooks.md §4) through `DjsHooks`,
//! with pooled (reset) and fresh instances, one and eight callers.
//!
//! usage: cargo run --release -p gondolin-hooks-djs --example bench [-- CALLS [caps]]
//!
//! `caps`: instead, body reads of growing size against the idle-heap cap of
//! pooled instances (what a call costs when its instance was shrunk).

use std::sync::Arc;
use std::time::Instant;

use gondolin_egress::{Blocked, HookBackend, HookBody, PullableBody, RequestHead};
use gondolin_hooks_djs::DjsHooks;
use gondolin_proto::net::{DjsHooksConfig, NetLimits};

const NOOP: &str = "function onRequest(req) {}";
const ALLOWLIST: &str = r#"
const ALLOWED = ["api.example.com", "*.github.com", "registry.npmjs.org"];
const SECRETS = { GONDOLIN_SECRET_GH_TOKEN: ["api.github.com"] };
function hostAllowed(host) {
  return ALLOWED.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) : host === p));
}
async function onRequest(req) {
  const url = new URL(req.url);
  if (!hostAllowed(url.hostname)) return new Response(`blocked: ${url.hostname}`, { status: 403 });
  for (const [name, value] of req.headers) {
    for (const [placeholder, hosts] of Object.entries(SECRETS)) {
      if (value.includes(placeholder) && !hosts.includes(url.hostname)) {
        return new Response(`secret ${placeholder} not allowed in ${name}`, { status: 403 });
      }
    }
  }
  req.headers.set("x-gondolin-policy", "v1");
  req.headers.delete("x-debug-token");
  return req;
}"#;
const BODY: &str = r#"
async function onRequest(req) {
  const text = await req.clone().text();
  if (text.includes("forbidden-marker")) return new Response("no", { status: 403 });
}"#;

fn head() -> RequestHead {
    RequestHead {
        method: "POST".into(),
        url: "https://api.github.com/repos/earendil-works/gondolin/issues?per_page=100".into(),
        headers: [
            ("host", "api.github.com"),
            ("user-agent", "curl/8.5.0"),
            ("accept", "application/vnd.github+json"),
            ("authorization", "Bearer GONDOLIN_SECRET_GH_TOKEN"),
            ("x-github-api-version", "2022-11-28"),
            ("content-type", "application/json"),
            ("x-debug-token", "abc"),
            ("accept-encoding", "gzip"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect(),
    }
}

async fn one(hooks: &DjsHooks, body: Option<&bytes::Bytes>) {
    let p = body
        .map(|b| PullableBody::new(HookBody::full(b.clone()), 1 << 30, Blocked::forbidden("x")));
    hooks.on_request(head(), p.as_ref().map(PullableBody::handle)).await.expect("hook call");
}

/// p50 of `calls` sequential calls in µs.
fn p50(
    rt: &tokio::runtime::Runtime,
    hooks: &DjsHooks,
    body: Option<&bytes::Bytes>,
    calls: usize,
) -> f64 {
    rt.block_on(async {
        for _ in 0..calls / 10 + 1 {
            one(hooks, body).await;
        }
        let mut samples: Vec<f64> = Vec::with_capacity(calls);
        for _ in 0..calls {
            let t = Instant::now();
            one(hooks, body).await;
            samples.push(t.elapsed().as_secs_f64() * 1e6);
        }
        samples.sort_by(f64::total_cmp);
        samples[calls / 2]
    })
}

fn caps(calls: usize) {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let variants: [(&str, Option<usize>); 5] = [
        ("fresh instance", None),
        ("pooled, no shrink", Some(usize::MAX)),
        ("pooled, cap 4 MiB", Some(4 << 20)),
        ("pooled, cap 1 MiB", Some(1 << 20)),
        ("pooled, shrink to 0", Some(0)),
    ];
    print!("| body read as text |");
    for (v, _) in &variants {
        print!(" {v} |");
    }
    println!("\n|---|{}", "---:|".repeat(variants.len()));
    for size in [0usize, 64 << 10, 256 << 10, 1 << 20, 4 << 20, 16 << 20] {
        let body = bytes::Bytes::from(vec![b'a'; size.max(1)]);
        print!("| {} KiB |", size >> 10);
        for (_, cap) in &variants {
            let cfg = DjsHooksConfig { source: BODY.into(), ..Default::default() };
            let hooks = DjsHooks::new(&cfg, &NetLimits::default()).unwrap();
            match cap {
                None => hooks.set_pooling(false),
                Some(c) => hooks.set_idle_heap_cap(*c),
            }
            let n = (calls * 64 / (size / 1024 + 64)).max(50);
            print!(" {:.1} |", p50(&rt, &hooks, Some(&body), n));
        }
        println!();
    }
}

fn main() {
    let calls: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(20_000);
    if std::env::args().nth(2).as_deref() == Some("caps") {
        return caps(calls);
    }
    let rt =
        tokio::runtime::Builder::new_multi_thread().worker_threads(8).enable_all().build().unwrap();
    let body = bytes::Bytes::from(vec![b'a'; 64 * 1024]);
    println!("| policy | instances | p50 µs | p99 µs | calls/s (1 caller) | calls/s (8 callers) |");
    println!("|---|---|---:|---:|---:|---:|");
    for (name, src, with_body) in [
        ("empty", NOOP, false),
        ("header-only allowlist", ALLOWLIST, false),
        ("64 KiB body read as text", BODY, true),
    ] {
        for pooled in [true, false] {
            let cfg = DjsHooksConfig { source: src.into(), ..Default::default() };
            let hooks = Arc::new(DjsHooks::new(&cfg, &NetLimits::default()).unwrap());
            hooks.set_pooling(pooled);
            let b = with_body.then(|| body.clone());
            let (p50, p99, rate1) = rt.block_on(async {
                for _ in 0..calls / 10 {
                    one(&hooks, b.as_ref()).await;
                }
                let mut samples = Vec::with_capacity(calls);
                let start = Instant::now();
                for _ in 0..calls {
                    let t = Instant::now();
                    one(&hooks, b.as_ref()).await;
                    samples.push(t.elapsed().as_secs_f64() * 1e6);
                }
                let rate = calls as f64 / start.elapsed().as_secs_f64();
                samples.sort_by(f64::total_cmp);
                (samples[calls / 2], samples[calls * 99 / 100], rate)
            });
            let rate8 = rt.block_on(async {
                let start = Instant::now();
                let tasks: Vec<_> = (0..8)
                    .map(|_| {
                        let hooks = hooks.clone();
                        let b = b.clone();
                        tokio::spawn(async move {
                            for _ in 0..calls / 8 {
                                one(&hooks, b.as_ref()).await;
                            }
                        })
                    })
                    .collect();
                for t in tasks {
                    t.await.unwrap();
                }
                (calls / 8 * 8) as f64 / start.elapsed().as_secs_f64()
            });
            println!(
                "| {name} | {} | {p50:.1} | {p99:.1} | {rate1:.0} | {rate8:.0} |",
                if pooled { "pooled (reset)" } else { "fresh" }
            );
        }
    }
}

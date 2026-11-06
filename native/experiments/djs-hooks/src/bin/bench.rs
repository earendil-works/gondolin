//! Per-call cost of tier-2 (djs) hooks against tier 3 (a node controller over
//! the controller protocol) and a native Rust closure.
//!
//! usage: cargo run --release --bin bench [-- <calls>]

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use djs_hooks_experiment::{DjsHooks, Limits, Mode};
use gondolin_egress::{
    Blocked, BodyHandle, ControllerLink, HookBackend, HookError, PullableBody, RemoteHooks,
    RequestDecision, RequestHead, ResponseHead, full_body,
};
use gondolin_proto::net::{
    BodyChunk, BodyHookRegistration, BodyPull, HookCall, HookDecision, HookRegistrations,
};
use gondolin_wire::{Envelope, FrameReader, FrameWriter, RawEnvelope};
use tokio::process::{ChildStdin, Command};
use tokio::sync::oneshot;

const DIR: &str = env!("CARGO_MANIFEST_DIR");

fn policy(name: &str) -> String {
    std::fs::read_to_string(format!("{DIR}/policies/{name}.js")).unwrap()
}

fn header_request(host: &str) -> RequestHead {
    RequestHead {
        method: "GET".into(),
        url: format!("https://{host}/repos/earendil-works/gondolin/pulls?state=open&per_page=50"),
        headers: vec![
            ("host".into(), host.into()),
            ("user-agent".into(), "curl/8.7.1".into()),
            ("accept".into(), "application/vnd.github+json".into()),
            ("accept-encoding".into(), "gzip, deflate, br".into()),
            ("authorization".into(), "Bearer GONDOLIN_SECRET_GH_TOKEN".into()),
            ("x-github-api-version".into(), "2022-11-28".into()),
            ("x-debug-token".into(), "abc".into()),
            ("connection".into(), "keep-alive".into()),
        ],
    }
}

fn body_request() -> (RequestHead, Vec<u8>) {
    let mut body = Vec::with_capacity(64 * 1024);
    body.extend_from_slice(b"{\"rows\":[");
    while body.len() < 64 * 1024 - 64 {
        body.extend_from_slice(b"{\"id\":12345,\"name\":\"gondolin\",\"tags\":[\"a\",\"b\"]},");
    }
    body.extend_from_slice(b"{}]}");
    body.resize(64 * 1024, b' ');
    let head = RequestHead {
        method: "POST".into(),
        url: "https://api.example.com/upload".into(),
        headers: vec![
            ("host".into(), "api.example.com".into()),
            ("content-type".into(), "application/json".into()),
            ("content-length".into(), body.len().to_string()),
        ],
    };
    (head, body)
}

/// Native baseline: the same allowlist policy as a Rust closure.
struct Native;

#[async_trait]
impl HookBackend for Native {
    fn registrations(&self) -> HookRegistrations {
        HookRegistrations {
            on_request: Some(BodyHookRegistration { body: true }),
            ..Default::default()
        }
    }

    async fn on_request(
        &self,
        mut request: RequestHead,
        body: Option<BodyHandle>,
    ) -> Result<RequestDecision, HookError> {
        if let Some(body) = body {
            let data = body.read_to_end().await.map_err(|e| HookError::Failed(e.to_string()))?;
            if String::from_utf8_lossy(&data).contains("DROP TABLE") {
                return Ok(RequestDecision::Respond {
                    head: ResponseHead { status: 400, status_text: String::new(), headers: vec![] },
                    body: gondolin_egress::BodyChoice::None,
                });
            }
            return Ok(RequestDecision::Continue);
        }
        let url = url::Url::parse(&request.url).map_err(|e| HookError::Failed(e.to_string()))?;
        let host = url.host_str().unwrap_or("");
        if !(host == "api.example.com"
            || host.ends_with(".github.com")
            || host == "registry.npmjs.org")
        {
            return Ok(RequestDecision::Respond {
                head: ResponseHead { status: 403, status_text: String::new(), headers: vec![] },
                body: gondolin_egress::BodyChoice::None,
            });
        }
        request.set_header("x-gondolin-policy", "v1");
        request.remove_header("x-debug-token");
        Ok(RequestDecision::Request { head: request, body: gondolin_egress::BodyChoice::Original })
    }
}

/// Tier 3: a node controller child process speaking the controller protocol.
struct NodeLink {
    stdin: tokio::sync::Mutex<FrameWriter<ChildStdin>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<RawEnvelope>>>,
    next: std::sync::atomic::AtomicU64,
    hooks: OnceLock<Arc<RemoteHooks>>,
}

#[async_trait]
impl ControllerLink for NodeLink {
    async fn hook_call(&self, call: HookCall) -> Result<HookDecision, String> {
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        {
            let mut w = self.stdin.lock().await;
            w.write_message(&Envelope::new("hook_call", id, call))
                .await
                .map_err(|e| e.to_string())?;
            w.flush().await.map_err(|e| e.to_string())?;
        }
        let env = rx.await.map_err(|e| e.to_string())?;
        env.payload::<HookDecision>().map_err(|e| format!("{e}: {:?}", env.p))
    }

    async fn body_pull(&self, _pull: BodyPull) -> Result<BodyChunk, String> {
        Err("not used".into())
    }

    fn body_release(&self, _stream: u64) {}
}

async fn spawn_node(policy_name: &str, body: bool) -> Arc<RemoteHooks> {
    let mut child = Command::new("node")
        .arg(format!("{DIR}/node/controller.mts"))
        .arg(format!("{DIR}/policies/{policy_name}.js"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("node");
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let link = Arc::new(NodeLink {
        stdin: tokio::sync::Mutex::new(FrameWriter::new(stdin)),
        pending: Mutex::new(HashMap::new()),
        next: 1.into(),
        hooks: OnceLock::new(),
    });
    let regs =
        HookRegistrations { on_request: Some(BodyHookRegistration { body }), ..Default::default() };
    let hooks = Arc::new(RemoteHooks::new(link.clone(), regs));
    link.hooks.set(hooks.clone()).ok();
    let reader_link = link.clone();
    tokio::spawn(async move {
        let _child = child;
        let mut r = FrameReader::new(stdout);
        while let Ok(Some(env)) = r.read_envelope().await {
            match env.t.as_str() {
                "hook_call_result" => {
                    if let Some(tx) = reader_link.pending.lock().unwrap().remove(&env.id) {
                        tx.send(env).ok();
                    }
                }
                "body_pull" => {
                    let link = reader_link.clone();
                    tokio::spawn(async move {
                        let pull: BodyPull = env.payload().unwrap();
                        let hooks = link.hooks.get().unwrap();
                        let chunk = hooks.serve_body_pull(pull).await.unwrap();
                        let mut w = link.stdin.lock().await;
                        w.write_message(&Envelope::new("body_pull_result", env.id, chunk))
                            .await
                            .unwrap();
                        w.flush().await.unwrap();
                    });
                }
                "body_release" => {
                    #[derive(serde::Deserialize)]
                    struct Release {
                        stream: u64,
                    }
                    if let Ok(r) = env.payload::<Release>() {
                        reader_link.hooks.get().unwrap().serve_body_release(r.stream);
                    }
                }
                _ => {}
            }
        }
    });
    hooks
}

fn describe(d: &RequestDecision) -> String {
    match d {
        RequestDecision::Continue => "continue".into(),
        RequestDecision::Request { head, .. } => format!(
            "request x-gondolin-policy={:?} x-debug-token={:?}",
            head.header("x-gondolin-policy"),
            head.header("x-debug-token")
        ),
        RequestDecision::Respond { head, .. } => format!("respond {}", head.status),
    }
}

async fn one(hooks: &dyn HookBackend, head: &RequestHead, body: Option<&[u8]>) -> RequestDecision {
    match body {
        None => hooks.on_request(head.clone(), None).await.unwrap(),
        Some(data) => {
            let pb = PullableBody::new(
                full_body(bytes::Bytes::copy_from_slice(data)),
                1 << 20,
                Blocked::forbidden("too large"),
            );
            let d = hooks.on_request(head.clone(), Some(pb.handle())).await.unwrap();
            pb.discard().await;
            d
        }
    }
}

struct Stats {
    p50: Duration,
    p99: Duration,
    rate: f64,
}

async fn measure(
    hooks: Arc<dyn HookBackend>,
    head: &RequestHead,
    body: Option<&[u8]>,
    calls: usize,
) -> Stats {
    for _ in 0..calls.min(200) {
        one(&*hooks, head, body).await;
    }
    let mut lat = Vec::with_capacity(calls);
    let start = Instant::now();
    for _ in 0..calls {
        let t = Instant::now();
        one(&*hooks, head, body).await;
        lat.push(t.elapsed());
    }
    let total = start.elapsed();
    lat.sort();
    Stats {
        p50: lat[lat.len() / 2],
        p99: lat[lat.len() * 99 / 100],
        rate: calls as f64 / total.as_secs_f64(),
    }
}

/// Calls/s with `n` concurrent callers on the multi-thread runtime.
async fn concurrent(
    hooks: Arc<dyn HookBackend>,
    head: &RequestHead,
    body: Option<&[u8]>,
    calls: usize,
    n: usize,
) -> f64 {
    let start = Instant::now();
    let mut tasks = Vec::new();
    for _ in 0..n {
        let hooks = hooks.clone();
        let head = head.clone();
        let body = body.map(|b| b.to_vec());
        tasks.push(tokio::spawn(async move {
            for _ in 0..calls / n {
                one(&*hooks, &head, body.as_deref()).await;
            }
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    (calls / n * n) as f64 / start.elapsed().as_secs_f64()
}

fn us(d: Duration) -> String {
    format!("{:.1}", d.as_secs_f64() * 1e6)
}

#[tokio::main(flavor = "multi_thread", worker_threads = 8)]
async fn main() {
    let calls: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(5000);
    let allow = policy("allowlist");
    let body_policy = policy("body");

    let t = Instant::now();
    let fresh = Arc::new(DjsHooks::new(&allow, Mode::Fresh, Limits::default(), false).unwrap());
    println!(
        "compile allowlist policy + snapshot: {:?} (image {} KiB)",
        t.elapsed(),
        fresh.image_len() / 1024
    );
    let pooled = Arc::new(DjsHooks::new(&allow, Mode::Pooled, Limits::default(), false).unwrap());
    let noop =
        Arc::new(DjsHooks::new(&policy("noop"), Mode::Pooled, Limits::default(), false).unwrap());
    let text_only = Arc::new(
        DjsHooks::new(&policy("body-text"), Mode::Pooled, Limits::default(), true).unwrap(),
    );
    let bytes_only = Arc::new(
        DjsHooks::new(&policy("body-bytes"), Mode::Pooled, Limits::default(), true).unwrap(),
    );
    let fresh_body =
        Arc::new(DjsHooks::new(&body_policy, Mode::Fresh, Limits::default(), true).unwrap());
    let pooled_body =
        Arc::new(DjsHooks::new(&body_policy, Mode::Pooled, Limits::default(), true).unwrap());

    // Sanity: the decisions.
    for host in ["api.github.com", "evil.example.org", "api.example.com"] {
        let d = one(&*pooled, &header_request(host), None).await;
        println!("  {host}: {}", describe(&d));
    }
    let (bhead, bdata) = body_request();
    println!("  64 KiB body: {}", describe(&one(&*pooled_body, &bhead, Some(&bdata)).await));
    let mut bad = bdata.clone();
    bad[100..110].copy_from_slice(b"DROP TABLE");
    println!("  64 KiB body (bad): {}", describe(&one(&*pooled_body, &bhead, Some(&bad)).await));

    // Fail closed.
    let tight = Limits { fuel: 20_000, slice: 10_000, ..Limits::default() };
    let spin =
        DjsHooks::new("async function onRequest(r) { for (;;) {} }", Mode::Fresh, tight, false)
            .unwrap();
    println!("  fuel exhausted: {:?}", one_err(&spin, &header_request("api.github.com")).await);
    let small = Limits { memory: 4 << 20, ..Limits::default() };
    let hog = DjsHooks::new(
        "async function onRequest(r) { const a = []; for (;;) a.push(new Array(1000).fill(r.url)); }",
        Mode::Fresh,
        small,
        false,
    )
    .unwrap();
    println!("  memory exhausted: {:?}", one_err(&hog, &header_request("api.github.com")).await);
    let throws = DjsHooks::new(
        "function onRequest(r) { return 42; }",
        Mode::Fresh,
        Limits::default(),
        false,
    )
    .unwrap();
    println!("  bad return: {:?}", one_err(&throws, &header_request("api.github.com")).await);
    let pending = DjsHooks::new(
        "function onRequest(r) { return new Promise(() => {}); }",
        Mode::Fresh,
        Limits::default(),
        false,
    )
    .unwrap();
    println!("  never settles: {:?}", one_err(&pending, &header_request("api.github.com")).await);
    let blocks = DjsHooks::new(
        "function onRequest(r) { throw new HttpRequestBlockedError('no', 451, 'Unavailable'); }",
        Mode::Fresh,
        Limits::default(),
        false,
    )
    .unwrap();
    println!("  blocked: {:?}", one_err(&blocks, &header_request("api.github.com")).await);
    println!(
        "  syntax error: {:?}",
        DjsHooks::new("function (", Mode::Fresh, Limits::default(), false).err()
    );

    let node = spawn_node("allowlist", false).await;
    let node_body = spawn_node("body", true).await;
    println!(
        "  node allowlist: {}",
        describe(&one(&*node, &header_request("api.github.com"), None).await)
    );
    println!("  node body: {}", describe(&one(&*node_body, &bhead, Some(&bad)).await));

    let gh = header_request("api.github.com");
    println!();
    println!(
        "| engine | hook | p50 µs | p99 µs | calls/s (1 caller) | calls/s (8 callers) | fuel/call |"
    );
    println!("|---|---|---:|---:|---:|---:|---:|");
    let rows: Vec<(&str, &str, Arc<dyn HookBackend>, bool)> = vec![
        ("native Rust", "header-only", Arc::new(Native), false),
        ("djs pooled VM", "empty policy", noop.clone(), false),
        ("djs fresh VM", "header-only", fresh.clone(), false),
        ("djs pooled VM", "header-only", pooled.clone(), false),
        ("node tier 3", "header-only", node.clone(), false),
        ("native Rust", "64 KiB body", Arc::new(Native), true),
        ("djs pooled VM", "64 KiB as text, unused", text_only.clone(), true),
        ("djs pooled VM", "64 KiB as bytes, unused", bytes_only.clone(), true),
        ("djs fresh VM", "64 KiB body", fresh_body.clone(), true),
        ("djs pooled VM", "64 KiB body", pooled_body.clone(), true),
        ("node tier 3", "64 KiB body", node_body.clone(), true),
    ];
    for (name, kind, hooks, with_body) in rows {
        let (head, body) = if with_body { (&bhead, Some(&bdata[..])) } else { (&gh, None) };
        let n = if name.starts_with("node") { calls.min(5000) } else { calls };
        let s = measure(hooks.clone(), head, body, n).await;
        let c = concurrent(hooks.clone(), head, body, n * 2, 8).await;
        let fuel = if name.starts_with("djs") {
            djs_hooks_experiment::LAST_FUEL.load(std::sync::atomic::Ordering::Relaxed).to_string()
        } else {
            "–".into()
        };
        println!(
            "| {name} | {kind} | {} | {} | {:.0} | {:.0} | {fuel} |",
            us(s.p50),
            us(s.p99),
            s.rate,
            c
        );
    }
}

async fn one_err(hooks: &DjsHooks, head: &RequestHead) -> String {
    match hooks.on_request(head.clone(), None).await {
        Ok(d) => format!("unexpected: {}", describe(&d)),
        Err(HookError::Blocked(b)) => {
            format!("blocked {} {}: {}", b.status, b.status_text, b.message)
        }
        Err(e) => e.to_string(),
    }
}

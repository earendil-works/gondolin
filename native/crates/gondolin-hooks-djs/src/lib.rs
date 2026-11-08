//! Tier-2 network hooks: a JavaScript policy (`configure.net.djs_hooks`) run
//! inside gondolind on djs, Earendil's embeddable JavaScript engine.
//!
//! [`DjsHooks::new`] compiles the shim (`shim.js`: a restricted
//! `Headers`/`URL`/`Request`/`Response`, `HttpRequestBlockedError`,
//! `console`) and the policy once into a snapshot; each hook call runs in an
//! instance reset to that snapshot, so no state survives between calls. Only
//! the phases the policy defines are registered (`isRequestAllowed`,
//! `isIpAllowed`, `onRequest`, `onResponse`), so egress keeps its early
//! policy fast path for the others. Bodies stay on the host until the policy
//! reads them (an async host function over egress's lazy [`BodyHandle`]).
//!
//! Fail closed: an exception, a rejected promise, running out of fuel,
//! memory or time, a promise that never settles, a malformed decision or an
//! engine panic is [`HookError::Failed`] (egress answers `502`);
//! `HttpRequestBlockedError` is [`HookError::Blocked`] with its status.
//!
//! Every djs API use is in [`engine`] (the adapter); this module maps egress
//! types to plain data and decisions back.

mod decode;
mod engine;
mod url;

use std::time::Duration;

use gondolin_egress::{
    Blocked, BodyChoice, BodyHandle, HookBackend, HookError, IpAllowInfo, PullError,
    RequestDecision, RequestHead, ResponseDecision, ResponseHead, full_body,
};
use gondolin_proto::net::{
    BodyHookRegistration, DjsHooksConfig, DjsSourceKind, HookRegistrations, NetLimits,
};
use gondolin_wire::Value;

pub use engine::Phases;
use engine::{Entry, Host, Limits, PolicySource, Program, SourceKind};

/// Default fuel per call (about 0.2 s of interpretation)
pub const DEFAULT_FUEL: u64 = 50_000_000;
/// Default heap cap per call in `bytes`
pub const DEFAULT_MEMORY_BYTES: u64 = 64 << 20;
/// Default wall-clock limit per call in `ms` (body reads included)
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Smallest accepted heap cap in `bytes` (the snapshot alone needs a few hundred KiB)
const MIN_MEMORY_BYTES: u64 = 1 << 20;

const REQUEST_BODY: i32 = 1;
const RESPONSE_BODY: i32 = 2;

/// Statuses whose responses have no body.
const NULL_BODY_STATUSES: [u16; 5] = [101, 103, 204, 205, 304];

/// Why a policy did not compile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileError(pub String);

impl std::fmt::Display for CompileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "djs_hooks: {}", self.0)
    }
}

impl std::error::Error for CompileError {}

/// A compiled tier-2 policy as a [`HookBackend`].
#[derive(Debug)]
pub struct DjsHooks {
    program: Program,
    timeout: Duration,
    /// cap of a decoded response body in `bytes`
    max_response_body_bytes: u64,
}

impl DjsHooks {
    /// Compiles `config`; `limits` are the egress body limits (decoded
    /// response bodies are bounded by `max_response_body_bytes`).
    pub fn new(config: &DjsHooksConfig, limits: &NetLimits) -> Result<Self, CompileError> {
        let fuel = config.limits.fuel.unwrap_or(DEFAULT_FUEL);
        let memory = config.limits.memory_bytes.unwrap_or(DEFAULT_MEMORY_BYTES);
        let timeout_ms = config.limits.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        if fuel == 0 {
            return Err(CompileError("limits.fuel must be positive".into()));
        }
        if memory < MIN_MEMORY_BYTES || memory > usize::MAX as u64 {
            return Err(CompileError(format!(
                "limits.memory_bytes must be at least {MIN_MEMORY_BYTES}"
            )));
        }
        if timeout_ms == 0 {
            return Err(CompileError("limits.timeout_ms must be positive".into()));
        }
        let kind = match config.kind {
            DjsSourceKind::Script => SourceKind::Script,
            DjsSourceKind::Module => SourceKind::Module,
            DjsSourceKind::TypeScript => SourceKind::TypeScript,
        };
        let filename = config.filename.as_deref().unwrap_or(match kind {
            SourceKind::Script => "policy.js",
            SourceKind::Module => "policy.mjs",
            SourceKind::TypeScript => "policy.ts",
        });
        if config.modules.contains_key(filename) {
            return Err(CompileError(format!("modules: {filename} is the policy's own name")));
        }
        let source = PolicySource {
            source: &config.source,
            filename,
            kind,
            modules: config.modules.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect(),
        };
        let timeout = Duration::from_millis(timeout_ms);
        let program = Program::compile(&source, Limits { fuel, memory: memory as usize, timeout })
            .map_err(CompileError)?;
        Ok(Self { program, timeout, max_response_body_bytes: limits.max_response_body_bytes })
    }

    /// Phases the policy defines.
    pub fn phases(&self) -> Phases {
        self.program.phases()
    }

    /// Reuse instances reset to the snapshot (default) or make a fresh one
    /// per call; both give every call the snapshot's state (benchmarks).
    #[doc(hidden)]
    pub fn set_pooling(&self, on: bool) {
        self.program.set_pooling(on);
    }

    /// Heap an idle pooled instance keeps in `bytes` (benchmarks).
    #[doc(hidden)]
    pub fn set_idle_heap_cap(&self, bytes: usize) {
        self.program.set_idle_heap_cap(bytes);
    }

    /// Heap sizes of the idle pooled instances in `bytes` (tests).
    #[doc(hidden)]
    pub fn idle_heap_sizes(&self) -> Vec<usize> {
        self.program.idle_heap_sizes()
    }

    /// Snapshot size in `bytes`.
    pub fn image_len(&self) -> usize {
        self.program.image_len()
    }

    async fn call(&self, entry: Entry<'_>, host: &mut CallHost<'_>) -> Result<Value, HookError> {
        match tokio::time::timeout(self.timeout, self.program.call(entry, host)).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(msg)) => Err(fail(msg)),
            Err(_) => Err(fail("hook exceeded its time limit".into())),
        }
    }
}

fn fail(msg: String) -> HookError {
    gondolin_log::debug!(target: "gondolin::hooks", "tier-2 hook failed: {msg}");
    HookError::Failed(format!("tier-2 hook: {msg}"))
}

/// Host work of one call: the bodies it may read.
struct CallHost<'a> {
    request: Option<&'a BodyHandle>,
    response: Option<&'a BodyHandle>,
    /// coding the hook sees the response body decoded from
    coding: Option<decode::Coding>,
    max_decoded: u64,
}

impl Host for CallHost<'_> {
    fn log(&mut self, level: &str, text: &str) {
        match level {
            "error" => gondolin_log::error!(target: "gondolin::hooks", "{text}"),
            "warn" => gondolin_log::warn!(target: "gondolin::hooks", "{text}"),
            _ => gondolin_log::debug!(target: "gondolin::hooks", "{text}"),
        }
    }

    async fn read_body(&mut self, stream: i32) -> Result<bytes::Bytes, String> {
        let (handle, coding) = match stream {
            REQUEST_BODY => (self.request, None),
            RESPONSE_BODY => (self.response, self.coding),
            _ => (None, None),
        };
        let handle = handle.ok_or("no such body")?;
        let raw = handle.read_to_end().await.map_err(|e| match e {
            PullError::Limit(b) => b.message,
            e => format!("body read failed: {e}"),
        })?;
        match coding {
            None => Ok(raw),
            Some(c) => {
                let limit = usize::try_from(self.max_decoded).unwrap_or(usize::MAX);
                c.decode(&raw, limit).map(bytes::Bytes::from)
            }
        }
    }
}

// ---- decisions ----

fn field<'v>(v: &'v Value, key: &str) -> Option<&'v Value> {
    match v {
        Value::Map(entries) => {
            entries.iter().find(|(k, _)| matches!(k, Value::Text(t) if t == key)).map(|(_, v)| v)
        }
        _ => None,
    }
}

fn text<'v>(v: &'v Value, key: &str) -> Result<&'v str, String> {
    match field(v, key) {
        Some(Value::Text(s)) => Ok(s),
        _ => Err(format!("decision field {key} must be a string")),
    }
}

fn int(v: &Value, key: &str) -> Result<i128, String> {
    match field(v, key) {
        Some(Value::Integer(i)) => Ok(*i),
        _ => Err(format!("decision field {key} must be an integer")),
    }
}

fn is_token(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// `[[name, value], ...]` with valid names (lowercased) and values.
fn headers(v: &Value) -> Result<Vec<(String, String)>, String> {
    let Some(Value::Array(items)) = field(v, "headers") else {
        return Err("decision headers must be an array".into());
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Value::Array(pair) = item else {
            return Err("a header must be a [name, value] pair".into());
        };
        let [Value::Text(name), Value::Text(value)] = pair.as_slice() else {
            return Err("a header must be a [name, value] pair of strings".into());
        };
        if !is_token(name) {
            return Err(format!("invalid header name {name:?}"));
        }
        if value.bytes().any(|b| matches!(b, b'\r' | b'\n' | 0)) {
            return Err(format!("invalid value of header {name}"));
        }
        out.push((name.to_ascii_lowercase(), value.clone()));
    }
    Ok(out)
}

fn request_head(v: &Value) -> Result<RequestHead, String> {
    let head = field(v, "head").ok_or("decision without head")?;
    let method = text(head, "method")?;
    if !is_token(method) {
        return Err(format!("invalid method {method:?}"));
    }
    let url = text(head, "url")?;
    let parsed =
        gondolin_http::url::Url::parse(url).map_err(|e| format!("invalid url {url:?}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported url scheme in {url:?}"));
    }
    Ok(RequestHead { method: method.to_string(), url: url.to_string(), headers: headers(head)? })
}

fn response_head(v: &Value) -> Result<ResponseHead, String> {
    let head = field(v, "head").ok_or("decision without head")?;
    let status = int(head, "status")?;
    if !(200..=599).contains(&status) {
        return Err(format!("invalid response status {status}"));
    }
    let status_text = text(head, "statusText")?;
    if status_text.bytes().any(|b| matches!(b, b'\r' | b'\n' | 0)) {
        return Err("invalid statusText".into());
    }
    Ok(ResponseHead {
        status: status as u16,
        status_text: status_text.to_string(),
        headers: headers(head)?,
    })
}

/// Body of a decision; `original` keeps the host body.
enum Body {
    Original,
    None,
    Data(Vec<u8>),
}

fn body(v: &Value) -> Result<Body, String> {
    let b = field(v, "body").ok_or("decision without body")?;
    match text(b, "kind")? {
        "original" => Ok(Body::Original),
        "none" => Ok(Body::None),
        "text" => Ok(Body::Data(text(b, "text")?.as_bytes().to_vec())),
        "bytes" => match field(b, "bytes") {
            Some(Value::Bytes(data)) => Ok(Body::Data(data.clone())),
            _ => Err("decision body bytes must be a Uint8Array".into()),
        },
        k => Err(format!("unknown body kind {k:?}")),
    }
}

fn choice(b: Body) -> BodyChoice {
    match b {
        Body::Original => BodyChoice::Original,
        Body::None => BodyChoice::None,
        Body::Data(d) => BodyChoice::Body(full_body(d)),
    }
}

/// `block` decisions (`HttpRequestBlockedError`); `None` for other actions.
fn blocked(v: &Value) -> Option<Blocked> {
    if !matches!(field(v, "action"), Some(Value::Text(a)) if a == "block") {
        return None;
    }
    let status = match field(v, "status") {
        Some(Value::Integer(s)) if (100..=599).contains(s) => *s as u16,
        _ => 403,
    };
    let status_text = match field(v, "statusText") {
        Some(Value::Text(t)) if !t.is_empty() && !t.bytes().any(|b| b < 0x20) => t.clone(),
        _ => default_reason(status).to_string(),
    };
    let message = match field(v, "message") {
        Some(Value::Text(m)) => m.clone(),
        _ => "request blocked".to_string(),
    };
    Some(Blocked { status, status_text, message })
}

fn default_reason(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Blocked",
    }
}

fn action(v: &Value) -> Result<&str, HookError> {
    if let Some(b) = blocked(v) {
        return Err(HookError::Blocked(b));
    }
    text(v, "action").map_err(fail)
}

fn allowed(v: &Value) -> Result<bool, HookError> {
    match action(v)? {
        "allowed" => match field(v, "allowed") {
            Some(Value::Bool(b)) => Ok(*b),
            _ => Err(fail("allowed decision without a boolean".into())),
        },
        a => Err(fail(format!("unexpected decision {a:?}"))),
    }
}

/// Response head as the hook sees it: decoded bodies lose their
/// `content-encoding`/`content-length` (as tier 3's `DecompressionStream`).
fn hook_response_view(
    head: &ResponseHead,
    has_body: bool,
) -> (ResponseHead, Option<decode::Coding>) {
    let coding =
        if has_body { head.header("content-encoding").and_then(decode::Coding::of) } else { None };
    let mut view = head.clone();
    if coding.is_some() {
        view.remove_header("content-encoding");
        view.remove_header("content-length");
    }
    (view, coding)
}

impl HookBackend for DjsHooks {
    fn registrations(&self) -> HookRegistrations {
        let p = self.program.phases();
        // bodies are offered lazily: an unread body costs nothing
        HookRegistrations {
            is_request_allowed: p.is_request_allowed,
            is_ip_allowed: p.is_ip_allowed,
            on_request: p.on_request.then_some(BodyHookRegistration { body: true }),
            on_response: p.on_response.then_some(BodyHookRegistration { body: true }),
        }
    }

    fn is_request_allowed<'a>(
        &'a self,
        request: &'a RequestHead,
    ) -> gondolin_egress::BoxFuture<'a, Result<bool, HookError>> {
        Box::pin(async move {
            let mut host = CallHost { request: None, response: None, coding: None, max_decoded: 0 };
            let d = self.call(Entry::IsRequestAllowed(request), &mut host).await?;
            allowed(&d)
        })
    }

    fn is_ip_allowed<'a>(
        &'a self,
        info: &'a IpAllowInfo,
    ) -> gondolin_egress::BoxFuture<'a, Result<bool, HookError>> {
        Box::pin(async move {
            let mut host = CallHost { request: None, response: None, coding: None, max_decoded: 0 };
            let d = self.call(Entry::IsIpAllowed(info), &mut host).await?;
            allowed(&d)
        })
    }

    fn on_request<'a>(
        &'a self,
        request: RequestHead,
        body: Option<BodyHandle>,
    ) -> gondolin_egress::BoxFuture<'a, Result<RequestDecision, HookError>> {
        Box::pin(async move {
            let stream = if body.is_some() { REQUEST_BODY } else { -1 };
            let mut host =
                CallHost { request: body.as_ref(), response: None, coding: None, max_decoded: 0 };
            let d = self.call(Entry::OnRequest(&request, stream), &mut host).await?;
            match action(&d)? {
                "continue" => Ok(RequestDecision::Continue),
                "request" => {
                    let head = request_head(&d).map_err(fail)?;
                    let b = body_of(&d)?;
                    let b = match b {
                        Body::Original if body.is_none() => Body::None,
                        b => b,
                    };
                    Ok(RequestDecision::Request { head, body: choice(b) })
                }
                "respond" => {
                    let head = response_head(&d).map_err(fail)?;
                    let b = match body_of(&d)? {
                        // `new Response(request.body)`: the request's bytes
                        Body::Original => match &body {
                            Some(h) => Body::Data(
                                h.read_to_end()
                                    .await
                                    .map_err(|e| fail(format!("body read failed: {e}")))?
                                    .to_vec(),
                            ),
                            None => Body::None,
                        },
                        b => b,
                    };
                    Ok(RequestDecision::Respond { head, body: choice(b) })
                }
                a => Err(fail(format!("unexpected onRequest decision {a:?}"))),
            }
        })
    }

    fn on_response<'a>(
        &'a self,
        response: ResponseHead,
        body: Option<BodyHandle>,
        request: RequestHead,
    ) -> gondolin_egress::BoxFuture<'a, Result<ResponseDecision, HookError>> {
        Box::pin(async move {
            let has_body = body.is_some() && !NULL_BODY_STATUSES.contains(&response.status);
            let (view, coding) = hook_response_view(&response, has_body);
            let stream = if has_body { RESPONSE_BODY } else { -1 };
            let mut host = CallHost {
                request: None,
                response: if has_body { body.as_ref() } else { None },
                coding,
                max_decoded: self.max_response_body_bytes,
            };
            let d = self.call(Entry::OnResponse(&view, stream, &request), &mut host).await?;
            match action(&d)? {
                "continue" => Ok(ResponseDecision::Continue),
                "response" => {
                    let mut head = response_head(&d).map_err(fail)?;
                    let b = match body_of(&d)? {
                        Body::Original if !has_body => Body::None,
                        Body::Original => {
                            if let Some(c) =
                                response.header("content-encoding").filter(|_| coding.is_some())
                            {
                                // forwarding the original (still encoded) body: restore its framing
                                let c = c.to_string();
                                head.remove_header("content-length");
                                head.set_header("content-encoding", c);
                            }
                            Body::Original
                        }
                        b => b,
                    };
                    Ok(ResponseDecision::Response { head, body: choice(b) })
                }
                a => Err(fail(format!("unexpected onResponse decision {a:?}"))),
            }
        })
    }
}

fn body_of(d: &Value) -> Result<Body, HookError> {
    body(d).map_err(fail)
}

#[cfg(test)]
mod tests;

//! HTTP/1.x bridging: the guest-facing server and the request pipeline.
//!
//! Order per request: head validation → request + ip policy precheck (when no
//! `on_request` hook can rewrite the request) → for each hop: `on_request`
//! hook → secret substitution → request/ip policy (unless prechecked and the
//! head is unchanged) → upstream fetch (connect-time ip check on new
//! connections) → redirects (re-validated) → `on_response` hook.

use std::sync::Arc;

use bytes::Bytes;
use gondolin_http::client::{ClientError, ClientResponse, Target};
use gondolin_http::head::{canonical_reason, valid_name};
use gondolin_http::server::{Request, Response, ServerConfig};
use gondolin_http::url::Url;
use gondolin_http::{
    Body as _, HeadLimits, Header, Incoming, ParseError, RequestHead as WireHead, Version,
};
use gondolin_proto::net::{HookRegistrations, NetPolicy};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::Shared;
use crate::body::{
    self, HookBody, IdleTimeoutBody, LimitedBody, PullableBody, RecordingBody, find_blocked,
    with_guard,
};
use crate::error::{Blocked, PipelineError};
use crate::headers::{
    coalesce_request_headers, has_upgrade, is_websocket_upgrade, latin1, response_headers,
    strip_hop_by_hop, strip_hop_by_hop_for_websocket, to_header_value, to_wire_headers,
};
use crate::hooks::{
    BodyChoice, HookError, RequestDecision, RequestHead, ResponseDecision, ResponseHead,
};
use crate::secrets::apply_secrets;
use crate::upstream::ConnectBlocked;

/// Max request head size in `bytes` (`MAX_HTTP_HEADER_BYTES`)
pub const MAX_HTTP_HEADER_BYTES: usize = 64 * 1024;
const MAX_HTTP_REDIRECTS: usize = 10;
/// Upstream response head timeout (undici `headersTimeout`)
const UPSTREAM_HEADERS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
/// Max idle time between upstream body chunks (undici `bodyTimeout`)
const UPSTREAM_BODY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
/// Request bodies up to this size in `bytes` are kept for 307/308 replays
const REDIRECT_REPLAY_LIMIT: u64 = 1024 * 1024;

/// URL scheme of the guest connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Http,
    Https,
}

impl Scheme {
    fn as_str(self) -> &'static str {
        match self {
            Scheme::Http => "http",
            Scheme::Https => "https",
        }
    }
}

/// Per-request response context.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ReqCtx {
    pub keep_alive: bool,
}

/// Serves HTTP/1.x on a guest stream until the connection ends.
pub(crate) async fn serve_http<IO>(shared: Arc<Shared>, io: IO, scheme: Scheme, flow_id: u64)
where
    IO: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let ctx = ReqCtx { keep_alive: shared.limits.guest_keep_alive };
    let config = ServerConfig {
        keep_alive: ctx.keep_alive,
        // heads up to this size reach `prepare` (431 with the node message)
        limits: HeadLimits { max_bytes: MAX_HTTP_HEADER_BYTES + 8 * 1024, max_headers: 1024 },
    };
    let svc_shared = shared.clone();
    gondolin_http::server::serve(
        io,
        config,
        move |req| handle_request(svc_shared.clone(), scheme, req),
        move |err| parse_error_response(&ctx, err),
    )
    .await;
    gondolin_log::debug!(target: "gondolin::egress", "http connection ended flow={}", flow_id);
}

/// Response to a request head the server could not parse.
fn parse_error_response(ctx: &ReqCtx, err: &ParseError) -> Response {
    gondolin_log::debug!(target: "gondolin::egress", "http request head invalid: {err}");
    let err = match err {
        ParseError::TooLarge | ParseError::TooManyHeaders => Blocked::new(
            431,
            "Request Header Fields Too Large",
            format!("request headers exceed {MAX_HTTP_HEADER_BYTES} bytes"),
        )
        .into(),
        _ => PipelineError::plain(400, "Bad Request"),
    };
    error_response(ctx, err, 400)
}

/// Request body of one hop.
pub(crate) enum ReqBody {
    Empty,
    Bytes(Bytes),
    Stream(HookBody),
}

impl ReqBody {
    fn is_empty(&self) -> bool {
        match self {
            ReqBody::Empty => true,
            ReqBody::Bytes(b) => b.is_empty(),
            ReqBody::Stream(_) => false,
        }
    }

    fn into_hook_body(self) -> HookBody {
        match self {
            ReqBody::Empty => body::empty(),
            ReqBody::Bytes(b) => body::full(b),
            ReqBody::Stream(s) => s,
        }
    }
}

struct Prepared {
    base: RequestHead,
    body: ReqBody,
    prechecked: bool,
    /// whether the body is the guest's Content-Length stream (keep its header)
    guest_content_length: bool,
    websocket: bool,
}

async fn handle_request(shared: Arc<Shared>, scheme: Scheme, req: Request) -> Response {
    let ctx = ReqCtx { keep_alive: shared.limits.guest_keep_alive };
    let Request { head, body: incoming, upgrade, .. } = req;
    let prepared = match prepare(&shared, scheme, &head, incoming).await {
        Ok(p) => p,
        Err(err) => return error_response(&ctx, err, 400),
    };
    if prepared.websocket {
        return match crate::ws::handle_websocket(
            &shared,
            &ctx,
            head.version,
            upgrade,
            prepared.base,
            prepared.prechecked,
        )
        .await
        {
            Ok(resp) => resp,
            Err(err) => error_response(&ctx, err, 400),
        };
    }
    drop(upgrade);
    let permit = shared.concurrency.clone().acquire_owned().await.ok();
    match fetch_and_respond(&shared, &ctx, prepared).await {
        Ok(mut resp) => {
            resp.body = with_guard(resp.body, permit);
            resp
        }
        Err(err) => error_response(&ctx, err, 502),
    }
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &s[prefix.len()..])
}

fn build_fetch_url(target: &str, host: Option<&str>, scheme: Scheme) -> Option<String> {
    if let Some(rest) = strip_prefix_ci(target, "ws://") {
        return Some(format!("http://{rest}"));
    }
    if let Some(rest) = strip_prefix_ci(target, "wss://") {
        return Some(format!("https://{rest}"));
    }
    if strip_prefix_ci(target, "http://").is_some() || strip_prefix_ci(target, "https://").is_some()
    {
        return Some(target.to_string());
    }
    let host = host.filter(|h| !h.is_empty())?;
    Some(format!("{}://{host}{target}", scheme.as_str()))
}

fn parse_content_length(raw: &str) -> Option<u64> {
    // `Number.parseInt(raw, 10)`: leading digits after optional whitespace
    let trimmed = raw.trim_start();
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u64>().ok().filter(|n| *n < (1u64 << 53))
}

async fn prepare(
    shared: &Shared,
    scheme: Scheme,
    req: &WireHead,
    incoming: Incoming,
) -> Result<Prepared, PipelineError> {
    let method = req.method.clone();
    let target = req.target.clone();
    let head_bytes = method.len()
        + target.len()
        + 11
        + req.headers.iter().map(|h| h.name.len() + h.value.len() + 4).sum::<usize>();
    if head_bytes > MAX_HTTP_HEADER_BYTES {
        return Err(Blocked::new(
            431,
            "Request Header Fields Too Large",
            format!("request headers exceed {MAX_HTTP_HEADER_BYTES} bytes"),
        )
        .into());
    }
    let mut headers = coalesce_request_headers(&req.headers);
    let get = |headers: &[(String, String)], name: &str| {
        crate::hooks::header_get(headers, name).map(str::to_string)
    };

    if req.version == Version::Http11
        && let Some(expect) = get(&headers, "expect")
    {
        let unsupported: Vec<String> = expect
            .to_lowercase()
            .split(',')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty() && t != "100-continue")
            .collect();
        if !unsupported.is_empty() {
            return Err(Blocked::new(
                417,
                "Expectation Failed",
                format!("unsupported expect token(s): {}", unsupported.join(", ")),
            )
            .into());
        }
    }

    if method == "OPTIONS" && target == "*" {
        return Err(PipelineError::plain(501, "Not Implemented"));
    }

    let mut chunked = false;
    let mut content_length = 0u64;
    if let Some(te) = get(&headers, "transfer-encoding") {
        let encodings: Vec<String> =
            te.split(',').map(|v| v.trim().to_lowercase()).filter(|v| !v.is_empty()).collect();
        if encodings.is_empty() || encodings.iter().any(|e| e != "chunked") {
            return Err(Blocked::new(
                501,
                "Not Implemented",
                format!("unsupported transfer-encoding: {te}"),
            )
            .into());
        }
        chunked = true;
    } else if let Some(raw) = get(&headers, "content-length") {
        let Some(n) = parse_content_length(&raw) else {
            return Err(Blocked::bad_request("invalid content-length").into());
        };
        content_length = n;
        crate::hooks::header_set(&mut headers, "content-length", n.to_string());
    }

    let policy = shared.engine.policy();
    let websocket = is_websocket_upgrade(&headers);
    if has_upgrade(&headers) && !(policy.allow_websockets && websocket) {
        return Err(PipelineError::plain(501, "Not Implemented"));
    }

    let Some(url) = build_fetch_url(&target, get(&headers, "host").as_deref(), scheme) else {
        return Err(PipelineError::plain(400, "Bad Request"));
    };
    let parsed = Url::parse(&url).map_err(|_| Blocked::bad_request("invalid url"))?;
    if !target.starts_with('/') && target != "*" {
        // absolute-form: the URL wins over Host (RFC 9112 §3.2.2); keep them
        // consistent so the upstream cannot be steered to another virtual host
        crate::hooks::header_set(&mut headers, "host", target_host(&parsed));
    }

    let base_headers =
        if websocket { strip_hop_by_hop_for_websocket(headers) } else { strip_hop_by_hop(headers) };
    let mut base = RequestHead { method, url: parsed.to_string(), headers: base_headers };

    let max = shared.limits.max_request_body_bytes;
    if !chunked && content_length > max {
        return Err(Blocked::new(
            413,
            "Payload Too Large",
            format!("request body exceeds {max} bytes"),
        )
        .into());
    }

    let prechecked = shared.engine.registrations().on_request.is_none();
    if prechecked {
        shared.engine.ensure_request_allowed(&base).await?;
        ensure_ip_allowed(shared, &parsed).await?;
    }

    if websocket {
        if chunked || content_length > 0 {
            return Err(
                Blocked::bad_request("websocket upgrade requests must not have a body").into()
            );
        }
        return Ok(Prepared {
            base,
            body: ReqBody::Empty,
            prechecked,
            guest_content_length: false,
            websocket,
        });
    }

    let body = if chunked {
        base.remove_header("content-length");
        ReqBody::Stream(HookBody::new(LimitedBody::new(
            incoming,
            max,
            Blocked::new(413, "Payload Too Large", format!("request body exceeds {max} bytes")),
        )))
    } else if content_length > 0 {
        ReqBody::Stream(incoming.boxed())
    } else {
        base.remove_header("content-length");
        ReqBody::Empty
    };
    Ok(Prepared {
        base,
        guest_content_length: !chunked && content_length > 0,
        body,
        prechecked,
        websocket,
    })
}

/// Protocol name of an http(s) URL.
pub(crate) fn url_protocol(url: &Url) -> Option<&'static str> {
    match url.scheme() {
        "http" => Some("http"),
        "https" => Some("https"),
        _ => None,
    }
}

/// `ensureIpAllowed`: resolve and require at least one allowed address.
pub(crate) async fn ensure_ip_allowed(
    shared: &Shared,
    url: &Url,
) -> Result<std::net::IpAddr, PipelineError> {
    let protocol = url_protocol(url).ok_or_else(|| Blocked::bad_request("unsupported protocol"))?;
    let port = url
        .port_or_known_default()
        .filter(|p| *p > 0)
        .ok_or_else(|| Blocked::bad_request("invalid port"))?;
    let host = url.host_str().ok_or_else(|| Blocked::bad_request("invalid url"))?;
    shared.engine.resolve_allowed(host, protocol, port).await
}

/// [`ensure_ip_allowed`] with an earlier lookup result.
async fn ensure_ip_allowed_with(
    shared: &Shared,
    url: &Url,
    ips: Option<Result<Vec<std::net::IpAddr>, Blocked>>,
) -> Result<std::net::IpAddr, PipelineError> {
    let Some(ips) = ips else {
        return ensure_ip_allowed(shared, url).await;
    };
    let protocol = url_protocol(url).ok_or_else(|| Blocked::bad_request("unsupported protocol"))?;
    let port = url
        .port_or_known_default()
        .filter(|p| *p > 0)
        .ok_or_else(|| Blocked::bad_request("invalid port"))?;
    let host = url.host_str().ok_or_else(|| Blocked::bad_request("invalid url"))?;
    shared.engine.resolve_allowed_from(host, protocol, port, ips).await
}

fn hook_error(err: HookError) -> PipelineError {
    match err {
        HookError::Blocked(b) => PipelineError::Blocked(b),
        HookError::Failed(msg) => PipelineError::Other(msg),
    }
}

pub(crate) enum RequestHookOutcome {
    Forward {
        head: RequestHead,
        body: ReqBody,
        /// whether `body` is the body the hook was offered
        original: bool,
    },
    ShortCircuit {
        head: ResponseHead,
        body: HookBody,
    },
}

/// `applyRequestHooks`: tier-3 `on_request`, then declarative secrets.
pub(crate) async fn apply_request_hooks(
    shared: &Shared,
    regs: &HookRegistrations,
    policy: &NetPolicy,
    head: RequestHead,
    body: ReqBody,
) -> Result<RequestHookOutcome, PipelineError> {
    let limits = &shared.limits;
    let (mut head, body, original) = match regs.on_request {
        None => (head, body, true),
        Some(reg) => {
            let has_body = !body.is_empty();
            let upper = head.method.to_ascii_uppercase();
            if has_body && (upper == "GET" || upper == "HEAD") {
                return Err(Blocked::bad_request(format!(
                    "request body not allowed for {upper} in web hooks"
                ))
                .into());
            }
            let max = limits.max_request_body_bytes;
            let too_large = move || {
                Blocked::new(413, "Payload Too Large", format!("request body exceeds {max} bytes"))
            };
            let (pullable, kept) = if reg.body && has_body {
                (Some(PullableBody::new(body.into_hook_body(), max, too_large())), None)
            } else {
                (None, Some(body))
            };
            let handle = pullable.as_ref().map(PullableBody::handle);
            let decision = match shared.engine.hooks().on_request(head.clone(), handle).await {
                Ok(d) => d,
                Err(e) => {
                    discard(pullable).await;
                    return Err(hook_error(e));
                }
            };
            match decision {
                RequestDecision::Continue => (head, restore(pullable, kept).await, true),
                RequestDecision::Request { head: new_head, body: choice } => {
                    let new_head = normalize_request_head(new_head);
                    match choice {
                        BodyChoice::Original => (new_head, restore(pullable, kept).await, true),
                        BodyChoice::None => {
                            discard(pullable).await;
                            (new_head, ReqBody::Empty, false)
                        }
                        BodyChoice::Body(b) => {
                            discard(pullable).await;
                            (
                                new_head,
                                ReqBody::Stream(HookBody::new(LimitedBody::new(
                                    b,
                                    max,
                                    too_large(),
                                ))),
                                false,
                            )
                        }
                    }
                }
                RequestDecision::Respond { head: resp, body: choice } => {
                    discard(pullable).await;
                    let max = limits.max_response_body_bytes;
                    let b = HookBody::new(LimitedBody::new(
                        choice.into_body_or_empty(),
                        max,
                        Blocked::bad_gateway(format!("response body exceeds {max} bytes")),
                    ));
                    return Ok(RequestHookOutcome::ShortCircuit { head: resp, body: b });
                }
            }
        }
    };
    if let Some(rules) = &policy.rules {
        apply_secrets(rules, &mut head)?;
    }
    Ok(RequestHookOutcome::Forward { head, body, original })
}

async fn restore(pullable: Option<PullableBody>, kept: Option<ReqBody>) -> ReqBody {
    match (pullable, kept) {
        (Some(p), _) => ReqBody::Stream(p.into_body().await),
        (None, Some(b)) => b,
        (None, None) => ReqBody::Empty,
    }
}

async fn discard(pullable: Option<PullableBody>) {
    if let Some(p) = pullable {
        p.discard().await;
    }
}

fn normalize_request_head(mut head: RequestHead) -> RequestHead {
    for (k, _) in head.headers.iter_mut() {
        k.make_ascii_lowercase();
    }
    head
}

/// `applyRedirectRequest`.
pub(crate) fn apply_redirect(
    head: &RequestHead,
    status: u16,
    source: &Url,
    target: &Url,
    has_body: bool,
) -> (RequestHead, bool) {
    let mut method = head.method.clone();
    let mut keeps_body = has_body;
    let to_get = (status == 303 && method != "GET" && method != "HEAD")
        || ((status == 301 || status == 302) && method == "POST");
    if to_get {
        method = "GET".into();
        keeps_body = false;
    }
    let mut next = RequestHead { method, url: target.to_string(), headers: head.headers.clone() };
    if next.header("host").is_some() {
        next.set_header("host", target_host(target));
    }
    if !same_origin(source, target) {
        next.remove_header("authorization");
        next.remove_header("cookie");
    }
    if !keeps_body || next.method == "GET" || next.method == "HEAD" {
        next.remove_header("content-length");
        next.remove_header("content-type");
        next.remove_header("transfer-encoding");
    }
    (next, keeps_body)
}

fn target_host(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str().map(str::to_lowercase) == b.host_str().map(str::to_lowercase)
        && a.port_or_known_default() == b.port_or_known_default()
}

fn redirect_target(status: u16, headers: &[Header], current: &Url) -> Option<Url> {
    if ![301, 302, 303, 307, 308].contains(&status) {
        return None;
    }
    let location = gondolin_http::header(headers, "location")?;
    current.join(&latin1(location)).ok()
}

fn client_error(err: ClientError) -> PipelineError {
    if let Some(blocked) = find_blocked(&err) {
        return blocked.into();
    }
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&err);
    while let Some(e) = source {
        if let Some(cb) = e.downcast_ref::<ConnectBlocked>() {
            gondolin_log::debug!(target: "gondolin::egress", "http connect blocked: {}", cb.0.message);
            // node: the guarded lookup failure surfaces as a fetch failure
            return PipelineError::Other(format!("fetch failed: {}", cb.0.message));
        }
        source = e.source();
    }
    let mut msg = err.to_string();
    let mut source = std::error::Error::source(&err);
    while let Some(e) = source {
        msg.push_str(": ");
        msg.push_str(&e.to_string());
        source = e.source();
    }
    gondolin_log::debug!(target: "gondolin::egress", "http bridge fetch failed ({msg})");
    PipelineError::Other(msg)
}

/// An upstream request: destination, method, origin-form target and headers.
struct UpstreamRequest {
    target: Target,
    method: String,
    path: String,
    headers: Vec<Header>,
}

fn build_upstream_request(
    head: &RequestHead,
    url: &Url,
    keep_content_length: bool,
) -> Result<UpstreamRequest, PipelineError> {
    let bad = || PipelineError::plain(400, "Bad Request");
    if !valid_name(head.method.as_bytes()) {
        return Err(bad());
    }
    let https = url_protocol(url).ok_or_else(bad)? == "https";
    let host = url.host_str().filter(|h| !h.is_empty()).ok_or_else(bad)?;
    let port = url.port_or_known_default().ok_or_else(bad)?;
    let path = match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => url.path().to_string(),
    };
    let path = if path.is_empty() { "/".to_string() } else { path };
    let mut headers = to_wire_headers(&head.headers);
    if !keep_content_length {
        headers.retain(|h| h.name != "content-length");
    }
    Ok(UpstreamRequest {
        target: Target { https, host: host.to_string(), port },
        method: head.method.clone(),
        path,
        headers,
    })
}

async fn fetch_and_respond(
    shared: &Shared,
    ctx: &ReqCtx,
    prepared: Prepared,
) -> Result<Response, PipelineError> {
    let mut pending = prepared.base.clone();
    let mut body = prepared.body;
    for redirect_count in 0..=MAX_HTTP_REDIRECTS {
        let first = redirect_count == 0;
        let regs = shared.engine.registrations();
        let policy = shared.engine.policy();
        // resolve the host while the request hook round trip runs (the
        // result is only used if the hook keeps the host)
        let prefetched = (regs.on_request.is_some() && !(first && prepared.prechecked))
            .then(|| Url::parse(&pending.url).ok())
            .flatten()
            .and_then(|u| u.host_str().map(str::to_string))
            .filter(|host| shared.engine.may_prefetch_lookup(host))
            .map(|host| {
                let engine = shared.engine.clone();
                let lookup_host = host.clone();
                (host, tokio::spawn(async move { engine.lookup(&lookup_host).await }))
            });
        let outcome = apply_request_hooks(shared, &regs, &policy, pending.clone(), body).await?;
        let (head, hop_body, original) = match outcome {
            RequestHookOutcome::ShortCircuit { head, body } => {
                return Ok(guest_response(
                    ctx,
                    normalize_hook_response(head, body, &pending.method),
                ));
            }
            RequestHookOutcome::Forward { head, body, original } => (head, body, original),
        };
        gondolin_log::debug!(target: "gondolin::egress", "http bridge {} {}", head.method, head.url);

        let url = Url::parse(&head.url).map_err(|_| PipelineError::plain(400, "Bad Request"))?;
        if url_protocol(&url).is_none() || url.port_or_known_default().is_none_or(|p| p == 0) {
            return Err(PipelineError::plain(400, "Bad Request"));
        }

        let skip = first && prepared.prechecked && !pending.policy_relevant_change(&head);
        if !skip {
            shared.engine.ensure_request_allowed(&head).await?;
            match prefetched {
                Some((host, lookup)) if url.host_str() == Some(host.as_str()) => {
                    let ips =
                        lookup.await.unwrap_or_else(|e| Err(Blocked::bad_gateway(e.to_string())));
                    ensure_ip_allowed_with(shared, &url, Some(ips)).await?;
                }
                other => {
                    if let Some((_, lookup)) = other {
                        lookup.abort();
                    }
                    ensure_ip_allowed(shared, &url).await?;
                }
            }
        } else if let Some((_, lookup)) = prefetched {
            lookup.abort();
        }

        let had_body = !hop_body.is_empty();
        let keep_cl = first && original && prepared.guest_content_length;
        let (upstream_body, recording) = match hop_body {
            ReqBody::Empty => (body::empty(), None),
            ReqBody::Bytes(b) => (body::full(b.clone()), Some(Ok(b))),
            ReqBody::Stream(s) => {
                let (rec, record) = RecordingBody::new(s, REDIRECT_REPLAY_LIMIT);
                (HookBody::new(rec), Some(Err(record)))
            }
        };
        let request = build_upstream_request(&head, &url, keep_cl && had_body)?;
        let fetch = shared.client.request(
            &request.target,
            &request.method,
            &request.path,
            request.headers,
            upstream_body,
        );
        let response = match tokio::time::timeout(UPSTREAM_HEADERS_TIMEOUT, fetch).await {
            Ok(r) => r.map_err(client_error)?,
            Err(_) => return Err(PipelineError::Other("upstream headers timeout".into())),
        };

        let status = response.head.status;
        if let Some(target) = redirect_target(status, &response.head.headers, &url) {
            drop(response);
            if redirect_count >= MAX_HTTP_REDIRECTS {
                return Err(Blocked::new(508, "Loop Detected", "too many redirects").into());
            }
            let (next, keeps_body) = apply_redirect(&head, status, &url, &target, had_body);
            body = if keeps_body {
                let replay = match recording {
                    Some(Ok(b)) => Some(b),
                    Some(Err(record)) => record.lock().unwrap().complete_body(),
                    None => None,
                };
                match replay {
                    Some(b) => ReqBody::Bytes(b),
                    None => {
                        return Err(Blocked::bad_gateway(
                            "redirect requires replaying streamed request body",
                        )
                        .into());
                    }
                }
            } else {
                ReqBody::Empty
            };
            pending = next;
            continue;
        }

        return respond(shared, ctx, &regs, head, response).await;
    }
    Err(Blocked::new(508, "Loop Detected", "too many redirects").into())
}

/// Status text of an upstream response: the received reason phrase (the
/// canonical one when it matches).
pub(crate) fn status_text(status: u16, reason: &[u8]) -> String {
    match canonical_reason(status) {
        Some(c) if c.as_bytes() == reason => c.to_string(),
        _ => latin1(reason),
    }
}

async fn respond(
    shared: &Shared,
    ctx: &ReqCtx,
    regs: &HookRegistrations,
    request: RequestHead,
    response: ClientResponse,
) -> Result<Response, PipelineError> {
    let ClientResponse { head: wire, body: incoming, .. } = response;
    let status = wire.status;
    let mut head = ResponseHead {
        status,
        status_text: status_text(status, &wire.reason),
        headers: strip_hop_by_hop(response_headers(&wire.headers)),
    };
    drop(wire);
    gondolin_log::debug!(target: "gondolin::egress", "http bridge response {} {}", head.status, head.status_text);
    head.set_header("connection", "close");
    let upstream_body = HookBody::new(IdleTimeoutBody::new(incoming, UPSTREAM_BODY_TIMEOUT));

    let is_head = request.method.eq_ignore_ascii_case("HEAD");
    let suppress = is_head || matches!(status, 204 | 205 | 304);
    if suppress {
        drop(upstream_body);
        head.remove_header("transfer-encoding");
        if matches!(status, 204 | 205 | 304) {
            head.remove_header("content-encoding");
            head.set_header("content-length", "0");
        } else if head.header("content-length").is_none() {
            head.set_header("content-length", "0");
        }
        if regs.on_response.is_some() {
            let decision = shared
                .engine
                .hooks()
                .on_response(head.clone(), None, request.clone())
                .await
                .map_err(hook_error)?;
            let (h, b) = match decision {
                ResponseDecision::Continue => (head, body::empty()),
                ResponseDecision::Response { head, body } => (head, body.into_body_or_empty()),
            };
            return Ok(guest_response(ctx, normalize_hook_response(h, b, &request.method)));
        }
        return Ok(guest_response(ctx, (head, body::empty())));
    }

    let Some(reg) = regs.on_response else {
        normalize_stream_framing(&mut head);
        return Ok(guest_response(ctx, (head, upstream_body)));
    };

    let max = shared.limits.max_response_body_bytes;
    let (pullable, kept) = if reg.body {
        let p = PullableBody::new(
            upstream_body,
            max,
            Blocked::bad_gateway(format!("response body exceeds {max} bytes")),
        );
        (Some(p), None)
    } else {
        (None, Some(upstream_body))
    };
    let handle = pullable.as_ref().map(PullableBody::handle);
    let decision =
        match shared.engine.hooks().on_response(head.clone(), handle, request.clone()).await {
            Ok(d) => d,
            Err(e) => {
                discard(pullable).await;
                return Err(hook_error(e));
            }
        };
    let original = async move |pullable: Option<PullableBody>, kept: Option<HookBody>| match (
        pullable, kept,
    ) {
        (Some(p), _) => p.into_body().await,
        (None, Some(b)) => b,
        (None, None) => body::empty(),
    };
    let (h, b) = match decision {
        ResponseDecision::Continue => (head, original(pullable, kept).await),
        ResponseDecision::Response { head, body: choice } => match choice {
            BodyChoice::Original => (head, original(pullable, kept).await),
            BodyChoice::None => {
                discard(pullable).await;
                (head, body::empty())
            }
            BodyChoice::Body(b) => {
                discard(pullable).await;
                (head, b)
            }
        },
    };
    Ok(guest_response(ctx, normalize_hook_response(h, b, &request.method)))
}

/// Response framing for a streamed upstream body: keep a valid
/// Content-Length, otherwise let the server chunk (or close-delimit for HTTP/1.0).
fn normalize_stream_framing(head: &mut ResponseHead) {
    head.remove_header("transfer-encoding");
    let valid = head.header("content-length").is_some_and(|v| v.trim().parse::<u64>().is_ok());
    if !valid {
        head.remove_header("content-length");
    }
}

/// `normalizeHookResponseForGuest`.
pub(crate) fn normalize_hook_response(
    mut head: ResponseHead,
    body: HookBody,
    method: &str,
) -> (ResponseHead, HookBody) {
    let status = head.status;
    let is_head = method.eq_ignore_ascii_case("HEAD");
    let suppress = is_head || matches!(status, 204 | 205 | 304);
    head.set_header("connection", "close");
    head.remove_header("transfer-encoding");
    if head.status_text.is_empty() {
        head.status_text = "OK".into();
    }
    let body = if suppress { body::empty() } else { body };
    if matches!(status, 204 | 205 | 304) {
        head.remove_header("content-encoding");
        head.set_header("content-length", "0");
    } else if is_head {
        if head.header("content-length").is_none() {
            head.set_header("content-length", "0");
        }
    } else {
        match body.size_hint().exact_len() {
            Some(n) => head.set_header("content-length", n.to_string()),
            None => head.remove_header("content-length"),
        }
    }
    (head, body)
}

/// Builds the guest-facing response.
pub(crate) fn guest_response(ctx: &ReqCtx, (mut head, body): (ResponseHead, HookBody)) -> Response {
    if ctx.keep_alive {
        head.remove_header("connection");
    } else {
        head.set_header("connection", "close");
    }
    wire_response(&head, body)
}

/// A response with `head` as given (status out of range: 502).
pub(crate) fn wire_response(head: &ResponseHead, body: HookBody) -> Response {
    let status = if (100..1000).contains(&head.status) { head.status } else { 502 };
    let reason = if canonical_reason(status) != Some(head.status_text.as_str())
        && !head.status_text.is_empty()
    {
        to_header_value(&head.status_text)
    } else {
        None
    };
    Response { status, reason, headers: to_wire_headers(&head.headers), body }
}

/// `respondWithError`: `<status> <text>[: <detail>]\n` as text/plain.
pub(crate) fn error_response(ctx: &ReqCtx, err: PipelineError, default_status: u16) -> Response {
    let (status, text, detail): (u16, String, Option<String>) = match err {
        PipelineError::Blocked(b) => {
            gondolin_log::debug!(target: "gondolin::egress", "http blocked {}", b.message);
            (b.status, b.status_text, Some(b.message))
        }
        PipelineError::Plain { status, status_text } => (status, status_text.to_string(), None),
        PipelineError::Other(msg) => {
            gondolin_log::warn!(target: "gondolin::egress", "http bridge error: {msg}");
            let text = canonical_reason(default_status).unwrap_or("Bad Gateway");
            (default_status, text.to_string(), None)
        }
    };
    let body = match detail {
        Some(d) => format!("{status} {text}: {d}\n"),
        None => format!("{status} {text}\n"),
    };
    let head = ResponseHead {
        status,
        status_text: text,
        headers: vec![
            ("content-length".into(), body.len().to_string()),
            ("content-type".into(), "text/plain".into()),
            ("connection".into(), "close".into()),
        ],
    };
    guest_response(ctx, (head, body::full(body)))
}

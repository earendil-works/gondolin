//! WebSocket upgrades (port of `handleWebSocketUpgrade` and
//! `bridgeWebSocketUpgrade`): the handshake is mediated (hooks, policy), then
//! the connection becomes an opaque tunnel.

use std::time::Duration;

use http::{Request, Response};
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper::ext::ReasonPhrase;
use hyper_util::rt::TokioIo;
use url::Url;

use crate::Shared;
use crate::body::HookBody;
use crate::error::{Blocked, PipelineError};
use crate::headers::{WEBSOCKET_UPGRADE_HEADER_NAMES, latin1, response_headers, to_header_map};
use crate::hooks::{RequestHead, ResponseHead};
use crate::http::{
    ReqBody, ReqCtx, RequestHookOutcome, apply_request_hooks, guest_response,
    normalize_hook_response, url_protocol,
};
use crate::upstream::connect_raw;

pub(crate) async fn handle_websocket(
    shared: &Shared,
    ctx: &ReqCtx,
    req: &mut Request<()>,
    base: RequestHead,
    prechecked: bool,
) -> Result<Response<HookBody>, PipelineError> {
    if req.version() != http::Version::HTTP_11 {
        return Err(
            Blocked::new(501, "Not Implemented", "websocket upgrade requires HTTP/1.1").into()
        );
    }
    if !base.method.eq_ignore_ascii_case("GET") {
        return Err(Blocked::bad_request("websocket upgrade requires GET").into());
    }

    let regs = shared.engine.registrations();
    let policy = shared.engine.policy();
    let outcome = apply_request_hooks(shared, &regs, &policy, base.clone(), ReqBody::Empty).await?;
    let (mut hooked, hooked_body) = match outcome {
        RequestHookOutcome::ShortCircuit { head, body } => {
            return Ok(guest_response(ctx, normalize_hook_response(head, body, &base.method)));
        }
        RequestHookOutcome::Forward { head, body, .. } => (head, body),
    };

    for name in WEBSOCKET_UPGRADE_HEADER_NAMES {
        if let Some(value) = base.header(name)
            && hooked.header(name).is_none()
        {
            hooked.headers.push((name.to_string(), value.to_string()));
        }
    }

    if !prechecked || base.policy_relevant_change(&hooked) {
        shared.engine.ensure_request_allowed(&hooked).await?;
    }

    let method = hooked.method.to_ascii_uppercase();
    if method != "GET" {
        return Err(Blocked::bad_request("websocket upgrade requires GET").into());
    }
    if !matches!(hooked_body, ReqBody::Empty) {
        return Err(Blocked::bad_request("websocket upgrade requests must not have a body").into());
    }

    let url = Url::parse(&hooked.url).map_err(|_| Blocked::bad_request("invalid url"))?;
    let protocol =
        url_protocol(&url).ok_or_else(|| Blocked::bad_request("unsupported protocol"))?;
    let port = url
        .port_or_known_default()
        .filter(|p| *p > 0)
        .ok_or_else(|| Blocked::bad_request("invalid port"))?;
    let hostname = url.host_str().unwrap_or_default().to_string();

    // pin the tunnel to addresses allowed by policy (tried in resolver order)
    let addresses = shared.engine.allowed_addresses(&hostname, protocol, port).await?;
    if addresses.is_empty() {
        // same error as the HTTP path (`resolveHostname`)
        shared.engine.resolve_allowed(&hostname, protocol, port).await?;
    }

    let connect_timeout = Duration::from_millis(shared.limits.websocket_connect_timeout_ms);
    let connect = connect_raw(&shared.tls_client, protocol == "https", &hostname, &addresses, port);
    let io = with_timeout(connect_timeout, connect, || {
        format!("websocket upstream connect timeout after {}ms", connect_timeout.as_millis())
    })
    .await?
    .map_err(|e| PipelineError::Other(e.to_string()))?;

    let (mut sender, conn) =
        hyper::client::conn::http1::handshake::<_, Empty<Bytes>>(TokioIo::new(io))
            .await
            .map_err(|e| PipelineError::Other(e.to_string()))?;
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });

    let mut headers = hooked.headers.clone();
    if hooked.header("host").is_none() {
        let host = match url.port() {
            Some(p) => format!("{hostname}:{p}"),
            None => hostname.clone(),
        };
        headers.push(("host".into(), host));
    }
    headers
        .retain(|(k, _)| !matches!(k.as_str(), "content-length" | "transfer-encoding" | "expect"));
    let target = match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => url.path().to_string(),
    };
    let mut upstream_req = Request::new(Empty::<Bytes>::new());
    *upstream_req.uri_mut() = target.parse().map_err(|_| Blocked::bad_request("invalid url"))?;
    *upstream_req.headers_mut() = to_header_map(&headers);

    let header_timeout = Duration::from_millis(shared.limits.websocket_header_timeout_ms);
    let mut upstream_resp = with_timeout(header_timeout, sender.send_request(upstream_req), || {
        format!("websocket upstream header timeout after {}ms", header_timeout.as_millis())
    })
    .await?
    .map_err(|e| PipelineError::Other(e.to_string()))?;

    let status = upstream_resp.status();
    let head = ResponseHead {
        status: status.as_u16(),
        status_text: upstream_resp
            .extensions()
            .get::<ReasonPhrase>()
            .map(|r| latin1(r.as_bytes()))
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("OK").to_string()),
        headers: response_headers(upstream_resp.headers()),
    };

    if status != http::StatusCode::SWITCHING_PROTOCOLS {
        let body: HookBody = upstream_resp.into_body().map_err(Into::into).boxed();
        let mut resp = raw_response(&head, body);
        resp.headers_mut()
            .insert(http::header::CONNECTION, http::HeaderValue::from_static("close"));
        return Ok(resp);
    }

    let upstream_upgrade = hyper::upgrade::on(&mut upstream_resp);
    let guest_upgrade = hyper::upgrade::on(req);
    tokio::spawn(async move {
        let (guest, upstream) = match tokio::try_join!(guest_upgrade, upstream_upgrade) {
            Ok(pair) => pair,
            Err(err) => {
                tracing::debug!(target: "gondolin::egress", "websocket upgrade failed: {err}");
                return;
            }
        };
        let mut guest = TokioIo::new(guest);
        let mut upstream = TokioIo::new(upstream);
        if let Err(err) = tokio::io::copy_bidirectional(&mut guest, &mut upstream).await {
            tracing::debug!(target: "gondolin::egress", "websocket tunnel ended: {err}");
        }
    });
    Ok(raw_response(&head, crate::body::empty()))
}

/// Upstream handshake response forwarded as received (no hop-by-hop stripping).
fn raw_response(head: &ResponseHead, body: HookBody) -> Response<HookBody> {
    let mut resp = Response::new(body);
    *resp.status_mut() =
        http::StatusCode::from_u16(head.status).unwrap_or(http::StatusCode::BAD_GATEWAY);
    *resp.headers_mut() = to_header_map(&head.headers);
    if resp.status().canonical_reason() != Some(head.status_text.as_str())
        && let Ok(reason) = ReasonPhrase::try_from(head.status_text.as_bytes().to_vec())
    {
        resp.extensions_mut().insert(reason);
    }
    resp
}

async fn with_timeout<F: std::future::Future>(
    timeout: Duration,
    fut: F,
    message: impl FnOnce() -> String,
) -> Result<F::Output, PipelineError> {
    if timeout.is_zero() {
        return Ok(fut.await);
    }
    tokio::time::timeout(timeout, fut).await.map_err(|_| PipelineError::Other(message()))
}

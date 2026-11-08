//! WebSocket upgrades (port of `handleWebSocketUpgrade` and
//! `bridgeWebSocketUpgrade`): the handshake is mediated (hooks, policy), then
//! the connection becomes an opaque tunnel.

use std::time::Duration;

use gondolin_http::client::Connection;
use gondolin_http::server::{OnUpgrade, Response};
use gondolin_http::url::Url;
use gondolin_http::{BoxBody, HeadLimits, Version};

use crate::Shared;
use crate::error::{Blocked, PipelineError};
use crate::headers::{WEBSOCKET_UPGRADE_HEADER_NAMES, response_headers, to_wire_headers};
use crate::hooks::{RequestHead, ResponseHead};
use crate::http::{
    ReqBody, ReqCtx, RequestHookOutcome, apply_request_hooks, guest_response,
    normalize_hook_response, status_text, url_protocol, wire_response,
};
use crate::upstream::connect_raw;

/// Limits for the upstream handshake response head
const UPSTREAM_HEAD_LIMITS: HeadLimits =
    HeadLimits { max_bytes: 8192 + 4096 * 100, max_headers: 1024 };

pub(crate) async fn handle_websocket(
    shared: &Shared,
    ctx: &ReqCtx,
    version: Version,
    upgrade: Option<OnUpgrade>,
    base: RequestHead,
    prechecked: bool,
) -> Result<Response, PipelineError> {
    if version != Version::Http11 {
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
    if target.is_empty() || !target.starts_with('/') {
        return Err(Blocked::bad_request("invalid url").into());
    }

    let header_timeout = Duration::from_millis(shared.limits.websocket_header_timeout_ms);
    let wire_headers = to_wire_headers(&headers);
    let send = gondolin_http::client::send(
        Connection::new(io),
        "GET",
        &target,
        &wire_headers,
        BoxBody::empty(),
        &UPSTREAM_HEAD_LIMITS,
        None,
    );
    let upstream_resp = with_timeout(header_timeout, send, || {
        format!("websocket upstream header timeout after {}ms", header_timeout.as_millis())
    })
    .await?
    .map_err(|e| PipelineError::Other(e.to_string()))?;

    let status = upstream_resp.head.status;
    let head = ResponseHead {
        status,
        status_text: status_text(status, &upstream_resp.head.reason),
        headers: response_headers(&upstream_resp.head.headers),
    };

    let (Some(upstream), Some(guest_upgrade)) = (upstream_resp.upgraded, upgrade) else {
        // forwarded as received (no hop-by-hop stripping)
        let mut head = head;
        head.set_header("connection", "close");
        return Ok(wire_response(&head, upstream_resp.body.boxed()));
    };

    tokio::spawn(async move {
        let mut guest = match guest_upgrade.await {
            Ok(io) => io,
            Err(err) => {
                gondolin_log::debug!(target: "gondolin::egress", "websocket upgrade failed: {err}");
                return;
            }
        };
        let mut upstream = upstream;
        if let Err(err) = tokio::io::copy_bidirectional(&mut guest, &mut upstream).await {
            gondolin_log::debug!(target: "gondolin::egress", "websocket tunnel ended: {err}");
        }
    });
    Ok(wire_response(&head, crate::body::empty()))
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

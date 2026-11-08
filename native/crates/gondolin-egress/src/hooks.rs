//! Programmable hooks (tier 2/3): the [`HookBackend`] trait, plain-data
//! request/response heads, decisions and lazily pulled bodies.

use gondolin_proto::net::HookRegistrations;
use std::net::IpAddr;

use crate::body::{BodyHandle, HookBody};
use crate::error::Blocked;

/// Request head as plain data (`InternalHttpRequest` without the body).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestHead {
    pub method: String,
    /// absolute URL
    pub url: String,
    /// lowercase names, one entry per name (coalesced like WHATWG `Headers`)
    pub headers: Vec<(String, String)>,
}

impl RequestHead {
    pub fn header(&self, name: &str) -> Option<&str> {
        header_get(&self.headers, name)
    }

    pub fn set_header(&mut self, name: &str, value: impl Into<String>) {
        header_set(&mut self.headers, name, value.into());
    }

    pub fn remove_header(&mut self, name: &str) {
        header_remove(&mut self.headers, name);
    }

    /// Method/url/header changes that require re-running request policy
    /// (`hasPolicyRelevantRequestHeadChange`).
    pub fn policy_relevant_change(&self, other: &RequestHead) -> bool {
        if self.method != other.method || self.url != other.url {
            return true;
        }
        if self.headers.len() != other.headers.len() {
            return true;
        }
        self.headers.iter().any(|(k, v)| other.header(k) != Some(v.as_str()))
    }
}

/// Response head as plain data.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResponseHead {
    pub status: u16,
    pub status_text: String,
    /// lowercase names; repeated names allowed (`set-cookie`)
    pub headers: Vec<(String, String)>,
}

impl ResponseHead {
    pub fn header(&self, name: &str) -> Option<&str> {
        header_get(&self.headers, name)
    }

    pub fn set_header(&mut self, name: &str, value: impl Into<String>) {
        header_set(&mut self.headers, name, value.into());
    }

    pub fn remove_header(&mut self, name: &str) {
        header_remove(&mut self.headers, name);
    }
}

pub(crate) fn header_get<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

pub(crate) fn header_set(headers: &mut Vec<(String, String)>, name: &str, value: String) {
    if let Some(pos) = headers.iter().position(|(k, _)| k.eq_ignore_ascii_case(name)) {
        headers[pos].1 = value;
        let mut i = pos + 1;
        while i < headers.len() {
            if headers[i].0.eq_ignore_ascii_case(name) {
                headers.remove(i);
            } else {
                i += 1;
            }
        }
    } else {
        headers.push((name.to_ascii_lowercase(), value));
    }
}

pub(crate) fn header_remove(headers: &mut Vec<(String, String)>, name: &str) {
    headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
}

/// Destination check info (`HttpIpAllowInfo`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IpAllowInfo {
    pub hostname: String,
    pub ip: IpAddr,
    pub port: u16,
    /// `"http"` or `"https"`
    pub protocol: &'static str,
}

/// Replacement body in a decision.
pub enum BodyChoice {
    /// keep the original body (chunks the hook already pulled are replayed)
    Original,
    /// no body
    None,
    /// a new body
    Body(HookBody),
}

impl BodyChoice {
    /// The replacement body, or an empty body for `Original`/`None`.
    pub fn into_body_or_empty(self) -> HookBody {
        match self {
            Self::Body(b) => b,
            _ => crate::body::empty(),
        }
    }
}

impl std::fmt::Debug for BodyChoice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Original => f.write_str("Original"),
            Self::None => f.write_str("None"),
            Self::Body(_) => f.write_str("Body(..)"),
        }
    }
}

/// Decision of an `on_request` hook.
#[derive(Debug)]
pub enum RequestDecision {
    /// forward the request unchanged
    Continue,
    /// forward a replaced request
    Request { head: RequestHead, body: BodyChoice },
    /// short-circuit with a synthetic response (skips upstream and `on_response`)
    Respond { head: ResponseHead, body: BodyChoice },
}

/// Decision of an `on_response` hook.
#[derive(Debug)]
pub enum ResponseDecision {
    /// send the upstream response unchanged
    Continue,
    /// send a replaced response (`BodyChoice::Original` keeps the upstream body)
    Response { head: ResponseHead, body: BodyChoice },
}

/// Hook failure.
#[derive(Debug)]
pub enum HookError {
    /// the hook rejected the request with a status (`HttpRequestBlockedError`)
    Blocked(Blocked),
    /// the hook failed (exception, transport error): `502 Bad Gateway`
    Failed(String),
}

impl From<Blocked> for HookError {
    fn from(b: Blocked) -> Self {
        HookError::Blocked(b)
    }
}

impl std::fmt::Display for HookError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HookError::Blocked(b) => b.fmt(f),
            HookError::Failed(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for HookError {}

/// Programmable hooks reached from the egress pipeline.
///
/// Only phases set in [`HookBackend::registrations`] are ever called. Bodies are
/// offered as [`BodyHandle`]s that the hook may pull; a body that is never
/// pulled is not buffered and is forwarded natively when the decision keeps it.
pub trait HookBackend: Send + Sync + 'static {
    /// Which phases exist; read on every request (cheap, may change at runtime).
    fn registrations(&self) -> HookRegistrations;

    /// Request policy on the head only (`isRequestAllowed`).
    fn is_request_allowed<'a>(
        &'a self,
        _request: &'a RequestHead,
    ) -> crate::BoxFuture<'a, Result<bool, HookError>> {
        Box::pin(async move { Ok(true) })
    }

    /// Destination ip policy (`isIpAllowed`); called after the declarative checks passed.
    fn is_ip_allowed<'a>(
        &'a self,
        _info: &'a IpAllowInfo,
    ) -> crate::BoxFuture<'a, Result<bool, HookError>> {
        Box::pin(async move { Ok(true) })
    }

    /// Request hook (`onRequest`), before secret substitution.
    fn on_request<'a>(
        &'a self,
        _request: RequestHead,
        _body: Option<BodyHandle>,
    ) -> crate::BoxFuture<'a, Result<RequestDecision, HookError>> {
        Box::pin(async move { Ok(RequestDecision::Continue) })
    }

    /// Response hook (`onResponse`) with the final request head.
    fn on_response<'a>(
        &'a self,
        _response: ResponseHead,
        _body: Option<BodyHandle>,
        _request: RequestHead,
    ) -> crate::BoxFuture<'a, Result<ResponseDecision, HookError>> {
        Box::pin(async move { Ok(ResponseDecision::Continue) })
    }
}

/// A backend without hooks.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoHooks;

impl HookBackend for NoHooks {
    fn registrations(&self) -> HookRegistrations {
        HookRegistrations::default()
    }
}

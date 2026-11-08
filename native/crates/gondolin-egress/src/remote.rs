//! Tier-3 hooks over the controller protocol: a [`HookBackend`] that turns
//! hook phases into `hook_call` requests and exposes request/response bodies as
//! daemon streams the controller pulls with `body_pull`.
//!
//! gondolind supplies a [`ControllerLink`] (send a request, await its result)
//! and routes the controller's `body_pull`/`body_release` messages to
//! [`RemoteHooks::serve_body_pull`] / [`RemoteHooks::serve_body_release`].

use crate::BoxFuture;
use bytes::Bytes;
use gondolin_http::Body;
use gondolin_proto::net::{
    BodyChunk, BodyPull, HookCall, HookDecision, HookPhase, HookRegistrations, WireBody,
    WireIpInfo, WireRequestHead, WireResponseHead,
};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::task::{Context, Poll};

use crate::body::{BodyHandle, PullError};
use crate::error::{Blocked, BoxError};
use crate::hooks::{
    BodyChoice, HookBackend, HookError, IpAllowInfo, RequestDecision, RequestHead,
    ResponseDecision, ResponseHead,
};

/// Max chunk the daemon pulls from a controller stream in `bytes`
const CONTROLLER_PULL_BYTES: u64 = 256 * 1024;
/// Max chunk served to one controller `body_pull` in `bytes`
const MAX_SERVED_CHUNK: u64 = 1024 * 1024;
/// Bodies up to this size in `bytes` are sent inline with `hook_call` (read
/// ahead when their Content-Length says they fit, otherwise whatever already
/// arrived), so a body-reading hook needs no `body_pull` round trip
const INLINE_BODY_BYTES: usize = 64 * 1024;

/// Requests to the controller (implemented by gondolind's transport).
pub trait ControllerLink: Send + Sync + 'static {
    /// Sends `hook_call` and waits for `hook_call_result`.
    fn hook_call<'a>(
        &'a self,
        call: HookCall,
    ) -> crate::BoxFuture<'a, Result<HookDecision, String>>;
    /// Pulls from a controller-held stream (`body_pull` → `body_pull_result`).
    fn body_pull<'a>(&'a self, pull: BodyPull) -> crate::BoxFuture<'a, Result<BodyChunk, String>>;
    /// Tells the controller a stream is no longer needed (`body_release`).
    fn body_release(&self, stream: u64);
}

/// [`HookBackend`] backed by controller callbacks.
pub struct RemoteHooks {
    link: Arc<dyn ControllerLink>,
    registrations: RwLock<HookRegistrations>,
    streams: Mutex<HashMap<u64, BodyHandle>>,
    next_stream: AtomicU64,
}

impl RemoteHooks {
    pub fn new(link: Arc<dyn ControllerLink>, registrations: HookRegistrations) -> Self {
        Self {
            link,
            registrations: RwLock::new(registrations),
            streams: Mutex::new(HashMap::new()),
            next_stream: AtomicU64::new(1),
        }
    }

    /// Replaces the registered phases.
    pub fn set_registrations(&self, registrations: HookRegistrations) {
        *self.registrations.write().unwrap() = registrations;
    }

    /// Serves a controller `body_pull` on a daemon stream.
    pub async fn serve_body_pull(&self, pull: BodyPull) -> Result<BodyChunk, String> {
        let handle = self
            .streams
            .lock()
            .unwrap()
            .get(&pull.stream)
            .cloned()
            .ok_or_else(|| format!("unknown body stream {}", pull.stream))?;
        let max = pull.max.clamp(1, MAX_SERVED_CHUNK) as usize;
        let result = match pull.offset {
            Some(offset) => handle.pull_at(offset, max).await,
            None => handle.pull(max).await,
        };
        // the stream stays registered until the hook call ends (other readers)
        match result {
            Ok(Some(data)) => {
                // report the end with the last chunk (saves a round trip)
                let eof = match pull.offset {
                    Some(offset) => handle.complete_at(offset + data.len() as u64).await,
                    None => false,
                };
                Ok(BodyChunk { stream: pull.stream, data: data.to_vec(), eof })
            }
            Ok(None) => Ok(BodyChunk { stream: pull.stream, data: Vec::new(), eof: true }),
            Err(PullError::Limit(b)) => Err(b.message),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Serves a controller `body_release` on a daemon stream. A hint only:
    /// daemon streams live until their hook call returns (several readers may
    /// share one stream through offsets).
    pub fn serve_body_release(&self, _stream: u64) {}

    fn register_stream(&self, handle: BodyHandle) -> u64 {
        let id = self.next_stream.fetch_add(1, Ordering::Relaxed);
        self.streams.lock().unwrap().insert(id, handle);
        id
    }

    fn drop_stream(&self, id: Option<u64>) {
        if let Some(id) = id {
            self.streams.lock().unwrap().remove(&id);
        }
    }

    async fn call(&self, call: HookCall) -> Result<HookDecision, HookError> {
        match self.link.hook_call(call).await {
            Ok(HookDecision::Block { status, status_text, message }) => {
                Err(HookError::Blocked(Blocked { status, status_text, message }))
            }
            Ok(decision) => Ok(decision),
            Err(message) => Err(HookError::Failed(message)),
        }
    }

    fn body(&self, body: WireBody) -> BodyChoice {
        match body {
            WireBody::Original => BodyChoice::Original,
            WireBody::None => BodyChoice::None,
            WireBody::Bytes { data } => BodyChoice::Body(crate::body::full(data)),
            WireBody::Stream { stream } => BodyChoice::Body(crate::body::HookBody::new(
                ControllerBody::new(self.link.clone(), stream),
            )),
        }
    }
}

fn wire_request(head: &RequestHead, body: Option<u64>) -> WireRequestHead {
    WireRequestHead {
        method: head.method.clone(),
        url: head.url.clone(),
        headers: head.headers.clone(),
        body,
        body_prefix: None,
        body_complete: false,
    }
}

/// Reads the start of `body` for inline transfer (see [`INLINE_BODY_BYTES`]).
async fn inline_prefix(body: &BodyHandle, headers: &[(String, String)]) -> (Option<Vec<u8>>, bool) {
    let small = crate::hooks::header_get(headers, "content-length")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .is_some_and(|len| len <= INLINE_BODY_BYTES as u64);
    match body.prefetch(INLINE_BODY_BYTES, small).await {
        Ok((prefix, complete)) if !prefix.is_empty() || complete => {
            (Some(prefix.to_vec()), complete)
        }
        _ => (None, false),
    }
}

fn request_head(wire: WireRequestHead) -> RequestHead {
    RequestHead { method: wire.method, url: wire.url, headers: wire.headers }
}

fn response_head(wire: WireResponseHead) -> ResponseHead {
    ResponseHead { status: wire.status, status_text: wire.status_text, headers: wire.headers }
}

fn unexpected(phase: &str, decision: &HookDecision) -> HookError {
    HookError::Failed(format!("unexpected {phase} decision: {decision:?}"))
}

impl HookBackend for RemoteHooks {
    fn registrations(&self) -> HookRegistrations {
        self.registrations.read().unwrap().clone()
    }

    fn is_request_allowed<'a>(
        &'a self,
        request: &'a RequestHead,
    ) -> crate::BoxFuture<'a, Result<bool, HookError>> {
        Box::pin(async move {
            let call = HookCall {
                phase: HookPhase::IsRequestAllowed,
                request: Some(wire_request(request, None)),
                response: None,
                ip: None,
            };
            match self.call(call).await? {
                HookDecision::Allowed { allowed } => Ok(allowed),
                HookDecision::Continue => Ok(true),
                other => Err(unexpected("is_request_allowed", &other)),
            }
        })
    }

    fn is_ip_allowed<'a>(
        &'a self,
        info: &'a IpAllowInfo,
    ) -> crate::BoxFuture<'a, Result<bool, HookError>> {
        Box::pin(async move {
            let call = HookCall {
                phase: HookPhase::IsIpAllowed,
                request: None,
                response: None,
                ip: Some(WireIpInfo {
                    hostname: info.hostname.clone(),
                    ip: info.ip.to_string(),
                    family: if info.ip.is_ipv6() { 6 } else { 4 },
                    port: info.port,
                    protocol: info.protocol.to_string(),
                }),
            };
            match self.call(call).await? {
                HookDecision::Allowed { allowed } => Ok(allowed),
                HookDecision::Continue => Ok(true),
                other => Err(unexpected("is_ip_allowed", &other)),
            }
        })
    }

    fn on_request<'a>(
        &'a self,
        request: RequestHead,
        body: Option<BodyHandle>,
    ) -> crate::BoxFuture<'a, Result<RequestDecision, HookError>> {
        Box::pin(async move {
            let (body_prefix, body_complete) = match &body {
                Some(b) => inline_prefix(b, &request.headers).await,
                None => (None, false),
            };
            let stream = body.map(|b| self.register_stream(b));
            let mut wire = wire_request(&request, stream);
            wire.body_prefix = body_prefix;
            wire.body_complete = body_complete;
            let call = HookCall {
                phase: HookPhase::OnRequest,
                request: Some(wire),
                response: None,
                ip: None,
            };
            let result = self.call(call).await;
            self.drop_stream(stream);
            match result? {
                HookDecision::Continue => Ok(RequestDecision::Continue),
                HookDecision::Request { request, body } => Ok(RequestDecision::Request {
                    head: request_head(request),
                    body: self.body(body),
                }),
                HookDecision::Response { response, body } => Ok(RequestDecision::Respond {
                    head: response_head(response),
                    body: self.body(body),
                }),
                other => Err(unexpected("on_request", &other)),
            }
        })
    }

    fn on_response<'a>(
        &'a self,
        response: ResponseHead,
        body: Option<BodyHandle>,
        request: RequestHead,
    ) -> crate::BoxFuture<'a, Result<ResponseDecision, HookError>> {
        Box::pin(async move {
            let (body_prefix, body_complete) = match &body {
                Some(b) => inline_prefix(b, &response.headers).await,
                None => (None, false),
            };
            let stream = body.map(|b| self.register_stream(b));
            let call = HookCall {
                phase: HookPhase::OnResponse,
                request: Some(wire_request(&request, None)),
                response: Some(WireResponseHead {
                    status: response.status,
                    status_text: response.status_text.clone(),
                    headers: response.headers.clone(),
                    body: stream,
                    body_prefix,
                    body_complete,
                }),
                ip: None,
            };
            let result = self.call(call).await;
            self.drop_stream(stream);
            match result? {
                HookDecision::Continue => Ok(ResponseDecision::Continue),
                HookDecision::Response { response, body } => Ok(ResponseDecision::Response {
                    head: response_head(response),
                    body: self.body(body),
                }),
                other => Err(unexpected("on_response", &other)),
            }
        })
    }
}

/// A body pulled from a controller-held stream.
struct ControllerBody {
    link: Arc<dyn ControllerLink>,
    stream: u64,
    /// in-flight pull (behind a mutex only to make the body `Sync`)
    pending: Mutex<Option<BoxFuture<'static, Result<BodyChunk, String>>>>,
    done: bool,
}

impl ControllerBody {
    fn new(link: Arc<dyn ControllerLink>, stream: u64) -> Self {
        Self { link, stream, pending: Mutex::new(None), done: false }
    }
}

impl Body for ControllerBody {
    fn poll_data(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Bytes, BoxError>>> {
        loop {
            if self.done {
                return Poll::Ready(None);
            }
            let chunk = {
                let this = &mut *self;
                let pending = this.pending.get_mut().unwrap();
                if pending.is_none() {
                    let link = this.link.clone();
                    let pull =
                        BodyPull { stream: this.stream, max: CONTROLLER_PULL_BYTES, offset: None };
                    *pending = Some(Box::pin(async move { link.body_pull(pull).await }));
                }
                match pending.as_mut().unwrap().as_mut().poll(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(r) => {
                        *pending = None;
                        r
                    }
                }
            };
            match chunk {
                Err(e) => {
                    self.done = true;
                    return Poll::Ready(Some(Err(e.into())));
                }
                Ok(chunk) => {
                    if chunk.eof {
                        self.done = true;
                    }
                    if !chunk.data.is_empty() {
                        return Poll::Ready(Some(Ok(Bytes::from(chunk.data))));
                    }
                }
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.done
    }
}

impl Drop for ControllerBody {
    fn drop(&mut self) {
        if !self.done {
            self.link.body_release(self.stream);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::PullableBody;

    #[derive(Default)]
    struct Link {
        calls: Mutex<Vec<HookCall>>,
        decision: Mutex<Option<HookDecision>>,
        chunks: Mutex<Vec<BodyChunk>>,
        released: Mutex<Vec<u64>>,
    }

    impl ControllerLink for Link {
        fn hook_call<'a>(
            &'a self,
            call: HookCall,
        ) -> crate::BoxFuture<'a, Result<HookDecision, String>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(call);
                self.decision.lock().unwrap().take().ok_or_else(|| "no decision".to_string())
            })
        }
        fn body_pull<'a>(
            &'a self,
            pull: BodyPull,
        ) -> crate::BoxFuture<'a, Result<BodyChunk, String>> {
            Box::pin(async move {
                let mut chunks = self.chunks.lock().unwrap();
                if chunks.is_empty() {
                    return Ok(BodyChunk { stream: pull.stream, data: vec![], eof: true });
                }
                Ok(chunks.remove(0))
            })
        }
        fn body_release(&self, stream: u64) {
            self.released.lock().unwrap().push(stream);
        }
    }

    fn head() -> RequestHead {
        RequestHead { method: "POST".into(), url: "http://a.test/".into(), headers: vec![] }
    }

    #[tokio::test]
    async fn on_request_with_controller_stream_body() {
        let link = Arc::new(Link::default());
        *link.decision.lock().unwrap() = Some(HookDecision::Request {
            request: WireRequestHead {
                method: "PUT".into(),
                url: "http://a.test/x".into(),
                headers: vec![],
                ..Default::default()
            },
            body: WireBody::Stream { stream: 9 },
        });
        link.chunks.lock().unwrap().extend([
            BodyChunk { stream: 9, data: b"ab".to_vec(), eof: false },
            BodyChunk { stream: 9, data: b"cd".to_vec(), eof: true },
        ]);
        let hooks = RemoteHooks::new(link.clone(), HookRegistrations::default());
        let RequestDecision::Request { head, body: BodyChoice::Body(b) } =
            hooks.on_request(head(), None).await.unwrap()
        else {
            panic!("unexpected decision");
        };
        assert_eq!(head.method, "PUT");
        assert_eq!(&b.collect().await.unwrap()[..], b"abcd");
        assert!(link.released.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn daemon_streams_are_served_while_the_call_runs() {
        struct PullingLink {
            hooks: Mutex<Option<Arc<RemoteHooks>>>,
        }
        impl ControllerLink for PullingLink {
            fn hook_call<'a>(
                &'a self,
                call: HookCall,
            ) -> crate::BoxFuture<'a, Result<HookDecision, String>> {
                Box::pin(async move {
                    let hooks = self.hooks.lock().unwrap().clone().unwrap();
                    let request = call.request.unwrap();
                    // small bodies arrive inline and complete
                    assert_eq!(request.body_prefix.as_deref(), Some(&b"hello"[..]));
                    assert!(request.body_complete);
                    let stream = request.body.unwrap();
                    let mut data = Vec::new();
                    loop {
                        let chunk = hooks
                            .serve_body_pull(BodyPull { stream, max: 2, offset: None })
                            .await?;
                        data.extend(chunk.data);
                        if chunk.eof {
                            break;
                        }
                    }
                    assert_eq!(data, b"hello");
                    Ok(HookDecision::Continue)
                })
            }
            fn body_pull<'a>(
                &'a self,
                _pull: BodyPull,
            ) -> crate::BoxFuture<'a, Result<BodyChunk, String>> {
                Box::pin(async move { unreachable!() })
            }
            fn body_release(&self, _stream: u64) {}
        }
        let link = Arc::new(PullingLink { hooks: Mutex::new(None) });
        let hooks = Arc::new(RemoteHooks::new(link.clone(), HookRegistrations::default()));
        *link.hooks.lock().unwrap() = Some(hooks.clone());
        let body = PullableBody::new(crate::body::full("hello"), 100, Blocked::bad_gateway("x"));
        let decision = hooks.on_request(head(), Some(body.handle())).await.unwrap();
        assert!(matches!(decision, RequestDecision::Continue));
        assert_eq!(&body.into_body().await.collect().await.unwrap()[..], b"hello");
        assert!(hooks.streams.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn block_and_link_errors() {
        let link = Arc::new(Link::default());
        *link.decision.lock().unwrap() = Some(HookDecision::Block {
            status: 403,
            status_text: "Forbidden".into(),
            message: "no".into(),
        });
        let hooks = RemoteHooks::new(link.clone(), HookRegistrations::default());
        assert!(
            matches!(hooks.is_request_allowed(&head()).await, Err(HookError::Blocked(b)) if b.message == "no")
        );
        assert!(matches!(hooks.is_request_allowed(&head()).await, Err(HookError::Failed(_))));
    }

    #[tokio::test]
    async fn dropped_controller_body_is_released() {
        let link = Arc::new(Link::default());
        let body = ControllerBody::new(link.clone(), 5);
        drop(body);
        assert_eq!(*link.released.lock().unwrap(), vec![5]);
    }
}

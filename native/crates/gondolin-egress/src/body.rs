//! Body plumbing: boxed bodies, lazily pulled hook bodies with replay, size
//! limits and request body recording for redirect replays.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use bytes::Bytes;
use gondolin_http::{Body, SizeHint};

use crate::error::{Blocked, BoxError};

/// Body type used between pipeline stages and hooks.
pub type HookBody = gondolin_http::BoxBody;

type Data = Poll<Option<Result<Bytes, BoxError>>>;

pub fn empty() -> HookBody {
    HookBody::empty()
}

pub fn full(data: impl Into<Bytes>) -> HookBody {
    HookBody::full(data)
}

/// Keeps `guard` alive as long as the body (e.g. a concurrency permit).
pub fn with_guard<G: Send + Unpin + 'static>(body: HookBody, guard: G) -> HookBody {
    struct Guarded<G> {
        body: HookBody,
        _guard: G,
    }
    impl<G: Send + Unpin> Body for Guarded<G> {
        fn poll_data(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Data {
            Pin::new(&mut self.get_mut().body).poll_data(cx)
        }
        fn is_end_stream(&self) -> bool {
            self.body.is_end_stream()
        }
        fn size_hint(&self) -> SizeHint {
            self.body.size_hint()
        }
    }
    HookBody::new(Guarded { body, _guard: guard })
}

/// Error raised by [`LimitedBody`] when the limit is exceeded.
#[derive(Debug)]
pub struct BodyLimitExceeded(pub Blocked);

impl std::fmt::Display for BodyLimitExceeded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for BodyLimitExceeded {}

/// Fails with [`BodyLimitExceeded`] once more than `limit` bytes were read.
pub struct LimitedBody<B> {
    inner: B,
    remaining: u64,
    error: Option<Blocked>,
}

impl<B> LimitedBody<B> {
    pub fn new(inner: B, limit: u64, error: Blocked) -> Self {
        Self { inner, remaining: limit, error: Some(error) }
    }
}

impl<B: Body + Unpin> Body for LimitedBody<B> {
    fn poll_data(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Data {
        let this = &mut *self;
        match Pin::new(&mut this.inner).poll_data(cx) {
            Poll::Ready(Some(Ok(data))) => {
                let len = data.len() as u64;
                if len > this.remaining {
                    let err = this.error.take().unwrap_or_else(|| {
                        Blocked::new(413, "Payload Too Large", "body too large")
                    });
                    return Poll::Ready(Some(Err(Box::new(BodyLimitExceeded(err)))));
                }
                this.remaining -= len;
                Poll::Ready(Some(Ok(data)))
            }
            other => other,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Finds a [`BodyLimitExceeded`] (or other [`Blocked`]) in an error chain.
pub fn find_blocked(err: &(dyn std::error::Error + 'static)) -> Option<Blocked> {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(err);
    let mut depth = 0;
    while let Some(e) = current {
        if let Some(limit) = e.downcast_ref::<BodyLimitExceeded>() {
            return Some(limit.0.clone());
        }
        if let Some(blocked) = e.downcast_ref::<Blocked>() {
            return Some(blocked.clone());
        }
        depth += 1;
        if depth > 16 {
            break;
        }
        current = e.source();
    }
    None
}

/// Errors of [`BodyHandle::pull`].
#[derive(Debug, Clone)]
pub enum PullError {
    /// retained bytes would exceed the limit
    Limit(Blocked),
    /// reading the underlying body failed
    Read(String),
    /// the pipeline already took the body back (decision made)
    Released,
}

impl std::fmt::Display for PullError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PullError::Limit(b) => b.fmt(f),
            PullError::Read(e) => write!(f, "body read failed: {e}"),
            PullError::Released => f.write_str("body stream released"),
        }
    }
}

impl std::error::Error for PullError {}

struct PullState {
    source: Option<HookBody>,
    retained: Vec<Bytes>,
    retained_bytes: u64,
    limit: u64,
    limit_error: Blocked,
    /// read cursor: chunk index + offset in that chunk
    chunk: usize,
    offset: usize,
    eof: bool,
    pulled: bool,
    released: bool,
}

/// How long a non-waiting [`BodyHandle::prefetch`] waits for more of a body
/// that already started arriving
const PREFETCH_GRACE: std::time::Duration = std::time::Duration::from_millis(1);

/// Reads the next data frame of the source into `retained`. Returns `false` at
/// end of body. Marks the body complete as soon as the source reports its end.
async fn read_next(state: &mut PullState) -> Result<bool, PullError> {
    loop {
        if state.eof {
            return Ok(false);
        }
        let Some(source) = state.source.as_mut() else {
            state.eof = true;
            return Ok(false);
        };
        match source.data().await {
            Some(Ok(data)) => {
                if data.is_empty() {
                    continue;
                }
                let len = data.len() as u64;
                if state.retained_bytes + len > state.limit {
                    return Err(PullError::Limit(state.limit_error.clone()));
                }
                state.retained_bytes += len;
                state.retained.push(data);
                state.pulled = true;
                if state.source.as_ref().is_some_and(|s| s.is_end_stream()) {
                    state.eof = true;
                    state.source = None;
                }
                return Ok(true);
            }
            Some(Err(e)) => {
                if let Some(blocked) = find_blocked(e.as_ref()) {
                    return Err(PullError::Limit(blocked));
                }
                return Err(PullError::Read(e.to_string()));
            }
            None => {
                state.eof = true;
                state.source = None;
                return Ok(false);
            }
        }
    }
}

/// Polls `fut` once; `None` when it is not ready.
fn now_or_never<F: Future>(fut: F) -> Option<F::Output> {
    let mut fut = std::pin::pin!(fut);
    let mut cx = Context::from_waker(std::task::Waker::noop());
    match fut.as_mut().poll(&mut cx) {
        Poll::Ready(v) => Some(v),
        Poll::Pending => None,
    }
}

/// Lazily pulled body offered to a hook. Pulled chunks are retained so the
/// pipeline can replay them when the decision keeps the original body.
#[derive(Clone)]
pub struct BodyHandle {
    state: Arc<tokio::sync::Mutex<PullState>>,
}

impl std::fmt::Debug for BodyHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BodyHandle")
    }
}

impl BodyHandle {
    /// Reads the next chunk of at most `max` bytes; `None` at end of body.
    pub async fn pull(&self, max: usize) -> Result<Option<Bytes>, PullError> {
        let max = max.max(1);
        let mut state = self.state.lock().await;
        if state.released {
            return Err(PullError::Released);
        }
        state.pulled = true;
        loop {
            if state.chunk < state.retained.len() {
                let chunk = state.retained[state.chunk].clone();
                let start = state.offset;
                let end = (start + max).min(chunk.len());
                if end >= chunk.len() {
                    state.chunk += 1;
                    state.offset = 0;
                } else {
                    state.offset = end;
                }
                if end > start {
                    return Ok(Some(chunk.slice(start..end)));
                }
                continue;
            }
            if !read_next(&mut state).await? {
                return Ok(None);
            }
        }
    }

    /// Reads at most `max` bytes at byte `offset` of the body (independent of
    /// the [`BodyHandle::pull`] cursor); `None` at end of body. Offsets beyond
    /// what was read so far are an error.
    pub async fn pull_at(&self, offset: u64, max: usize) -> Result<Option<Bytes>, PullError> {
        let max = max.max(1);
        let mut state = self.state.lock().await;
        if state.released {
            return Err(PullError::Released);
        }
        state.pulled = true;
        loop {
            if offset < state.retained_bytes {
                let mut start = 0u64;
                for chunk in &state.retained {
                    let end = start + chunk.len() as u64;
                    if offset < end {
                        let from = (offset - start) as usize;
                        let to = (from + max).min(chunk.len());
                        return Ok(Some(chunk.slice(from..to)));
                    }
                    start = end;
                }
            }
            if offset > state.retained_bytes {
                return Err(PullError::Read(format!("offset {offset} beyond body position")));
            }
            if !read_next(&mut state).await? {
                return Ok(None);
            }
        }
    }

    /// Whether everything from `offset` on has been read (the body ends there).
    pub async fn complete_at(&self, offset: u64) -> bool {
        let state = self.state.lock().await;
        state.eof && offset >= state.retained_bytes
    }

    /// Reads ahead up to `max` bytes so they can be sent inline with a hook
    /// call: with `wait`, until `max` or the end of the body; otherwise only
    /// data that is already available. Returns the bytes read so far and
    /// whether that is the whole body.
    pub async fn prefetch(&self, max: usize, wait: bool) -> Result<(Bytes, bool), PullError> {
        let mut state = self.state.lock().await;
        if state.released {
            return Err(PullError::Released);
        }
        while (state.retained_bytes as usize) < max && !state.eof {
            if wait {
                if !read_next(&mut state).await? {
                    break;
                }
            } else if state.retained_bytes == 0 {
                match now_or_never(read_next(&mut state)) {
                    Some(Ok(true)) => {}
                    Some(Ok(false)) => break,
                    Some(Err(e)) => return Err(e),
                    None => break,
                }
            } else {
                // data arrived: give the connection a moment to deliver the
                // end of a small body (chunked terminator) before the call
                match tokio::time::timeout(PREFETCH_GRACE, read_next(&mut state)).await {
                    Ok(Ok(true)) => {}
                    Ok(Ok(false)) => break,
                    Ok(Err(e)) => return Err(e),
                    Err(_) => break,
                }
            }
        }
        let mut out = bytes::BytesMut::with_capacity(state.retained_bytes as usize);
        for chunk in &state.retained {
            out.extend_from_slice(chunk);
        }
        Ok((out.freeze(), state.eof))
    }

    /// Reads the whole remaining body (up to the limit).
    pub async fn read_to_end(&self) -> Result<Bytes, PullError> {
        let mut out = bytes::BytesMut::new();
        while let Some(chunk) = self.pull(64 * 1024).await? {
            out.extend_from_slice(&chunk);
        }
        Ok(out.freeze())
    }
}

/// Owner side of a [`BodyHandle`].
pub struct PullableBody {
    state: Arc<tokio::sync::Mutex<PullState>>,
}

impl PullableBody {
    /// Wraps `body`; hooks may retain at most `limit` bytes (`limit_error` otherwise).
    pub fn new(body: HookBody, limit: u64, limit_error: Blocked) -> Self {
        Self {
            state: Arc::new(tokio::sync::Mutex::new(PullState {
                source: Some(body),
                retained: Vec::new(),
                retained_bytes: 0,
                limit,
                limit_error,
                chunk: 0,
                offset: 0,
                eof: false,
                pulled: false,
                released: false,
            })),
        }
    }

    pub fn handle(&self) -> BodyHandle {
        BodyHandle { state: self.state.clone() }
    }

    /// Takes the body back: retained chunks first, then the unread rest.
    /// Never-pulled bodies come back unchanged (no copy, no buffering).
    pub async fn into_body(self) -> HookBody {
        let mut state = self.state.lock().await;
        state.released = true;
        let source = state.source.take();
        let retained = std::mem::take(&mut state.retained);
        let pulled = state.pulled;
        drop(state);
        match (pulled, source) {
            (false, Some(source)) => source,
            (_, source) => HookBody::new(ReplayBody { retained: retained.into(), rest: source }),
        }
    }

    /// Drops the body (decision did not keep it).
    pub async fn discard(self) {
        let mut state = self.state.lock().await;
        state.released = true;
        state.source = None;
        state.retained.clear();
    }
}

struct ReplayBody {
    retained: std::collections::VecDeque<Bytes>,
    rest: Option<HookBody>,
}

impl Body for ReplayBody {
    fn poll_data(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Data {
        if let Some(chunk) = self.retained.pop_front() {
            return Poll::Ready(Some(Ok(chunk)));
        }
        match self.rest.as_mut() {
            Some(rest) => Pin::new(rest).poll_data(cx),
            None => Poll::Ready(None),
        }
    }

    fn is_end_stream(&self) -> bool {
        self.retained.is_empty() && self.rest.as_ref().is_none_or(|r| r.is_end_stream())
    }

    fn size_hint(&self) -> SizeHint {
        let retained: u64 = self.retained.iter().map(|b| b.len() as u64).sum();
        let rest = self.rest.as_ref().map(|r| r.size_hint()).unwrap_or(SizeHint::exact(0));
        SizeHint { lower: rest.lower + retained, upper: rest.upper.map(|u| u + retained) }
    }
}

/// Shared record of a request body as it is sent upstream.
#[derive(Default)]
pub struct Recording {
    chunks: Vec<Bytes>,
    bytes: u64,
    overflowed: bool,
    complete: bool,
}

impl Recording {
    /// The full body if it was completely recorded.
    pub fn complete_body(&self) -> Option<Bytes> {
        if !self.complete || self.overflowed {
            return None;
        }
        let mut out = bytes::BytesMut::with_capacity(self.bytes as usize);
        for c in &self.chunks {
            out.extend_from_slice(c);
        }
        Some(out.freeze())
    }
}

/// Records up to `limit` bytes of a body while it is polled (redirect replays).
pub struct RecordingBody {
    inner: HookBody,
    record: Arc<Mutex<Recording>>,
    limit: u64,
}

impl RecordingBody {
    pub fn new(inner: HookBody, limit: u64) -> (Self, Arc<Mutex<Recording>>) {
        let record = Arc::new(Mutex::new(Recording::default()));
        (Self { inner, record: record.clone(), limit }, record)
    }
}

impl Body for RecordingBody {
    fn poll_data(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Data {
        let limit = self.limit;
        let polled = Pin::new(&mut self.inner).poll_data(cx);
        let mut rec = self.record.lock().unwrap();
        match &polled {
            Poll::Ready(Some(Ok(data))) => {
                if !rec.overflowed {
                    if rec.bytes + data.len() as u64 > limit {
                        rec.overflowed = true;
                        rec.chunks.clear();
                    } else {
                        rec.bytes += data.len() as u64;
                        rec.chunks.push(data.clone());
                    }
                }
                // the client stops polling once a length-delimited body reports its end
                if self.inner.is_end_stream() {
                    rec.complete = true;
                }
            }
            Poll::Ready(None) => rec.complete = true,
            _ => {}
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Fails when no frame arrives for `timeout` (undici `bodyTimeout`).
pub struct IdleTimeoutBody<B> {
    inner: B,
    timeout: std::time::Duration,
    sleep: Pin<Box<tokio::time::Sleep>>,
    /// whether a wait for the next frame is in progress (timer armed)
    waiting: bool,
}

impl<B> IdleTimeoutBody<B> {
    pub fn new(inner: B, timeout: std::time::Duration) -> Self {
        Self { inner, timeout, sleep: Box::pin(tokio::time::sleep(timeout)), waiting: false }
    }
}

impl<B: Body + Unpin> Body for IdleTimeoutBody<B> {
    fn poll_data(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Data {
        let this = &mut *self;
        if !this.waiting {
            // the reader may have paused (guest backpressure): time only our wait
            this.sleep.as_mut().reset(tokio::time::Instant::now() + this.timeout);
            this.waiting = true;
        }
        match Pin::new(&mut this.inner).poll_data(cx) {
            Poll::Ready(data) => {
                this.waiting = false;
                Poll::Ready(data)
            }
            Poll::Pending => match this.sleep.as_mut().poll(cx) {
                Poll::Ready(()) => Poll::Ready(Some(Err("upstream body timeout".into()))),
                Poll::Pending => Poll::Pending,
            },
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunks(parts: &[&'static str]) -> HookBody {
        gondolin_http::body::from_chunks(
            parts.iter().map(|p| Bytes::from_static(p.as_bytes())).collect(),
        )
    }

    #[tokio::test]
    async fn unpulled_body_passes_through() {
        let body = PullableBody::new(chunks(&["ab", "cd"]), 10, Blocked::bad_gateway("x"));
        let out = body.into_body().await.collect().await.unwrap();
        assert_eq!(&out[..], b"abcd");
    }

    #[tokio::test]
    async fn pulled_chunks_are_replayed() {
        let body = PullableBody::new(chunks(&["hello", " world"]), 100, Blocked::bad_gateway("x"));
        let handle = body.handle();
        assert_eq!(&handle.pull(3).await.unwrap().unwrap()[..], b"hel");
        assert_eq!(&handle.pull(10).await.unwrap().unwrap()[..], b"lo");
        let out = body.into_body().await.collect().await.unwrap();
        assert_eq!(&out[..], b"hello world");
        assert!(matches!(handle.pull(1).await, Err(PullError::Released)));
    }

    #[tokio::test]
    async fn offset_pulls_are_independent() {
        let body = PullableBody::new(chunks(&["hello", " world"]), 100, Blocked::bad_gateway("x"));
        let handle = body.handle();
        assert_eq!(&handle.pull_at(0, 100).await.unwrap().unwrap()[..], b"hello");
        assert_eq!(&handle.pull_at(5, 100).await.unwrap().unwrap()[..], b" world");
        assert!(handle.pull_at(11, 100).await.unwrap().is_none());
        assert_eq!(&handle.pull_at(2, 2).await.unwrap().unwrap()[..], b"ll");
        assert!(handle.pull_at(50, 1).await.is_err());
        let out = body.into_body().await.collect().await.unwrap();
        assert_eq!(&out[..], b"hello world");
    }

    #[tokio::test]
    async fn pull_limit() {
        let body =
            PullableBody::new(chunks(&["hello", " world"]), 6, Blocked::bad_gateway("too big"));
        let handle = body.handle();
        let err = handle.read_to_end().await.unwrap_err();
        assert!(matches!(err, PullError::Limit(b) if b.message == "too big"));
    }

    #[tokio::test]
    async fn recording() {
        let (rec, record) = RecordingBody::new(chunks(&["ab", "cd"]), 10);
        let _ = HookBody::new(rec).collect().await.unwrap();
        assert_eq!(&record.lock().unwrap().complete_body().unwrap()[..], b"abcd");
        let (rec, record) = RecordingBody::new(chunks(&["ab", "cd"]), 3);
        let _ = HookBody::new(rec).collect().await.unwrap();
        assert!(record.lock().unwrap().complete_body().is_none());
    }
}

//! Message bodies: a minimal poll-based [`Body`] trait (data frames only),
//! boxed bodies and helpers.

use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::{Bytes, BytesMut};

use crate::BoxError;

/// Size bounds of a body in `bytes`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SizeHint {
    pub lower: u64,
    pub upper: Option<u64>,
}

impl SizeHint {
    pub fn exact(n: u64) -> Self {
        Self { lower: n, upper: Some(n) }
    }

    /// The size when lower and upper bounds agree.
    pub fn exact_len(&self) -> Option<u64> {
        self.upper.filter(|u| *u == self.lower)
    }
}

/// A stream of body data.
pub trait Body: Send {
    /// Polls the next data chunk; `None` at the end.
    fn poll_data(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Bytes, BoxError>>>;

    /// Whether the body is known to have ended (no more data will come).
    fn is_end_stream(&self) -> bool {
        false
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

/// A type-erased body.
pub struct BoxBody(Pin<Box<dyn Body + Send + 'static>>);

impl BoxBody {
    pub fn new(body: impl Body + 'static) -> Self {
        Self(Box::pin(body))
    }

    /// A body without data.
    pub fn empty() -> Self {
        Self::new(Full(None))
    }

    /// A body of one chunk.
    pub fn full(data: impl Into<Bytes>) -> Self {
        let data = data.into();
        Self::new(Full((!data.is_empty()).then_some(data)))
    }

    /// The next data chunk.
    pub async fn data(&mut self) -> Option<Result<Bytes, BoxError>> {
        std::future::poll_fn(|cx| self.0.as_mut().poll_data(cx)).await
    }

    /// Reads the whole body.
    pub async fn collect(mut self) -> Result<Bytes, BoxError> {
        let first = match self.data().await {
            None => return Ok(Bytes::new()),
            Some(r) => r?,
        };
        let Some(second) = self.data().await else {
            return Ok(first);
        };
        let mut out = BytesMut::from(&first[..]);
        out.extend_from_slice(&second?);
        while let Some(chunk) = self.data().await {
            out.extend_from_slice(&chunk?);
        }
        Ok(out.freeze())
    }

    /// The body length for framing an outgoing message.
    pub fn length(&self) -> crate::head::BodyLength {
        if self.is_end_stream() {
            return crate::head::BodyLength::Empty;
        }
        match self.size_hint().exact_len() {
            Some(n) => crate::head::BodyLength::Known(n),
            None => crate::head::BodyLength::Unknown,
        }
    }
}

impl Body for BoxBody {
    fn poll_data(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Bytes, BoxError>>> {
        self.0.as_mut().poll_data(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.0.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.0.size_hint()
    }
}

impl std::fmt::Debug for BoxBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BoxBody")
    }
}

/// A body of at most one chunk.
struct Full(Option<Bytes>);

impl Body for Full {
    fn poll_data(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Bytes, BoxError>>> {
        Poll::Ready(self.0.take().map(Ok))
    }

    fn is_end_stream(&self) -> bool {
        self.0.is_none()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::exact(self.0.as_ref().map_or(0, |b| b.len() as u64))
    }
}

/// A body of the given chunks (tests).
pub fn from_chunks(chunks: Vec<Bytes>) -> BoxBody {
    struct Chunks(std::collections::VecDeque<Bytes>);
    impl Body for Chunks {
        fn poll_data(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Bytes, BoxError>>> {
            Poll::Ready(self.0.pop_front().map(Ok))
        }
        fn is_end_stream(&self) -> bool {
            self.0.is_empty()
        }
    }
    BoxBody::new(Chunks(chunks.into()))
}

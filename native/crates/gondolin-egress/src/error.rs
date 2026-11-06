//! Errors that turn into guest-visible HTTP error responses.

/// A request rejected with a specific status (`HttpRequestBlockedError`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct Blocked {
    pub status: u16,
    pub status_text: String,
    pub message: String,
}

impl Blocked {
    pub fn new(status: u16, status_text: &str, message: impl Into<String>) -> Self {
        Self { status, status_text: status_text.into(), message: message.into() }
    }

    /// `403 Forbidden` (the `HttpRequestBlockedError` default).
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(403, "Forbidden", message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, "Bad Request", message)
    }

    pub fn bad_gateway(message: impl Into<String>) -> Self {
        Self::new(502, "Bad Gateway", message)
    }
}

/// Outcome of a failed request pipeline step.
#[derive(Debug, thiserror::Error)]
pub enum PipelineError {
    /// rejected with a status and a detail message
    #[error(transparent)]
    Blocked(#[from] Blocked),
    /// error response without detail (`respondWithError(status, text)`)
    #[error("{status} {status_text}")]
    Plain { status: u16, status_text: &'static str },
    /// unexpected failure (upstream errors, hook failures): `502 Bad Gateway`
    #[error("{0}")]
    Other(String),
}

impl PipelineError {
    pub fn plain(status: u16, status_text: &'static str) -> Self {
        Self::Plain { status, status_text }
    }
}

pub type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

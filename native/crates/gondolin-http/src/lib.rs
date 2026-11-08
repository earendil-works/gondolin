//! A small HTTP/1.1 implementation for gondolind: a sans-io core (message
//! heads, framing, chunked coding; [`head`], [`decode`]) with thin tokio
//! adapters for serving ([`server`]) and sending ([`client`]) requests, and a
//! rustls stream adapter ([`tls`]).

pub mod body;
pub mod client;
pub mod conn;
pub mod decode;
pub mod head;
pub mod server;
pub mod tls;
pub mod url;

pub use body::{Body, BoxBody, SizeHint};
pub use conn::{BoxIo, Incoming, Io, Upgraded};
pub use head::{Framing, HeadLimits, ParseError, RequestHead, ResponseHead, Version};

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// A header field: lowercase name (as parsed; outgoing names are written as
/// given) and raw value bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub name: String,
    pub value: Vec<u8>,
}

impl Header {
    pub fn new(name: impl Into<String>, value: impl Into<Vec<u8>>) -> Self {
        Self { name: name.into(), value: value.into() }
    }
}

/// The first value of header `name` (case-insensitive).
pub fn header<'a>(headers: &'a [Header], name: &str) -> Option<&'a [u8]> {
    headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)).map(|h| h.value.as_slice())
}

//! Sans-io HTTP/1.x message heads: parsing request and response heads,
//! message framing (RFC 9112 §6) and serialization.
//!
//! The parser follows what hyper/httparse accept: optional empty lines before
//! a request line, `\r\n` or bare `\n` line endings, single spaces in the start
//! line, token header names without whitespace before the colon, no obsolete
//! line folding, header values of HTAB/SP/VCHAR/obs-text (trimmed).

use crate::Header;

/// HTTP version of a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Version {
    Http10,
    Http11,
}

impl Version {
    pub fn as_str(self) -> &'static str {
        match self {
            Version::Http10 => "HTTP/1.0",
            Version::Http11 => "HTTP/1.1",
        }
    }
}

/// A parsed request head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestHead {
    pub method: String,
    /// request-target as sent (origin, absolute, authority or asterisk form)
    pub target: String,
    pub version: Version,
    /// lowercase names in received order
    pub headers: Vec<Header>,
}

/// A parsed response head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseHead {
    pub version: Version,
    pub status: u16,
    /// reason phrase bytes as received (may be empty)
    pub reason: Vec<u8>,
    /// lowercase names in received order
    pub headers: Vec<Header>,
}

/// Limits for parsing a head.
#[derive(Debug, Clone, Copy)]
pub struct HeadLimits {
    /// max head size including the terminating empty line in `bytes`
    pub max_bytes: usize,
    /// max number of header lines
    pub max_headers: usize,
}

/// Why a head (or its framing) is invalid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// head larger than [`HeadLimits::max_bytes`]
    TooLarge,
    /// more header lines than [`HeadLimits::max_headers`]
    TooManyHeaders,
    /// unsupported HTTP version
    Version,
    /// malformed head or framing headers
    Invalid(&'static str),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::TooLarge => f.write_str("message head is too large"),
            ParseError::TooManyHeaders => f.write_str("too many headers"),
            ParseError::Version => f.write_str("unsupported http version"),
            ParseError::Invalid(what) => write!(f, "invalid http message: {what}"),
        }
    }
}

impl std::error::Error for ParseError {}

/// Whether `b` is a `tchar` (RFC 9110 token character).
pub fn is_token(b: u8) -> bool {
    matches!(b,
        b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_'
        | b'`' | b'|' | b'~' | b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z')
}

/// Whether `b` may appear in a header value (HTAB, SP, VCHAR, obs-text).
pub fn is_value_byte(b: u8) -> bool {
    b == b'\t' || (b >= 0x20 && b != 0x7f)
}

/// Whether `name` is a valid header field name.
pub fn valid_name(name: &[u8]) -> bool {
    !name.is_empty() && name.iter().all(|&b| is_token(b))
}

/// Whether `value` is a valid header field value.
pub fn valid_value(value: &[u8]) -> bool {
    value.iter().all(|&b| is_value_byte(b))
}

/// Finds the end of a head (index after the empty line) in `buf`, skipping
/// leading empty lines when `skip_empty` is set. `Ok(None)` when more input
/// is needed.
fn find_head_end(buf: &[u8], limits: &HeadLimits) -> Result<Option<(usize, usize)>, ParseError> {
    let mut start = 0;
    // leading empty lines (RFC 9112 §2.2: a server SHOULD ignore them)
    loop {
        if buf[start..].starts_with(b"\r\n") {
            start += 2;
        } else if buf[start..].starts_with(b"\n") {
            start += 1;
        } else {
            break;
        }
        if start > limits.max_bytes {
            return Err(ParseError::TooLarge);
        }
    }
    let mut i = start;
    while let Some(off) = buf[i..].iter().position(|&b| b == b'\n') {
        let nl = i + off;
        let rest = &buf[nl + 1..];
        let end = if rest.starts_with(b"\n") {
            Some(nl + 2)
        } else if rest.starts_with(b"\r\n") {
            Some(nl + 3)
        } else if rest.is_empty() || rest == b"\r" {
            // need more to decide
            break;
        } else {
            None
        };
        if let Some(end) = end {
            if end - start > limits.max_bytes {
                return Err(ParseError::TooLarge);
            }
            return Ok(Some((start, end)));
        }
        i = nl + 1;
    }
    if buf.len() - start > limits.max_bytes {
        return Err(ParseError::TooLarge);
    }
    Ok(None)
}

/// Splits a head into lines without their line endings (the final empty line excluded).
fn lines(head: &[u8]) -> Result<Vec<&[u8]>, ParseError> {
    let mut out = Vec::new();
    let mut rest = head;
    while let Some(pos) = rest.iter().position(|&b| b == b'\n') {
        let mut line = &rest[..pos];
        if let Some(stripped) = line.strip_suffix(b"\r") {
            line = stripped;
        }
        rest = &rest[pos + 1..];
        if line.is_empty() {
            break;
        }
        if line.contains(&b'\r') {
            return Err(ParseError::Invalid("bare CR"));
        }
        out.push(line);
    }
    Ok(out)
}

fn parse_version(v: &[u8]) -> Result<Version, ParseError> {
    match v {
        b"HTTP/1.1" => Ok(Version::Http11),
        b"HTTP/1.0" => Ok(Version::Http10),
        _ if v.starts_with(b"HTTP/") => Err(ParseError::Version),
        _ => Err(ParseError::Invalid("version")),
    }
}

fn parse_headers(lines: &[&[u8]], limits: &HeadLimits) -> Result<Vec<Header>, ParseError> {
    if lines.len() > limits.max_headers {
        return Err(ParseError::TooManyHeaders);
    }
    let mut headers = Vec::with_capacity(lines.len());
    for line in lines {
        let colon =
            line.iter().position(|&b| b == b':').ok_or(ParseError::Invalid("header line"))?;
        let name = &line[..colon];
        if !valid_name(name) {
            return Err(ParseError::Invalid("header name"));
        }
        let value = trim_ows(&line[colon + 1..]);
        if !valid_value(value) {
            return Err(ParseError::Invalid("header value"));
        }
        let name = std::str::from_utf8(name).expect("token is ascii").to_ascii_lowercase();
        headers.push(Header { name, value: value.to_vec() });
    }
    Ok(headers)
}

fn trim_ows(mut v: &[u8]) -> &[u8] {
    while let [b' ' | b'\t', rest @ ..] = v {
        v = rest;
    }
    while let [rest @ .., b' ' | b'\t'] = v {
        v = rest;
    }
    v
}

/// Parses a request head from the start of `buf`. Returns the head and the
/// number of bytes it used, `Ok(None)` when incomplete.
pub fn parse_request(
    buf: &[u8],
    limits: &HeadLimits,
) -> Result<Option<(RequestHead, usize)>, ParseError> {
    let Some((start, end)) = find_head_end(buf, limits)? else {
        return Ok(None);
    };
    let lines = lines(&buf[start..end])?;
    let (first, rest) = lines.split_first().ok_or(ParseError::Invalid("empty head"))?;
    let mut parts = first.split(|&b| b == b' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(ParseError::Invalid("request line"));
    };
    if !valid_name(method) {
        return Err(ParseError::Invalid("method"));
    }
    if target.is_empty() || target.iter().any(|&b| b <= 0x20 || b == 0x7f) {
        return Err(ParseError::Invalid("request target"));
    }
    let target = std::str::from_utf8(target).map_err(|_| ParseError::Invalid("request target"))?;
    let version = parse_version(version)?;
    let headers = parse_headers(rest, limits)?;
    let head = RequestHead {
        method: std::str::from_utf8(method).expect("token is ascii").to_string(),
        target: target.to_string(),
        version,
        headers,
    };
    Ok(Some((head, end)))
}

/// Parses a response head from the start of `buf` (see [`parse_request`]).
pub fn parse_response(
    buf: &[u8],
    limits: &HeadLimits,
) -> Result<Option<(ResponseHead, usize)>, ParseError> {
    let Some((start, end)) = find_head_end(buf, limits)? else {
        return Ok(None);
    };
    if start != 0 {
        return Err(ParseError::Invalid("status line"));
    }
    let lines = lines(&buf[..end])?;
    let (first, rest) = lines.split_first().ok_or(ParseError::Invalid("empty head"))?;
    let (version, after) = match first.iter().position(|&b| b == b' ') {
        Some(sp) => (&first[..sp], &first[sp + 1..]),
        None => return Err(ParseError::Invalid("status line")),
    };
    let version = parse_version(version)?;
    if after.len() < 3 || !after[..3].iter().all(u8::is_ascii_digit) {
        return Err(ParseError::Invalid("status code"));
    }
    let status = after[..3].iter().fold(0u16, |n, d| n * 10 + u16::from(d - b'0'));
    if status < 100 {
        return Err(ParseError::Invalid("status code"));
    }
    let reason = match &after[3..] {
        [] => &[][..],
        [b' ', reason @ ..] => reason,
        _ => return Err(ParseError::Invalid("status line")),
    };
    if !valid_value(reason) {
        return Err(ParseError::Invalid("reason phrase"));
    }
    let headers = parse_headers(rest, limits)?;
    Ok(Some((ResponseHead { version, status, reason: reason.to_vec(), headers }, end)))
}

/// Message body framing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framing {
    /// exactly this many `bytes`
    Length(u64),
    /// chunked transfer coding
    Chunked,
    /// until the connection closes (responses only)
    Close,
}

/// Request semantics derived from the head (hyper's `Server::parse` rules).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestInfo {
    pub framing: Framing,
    /// the client allows reusing the connection
    pub keep_alive: bool,
    /// `Expect: 100-continue` on HTTP/1.1
    pub expect_continue: bool,
    /// `Upgrade` on HTTP/1.1
    pub wants_upgrade: bool,
}

fn has_token(value: &[u8], token: &str) -> bool {
    value.split(|&b| b == b',').any(|t| trim_ows(t).eq_ignore_ascii_case(token.as_bytes()))
}

/// Whether the last transfer coding is `chunked`.
fn ends_chunked(value: &[u8]) -> bool {
    value
        .rsplit(|&b| b == b',')
        .next()
        .is_some_and(|t| trim_ows(t).eq_ignore_ascii_case(b"chunked"))
}

/// Strict decimal Content-Length (`1*DIGIT`).
pub fn parse_content_length(value: &[u8]) -> Option<u64> {
    if value.is_empty() {
        return None;
    }
    value.iter().try_fold(0u64, |n, &b| {
        if !b.is_ascii_digit() {
            return None;
        }
        n.checked_mul(10)?.checked_add(u64::from(b - b'0'))
    })
}

/// Content-Length from all values (comma lists allowed, all equal), `Err` when invalid.
fn content_length_all(headers: &[Header]) -> Result<Option<u64>, ()> {
    let mut len = None;
    for h in headers.iter().filter(|h| h.name == "content-length") {
        for part in h.value.split(|&b| b == b',') {
            let n = parse_content_length(trim_ows(part)).ok_or(())?;
            if len.is_some_and(|l| l != n) {
                return Err(());
            }
            len = Some(n);
        }
    }
    Ok(len)
}

/// Validates the framing headers of a request and derives its semantics.
/// With `Transfer-Encoding`, `Content-Length` headers are removed; repeated
/// equal `Content-Length` headers are collapsed.
pub fn request_info(head: &mut RequestHead) -> Result<RequestInfo, ParseError> {
    let http11 = head.version == Version::Http11;
    let mut keep_alive = http11;
    let mut saw_close = false;
    let mut expect_continue = false;
    let mut wants_upgrade = false;
    let mut te = false;
    let mut te_chunked = false;
    let mut cl: Option<u64> = None;
    let mut cl_seen = false;
    let mut keep = Vec::with_capacity(head.headers.len());
    for h in std::mem::take(&mut head.headers) {
        match h.name.as_str() {
            "transfer-encoding" => {
                if !http11 {
                    return Err(ParseError::Invalid("transfer-encoding on HTTP/1.0"));
                }
                te = true;
                te_chunked = ends_chunked(&h.value);
            }
            "content-length" => {
                cl_seen = true;
                if te {
                    continue;
                }
                let n =
                    parse_content_length(&h.value).ok_or(ParseError::Invalid("content-length"))?;
                if let Some(prev) = cl {
                    if prev != n {
                        return Err(ParseError::Invalid("content-length"));
                    }
                    continue;
                }
                cl = Some(n);
            }
            "connection" => {
                if saw_close || has_token(&h.value, "close") {
                    saw_close = true;
                    keep_alive = false;
                } else if !keep_alive {
                    keep_alive = has_token(&h.value, "keep-alive");
                }
            }
            "expect" => expect_continue = h.value.eq_ignore_ascii_case(b"100-continue"),
            "upgrade" => wants_upgrade = http11,
            _ => {}
        }
        keep.push(h);
    }
    if te {
        keep.retain(|h| h.name != "content-length");
        if !te_chunked {
            head.headers = keep;
            return Err(ParseError::Invalid("transfer-encoding"));
        }
        if cl_seen {
            keep_alive = false;
        }
    }
    head.headers = keep;
    let framing = if te { Framing::Chunked } else { Framing::Length(cl.unwrap_or(0)) };
    Ok(RequestInfo {
        framing,
        keep_alive,
        expect_continue: expect_continue && http11,
        wants_upgrade,
    })
}

/// Response semantics derived from the head (hyper's `Client::decoder` rules).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResponseInfo {
    pub framing: Framing,
    /// the server allows reusing the connection
    pub keep_alive: bool,
    /// `101 Switching Protocols`
    pub upgrade: bool,
}

/// Framing of a response to a request with `method`; `Ok(None)` for interim
/// (1xx other than 101) responses that are skipped.
pub fn response_info(
    head: &ResponseHead,
    method: &str,
) -> Result<Option<ResponseInfo>, ParseError> {
    let mut keep_alive = head.version == Version::Http11;
    let mut saw_close = false;
    for h in head.headers.iter().filter(|h| h.name == "connection") {
        if saw_close || has_token(&h.value, "close") {
            saw_close = true;
            keep_alive = false;
        } else if !keep_alive {
            keep_alive = has_token(&h.value, "keep-alive");
        }
    }
    let info = |framing, keep_alive| Ok(Some(ResponseInfo { framing, keep_alive, upgrade: false }));
    match head.status {
        101 => {
            return Ok(Some(ResponseInfo {
                framing: Framing::Length(0),
                keep_alive: false,
                upgrade: true,
            }));
        }
        100..=199 => return Ok(None),
        204 | 304 => return info(Framing::Length(0), keep_alive),
        _ => {}
    }
    if method.eq_ignore_ascii_case("HEAD") {
        return info(Framing::Length(0), keep_alive);
    }
    let te: Vec<&Header> = head.headers.iter().filter(|h| h.name == "transfer-encoding").collect();
    if !te.is_empty() {
        if head.version == Version::Http10 {
            return Err(ParseError::Invalid("transfer-encoding on HTTP/1.0"));
        }
        if te.last().is_some_and(|h| ends_chunked(&h.value)) {
            return info(Framing::Chunked, keep_alive);
        }
        return info(Framing::Close, false);
    }
    match content_length_all(&head.headers) {
        Ok(Some(n)) => info(Framing::Length(n), keep_alive),
        Ok(None) => info(Framing::Close, false),
        Err(()) => Err(ParseError::Invalid("content-length")),
    }
}

/// Known size of an outgoing body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyLength {
    /// no body (ended before it started)
    Empty,
    /// exactly this many `bytes`
    Known(u64),
    Unknown,
}

fn push_header(dst: &mut Vec<u8>, name: &str, value: &[u8]) {
    dst.extend_from_slice(name.as_bytes());
    dst.extend_from_slice(b": ");
    dst.extend_from_slice(value);
    dst.extend_from_slice(b"\r\n");
}

/// Writes a request head and decides the body framing (hyper's
/// `Client::set_length`): an explicit `Transfer-Encoding` wins (made to end in
/// `chunked`), then `Content-Length`, then the body size; unknown sizes are
/// chunked except for GET/HEAD/CONNECT. Invalid header lines are skipped.
pub fn encode_request(
    dst: &mut Vec<u8>,
    method: &str,
    target: &str,
    headers: &[Header],
    body: BodyLength,
) -> Framing {
    dst.extend_from_slice(method.as_bytes());
    dst.push(b' ');
    dst.extend_from_slice(target.as_bytes());
    dst.extend_from_slice(b" HTTP/1.1\r\n");
    let valid = |h: &&Header| valid_name(h.name.as_bytes()) && valid_value(&h.value);
    let te =
        headers.iter().filter(valid).rfind(|h| h.name.eq_ignore_ascii_case("transfer-encoding"));
    let framing = if body == BodyLength::Empty {
        Framing::Length(0)
    } else if te.is_some() {
        Framing::Chunked
    } else if let Ok(Some(n)) = content_length_all(
        &headers
            .iter()
            .filter(valid)
            .filter(|h| h.name.eq_ignore_ascii_case("content-length"))
            .map(|h| Header { name: "content-length".into(), value: h.value.clone() })
            .collect::<Vec<_>>(),
    ) {
        Framing::Length(n)
    } else {
        match body {
            BodyLength::Known(n) => Framing::Length(n),
            _ if matches!(method, "GET" | "HEAD" | "CONNECT") => Framing::Length(0),
            _ => Framing::Chunked,
        }
    };
    let mut wrote_cl = false;
    let mut wrote_te = false;
    for h in headers.iter().filter(valid) {
        if h.name.eq_ignore_ascii_case("transfer-encoding") {
            if body == BodyLength::Empty {
                continue;
            }
            if !ends_chunked(&h.value) && std::ptr::eq(h, *te.as_ref().unwrap()) {
                let mut v = h.value.clone();
                v.extend_from_slice(b", chunked");
                push_header(dst, &h.name, &v);
                wrote_te = true;
                continue;
            }
            wrote_te = true;
        } else if h.name.eq_ignore_ascii_case("content-length") {
            if framing == Framing::Chunked {
                continue;
            }
            wrote_cl = true;
        }
        push_header(dst, &h.name, &h.value);
    }
    match framing {
        Framing::Chunked if !wrote_te => push_header(dst, "transfer-encoding", b"chunked"),
        Framing::Length(n) if !wrote_cl && matches!(body, BodyLength::Known(_)) => {
            push_header(dst, "content-length", n.to_string().as_bytes())
        }
        _ => {}
    }
    dst.extend_from_slice(b"\r\n");
    framing
}

/// Outcome of [`encode_response`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResponseEncoding {
    /// body framing (`Length(0)` when the response cannot have a body)
    pub framing: Framing,
    /// the connection must close after this response
    pub close: bool,
}

/// Writes a response head for a request with `head_request` (HEAD) and
/// `version`, deciding the body framing like hyper's `Server::encode`:
/// a body-size-consistent `Content-Length` is kept, `Transfer-Encoding` is
/// dropped where chunking is impossible, unknown sizes are chunked on
/// HTTP/1.1 and close-delimited on HTTP/1.0, empty bodies get
/// `content-length: 0` where allowed; 204/304/1xx never carry framing headers
/// or a body. Invalid header lines are skipped. `reason` defaults to the
/// canonical reason phrase.
pub fn encode_response(
    dst: &mut Vec<u8>,
    version: Version,
    status: u16,
    reason: Option<&[u8]>,
    headers: &[Header],
    head_request: bool,
    body: BodyLength,
) -> ResponseEncoding {
    dst.extend_from_slice(version.as_str().as_bytes());
    dst.push(b' ');
    dst.extend_from_slice(status.to_string().as_bytes());
    dst.push(b' ');
    match reason {
        Some(r) if valid_value(r) => dst.extend_from_slice(r),
        _ => dst.extend_from_slice(canonical_reason(status).unwrap_or("<none>").as_bytes()),
    }
    dst.extend_from_slice(b"\r\n");

    let informational = (100..200).contains(&status);
    let can_have_cl = !informational && status != 204 && status != 304;
    let can_have_body = can_have_cl && !head_request;
    let can_chunk = can_have_body && version == Version::Http11;
    let mut close = false;
    let mut framing: Option<Framing> = None;
    let mut te_values: Vec<&[u8]> = Vec::new();
    let mut connection: Vec<&[u8]> = Vec::new();
    for h in headers {
        if !valid_name(h.name.as_bytes()) || !valid_value(&h.value) {
            continue;
        }
        let name = h.name.to_ascii_lowercase();
        match name.as_str() {
            "content-length" => {
                if framing.is_some() || !can_have_cl {
                    continue;
                }
                match body {
                    BodyLength::Known(n) => framing = Some(Framing::Length(n)),
                    BodyLength::Unknown => match parse_content_length(&h.value) {
                        Some(n) => framing = Some(Framing::Length(n)),
                        None => continue,
                    },
                    BodyLength::Empty => {
                        if !head_request {
                            continue;
                        }
                        framing = Some(Framing::Length(0));
                    }
                }
                push_header(dst, "content-length", &h.value);
            }
            "transfer-encoding" => {
                if !can_chunk || matches!(framing, Some(Framing::Length(_))) {
                    continue;
                }
                framing = Some(Framing::Chunked);
                te_values.push(&h.value);
            }
            "connection" => {
                if has_token(&h.value, "close") {
                    close = true;
                }
                connection.push(&h.value);
            }
            "trailer" => {
                if can_chunk {
                    push_header(dst, "trailer", &h.value);
                }
            }
            _ => push_header(dst, &name, &h.value),
        }
    }
    if !connection.is_empty() {
        push_header(dst, "connection", &connection.join(&b", "[..]));
    }
    if !te_values.is_empty() {
        let mut v = te_values.join(&b", "[..]);
        if !ends_chunked(&v) {
            v.extend_from_slice(b", chunked");
        }
        push_header(dst, "transfer-encoding", &v);
    }
    let framing = match framing {
        Some(f) => f,
        None => match body {
            BodyLength::Unknown if can_chunk => {
                push_header(dst, "transfer-encoding", b"chunked");
                Framing::Chunked
            }
            BodyLength::Unknown if can_have_body => {
                close = true;
                Framing::Close
            }
            BodyLength::Unknown => Framing::Length(0),
            BodyLength::Empty | BodyLength::Known(0) => {
                if can_have_body {
                    push_header(dst, "content-length", b"0");
                }
                Framing::Length(0)
            }
            BodyLength::Known(n) => {
                if can_have_cl {
                    push_header(dst, "content-length", n.to_string().as_bytes());
                    Framing::Length(n)
                } else {
                    Framing::Length(0)
                }
            }
        },
    };
    dst.extend_from_slice(b"\r\n");
    let framing = if can_have_body { framing } else { Framing::Length(0) };
    ResponseEncoding { framing, close }
}

/// The IANA reason phrase of a status code.
pub fn canonical_reason(status: u16) -> Option<&'static str> {
    Some(match status {
        100 => "Continue",
        101 => "Switching Protocols",
        102 => "Processing",
        103 => "Early Hints",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        203 => "Non Authoritative Information",
        204 => "No Content",
        205 => "Reset Content",
        206 => "Partial Content",
        207 => "Multi-Status",
        208 => "Already Reported",
        226 => "IM Used",
        300 => "Multiple Choices",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        305 => "Use Proxy",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        407 => "Proxy Authentication Required",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        412 => "Precondition Failed",
        413 => "Payload Too Large",
        414 => "URI Too Long",
        415 => "Unsupported Media Type",
        416 => "Range Not Satisfiable",
        417 => "Expectation Failed",
        418 => "I'm a teapot",
        421 => "Misdirected Request",
        422 => "Unprocessable Entity",
        423 => "Locked",
        424 => "Failed Dependency",
        425 => "Too Early",
        426 => "Upgrade Required",
        428 => "Precondition Required",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        451 => "Unavailable For Legal Reasons",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        505 => "HTTP Version Not Supported",
        506 => "Variant Also Negotiates",
        507 => "Insufficient Storage",
        508 => "Loop Detected",
        510 => "Not Extended",
        511 => "Network Authentication Required",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITS: HeadLimits = HeadLimits { max_bytes: 1024, max_headers: 8 };

    fn h(name: &str, value: &str) -> Header {
        Header { name: name.into(), value: value.as_bytes().to_vec() }
    }

    #[test]
    fn request_basic() {
        let raw = b"\r\nGET /a?b HTTP/1.1\r\nHost: x\r\nX-A:  1 \r\n\r\nrest";
        let (head, len) = parse_request(raw, &LIMITS).unwrap().unwrap();
        assert_eq!(&raw[len..], b"rest");
        assert_eq!(head.method, "GET");
        assert_eq!(head.target, "/a?b");
        assert_eq!(head.version, Version::Http11);
        assert_eq!(head.headers, vec![h("host", "x"), h("x-a", "1")]);
        // bare LF line endings
        let (head, _) = parse_request(b"GET / HTTP/1.0\nA: b\n\n", &LIMITS).unwrap().unwrap();
        assert_eq!(head.version, Version::Http10);
        assert_eq!(head.headers, vec![h("a", "b")]);
    }

    #[test]
    fn request_partial_and_limits() {
        assert_eq!(parse_request(b"GET / HTTP/1.1\r\nHost: x\r\n", &LIMITS), Ok(None));
        assert_eq!(parse_request(b"GET / HTTP/1.1\r\nHost: x\r\n\r", &LIMITS), Ok(None));
        let big = [b'a'; 2000];
        assert_eq!(parse_request(&big, &LIMITS), Err(ParseError::TooLarge));
        let many = b"GET / HTTP/1.1\r\na:1\r\na:1\r\na:1\r\na:1\r\na:1\r\na:1\r\na:1\r\na:1\r\na:1\r\n\r\n";
        assert_eq!(parse_request(many, &LIMITS), Err(ParseError::TooManyHeaders));
    }

    #[test]
    fn request_invalid() {
        for raw in [
            &b"GET  / HTTP/1.1\r\n\r\n"[..],
            b"GET / HTTP/1.1 \r\n\r\n",
            b"G(T / HTTP/1.1\r\n\r\n",
            b"GET / HTTP/1.1\r\nA : b\r\n\r\n",
            b"GET / HTTP/1.1\r\nA: b\r\n c\r\n\r\n",
            b"GET / HTTP/1.1\r\nA: b\x01\r\n\r\n",
            b"GET / HTTP/1.1\r\nA\r\n\r\n",
            b"GET / HTTP/1.1\r\nA: b\rc\r\n\r\n",
        ] {
            assert!(parse_request(raw, &LIMITS).is_err(), "{:?}", String::from_utf8_lossy(raw));
        }
        assert_eq!(parse_request(b"GET / HTTP/2.0\r\n\r\n", &LIMITS), Err(ParseError::Version));
    }

    fn info(raw: &[u8]) -> Result<(RequestInfo, RequestHead), ParseError> {
        let (mut head, _) = parse_request(raw, &LIMITS).unwrap().unwrap();
        request_info(&mut head).map(|i| (i, head))
    }

    #[test]
    fn request_framing() {
        let (i, _) = info(b"POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\n").unwrap();
        assert_eq!(i.framing, Framing::Length(5));
        assert!(i.keep_alive);
        let (i, head) = info(
            b"POST / HTTP/1.1\r\nContent-Length: 5\r\nTransfer-Encoding: gzip, chunked\r\n\r\n",
        )
        .unwrap();
        assert_eq!(i.framing, Framing::Chunked);
        assert!(!i.keep_alive);
        assert_eq!(head.headers, vec![h("transfer-encoding", "gzip, chunked")]);
        assert!(info(b"POST / HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n").is_err());
        assert!(info(b"POST / HTTP/1.0\r\nTransfer-Encoding: chunked\r\n\r\n").is_err());
        assert!(
            info(b"POST / HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\n").is_err()
        );
        assert!(info(b"POST / HTTP/1.1\r\nContent-Length: 5, 5\r\n\r\n").is_err());
        assert!(info(b"POST / HTTP/1.1\r\nContent-Length: +5\r\n\r\n").is_err());
        let (i, head) =
            info(b"POST / HTTP/1.1\r\nContent-Length: 5\r\ncontent-length: 5\r\n\r\n").unwrap();
        assert_eq!(i.framing, Framing::Length(5));
        assert_eq!(head.headers.len(), 1);
        let (i, _) = info(b"GET / HTTP/1.0\r\nConnection: Keep-Alive\r\n\r\n").unwrap();
        assert!(i.keep_alive);
        let (i, _) =
            info(b"GET / HTTP/1.1\r\nConnection: close\r\nConnection: keep-alive\r\n\r\n").unwrap();
        assert!(!i.keep_alive);
        let (i, _) =
            info(b"GET / HTTP/1.1\r\nExpect: 100-Continue\r\nUpgrade: websocket\r\n\r\n").unwrap();
        assert!(i.expect_continue && i.wants_upgrade);
        let (i, _) = info(b"GET / HTTP/1.0\r\nExpect: 100-continue\r\nUpgrade: x\r\n\r\n").unwrap();
        assert!(!i.expect_continue && !i.wants_upgrade);
    }

    #[test]
    fn response_parse_and_framing() {
        let (head, len) =
            parse_response(b"HTTP/1.1 200 Very OK\r\nContent-Length: 3\r\n\r\nabc", &LIMITS)
                .unwrap()
                .unwrap();
        assert_eq!(len, 43);
        assert_eq!(head.status, 200);
        assert_eq!(head.reason, b"Very OK");
        let i = response_info(&head, "GET").unwrap().unwrap();
        assert_eq!(i.framing, Framing::Length(3));
        assert_eq!(response_info(&head, "HEAD").unwrap().unwrap().framing, Framing::Length(0));
        let (head, _) = parse_response(b"HTTP/1.1 204\r\n\r\n", &LIMITS).unwrap().unwrap();
        assert!(head.reason.is_empty());
        let (head, _) = parse_response(b"HTTP/1.1 100 Continue\r\n\r\n", &LIMITS).unwrap().unwrap();
        assert_eq!(response_info(&head, "GET"), Ok(None));
        let (head, _) = parse_response(b"HTTP/1.0 200 OK\r\n\r\n", &LIMITS).unwrap().unwrap();
        let i = response_info(&head, "GET").unwrap().unwrap();
        assert_eq!(i.framing, Framing::Close);
        assert!(!i.keep_alive);
        let (head, _) =
            parse_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n", &LIMITS)
                .unwrap()
                .unwrap();
        assert_eq!(response_info(&head, "GET").unwrap().unwrap().framing, Framing::Close);
        let (head, _) = parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 1, 2\r\n\r\n", &LIMITS)
            .unwrap()
            .unwrap();
        assert!(response_info(&head, "GET").is_err());
        assert!(parse_response(b"HTTP/1.1 20 OK\r\n\r\n", &LIMITS).is_err());
        assert!(parse_response(b"HTTP/1.1 200OK\r\n\r\n", &LIMITS).is_err());
    }

    fn encode_resp(
        version: Version,
        status: u16,
        headers: &[Header],
        head_req: bool,
        body: BodyLength,
    ) -> (String, ResponseEncoding) {
        let mut out = Vec::new();
        let enc = encode_response(&mut out, version, status, None, headers, head_req, body);
        (String::from_utf8(out).unwrap(), enc)
    }

    #[test]
    fn response_encoding() {
        let (s, e) =
            encode_resp(Version::Http11, 200, &[h("X-A", "1")], false, BodyLength::Unknown);
        assert_eq!(s, "HTTP/1.1 200 OK\r\nx-a: 1\r\ntransfer-encoding: chunked\r\n\r\n");
        assert_eq!(e.framing, Framing::Chunked);
        let (s, e) = encode_resp(Version::Http10, 200, &[], false, BodyLength::Unknown);
        assert_eq!(s, "HTTP/1.0 200 OK\r\n\r\n");
        assert_eq!(e, ResponseEncoding { framing: Framing::Close, close: true });
        let (s, _) = encode_resp(Version::Http11, 200, &[], false, BodyLength::Empty);
        assert_eq!(s, "HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
        let (s, e) = encode_resp(
            Version::Http11,
            204,
            &[h("content-length", "0")],
            false,
            BodyLength::Empty,
        );
        assert_eq!(s, "HTTP/1.1 204 No Content\r\n\r\n");
        assert_eq!(e.framing, Framing::Length(0));
        let (s, e) = encode_resp(
            Version::Http11,
            200,
            &[h("content-length", "10")],
            true,
            BodyLength::Empty,
        );
        assert_eq!(s, "HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\n");
        assert_eq!(e.framing, Framing::Length(0));
        let (s, e) = encode_resp(
            Version::Http11,
            200,
            &[h("content-length", "3"), h("connection", "close")],
            false,
            BodyLength::Unknown,
        );
        assert_eq!(s, "HTTP/1.1 200 OK\r\ncontent-length: 3\r\nconnection: close\r\n\r\n");
        assert_eq!(e, ResponseEncoding { framing: Framing::Length(3), close: true });
        let (s, _) = encode_resp(Version::Http11, 200, &[], false, BodyLength::Known(5));
        assert_eq!(s, "HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\n");
        let (s, _) = encode_resp(
            Version::Http11,
            200,
            &[h("bad name", "x"), h("a", "b\r\nc")],
            false,
            BodyLength::Empty,
        );
        assert_eq!(s, "HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
    }

    #[test]
    fn request_encoding() {
        let enc = |method: &str, headers: &[Header], body| {
            let mut out = Vec::new();
            let f = encode_request(&mut out, method, "/x", headers, body);
            (String::from_utf8(out).unwrap(), f)
        };
        assert_eq!(
            enc("GET", &[h("host", "a")], BodyLength::Empty),
            ("GET /x HTTP/1.1\r\nhost: a\r\n\r\n".into(), Framing::Length(0))
        );
        assert_eq!(
            enc("POST", &[], BodyLength::Unknown),
            ("POST /x HTTP/1.1\r\ntransfer-encoding: chunked\r\n\r\n".into(), Framing::Chunked)
        );
        assert_eq!(
            enc("POST", &[], BodyLength::Known(3)),
            ("POST /x HTTP/1.1\r\ncontent-length: 3\r\n\r\n".into(), Framing::Length(3))
        );
        assert_eq!(
            enc("POST", &[h("content-length", "3")], BodyLength::Unknown),
            ("POST /x HTTP/1.1\r\ncontent-length: 3\r\n\r\n".into(), Framing::Length(3))
        );
        assert_eq!(
            enc("GET", &[], BodyLength::Unknown),
            ("GET /x HTTP/1.1\r\n\r\n".into(), Framing::Length(0))
        );
        assert_eq!(
            enc(
                "POST",
                &[h("transfer-encoding", "gzip"), h("content-length", "3")],
                BodyLength::Known(3)
            ),
            (
                "POST /x HTTP/1.1\r\ntransfer-encoding: gzip, chunked\r\n\r\n".into(),
                Framing::Chunked
            )
        );
    }
}

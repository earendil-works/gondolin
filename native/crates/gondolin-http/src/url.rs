//! WHATWG URL parsing and serialization for what gondolind needs (port of
//! the `url` crate's parser): absolute and relative (`join`) parsing for the
//! special schemes (`http`, `https`, `ws`, `wss`, `ftp`, `file`) with host
//! normalization (lowercase domains, IPv4 in any WHATWG number form, IPv6),
//! default port elision, dot-segment removal and percent-encoding; generic
//! schemes keep an opaque host/path. Plus `application/x-www-form-urlencoded`
//! query pairs.
//!
//! Deviation: non-ASCII domains are lowercased and punycode-encoded per label
//! without the full UTS #46 mapping (NFC, width folding, disallowed code
//! points); `xn--` labels must decode as punycode.

use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};

/// A parsed, serialized URL.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Url {
    serialization: String,
    /// index of the `:` after the scheme
    scheme_end: usize,
    /// byte range of the host in `serialization`
    host: Option<(usize, usize)>,
    /// explicit non-default port
    port: Option<u16>,
    path_start: usize,
    /// index of `?`
    query_start: Option<usize>,
    /// index of `#`
    fragment_start: Option<usize>,
}

/// Why a URL did not parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    MissingScheme,
    EmptyHost,
    InvalidPort,
    InvalidIpv4Address,
    InvalidIpv6Address,
    InvalidDomainCharacter,
    /// a relative URL against an opaque base
    CannotBeABase,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ParseError::MissingScheme => "relative URL without a base",
            ParseError::EmptyHost => "empty host",
            ParseError::InvalidPort => "invalid port number",
            ParseError::InvalidIpv4Address => "invalid IPv4 address",
            ParseError::InvalidIpv6Address => "invalid IPv6 address",
            ParseError::InvalidDomainCharacter => "invalid domain character",
            ParseError::CannotBeABase => "relative URL with a cannot-be-a-base base",
        })
    }
}

impl std::error::Error for ParseError {}

/// Bytes to percent-encode, in addition to C0 controls, DEL and non-ASCII.
type EncodeSet = &'static [u8];

const CONTROLS: EncodeSet = b"";
const FRAGMENT: EncodeSet = b" \"<>`";
const PATH: EncodeSet = b" \"<>`#?{}";
const USERINFO: EncodeSet = b" \"<>`#?{}/:;=@[\\]^|";
const QUERY: EncodeSet = b" \"#<>";
const SPECIAL_QUERY: EncodeSet = b" \"#<>'";

fn percent_encode(out: &mut String, input: &str, set: EncodeSet) {
    for c in input.chars() {
        if c.is_ascii() && !(c as u8).is_ascii_control() && !set.contains(&(c as u8)) {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                push_hex(out, b);
            }
        }
    }
}

fn push_hex(out: &mut String, b: u8) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    out.push('%');
    out.push(HEX[usize::from(b >> 4)] as char);
    out.push(HEX[usize::from(b & 15)] as char);
}

/// Percent-decodes `input` (invalid escapes stay as they are).
pub fn percent_decode(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'%'
            && i + 2 < input.len()
            && let (Some(h), Some(l)) = (hex_val(input[i + 1]), hex_val(input[i + 2]))
        {
            out.push(h << 4 | l);
            i += 3;
            continue;
        }
        out.push(input[i]);
        i += 1;
    }
    out
}

fn hex_val(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|d| d as u8)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SchemeType {
    File,
    SpecialNotFile,
    NotSpecial,
}

impl SchemeType {
    fn of(scheme: &str) -> Self {
        match scheme {
            "http" | "https" | "ws" | "wss" | "ftp" => SchemeType::SpecialNotFile,
            "file" => SchemeType::File,
            _ => SchemeType::NotSpecial,
        }
    }

    fn is_special(self) -> bool {
        self != SchemeType::NotSpecial
    }
}

/// Default port of a scheme.
pub fn default_port(scheme: &str) -> Option<u16> {
    match scheme {
        "http" | "ws" => Some(80),
        "https" | "wss" => Some(443),
        "ftp" => Some(21),
        _ => None,
    }
}

/// URL components while parsing.
#[derive(Default)]
struct Parts {
    scheme: String,
    /// serialized `user[:pass]` (without `@`)
    userinfo: String,
    /// serialized host; `None` without authority
    host: Option<String>,
    port: Option<u16>,
    path: String,
    query: Option<String>,
    fragment: Option<String>,
}

impl Parts {
    fn build(self) -> Url {
        let mut s = self.scheme;
        let scheme_end = s.len();
        s.push(':');
        let mut host = None;
        if let Some(h) = &self.host {
            s.push_str("//");
            if !self.userinfo.is_empty() {
                s.push_str(&self.userinfo);
                s.push('@');
            }
            let start = s.len();
            s.push_str(h);
            host = Some((start, s.len()));
            if let Some(p) = self.port {
                s.push(':');
                s.push_str(&p.to_string());
            }
        } else if self.path.starts_with("//") {
            // keep a host-less path from looking like an authority
            s.push_str("/.");
        }
        let path_start = s.len();
        s.push_str(&self.path);
        let query_start = self.query.as_ref().map(|q| {
            let at = s.len();
            s.push('?');
            s.push_str(q);
            at
        });
        let fragment_start = self.fragment.as_ref().map(|f| {
            let at = s.len();
            s.push('#');
            s.push_str(f);
            at
        });
        Url {
            serialization: s,
            scheme_end,
            host,
            port: self.port,
            path_start,
            query_start,
            fragment_start,
        }
    }
}

fn split_scheme(input: &str) -> Option<(String, &str)> {
    let colon = input.find(':')?;
    let scheme = &input[..colon];
    let mut chars = scheme.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic()
        || !chars.all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), &input[colon + 1..]))
}

/// Trims C0 controls and spaces at both ends and drops tabs and newlines.
fn clean(input: &str) -> String {
    input
        .trim_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect()
}

fn is_sep(c: char, special: bool) -> bool {
    c == '/' || (special && c == '\\')
}

impl Url {
    /// Parses an absolute URL.
    pub fn parse(input: &str) -> Result<Url, ParseError> {
        parse(&clean(input), None)
    }

    /// Resolves `input` against this URL (`new URL(input, base)`).
    pub fn join(&self, input: &str) -> Result<Url, ParseError> {
        parse(&clean(input), Some(self))
    }

    pub fn as_str(&self) -> &str {
        &self.serialization
    }

    pub fn scheme(&self) -> &str {
        &self.serialization[..self.scheme_end]
    }

    /// Serialized host (domains lowercase, IPv6 in brackets); `None` when empty.
    pub fn host_str(&self) -> Option<&str> {
        self.host.map(|(a, b)| &self.serialization[a..b]).filter(|h| !h.is_empty())
    }

    /// Explicit port (default ports are elided).
    pub fn port(&self) -> Option<u16> {
        self.port
    }

    pub fn port_or_known_default(&self) -> Option<u16> {
        self.port.or_else(|| default_port(self.scheme()))
    }

    pub fn path(&self) -> &str {
        let end = self.query_start.or(self.fragment_start).unwrap_or(self.serialization.len());
        &self.serialization[self.path_start..end]
    }

    pub fn query(&self) -> Option<&str> {
        let start = self.query_start? + 1;
        let end = self.fragment_start.unwrap_or(self.serialization.len());
        Some(&self.serialization[start..end])
    }

    pub fn fragment(&self) -> Option<&str> {
        self.fragment_start.map(|i| &self.serialization[i + 1..])
    }

    /// Percent-encoded username (empty without credentials).
    pub fn username(&self) -> &str {
        let info = self.userinfo();
        info.split_once(':').map_or(info, |(user, _)| user)
    }

    /// Percent-encoded password, if any.
    pub fn password(&self) -> Option<&str> {
        self.userinfo().split_once(':').map(|(_, pass)| pass)
    }

    /// Serialized `user:pass` (empty without credentials).
    fn userinfo(&self) -> &str {
        match self.host {
            Some((start, _)) => {
                let after = self.scheme_end + 3;
                if start > after { &self.serialization[after..start - 1] } else { "" }
            }
            None => "",
        }
    }

    fn parts(&self) -> Parts {
        Parts {
            scheme: self.scheme().to_string(),
            userinfo: self.userinfo().to_string(),
            host: self.host.map(|(a, b)| self.serialization[a..b].to_string()),
            port: self.port,
            path: self.path().to_string(),
            query: self.query().map(str::to_string),
            fragment: self.fragment().map(str::to_string),
        }
    }

    /// Replaces the query (percent-encoded as needed).
    pub fn set_query(&mut self, query: Option<&str>) {
        let mut parts = self.parts();
        parts.query = query.map(|q| {
            let mut out = String::new();
            let set =
                if SchemeType::of(&parts.scheme).is_special() { SPECIAL_QUERY } else { QUERY };
            percent_encode(&mut out, &clean_newlines(q), set);
            out
        });
        *self = parts.build();
    }

    /// The query as `application/x-www-form-urlencoded` pairs.
    pub fn query_pairs(&self) -> Vec<(String, String)> {
        self.query().map(parse_form).unwrap_or_default()
    }

    /// Replaces the query with form-encoded `pairs`.
    pub fn set_query_pairs<K: AsRef<str>, V: AsRef<str>>(&mut self, pairs: &[(K, V)]) {
        let encoded = serialize_form(pairs);
        let mut parts = self.parts();
        parts.query = Some(encoded);
        *self = parts.build();
    }
}

fn clean_newlines(s: &str) -> String {
    s.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect()
}

impl fmt::Display for Url {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.serialization)
    }
}

impl fmt::Debug for Url {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Url({:?})", self.serialization)
    }
}

impl std::str::FromStr for Url {
    type Err = ParseError;

    fn from_str(s: &str) -> Result<Self, ParseError> {
        Url::parse(s)
    }
}

fn parse(input: &str, base: Option<&Url>) -> Result<Url, ParseError> {
    match split_scheme(input) {
        Some((scheme, rest)) => {
            let ty = SchemeType::of(&scheme);
            if ty == SchemeType::SpecialNotFile
                && let Some(base) = base
                && base.scheme() == scheme
                && rest.chars().take_while(|&c| is_sep(c, true)).count() < 2
            {
                return relative(rest, base);
            }
            if ty == SchemeType::File {
                let base = base.filter(|b| b.scheme() == "file");
                return parse_file(rest, base);
            }
            absolute(scheme, ty, rest)
        }
        None => {
            let base = base.ok_or(ParseError::MissingScheme)?;
            if base.scheme() == "file" {
                return parse_file(input, Some(base));
            }
            relative(input, base)
        }
    }
}

fn absolute(scheme: String, ty: SchemeType, rest: &str) -> Result<Url, ParseError> {
    let mut parts = Parts { scheme, ..Parts::default() };
    match ty {
        SchemeType::SpecialNotFile => {
            let rest = rest.trim_start_matches(['/', '\\']);
            let rest = authority(&mut parts, rest, ty)?;
            path_query_fragment(&mut parts, rest, ty, Vec::new(), true)?;
        }
        SchemeType::NotSpecial => {
            if let Some(after) = rest.strip_prefix("//") {
                let rest = authority(&mut parts, after, ty)?;
                path_query_fragment(&mut parts, rest, ty, Vec::new(), true)?;
            } else if rest.starts_with('/') {
                path_query_fragment(&mut parts, rest, ty, Vec::new(), true)?;
            } else {
                opaque(&mut parts, rest);
            }
        }
        SchemeType::File => unreachable!("file urls use parse_file"),
    }
    Ok(parts.build())
}

/// Cannot-be-a-base path, query and fragment.
fn opaque(parts: &mut Parts, rest: &str) {
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    percent_encode(&mut parts.path, &rest[..end], CONTROLS);
    query_fragment(parts, &rest[end..], SchemeType::NotSpecial);
}

fn query_fragment(parts: &mut Parts, rest: &str, ty: SchemeType) {
    let (before, fragment) = match rest.find('#') {
        Some(i) => (&rest[..i], Some(&rest[i + 1..])),
        None => (rest, None),
    };
    if let Some(q) = before.strip_prefix('?') {
        let mut out = String::new();
        percent_encode(&mut out, q, if ty.is_special() { SPECIAL_QUERY } else { QUERY });
        parts.query = Some(out);
    }
    if let Some(f) = fragment {
        let mut out = String::new();
        percent_encode(&mut out, f, FRAGMENT);
        parts.fragment = Some(out);
    }
}

/// Parses `[userinfo@]host[:port]`; returns the rest (path onwards).
fn authority<'a>(parts: &mut Parts, input: &'a str, ty: SchemeType) -> Result<&'a str, ParseError> {
    let special = ty.is_special();
    let end = input
        .find(|c: char| c == '/' || c == '?' || c == '#' || (special && c == '\\'))
        .unwrap_or(input.len());
    let (auth, rest) = input.split_at(end);
    let hostport = match auth.rfind('@') {
        Some(at) => {
            let userinfo = &auth[..at];
            let hostport = &auth[at + 1..];
            if hostport.is_empty() {
                return Err(ParseError::EmptyHost);
            }
            let (user, pass) = match userinfo.find(':') {
                Some(i) => (&userinfo[..i], Some(&userinfo[i + 1..])),
                None => (userinfo, None),
            };
            percent_encode(&mut parts.userinfo, user, USERINFO);
            if let Some(pass) = pass.filter(|p| !p.is_empty()) {
                parts.userinfo.push(':');
                percent_encode(&mut parts.userinfo, pass, USERINFO);
            }
            hostport
        }
        None => auth,
    };
    // the host ends at a `:` outside brackets
    let mut in_brackets = false;
    let mut colon = None;
    for (i, c) in hostport.char_indices() {
        match c {
            '[' => in_brackets = true,
            ']' => in_brackets = false,
            ':' if !in_brackets => {
                colon = Some(i);
                break;
            }
            _ => {}
        }
    }
    let (host, port) = match colon {
        Some(i) => (&hostport[..i], Some(&hostport[i + 1..])),
        None => (hostport, None),
    };
    if host.is_empty() && (special || port.is_some()) {
        return Err(ParseError::EmptyHost);
    }
    if host.is_empty() && !parts.userinfo.is_empty() {
        return Err(ParseError::EmptyHost);
    }
    parts.host = Some(if special { parse_host(host)? } else { parse_opaque_host(host)? });
    if let Some(port) = port
        && !port.is_empty()
    {
        if !port.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ParseError::InvalidPort);
        }
        let mut n: u32 = 0;
        for b in port.bytes() {
            n = n * 10 + u32::from(b - b'0');
            if n > u32::from(u16::MAX) {
                return Err(ParseError::InvalidPort);
            }
        }
        let n = n as u16;
        if default_port(&parts.scheme) != Some(n) {
            parts.port = Some(n);
        }
    }
    Ok(rest)
}

/// Path segments of a serialized absolute path (`/a/b` → `["a", "b"]`).
fn segments(path: &str) -> Vec<String> {
    match path.strip_prefix('/') {
        Some(rest) => rest.split('/').map(str::to_string).collect(),
        None if path.is_empty() => Vec::new(),
        None => vec![path.to_string()],
    }
}

fn is_single_dot(s: &str) -> bool {
    s == "." || s.eq_ignore_ascii_case("%2e")
}

fn is_double_dot(s: &str) -> bool {
    matches!(s.to_ascii_lowercase().as_str(), ".." | ".%2e" | "%2e." | "%2e%2e")
}

/// Parses a path (from its first segment, any leading separator removed)
/// onto `segs`, then query and fragment.
fn path_query_fragment(
    parts: &mut Parts,
    input: &str,
    ty: SchemeType,
    mut segs: Vec<String>,
    strip_leading: bool,
) -> Result<(), ParseError> {
    let special = ty.is_special();
    let end = input.find(['?', '#']).unwrap_or(input.len());
    let (path, rest) = input.split_at(end);
    let mut path = path;
    let had_path = !path.is_empty();
    if strip_leading
        && let Some(c) = path.chars().next()
        && is_sep(c, special)
    {
        path = &path[1..];
    }
    if special || had_path || !segs.is_empty() {
        let raw: Vec<&str> = path.split(|c: char| is_sep(c, special)).collect();
        let last = raw.len() - 1;
        for (i, seg) in raw.iter().enumerate() {
            let mut enc = String::new();
            percent_encode(&mut enc, seg, PATH);
            if is_double_dot(&enc) {
                segs.pop();
                if i == last {
                    segs.push(String::new());
                }
            } else if is_single_dot(&enc) {
                if i == last {
                    segs.push(String::new());
                }
            } else {
                segs.push(enc);
            }
        }
        parts.path = if segs.is_empty() && !special {
            String::new()
        } else {
            let mut p = String::new();
            for s in &segs {
                p.push('/');
                p.push_str(s);
            }
            if p.is_empty() { "/".into() } else { p }
        };
    }
    query_fragment(parts, rest, ty);
    Ok(())
}

fn relative(input: &str, base: &Url) -> Result<Url, ParseError> {
    let ty = SchemeType::of(base.scheme());
    let special = ty.is_special();
    if base.host.is_none() && !base.path().starts_with('/') {
        // opaque base: only a fragment may be replaced
        let Some(fragment) = input.strip_prefix('#') else {
            return Err(ParseError::CannotBeABase);
        };
        let mut parts = base.parts();
        parts.fragment = None;
        query_fragment(&mut parts, &format!("#{fragment}"), ty);
        return Ok(parts.build());
    }
    let mut parts = base.parts();
    parts.fragment = None;
    let first = input.chars().next();
    match first {
        None => {
            return Ok(parts.build());
        }
        Some('?') => {
            parts.query = None;
            query_fragment(&mut parts, input, ty);
        }
        Some('#') => {
            query_fragment(&mut parts, input, ty);
        }
        Some(c) if is_sep(c, special) => {
            let slashes = input.chars().take_while(|&c| is_sep(c, special)).count();
            if slashes >= 2 {
                let mut fresh = Parts { scheme: parts.scheme, ..Parts::default() };
                let after =
                    if special { input.trim_start_matches(['/', '\\']) } else { &input[2..] };
                let rest = authority(&mut fresh, after, ty)?;
                path_query_fragment(&mut fresh, rest, ty, Vec::new(), true)?;
                return Ok(fresh.build());
            }
            parts.query = None;
            path_query_fragment(&mut parts, input, ty, Vec::new(), true)?;
        }
        Some(_) => {
            let mut segs = segments(&parts.path);
            segs.pop();
            parts.query = None;
            path_query_fragment(&mut parts, input, ty, segs, false)?;
        }
    }
    Ok(parts.build())
}

/// `file:` URLs: optional host (`localhost` → none), absolute path.
fn parse_file(rest: &str, base: Option<&Url>) -> Result<Url, ParseError> {
    let mut parts = Parts { scheme: "file".into(), host: Some(String::new()), ..Parts::default() };
    let slashes = rest.chars().take_while(|&c| is_sep(c, true)).count();
    if slashes >= 2 {
        let after = &rest[2..];
        let end = after.find(['/', '\\', '?', '#']).unwrap_or(after.len());
        let host = &after[..end];
        if !host.is_empty() {
            let h = parse_host(host)?;
            parts.host = Some(if h == "localhost" { String::new() } else { h });
        }
        path_query_fragment(&mut parts, &after[end..], SchemeType::File, Vec::new(), true)?;
        return Ok(parts.build());
    }
    match base {
        Some(base) if slashes == 0 => {
            parts.host = Some(base.host_str().unwrap_or_default().to_string());
            let mut base_parts = base.parts();
            base_parts.fragment = None;
            match rest.chars().next() {
                None => return Ok(base_parts.build()),
                Some('?') => {
                    base_parts.query = None;
                    query_fragment(&mut base_parts, rest, SchemeType::File);
                    return Ok(base_parts.build());
                }
                Some('#') => {
                    query_fragment(&mut base_parts, rest, SchemeType::File);
                    return Ok(base_parts.build());
                }
                Some(_) => {
                    let mut segs = segments(&base_parts.path);
                    segs.pop();
                    path_query_fragment(&mut parts, rest, SchemeType::File, segs, false)?;
                }
            }
        }
        Some(base) => {
            parts.host = Some(base.host_str().unwrap_or_default().to_string());
            path_query_fragment(&mut parts, rest, SchemeType::File, Vec::new(), true)?;
        }
        None => path_query_fragment(&mut parts, rest, SchemeType::File, Vec::new(), true)?,
    }
    Ok(parts.build())
}

const FORBIDDEN_HOST: &[char] =
    &['\0', '\t', '\n', '\r', ' ', '#', '/', ':', '<', '>', '?', '@', '[', '\\', ']', '^', '|'];

fn parse_opaque_host(input: &str) -> Result<String, ParseError> {
    if let Some(inner) = input.strip_prefix('[') {
        let inner = inner.strip_suffix(']').ok_or(ParseError::InvalidIpv6Address)?;
        return Ok(format!("[{}]", serialize_ipv6(parse_ipv6(inner)?)));
    }
    if input.contains(FORBIDDEN_HOST) {
        return Err(ParseError::InvalidDomainCharacter);
    }
    let mut out = String::new();
    percent_encode(&mut out, input, CONTROLS);
    Ok(out)
}

/// Host parser for special schemes: IPv6 literal, domain or IPv4.
pub fn parse_host(input: &str) -> Result<String, ParseError> {
    if let Some(inner) = input.strip_prefix('[') {
        let inner = inner.strip_suffix(']').ok_or(ParseError::InvalidIpv6Address)?;
        return Ok(format!("[{}]", serialize_ipv6(parse_ipv6(inner)?)));
    }
    let decoded = percent_decode(input.as_bytes());
    let decoded = String::from_utf8(decoded).map_err(|_| ParseError::InvalidDomainCharacter)?;
    let domain = domain_to_ascii(&decoded)?;
    if domain.is_empty() {
        return Err(ParseError::EmptyHost);
    }
    if ends_in_a_number(&domain) {
        return Ok(parse_ipv4(&domain)?.to_string());
    }
    Ok(domain)
}

fn is_forbidden_domain(c: char) -> bool {
    c <= ' ' || c == '\x7f' || "#%/:<>?@[\\]^|".contains(c)
}

fn domain_to_ascii(domain: &str) -> Result<String, ParseError> {
    let mut labels = Vec::new();
    for label in domain.split('.') {
        let ascii = if label.is_ascii() {
            let lower = label.to_ascii_lowercase();
            if let Some(encoded) = lower.strip_prefix("xn--") {
                let decoded = punycode_decode(encoded).ok_or(ParseError::InvalidDomainCharacter)?;
                let canonical = punycode_encode(&decoded).is_some_and(|e| e == encoded);
                if decoded.is_empty()
                    || decoded.iter().all(char::is_ascii)
                    || decoded
                        .iter()
                        .any(|c| c.is_control() || c.is_whitespace() || c.is_uppercase())
                    || !canonical
                {
                    return Err(ParseError::InvalidDomainCharacter);
                }
            }
            lower
        } else {
            let lower: String = label.chars().flat_map(char::to_lowercase).collect();
            if lower.is_ascii() {
                lower
            } else {
                let chars: Vec<char> = lower.chars().collect();
                format!(
                    "xn--{}",
                    punycode_encode(&chars).ok_or(ParseError::InvalidDomainCharacter)?
                )
            }
        };
        if ascii.chars().any(is_forbidden_domain) {
            return Err(ParseError::InvalidDomainCharacter);
        }
        labels.push(ascii);
    }
    Ok(labels.join("."))
}

fn ends_in_a_number(input: &str) -> bool {
    let mut parts = input.rsplit('.');
    let last = parts.next().unwrap_or_default();
    let last = if last.is_empty() {
        match parts.next() {
            Some(l) => l,
            None => return false,
        }
    } else {
        last
    };
    if !last.is_empty() && last.bytes().all(|c| c.is_ascii_digit()) {
        return true;
    }
    parse_ipv4_number(last).is_ok()
}

/// `Ok(None)` for a valid number that overflows `u32`.
fn parse_ipv4_number(mut input: &str) -> Result<Option<u32>, ()> {
    if input.is_empty() {
        return Err(());
    }
    let mut radix = 10;
    if input.starts_with("0x") || input.starts_with("0X") {
        input = &input[2..];
        radix = 16;
    } else if input.len() >= 2 && input.starts_with('0') {
        input = &input[1..];
        radix = 8;
    }
    if input.is_empty() {
        return Ok(Some(0));
    }
    let valid = match radix {
        8 => input.bytes().all(|c| (b'0'..=b'7').contains(&c)),
        10 => input.bytes().all(|c| c.is_ascii_digit()),
        _ => input.bytes().all(|c| c.is_ascii_hexdigit()),
    };
    if !valid {
        return Err(());
    }
    Ok(u32::from_str_radix(input, radix).ok())
}

fn parse_ipv4(input: &str) -> Result<Ipv4Addr, ParseError> {
    let mut parts: Vec<&str> = input.split('.').collect();
    if parts.last() == Some(&"") {
        parts.pop();
    }
    if parts.len() > 4 {
        return Err(ParseError::InvalidIpv4Address);
    }
    let mut numbers = Vec::with_capacity(4);
    for part in parts {
        match parse_ipv4_number(part) {
            Ok(Some(n)) => numbers.push(n),
            _ => return Err(ParseError::InvalidIpv4Address),
        }
    }
    let mut ipv4 = numbers.pop().ok_or(ParseError::InvalidIpv4Address)?;
    if ipv4 > u32::MAX >> (8 * numbers.len() as u32) {
        return Err(ParseError::InvalidIpv4Address);
    }
    if numbers.iter().any(|n| *n > 255) {
        return Err(ParseError::InvalidIpv4Address);
    }
    for (i, n) in numbers.iter().enumerate() {
        ipv4 += n << (8 * (3 - i as u32));
    }
    Ok(Ipv4Addr::from(ipv4))
}

/// WHATWG IPv6 parser.
fn parse_ipv6(input: &str) -> Result<Ipv6Addr, ParseError> {
    use ParseError::InvalidIpv6Address as E;
    let input = input.as_bytes();
    let len = input.len();
    let mut pieces = [0u16; 8];
    let mut piece = 0;
    let mut compress = None;
    let mut i = 0;
    if len < 2 {
        return Err(E);
    }
    if input[0] == b':' {
        if input[1] != b':' {
            return Err(E);
        }
        i = 2;
        piece = 1;
        compress = Some(1);
    }
    while i < len {
        if piece == 8 {
            return Err(E);
        }
        if input[i] == b':' {
            if compress.is_some() {
                return Err(E);
            }
            i += 1;
            piece += 1;
            compress = Some(piece);
            continue;
        }
        let start = i;
        let end = len.min(start + 4);
        let mut value = 0u16;
        while i < end {
            match hex_val(input[i]) {
                Some(d) => {
                    value = value * 0x10 + u16::from(d);
                    i += 1;
                }
                None => break,
            }
        }
        if i < len {
            match input[i] {
                b'.' => {
                    if i == start {
                        return Err(E);
                    }
                    i = start;
                    if piece > 6 {
                        return Err(E);
                    }
                    let mut numbers_seen = 0;
                    while i < len {
                        if numbers_seen > 0 {
                            if numbers_seen < 4 && i < len && input[i] == b'.' {
                                i += 1;
                            } else {
                                return Err(E);
                            }
                        }
                        let mut ipv4_piece: Option<u16> = None;
                        while i < len {
                            let digit = match input[i] {
                                c @ b'0'..=b'9' => u16::from(c - b'0'),
                                _ => break,
                            };
                            match ipv4_piece {
                                None => ipv4_piece = Some(digit),
                                Some(0) => return Err(E),
                                Some(ref mut v) => {
                                    *v = *v * 10 + digit;
                                    if *v > 255 {
                                        return Err(E);
                                    }
                                }
                            }
                            i += 1;
                        }
                        pieces[piece] = match ipv4_piece {
                            Some(v) => pieces[piece] * 0x100 + v,
                            None => return Err(E),
                        };
                        numbers_seen += 1;
                        if numbers_seen == 2 || numbers_seen == 4 {
                            piece += 1;
                        }
                    }
                    if numbers_seen != 4 {
                        return Err(E);
                    }
                    if i < len {
                        return Err(E);
                    }
                    break;
                }
                b':' => {
                    i += 1;
                    if i == len {
                        return Err(E);
                    }
                }
                _ => return Err(E),
            }
        }
        if piece == 8 {
            return Err(E);
        }
        pieces[piece] = value;
        piece += 1;
    }
    match compress {
        Some(c) => {
            let mut swaps = piece - c;
            piece = 7;
            while piece != 0 && swaps > 0 {
                pieces.swap(piece, c + swaps - 1);
                swaps -= 1;
                piece -= 1;
            }
        }
        None => {
            if piece != 8 {
                return Err(E);
            }
        }
    }
    Ok(Ipv6Addr::from(pieces))
}

/// WHATWG IPv6 serialization (longest zero run compressed, lowercase hex).
fn serialize_ipv6(addr: Ipv6Addr) -> String {
    let segs = addr.segments();
    let (mut best_start, mut best_len) = (None, 1);
    let mut i = 0;
    while i < 8 {
        if segs[i] == 0 {
            let start = i;
            while i < 8 && segs[i] == 0 {
                i += 1;
            }
            if i - start > best_len {
                best_len = i - start;
                best_start = Some(start);
            }
        } else {
            i += 1;
        }
    }
    let mut out = String::new();
    let mut i = 0;
    while i < 8 {
        if best_start == Some(i) {
            out.push_str(if i == 0 { "::" } else { ":" });
            i += best_len;
            continue;
        }
        out.push_str(&format!("{:x}", segs[i]));
        if i < 7 {
            out.push(':');
        }
        i += 1;
    }
    out
}

const PUNY_BASE: u32 = 36;
const PUNY_TMIN: u32 = 1;
const PUNY_TMAX: u32 = 26;

fn puny_adapt(mut delta: u32, points: u32, first: bool) -> u32 {
    delta /= if first { 700 } else { 2 };
    delta += delta / points;
    let mut k = 0;
    while delta > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) / 2 {
        delta /= PUNY_BASE - PUNY_TMIN;
        k += PUNY_BASE;
    }
    k + (PUNY_BASE - PUNY_TMIN + 1) * delta / (delta + 38)
}

fn puny_digit(d: u32) -> char {
    (if d < 26 { b'a' + d as u8 } else { b'0' + (d - 26) as u8 }) as char
}

/// RFC 3492 encoding of a label (without the `xn--` prefix).
fn punycode_encode(input: &[char]) -> Option<String> {
    let mut out: String = input.iter().filter(|c| c.is_ascii()).collect();
    let basic = out.len() as u32;
    if basic > 0 {
        out.push('-');
    }
    let (mut n, mut delta, mut bias, mut handled) = (128u32, 0u32, 72u32, basic);
    while (handled as usize) < input.len() {
        let m = input.iter().map(|&c| c as u32).filter(|&c| c >= n).min()?;
        delta = delta.checked_add((m - n).checked_mul(handled + 1)?)?;
        n = m;
        for &c in input {
            let c = c as u32;
            if c < n {
                delta = delta.checked_add(1)?;
            }
            if c == n {
                let mut q = delta;
                let mut k = PUNY_BASE;
                loop {
                    let t = if k <= bias {
                        PUNY_TMIN
                    } else if k >= bias + PUNY_TMAX {
                        PUNY_TMAX
                    } else {
                        k - bias
                    };
                    if q < t {
                        break;
                    }
                    out.push(puny_digit(t + (q - t) % (PUNY_BASE - t)));
                    q = (q - t) / (PUNY_BASE - t);
                    k += PUNY_BASE;
                }
                out.push(puny_digit(q));
                bias = puny_adapt(delta, handled + 1, handled == basic);
                delta = 0;
                handled += 1;
            }
        }
        delta = delta.checked_add(1)?;
        n = n.checked_add(1)?;
    }
    Some(out)
}

/// RFC 3492 decoding (lowercase input), `None` when invalid.
fn punycode_decode(input: &str) -> Option<Vec<char>> {
    let (basic, encoded) = match input.rfind('-') {
        Some(i) => (&input[..i], &input[i + 1..]),
        None => ("", input),
    };
    if !basic.is_ascii() {
        return None;
    }
    let mut out: Vec<char> = basic.chars().collect();
    let (mut n, mut i, mut bias) = (128u32, 0u32, 72u32);
    let mut iter = encoded.bytes().peekable();
    while iter.peek().is_some() {
        let old_i = i;
        let mut w = 1u32;
        let mut k = PUNY_BASE;
        loop {
            let b = iter.next()?;
            let digit = match b {
                b'a'..=b'z' => u32::from(b - b'a'),
                b'A'..=b'Z' => u32::from(b - b'A'),
                b'0'..=b'9' => u32::from(b - b'0') + 26,
                _ => return None,
            };
            i = i.checked_add(digit.checked_mul(w)?)?;
            let t = if k <= bias {
                PUNY_TMIN
            } else if k >= bias + PUNY_TMAX {
                PUNY_TMAX
            } else {
                k - bias
            };
            if digit < t {
                break;
            }
            w = w.checked_mul(PUNY_BASE - t)?;
            k += PUNY_BASE;
        }
        let len = out.len() as u32 + 1;
        bias = puny_adapt(i - old_i, len, old_i == 0);
        n = n.checked_add(i / len)?;
        i %= len;
        let c = char::from_u32(n)?;
        out.insert(i as usize, c);
        i += 1;
    }
    Some(out)
}

/// Parses `application/x-www-form-urlencoded` pairs.
pub fn parse_form(input: &str) -> Vec<(String, String)> {
    input
        .split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let decode = |s: &str| {
                let plus = s.replace('+', " ");
                String::from_utf8_lossy(&percent_decode(plus.as_bytes())).into_owned()
            };
            (decode(k), decode(v))
        })
        .collect()
}

/// Serializes `application/x-www-form-urlencoded` pairs.
pub fn serialize_form<K: AsRef<str>, V: AsRef<str>>(pairs: &[(K, V)]) -> String {
    let mut out = String::new();
    let encode = |out: &mut String, s: &str| {
        for b in s.bytes() {
            match b {
                b'*' | b'-' | b'.' | b'_' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z' => {
                    out.push(b as char)
                }
                b' ' => out.push('+'),
                _ => push_hex(out, b),
            }
        }
    };
    for (i, (k, v)) in pairs.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        encode(&mut out, k.as_ref());
        out.push('=');
        encode(&mut out, v.as_ref());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> String {
        Url::parse(s).map(|u| u.to_string()).unwrap_or_else(|e| format!("ERR {e}"))
    }

    #[test]
    fn normalization() {
        assert_eq!(p("HTTP://Example.COM:80/a/./b/../c?x=1#f"), "http://example.com/a/c?x=1#f");
        assert_eq!(p("http://2130706433/"), "http://127.0.0.1/");
        assert_eq!(p("http://0x7f.1/"), "http://127.0.0.1/");
        assert_eq!(p("http://0177.0.0.1/"), "http://127.0.0.1/");
        assert_eq!(p("http://[0:0::1]:8080"), "http://[::1]:8080/");
        assert_eq!(p("http://[::ffff:1.2.3.4]/"), "http://[::ffff:102:304]/");
        assert_eq!(p("https://a.test:443"), "https://a.test/");
        assert_eq!(p("http:\\\\a.test\\x\\y"), "http://a.test/x/y");
        assert_eq!(p("http:a.test/x"), "http://a.test/x");
        assert_eq!(p(" http://a.test/a b\t\n?q r'#f g "), "http://a.test/a%20b?q%20r%27#f%20g");
        assert_eq!(p("http://u:p@a.test/"), "http://u:p@a.test/");
        assert_eq!(p("http://ex%41mple.com/"), "http://example.com/");
        assert_eq!(p("http://bücher.de/"), "http://xn--bcher-kva.de/");
        assert_eq!(p("http://a.test/é"), "http://a.test/%C3%A9");
        assert_eq!(p("ws://a.test/x"), "ws://a.test/x");
        assert_eq!(p("mailto:a@b"), "mailto:a@b");
        assert_eq!(p("foo://Host/a/../b"), "foo://Host/b");
    }

    #[test]
    fn errors() {
        for bad in [
            "a.test/x",
            "http://",
            "http://a.test:99999/",
            "http://a.test:8x/",
            "http://1.2.3.256/",
            "http://[::1/",
            "http://a b/",
            "http://a%2fb/",
            "http://@/",
            "http://xn--a/",
            "http://:80/",
        ] {
            assert!(Url::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn accessors() {
        let u = Url::parse("https://[::1]:8443/p/q?x=1&y=a+b%21#frag").unwrap();
        assert_eq!(u.scheme(), "https");
        assert_eq!(u.host_str(), Some("[::1]"));
        assert_eq!(u.port(), Some(8443));
        assert_eq!(u.path(), "/p/q");
        assert_eq!(u.query(), Some("x=1&y=a+b%21"));
        assert_eq!(u.fragment(), Some("frag"));
        assert_eq!(u.query_pairs(), vec![("x".into(), "1".into()), ("y".into(), "a b!".into())]);
        let u = Url::parse("http://a.test").unwrap();
        assert_eq!(u.port_or_known_default(), Some(80));
        assert_eq!(u.path(), "/");
    }

    #[test]
    fn joins() {
        let base = Url::parse("http://a.test/b/c/d?q#f").unwrap();
        let j =
            |s: &str| base.join(s).map(|u| u.to_string()).unwrap_or_else(|e| format!("ERR {e}"));
        assert_eq!(j("g"), "http://a.test/b/c/g");
        assert_eq!(j("./g/"), "http://a.test/b/c/g/");
        assert_eq!(j("../g"), "http://a.test/b/g");
        assert_eq!(j("../../../g"), "http://a.test/g");
        assert_eq!(j("/g"), "http://a.test/g");
        assert_eq!(j("//other.test/x"), "http://other.test/x");
        assert_eq!(j("?y"), "http://a.test/b/c/d?y");
        assert_eq!(j("#s"), "http://a.test/b/c/d?q#s");
        assert_eq!(j(""), "http://a.test/b/c/d?q");
        assert_eq!(j("https://x.test"), "https://x.test/");
        assert_eq!(j("http:g"), "http://a.test/b/c/g");
        assert_eq!(j(".."), "http://a.test/b/");
        assert_eq!(j("\\\\h\\x"), "http://h/x");
    }

    #[test]
    fn query_updates() {
        let mut u = Url::parse("http://a.test/x?token=1&b=2").unwrap();
        u.set_query_pairs(&[("token", "a b&c"), ("b", "2")]);
        assert_eq!(u.as_str(), "http://a.test/x?token=a+b%26c&b=2");
        u.set_query(None);
        assert_eq!(u.as_str(), "http://a.test/x");
        u.set_query(Some("a b"));
        assert_eq!(u.as_str(), "http://a.test/x?a%20b");
    }

    #[test]
    fn punycode() {
        let enc = punycode_encode(&"bücher".chars().collect::<Vec<_>>()).unwrap();
        assert_eq!(enc, "bcher-kva");
        assert_eq!(punycode_decode(&enc).unwrap().iter().collect::<String>(), "bücher");
        assert!(punycode_decode("a!").is_none());
    }
}

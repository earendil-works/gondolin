//! Header conversions and hop-by-hop rules (ports of `stripHopByHopHeaders`,
//! `stripHopByHopHeadersForWebSocket`, `coalesceHeaderRecord`,
//! `isWebSocketUpgradeRequestHeaders`).
//!
//! Header values are carried as strings with one char per byte (latin1), like
//! the node engine's `latin1` header parsing.

use gondolin_http::Header;
use gondolin_http::head::{valid_name, valid_value};

use crate::hooks::header_get;

const HOP_BY_HOP: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
];

/// WebSocket upgrade headers re-injected after request hooks.
pub const WEBSOCKET_UPGRADE_HEADER_NAMES: [&str; 6] = [
    "connection",
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
];

/// Header bytes as a latin1 string.
pub fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

/// String back to header bytes (latin1 when possible, else UTF-8); CR/LF
/// become spaces like `renderHttpResponseHead` does.
pub fn to_header_value(value: &str) -> Option<Vec<u8>> {
    let cleaned: std::borrow::Cow<'_, str> = if value.contains(['\r', '\n']) {
        value.replace(['\r', '\n'], " ").into()
    } else {
        value.into()
    };
    let bytes: Vec<u8> = if cleaned.chars().all(|c| (c as u32) <= 0xff) {
        cleaned.chars().map(|c| c as u8).collect()
    } else {
        cleaned.as_bytes().to_vec()
    };
    valid_value(&bytes).then_some(bytes)
}

/// Request headers coalesced per name (cookie with `; `, others with `, `),
/// lowercase and sorted by name like WHATWG `Headers` iteration.
pub fn coalesce_request_headers(headers: &[Header]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::with_capacity(headers.len());
    for h in headers {
        let name = h.name.to_ascii_lowercase();
        let value = latin1(&h.value);
        match out.iter_mut().find(|(k, _)| *k == name) {
            Some((_, joined)) => {
                joined.push_str(if name == "cookie" { "; " } else { ", " });
                joined.push_str(&value);
            }
            None => out.push((name, value)),
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Response headers as a list (repeated names kept, e.g. `set-cookie`).
pub fn response_headers(headers: &[Header]) -> Vec<(String, String)> {
    headers.iter().map(|h| (h.name.to_ascii_lowercase(), latin1(&h.value))).collect()
}

/// Wire headers with lowercase names; invalid names/values are skipped.
pub fn to_wire_headers(headers: &[(String, String)]) -> Vec<Header> {
    let mut out = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        if !valid_name(name.as_bytes()) {
            continue;
        }
        if let Some(value) = to_header_value(value) {
            out.push(Header { name: name.to_ascii_lowercase(), value });
        }
    }
    out
}

fn connection_tokens(headers: &[(String, String)]) -> Vec<String> {
    headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("connection"))
        .flat_map(|(_, v)| {
            v.split(',')
                .map(|t| t.trim().to_ascii_lowercase())
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Removes hop-by-hop headers and headers nominated by `Connection`.
pub fn strip_hop_by_hop(headers: Vec<(String, String)>) -> Vec<(String, String)> {
    let tokens = connection_tokens(&headers);
    headers
        .into_iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v))
        .filter(|(k, _)| !HOP_BY_HOP.contains(&k.as_str()) && !tokens.contains(k))
        .collect()
}

/// Hop-by-hop stripping for WebSocket handshakes: keeps `Connection`/`Upgrade`
/// and the WebSocket headers, drops proxy and body framing headers.
pub fn strip_hop_by_hop_for_websocket(headers: Vec<(String, String)>) -> Vec<(String, String)> {
    const DROP: [&str; 9] = [
        "keep-alive",
        "proxy-connection",
        "proxy-authenticate",
        "proxy-authorization",
        "content-length",
        "transfer-encoding",
        "expect",
        "te",
        "trailer",
    ];
    const KEEP: [&str; 5] = [
        "upgrade",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
        "sec-websocket-extensions",
    ];
    let tokens: Vec<String> =
        connection_tokens(&headers).into_iter().filter(|t| !KEEP.contains(&t.as_str())).collect();
    headers
        .into_iter()
        .filter(|(k, _)| !DROP.contains(&k.as_str()) && !tokens.contains(k))
        .collect()
}

/// `isWebSocketUpgradeRequestHeaders`.
pub fn is_websocket_upgrade(headers: &[(String, String)]) -> bool {
    if header_get(headers, "upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket")) {
        return true;
    }
    header_get(headers, "sec-websocket-key").is_some_and(|v| !v.is_empty())
        || header_get(headers, "sec-websocket-version").is_some_and(|v| !v.is_empty())
}

/// Whether the request asks for any protocol upgrade.
pub fn has_upgrade(headers: &[(String, String)]) -> bool {
    header_get(headers, "upgrade").is_some_and(|v| !v.is_empty())
        || connection_tokens(headers).iter().any(|t| t == "upgrade")
        || header_get(headers, "sec-websocket-key").is_some_and(|v| !v.is_empty())
        || header_get(headers, "sec-websocket-version").is_some_and(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn hop_by_hop_nominated() {
        let out = strip_hop_by_hop(h(&[
            ("connection", "x-foo, keep-alive"),
            ("x-foo", "1"),
            ("x-bar", "2"),
            ("keep-alive", "timeout=5"),
            ("transfer-encoding", "chunked"),
        ]));
        assert_eq!(out, h(&[("x-bar", "2")]));
    }

    #[test]
    fn hop_by_hop_websocket() {
        let out = strip_hop_by_hop_for_websocket(h(&[
            ("connection", "Upgrade, x-foo"),
            ("upgrade", "websocket"),
            ("sec-websocket-key", "k"),
            ("x-foo", "1"),
            ("content-length", "0"),
            ("x-bar", "2"),
        ]));
        assert_eq!(
            out,
            h(&[
                ("connection", "Upgrade, x-foo"),
                ("upgrade", "websocket"),
                ("sec-websocket-key", "k"),
                ("x-bar", "2"),
            ])
        );
    }

    #[test]
    fn coalesce() {
        let map = vec![
            Header::new("x-a", "1"),
            Header::new("cookie", "a=1"),
            Header::new("x-a", "2"),
            Header::new("cookie", "b=2"),
        ];
        assert_eq!(coalesce_request_headers(&map), h(&[("cookie", "a=1; b=2"), ("x-a", "1, 2")]));
    }

    #[test]
    fn latin1_roundtrip() {
        let v = b"caf\xe9".to_vec();
        let s = latin1(&v);
        assert_eq!(to_header_value(&s).unwrap(), v);
        assert_eq!(to_header_value("a\r\nb").unwrap(), b"a  b".to_vec());
        assert!(to_header_value("a\x00b").is_none());
    }
}

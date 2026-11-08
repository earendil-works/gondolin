//! Secret placeholder substitution (port of the secret handling in
//! `host/src/http/hooks.ts`).
//!
//! Strings here are JS-style header strings: header bytes are mapped 1:1 to
//! chars (latin1), so byte offsets of ASCII placeholders are stable.

use gondolin_http::url::Url;
use gondolin_proto::net::{HttpRules, PlaceholderMode, SecretRule};

use crate::error::Blocked;
use crate::hooks::RequestHead;
use crate::patterns::matches_any_host;

#[derive(Debug, Clone, Copy)]
struct Range {
    start: usize,
    end: usize,
}

struct Replacement<'a> {
    start: usize,
    end: usize,
    entry: &'a SecretRule,
}

/// Lowercased hostname of an absolute URL (`""` when unparsable).
pub fn url_hostname(url: &str) -> String {
    Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.to_lowercase())).unwrap_or_default()
}

/// Applies the createHttpHooks secret step to a request head (in place).
///
/// Checks that real secret values only go to allowed hosts and that revoked or
/// deleted values are not sent at all, then replaces placeholders in headers
/// (incl. Basic auth) and optionally URL query parameters.
pub fn apply_secrets(rules: &HttpRules, head: &mut RequestHead) -> Result<(), Blocked> {
    let hostname = url_hostname(&head.url);
    let entries = &rules.secrets;
    let marker = match rules.placeholder_mode {
        PlaceholderMode::Shared => rules.marker.as_deref(),
        PlaceholderMode::Unique => None,
    };

    assert_secret_values_allowed_for_host(
        head,
        &hostname,
        entries,
        rules.replace_secrets_in_query,
    )?;

    if entries.is_empty() {
        return Ok(());
    }

    for (name, value) in head.headers.iter_mut() {
        let mut updated = replace_in_string(value, &hostname, entries, marker)?;
        updated = replace_basic_auth(name, &updated, &hostname, entries, marker)?;
        if updated != *value {
            *value = updated;
        }
    }

    if rules.replace_secrets_in_query {
        head.url = replace_in_url_parameters(&head.url, &hostname, entries, marker)?;
    }
    Ok(())
}

fn unknown(hostname: &str) -> &str {
    if hostname.is_empty() { "unknown" } else { hostname }
}

fn assert_secret_values_allowed_for_host(
    head: &RequestHead,
    hostname: &str,
    entries: &[SecretRule],
    check_query: bool,
) -> Result<(), Blocked> {
    for entry in entries {
        let current: Vec<String> =
            if entry.deleted { Vec::new() } else { vec![entry.value.clone()] };
        if headers_contain_forbidden(&head.headers, &entry.revoked_values, &current)
            || (check_query && query_contains_forbidden(&head.url, &entry.revoked_values, &current))
        {
            return Err(Blocked::forbidden(format!(
                "secret {} revoked for host: {}",
                entry.name,
                unknown(hostname)
            )));
        }

        if entry.deleted {
            let value = std::slice::from_ref(&entry.value);
            if headers_contain_forbidden(&head.headers, value, &[])
                || (check_query && query_contains_forbidden(&head.url, value, &[]))
            {
                return Err(Blocked::forbidden(format!(
                    "secret {} deleted for host: {}",
                    entry.name,
                    unknown(hostname)
                )));
            }
            continue;
        }

        if matches_any_host(hostname, &entry.hosts) {
            continue;
        }

        if headers_contain_values(&head.headers, std::slice::from_ref(&entry.value))
            || (check_query && query_contains_values(&head.url, std::slice::from_ref(&entry.value)))
        {
            return Err(Blocked::forbidden(format!(
                "secret {} not allowed for host: {}",
                entry.name,
                unknown(hostname)
            )));
        }
    }
    Ok(())
}

fn is_auth_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("proxy-authorization")
}

fn headers_contain_values(headers: &[(String, String)], values: &[String]) -> bool {
    let values: Vec<&String> = values.iter().filter(|v| !v.is_empty()).collect();
    if values.is_empty() {
        return false;
    }
    for (name, header_value) in headers {
        if header_value.is_empty() {
            continue;
        }
        for value in &values {
            if header_value.contains(value.as_str()) {
                return true;
            }
            if is_auth_header(name)
                && let Some(decoded) = decode_basic_auth(header_value)
                && decoded.contains(value.as_str())
            {
                return true;
            }
        }
    }
    false
}

fn headers_contain_forbidden(
    headers: &[(String, String)],
    forbidden: &[String],
    allowed: &[String],
) -> bool {
    let forbidden: Vec<&str> =
        forbidden.iter().filter(|v| !v.is_empty()).map(|s| s.as_str()).collect();
    let allowed: Vec<&str> = allowed.iter().filter(|v| !v.is_empty()).map(|s| s.as_str()).collect();
    if forbidden.is_empty() {
        return false;
    }
    for (name, value) in headers {
        if value.is_empty() {
            continue;
        }
        if is_auth_header(name)
            && let Some(decoded) = decode_basic_auth_strict(value)
        {
            if contains_forbidden_outside_allowed(&decoded, &forbidden, &allowed) {
                return true;
            }
            continue;
        }
        if contains_forbidden_outside_allowed(value, &forbidden, &allowed) {
            return true;
        }
    }
    false
}

fn query_pairs(url: &str) -> Option<Vec<(String, String)>> {
    let parsed = Url::parse(url).ok()?;
    match parsed.query() {
        None | Some("") => None,
        Some(_) => Some(parsed.query_pairs()),
    }
}

fn query_contains_values(url: &str, values: &[String]) -> bool {
    let values: Vec<&String> = values.iter().filter(|v| !v.is_empty()).collect();
    if values.is_empty() {
        return false;
    }
    let Some(pairs) = query_pairs(url) else {
        return false;
    };
    pairs.iter().any(|(name, value)| {
        values.iter().any(|s| name.contains(s.as_str()) || value.contains(s.as_str()))
    })
}

fn query_contains_forbidden(url: &str, forbidden: &[String], allowed: &[String]) -> bool {
    let forbidden: Vec<&str> =
        forbidden.iter().filter(|v| !v.is_empty()).map(|s| s.as_str()).collect();
    let allowed: Vec<&str> = allowed.iter().filter(|v| !v.is_empty()).map(|s| s.as_str()).collect();
    if forbidden.is_empty() {
        return false;
    }
    let Some(pairs) = query_pairs(url) else {
        return false;
    };
    pairs.iter().any(|(name, value)| {
        contains_forbidden_outside_allowed(name, &forbidden, &allowed)
            || contains_forbidden_outside_allowed(value, &forbidden, &allowed)
    })
}

fn contains_forbidden_outside_allowed(
    container: &str,
    forbidden: &[&str],
    allowed: &[&str],
) -> bool {
    if container.is_empty() {
        return false;
    }
    let allowed_ranges: Vec<Range> =
        allowed.iter().flat_map(|v| match_ranges(container, v)).collect();
    forbidden
        .iter()
        .any(|f| match_ranges(container, f).into_iter().any(|r| !covered(r, &allowed_ranges)))
}

/// All (overlapping) occurrences of `search` in `container`.
fn match_ranges(container: &str, search: &str) -> Vec<Range> {
    let mut out = Vec::new();
    if search.is_empty() {
        return out;
    }
    let mut from = 0;
    while from <= container.len() {
        let Some(idx) = container[from..].find(search) else {
            break;
        };
        let start = from + idx;
        out.push(Range { start, end: start + search.len() });
        // advance by one char (a match never starts inside a char)
        let step = container[start..].chars().next().map_or(1, char::len_utf8);
        from = start + step;
    }
    out
}

fn covered(candidate: Range, allowed: &[Range]) -> bool {
    allowed.iter().any(|a| a.start <= candidate.start && a.end >= candidate.end)
}

fn replace_in_string(
    value: &str,
    hostname: &str,
    entries: &[SecretRule],
    marker: Option<&str>,
) -> Result<String, Blocked> {
    let secret_ranges: Vec<Range> =
        entries.iter().flat_map(|e| match_ranges(value, &e.value)).collect();
    let mut replacements: Vec<Replacement<'_>> = Vec::new();
    collect_marker_ranges(value, entries, marker, &mut replacements);
    collect_legacy_ranges(value, entries, marker, &mut replacements);
    replacements.retain(|r| !covered(Range { start: r.start, end: r.end }, &secret_ranges));
    apply_replacements(value, hostname, replacements)
}

fn marker_placeholder(marker: &str, entry: &SecretRule) -> String {
    format!("{marker}.{}", entry.identifier)
}

fn collect_legacy_ranges<'a>(
    value: &str,
    entries: &'a [SecretRule],
    marker: Option<&str>,
    out: &mut Vec<Replacement<'a>>,
) {
    for entry in entries {
        if let Some(marker) = marker
            && entry.placeholder == marker_placeholder(marker, entry)
        {
            continue;
        }
        for r in match_ranges(value, &entry.placeholder) {
            out.push(Replacement { start: r.start, end: r.end, entry });
        }
    }
}

fn collect_marker_ranges<'a>(
    value: &str,
    entries: &'a [SecretRule],
    marker: Option<&str>,
    out: &mut Vec<Replacement<'a>>,
) {
    let Some(marker) = marker else {
        return;
    };
    let prefix = format!("{marker}.");
    let bytes = value.as_bytes();
    let mut from = 0;
    while from < value.len() {
        let Some(idx) = value[from..].find(&prefix) else {
            break;
        };
        let start = from + idx;
        let ident_start = start + prefix.len();
        let mut ident_end = ident_start;
        while ident_end < bytes.len()
            && (bytes[ident_end].is_ascii_alphanumeric()
                || bytes[ident_end] == b'_'
                || bytes[ident_end] == b'-')
        {
            ident_end += 1;
        }
        let identifier = &value[ident_start..ident_end];
        if !identifier.is_empty()
            && let Some(entry) = entries.iter().find(|e| {
                e.identifier == identifier && e.placeholder == marker_placeholder(marker, e)
            })
        {
            out.push(Replacement { start, end: ident_end, entry });
        }
        from = ident_start;
    }
}

fn apply_replacements(
    value: &str,
    hostname: &str,
    mut replacements: Vec<Replacement<'_>>,
) -> Result<String, Blocked> {
    if replacements.is_empty() {
        return Ok(value.to_string());
    }
    replacements.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut out = String::with_capacity(value.len());
    let mut offset = 0;
    for r in replacements {
        if r.start < offset {
            continue;
        }
        out.push_str(&value[offset..r.start]);
        if !r.entry.deleted {
            if !matches_any_host(hostname, &r.entry.hosts) {
                return Err(Blocked::forbidden(format!(
                    "secret {} not allowed for host: {}",
                    r.entry.name,
                    unknown(hostname)
                )));
            }
            out.push_str(&r.entry.value);
        }
        offset = r.end;
    }
    out.push_str(&value[offset..]);
    Ok(out)
}

fn replace_in_url_parameters(
    url: &str,
    hostname: &str,
    entries: &[SecretRule],
    marker: Option<&str>,
) -> Result<String, Blocked> {
    let Ok(mut parsed) = Url::parse(url) else {
        return Ok(url.to_string());
    };
    let Some(pairs) = query_pairs(url) else {
        return Ok(url.to_string());
    };
    let mut changed = false;
    let mut updated = Vec::with_capacity(pairs.len());
    for (name, value) in pairs {
        let n = replace_in_string(&name, hostname, entries, marker)?;
        let v = replace_in_string(&value, hostname, entries, marker)?;
        if n != name || v != value {
            changed = true;
        }
        updated.push((n, v));
    }
    if !changed {
        return Ok(url.to_string());
    }
    if updated.is_empty() {
        parsed.set_query(None);
    } else {
        parsed.set_query_pairs(&updated);
    }
    Ok(parsed.to_string())
}

/// Splits `Basic <token>` (`/^(Basic)(\s+)(\S+)(\s*)$/i`).
fn split_basic(value: &str) -> Option<(&str, &str, &str, &str)> {
    // `get`: header strings may hold multi-byte chars (latin1 bytes >= 0x80)
    let scheme = value.get(..5).filter(|s| s.eq_ignore_ascii_case("basic"))?;
    let rest = &value[5..];
    let ws_len = rest.len() - rest.trim_start().len();
    if ws_len == 0 {
        return None;
    }
    let whitespace = &rest[..ws_len];
    let rest = &rest[ws_len..];
    let token_len =
        rest.char_indices().find(|(_, c)| c.is_whitespace()).map_or(rest.len(), |(i, _)| i);
    if token_len == 0 {
        return None;
    }
    let token = &rest[..token_len];
    let trailing = &rest[token_len..];
    if !trailing.chars().all(char::is_whitespace) {
        return None;
    }
    Some((scheme, whitespace, token, trailing))
}

/// Node's lenient `Buffer.from(token, "base64")` (accepts base64url, stops at `=`,
/// skips invalid characters).
fn lenient_base64_decode(token: &str) -> Vec<u8> {
    let mut bits: u32 = 0;
    let mut nbits = 0;
    let mut out = Vec::with_capacity(token.len() * 3 / 4);
    for c in token.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | v as u32;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            out.push((bits >> nbits) as u8);
            bits &= (1 << nbits) - 1;
        }
    }
    out
}

fn base64_encode(data: &[u8]) -> String {
    gondolin_wire::base64::encode(data)
}

/// Header strings carry latin1 chars; Basic tokens are ASCII so this is exact.
fn decode_basic_auth(value: &str) -> Option<String> {
    let (_, _, token, _) = split_basic(value)?;
    Some(String::from_utf8_lossy(&lenient_base64_decode(token)).into_owned())
}

fn decode_basic_auth_strict(value: &str) -> Option<String> {
    let (_, _, token, _) = split_basic(value)?;
    let body = token.trim_end_matches('=');
    let padding = token.len() - body.len();
    if body.is_empty()
        || padding > 2
        || !body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    {
        return None;
    }
    if token.len() % 4 == 1 {
        return None;
    }
    let decoded = String::from_utf8_lossy(&lenient_base64_decode(token)).into_owned();
    let reencoded = base64_encode(decoded.as_bytes());
    if reencoded.trim_end_matches('=') != body {
        return None;
    }
    Some(decoded)
}

fn replace_basic_auth(
    name: &str,
    value: &str,
    hostname: &str,
    entries: &[SecretRule],
    marker: Option<&str>,
) -> Result<String, Blocked> {
    if !is_auth_header(name) {
        return Ok(value.to_string());
    }
    let Some((scheme, whitespace, token, trailing)) = split_basic(value) else {
        return Ok(value.to_string());
    };
    let decoded = String::from_utf8_lossy(&lenient_base64_decode(token)).into_owned();
    let updated = replace_in_string(&decoded, hostname, entries, marker)?;
    if updated == decoded {
        return Ok(value.to_string());
    }
    Ok(format!("{scheme}{whitespace}{}{trailing}", base64_encode(updated.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

    fn secret(name: &str, value: &str, hosts: &[&str]) -> SecretRule {
        let identifier = name.to_lowercase();
        SecretRule {
            name: name.into(),
            placeholder: format!("{MARKER}.{identifier}"),
            identifier,
            value: value.into(),
            revoked_values: vec![],
            hosts: hosts.iter().map(|s| s.to_string()).collect(),
            deleted: false,
        }
    }

    fn rules(secrets: Vec<SecretRule>) -> HttpRules {
        HttpRules { secrets, marker: Some(MARKER.into()), ..HttpRules::default() }
    }

    fn head(url: &str, headers: &[(&str, &str)]) -> RequestHead {
        RequestHead {
            method: "GET".into(),
            url: url.into(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    fn run(rules: &HttpRules, mut h: RequestHead) -> Result<RequestHead, Blocked> {
        apply_secrets(rules, &mut h).map(|_| h)
    }

    fn rotate(entry: &mut SecretRule, value: &str) {
        if !entry.revoked_values.contains(&entry.value) {
            entry.revoked_values.push(entry.value.clone());
        }
        entry.value = value.into();
        let v = entry.value.clone();
        entry.revoked_values.retain(|x| *x != v);
    }

    #[test]
    fn replaces_shared_placeholders() {
        let r = rules(vec![secret("API_KEY", "secret-value", &["example.com"])]);
        let ph = r.secrets[0].placeholder.clone();
        let out = run(
            &r,
            head("https://example.com/data", &[("authorization", &format!("Bearer {ph}"))]),
        )
        .unwrap();
        assert_eq!(out.headers[0].1, "Bearer secret-value");
    }

    #[test]
    fn unique_and_custom_placeholders() {
        let mut s = secret("API_KEY", "secret-value", &["example.com"]);
        s.placeholder = "ghp_placeholder".into();
        let r = rules(vec![s]);
        let out = run(
            &r,
            head("https://example.com/data", &[("authorization", "Bearer ghp_placeholder")]),
        )
        .unwrap();
        assert_eq!(out.headers[0].1, "Bearer secret-value");

        let mut s = secret("API_KEY", "secret-value", &["example.com"]);
        s.placeholder = "GONDOLIN_SECRET_abc".into();
        let mut r = rules(vec![s]);
        r.placeholder_mode = PlaceholderMode::Unique;
        r.marker = None;
        let out = run(
            &r,
            head("https://example.com/data", &[("authorization", "Bearer GONDOLIN_SECRET_abc")]),
        )
        .unwrap();
        assert_eq!(out.headers[0].1, "Bearer secret-value");
    }

    #[test]
    fn no_rewrite_inside_substituted_values() {
        let mut s = secret("API_KEY", "ghp_real", &["example.com"]);
        s.placeholder = "ghp_".into();
        let r = rules(vec![s]);
        let out =
            run(&r, head("https://example.com/", &[("authorization", "Bearer ghp_")])).unwrap();
        assert_eq!(out.headers[0].1, "Bearer ghp_real");
        let out =
            run(&r, head("https://example.com/", &[("authorization", "Bearer ghp_real")])).unwrap();
        assert_eq!(out.headers[0].1, "Bearer ghp_real");
    }

    #[test]
    fn no_cascade() {
        let mut a = secret("FIRST", "second-placeholder", &["example.com"]);
        a.placeholder = "first-placeholder".into();
        let mut b = secret("SECOND", "second-value", &["example.com"]);
        b.placeholder = "second-placeholder".into();
        let r = rules(vec![a, b]);
        let out =
            run(&r, head("https://example.com/", &[("authorization", "Bearer first-placeholder")]))
                .unwrap();
        assert_eq!(out.headers[0].1, "Bearer second-placeholder");
    }

    #[test]
    fn rotation_and_hosts() {
        let mut r = rules(vec![secret("API_KEY", "secret-value", &["example.com"])]);
        let ph = r.secrets[0].placeholder.clone();
        rotate(&mut r.secrets[0], "rotated-value");
        let out =
            run(&r, head("https://example.com/", &[("authorization", &format!("Bearer {ph}"))]))
                .unwrap();
        assert_eq!(out.headers[0].1, "Bearer rotated-value");
        // revoked value rejected even on allowed host
        assert!(
            run(&r, head("https://example.com/", &[("authorization", "Bearer secret-value")]))
                .is_err()
        );

        r.secrets[0].hosts = vec!["example.org".into()];
        let err =
            run(&r, head("https://example.com/", &[("authorization", &format!("Bearer {ph}"))]))
                .unwrap_err();
        assert_eq!(err.status, 403);
        assert_eq!(err.message, "secret API_KEY not allowed for host: example.com");
        assert!(
            run(&r, head("https://example.org/", &[("authorization", &format!("Bearer {ph}"))]))
                .is_ok()
        );
    }

    #[test]
    fn revoked_values_embedded() {
        let mut r = rules(vec![secret("API_KEY", "oldsecret", &["example.com"])]);
        rotate(&mut r.secrets[0], "newsecret");
        for (k, v) in [
            ("x-api-key", "key=oldsecret"),
            ("authorization", "Bearer prefix-oldsecret-suffix"),
            ("authorization", "Basic oldsecret"),
        ] {
            assert!(run(&r, head("https://example.com/", &[(k, v)])).is_err(), "{k}: {v}");
        }
    }

    #[test]
    fn deleted_secret_values() {
        let mut r = rules(vec![secret("API_KEY", "oldsecret", &["example.com"])]);
        r.secrets[0].deleted = true;
        r.replace_secrets_in_query = true;
        assert!(
            run(&r, head("https://example.com/", &[("authorization", "Basic oldsecret")])).is_err()
        );
        assert!(
            run(
                &r,
                head(
                    "https://example.com/data?sig=prefix-oldsecret-suffix",
                    &[("x-api-key", "prefix-oldsecret-suffix")]
                )
            )
            .is_err()
        );
        let ph = r.secrets[0].placeholder.clone();
        let out =
            run(&r, head("https://example.org/", &[("authorization", &format!("Bearer {ph}"))]))
                .unwrap();
        assert_eq!(out.headers[0].1, "Bearer ");
    }

    #[test]
    fn rotated_values_containing_revoked() {
        let mut r = rules(vec![secret("API_KEY", "abc", &["example.com"])]);
        rotate(&mut r.secrets[0], "abcd");
        let out =
            run(&r, head("https://example.com/", &[("authorization", "Bearer abcd")])).unwrap();
        assert_eq!(out.headers[0].1, "Bearer abcd");
        let out = run(
            &r,
            head("https://example.com/", &[("authorization", "Bearer prefix-abcd-suffix")]),
        )
        .unwrap();
        assert_eq!(out.headers[0].1, "Bearer prefix-abcd-suffix");
        r.replace_secrets_in_query = true;
        let out = run(&r, head("https://example.com/data?token=abcd", &[])).unwrap();
        assert_eq!(out.url, "https://example.com/data?token=abcd");
    }

    #[test]
    fn revoked_in_query() {
        let mut r = rules(vec![secret("API_KEY", "oldsecret", &["example.com"])]);
        r.replace_secrets_in_query = true;
        rotate(&mut r.secrets[0], "newsecret");
        assert!(run(&r, head("https://example.com/data?sig=oldsecret-v2", &[])).is_err());
    }

    #[test]
    fn query_placeholders() {
        let mut r = rules(vec![secret("API_KEY", "s3cr3t+/=?", &["example.com"])]);
        let ph = r.secrets[0].placeholder.clone();
        let url = format!("https://example.com/data?token={ph}");
        let out = run(&r, head(&url, &[])).unwrap();
        assert_eq!(out.url, url);

        r.replace_secrets_in_query = true;
        let out = run(&r, head(&format!("https://example.com/data?token={ph}&ok=1"), &[])).unwrap();
        let parsed = Url::parse(&out.url).unwrap();
        let token = parsed.query_pairs().into_iter().find(|(k, _)| k == "token").unwrap().1;
        assert_eq!(token, "s3cr3t+/=?");
        assert!(!out.url.contains(&ph));

        assert!(run(&r, head(&format!("https://example.org/data?token={ph}"), &[])).is_err());
    }

    #[test]
    fn basic_auth() {
        let r = rules(vec![
            secret("BASIC_USER", "alice", &["example.com"]),
            secret("BASIC_PASS", "s3cr3t", &["example.com"]),
        ]);
        let token = base64_encode(
            format!("{}:{}", r.secrets[0].placeholder, r.secrets[1].placeholder).as_bytes(),
        );
        let out =
            run(&r, head("https://example.com/", &[("authorization", &format!("Basic {token}"))]))
                .unwrap();
        assert_eq!(out.headers[0].1, format!("Basic {}", base64_encode(b"alice:s3cr3t")));
        assert!(
            run(&r, head("https://example.org/", &[("authorization", &format!("Basic {token}"))]))
                .is_err()
        );
    }

    #[test]
    fn already_substituted_on_disallowed_host() {
        let r = rules(vec![secret("API_KEY", "secret-value", &["example.com"])]);
        let err =
            run(&r, head("https://example.org/", &[("authorization", "Bearer secret-value")]))
                .unwrap_err();
        assert_eq!(err.message, "secret API_KEY not allowed for host: example.org");
    }

    #[test]
    fn basic_auth_with_non_ascii_prefix() {
        // fuzz finding: slicing a header value inside a multi-byte char
        let r = rules(vec![secret("API_KEY", "secret-value", &["example.com"])]);
        for value in ["\u{fe}\u{ff}\u{ff}", "Basi\u{e9}", "\u{ff}asic abc"] {
            let _ = run(&r, head("https://example.com/", &[("authorization", value)]));
        }
    }

    #[test]
    fn lenient_base64() {
        assert_eq!(lenient_base64_decode("YWxpY2U6czNjcjN0"), b"alice:s3cr3t");
        assert_eq!(lenient_base64_decode("YQ"), b"a");
        assert_eq!(lenient_base64_decode("YQ=="), b"a");
        assert_eq!(decode_basic_auth_strict("Basic YQ==").as_deref(), Some("a"));
        assert_eq!(decode_basic_auth_strict("Basic oldsecret"), None);
    }
}

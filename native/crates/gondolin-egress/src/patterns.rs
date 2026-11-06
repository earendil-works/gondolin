//! Hostname allowlist patterns (port of `host/src/host/patterns.ts`).
//!
//! `*` matches any hostname; `*` inside a pattern matches any substring
//! (including the empty string and dots). Matching is case-insensitive.

/// Normalizes a pattern (trim + lowercase).
pub fn normalize_pattern(pattern: &str) -> String {
    pattern.trim().to_lowercase()
}

/// Normalizes and de-duplicates patterns, dropping empty ones (`uniqueHosts`).
pub fn unique_hosts<I: IntoIterator<Item = S>, S: AsRef<str>>(hosts: I) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for host in hosts {
        let normalized = normalize_pattern(host.as_ref());
        if normalized.is_empty() || out.contains(&normalized) {
            continue;
        }
        out.push(normalized);
    }
    out
}

/// Matches `hostname` against one pattern.
pub fn match_hostname(hostname: &str, pattern: &str) -> bool {
    if pattern.is_empty() {
        return false;
    }
    if pattern == "*" {
        return true;
    }
    let hostname = hostname.to_lowercase();
    let pattern = pattern.to_lowercase();
    glob_match(&hostname, &pattern)
}

/// Matches `hostname` against any of `patterns`.
pub fn matches_any_host(hostname: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| match_hostname(hostname, p))
}

fn glob_match(text: &str, pattern: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return text == pattern;
    }
    let first = parts[0];
    let last = parts[parts.len() - 1];
    if !text.starts_with(first) {
        return false;
    }
    let mut rest = &text[first.len()..];
    for part in &parts[1..parts.len() - 1] {
        match rest.find(part) {
            Some(idx) => rest = &rest[idx + part.len()..],
            None => return false,
        }
    }
    rest.len() >= last.len() && rest.ends_with(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts(v: &[&str]) -> Vec<String> {
        unique_hosts(v.iter())
    }

    #[test]
    fn allowlist_patterns() {
        let p = hosts(&["example.com", "*.example.org", "api.*.net"]);
        assert!(matches_any_host("example.com", &p));
        assert!(matches_any_host("Foo.Example.Org", &p));
        assert!(matches_any_host("api.foo.net", &p));
        assert!(!matches_any_host("nope.com", &p));
        assert!(!matches_any_host("example.org", &p));
    }

    #[test]
    fn empty_patterns_and_multiple_wildcards() {
        let p = hosts(&["", "   ", "a**b.com"]);
        assert_eq!(p, vec!["a**b.com".to_string()]);
        assert!(matches_any_host("axxxb.com", &p));
        assert!(matches_any_host("ab.com", &p));
        assert!(matches_any_host("acb.com", &p));
        assert!(!matches_any_host("nope.com", &p));
    }

    #[test]
    fn star_matches_everything() {
        assert!(matches_any_host("anything.example", &hosts(&["*"])));
        assert!(matches_any_host("", &hosts(&["*"])));
    }

    #[test]
    fn suffix_overlap() {
        // `*a*a` must not consume the trailing literal greedily
        assert!(match_hostname("aa", "*a*a"));
        assert!(match_hostname("xaya", "*a*a"));
        assert!(!match_hostname("a", "a*a"));
        assert!(match_hostname("192.168.99.10", "192.168.99.*"));
        assert!(!match_hostname("192.168.100.10", "192.168.99.*"));
    }
}

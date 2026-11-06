//! `HOST[:PORT]` allowlist patterns (port of `host/src/ssh/utils.ts` and
//! `host/src/host/patterns.ts`).

/// Allowed upstream target: normalized host pattern plus port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetPattern {
    /// lowercase host pattern (`*` matches any substring)
    pub pattern: String,
    pub port: u16,
}

/// Parses `host`, `host:port` or `[host]:port`; the default port is 22.
pub fn parse_target_pattern(raw: &str) -> Option<TargetPattern> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut host = trimmed;
    let mut port: u32 = 22;
    if let Some(rest) = host.strip_prefix('[') {
        let end = rest.find(']')?;
        let inner = &rest[..end];
        let after = &rest[end + 1..];
        if inner.is_empty() {
            return None;
        }
        host = inner;
        if !after.is_empty() {
            let digits = after.strip_prefix(':')?;
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            port = digits.parse().ok()?;
        }
    } else if let Some(idx) = host.rfind(':') {
        let digits = &host[idx + 1..];
        if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
            port = digits.parse().unwrap_or(0);
            host = &host[..idx];
        }
    }
    let pattern = normalize_pattern(host);
    if pattern.is_empty() || port == 0 || port > 65535 {
        return None;
    }
    Some(TargetPattern { pattern, port: port as u16 })
}

/// Parses and deduplicates allowlist entries, skipping invalid ones.
pub fn parse_targets(raw: &[String]) -> Vec<TargetPattern> {
    let mut out: Vec<TargetPattern> = Vec::new();
    for entry in raw {
        if let Some(target) = parse_target_pattern(entry)
            && !out.contains(&target)
        {
            out.push(target);
        }
    }
    out
}

pub fn normalize_pattern(pattern: &str) -> String {
    pattern.trim().to_ascii_lowercase()
}

/// Matches a hostname against a normalized pattern (`*` = any substring,
/// case-insensitive).
pub fn match_hostname(hostname: &str, pattern: &str) -> bool {
    if pattern.is_empty() {
        return false;
    }
    if pattern == "*" {
        return true;
    }
    wildcard_match(&hostname.to_ascii_lowercase(), pattern, false)
}

/// Glob match with `*` (any run) and, when `question` is set, `?` (one char).
pub(crate) fn wildcard_match(text: &str, pattern: &str, question: bool) -> bool {
    let t = text.as_bytes();
    let p = pattern.as_bytes();
    let (mut ti, mut pi) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == t[ti] || (question && p[pi] == b'?')) {
            ti += 1;
            pi += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(pattern: &str, port: u16) -> Option<TargetPattern> {
        Some(TargetPattern { pattern: pattern.into(), port })
    }

    #[test]
    fn parses_targets() {
        assert_eq!(parse_target_pattern("GitHub.com"), t("github.com", 22));
        assert_eq!(parse_target_pattern("ssh.github.com:443"), t("ssh.github.com", 443));
        assert_eq!(parse_target_pattern("[git.example.com]:2222"), t("git.example.com", 2222));
        assert_eq!(parse_target_pattern("[git.example.com]"), t("git.example.com", 22));
        assert_eq!(parse_target_pattern("*.example.com"), t("*.example.com", 22));
        assert_eq!(parse_target_pattern(""), None);
        assert_eq!(parse_target_pattern("host:0"), None);
        assert_eq!(parse_target_pattern("host:70000"), None);
        assert_eq!(parse_target_pattern("[host]x"), None);
        assert_eq!(parse_target_pattern("[]:22"), None);
        assert_eq!(
            parse_targets(&["a.com".into(), "A.com:22".into(), "bad:0".into(), "a.com:23".into()]),
            vec![
                TargetPattern { pattern: "a.com".into(), port: 22 },
                TargetPattern { pattern: "a.com".into(), port: 23 }
            ]
        );
    }

    #[test]
    fn matches_hostnames() {
        assert!(match_hostname("github.com", "github.com"));
        assert!(match_hostname("GitHub.com", "github.com"));
        assert!(!match_hostname("gitlab.com", "github.com"));
        assert!(match_hostname("api.example.com", "*.example.com"));
        assert!(!match_hostname("example.com", "*.example.com"));
        assert!(match_hostname("anything", "*"));
        assert!(match_hostname("a.b.c", "a*c"));
        assert!(!match_hostname("a.b.cd", "a*c"));
        assert!(!match_hostname("x", ""));
        // `?` is literal in allowlist patterns
        assert!(!match_hostname("ab", "a?"));
    }
}

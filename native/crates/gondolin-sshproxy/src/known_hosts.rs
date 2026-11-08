//! OpenSSH `known_hosts` verification (port of
//! `createOpenSshKnownHostsHostVerifier` in `host/src/ssh/utils.ts`): plain,
//! wildcard (`*`, `?`), negated (`!`) and hashed (`|1|salt|hmac`) host
//! patterns, `[host]:port` entries and `@revoked` keys.

use std::path::{Path, PathBuf};

use crate::targets::wildcard_match;

#[derive(Debug, Clone)]
struct Entry {
    /// marker such as `@revoked` or `@cert-authority`
    marker: Option<String>,
    host_patterns: Vec<String>,
    key_type: String,
    /// SSH wire encoding of the public key
    key: Vec<u8>,
}

/// Parsed known_hosts files.
#[derive(Debug, Clone, Default)]
pub struct KnownHosts {
    entries: Vec<Entry>,
}

/// Default files when none are configured.
pub fn default_files() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        out.push(Path::new(&home).join(".ssh").join("known_hosts"));
    }
    out.push(PathBuf::from("/etc/ssh/ssh_known_hosts"));
    out
}

impl KnownHosts {
    /// Loads every readable file; fails when none could be read.
    pub fn load(files: &[PathBuf]) -> Result<KnownHosts, String> {
        let mut known = KnownHosts::default();
        let mut loaded = 0;
        for file in files {
            if let Ok(content) = std::fs::read_to_string(file) {
                loaded += 1;
                known.entries.extend(parse(&content));
            }
        }
        if loaded == 0 {
            let tried: Vec<String> = files.iter().map(|f| f.display().to_string()).collect();
            return Err(format!("no OpenSSH known_hosts files found (tried {})", tried.join(", ")));
        }
        Ok(known)
    }

    pub fn parse(content: &str) -> KnownHosts {
        KnownHosts { entries: parse(content) }
    }

    /// Whether `key` (SSH wire encoding) is a known, non-revoked key of
    /// `hostname:port`.
    pub fn verify(&self, hostname: &str, key: &[u8], port: u16) -> bool {
        let host = hostname.trim().to_ascii_lowercase();
        if host.is_empty() {
            return false;
        }
        let port = if port == 0 { 22 } else { port };
        for entry in &self.entries {
            if !host_matches(&host, &entry.host_patterns, port) {
                continue;
            }
            if entry.marker.as_deref() == Some("@revoked") {
                if entry.key == key {
                    return false;
                }
                continue;
            }
            if entry.marker.is_none() && entry.key == key {
                return true;
            }
        }
        false
    }

    /// Key types recorded for `hostname:port`, in file order (used to prefer
    /// those host key algorithms, like OpenSSH does).
    pub fn key_types(&self, hostname: &str, port: u16) -> Vec<String> {
        let host = hostname.trim().to_ascii_lowercase();
        let mut out: Vec<String> = Vec::new();
        for entry in &self.entries {
            if entry.marker.is_none()
                && host_matches(&host, &entry.host_patterns, port)
                && !out.contains(&entry.key_type)
            {
                out.push(entry.key_type.clone());
            }
        }
        out
    }
}

fn parse(content: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut rest = line;
        let mut marker = None;
        if line.starts_with('@') {
            let Some((m, r)) = line.split_once(char::is_whitespace) else {
                continue;
            };
            marker = Some(m.to_string());
            rest = r.trim();
        }
        let mut parts = rest.split_whitespace();
        let (Some(hosts), Some(key_type), Some(key_b64)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(key) = crate::b64::decode(key_b64) else {
            continue;
        };
        if key.is_empty() {
            continue;
        }
        entries.push(Entry {
            marker,
            host_patterns: hosts.split(',').filter(|p| !p.is_empty()).map(str::to_string).collect(),
            key_type: key_type.to_string(),
            key,
        });
    }
    entries
}

fn host_matches(host: &str, patterns: &[String], port: u16) -> bool {
    let candidates = if port == 22 {
        vec![host.to_string(), format!("[{host}]:22")]
    } else {
        vec![format!("[{host}]:{port}")]
    };
    for candidate in &candidates {
        let mut positive = false;
        for raw in patterns {
            let (negated, pattern) = match raw.strip_prefix('!') {
                Some(p) => (true, p),
                None => (false, raw.as_str()),
            };
            if pattern.is_empty() {
                continue;
            }
            if pattern_matches(candidate, pattern) {
                if negated {
                    return false;
                }
                positive = true;
            }
        }
        if positive {
            return true;
        }
    }
    false
}

fn pattern_matches(candidate: &str, pattern: &str) -> bool {
    if let Some(hashed) = pattern.strip_prefix("|1|") {
        let Some((salt, mac)) = hashed.split_once('|') else {
            return false;
        };
        let (Ok(salt), Ok(expected)) = (crate::b64::decode(salt), crate::b64::decode(mac)) else {
            return false;
        };
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, &salt);
        return ring::hmac::verify(&key, candidate.as_bytes(), &expected).is_ok();
    }
    let pattern = pattern.to_ascii_lowercase();
    if pattern.contains('*') || pattern.contains('?') {
        return wildcard_match(candidate, &pattern, true);
    }
    candidate == pattern
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &[u8] =
        b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const KEY_B: &[u8] =
        b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn line(hosts: &str, key: &[u8]) -> String {
        format!("{hosts} ssh-ed25519 {}\n", crate::b64::encode(key))
    }

    #[test]
    fn plain_and_port_entries() {
        let kh = KnownHosts::parse(&format!(
            "# comment\n\n{}{}",
            line("github.com,140.82.112.3", KEY_A),
            line("[ssh.github.com]:443", KEY_B)
        ));
        assert!(kh.verify("github.com", KEY_A, 22));
        assert!(kh.verify("GitHub.com", KEY_A, 22));
        assert!(!kh.verify("github.com", KEY_B, 22));
        assert!(!kh.verify("gitlab.com", KEY_A, 22));
        assert!(!kh.verify("github.com", KEY_A, 2222));
        assert!(kh.verify("ssh.github.com", KEY_B, 443));
        assert!(!kh.verify("ssh.github.com", KEY_B, 22));
        assert_eq!(kh.key_types("github.com", 22), vec!["ssh-ed25519".to_string()]);
        assert!(kh.key_types("other", 22).is_empty());
    }

    #[test]
    fn explicit_port_22_brackets() {
        let kh = KnownHosts::parse(&line("[git.example.com]:22", KEY_A));
        assert!(kh.verify("git.example.com", KEY_A, 22));
    }

    #[test]
    fn wildcards_and_negation() {
        let kh = KnownHosts::parse(&line("*.example.com,!bad.example.com,host?.lan", KEY_A));
        assert!(kh.verify("a.example.com", KEY_A, 22));
        assert!(!kh.verify("bad.example.com", KEY_A, 22));
        assert!(kh.verify("host1.lan", KEY_A, 22));
        assert!(!kh.verify("host12.lan", KEY_A, 22));
    }

    #[test]
    fn hashed_hosts() {
        let salt = b"0123456789abcdef0123";
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, salt);
        let tag = ring::hmac::sign(&key, b"[git.example.com]:2222");
        let pattern =
            format!("|1|{}|{}", crate::b64::encode(salt), crate::b64::encode(tag.as_ref()));
        let kh = KnownHosts::parse(&line(&pattern, KEY_A));
        assert!(kh.verify("git.example.com", KEY_A, 2222));
        assert!(!kh.verify("git.example.com", KEY_A, 22));
        assert!(!kh.verify("other.example.com", KEY_A, 2222));
    }

    #[test]
    fn revoked_keys_are_rejected() {
        let kh = KnownHosts::parse(&format!(
            "@revoked * ssh-ed25519 {}\n{}",
            crate::b64::encode(KEY_A),
            line("github.com", KEY_A)
        ));
        assert!(!kh.verify("github.com", KEY_A, 22));
        // cert-authority lines never match a plain key
        let kh = KnownHosts::parse(&format!(
            "@cert-authority * ssh-ed25519 {}\n",
            crate::b64::encode(KEY_B)
        ));
        assert!(!kh.verify("github.com", KEY_B, 22));
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let kh = KnownHosts::parse(&format!(
            "onlyhost\nhost ssh-ed25519 !!!notbase64\n@revoked\n{}",
            line("ok.com", KEY_A)
        ));
        assert!(kh.verify("ok.com", KEY_A, 22));
    }

    #[test]
    fn load_requires_a_file() {
        let err = KnownHosts::load(&[PathBuf::from("/nonexistent/known_hosts")]).unwrap_err();
        assert_eq!(err, "no OpenSSH known_hosts files found (tried /nonexistent/known_hosts)");
    }
}

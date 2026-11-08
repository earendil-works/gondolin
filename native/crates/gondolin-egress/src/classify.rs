//! Classification of the first bytes of a guest TCP flow.

/// Max bytes buffered before a flow must be classified (`MAX_FLOW_SNIFF`).
pub const MAX_FLOW_SNIFF: usize = 8 * 1024;

const HTTP_METHODS: [&str; 9] =
    ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"];

/// Classification result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Classification {
    /// more bytes are needed
    NeedMore,
    /// HTTP/1.x request line (`method` of the first request)
    Http { method: String },
    /// TLS ClientHello record
    Tls,
    /// SSH client banner on an SSH port
    Ssh,
    /// anything else
    Deny,
}

fn looks_like_tls_client_hello(data: &[u8]) -> bool {
    data.len() >= 5 && data[0] == 0x16 && data[1] == 0x03 && data[2] <= 0x03
}

enum Prefix {
    Match,
    Partial,
    None,
}

fn match_http_method_prefix(data: &[u8]) -> Prefix {
    let snippet = &data[..data.len().min(16)];
    for method in HTTP_METHODS {
        let m = method.as_bytes();
        if snippet.len() > m.len() && snippet.starts_with(m) && snippet[m.len()] == b' ' {
            return Prefix::Match;
        }
        if m.starts_with(snippet) {
            return Prefix::Partial;
        }
    }
    Prefix::None
}

fn parse_request_line(data: &[u8]) -> Option<String> {
    let end = data.windows(2).position(|w| w == b"\r\n")?;
    let line = String::from_utf8_lossy(&data[..end]);
    let mut parts = line.split(' ');
    let method = parts.next().filter(|s| !s.is_empty())?;
    let _target = parts.next().filter(|s| !s.is_empty())?;
    let version = parts.next().filter(|s| !s.is_empty())?;
    if !version.starts_with("HTTP/") || !HTTP_METHODS.contains(&method) {
        return None;
    }
    Some(method.to_string())
}

/// Classifies the buffered start of a flow. `ssh_port` says whether the
/// destination port is one where SSH banners are recognized.
pub fn classify(data: &[u8], ssh_port: bool) -> Classification {
    if data.is_empty() {
        return Classification::NeedMore;
    }
    if looks_like_tls_client_hello(data) {
        return Classification::Tls;
    }
    match match_http_method_prefix(data) {
        Prefix::Match => {
            return match parse_request_line(data) {
                Some(method) => Classification::Http { method },
                None => Classification::NeedMore,
            };
        }
        Prefix::Partial => return Classification::NeedMore,
        Prefix::None => {}
    }
    if ssh_port {
        let snippet = &data[..data.len().min(4)];
        if snippet == b"SSH-" {
            return Classification::Ssh;
        }
        if b"SSH-".starts_with(snippet) {
            return Classification::NeedMore;
        }
    }
    if data.len() < 4 {
        return Classification::NeedMore;
    }
    Classification::Deny
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http() {
        assert_eq!(
            classify(b"GET / HTTP/1.1\r\n", false),
            Classification::Http { method: "GET".into() }
        );
        assert_eq!(classify(b"GE", false), Classification::NeedMore);
        assert_eq!(classify(b"GET / HTTP/1.1", false), Classification::NeedMore);
        assert_eq!(
            classify(b"CONNECT a:443 HTTP/1.1\r\n", false),
            Classification::Http { method: "CONNECT".into() }
        );
        // a request line that never becomes valid keeps needing more (until the sniff limit)
        assert_eq!(classify(b"GET /\r\n", false), Classification::NeedMore);
        assert_eq!(classify(b"PRI * HTTP/2.0\r\n", false), Classification::Deny);
        assert_eq!(classify(b"get / HTTP/1.1\r\n", false), Classification::Deny);
    }

    #[test]
    fn tls() {
        assert_eq!(classify(&[0x16, 0x03, 0x01, 0x00, 0x10], false), Classification::Tls);
        assert_eq!(classify(&[0x16, 0x03, 0x04, 0x00, 0x10], false), Classification::Deny);
        assert_eq!(classify(&[0x16, 0x03], false), Classification::NeedMore);
    }

    #[test]
    fn ssh() {
        assert_eq!(classify(b"SSH-2.0-OpenSSH\r\n", true), Classification::Ssh);
        assert_eq!(classify(b"SS", true), Classification::NeedMore);
        assert_eq!(classify(b"SSH-2.0-OpenSSH\r\n", false), Classification::Deny);
        assert_eq!(classify(b"\x00\x01\x02\x03", false), Classification::Deny);
    }
}

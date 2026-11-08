//! gondolin-http's WHATWG URL parser against the `url` crate (differential):
//! parse results, components, `join` against fixed and fuzzed bases, and
//! form-encoded query pairs, for special schemes. Non-ASCII hosts and `xn--`
//! labels are skipped (gondolin-http has no full UTS #46 mapping), as are
//! `file:` URLs and spots where the url crate deviates from WHATWG.
#![no_main]

use gondolin_http::url::Url;
use libfuzzer_sys::fuzz_target;

fn comparable(s: &str) -> bool {
    !s.to_ascii_lowercase().contains("xn--")
        && !s.to_ascii_lowercase().contains("file:")
        && s.is_ascii()
        // percent-encoded non-ASCII in hosts goes through IDNA
        && !s.contains('%')
}

fn check(
    ours: Result<Url, gondolin_http::url::ParseError>,
    theirs: Result<url::Url, url::ParseError>,
    what: &str,
) {
    match (ours, theirs) {
        (Ok(a), Ok(b)) => {
            // the url crate never pops a drive-letter-like segment (`/c:/..`)
            // for any scheme (WHATWG: only for file URLs)
            let drive = |s: &str| {
                let b = s.as_bytes();
                b.len() == 2 && b[0].is_ascii_alphabetic() && matches!(b[1], b':' | b'|')
            };
            if a.as_str() != b.as_str() && b.path().split('/').any(drive) {
                return;
            }
            assert_eq!(a.as_str(), b.as_str(), "{what}");
            assert_eq!(a.scheme(), b.scheme(), "{what}");
            assert_eq!(a.host_str(), b.host_str(), "{what}");
            assert_eq!(a.port(), b.port(), "{what}");
            assert_eq!(a.port_or_known_default(), b.port_or_known_default(), "{what}");
            assert_eq!(a.path(), b.path(), "{what}");
            assert_eq!(a.query(), b.query(), "{what}");
            assert_eq!(a.fragment(), b.fragment(), "{what}");
            let pairs: Vec<(String, String)> =
                b.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
            assert_eq!(a.query_pairs(), pairs, "{what}");
        }
        (Err(_), Err(_)) => {}
        (a, b) => panic!("{what}: ours {a:?} theirs {b:?}"),
    }
}

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    if !comparable(text) {
        return;
    }
    let (base, input) = text.split_once('\u{1}').unwrap_or(("http://a.test/b/c?q#f", text));
    let cleaned: String = input
        .trim_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let scheme = cleaned.split_once(':').map(|(s, _)| s.to_ascii_lowercase()).filter(|s| {
        s.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && s.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    });
    // non-special URLs: the url crate is laxer than WHATWG in several places
    // (`\\` ends ports, empty hosts after `@`); gondolind only needs special ones
    if !scheme.as_deref().is_none_or(|s| matches!(s, "http" | "https" | "ws" | "wss" | "ftp")) {
        return;
    }
    check(Url::parse(input), url::Url::parse(input), &format!("parse {input:?}"));
    // the url crate strips exactly two slashes of a scheme-relative reference
    // (WHATWG and node ignore any number)
    if cleaned.chars().take_while(|c| matches!(c, '/' | '\\')).count() > 2 {
        return;
    }
    for base in [base, "http://a.test/b/c?q#f", "https://[::1]:8443/x/", "ws://w.test"] {
        if let (Ok(ours), Ok(theirs)) = (Url::parse(base), url::Url::parse(base))
            && matches!(theirs.scheme(), "http" | "https" | "ws" | "wss" | "ftp")
        {
            check(ours.join(input), theirs.join(input), &format!("join {base:?} {input:?}"));
        }
    }
});

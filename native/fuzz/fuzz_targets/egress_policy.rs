//! egress policy helpers on guest-controlled strings: secret substitution
//! (headers incl. Basic auth, URL query), host pattern matching, internal
//! address checks, classification.
#![no_main]

use arbitrary::Arbitrary;
use gondolin_egress::{RequestHead, apply_secrets, classify, is_internal_ip_str, match_hostname};
use gondolin_proto::net::{HttpRules, PlaceholderMode, SecretRule};
use libfuzzer_sys::fuzz_target;

#[derive(Debug, Arbitrary)]
struct Input {
    url: String,
    headers: Vec<(String, String)>,
    pattern: String,
    host: String,
    unique: bool,
    query: bool,
    deleted: bool,
    sniff: Vec<u8>,
}

fuzz_target!(|input: Input| {
    let marker = "cd".repeat(24);
    let rules = HttpRules {
        allowed_hosts: vec![input.pattern.clone()],
        replace_secrets_in_query: input.query,
        placeholder_mode: if input.unique {
            PlaceholderMode::Unique
        } else {
            PlaceholderMode::Shared
        },
        marker: (!input.unique).then(|| marker.clone()),
        secrets: vec![
            SecretRule {
                name: "A".into(),
                identifier: "a".into(),
                placeholder: format!("{marker}.a"),
                value: "va\u{e9}lue".into(),
                revoked_values: vec!["old".into()],
                hosts: vec![input.pattern.clone()],
                deleted: input.deleted,
            },
            SecretRule {
                name: "B".into(),
                identifier: "b".into(),
                placeholder: "PLACEHOLDER_B".into(),
                value: "".into(),
                revoked_values: vec![],
                hosts: vec!["*".into()],
                deleted: false,
            },
        ],
        ..HttpRules::default()
    };
    let mut head = RequestHead {
        method: "GET".into(),
        url: input.url.clone(),
        headers: input.headers.iter().take(16).cloned().collect(),
    };
    let _ = apply_secrets(&rules, &mut head);

    let _ = match_hostname(&input.host, &input.pattern);
    let _ = match_hostname(&input.host, &input.pattern.to_lowercase());
    let _ = is_internal_ip_str(&input.host);
    for ssh in [true, false] {
        let _ = classify(&input.sniff, ssh);
    }
});

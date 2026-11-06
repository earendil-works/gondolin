//! sshproxy parsers on guest-controlled strings: git exec command parsing
//! (`execPolicy` helpers), known_hosts content, allowlist patterns.
#![no_main]

use arbitrary::Arbitrary;
use gondolin_sshproxy::git::git_exec_info;
use gondolin_sshproxy::known_hosts::KnownHosts;
use gondolin_sshproxy::targets::{match_hostname, parse_target_pattern};
use libfuzzer_sys::fuzz_target;

#[derive(Debug, Arbitrary)]
struct Input {
    command: String,
    known_hosts: String,
    host: String,
    pattern: String,
    key: Vec<u8>,
    port: u16,
}

fuzz_target!(|input: Input| {
    let _ = git_exec_info(&input.command);
    let kh = KnownHosts::parse(&input.known_hosts);
    let _ = kh.verify(&input.host, &input.key, input.port);
    let _ = kh.key_types(&input.host, input.port);
    let _ = parse_target_pattern(&input.pattern);
    let _ = match_hostname(&input.host, &input.pattern);
});

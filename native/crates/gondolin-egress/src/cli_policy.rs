//! CLI network flags → `configure.net` for the static `gondolin` CLI (an
//! in-process Rust controller without Node).
//!
//! Replicates the node CLI exactly: flag validation and defaulting of
//! `buildVmOptions` (`host/bin/gondolin.ts`), `createHttpHooks()` for
//! `--allow-host`/`--host-secret`, and `NativeNetwork.configure()`
//! (`host/src/native/net.ts`) for a local daemon, with the same error
//! messages. Differences by design:
//! - upstream trust: the system and webpki roots (`use_system_roots`,
//!   `use_webpki_roots`) instead of node's CA store as `upstream_ca_pems`;
//! - resolvers: the daemon's (`/etc/resolv.conf`) rather than
//!   `dns.getServers()`, so `system_resolvers` and implicit `trusted_servers`
//!   are not sent (same machine: the netstack reads them itself and fails fast
//!   in `trusted` mode without IPv4 resolvers, like the CLI).
//!
//! Tested against payloads produced by the TypeScript side
//! (`tests/fixtures/cli-net/gen.ts`).

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;

use gondolin_wire::{Value, value};
use ring::rand::SecureRandom;

use crate::patterns::unique_hosts;

/// Default HTTP body limits in `bytes` (`DEFAULT_MAX_HTTP_BODY_BYTES`)
const MAX_BODY_BYTES: u64 = 64 * 1024 * 1024;

gondolin_wire::wire_struct! {
/// `--host-secret`: value already resolved (from the environment or the flag).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SecretFlag {
    pub name: String = Default::default(),
    /// host patterns (may be empty: the secret is then substituted nowhere)
    pub hosts: Vec<String> = Default::default(),
    pub value: String = Default::default(),
}
}

gondolin_wire::wire_struct! {
/// `--dns`, `--dns-trusted-server`, `--dns-synthetic-host-mapping`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DnsFlags {
    /// `synthetic`, `trusted` or `open`
    pub mode: Option<String> = Default::default(),
    pub trusted_servers: Vec<String> = Default::default(),
    /// `single` or `per-host`
    pub synthetic_host_mapping: Option<String> = Default::default(),
}
}

gondolin_wire::wire_struct! {
/// `--ssh-credential HOST[:PORT]=USER@KEYFILE[:PASSPHRASE]` with the key read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SshCredentialFlag {
    pub host: String = Default::default(),
    pub username: Option<String> = Default::default(),
    pub private_key_pem: String = Default::default(),
    pub passphrase: Option<String> = Default::default(),
}
}

gondolin_wire::wire_struct! {
/// `--ssh-allow-host`, `--ssh-agent`, `--ssh-known-hosts`, `--ssh-credential`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SshFlags {
    pub allow_hosts: Vec<String> = Default::default(),
    /// agent socket (`--ssh-agent [SOCK]`, `$SSH_AUTH_SOCK` already applied)
    pub agent: Option<String> = Default::default(),
    pub known_hosts_files: Vec<PathBuf> = Default::default(),
    pub credentials: Vec<SshCredentialFlag> = Default::default(),
}
}

gondolin_wire::wire_struct! {
/// The network flags of a CLI command.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NetFlags {
    /// `--allow-host`
    pub allow_hosts: Vec<String> = Default::default(),
    /// `--host-secret`
    pub secrets: Vec<SecretFlag> = Default::default(),
    /// `--disable-websockets`
    pub disable_websockets: bool = Default::default(),
    pub dns: Option<DnsFlags> = Default::default(),
    /// `--tcp-map GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT` (as split by `parseTcpMapSpec`)
    pub tcp_maps: Vec<(String, String)> = Default::default(),
    pub ssh: Option<SshFlags> = Default::default(),
}
}

gondolin_wire::wire_struct! {
/// Session facts the compiler needs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CompileCtx {
    /// MITM CA `(cert_pem, key_pem)`; absent: the daemon uses its own cache
    pub mitm_ca: Option<(String, String)> = Default::default(),
    /// guest MAC (`aa:bb:cc:dd:ee:ff`)
    pub mac: Option<String> = Default::default(),
    /// krun's virtio-net offloads checksums (`vmm: krun`)
    pub checksum_offload: bool = Default::default(),
}
}

/// Result of [`compile_cli_net`].
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledNet {
    /// `configure.net` (`mode: "native"`)
    pub net: Value,
    /// guest environment: secret name → placeholder
    pub guest_env: BTreeMap<String, String>,
}

fn err(message: impl Into<String>) -> String {
    message.into()
}

/// Compiles CLI network flags into `configure.net` plus the guest environment.
pub fn compile_cli_net(flags: &NetFlags, ctx: &CompileCtx) -> Result<CompiledNet, String> {
    // --- argument validation of the CLI parser
    let dns = flags.dns.clone().unwrap_or_default();
    if let Some(mode) = &dns.mode
        && !matches!(mode.as_str(), "synthetic" | "trusted" | "open")
    {
        return Err(err("--dns must be one of: synthetic, trusted, open"));
    }
    if let Some(mapping) = &dns.synthetic_host_mapping
        && !matches!(mapping.as_str(), "single" | "per-host")
    {
        return Err(err("--dns-synthetic-host-mapping must be one of: single, per-host"));
    }
    for server in &dns.trusted_servers {
        if server.parse::<Ipv4Addr>().is_err() {
            return Err(err("--dns-trusted-server must be a valid IPv4 address"));
        }
    }

    // --- buildVmOptions: --allow-host / --host-secret → createHttpHooks
    let mut guest_env = BTreeMap::new();
    let rules = if !flags.allow_hosts.is_empty() || !flags.secrets.is_empty() {
        Some(http_rules(flags, &mut guest_env)?)
    } else {
        None
    };

    // --- buildVmOptions: dns/ssh/tcp validation and defaulting
    let mut dns_mode = dns.mode.clone();
    let mut mapping = dns.synthetic_host_mapping.clone();
    if !dns.trusted_servers.is_empty() {
        match dns_mode.as_deref() {
            None => return Err(err("--dns-trusted-server requires --dns trusted")),
            Some("trusted") => {}
            Some(_) => return Err(err("--dns-trusted-server can only be used with --dns trusted")),
        }
    }
    if mapping.is_some() && dns_mode.as_deref().is_some_and(|m| m != "synthetic") {
        return Err(err("--dns-synthetic-host-mapping requires --dns synthetic"));
    }

    let ssh = flags.ssh.clone().unwrap_or_default();
    let mut ssh_allow = ssh.allow_hosts.clone();
    for credential in &ssh.credentials {
        if !ssh_allow.contains(&credential.host) {
            ssh_allow.push(credential.host.clone());
        }
    }
    if ssh.agent.is_some() && ssh_allow.is_empty() {
        return Err(err(
            "--ssh-agent requires at least one --ssh-allow-host (or --ssh-credential)",
        ));
    }
    if !ssh_allow.is_empty() {
        if dns_mode.as_deref().is_some_and(|m| m != "synthetic") {
            return Err(err("--ssh-allow-host requires --dns synthetic"));
        }
        dns_mode.get_or_insert_with(|| "synthetic".into());
        mapping.get_or_insert_with(|| "per-host".into());
    }

    // a JS object: a repeated key keeps its first position, last value wins
    let mut tcp_maps: Vec<(String, String)> = Vec::new();
    for (key, value) in &flags.tcp_maps {
        match tcp_maps.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = value.clone(),
            None => tcp_maps.push((key.clone(), value.clone())),
        }
    }
    if !tcp_maps.is_empty() {
        if dns_mode.as_deref().is_some_and(|m| m != "synthetic") {
            return Err(err("--tcp-map requires --dns synthetic"));
        }
        dns_mode.get_or_insert_with(|| "synthetic".into());
        mapping.get_or_insert_with(|| "per-host".into());
    }

    // --- compileNetworkOptions
    let mode = dns_mode.unwrap_or_else(|| "synthetic".into());
    let ssh_targets = ssh_allowed_targets(&ssh_allow);
    let tcp_rules = tcp_mapping_rules(&tcp_maps)?;
    let mapping = mapping.unwrap_or_else(|| {
        if !ssh_targets.is_empty() || !tcp_rules.is_empty() { "per-host" } else { "single" }.into()
    });
    if !ssh_targets.is_empty() {
        if mode != "synthetic" {
            return Err(err("ssh egress requires dns mode 'synthetic'"));
        }
        if mapping != "per-host" {
            return Err(err("ssh egress requires dns syntheticHostMapping='per-host'"));
        }
    }
    if !tcp_rules.is_empty() {
        if mode != "synthetic" {
            return Err(err("tcp host mapping requires dns mode 'synthetic'"));
        }
        if mapping != "per-host" {
            return Err(err("tcp host mapping requires dns syntheticHostMapping='per-host'"));
        }
    }
    let mut trusted: Vec<String> = Vec::new();
    for server in &dns.trusted_servers {
        let bare = server.split('%').next().unwrap_or_default();
        if bare.parse::<Ipv4Addr>().is_ok() && !trusted.iter().any(|t| t == bare) {
            trusted.push(bare.to_string());
        }
    }

    let mut dns_json = Value::map();
    dns_json.insert("mode", value!(mode));
    if !trusted.is_empty() {
        dns_json.insert("trusted_servers", value!(trusted));
    }
    dns_json.insert("synthetic_host_mapping", value!(mapping));
    let mut stack = Value::map();
    if let Some(mac) = &ctx.mac {
        stack.insert("guest_mac", value!(mac));
    }
    if ctx.checksum_offload {
        stack.insert("checksum_offload", value!(true));
    }
    stack.insert("dns", dns_json);

    // --- NativeNetwork.configure()
    let mut policy = Value::map();
    if let Some(rules) = rules {
        policy.insert("rules", rules);
    }
    policy.insert("allow_websockets", value!(!flags.disable_websockets));
    let mut net = Value::map();
    net.insert("mode", value!("native"));
    net.insert("policy", policy);
    net.insert("hooks", value!({ "is_request_allowed": false, "is_ip_allowed": false }));
    net.insert(
        "limits",
        value!({ "max_request_body_bytes": MAX_BODY_BYTES, "max_response_body_bytes": MAX_BODY_BYTES }),
    );
    if let Some((cert, key)) = &ctx.mitm_ca {
        net.insert("mitm", value!({ "cert_pem": cert, "key_pem": key }));
    }
    if !tcp_rules.is_empty() {
        net.insert("tcp_hosts", Value::Array(tcp_rules));
    }
    if !ssh_targets.is_empty() {
        let mut ports: Vec<u16> = Vec::new();
        for (_, port) in &ssh_targets {
            if !ports.contains(port) {
                ports.push(*port);
            }
        }
        net.insert("ssh", ssh_config(&ssh, &ssh_allow, &ports));
    }
    net.insert("stack", stack);
    net.insert("use_system_roots", value!(true));
    net.insert("use_webpki_roots", value!(true));

    Ok(CompiledNet { net, guest_env })
}

/// `createHttpHooks({ allowedHosts, secrets })` in its `rules()` form.
fn http_rules(flags: &NetFlags, env: &mut BTreeMap<String, String>) -> Result<Value, String> {
    let marker = random_hex(24);
    // secrets keyed by name (a JS object): first position, last value
    let mut secrets: Vec<SecretFlag> = Vec::new();
    for secret in &flags.secrets {
        match secrets.iter_mut().find(|s| s.name == secret.name) {
            Some(existing) => *existing = secret.clone(),
            None => secrets.push(secret.clone()),
        }
    }
    let mut entries: Vec<(String, &SecretFlag)> = Vec::new();
    for secret in &secrets {
        let identifier = secret_identifier(&secret.name)?;
        if let Some((_, other)) = entries.iter().find(|(id, _)| *id == identifier) {
            return Err(format!(
                "secret identifier for {} collides with secret identifier for {}",
                secret.name, other.name
            ));
        }
        entries.push((identifier, secret));
    }
    let rules_secrets: Vec<Value> = entries
        .iter()
        .map(|(identifier, secret)| {
            let placeholder = format!("{marker}.{identifier}");
            env.insert(secret.name.clone(), placeholder.clone());
            value!({
                "name": secret.name,
                "identifier": identifier,
                "placeholder": placeholder,
                "value": secret.value,
                "revoked_values": [],
                "hosts": unique_hosts(&secret.hosts),
                "deleted": false,
            })
        })
        .collect();
    let configured = if flags.allow_hosts.is_empty() {
        vec!["*".to_string()]
    } else {
        unique_hosts(&flags.allow_hosts)
    };
    let allowed =
        if configured.iter().any(|h| h == "*") { vec!["*".to_string()] } else { configured };
    Ok(value!({
        "allowed_hosts": allowed,
        "allowed_internal_hosts": [],
        "block_internal_ranges": true,
        "secrets": rules_secrets,
        "replace_secrets_in_query": false,
        "placeholder_mode": "shared",
        "marker": marker,
    }))
}

/// `makeSecretIdentifier`: lowercase, runs of `[^a-z0-9_-]` become `_`.
fn secret_identifier(name: &str) -> Result<String, String> {
    let lower = name.trim().to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut in_run = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    if out.is_empty() {
        return Err(format!("invalid secret identifier for {name}"));
    }
    Ok(out)
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    ring::rand::SystemRandom::new().fill(&mut buf).expect("system rng");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// `normalizeSshAllowedTargets`: `(pattern, port)`, deduplicated, invalid dropped.
fn ssh_allowed_targets(raw: &[String]) -> Vec<(String, u16)> {
    let mut out: Vec<(String, u16)> = Vec::new();
    for entry in raw {
        if let Some(target) = parse_ssh_target(entry)
            && !out.contains(&target)
        {
            out.push(target);
        }
    }
    out
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// Parses a port like JS `Number.parseInt` of a digit string (`None` above `u16`).
fn parse_port(digits: &str) -> Option<u32> {
    digits.parse::<u32>().ok().or(Some(u32::MAX))
}

fn parse_ssh_target(raw: &str) -> Option<(String, u16)> {
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
            if !all_digits(digits) {
                return None;
            }
            port = parse_port(digits)?;
        }
    } else if let Some(idx) = host.rfind(':') {
        let maybe = &host[idx + 1..];
        if all_digits(maybe) {
            port = parse_port(maybe)?;
            host = &host[..idx];
        }
    }
    let pattern = host.trim().to_lowercase();
    if pattern.is_empty() || port == 0 || port > 65535 {
        return None;
    }
    Some((pattern, port as u16))
}

/// `normalizeHost` of `host/src/net/tcp.ts`.
fn normalize_tcp_host(host: &str) -> String {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.parse::<IpAddr>().is_ok() {
        return trimmed.to_lowercase();
    }
    trimmed.to_lowercase().trim_end_matches('.').to_string()
}

/// `parseHostPort` of `host/src/net/tcp.ts`.
fn parse_host_port(
    raw: &str,
    require_port: bool,
    context: &str,
) -> Result<(String, Option<u16>), String> {
    let input = raw.trim();
    if input.is_empty() {
        return Err(format!("{context} must not be empty"));
    }
    let mut host = input;
    let mut port: Option<u32> = None;
    if let Some(rest) = input.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return Err(format!("{context} has invalid bracket syntax: {raw}"));
        };
        host = &rest[..end];
        let after = &rest[end + 1..];
        if !after.is_empty() {
            let Some(digits) = after.strip_prefix(':') else {
                return Err(format!("{context} has invalid bracket syntax: {raw}"));
            };
            if !all_digits(digits) {
                return Err(format!("{context} has invalid port: {raw}"));
            }
            port = parse_port(digits);
        }
    } else if let Some(idx) = input.rfind(':') {
        let maybe = &input[idx + 1..];
        if all_digits(maybe) {
            host = &input[..idx];
            port = parse_port(maybe);
        }
    }
    let host = normalize_tcp_host(host);
    if host.is_empty() {
        return Err(format!("{context} host must not be empty: {raw}"));
    }
    if let Some(p) = port
        && (p == 0 || p > 65535)
    {
        return Err(format!("{context} port must be in range 1..65535: {raw}"));
    }
    if require_port && port.is_none() {
        return Err(format!("{context} requires an explicit :PORT: {raw}"));
    }
    Ok((host, port.map(|p| p as u16)))
}

/// `createQemuTcpInternals(...).rules` as `tcp_hosts` entries.
fn tcp_mapping_rules(maps: &[(String, String)]) -> Result<Vec<Value>, String> {
    let mut seen_host_port: Vec<String> = Vec::new();
    let mut seen_host: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for (raw_key, raw_value) in maps {
        let (host, port) = parse_host_port(raw_key, false, "tcp.hosts key")?;
        if host.contains('*') {
            return Err(format!("tcp.hosts key does not support wildcard '*': {raw_key}"));
        }
        let (upstream_host, upstream_port) = parse_host_port(raw_value, true, "tcp.hosts value")?;
        if upstream_host.contains('*') {
            return Err(format!("tcp.hosts value does not support wildcard '*': {raw_value}"));
        }
        match port {
            Some(p) => {
                let key = format!("{host}:{p}");
                if seen_host_port.contains(&key) {
                    return Err(format!("duplicate tcp.hosts mapping for {key}"));
                }
                seen_host_port.push(key);
            }
            None => {
                if seen_host.contains(&host) {
                    return Err(format!("duplicate tcp.hosts mapping for {host}"));
                }
                seen_host.push(host.clone());
            }
        }
        let mut entry = Value::map();
        entry.insert("host", value!(host));
        if let Some(p) = port {
            entry.insert("port", value!(p));
        }
        entry.insert("upstream_host", value!(upstream_host));
        entry.insert("upstream_port", value!(upstream_port.expect("required")));
        out.push(entry);
    }
    Ok(out)
}

/// `compileSshConfig` for a local daemon (paths are on this machine).
fn ssh_config(ssh: &SshFlags, allow: &[String], ports: &[u16]) -> Value {
    let mut files: Vec<String> = ssh
        .known_hosts_files
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|f| !f.trim().is_empty())
        .collect();
    if files.is_empty() {
        let home = std::env::var("HOME").unwrap_or_default();
        files.push(format!("{home}/.ssh/known_hosts"));
        files.push("/etc/ssh/ssh_known_hosts".into());
    }
    let mut known_hosts: Vec<String> = Vec::new();
    for f in files {
        let f = f.trim().to_string();
        if !f.is_empty() && !known_hosts.contains(&f) {
            known_hosts.push(f);
        }
    }
    // credentials keyed by host (a JS object): first position, last value
    let mut credentials: Vec<&SshCredentialFlag> = Vec::new();
    for credential in &ssh.credentials {
        match credentials.iter_mut().find(|c| c.host == credential.host) {
            Some(existing) => *existing = credential,
            None => credentials.push(credential),
        }
    }
    let credentials: Vec<Value> = credentials
        .iter()
        .map(|c| {
            let mut entry = Value::map();
            entry.insert("host", value!(c.host));
            if let Some(user) = &c.username {
                entry.insert("username", value!(user));
            }
            entry.insert("private_key", value!(c.private_key_pem));
            if let Some(pass) = &c.passphrase {
                entry.insert("passphrase", value!(pass));
            }
            entry
        })
        .collect();
    let mut out = Value::map();
    out.insert("ports", value!(ports));
    out.insert("allowed_hosts", value!(allow));
    out.insert("credentials", Value::Array(credentials));
    if let Some(agent) = &ssh.agent {
        out.insert("agent", value!(agent));
    }
    out.insert("known_hosts_files", value!(known_hosts));
    out.insert("host_verifier_hook", value!(false));
    out.insert("exec_policy_hook", value!(false));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers() {
        assert_eq!(secret_identifier(" Foo Bar!! ").unwrap(), "foo_bar_");
        assert_eq!(secret_identifier("API-KEY_2").unwrap(), "api-key_2");
        assert!(secret_identifier("  ").is_err());
    }

    #[test]
    fn ssh_targets() {
        assert_eq!(parse_ssh_target("GitHub.com"), Some(("github.com".into(), 22)));
        assert_eq!(parse_ssh_target("[git.example]:2222"), Some(("git.example".into(), 2222)));
        assert_eq!(parse_ssh_target("h:0"), None);
        assert_eq!(parse_ssh_target("h:99999"), None);
    }
}

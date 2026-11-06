//! Network messages: `configure.net`, `policy_update`, tier-3 hook calls and
//! lazy body streams (`native/DESIGN.md`, "Network").
//!
//! Every struct here is plain data shared by the controller (TypeScript) and
//! `gondolind`. Field names are `snake_case` on the wire. Optional fields are
//! omitted when absent; unknown fields are ignored so the controller can add
//! fields ahead of the daemon.

use serde::{Deserialize, Serialize};

/// Default request body limit in `bytes` (`DEFAULT_MAX_HTTP_BODY_BYTES`)
pub const DEFAULT_MAX_HTTP_BODY_BYTES: u64 = 64 * 1024 * 1024;
/// Default response body limit in `bytes`
pub const DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES: u64 = DEFAULT_MAX_HTTP_BODY_BYTES;

/// `configure.net`: everything the egress side needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NetConfig {
    /// declarative policy (tier 1)
    pub policy: NetPolicy,
    /// tier-3 hooks the controller implements
    pub hooks: HookRegistrations,
    /// size limits and timeouts
    pub limits: NetLimits,
    /// CA used to sign MITM leaf certificates (absent: TLS flows are blocked)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mitm: Option<MitmCaConfig>,
    /// explicit `tcp.hosts` mappings (raw tunnels, no HTTP mediation)
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tcp_hosts: Vec<TcpHostMapping>,
    /// SSH egress (sniffed `SSH-` banners); absent: SSH is not recognized
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshEgressConfig>,
    /// extra PEM CA certificates trusted for upstream TLS (tests, corporate CAs)
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub upstream_ca_pems: Vec<String>,
    /// whether to also trust the operating system's root store upstream
    pub use_system_roots: bool,
    /// whether upstream TLS uses the built-in webpki root set
    pub use_webpki_roots: bool,
}

impl Default for NetConfig {
    fn default() -> Self {
        Self {
            policy: NetPolicy::default(),
            hooks: HookRegistrations::default(),
            limits: NetLimits::default(),
            mitm: None,
            tcp_hosts: Vec::new(),
            ssh: None,
            upstream_ca_pems: Vec::new(),
            use_system_roots: true,
            use_webpki_roots: true,
        }
    }
}

/// Declarative network policy. Replaced as a whole by `policy_update`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NetPolicy {
    /// rules compiled from `createHttpHooks()` options; absent when the hooks
    /// were not created by `createHttpHooks()` (then only the built-in
    /// internal-range default applies, unless an `is_ip_allowed` hook exists)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules: Option<HttpRules>,
    /// whether WebSocket upgrades are tunneled (`allowWebSockets`)
    pub allow_websockets: bool,
}

impl Default for NetPolicy {
    fn default() -> Self {
        Self { rules: None, allow_websockets: true }
    }
}

/// The `createHttpHooks()` options in evaluated form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct HttpRules {
    /// normalized allowed host patterns, already merged with
    /// `allowed_internal_hosts` (`["*"]` when `allowedHosts` was omitted)
    pub allowed_hosts: Vec<String>,
    /// normalized host patterns allowed to resolve to internal ranges
    pub allowed_internal_hosts: Vec<String>,
    /// whether internal ip ranges are blocked
    pub block_internal_ranges: bool,
    /// secrets in definition order
    pub secrets: Vec<SecretRule>,
    /// whether placeholders in URL query parameters are replaced
    pub replace_secrets_in_query: bool,
    /// placeholder strategy
    pub placeholder_mode: PlaceholderMode,
    /// random marker of `shared` mode placeholders (`<marker>.<identifier>`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
}

impl Default for HttpRules {
    fn default() -> Self {
        Self {
            allowed_hosts: vec!["*".into()],
            allowed_internal_hosts: Vec::new(),
            block_internal_ranges: true,
            secrets: Vec::new(),
            replace_secrets_in_query: false,
            placeholder_mode: PlaceholderMode::Shared,
            marker: None,
        }
    }
}

/// Secret placeholder strategy (`secretPlaceholderMode`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaceholderMode {
    #[default]
    Shared,
    Unique,
}

/// One secret (a `SecretEntry` of `createHttpHooks`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SecretRule {
    /// env var name
    pub name: String,
    /// normalized identifier (`[a-z0-9_-]+`) used by shared placeholders
    pub identifier: String,
    /// guest-visible placeholder
    pub placeholder: String,
    /// current secret value
    pub value: String,
    /// values replaced by rotation, rejected in outgoing requests
    pub revoked_values: Vec<String>,
    /// normalized host patterns this secret may be sent to
    pub hosts: Vec<String>,
    /// whether the secret was deleted (placeholders become empty strings)
    pub deleted: bool,
}

/// Which tier-3 hooks the controller has; unregistered phases cost nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HookRegistrations {
    pub is_request_allowed: bool,
    pub is_ip_allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_request: Option<BodyHookRegistration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_response: Option<BodyHookRegistration>,
}

/// Registration of a hook phase that may look at bodies.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BodyHookRegistration {
    /// whether the hook may pull the body (otherwise no body stream is offered)
    pub body: bool,
}

/// Limits and timeouts (node engine defaults).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NetLimits {
    /// max request body in `bytes`
    pub max_request_body_bytes: u64,
    /// max response body a hook may buffer in `bytes`
    pub max_response_body_bytes: u64,
    /// max concurrently bridged HTTP requests
    pub max_concurrent_requests: u32,
    /// websocket upstream connect + TLS handshake timeout in `ms`
    pub websocket_connect_timeout_ms: u64,
    /// websocket upstream response head timeout in `ms`
    pub websocket_header_timeout_ms: u64,
    /// MITM leaf certificate cache size (entries)
    pub tls_cache_max_entries: u32,
    /// MITM leaf certificate cache ttl in `ms` (0 disables caching)
    pub tls_cache_ttl_ms: u64,
    /// whether guest HTTP connections are kept alive between requests (node:
    /// one request per connection, `connection: close`)
    pub guest_keep_alive: bool,
}

impl Default for NetLimits {
    fn default() -> Self {
        Self {
            max_request_body_bytes: DEFAULT_MAX_HTTP_BODY_BYTES,
            max_response_body_bytes: DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES,
            max_concurrent_requests: 128,
            websocket_connect_timeout_ms: 10_000,
            websocket_header_timeout_ms: 10_000,
            tls_cache_max_entries: 256,
            tls_cache_ttl_ms: 10 * 60 * 1000,
            guest_keep_alive: false,
        }
    }
}

/// MITM CA (the controller's cached `ca.crt`/`ca.key`, PEM).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MitmCaConfig {
    /// CA certificate PEM
    pub cert_pem: String,
    /// CA private key PEM (PKCS#1 RSA, PKCS#8 RSA/ECDSA)
    pub key_pem: String,
}

/// `tcp.hosts` entry: guest `host[:port]` → upstream `host:port`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TcpHostMapping {
    /// normalized (lowercase) synthetic hostname
    pub host: String,
    /// guest destination port (absent: any port)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub upstream_host: String,
    pub upstream_port: u16,
}

/// SSH egress configuration (`VMOptions.ssh`, served by `gondolin-sshproxy`).
///
/// Defaults match `host/src/qemu/ssh.ts`. Paths are paths on the daemon's
/// machine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SshEgressConfig {
    /// destination ports on which `SSH-` banners are recognized (the ports of
    /// `allowed_hosts`; empty: derived from `allowed_hosts`)
    pub ports: Vec<u16>,
    /// allowed `HOST[:PORT]` patterns (`*` wildcards, default port 22, `[host]:port` accepted)
    pub allowed_hosts: Vec<String>,
    /// upstream private-key credentials, first matching `host` pattern wins
    pub credentials: Vec<SshCredential>,
    /// ssh-agent socket path (`$SSH_AUTH_SOCK`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// OpenSSH known_hosts files; empty: `~/.ssh/known_hosts` and `/etc/ssh/ssh_known_hosts`
    pub known_hosts_files: Vec<String>,
    /// known_hosts contents (remote controllers send the files they read
    /// locally); when non-empty, used instead of `known_hosts_files`
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub known_hosts: Vec<String>,
    /// the controller implements `hostVerifier` (`ssh_hook_call` `host_verify`) instead of known_hosts
    pub host_verifier_hook: bool,
    /// the controller implements `execPolicy` (`ssh_hook_call` `exec_policy`)
    pub exec_policy_hook: bool,
    /// guest-facing host key (OpenSSH or PEM private key); absent: ephemeral Ed25519 key
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_key: Option<String>,
    /// max concurrent upstream connections per guest TCP flow
    pub max_upstream_connections_per_flow: u32,
    /// max concurrent upstream connections across all flows
    pub max_upstream_connections_total: u32,
    /// upstream connect + handshake + auth timeout in `ms`
    pub upstream_ready_timeout_ms: u64,
    /// upstream keepalive interval in `ms` (0: disabled)
    pub upstream_keepalive_interval_ms: u64,
    /// unanswered upstream keepalives before disconnect
    pub upstream_keepalive_count_max: u32,
}

impl Default for SshEgressConfig {
    fn default() -> Self {
        Self {
            ports: Vec::new(),
            allowed_hosts: Vec::new(),
            credentials: Vec::new(),
            agent: None,
            known_hosts_files: Vec::new(),
            known_hosts: Vec::new(),
            host_verifier_hook: false,
            exec_policy_hook: false,
            host_key: None,
            max_upstream_connections_per_flow: 4,
            max_upstream_connections_total: 64,
            upstream_ready_timeout_ms: 15_000,
            upstream_keepalive_interval_ms: 10_000,
            upstream_keepalive_count_max: 3,
        }
    }
}

/// Upstream private-key credential (`ssh.credentials[pattern]`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SshCredential {
    /// `HOST[:PORT]` pattern the credential applies to
    pub host: String,
    /// upstream username (absent: `git`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// private key (OpenSSH, PKCS#1/PKCS#8 PEM)
    pub private_key: String,
    /// private key passphrase
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

/// `ssh_hook_call` (d→c request, answered by `ssh_hook_call_result` with
/// [`SshHookResult`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum SshHookCall {
    /// `ssh.execPolicy(request)`
    ExecPolicy { request: SshExecRequest },
    /// `ssh.hostVerifier(hostname, key, port)`
    HostVerify {
        hostname: String,
        port: u16,
        /// SSH wire encoding of the upstream host key
        #[serde(with = "serde_bytes")]
        key: Vec<u8>,
    },
}

/// Guest `exec` request (`SshExecRequest`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SshExecRequest {
    /// target hostname (synthetic DNS mapping)
    pub hostname: String,
    pub port: u16,
    /// username the guest authenticated as
    pub guest_username: String,
    /// raw exec command
    pub command: String,
    /// guest source address
    pub src_ip: String,
    pub src_port: u16,
}

/// `ssh_hook_call_result` payload (besides `ok`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SshHookResult {
    /// exec allowed / host key accepted
    pub allow: bool,
    /// exit code for a denied exec (absent: 1)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
    /// stderr message for a denied exec (newline appended)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `policy_update` (c→d): replaces the declarative policy (secret rotation).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PolicyUpdate {
    pub policy: NetPolicy,
}

/// Hook phase of a `hook_call`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookPhase {
    IsRequestAllowed,
    IsIpAllowed,
    OnRequest,
    OnResponse,
}

/// Request head as plain data.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WireRequestHead {
    pub method: String,
    /// absolute URL
    pub url: String,
    /// `[name, value]` pairs, lowercase names
    pub headers: Vec<(String, String)>,
    /// daemon body stream id (pull with `body_pull`); absent: no body
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<u64>,
}

/// Response head as plain data.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WireResponseHead {
    pub status: u16,
    pub status_text: String,
    /// `[name, value]` pairs, lowercase names, repeated names allowed
    pub headers: Vec<(String, String)>,
    /// daemon body stream id; absent: no body
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<u64>,
}

/// Destination ip check info (`HttpIpAllowInfo`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WireIpInfo {
    pub hostname: String,
    pub ip: String,
    /// 4 or 6
    pub family: u8,
    pub port: u16,
    /// "http" or "https"
    pub protocol: String,
}

/// `hook_call` (d→c request, answered by `hook_call_result`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookCall {
    pub phase: HookPhase,
    /// request (all phases but `is_ip_allowed`; for `on_response` the final request, without body)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<WireRequestHead>,
    /// upstream response (`on_response`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<WireResponseHead>,
    /// destination (`is_ip_allowed`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip: Option<WireIpInfo>,
}

/// Body of a replaced request/response in a hook decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WireBody {
    /// keep the original body (bytes already pulled are replayed by the daemon)
    Original,
    /// no body
    None,
    /// inline bytes
    Bytes {
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
    /// controller-held stream, pulled by the daemon with `body_pull`
    Stream { stream: u64 },
}

/// `hook_call_result` payload (besides `ok`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum HookDecision {
    /// `is_request_allowed` / `is_ip_allowed` answer
    Allowed { allowed: bool },
    /// keep the request/response unchanged (incl. in-place header mutations
    /// already reflected in `request`/`response` when present)
    Continue,
    /// continue with a replaced request (`on_request`)
    Request { request: WireRequestHead, body: WireBody },
    /// short-circuit (`on_request`) or replaced response (`on_response`)
    Response { response: WireResponseHead, body: WireBody },
    /// reject with an error response (`HttpRequestBlockedError`)
    Block { status: u16, status_text: String, message: String },
}

/// `body_pull` (either direction): read the next chunk of a body stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BodyPull {
    pub stream: u64,
    /// max chunk size in `bytes`
    pub max: u64,
    /// read position in `bytes` (daemon streams: lets several readers, e.g.
    /// `clone()`d Requests, read the retained body independently); absent:
    /// continue after the previous pull
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
}

/// `body_pull_result`: one chunk (empty `data` with `eof` ends the stream).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BodyChunk {
    pub stream: u64,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
    pub eof: bool,
}

/// `body_release` (either direction, no reply): the reader is done with a stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BodyRelease {
    pub stream: u64,
}

/// Message type names.
pub mod types {
    pub const POLICY_UPDATE: &str = "policy_update";
    pub const HOOK_CALL: &str = "hook_call";
    pub const HOOK_CALL_RESULT: &str = "hook_call_result";
    pub const BODY_PULL: &str = "body_pull";
    pub const BODY_PULL_RESULT: &str = "body_pull_result";
    pub const BODY_RELEASE: &str = "body_release";
    pub const SSH_HOOK_CALL: &str = "ssh_hook_call";
    pub const SSH_HOOK_CALL_RESULT: &str = "ssh_hook_call_result";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_roundtrip() {
        let d = HookDecision::Request {
            request: WireRequestHead {
                method: "GET".into(),
                url: "https://example.com/".into(),
                headers: vec![("a".into(), "b".into())],
                body: None,
            },
            body: WireBody::Bytes { data: b"hi".to_vec() },
        };
        let enc = gondolin_wire::encode(&d).unwrap();
        let back: HookDecision = gondolin_wire::decode(&enc).unwrap();
        assert_eq!(back, d);
    }

    #[test]
    fn config_defaults_from_empty_map() {
        let enc = gondolin_wire::encode(&serde_json_like_empty()).unwrap();
        let cfg: NetConfig = gondolin_wire::decode(&enc).unwrap();
        assert!(cfg.policy.allow_websockets);
        assert_eq!(cfg.limits.max_concurrent_requests, 128);
        assert!(cfg.use_system_roots);
    }

    fn serde_json_like_empty() -> std::collections::BTreeMap<String, u8> {
        std::collections::BTreeMap::new()
    }
}

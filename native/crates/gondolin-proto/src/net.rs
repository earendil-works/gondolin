//! Network messages: `configure.net`, `policy_update`, tier-3 hook calls and
//! lazy body streams (`native/DESIGN.md`, "Network").
//!
//! Every struct here is plain data shared by the controller (TypeScript) and
//! `gondolind`. Field names are `snake_case` on the wire. Optional fields are
//! omitted when absent; unknown fields are ignored so the controller can add
//! fields ahead of the daemon.

/// Default request body limit in `bytes` (`DEFAULT_MAX_HTTP_BODY_BYTES`)
pub const DEFAULT_MAX_HTTP_BODY_BYTES: u64 = 64 * 1024 * 1024;
/// Default response body limit in `bytes`
pub const DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES: u64 = DEFAULT_MAX_HTTP_BODY_BYTES;

gondolin_wire::wire_struct! {
    /// `configure.net`: everything the egress side needs.
    #[derive(Debug, Clone, PartialEq)]
    pub struct NetConfig {
        /// declarative policy (tier 1)
        pub policy: NetPolicy = NetConfig::default().policy,
        /// tier-3 hooks the controller implements
        pub hooks: HookRegistrations = NetConfig::default().hooks,
        /// tier-2 hooks: a JavaScript policy run inside the daemon on djs
        pub djs_hooks: Option<DjsHooksConfig>,
        /// size limits and timeouts
        pub limits: NetLimits = NetConfig::default().limits,
        /// CA used to sign MITM leaf certificates (absent: TLS flows are blocked)
        pub mitm: Option<MitmCaConfig>,
        /// explicit `tcp.hosts` mappings (raw tunnels, no HTTP mediation)
        pub tcp_hosts: Vec<TcpHostMapping> = NetConfig::default().tcp_hosts => skip_if Vec::is_empty,
        /// SSH egress (sniffed `SSH-` banners); absent: SSH is not recognized
        pub ssh: Option<SshEgressConfig>,
        /// extra PEM CA certificates trusted for upstream TLS (tests, corporate CAs)
        pub upstream_ca_pems: Vec<String> = NetConfig::default().upstream_ca_pems => skip_if Vec::is_empty,
        /// whether to also trust the operating system's root store upstream
        pub use_system_roots: bool = NetConfig::default().use_system_roots,
        /// whether upstream TLS uses the built-in webpki root set
        pub use_webpki_roots: bool = NetConfig::default().use_webpki_roots,
    }
}

impl Default for NetConfig {
    fn default() -> Self {
        Self {
            policy: NetPolicy::default(),
            hooks: HookRegistrations::default(),
            djs_hooks: None,
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

gondolin_wire::wire_struct! {
    /// Declarative network policy. Replaced as a whole by `policy_update`.
    #[derive(Debug, Clone, PartialEq)]
    pub struct NetPolicy {
        /// rules compiled from `createHttpHooks()` options; absent when the hooks
        /// were not created by `createHttpHooks()` (then only the built-in
        /// internal-range default applies, unless an `is_ip_allowed` hook exists)
        pub rules: Option<HttpRules>,
        /// whether WebSocket upgrades are tunneled (`allowWebSockets`)
        pub allow_websockets: bool = NetPolicy::default().allow_websockets,
    }
}

impl Default for NetPolicy {
    fn default() -> Self {
        Self { rules: None, allow_websockets: true }
    }
}

gondolin_wire::wire_struct! {
    /// The `createHttpHooks()` options in evaluated form.
    #[derive(Debug, Clone, PartialEq)]
    pub struct HttpRules {
        /// normalized allowed host patterns, already merged with
        /// `allowed_internal_hosts` (`["*"]` when `allowedHosts` was omitted)
        pub allowed_hosts: Vec<String> = HttpRules::default().allowed_hosts,
        /// normalized host patterns allowed to resolve to internal ranges
        pub allowed_internal_hosts: Vec<String> = HttpRules::default().allowed_internal_hosts,
        /// whether internal ip ranges are blocked
        pub block_internal_ranges: bool = HttpRules::default().block_internal_ranges,
        /// secrets in definition order
        pub secrets: Vec<SecretRule> = HttpRules::default().secrets,
        /// whether placeholders in URL query parameters are replaced
        pub replace_secrets_in_query: bool = HttpRules::default().replace_secrets_in_query,
        /// placeholder strategy
        pub placeholder_mode: PlaceholderMode = HttpRules::default().placeholder_mode,
        /// random marker of `shared` mode placeholders (`<marker>.<identifier>`)
        pub marker: Option<String>,
    }
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

gondolin_wire::wire_enum! {
    /// Secret placeholder strategy (`secretPlaceholderMode`).
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub enum PlaceholderMode {
        #[default]
        Shared = "shared",
        Unique = "unique",
    }
}

gondolin_wire::wire_struct! {
    /// One secret (a `SecretEntry` of `createHttpHooks`).
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct SecretRule {
        /// env var name
        pub name: String = SecretRule::default().name,
        /// normalized identifier (`[a-z0-9_-]+`) used by shared placeholders
        pub identifier: String = SecretRule::default().identifier,
        /// guest-visible placeholder
        pub placeholder: String = SecretRule::default().placeholder,
        /// current secret value
        pub value: String = SecretRule::default().value,
        /// values replaced by rotation, rejected in outgoing requests
        pub revoked_values: Vec<String> = SecretRule::default().revoked_values,
        /// normalized host patterns this secret may be sent to
        pub hosts: Vec<String> = SecretRule::default().hosts,
        /// whether the secret was deleted (placeholders become empty strings)
        pub deleted: bool = SecretRule::default().deleted,
    }
}

gondolin_wire::wire_struct! {
    /// Which tier-3 hooks the controller has; unregistered phases cost nothing.
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    pub struct HookRegistrations {
        pub is_request_allowed: bool = HookRegistrations::default().is_request_allowed,
        pub is_ip_allowed: bool = HookRegistrations::default().is_ip_allowed,
        pub on_request: Option<BodyHookRegistration>,
        pub on_response: Option<BodyHookRegistration>,
    }
}

gondolin_wire::wire_enum! {
    /// How a tier-2 policy source is evaluated.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub enum DjsSourceKind {
        /// a classic script; the hooks are global functions
        #[default]
        Script = "script",
        /// an ES module; the hooks are its exports
        Module = "module",
        /// an ES module in TypeScript (types are erased as it compiles)
        TypeScript = "typescript",
    }
}

gondolin_wire::wire_struct! {
    /// Tier-2 hook policy (`createDjsHooks()`, `--hooks-script`): compiled once
    /// at `configure.net`; the phases are the functions it defines among
    /// `isRequestAllowed`, `isIpAllowed`, `onRequest` and `onResponse`.
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct DjsHooksConfig {
        /// policy source text
        pub source: String = DjsHooksConfig::default().source,
        /// name in stack traces and the module key of a module policy
        pub filename: Option<String>,
        /// script (global functions), module or typescript (exports)
        pub kind: DjsSourceKind = DjsSourceKind::Script,
        /// sources a module policy may import, by key (relative specifiers
        /// resolve against the importer's key; in memory, no I/O); the key's
        /// extension picks the language: `.ts`/`.mts`/`.cts` TypeScript,
        /// `.json` a JSON module, else JavaScript
        pub modules: std::collections::BTreeMap<String, String> = Default::default() => skip_if std::collections::BTreeMap::is_empty,
        /// per-call budgets (absent fields: daemon defaults)
        pub limits: DjsHookLimits = Default::default(),
    }
}

gondolin_wire::wire_struct! {
    /// Budgets of one tier-2 hook call; exceeding one fails the call closed.
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    pub struct DjsHookLimits {
        /// fuel per call (interpreter cost units, about 4 ns each; default 50M)
        pub fuel: Option<u64>,
        /// heap cap per call in `bytes` (default 64 MiB)
        pub memory_bytes: Option<u64>,
        /// wall-clock time per call in `ms`, body reads included (default 30000)
        pub timeout_ms: Option<u64>,
    }
}

gondolin_wire::wire_struct! {
    /// Registration of a hook phase that may look at bodies.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub struct BodyHookRegistration {
        /// whether the hook may pull the body (otherwise no body stream is offered)
        pub body: bool = BodyHookRegistration::default().body,
    }
}

gondolin_wire::wire_struct! {
    /// Limits and timeouts (node engine defaults).
    #[derive(Debug, Clone, PartialEq)]
    pub struct NetLimits {
        /// max request body in `bytes`
        pub max_request_body_bytes: u64 = NetLimits::default().max_request_body_bytes,
        /// max response body a hook may buffer in `bytes`
        pub max_response_body_bytes: u64 = NetLimits::default().max_response_body_bytes,
        /// max concurrently bridged HTTP requests
        pub max_concurrent_requests: u32 = NetLimits::default().max_concurrent_requests,
        /// websocket upstream connect + TLS handshake timeout in `ms`
        pub websocket_connect_timeout_ms: u64 = NetLimits::default().websocket_connect_timeout_ms,
        /// websocket upstream response head timeout in `ms`
        pub websocket_header_timeout_ms: u64 = NetLimits::default().websocket_header_timeout_ms,
        /// MITM leaf certificate cache size (entries)
        pub tls_cache_max_entries: u32 = NetLimits::default().tls_cache_max_entries,
        /// MITM leaf certificate cache ttl in `ms` (0 disables caching)
        pub tls_cache_ttl_ms: u64 = NetLimits::default().tls_cache_ttl_ms,
        /// whether guest HTTP connections are kept alive between requests (node:
        /// one request per connection, `connection: close`)
        pub guest_keep_alive: bool = NetLimits::default().guest_keep_alive,
    }
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

gondolin_wire::wire_struct! {
    /// MITM CA (the controller's cached `ca.crt`/`ca.key`, PEM).
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct MitmCaConfig {
        /// CA certificate PEM
        pub cert_pem: String,
        /// CA private key PEM (PKCS#1 RSA, PKCS#8 RSA/ECDSA)
        pub key_pem: String,
    }
}

gondolin_wire::wire_struct! {
    /// `tcp.hosts` entry: guest `host[:port]` → upstream `host:port`.
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct TcpHostMapping {
        /// normalized (lowercase) synthetic hostname
        pub host: String,
        /// guest destination port (absent: any port)
        pub port: Option<u16>,
        pub upstream_host: String,
        pub upstream_port: u16,
    }
}

gondolin_wire::wire_struct! {
    /// SSH egress configuration (`VMOptions.ssh`, served by `gondolin-sshproxy`).
    ///
    /// Paths are paths on the daemon's machine.
    #[derive(Debug, Clone, PartialEq)]
    pub struct SshEgressConfig {
        /// destination ports on which `SSH-` banners are recognized (the ports of
        /// `allowed_hosts`; empty: derived from `allowed_hosts`)
        pub ports: Vec<u16> = SshEgressConfig::default().ports,
        /// allowed `HOST[:PORT]` patterns (`*` wildcards, default port 22, `[host]:port` accepted)
        pub allowed_hosts: Vec<String> = SshEgressConfig::default().allowed_hosts,
        /// upstream private-key credentials, first matching `host` pattern wins
        pub credentials: Vec<SshCredential> = SshEgressConfig::default().credentials,
        /// ssh-agent socket path (`$SSH_AUTH_SOCK`)
        pub agent: Option<String>,
        /// OpenSSH known_hosts files; empty: `~/.ssh/known_hosts` and `/etc/ssh/ssh_known_hosts`
        pub known_hosts_files: Vec<String> = SshEgressConfig::default().known_hosts_files,
        /// known_hosts contents (remote controllers send the files they read
        /// locally); when non-empty, used instead of `known_hosts_files`
        pub known_hosts: Vec<String> = SshEgressConfig::default().known_hosts => skip_if Vec::is_empty,
        /// the controller implements `hostVerifier` (`ssh_hook_call` `host_verify`) instead of known_hosts
        pub host_verifier_hook: bool = SshEgressConfig::default().host_verifier_hook,
        /// the controller implements `execPolicy` (`ssh_hook_call` `exec_policy`)
        pub exec_policy_hook: bool = SshEgressConfig::default().exec_policy_hook,
        /// guest-facing host key (OpenSSH or PEM private key); absent: ephemeral Ed25519 key
        pub host_key: Option<String>,
        /// max concurrent upstream connections per guest TCP flow
        pub max_upstream_connections_per_flow: u32 = SshEgressConfig::default().max_upstream_connections_per_flow,
        /// max concurrent upstream connections across all flows
        pub max_upstream_connections_total: u32 = SshEgressConfig::default().max_upstream_connections_total,
        /// upstream connect + handshake + auth timeout in `ms`
        pub upstream_ready_timeout_ms: u64 = SshEgressConfig::default().upstream_ready_timeout_ms,
        /// upstream keepalive interval in `ms` (0: disabled)
        pub upstream_keepalive_interval_ms: u64 = SshEgressConfig::default().upstream_keepalive_interval_ms,
        /// unanswered upstream keepalives before disconnect
        pub upstream_keepalive_count_max: u32 = SshEgressConfig::default().upstream_keepalive_count_max,
    }
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

gondolin_wire::wire_struct! {
    /// Upstream private-key credential (`ssh.credentials[pattern]`).
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct SshCredential {
        /// `HOST[:PORT]` pattern the credential applies to
        pub host: String = SshCredential::default().host,
        /// upstream username (absent: `git`)
        pub username: Option<String>,
        /// private key (OpenSSH, PKCS#1/PKCS#8 PEM)
        pub private_key: String = SshCredential::default().private_key,
        /// private key passphrase
        pub passphrase: Option<String>,
    }
}

gondolin_wire::wire_tagged! {
    /// `ssh_hook_call` (d→c request, answered by `ssh_hook_call_result` with
    /// [`SshHookResult`]).
    #[derive(Debug, Clone, PartialEq)]
    pub enum SshHookCall : "phase" {
        /// `ssh.execPolicy(request)`
        ExecPolicy = "exec_policy" { request: SshExecRequest },
        /// `ssh.hostVerifier(hostname, key, port)`
        HostVerify = "host_verify" {
            hostname: String,
            port: u16,
            /// SSH wire encoding of the upstream host key
            key: Vec<u8>,
        },
    }
}

gondolin_wire::wire_struct! {
    /// Guest `exec` request (`SshExecRequest`).
    #[derive(Debug, Clone, Default, PartialEq)]
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
}

gondolin_wire::wire_struct! {
    /// `ssh_hook_call_result` payload (besides `ok`).
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct SshHookResult {
        /// exec allowed / host key accepted
        pub allow: bool = SshHookResult::default().allow,
        /// exit code for a denied exec (absent: 1)
        pub exit_code: Option<u32>,
        /// stderr message for a denied exec (newline appended)
        pub message: Option<String>,
    }
}

gondolin_wire::wire_struct! {
    /// `policy_update` (c→d): replaces the declarative policy (secret rotation).
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct PolicyUpdate {
        pub policy: NetPolicy,
    }
}

gondolin_wire::wire_enum! {
    /// Hook phase of a `hook_call`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum HookPhase {
        IsRequestAllowed = "is_request_allowed",
        IsIpAllowed = "is_ip_allowed",
        OnRequest = "on_request",
        OnResponse = "on_response",
    }
}

gondolin_wire::wire_struct! {
    /// Request head as plain data.
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct WireRequestHead {
        pub method: String,
        /// absolute URL
        pub url: String,
        /// `[name, value]` pairs, lowercase names
        pub headers: Vec<(String, String)>,
        /// daemon body stream id (pull with `body_pull`); absent: no body
        pub body: Option<u64>,
        /// first bytes of the body, sent inline (pull the rest from offset `len`)
        pub body_prefix: Option<Vec<u8>>,
        /// whether `body_prefix` is the whole body (no `body_pull` needed)
        pub body_complete: bool = Default::default() => skip_if std::ops::Not::not,
    }
}

gondolin_wire::wire_struct! {
    /// Response head as plain data.
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct WireResponseHead {
        pub status: u16,
        pub status_text: String,
        /// `[name, value]` pairs, lowercase names, repeated names allowed
        pub headers: Vec<(String, String)>,
        /// daemon body stream id; absent: no body
        pub body: Option<u64>,
        /// first bytes of the body, sent inline (pull the rest from offset `len`)
        pub body_prefix: Option<Vec<u8>>,
        /// whether `body_prefix` is the whole body (no `body_pull` needed)
        pub body_complete: bool = Default::default() => skip_if std::ops::Not::not,
    }
}

gondolin_wire::wire_struct! {
    /// Destination ip check info (`HttpIpAllowInfo`).
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct WireIpInfo {
        pub hostname: String,
        pub ip: String,
        /// 4 or 6
        pub family: u8,
        pub port: u16,
        /// "http" or "https"
        pub protocol: String,
    }
}

gondolin_wire::wire_struct! {
    /// `hook_call` (d→c request, answered by `hook_call_result`).
    #[derive(Debug, Clone, PartialEq)]
    pub struct HookCall {
        pub phase: HookPhase,
        /// request (all phases but `is_ip_allowed`; for `on_response` the final request, without body)
        pub request: Option<WireRequestHead>,
        /// upstream response (`on_response`)
        pub response: Option<WireResponseHead>,
        /// destination (`is_ip_allowed`)
        pub ip: Option<WireIpInfo>,
    }
}

gondolin_wire::wire_tagged! {
    /// Body of a replaced request/response in a hook decision.
    #[derive(Debug, Clone, PartialEq)]
    pub enum WireBody : "kind" {
        /// keep the original body (bytes already pulled are replayed by the daemon)
        Original = "original",
        /// no body
        None = "none",
        /// inline bytes
        Bytes = "bytes" { data: Vec<u8> },
        /// controller-held stream, pulled by the daemon with `body_pull`
        Stream = "stream" { stream: u64 },
    }
}

gondolin_wire::wire_tagged! {
    /// `hook_call_result` payload (besides `ok`).
    #[derive(Debug, Clone, PartialEq)]
    pub enum HookDecision : "action" {
        /// `is_request_allowed` / `is_ip_allowed` answer
        Allowed = "allowed" { allowed: bool },
        /// keep the request/response unchanged (incl. in-place header mutations
        /// already reflected in `request`/`response` when present)
        Continue = "continue",
        /// continue with a replaced request (`on_request`)
        Request = "request" { request: WireRequestHead, body: WireBody },
        /// short-circuit (`on_request`) or replaced response (`on_response`)
        Response = "response" { response: WireResponseHead, body: WireBody },
        /// reject with an error response (`HttpRequestBlockedError`)
        Block = "block" { status: u16, status_text: String, message: String },
    }
}

gondolin_wire::wire_struct! {
    /// `body_pull` (either direction): read the next chunk of a body stream.
    #[derive(Debug, Clone, PartialEq)]
    pub struct BodyPull {
        pub stream: u64,
        /// max chunk size in `bytes`
        pub max: u64,
        /// read position in `bytes` (daemon streams: lets several readers, e.g.
        /// `clone()`d Requests, read the retained body independently); absent:
        /// continue after the previous pull
        pub offset: Option<u64>,
    }
}

gondolin_wire::wire_struct! {
    /// `body_pull_result`: one chunk (empty `data` with `eof` ends the stream).
    #[derive(Debug, Clone, PartialEq)]
    pub struct BodyChunk {
        pub stream: u64,
        pub data: Vec<u8>,
        pub eof: bool,
    }
}

gondolin_wire::wire_struct! {
    /// `body_release` (either direction, no reply): the reader is done with a stream.
    #[derive(Debug, Clone, PartialEq)]
    pub struct BodyRelease {
        pub stream: u64,
    }
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
                body: Some(3),
                body_prefix: Some(b"pre".to_vec()),
                body_complete: true,
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

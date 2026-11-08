//! Exec-only SSH egress proxy.
//!
//! A guest TCP flow that egress classified as SSH (an `SSH-` banner to an
//! allowlisted synthetic hostname and port) is terminated by an in-process SSH
//! server. Every guest `exec` channel is checked (optional controller
//! `execPolicy`), then proxied over its own upstream SSH connection to the real
//! `HOST:PORT`, authenticated with a configured private key or the host's
//! ssh-agent and verified against OpenSSH `known_hosts` (or a controller
//! `hostVerifier`). Shells are answered with an error and exit status 1,
//! subsystems (sftp) and every other channel type are refused. Upstream
//! connections are capped per flow and in total, time-bounded while connecting
//! and kept alive.
//!
//! Seam for egress: [`SshProxy::target_for`] decides whether a flow may use
//! SSH; [`SshProxy::handle`] serves it.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use gondolin_netstack::{BoxFuture, DnsConfig, DnsMode, FlowMeta, SyntheticHostMapping, TcpFlow};

/// Standard base64 (gondolin-wire's codec; padding optional when decoding).
pub(crate) mod b64 {
    pub fn encode(data: impl AsRef<[u8]>) -> String {
        gondolin_wire::base64::encode(data.as_ref())
    }

    pub fn decode(text: impl AsRef<[u8]>) -> Result<Vec<u8>, ()> {
        std::str::from_utf8(text.as_ref()).ok().and_then(gondolin_wire::base64::decode).ok_or(())
    }
}

pub mod git;
pub mod known_hosts;
mod server;
pub mod ssh;
pub mod targets;
mod upstream;

pub use gondolin_proto::net::{
    SshCredential, SshEgressConfig, SshExecRequest, SshHookCall, SshHookResult,
};

use crate::known_hosts::KnownHosts;
use crate::ssh::PrivateKey;
use crate::targets::{TargetPattern, match_hostname, parse_target_pattern, parse_targets};

/// Invalid SSH egress configuration (messages match the node engine).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshConfigError(pub String);

impl std::fmt::Display for SshConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SshConfigError {}

/// Controller callbacks (`ssh.execPolicy`, `ssh.hostVerifier`); gondolind
/// forwards them as `ssh_hook_call` requests. Only called for the hooks the
/// configuration declares.
pub trait SshHooks: Send + Sync + 'static {
    fn ssh_hook_call(&self, call: SshHookCall) -> BoxFuture<'_, Result<SshHookResult, String>>;
}

/// [`SshHooks`] for configurations without controller hooks.
pub struct NoSshHooks;

impl SshHooks for NoSshHooks {
    fn ssh_hook_call(&self, _call: SshHookCall) -> BoxFuture<'_, Result<SshHookResult, String>> {
        Box::pin(async { Err("no ssh hooks registered".into()) })
    }
}

/// SSH egress needs synthetic DNS with per-host mapping so the destination IP
/// can be mapped back to the hostname (node: `assertSshDnsConfig`).
pub fn check_dns(dns: &DnsConfig) -> Result<(), SshConfigError> {
    if dns.mode != DnsMode::Synthetic {
        return Err(SshConfigError("ssh egress requires dns mode 'synthetic'".into()));
    }
    if dns.synthetic_host_mapping != SyntheticHostMapping::PerHost {
        return Err(SshConfigError(
            "ssh egress requires dns syntheticHostMapping='per-host'".into(),
        ));
    }
    Ok(())
}

/// Where an allowed SSH flow goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTarget {
    /// upstream hostname (lowercase synthetic hostname)
    pub hostname: String,
    /// upstream port (the guest's destination port)
    pub port: u16,
    /// index of the matching credential; `None`: ssh-agent
    credential: Option<usize>,
}

pub(crate) struct Credential {
    pattern: String,
    port: u16,
    username: Option<String>,
    key: PrivateKey,
}

pub(crate) enum HostVerifier {
    KnownHosts(KnownHosts),
    Hook,
    /// SSH disabled or no auth configured (never connects)
    Reject,
}

pub(crate) struct Inner {
    targets: Vec<TargetPattern>,
    credentials: Vec<Credential>,
    agent: Option<PathBuf>,
    verifier: HostVerifier,
    hooks: Arc<dyn SshHooks>,
    exec_policy_hook: bool,
    server_config: (ssh::transport::TransportConfig, ssh::session::SessionConfig),
    max_per_flow: usize,
    max_total: usize,
    ready_timeout: Duration,
    keepalive_interval: Option<Duration>,
    keepalive_max: usize,
    /// upstream connections across all flows
    total: AtomicUsize,
}

/// The SSH egress proxy; one per VM, shared by all flows.
#[derive(Clone)]
pub struct SshProxy {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for SshProxy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshProxy").field("targets", &self.inner.targets).finish_non_exhaustive()
    }
}

impl SshProxy {
    /// Validates `config` (limits, known_hosts, credentials/agent) and builds
    /// the proxy. With no valid `allowed_hosts` the proxy is disabled
    /// ([`SshProxy::target_for`] always returns `None`), as in the node engine.
    pub fn new(config: &SshEgressConfig, hooks: Arc<dyn SshHooks>) -> Result<Self, SshConfigError> {
        let err = |m: &str| SshConfigError(m.to_string());
        if config.max_upstream_connections_per_flow == 0 {
            return Err(err("ssh.maxUpstreamConnectionsPerTcpSession must be an integer > 0"));
        }
        if config.max_upstream_connections_total == 0 {
            return Err(err("ssh.maxUpstreamConnectionsTotal must be an integer > 0"));
        }
        if config.upstream_ready_timeout_ms == 0 {
            return Err(err("ssh.upstreamReadyTimeoutMs must be an integer > 0"));
        }

        let targets = parse_targets(&config.allowed_hosts);
        let mut credentials = Vec::new();
        for raw in &config.credentials {
            let Some(target) = parse_target_pattern(&raw.host) else {
                continue;
            };
            let key = ssh::decode_secret_key(&raw.private_key, raw.passphrase.as_deref()).map_err(
                |e| SshConfigError(format!("invalid ssh credential for {}: {e}", raw.host)),
            )?;
            credentials.push(Credential {
                pattern: target.pattern,
                port: target.port,
                username: raw.username.clone(),
                key,
            });
        }
        let agent = config.agent.as_ref().filter(|a| !a.is_empty()).map(PathBuf::from);
        let enabled = !targets.is_empty();

        let verifier = if !enabled || (credentials.is_empty() && agent.is_none()) {
            HostVerifier::Reject
        } else if config.host_verifier_hook {
            HostVerifier::Hook
        } else if config.known_hosts.iter().any(|c| !c.trim().is_empty()) {
            HostVerifier::KnownHosts(KnownHosts::parse(&config.known_hosts.join("\n")))
        } else {
            let files: Vec<PathBuf> =
                if config.known_hosts_files.iter().any(|f| !f.trim().is_empty()) {
                    let mut files: Vec<PathBuf> = Vec::new();
                    for f in
                        config.known_hosts_files.iter().map(|f| f.trim()).filter(|f| !f.is_empty())
                    {
                        if !files.iter().any(|x| x.as_os_str() == f) {
                            files.push(PathBuf::from(f));
                        }
                    }
                    files
                } else {
                    known_hosts::default_files()
                };
            HostVerifier::KnownHosts(KnownHosts::load(&files).map_err(|e| {
                SshConfigError(format!(
                    "ssh egress requires ssh.hostVerifier to validate upstream host keys (failed to load known_hosts: {e})"
                ))
            })?)
        };
        if enabled && credentials.is_empty() && agent.is_none() {
            return Err(err(
                "ssh egress requires at least one credential or ssh agent (direct ssh is not supported)",
            ));
        }

        let host_key = match &config.host_key {
            Some(pem) => ssh::decode_secret_key(pem, None)
                .map_err(|e| SshConfigError(format!("invalid ssh.hostKey: {e}")))?,
            None => server::ephemeral_host_key()?,
        };

        Ok(SshProxy {
            inner: Arc::new(Inner {
                targets,
                credentials,
                agent,
                verifier,
                hooks,
                exec_policy_hook: config.exec_policy_hook,
                server_config: server::server_config(host_key),
                max_per_flow: config.max_upstream_connections_per_flow as usize,
                max_total: config.max_upstream_connections_total as usize,
                ready_timeout: Duration::from_millis(config.upstream_ready_timeout_ms),
                keepalive_interval: (config.upstream_keepalive_interval_ms > 0)
                    .then(|| Duration::from_millis(config.upstream_keepalive_interval_ms)),
                keepalive_max: config.upstream_keepalive_count_max as usize,
                total: AtomicUsize::new(0),
            }),
        })
    }

    /// Whether SSH egress is enabled (non-empty allowlist).
    pub fn enabled(&self) -> bool {
        !self.inner.targets.is_empty()
    }

    /// Destination ports on which egress should recognize `SSH-` banners.
    pub fn sniff_ports(&self) -> Vec<u16> {
        let mut ports: Vec<u16> = Vec::new();
        for t in &self.inner.targets {
            if !ports.contains(&t.port) {
                ports.push(t.port);
            }
        }
        ports
    }

    /// Decides whether a flow may use SSH egress (node: `isSshFlowAllowed`):
    /// it needs a synthetic hostname that matches an allowlisted
    /// `HOST[:PORT]` for its destination port, and a credential for that host
    /// or an ssh-agent.
    pub fn target_for(&self, meta: &FlowMeta) -> Option<SshTarget> {
        let inner = &self.inner;
        if inner.targets.is_empty() {
            return None;
        }
        let hostname = meta.synthetic_hostname.as_deref()?.to_ascii_lowercase();
        let port = meta.dst.port();
        if !inner.targets.iter().any(|t| t.port == port && match_hostname(&hostname, &t.pattern)) {
            return None;
        }
        let credential = inner
            .credentials
            .iter()
            .position(|c| c.port == port && match_hostname(&hostname, &c.pattern));
        if credential.is_none() && inner.agent.is_none() {
            return None;
        }
        Some(SshTarget { hostname, port, credential })
    }

    /// Serves one guest SSH connection until it ends. Protocol or upstream
    /// errors reset the guest connection (node: `abortTcpSession`).
    pub async fn handle(&self, flow: TcpFlow, target: SshTarget) {
        server::serve(self.inner.clone(), flow, target).await
    }

    /// Upstream SSH connections currently open across all flows.
    pub fn upstream_connections(&self) -> usize {
        self.inner.total.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(host: Option<&str>, port: u16) -> FlowMeta {
        FlowMeta {
            id: 1,
            src: "192.168.127.3:50000".parse().unwrap(),
            dst: format!("198.19.0.1:{port}").parse().unwrap(),
            synthetic_hostname: host.map(str::to_string),
        }
    }

    fn known_hosts_file() -> tempfile::NamedTempFile {
        let f = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(f.path(), "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n").unwrap();
        f
    }

    fn config(allowed: &[&str], kh: &tempfile::NamedTempFile) -> SshEgressConfig {
        SshEgressConfig {
            allowed_hosts: allowed.iter().map(|s| s.to_string()).collect(),
            agent: Some("/tmp/fake-ssh-agent.sock".into()),
            known_hosts_files: vec![kh.path().display().to_string()],
            ..Default::default()
        }
    }

    #[test]
    fn target_requires_allowlisted_synthetic_hostname_and_port() {
        let kh = known_hosts_file();
        let proxy = SshProxy::new(
            &config(&["github.com", "ssh.github.com:443"], &kh),
            Arc::new(NoSshHooks),
        )
        .unwrap();
        assert_eq!(proxy.sniff_ports(), vec![22, 443]);
        let t = proxy.target_for(&meta(Some("GitHub.com"), 22)).unwrap();
        assert_eq!((t.hostname.as_str(), t.port, t.credential), ("github.com", 22, None));
        assert!(proxy.target_for(&meta(Some("gitlab.com"), 22)).is_none());
        assert!(proxy.target_for(&meta(None, 22)).is_none());
        assert!(proxy.target_for(&meta(Some("github.com"), 443)).is_none());
        assert!(proxy.target_for(&meta(Some("ssh.github.com"), 443)).is_some());
        assert!(proxy.target_for(&meta(Some("ssh.github.com"), 22)).is_none());
    }

    #[test]
    fn known_hosts_content_replaces_files() {
        let cfg = SshEgressConfig {
            allowed_hosts: vec!["github.com".into()],
            agent: Some("/tmp/fake-ssh-agent.sock".into()),
            known_hosts_files: vec!["/nonexistent/known_hosts".into()],
            known_hosts: vec!["github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n".into()],
            ..Default::default()
        };
        assert!(SshProxy::new(&cfg, Arc::new(NoSshHooks)).is_ok());
        let cfg = SshEgressConfig { known_hosts: Vec::new(), ..cfg };
        assert!(SshProxy::new(&cfg, Arc::new(NoSshHooks)).is_err());
    }

    #[test]
    fn credentials_match_by_pattern_and_port() {
        let kh = known_hosts_file();
        let key = server::ephemeral_host_key().unwrap();
        let pem = key.to_openssh();
        let mut cfg = config(&["github.com", "*.example.com:2222"], &kh);
        cfg.agent = None;
        cfg.credentials = vec![SshCredential {
            host: "*.example.com:2222".into(),
            username: Some("deploy".into()),
            private_key: pem,
            passphrase: None,
        }];
        let proxy = SshProxy::new(&cfg, Arc::new(NoSshHooks)).unwrap();
        let t = proxy.target_for(&meta(Some("git.example.com"), 2222)).unwrap();
        assert_eq!(t.credential, Some(0));
        // allowlisted but no credential and no agent: denied
        assert!(proxy.target_for(&meta(Some("github.com"), 22)).is_none());
    }

    #[test]
    fn config_errors_match_node() {
        let kh = known_hosts_file();
        let mut cfg = config(&["github.com"], &kh);
        cfg.agent = None;
        assert_eq!(
            SshProxy::new(&cfg, Arc::new(NoSshHooks)).unwrap_err().0,
            "ssh egress requires at least one credential or ssh agent (direct ssh is not supported)"
        );
        let mut cfg = config(&["github.com"], &kh);
        cfg.known_hosts_files = vec!["/nonexistent/kh".into()];
        assert_eq!(
            SshProxy::new(&cfg, Arc::new(NoSshHooks)).unwrap_err().0,
            "ssh egress requires ssh.hostVerifier to validate upstream host keys (failed to load known_hosts: no OpenSSH known_hosts files found (tried /nonexistent/kh))"
        );
        // a controller hostVerifier replaces known_hosts
        cfg.host_verifier_hook = true;
        assert!(SshProxy::new(&cfg, Arc::new(NoSshHooks)).is_ok());

        for (field, msg) in [
            (0, "ssh.maxUpstreamConnectionsPerTcpSession must be an integer > 0"),
            (1, "ssh.maxUpstreamConnectionsTotal must be an integer > 0"),
            (2, "ssh.upstreamReadyTimeoutMs must be an integer > 0"),
        ] {
            let mut cfg = config(&["github.com"], &kh);
            match field {
                0 => cfg.max_upstream_connections_per_flow = 0,
                1 => cfg.max_upstream_connections_total = 0,
                _ => cfg.upstream_ready_timeout_ms = 0,
            }
            assert_eq!(SshProxy::new(&cfg, Arc::new(NoSshHooks)).unwrap_err().0, msg);
        }

        let mut cfg = config(&["github.com"], &kh);
        cfg.credentials = vec![SshCredential {
            host: "github.com".into(),
            private_key: "not a key".into(),
            ..Default::default()
        }];
        assert!(
            SshProxy::new(&cfg, Arc::new(NoSshHooks))
                .unwrap_err()
                .0
                .starts_with("invalid ssh credential for github.com")
        );

        // disabled: no validation of auth, never matches
        let proxy = SshProxy::new(&SshEgressConfig::default(), Arc::new(NoSshHooks)).unwrap();
        assert!(!proxy.enabled());
        assert!(proxy.target_for(&meta(Some("github.com"), 22)).is_none());
    }

    #[test]
    fn dns_requirements() {
        let mut dns = DnsConfig::default();
        assert_eq!(
            check_dns(&dns).unwrap_err().0,
            "ssh egress requires dns syntheticHostMapping='per-host'"
        );
        dns.synthetic_host_mapping = SyntheticHostMapping::PerHost;
        assert!(check_dns(&dns).is_ok());
        dns.mode = DnsMode::Trusted;
        assert_eq!(check_dns(&dns).unwrap_err().0, "ssh egress requires dns mode 'synthetic'");
    }
}

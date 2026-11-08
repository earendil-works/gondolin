//! Policy evaluation: declarative rules (tier 1) combined with registered
//! hooks, request policy, destination ip policy and host resolution
//! (ports of `createHttpHooks().isIpAllowed`, `ensureRequestAllowed`,
//! `resolveHostname` and the default internal-range policy).

use gondolin_proto::net::{HookRegistrations, NetPolicy};
use std::io;
use std::net::IpAddr;
use std::sync::{Arc, RwLock};

use crate::error::{Blocked, PipelineError};
use crate::hooks::{HookBackend, HookError, IpAllowInfo, RequestHead};
use crate::ip::{is_internal_ip, parse_ip};
use crate::patterns::matches_any_host;

/// Host name resolution (`dns.lookup(host, { all: true, verbatim: true })`).
pub trait Resolver: Send + Sync + 'static {
    fn lookup<'a>(&'a self, host: &'a str) -> crate::BoxFuture<'a, io::Result<Vec<IpAddr>>>;
}

/// Resolves with the system resolver (`getaddrinfo`).
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn lookup<'a>(&'a self, host: &'a str) -> crate::BoxFuture<'a, io::Result<Vec<IpAddr>>> {
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((host, 0)).await?;
            let mut out: Vec<IpAddr> = Vec::new();
            for addr in addrs {
                if !out.contains(&addr.ip()) {
                    out.push(addr.ip());
                }
            }
            Ok(out)
        })
    }
}

/// Successful lookups of `R` reused for a short time. The system resolver
/// costs ~0.2 ms per call on macOS (mDNSResponder IPC), paid by every
/// request's policy check. Reusing the answer also keeps the policy check and
/// the upstream connect on the same addresses.
pub struct CachingResolver<R> {
    inner: R,
    ttl: std::time::Duration,
    entries: std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Vec<IpAddr>)>>,
}

/// Lifetime of a cached answer.
const RESOLVER_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(2);
/// Hosts kept at most; the cache is cleared when full.
const RESOLVER_CACHE_MAX: usize = 1024;

impl<R: Resolver> CachingResolver<R> {
    pub fn new(inner: R) -> Self {
        Self::with_ttl(inner, RESOLVER_CACHE_TTL)
    }

    pub fn with_ttl(inner: R, ttl: std::time::Duration) -> Self {
        Self { inner, ttl, entries: Default::default() }
    }
}

impl<R: Resolver> Resolver for CachingResolver<R> {
    fn lookup<'a>(&'a self, host: &'a str) -> crate::BoxFuture<'a, io::Result<Vec<IpAddr>>> {
        Box::pin(async move {
            let now = std::time::Instant::now();
            if let Some((at, ips)) = self.entries.lock().unwrap().get(host)
                && now.duration_since(*at) < self.ttl
            {
                return Ok(ips.clone());
            }
            let ips = self.inner.lookup(host).await?;
            if !ips.is_empty() {
                let mut entries = self.entries.lock().unwrap();
                if entries.len() >= RESOLVER_CACHE_MAX {
                    entries.clear();
                }
                entries.insert(host.to_string(), (std::time::Instant::now(), ips.clone()));
            }
            Ok(ips)
        })
    }
}

/// Strips the brackets of an IPv6 URL host (`[::1]`).
pub fn bare_host(host: &str) -> &str {
    host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host)
}

/// Current policy, hooks and resolver; shared by the pipeline and the
/// upstream connector.
pub struct PolicyEngine {
    policy: RwLock<Arc<NetPolicy>>,
    hooks: Arc<dyn HookBackend>,
    resolver: Arc<dyn Resolver>,
}

impl PolicyEngine {
    pub fn new(
        policy: NetPolicy,
        hooks: Arc<dyn HookBackend>,
        resolver: Arc<dyn Resolver>,
    ) -> Self {
        Self { policy: RwLock::new(Arc::new(policy)), hooks, resolver }
    }

    pub fn policy(&self) -> Arc<NetPolicy> {
        self.policy.read().unwrap().clone()
    }

    pub fn set_policy(&self, policy: NetPolicy) {
        *self.policy.write().unwrap() = Arc::new(policy);
    }

    pub fn hooks(&self) -> &Arc<dyn HookBackend> {
        &self.hooks
    }

    pub fn registrations(&self) -> HookRegistrations {
        self.hooks.registrations()
    }

    /// Whether a lookup of `hostname` may start before the request hooks ran:
    /// only for hosts the declarative allowlist admits anyway, so no lookup
    /// happens that the node engine would not do.
    pub fn may_prefetch_lookup(&self, hostname: &str) -> bool {
        match &self.policy().rules {
            Some(rules) => matches_any_host(hostname, &rules.allowed_hosts),
            None => true,
        }
    }

    /// Whether the built-in internal-range policy is in effect (no rules, no
    /// `is_ip_allowed` hook).
    pub fn is_default_ip_policy(&self) -> bool {
        self.policy().rules.is_none() && !self.registrations().is_ip_allowed
    }

    /// `isRequestAllowed` on a head (no-op without a registered hook).
    pub async fn ensure_request_allowed(&self, head: &RequestHead) -> Result<(), PipelineError> {
        if !self.registrations().is_request_allowed {
            return Ok(());
        }
        match self.hooks.is_request_allowed(head).await {
            Ok(true) => Ok(()),
            Ok(false) => Err(Blocked::forbidden("blocked by request policy").into()),
            Err(HookError::Blocked(b)) => Err(b.into()),
            Err(HookError::Failed(msg)) => Err(PipelineError::Other(msg)),
        }
    }

    /// Destination ip policy: declarative allowlist + internal ranges, then the
    /// `is_ip_allowed` hook; without rules either the hook or the default policy.
    pub async fn is_ip_allowed(&self, info: &IpAllowInfo) -> Result<bool, HookError> {
        let policy = self.policy();
        let regs = self.registrations();
        match &policy.rules {
            Some(rules) => {
                if !matches_any_host(&info.hostname, &rules.allowed_hosts) {
                    return Ok(false);
                }
                if rules.block_internal_ranges
                    && is_internal_ip(info.ip)
                    && !matches_any_host(&info.hostname, &rules.allowed_internal_hosts)
                {
                    return Ok(false);
                }
                if regs.is_ip_allowed {
                    return self.hooks.is_ip_allowed(info).await;
                }
                Ok(true)
            }
            None if regs.is_ip_allowed => self.hooks.is_ip_allowed(info).await,
            None => Ok(!is_internal_ip(info.ip)),
        }
    }

    /// Resolves `hostname` (URL host, IPv6 brackets allowed).
    pub async fn lookup(&self, hostname: &str) -> Result<Vec<IpAddr>, Blocked> {
        let host = bare_host(hostname);
        if let Some(ip) = parse_ip(host) {
            return Ok(vec![ip]);
        }
        match self.resolver.lookup(host).await {
            Ok(ips) if !ips.is_empty() => Ok(ips),
            Ok(_) => Err(dns_failed(hostname, "no addresses")),
            Err(err) => {
                gondolin_log::debug!(target: "gondolin::egress", "http dns lookup failed {hostname} ({err})");
                Err(dns_failed(hostname, lookup_code(&err)))
            }
        }
    }

    /// Resolves and returns the addresses allowed by policy, in resolver order.
    pub async fn allowed_addresses(
        &self,
        hostname: &str,
        protocol: &'static str,
        port: u16,
    ) -> Result<Vec<IpAddr>, PipelineError> {
        let ips = self.lookup(hostname).await?;
        let mut allowed = Vec::new();
        for ip in &ips {
            let info = IpAllowInfo { hostname: hostname.to_string(), ip: *ip, port, protocol };
            match self.is_ip_allowed(&info).await {
                Ok(true) => allowed.push(*ip),
                Ok(false) => {}
                Err(HookError::Blocked(b)) => return Err(b.into()),
                Err(HookError::Failed(msg)) => return Err(PipelineError::Other(msg)),
            }
        }
        Ok(allowed)
    }

    /// `resolveHostname` with policy: the first allowed address.
    pub async fn resolve_allowed(
        &self,
        hostname: &str,
        protocol: &'static str,
        port: u16,
    ) -> Result<IpAddr, PipelineError> {
        let ips = self.lookup(hostname).await;
        self.resolve_allowed_from(hostname, protocol, port, ips).await
    }

    /// [`PolicyEngine::resolve_allowed`] with a lookup result obtained earlier
    /// (speculatively, while a request hook ran).
    pub async fn resolve_allowed_from(
        &self,
        hostname: &str,
        protocol: &'static str,
        port: u16,
        ips: Result<Vec<IpAddr>, Blocked>,
    ) -> Result<IpAddr, PipelineError> {
        let ips = ips?;
        for ip in &ips {
            let info = IpAllowInfo { hostname: hostname.to_string(), ip: *ip, port, protocol };
            match self.is_ip_allowed(&info).await {
                Ok(true) => return Ok(*ip),
                Ok(false) => {}
                Err(HookError::Blocked(b)) => return Err(b.into()),
                Err(HookError::Failed(msg)) => return Err(PipelineError::Other(msg)),
            }
        }
        let is_default = self.is_default_ip_policy();
        gondolin_log::debug!(
            target: "gondolin::egress",
            "http ip policy blocked {hostname}{}",
            if is_default { " by default internal-range policy" } else { "" }
        );
        // never echo resolved addresses to the guest
        Err(Blocked::forbidden(if is_default {
            format!(
                "blocked by policy: {hostname} (internal address; provide httpHooks.isIpAllowed to allow)"
            )
        } else {
            format!("blocked by policy: {hostname}")
        })
        .into())
    }
}

fn dns_failed(hostname: &str, code: &str) -> Blocked {
    Blocked::bad_gateway(format!("host dns lookup failed for {hostname} ({code})"))
}

fn lookup_code(err: &io::Error) -> &'static str {
    match err.kind() {
        io::ErrorKind::TimedOut => "ETIMEOUT",
        io::ErrorKind::NotFound => "ENOTFOUND",
        _ => "ENOTFOUND",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::NoHooks;
    use gondolin_proto::net::HttpRules;

    struct Static(Vec<IpAddr>);

    impl Resolver for Static {
        fn lookup<'a>(&'a self, _host: &'a str) -> crate::BoxFuture<'a, io::Result<Vec<IpAddr>>> {
            Box::pin(async move { Ok(self.0.clone()) })
        }
    }

    /// Counts lookups; fails for `fail.test`.
    struct Counting(std::sync::atomic::AtomicUsize);

    impl Resolver for Counting {
        fn lookup<'a>(&'a self, host: &'a str) -> crate::BoxFuture<'a, io::Result<Vec<IpAddr>>> {
            Box::pin(async move {
                let n = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) as u8;
                if host == "fail.test" {
                    return Err(io::Error::other("nope"));
                }
                Ok(vec![IpAddr::from([192, 0, 2, n])])
            })
        }
    }

    #[tokio::test]
    async fn caching_resolver_reuses_answers_until_ttl() {
        // a TTL no slow (emulated) test run reaches
        let r = CachingResolver::with_ttl(
            Counting(Default::default()),
            std::time::Duration::from_secs(3600),
        );
        let first = r.lookup("a.test").await.unwrap();
        assert_eq!(r.lookup("a.test").await.unwrap(), first);
        assert_ne!(r.lookup("b.test").await.unwrap(), first);
        // failures are not cached
        assert!(r.lookup("fail.test").await.is_err());
        assert!(r.lookup("fail.test").await.is_err());
        assert_eq!(r.inner.0.load(std::sync::atomic::Ordering::SeqCst), 4);

        // expired answers are looked up again
        let r = CachingResolver::with_ttl(
            Counting(Default::default()),
            std::time::Duration::from_millis(10),
        );
        let first = r.lookup("a.test").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_ne!(r.lookup("a.test").await.unwrap(), first);
    }

    fn info(hostname: &str, ip: &str) -> IpAllowInfo {
        IpAllowInfo {
            hostname: hostname.into(),
            ip: ip.parse().unwrap(),
            port: 443,
            protocol: "https",
        }
    }

    fn engine(rules: Option<HttpRules>) -> PolicyEngine {
        PolicyEngine::new(
            NetPolicy { rules, allow_websockets: true },
            Arc::new(NoHooks),
            Arc::new(Static(vec!["10.0.0.1".parse().unwrap(), "203.0.113.10".parse().unwrap()])),
        )
    }

    fn rules(allowed: &[&str], internal: &[&str]) -> HttpRules {
        HttpRules {
            allowed_hosts: allowed.iter().map(|s| s.to_string()).collect(),
            allowed_internal_hosts: internal.iter().map(|s| s.to_string()).collect(),
            ..HttpRules::default()
        }
    }

    #[tokio::test]
    async fn default_policy_blocks_internal() {
        let e = engine(None);
        assert!(!e.is_ip_allowed(&info("x", "127.0.0.1")).await.unwrap());
        assert!(e.is_ip_allowed(&info("x", "8.8.8.8")).await.unwrap());
        // picks the first allowed answer
        assert_eq!(
            e.resolve_allowed("example.com", "https", 443).await.unwrap(),
            "203.0.113.10".parse::<IpAddr>().unwrap()
        );
        let err = e.resolve_allowed("127.0.0.1", "http", 80).await.unwrap_err();
        assert!(
            matches!(err, PipelineError::Blocked(b) if b.message.contains("internal address; provide httpHooks.isIpAllowed"))
        );
    }

    #[tokio::test]
    async fn declarative_rules() {
        let e = engine(Some(rules(&["*"], &["corp.example"])));
        assert!(e.is_ip_allowed(&info("corp.example", "10.1.2.3")).await.unwrap());
        assert!(!e.is_ip_allowed(&info("anything.example", "10.1.2.3")).await.unwrap());
        assert!(!e.is_ip_allowed(&info("anything.example", "::1")).await.unwrap());

        let e = engine(Some(rules(&["example.com"], &[])));
        assert!(!e.is_ip_allowed(&info("nope.com", "8.8.8.8")).await.unwrap());
        let err = e.resolve_allowed("nope.com", "https", 443).await.unwrap_err();
        assert!(
            matches!(err, PipelineError::Blocked(b) if b.message == "blocked by policy: nope.com" && b.status == 403)
        );

        let mut r = rules(&["example.com"], &[]);
        r.block_internal_ranges = false;
        let e = engine(Some(r));
        assert!(e.is_ip_allowed(&info("example.com", "10.0.0.1")).await.unwrap());

        let e = engine(Some(rules(&[], &[])));
        assert!(!e.is_ip_allowed(&info("example.com", "8.8.8.8")).await.unwrap());
    }
}

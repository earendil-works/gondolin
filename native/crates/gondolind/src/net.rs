//! Networking: wires `gondolin-netstack` (guest frames, DNS, TCP flows) to
//! `gondolin-egress` (classification, HTTP/TLS mediation, policy) and serves
//! the controller side of tier-3 hooks (`native/DESIGN.md`, "Network").
//!
//! `configure.net` with `mode: "native"` is built by [`build_native`]: the
//! session serves QEMU's stream netdev through [`NetBackend`], controller
//! messages `policy_update`, `body_pull` and `body_release` are routed here,
//! hooks go out as `hook_call` / `body_pull` / `ssh_hook_call` requests, and
//! open guest flows are reported as activity (no idle pause while connected).

use std::net::Ipv4Addr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use gondolin_egress::{ControllerLink, Egress, RemoteHooks};
use gondolin_netstack::{FlowHandler, NetStack, TcpFlow};
use gondolin_proto::net::{
    self as proto, BodyChunk, BodyPull, BodyRelease, HookCall, HookDecision, PolicyUpdate,
};
use gondolin_wire::{Value, from_value, to_value};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::UnixStream;

use crate::controller::{CallError, Controller, ControllerHandler};
use crate::session::ActivityHandle;
use crate::subsystem::{NetBackend, NetSetup, SubsystemContext};

/// `configure.net`: egress fields at the top level, the stack under `stack`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConfigureNet {
    /// policy, hook registrations, HTTP limits, MITM CA, `tcp_hosts`, `ssh`, upstream trust
    #[serde(flatten)]
    pub egress: proto::NetConfig,
    /// addresses, DNS (already resolved by the controller: per-host mapping
    /// auto default, trusted servers) and stack limits
    #[serde(default)]
    pub stack: gondolin_netstack::NetConfig,
    /// IPv4 resolvers standing in for the daemon host's (`trusted` default and
    /// `open` DHCP advertisement); the controller sends `dns.getServers()` when
    /// the daemon runs locally, absent: the daemon's `/etc/resolv.conf`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_resolvers: Option<Vec<String>>,
    /// daemon-side MITM CA directory used when `mitm` is absent (remote
    /// controllers); absent: `<cache>/gondolin/ssl` like the node engine
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mitm_dir: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum NetError {
    #[error(transparent)]
    Stack(#[from] gondolin_netstack::NetStackError),
    #[error(transparent)]
    Egress(#[from] gondolin_egress::EgressError),
    #[error(transparent)]
    Ssh(#[from] gondolin_sshproxy::SshConfigError),
}

/// Daemon→controller requests, provided by the dispatcher.
#[async_trait]
pub trait ControllerRequests: Send + Sync + 'static {
    /// Sends request `t` and returns the payload of its `<t>_result` (with
    /// `ok: true`); `Err` carries the failure message (`ok: false` or transport).
    async fn request(&self, t: &'static str, payload: Value) -> Result<Value, String>;
    /// Sends a message that has no reply.
    fn notify(&self, t: &'static str, payload: Value);
}

struct Link<R>(Arc<R>);

#[async_trait]
impl<R: ControllerRequests> ControllerLink for Link<R> {
    async fn hook_call(&self, call: HookCall) -> Result<HookDecision, String> {
        let payload = to_value(&call).map_err(|e| e.to_string())?;
        let result = self.0.request(proto::types::HOOK_CALL, payload).await?;
        from_value(result).map_err(|e| format!("invalid hook_call_result: {e}"))
    }

    async fn body_pull(&self, pull: BodyPull) -> Result<BodyChunk, String> {
        let payload = to_value(&pull).map_err(|e| e.to_string())?;
        let result = self.0.request(proto::types::BODY_PULL, payload).await?;
        from_value(result).map_err(|e| format!("invalid body_pull_result: {e}"))
    }

    fn body_release(&self, stream: u64) {
        if let Ok(payload) = to_value(&BodyRelease { stream }) {
            self.0.notify(proto::types::BODY_RELEASE, payload);
        }
    }
}

/// `ssh.execPolicy` / `ssh.hostVerifier` as `ssh_hook_call` requests.
struct ControllerSshHooks<R>(Arc<R>);

#[async_trait]
impl<R: ControllerRequests> gondolin_sshproxy::SshHooks for ControllerSshHooks<R> {
    async fn ssh_hook_call(
        &self,
        call: gondolin_sshproxy::SshHookCall,
    ) -> Result<gondolin_sshproxy::SshHookResult, String> {
        let payload = to_value(&call).map_err(|e| e.to_string())?;
        let result = self.0.request(proto::types::SSH_HOOK_CALL, payload).await?;
        from_value(result).map_err(|e| format!("invalid ssh_hook_call_result: {e}"))
    }
}

/// Counts open guest flows and reports them as session activity (the node
/// engine's `hasActiveGuestActivity`).
struct ActivityFlows {
    inner: Egress,
    open: AtomicUsize,
    activity: Option<ActivityHandle>,
}

struct FlowGuard<'a>(&'a ActivityFlows);

impl Drop for FlowGuard<'_> {
    fn drop(&mut self) {
        if self.0.open.fetch_sub(1, Ordering::SeqCst) == 1
            && let Some(activity) = &self.0.activity
        {
            activity.set("net", false);
        }
    }
}

#[async_trait]
impl FlowHandler for ActivityFlows {
    async fn handle_tcp(&self, flow: TcpFlow) {
        if self.open.fetch_add(1, Ordering::SeqCst) == 0
            && let Some(activity) = &self.activity
        {
            activity.set("net", true);
        }
        let _guard = FlowGuard(self);
        if flow.meta.dst.port() == 9 {
            crate::panics::test_panic(crate::panics::TestPanic::Flow);
        }
        self.inner.handle_tcp(flow).await;
    }
}

/// Network side of a session.
pub struct Net {
    stack: Arc<NetStack>,
    egress: Egress,
    hooks: Arc<RemoteHooks>,
}

impl Net {
    pub fn new<R: ControllerRequests>(
        config: ConfigureNet,
        controller: Arc<R>,
    ) -> Result<Self, NetError> {
        Self::with_activity(config, controller, None)
    }

    /// Like [`Net::new`], reporting open flows to `activity`.
    pub fn with_activity<R: ControllerRequests>(
        config: ConfigureNet,
        controller: Arc<R>,
        activity: Option<ActivityHandle>,
    ) -> Result<Self, NetError> {
        let ssh = match &config.egress.ssh {
            Some(ssh) => {
                let proxy = gondolin_sshproxy::SshProxy::new(
                    ssh,
                    Arc::new(ControllerSshHooks(controller.clone())),
                )?;
                if proxy.enabled() {
                    gondolin_sshproxy::check_dns(&config.stack.dns)?;
                }
                Some(proxy)
            }
            None => None,
        };
        let hooks =
            Arc::new(RemoteHooks::new(Arc::new(Link(controller)), config.egress.hooks.clone()));
        let egress = Egress::new(config.egress, hooks.clone())?.with_ssh_proxy(ssh);
        let handler =
            Arc::new(ActivityFlows { inner: egress.clone(), open: AtomicUsize::new(0), activity });
        let stack = match config.system_resolvers {
            Some(list) => {
                let resolvers = list
                    .iter()
                    .filter_map(|s| s.split('%').next()?.parse::<Ipv4Addr>().ok())
                    .collect();
                NetStack::with_system_resolvers(config.stack, handler, resolvers)?
            }
            None => NetStack::new(config.stack, handler)?,
        };
        Ok(Self { stack: Arc::new(stack), egress, hooks })
    }

    /// Serves QEMU's stream netdev until it closes.
    pub async fn serve<S>(&self, netdev: S) -> std::io::Result<()>
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        self.stack.serve(netdev).await
    }

    pub fn stack(&self) -> &Arc<NetStack> {
        &self.stack
    }

    pub fn egress(&self) -> &Egress {
        &self.egress
    }

    /// Handles a controller→daemon request of the network area. Returns `None`
    /// for message types this module does not own; otherwise the `<t>_result`
    /// payload (without `ok`) or an error message.
    pub async fn handle_request(&self, t: &str, payload: Value) -> Option<Result<Value, String>> {
        match t {
            proto::types::POLICY_UPDATE => Some(self.policy_update(payload)),
            proto::types::BODY_PULL => Some(self.body_pull(payload).await),
            _ => None,
        }
    }

    /// Handles a controller→daemon message without reply; returns whether it
    /// was a network message.
    pub fn handle_notification(&self, t: &str, payload: Value) -> bool {
        if t != proto::types::BODY_RELEASE {
            return false;
        }
        if let Ok(release) = from_value::<BodyRelease>(payload) {
            self.hooks.serve_body_release(release.stream);
        }
        true
    }

    fn policy_update(&self, payload: Value) -> Result<Value, String> {
        let update: PolicyUpdate =
            from_value(payload).map_err(|e| format!("invalid policy_update: {e}"))?;
        self.egress.update_policy(update.policy);
        Ok(Value::Map(Vec::new()))
    }

    async fn body_pull(&self, payload: Value) -> Result<Value, String> {
        let pull: BodyPull = from_value(payload).map_err(|e| format!("invalid body_pull: {e}"))?;
        let chunk = self.hooks.serve_body_pull(pull).await?;
        to_value(&chunk).map_err(|e| e.to_string())
    }
}

#[async_trait]
impl ControllerRequests for Controller {
    async fn request(&self, t: &'static str, payload: Value) -> Result<Value, String> {
        match Controller::request(self, t, &payload).await {
            Ok(v) => Ok(v),
            Err(CallError::Remote(e)) => Err(e.message),
            Err(e) => Err(e.to_string()),
        }
    }

    fn notify(&self, t: &'static str, payload: Value) {
        self.send(t, 0, &payload);
    }
}

#[async_trait]
impl NetBackend for Net {
    async fn serve(&self, stream: UnixStream) {
        match crate::panics::CatchUnwind::new(self.stack.serve(stream)).await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                tracing::debug!(target: "gondolin::net", "netdev connection ended: {err}");
            }
            // the stack driver owns the flow table and the smoltcp state
            // (flow handlers are contained separately): fail closed
            Err(panic) => crate::panics::fail_closed(&format!("network stack panicked: {panic}")),
        }
    }
}

/// Routes the network area's controller messages to [`Net`].
struct NetMessages(Arc<Net>);

#[async_trait]
impl ControllerHandler for NetMessages {
    async fn handle(&self, msg: gondolin_wire::RawEnvelope, ctl: &Arc<Controller>) {
        if self.0.handle_notification(&msg.t, msg.p.clone()) {
            return;
        }
        // body pulls wait for guest/upstream data: never block the reader
        let net = self.0.clone();
        let ctl = ctl.clone();
        tokio::spawn(async move {
            let t = msg.t.clone();
            let handled = crate::panics::CatchUnwind::new(net.handle_request(&t, msg.p)).await;
            let handled = match handled {
                Ok(handled) => handled,
                Err(panic) => {
                    if msg.id != 0 {
                        ctl.reply_err(
                            &msg.t,
                            msg.id,
                            "internal_error",
                            &format!("internal error: {panic}"),
                        );
                    }
                    return;
                }
            };
            match handled {
                Some(Ok(value)) => {
                    let fields = match value {
                        Value::Map(entries) => entries,
                        _ => Vec::new(),
                    };
                    if msg.id != 0 {
                        ctl.reply_ok(&msg.t, msg.id, fields);
                    }
                }
                Some(Err(message)) => {
                    if msg.id != 0 {
                        ctl.reply_err(&msg.t, msg.id, "net_error", &message);
                    }
                }
                None => {
                    if msg.id != 0 {
                        ctl.reply_err(&msg.t, msg.id, "unsupported", "unsupported message");
                    }
                }
            }
        });
    }
}

/// Builds the native network for `configure.net` with `mode: "native"`.
pub fn build_native(config: &Value, ctx: &SubsystemContext) -> Result<NetSetup, String> {
    if ctx.debug_enabled("net") {
        crate::netlog::install(ctx.ctl.clone());
    }
    let mut config: ConfigureNet =
        from_value(config.clone()).map_err(|e| format!("invalid net configuration: {e}"))?;
    if config.egress.mitm.is_none() {
        // no CA from the controller: the daemon's own cache (`mitm_ca` request)
        let dir = config
            .mitm_dir
            .as_deref()
            .filter(|d| !d.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(crate::mitm_ca::default_dir);
        // RSA key generation can take a moment: keep the runtime responsive
        let ca = match tokio::runtime::Handle::try_current() {
            Ok(h) if h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                tokio::task::block_in_place(|| crate::mitm_ca::load_or_create(&dir))
            }
            _ => crate::mitm_ca::load_or_create(&dir),
        }?;
        config.egress.mitm =
            Some(proto::MitmCaConfig { cert_pem: ca.cert_pem, key_pem: ca.key_pem });
    }
    let net = Arc::new(
        Net::with_activity(config, ctx.ctl.clone(), Some(ctx.activity.clone()))
            .map_err(|e| e.to_string())?,
    );
    let messages = Arc::new(NetMessages(net.clone()));
    for t in [proto::types::POLICY_UPDATE, proto::types::BODY_PULL, proto::types::BODY_RELEASE] {
        ctx.dispatcher.register(t, messages.clone());
    }
    Ok(NetSetup::Native(net))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct Fake {
        requests: Mutex<Vec<(&'static str, Value)>>,
        notes: Mutex<Vec<&'static str>>,
    }

    #[async_trait]
    impl ControllerRequests for Fake {
        async fn request(&self, t: &'static str, payload: Value) -> Result<Value, String> {
            self.requests.lock().unwrap().push((t, payload));
            // `hook_call_result` with `ok` next to the decision fields
            Ok(Value::Map(vec![
                (Value::Text("ok".into()), Value::Bool(true)),
                (Value::Text("action".into()), Value::Text("allowed".into())),
                (Value::Text("allowed".into()), Value::Bool(false)),
            ]))
        }

        fn notify(&self, t: &'static str, _payload: Value) {
            self.notes.lock().unwrap().push(t);
        }
    }

    fn decode_config(value: serde_json::Value) -> ConfigureNet {
        let bytes = gondolin_wire::encode(&value).unwrap();
        gondolin_wire::decode(&bytes).unwrap()
    }

    #[test]
    fn configure_net_shape() {
        let cfg = decode_config(serde_json::json!({
            "policy": { "allow_websockets": false, "rules": { "allowed_hosts": ["example.com"] } },
            "hooks": { "is_ip_allowed": true },
            "limits": { "max_request_body_bytes": 10 },
            "stack": { "dns": { "mode": "trusted", "synthetic_host_mapping": "per-host" } },
            "system_resolvers": ["10.0.0.53", "fe80::1%en0"],
        }));
        assert!(!cfg.egress.policy.allow_websockets);
        assert_eq!(cfg.egress.policy.rules.unwrap().allowed_hosts, vec!["example.com"]);
        assert!(cfg.egress.hooks.is_ip_allowed);
        assert_eq!(cfg.egress.limits.max_request_body_bytes, 10);
        assert_eq!(cfg.stack.dns.mode, gondolin_netstack::DnsMode::Trusted);
        assert_eq!(cfg.system_resolvers.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn builds_and_routes_messages() {
        let cfg = decode_config(serde_json::json!({
            "hooks": { "is_request_allowed": true },
            "system_resolvers": ["10.0.0.53"],
            "stack": { "dns": { "mode": "trusted" } },
        }));
        let fake = Arc::new(Fake::default());
        let net = Net::new(cfg, fake.clone()).unwrap();

        // policy_update replaces the policy
        let update = to_value(&PolicyUpdate {
            policy: proto::NetPolicy { rules: None, allow_websockets: false },
        })
        .unwrap();
        assert!(net.handle_request("policy_update", update).await.unwrap().is_ok());
        assert!(!net.egress().policy().allow_websockets);

        // unknown daemon stream
        let pull = to_value(&BodyPull { stream: 99, max: 10, offset: None }).unwrap();
        assert!(net.handle_request("body_pull", pull).await.unwrap().is_err());
        assert!(net.handle_request("exec", Value::Null).await.is_none());

        // hook calls go through the controller and decode with `ok` present
        let link = Link(fake.clone());
        let decision = link
            .hook_call(HookCall {
                phase: proto::HookPhase::IsRequestAllowed,
                request: None,
                response: None,
                ip: None,
            })
            .await
            .unwrap();
        assert_eq!(decision, HookDecision::Allowed { allowed: false });
        assert_eq!(fake.requests.lock().unwrap()[0].0, "hook_call");
    }

    #[test]
    fn ssh_requires_per_host_dns() {
        let ssh = serde_json::json!({
            "allowed_hosts": ["github.com"],
            "agent": "/tmp/agent.sock",
            "host_verifier_hook": true,
        });
        let cfg = decode_config(serde_json::json!({ "ssh": ssh.clone() }));
        let res = Net::new(cfg, Arc::new(Fake::default()));
        assert!(matches!(res, Err(NetError::Ssh(_))), "{:?}", res.err());
        let cfg = decode_config(serde_json::json!({
            "ssh": ssh,
            "stack": { "dns": { "synthetic_host_mapping": "per-host" } },
        }));
        assert!(Net::new(cfg, Arc::new(Fake::default())).is_ok());
    }

    #[test]
    fn trusted_mode_without_resolvers_fails_fast() {
        let cfg = decode_config(serde_json::json!({
            "system_resolvers": [],
            "stack": { "dns": { "mode": "trusted" } },
        }));
        assert!(matches!(
            Net::new(cfg, Arc::new(Fake::default())),
            Err(NetError::Stack(gondolin_netstack::NetStackError::NoTrustedResolvers))
        ));
    }
}

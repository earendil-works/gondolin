//! egress: a guest TCP flow with arbitrary bytes (classification, HTTP/1.x
//! request heads and bodies through hyper, the request pipeline with secrets
//! and a body-pulling `on_request` hook, TLS ClientHello sniffing / MITM
//! accept). Upstream resolution always fails, so nothing leaves the process.
#![no_main]

use gondolin_egress::{
    BodyChoice, BodyHandle, Egress, HookBackend, HookError, RequestDecision, RequestHead, Resolver,
};
use gondolin_netstack::{FlowHandler, FlowMeta, TcpFlow};
use gondolin_proto::net::{
    BodyHookRegistration, HookRegistrations, HttpRules, MitmCaConfig, NetConfig, NetPolicy,
    SecretRule, SshEgressConfig,
};
use libfuzzer_sys::fuzz_target;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Raw input: 4 control bytes (port selector, flags, pull count, chunk size)
/// followed by the guest's bytes, so seeds can be plain HTTP requests.
struct Input {
    port: u8,
    hooks: bool,
    pull: u8,
    replace_body: bool,
    chunks: Vec<Vec<u8>>,
}

impl Input {
    fn parse(data: &[u8]) -> Option<Input> {
        let (ctl, rest) = data.split_at_checked(4)?;
        let chunk = usize::from(ctl[3]) * 8 + 1;
        Some(Input {
            port: ctl[0],
            hooks: ctl[1] & 1 != 0,
            replace_body: ctl[1] & 2 != 0,
            pull: ctl[2],
            chunks: rest.chunks(chunk).map(<[u8]>::to_vec).collect(),
        })
    }
}

struct NoDns;

impl Resolver for NoDns {
    fn lookup<'a>(
        &'a self,
        _host: &'a str,
    ) -> gondolin_egress::BoxFuture<'a, io::Result<Vec<IpAddr>>> {
        Box::pin(async move { Err(io::Error::new(io::ErrorKind::NotFound, "fuzz")) })
    }
}

struct Hooks {
    pull: u8,
    replace_body: bool,
}

impl HookBackend for Hooks {
    fn registrations(&self) -> HookRegistrations {
        HookRegistrations {
            is_request_allowed: true,
            is_ip_allowed: true,
            on_request: Some(BodyHookRegistration { body: true }),
            on_response: Some(BodyHookRegistration { body: true }),
        }
    }

    fn on_request<'a>(
        &'a self,
        request: RequestHead,
        body: Option<BodyHandle>,
    ) -> gondolin_egress::BoxFuture<'a, Result<RequestDecision, HookError>> {
        Box::pin(async move {
            if let Some(body) = body {
                for i in 0..self.pull % 8 {
                    match body.pull_at(u64::from(i) * 7, 1 + usize::from(self.pull)).await {
                        Ok(Some(_)) => {}
                        _ => break,
                    }
                    let _ = body.pull(usize::from(self.pull) + 1).await;
                }
            }
            if self.replace_body {
                return Ok(RequestDecision::Request {
                    head: request,
                    body: BodyChoice::Body(gondolin_egress::full_body("replaced")),
                });
            }
            Ok(RequestDecision::Continue)
        })
    }
}

fn ca() -> &'static MitmCaConfig {
    static CA: OnceLock<MitmCaConfig> = OnceLock::new();
    CA.get_or_init(|| {
        let ca = gondolind::mitm_ca::generate().unwrap();
        MitmCaConfig { cert_pem: ca.cert_pem, key_pem: ca.key_pem }
    })
}

fn config() -> NetConfig {
    let marker = "ab".repeat(24);
    NetConfig {
        policy: NetPolicy {
            rules: Some(HttpRules {
                allowed_hosts: vec!["*.example".into(), "a*b".into()],
                marker: Some(marker.clone()),
                replace_secrets_in_query: true,
                secrets: vec![SecretRule {
                    name: "TOKEN".into(),
                    identifier: "token".into(),
                    placeholder: format!("{marker}.token"),
                    value: "s3cret".into(),
                    revoked_values: vec!["old".into()],
                    hosts: vec!["api.example".into()],
                    deleted: false,
                }],
                ..HttpRules::default()
            }),
            allow_websockets: true,
        },
        mitm: Some(ca().clone()),
        ssh: Some(SshEgressConfig { ports: vec![22], ..Default::default() }),
        use_system_roots: false,
        use_webpki_roots: false,
        ..NetConfig::default()
    }
}

fuzz_target!(|data: &[u8]| {
    let Some(input) = Input::parse(data) else { return };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async move {
        let hooks: Arc<dyn HookBackend> = if input.hooks {
            Arc::new(Hooks { pull: input.pull, replace_body: input.replace_body })
        } else {
            Arc::new(gondolin_egress::NoHooks)
        };
        let egress = Egress::with_resolver(config(), hooks, Arc::new(NoDns)).unwrap();
        let port = [80, 443, 22, 8080][usize::from(input.port % 4)];
        let (mut guest, host) = tokio::io::duplex(1 << 20);
        let flow = TcpFlow::new(
            FlowMeta {
                id: 1,
                src: "192.168.127.3:40000".parse().unwrap(),
                dst: SocketAddr::new("192.0.2.1".parse().unwrap(), port),
                synthetic_hostname: None,
            },
            host,
        );
        let task = tokio::spawn(async move { egress.handle_tcp(flow).await });
        let run = async {
            for chunk in input.chunks.iter().take(32) {
                if guest.write_all(chunk).await.is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
            let _ = guest.shutdown().await;
            let mut out = Vec::new();
            let _ = guest.read_to_end(&mut out).await;
        };
        tokio::time::timeout(Duration::from_secs(20), run).await.expect("egress flow hung");
        tokio::time::timeout(Duration::from_secs(20), task)
            .await
            .expect("egress handler did not finish")
            .ok();
    });
});

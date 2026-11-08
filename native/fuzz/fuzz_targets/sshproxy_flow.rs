//! sshproxy: arbitrary guest bytes on an SSH-classified flow (banner, packet
//! framing, key exchange messages of the guest-facing SSH server). The
//! upstream can never be reached (agent socket missing, no host verifier).
#![no_main]

use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use gondolin_netstack::{FlowMeta, TcpFlow};
use gondolin_proto::net::SshEgressConfig;
use gondolin_sshproxy::{NoSshHooks, SshProxy};
use libfuzzer_sys::fuzz_target;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn proxy() -> &'static SshProxy {
    static PROXY: OnceLock<SshProxy> = OnceLock::new();
    PROXY.get_or_init(|| {
        SshProxy::new(
            &SshEgressConfig {
                allowed_hosts: vec!["git.test".into()],
                agent: Some("/nonexistent/gondolin-fuzz-agent.sock".into()),
                host_verifier_hook: true,
                upstream_ready_timeout_ms: 200,
                ..Default::default()
            },
            Arc::new(NoSshHooks),
        )
        .unwrap()
    })
}

fuzz_target!(|chunks: Vec<Vec<u8>>| {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async move {
        let meta = FlowMeta {
            id: 1,
            src: "192.168.127.3:40000".parse().unwrap(),
            dst: SocketAddr::new("198.19.0.1".parse().unwrap(), 22),
            synthetic_hostname: Some("git.test".into()),
        };
        let proxy = proxy().clone();
        let target = proxy.target_for(&meta).expect("allowlisted");
        let (mut guest, host) = tokio::io::duplex(1 << 20);
        let task =
            tokio::spawn(async move { proxy.handle(TcpFlow::new(meta, host), target).await });
        let run = async {
            let mut first = true;
            for chunk in chunks.iter().take(32) {
                // most inputs should get past the banner
                if first {
                    first = false;
                    let _ = guest.write_all(b"SSH-2.0-fuzz\r\n").await;
                }
                if guest.write_all(chunk).await.is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
            let _ = guest.shutdown().await;
            let mut out = Vec::new();
            let _ = guest.read_to_end(&mut out).await;
        };
        tokio::time::timeout(Duration::from_secs(20), run).await.expect("ssh flow hung");
        tokio::time::timeout(Duration::from_secs(20), task)
            .await
            .expect("ssh handler did not finish")
            .ok();
    });
});

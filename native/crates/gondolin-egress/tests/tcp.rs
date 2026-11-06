mod common;

use std::net::SocketAddr;
use std::sync::Arc;

use common::*;
use gondolin_egress::NoHooks;
use gondolin_netstack::{FlowControl, FlowHandler, FlowMeta, TcpFlow};
use gondolin_proto::net::TcpHostMapping;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn mapped_tcp_hosts_are_tunneled_raw() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 4];
        s.read_exact(&mut buf).await.unwrap();
        s.write_all(b"pong").await.unwrap();
    });
    let mut cfg = config(None, None);
    cfg.tcp_hosts = vec![
        TcpHostMapping {
            host: "db.internal".into(),
            port: Some(5432),
            upstream_host: "127.0.0.1".into(),
            upstream_port: port,
        },
        TcpHostMapping {
            host: "db.internal".into(),
            port: None,
            upstream_host: "127.0.0.1".into(),
            upstream_port: 1,
        },
    ];
    let h = Harness::new(cfg, Arc::new(NoHooks));
    let (mut guest, host) = tokio::io::duplex(4096);
    let flow = TcpFlow {
        meta: FlowMeta {
            id: 7,
            src: "192.168.127.3:1234".parse().unwrap(),
            dst: SocketAddr::new("198.18.0.5".parse().unwrap(), 5432),
            synthetic_hostname: Some("DB.internal".into()),
        },
        stream: Box::pin(host),
        control: FlowControl::detached(),
    };
    let egress = h.egress.clone();
    tokio::spawn(async move { egress.handle_tcp(flow).await });
    // raw bytes that would never classify as HTTP/TLS
    guest.write_all(b"\x00\x01\x02\x03").await.unwrap();
    let mut buf = [0u8; 4];
    guest.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"pong");
}

#[tokio::test]
async fn ssh_flows_are_handed_to_the_proxy() {
    let proxy = gondolin_sshproxy::SshProxy::new(
        &gondolin_proto::net::SshEgressConfig {
            allowed_hosts: vec!["git.test".into()],
            agent: Some("/nonexistent/agent.sock".into()),
            host_verifier_hook: true,
            ..Default::default()
        },
        Arc::new(gondolin_sshproxy::NoSshHooks),
    )
    .unwrap();
    let h = Harness::new(config(None, None), Arc::new(NoHooks));
    let egress = h.egress.clone().with_ssh_proxy(Some(proxy));

    for (hostname, served) in [(Some("git.test"), true), (None, false), (Some("other.test"), false)]
    {
        let (mut guest, host) = tokio::io::duplex(64 * 1024);
        let abort = Arc::new(AbortFlag::default());
        let flow = TcpFlow {
            meta: FlowMeta {
                id: 3,
                src: "192.168.127.3:1234".parse().unwrap(),
                dst: SocketAddr::new("198.19.0.1".parse().unwrap(), 22),
                synthetic_hostname: hostname.map(str::to_string),
            },
            stream: Box::pin(host),
            control: FlowControl::new(abort.clone()),
        };
        let egress = egress.clone();
        tokio::spawn(async move { egress.handle_tcp(flow).await });
        guest.write_all(b"SSH-2.0-OpenSSH_9.9\r\n").await.unwrap();
        let mut banner = [0u8; 8];
        let read =
            tokio::time::timeout(std::time::Duration::from_secs(5), guest.read_exact(&mut banner))
                .await;
        if served {
            read.unwrap().unwrap();
            assert_eq!(&banner, b"SSH-2.0-");
        } else {
            assert!(read.unwrap().is_err(), "{hostname:?}");
            assert!(abort.0.load(std::sync::atomic::Ordering::SeqCst));
        }
    }
}

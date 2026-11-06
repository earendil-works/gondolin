//! End-to-end: a russh "guest" client talks to the proxy over an in-memory
//! flow; the proxy talks to an in-process russh upstream server.

use std::collections::HashMap;
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use gondolin_netstack::{FlowAbort, FlowControl, FlowMeta, TcpFlow};
use gondolin_sshproxy::{
    NoSshHooks, SshCredential, SshEgressConfig, SshHookCall, SshHookResult, SshHooks, SshProxy,
};
use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::{PrivateKey, PublicKey, PublicKeyOrCertificate};
use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId, ChannelMsg, Sig, client};

fn key(seed: u8) -> PrivateKey {
    PrivateKey::from(Ed25519Keypair::from_seed(&[seed; 32]))
}

// ---------------------------------------------------------------------------
// Upstream server

#[derive(Default)]
struct UpstreamLog {
    users: Vec<String>,
    commands: Vec<String>,
    connections: usize,
}

#[derive(Clone)]
struct Upstream {
    authorized: PublicKey,
    log: Arc<Mutex<UpstreamLog>>,
    /// currently open connections
    open: Arc<AtomicUsize>,
}

struct UpstreamConn {
    up: Upstream,
    cat: HashMap<ChannelId, ()>,
}

impl Drop for UpstreamConn {
    fn drop(&mut self) {
        self.up.open.fetch_sub(1, Ordering::SeqCst);
    }
}

impl server::Handler for UpstreamConn {
    type Error = russh::Error;

    async fn auth_publickey(
        &mut self,
        user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        self.up.log.lock().unwrap().users.push(user.to_string());
        if key.public_key == &self.up.authorized { Ok(Auth::Accept) } else { Ok(Auth::reject()) }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(data).into_owned();
        self.up.log.lock().unwrap().commands.push(command.clone());
        if command == "fail-exec" {
            return session.channel_failure(channel);
        }
        session.channel_success(channel)?;
        let handle = session.handle();
        let (verb, arg) = command.split_once(' ').unwrap_or((command.as_str(), ""));
        match verb {
            "echo" => {
                let out = format!("{arg}\n");
                tokio::spawn(async move {
                    let _ = handle.data(channel, out.into_bytes()).await;
                    let _ = handle.exit_status_request(channel, 0).await;
                    let _ = handle.eof(channel).await;
                    let _ = handle.close(channel).await;
                });
            }
            "stderr" => {
                let out = format!("{arg}\n");
                tokio::spawn(async move {
                    let _ = handle.extended_data(channel, 1, out.into_bytes()).await;
                    let _ = handle.exit_status_request(channel, 3).await;
                    let _ = handle.eof(channel).await;
                    let _ = handle.close(channel).await;
                });
            }
            "signal" => {
                tokio::spawn(async move {
                    let _ = handle
                        .exit_signal_request(channel, Sig::TERM, false, "killed".into(), "".into())
                        .await;
                    let _ = handle.eof(channel).await;
                    let _ = handle.close(channel).await;
                });
            }
            "cat" => {
                self.cat.insert(channel, ());
            }
            "drop" => {
                tokio::spawn(async move {
                    let _ = handle
                        .disconnect(russh::Disconnect::ByApplication, "bye".into(), "en".into())
                        .await;
                });
            }
            _ => {} // "sleep": never answers
        }
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.cat.contains_key(&channel) {
            session.data(channel, data.to_vec())?;
        }
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.cat.remove(&channel).is_some() {
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
        }
        Ok(())
    }
}

/// Starts an upstream server; returns its port and host key.
async fn start_upstream(authorized: PublicKey) -> (u16, PrivateKey, Upstream) {
    let host_key = key(7);
    let config = Arc::new(server::Config {
        keys: vec![host_key.clone()],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let up = Upstream { authorized, log: Arc::default(), open: Arc::default() };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server_up = up.clone();
    tokio::spawn(async move {
        loop {
            let (sock, _) = listener.accept().await.unwrap();
            server_up.log.lock().unwrap().connections += 1;
            server_up.open.fetch_add(1, Ordering::SeqCst);
            let conn = UpstreamConn { up: server_up.clone(), cat: HashMap::new() };
            let config = config.clone();
            tokio::spawn(async move {
                if let Ok(session) = server::run_stream(config, sock, conn).await {
                    let _ = session.await;
                }
            });
        }
    });
    (port, host_key, up)
}

// ---------------------------------------------------------------------------
// Guest client

struct GuestClient;

impl client::Handler for GuestClient {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        _key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[derive(Default)]
struct RecordAbort(AtomicBool);
impl FlowAbort for RecordAbort {
    fn abort(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

struct Guest {
    handle: client::Handle<GuestClient>,
    aborted: Arc<RecordAbort>,
}

async fn guest_connect(proxy: &SshProxy, hostname: &str, port: u16, user: &str) -> Guest {
    // russh's session loop stops reading while it flushes writes, so two russh
    // peers writing bulk data at each other over a small pipe can stall each
    // other (a real guest's OpenSSH client keeps reading); use a roomy pipe.
    let (guest_end, proxy_end) = tokio::io::duplex(16 << 20);
    let meta = FlowMeta {
        id: 1,
        src: "192.168.127.3:50006".parse().unwrap(),
        dst: format!("198.19.0.1:{port}").parse().unwrap(),
        synthetic_hostname: Some(hostname.to_string()),
    };
    let target = proxy.target_for(&meta).expect("flow allowed");
    let aborted = Arc::new(RecordAbort::default());
    let mut flow = TcpFlow::new(meta, proxy_end);
    flow.control = FlowControl::new(aborted.clone());
    let proxy = proxy.clone();
    tokio::spawn(async move { proxy.handle(flow, target).await });
    let mut handle =
        client::connect_stream(Arc::new(client::Config::default()), guest_end, GuestClient)
            .await
            .unwrap();
    assert!(handle.authenticate_none(user).await.unwrap().success());
    Guest { handle, aborted }
}

#[derive(Debug, Default)]
struct ExecResult {
    stdout: Vec<u8>,
    stderr: String,
    exit_status: Option<u32>,
    exit_signal: Option<Sig>,
    request_ok: bool,
}

async fn collect(channel: Channel<client::Msg>) -> ExecResult {
    let (rd, _wr) = channel.split();
    collect_half(rd).await
}

async fn collect_half(mut rd: russh::ChannelReadHalf) -> ExecResult {
    let mut r = ExecResult::default();
    while let Some(msg) = rd.wait().await {
        match msg {
            ChannelMsg::Success => r.request_ok = true,
            ChannelMsg::Data { data } => r.stdout.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, ext: 1 } => {
                r.stderr.push_str(&String::from_utf8_lossy(&data))
            }
            ChannelMsg::ExitStatus { exit_status } => r.exit_status = Some(exit_status),
            ChannelMsg::ExitSignal { signal_name, .. } => r.exit_signal = Some(signal_name),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    r
}

async fn run(guest: &Guest, command: &str) -> ExecResult {
    let channel = guest.handle.channel_open_session().await.unwrap();
    channel.exec(true, command).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), collect(channel)).await.expect("exec timed out")
}

struct Setup {
    proxy: SshProxy,
    port: u16,
    up: Upstream,
    _known_hosts: tempfile::NamedTempFile,
}

fn known_hosts_for(port: u16, host_key: &PrivateKey) -> tempfile::NamedTempFile {
    let mut f = tempfile::NamedTempFile::new().unwrap();
    writeln!(f, "[127.0.0.1]:{port} {}", host_key.public_key().to_openssh().unwrap()).unwrap();
    f
}

fn credential(port: u16, client_key: &PrivateKey) -> SshCredential {
    SshCredential {
        host: format!("127.0.0.1:{port}"),
        username: Some("deploy".into()),
        private_key: client_key.to_openssh(LineEnding::LF).unwrap().to_string(),
        passphrase: None,
    }
}

async fn setup_with(tweak: impl FnOnce(&mut SshEgressConfig), hooks: Arc<dyn SshHooks>) -> Setup {
    let client_key = key(1);
    let (port, host_key, up) = start_upstream(client_key.public_key().clone()).await;
    let known_hosts = known_hosts_for(port, &host_key);
    let mut config = SshEgressConfig {
        allowed_hosts: vec![format!("127.0.0.1:{port}")],
        credentials: vec![credential(port, &client_key)],
        known_hosts_files: vec![known_hosts.path().display().to_string()],
        ..Default::default()
    };
    tweak(&mut config);
    let proxy = SshProxy::new(&config, hooks).unwrap();
    Setup { proxy, port, up, _known_hosts: known_hosts }
}

async fn setup() -> Setup {
    setup_with(|_| {}, Arc::new(NoSshHooks)).await
}

// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exec_is_proxied_with_credential() {
    let s = setup().await;
    let guest = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;
    let r = run(&guest, "echo hello world").await;
    assert!(r.request_ok);
    assert_eq!(r.stdout, b"hello world\n");
    assert_eq!(r.exit_status, Some(0));

    let r = run(&guest, "stderr oops").await;
    assert_eq!(r.stderr, "oops\n");
    assert_eq!(r.exit_status, Some(3));

    let r = run(&guest, "signal").await;
    assert!(matches!(r.exit_signal, Some(Sig::TERM)), "{:?}", r.exit_signal);

    {
        let log = s.up.log.lock().unwrap();
        assert_eq!(log.users, vec!["deploy"; 3]);
        assert_eq!(log.connections, 3, "one upstream connection per exec");
    }
    // Upstream connections are released.
    for _ in 0..50 {
        if s.proxy.upstream_connections() == 0 && s.up.open.load(Ordering::SeqCst) == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(s.proxy.upstream_connections(), 0);
    assert_eq!(s.up.open.load(Ordering::SeqCst), 0);
    assert!(!guest.aborted.0.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stdin_is_streamed_both_ways() {
    let s = setup().await;
    let guest = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;
    let channel = guest.handle.channel_open_session().await.unwrap();
    channel.exec(true, "cat").await.unwrap();
    let payload: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    let (rd, wr) = channel.split();
    let sent = payload.clone();
    let writer = tokio::spawn(async move {
        wr.data_bytes(sent).await.unwrap();
        wr.eof().await.unwrap();
        wr
    });
    let r = tokio::time::timeout(Duration::from_secs(30), collect_half(rd)).await.unwrap();
    let _wr = writer.await.unwrap();
    assert_eq!(r.exit_status, Some(0));
    assert_eq!(r.stdout.len(), payload.len());
    assert!(r.stdout == payload);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shells_and_subsystems_are_denied() {
    let s = setup().await;
    let guest = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;

    let channel = guest.handle.channel_open_session().await.unwrap();
    channel.request_pty(true, "xterm", 80, 24, 0, 0, &[]).await.unwrap();
    channel.request_shell(true).await.unwrap();
    let r = tokio::time::timeout(Duration::from_secs(10), collect(channel)).await.unwrap();
    assert_eq!(r.stderr, "gondolin ssh proxy: interactive shells are not supported\n");
    assert_eq!(r.exit_status, Some(1));

    let mut channel = guest.handle.channel_open_session().await.unwrap();
    channel.request_subsystem(true, "sftp").await.unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(10), channel.wait()).await.unwrap();
    assert!(matches!(reply, Some(ChannelMsg::Failure)), "{reply:?}");

    // Other channel types (port forwarding) are refused.
    let forward =
        guest.handle.channel_open_direct_tcpip("127.0.0.1", 22u32, "127.0.0.1", 1u32).await;
    assert!(forward.is_err());
    assert_eq!(s.up.log.lock().unwrap().connections, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upstream_exec_failure_is_reported() {
    let s = setup().await;
    let guest = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;
    let r = run(&guest, "fail-exec").await;
    assert!(r.request_ok, "the proxy accepts exec before connecting upstream");
    assert_eq!(r.stderr, "gondolin ssh proxy error: Unable to exec\n");
    assert_eq!(r.exit_status, Some(255));
}

struct PolicyHooks {
    seen: Mutex<Vec<SshHookCall>>,
}

#[async_trait]
impl SshHooks for PolicyHooks {
    async fn ssh_hook_call(&self, call: SshHookCall) -> Result<SshHookResult, String> {
        self.seen.lock().unwrap().push(call.clone());
        match call {
            SshHookCall::ExecPolicy { request } if request.command.starts_with("echo") => {
                Ok(SshHookResult { allow: true, ..Default::default() })
            }
            SshHookCall::ExecPolicy { request } if request.command == "boom" => {
                Err("policy exploded".into())
            }
            SshHookCall::ExecPolicy { .. } => Ok(SshHookResult {
                allow: false,
                exit_code: Some(42),
                message: Some("denied".into()),
            }),
            SshHookCall::HostVerify { .. } => {
                Ok(SshHookResult { allow: false, ..Default::default() })
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exec_policy_hook_allows_and_denies() {
    let hooks = Arc::new(PolicyHooks { seen: Mutex::default() });
    let s = setup_with(|c| c.exec_policy_hook = true, hooks.clone()).await;
    let guest = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;

    let r = run(&guest, "git-upload-pack 'my-org/my-repo.git'").await;
    assert_eq!(r.stderr, "denied\n");
    assert_eq!(r.exit_status, Some(42));
    assert_eq!(s.up.log.lock().unwrap().connections, 0, "denied exec never connects upstream");

    let r = run(&guest, "boom").await;
    assert_eq!(r.stderr, "gondolin ssh proxy error: policy exploded\n");
    assert_eq!(r.exit_status, Some(255));

    let r = run(&guest, "echo ok").await;
    assert_eq!(r.stdout, b"ok\n");

    let seen = hooks.seen.lock().unwrap();
    let SshHookCall::ExecPolicy { request } = &seen[0] else { panic!() };
    assert_eq!(request.hostname, "127.0.0.1");
    assert_eq!(request.port, s.port);
    assert_eq!(request.guest_username, "git");
    assert_eq!(request.command, "git-upload-pack 'my-org/my-repo.git'");
    assert_eq!((request.src_ip.as_str(), request.src_port), ("192.168.127.3", 50006));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_host_key_is_rejected() {
    let other = key(99);
    let s = setup().await;
    // Replace known_hosts with a different key for the same host.
    let kh = known_hosts_for(s.port, &other);
    let mut config = SshEgressConfig {
        allowed_hosts: vec![format!("127.0.0.1:{}", s.port)],
        credentials: vec![credential(s.port, &key(1))],
        known_hosts_files: vec![kh.path().display().to_string()],
        ..Default::default()
    };
    let proxy = SshProxy::new(&config, Arc::new(NoSshHooks)).unwrap();
    let guest = guest_connect(&proxy, "127.0.0.1", s.port, "git").await;
    let r = run(&guest, "echo hi").await;
    assert_eq!(r.stderr, "gondolin ssh proxy error: Host denied (verification failed)\n");
    assert_eq!(r.exit_status, Some(255));
    assert!(s.up.log.lock().unwrap().commands.is_empty());

    // A controller hostVerifier is consulted instead of known_hosts.
    config.host_verifier_hook = true;
    let hooks = Arc::new(PolicyHooks { seen: Mutex::default() });
    let proxy = SshProxy::new(&config, hooks.clone()).unwrap();
    let guest = guest_connect(&proxy, "127.0.0.1", s.port, "git").await;
    let r = run(&guest, "echo hi").await;
    assert_eq!(r.exit_status, Some(255));
    let seen = hooks.seen.lock().unwrap();
    let SshHookCall::HostVerify { hostname, port, key } = &seen[0] else { panic!() };
    assert_eq!((hostname.as_str(), *port), ("127.0.0.1", s.port));
    assert!(!key.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wrong_credential_fails_auth() {
    let s = setup_with(|_| {}, Arc::new(NoSshHooks)).await;
    let kh = s._known_hosts.path().display().to_string();
    let config = SshEgressConfig {
        allowed_hosts: vec![format!("127.0.0.1:{}", s.port)],
        credentials: vec![credential(s.port, &key(2))],
        known_hosts_files: vec![kh],
        ..Default::default()
    };
    let proxy = SshProxy::new(&config, Arc::new(NoSshHooks)).unwrap();
    let guest = guest_connect(&proxy, "127.0.0.1", s.port, "git").await;
    let r = run(&guest, "echo hi").await;
    assert_eq!(
        r.stderr,
        "gondolin ssh proxy error: All configured authentication methods failed\n"
    );
    assert_eq!(r.exit_status, Some(255));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_agent_auth_uses_guest_username() {
    let client_key = key(1);
    let (port, host_key, up) = start_upstream(client_key.public_key().clone()).await;
    let kh = known_hosts_for(port, &host_key);

    // In-process agent holding the key.
    let path = std::env::temp_dir().join(format!("gsp-agent-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    tokio::spawn(russh::keys::agent::server::serve(
        tokio_stream::wrappers::UnixListenerStream::new(listener),
        (),
    ));
    let mut agent = russh::keys::agent::client::AgentClient::connect_uds(&path).await.unwrap();
    agent.add_identity(&key(3), &[]).await.unwrap(); // not authorized upstream
    agent.add_identity(&client_key, &[]).await.unwrap();

    let config = SshEgressConfig {
        allowed_hosts: vec![format!("127.0.0.1:{port}")],
        agent: Some(path.display().to_string()),
        known_hosts_files: vec![kh.path().display().to_string()],
        ..Default::default()
    };
    let proxy = SshProxy::new(&config, Arc::new(NoSshHooks)).unwrap();
    let guest = guest_connect(&proxy, "127.0.0.1", port, "alice").await;
    let r = run(&guest, "echo via agent").await;
    assert_eq!(r.stdout, b"via agent\n");
    assert_eq!(up.log.lock().unwrap().users.last().map(String::as_str), Some("alice"));
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_caps_are_enforced() {
    let s = setup_with(
        |c| {
            c.max_upstream_connections_per_flow = 1;
            c.max_upstream_connections_total = 2;
        },
        Arc::new(NoSshHooks),
    )
    .await;
    let guest = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;
    // Holds a slot (upstream never answers "sleep").
    let held = guest.handle.channel_open_session().await.unwrap();
    held.exec(true, "sleep").await.unwrap();
    for _ in 0..100 {
        if s.proxy.upstream_connections() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let r = run(&guest, "echo second").await;
    assert_eq!(
        r.stderr,
        "gondolin ssh proxy error: too many concurrent upstream ssh connections for this guest flow (limit 1)\n"
    );
    assert_eq!(r.exit_status, Some(255));

    let guest2 = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;
    let held2 = guest2.handle.channel_open_session().await.unwrap();
    held2.exec(true, "sleep").await.unwrap();
    for _ in 0..100 {
        if s.proxy.upstream_connections() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let guest3 = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;
    let r = run(&guest3, "echo third").await;
    assert_eq!(
        r.stderr,
        "gondolin ssh proxy error: too many concurrent upstream ssh connections on host (limit 2)\n"
    );

    // Closing the guest channel releases its upstream connection.
    held.close().await.unwrap();
    for _ in 0..100 {
        if s.proxy.upstream_connections() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(s.proxy.upstream_connections(), 1);
    let r = run(&guest3, "echo now").await;
    assert_eq!(r.stdout, b"now\n");
    drop(held2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ready_timeout_bounds_stalled_upstreams() {
    // Accepts TCP but never speaks SSH.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        loop {
            let (sock, _) = listener.accept().await.unwrap();
            held.push(sock);
        }
    });
    let kh = known_hosts_for(port, &key(7));
    let config = SshEgressConfig {
        allowed_hosts: vec![format!("127.0.0.1:{port}")],
        credentials: vec![credential(port, &key(1))],
        known_hosts_files: vec![kh.path().display().to_string()],
        upstream_ready_timeout_ms: 300,
        ..Default::default()
    };
    let proxy = SshProxy::new(&config, Arc::new(NoSshHooks)).unwrap();
    let guest = guest_connect(&proxy, "127.0.0.1", port, "git").await;
    let start = std::time::Instant::now();
    let r = run(&guest, "echo hi").await;
    assert!(start.elapsed() < Duration::from_secs(5));
    assert_eq!(r.stderr, "gondolin ssh proxy error: Timed out while waiting for handshake\n");
    assert_eq!(proxy.upstream_connections(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upstream_disconnect_mid_exec_aborts_flow() {
    let s = setup().await;
    let guest = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;
    let channel = guest.handle.channel_open_session().await.unwrap();
    channel.exec(true, "drop").await.unwrap();
    // In production abort() resets the guest TCP connection; here it only records.
    let _pending = tokio::spawn(collect(channel));
    for _ in 0..100 {
        if guest.aborted.0.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(guest.aborted.0.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn garbage_from_guest_aborts_flow() {
    let s = setup().await;
    let (mut guest_end, proxy_end) = tokio::io::duplex(64 * 1024);
    let meta = FlowMeta {
        id: 1,
        src: "192.168.127.3:50006".parse().unwrap(),
        dst: format!("198.19.0.1:{}", s.port).parse().unwrap(),
        synthetic_hostname: Some("127.0.0.1".into()),
    };
    let target = s.proxy.target_for(&meta).unwrap();
    let aborted = Arc::new(RecordAbort::default());
    let mut flow = TcpFlow::new(meta, proxy_end);
    flow.control = FlowControl::new(aborted.clone());
    let proxy = s.proxy.clone();
    let task = tokio::spawn(async move { proxy.handle(flow, target).await });
    use tokio::io::AsyncWriteExt;
    guest_end.write_all(b"SSH-2.0-x\r\n").await.unwrap();
    guest_end.write_all(&[0xff; 4096]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap();
    assert!(aborted.0.load(Ordering::SeqCst));
}

/// The guest side is OpenSSH in practice: drive the proxy with the system
/// `ssh` client (skipped when it is not installed).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openssh_client_against_proxy() {
    if std::process::Command::new("ssh").arg("-V").output().is_err() {
        eprintln!("skipping: no ssh client");
        return;
    }
    let s = setup().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let guest_port = listener.local_addr().unwrap().port();
    let proxy = s.proxy.clone();
    let upstream_port = s.port;
    tokio::spawn(async move {
        loop {
            let (sock, _) = listener.accept().await.unwrap();
            let meta = FlowMeta {
                id: 1,
                src: "192.168.127.3:50006".parse().unwrap(),
                dst: format!("198.19.0.1:{upstream_port}").parse().unwrap(),
                synthetic_hostname: Some("127.0.0.1".into()),
            };
            let target = proxy.target_for(&meta).unwrap();
            let proxy = proxy.clone();
            tokio::spawn(async move { proxy.handle(TcpFlow::new(meta, sock), target).await });
        }
    });
    let ssh = |args: &[&str]| {
        let mut cmd = tokio::process::Command::new("ssh");
        cmd.args([
            "-p",
            &guest_port.to_string(),
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "GlobalKnownHostsFile=/dev/null",
            "-o",
            "LogLevel=ERROR",
            "-F",
            "/dev/null",
            "git@127.0.0.1",
        ]);
        cmd.args(args);
        cmd.stdin(std::process::Stdio::piped());
        cmd.kill_on_drop(true);
        cmd
    };
    let out =
        tokio::time::timeout(Duration::from_secs(20), ssh(&["echo", "from-openssh"]).output())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "from-openssh\n", "{out:?}");
    assert_eq!(out.status.code(), Some(0));

    let out = tokio::time::timeout(Duration::from_secs(20), ssh(&["stderr", "bad"]).output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stderr), "bad\n");
    assert_eq!(out.status.code(), Some(3));

    // stdin is forwarded (git push sends a pack this way).
    let mut child = ssh(&["cat"]).stdout(std::process::Stdio::piped()).spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let payload: Vec<u8> = (0..1_000_000u32).map(|i| (i % 251) as u8).collect();
    let sent = payload.clone();
    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(&sent).await.unwrap();
    });
    let out = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(out.stdout == payload, "cat roundtrip ({} bytes)", out.stdout.len());

    // Interactive shells are refused.
    let out = tokio::time::timeout(Duration::from_secs(20), ssh(&["-T"]).output())
        .await
        .unwrap()
        .unwrap();
    assert!(String::from_utf8_lossy(&out.stderr).contains("interactive shells are not supported"));
    assert_eq!(out.status.code(), Some(1));
}

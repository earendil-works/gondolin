//! End-to-end: an SSH "guest" client (our own client) talks to the proxy over
//! an in-memory flow; the proxy talks to an in-process upstream server (our
//! own server). OpenSSH interop: `openssh_client_against_proxy` here and
//! `tests/openssh.rs`.

use std::io::Write as _;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gondolin_netstack::{FlowAbort, FlowControl, FlowMeta, TcpFlow};
use gondolin_sshproxy::ssh::agent;
use gondolin_sshproxy::ssh::connection::{AuthMethod, ChannelMsg, ChannelRequest};
use gondolin_sshproxy::ssh::session::{Channel, Client, Server, SessionConfig};
use gondolin_sshproxy::ssh::transport::TransportConfig;
use gondolin_sshproxy::ssh::wire::{Reader, Writer};
use gondolin_sshproxy::ssh::{PrivateKey, PublicKey};
use gondolin_sshproxy::{
    NoSshHooks, SshCredential, SshEgressConfig, SshHookCall, SshHookResult, SshHooks, SshProxy,
};

fn key(seed: u8) -> PrivateKey {
    PrivateKey::from_ed25519_seed(&[seed; 32])
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
    /// bytes `flood` commands have handed to their channel so far
    flooded: Arc<AtomicUsize>,
}

async fn upstream_channel(up: Upstream, server: Server, ch: Channel) {
    let ch = Arc::new(ch);
    let command = loop {
        match ch.wait().await {
            Some(ChannelMsg::Request { request: ChannelRequest::Exec { command }, want_reply }) => {
                let command = String::from_utf8_lossy(&command).into_owned();
                up.log.lock().unwrap().commands.push(command.clone());
                if command == "fail-exec" {
                    let _ = ch.reply(false);
                    continue;
                }
                if want_reply {
                    let _ = ch.reply(true);
                }
                break command;
            }
            Some(ChannelMsg::Request { want_reply: true, .. }) => {
                let _ = ch.reply(true);
            }
            Some(_) => {}
            None => return,
        }
    };
    let (verb, arg) = command.split_once(' ').unwrap_or((command.as_str(), ""));
    let finish = |ch: &Channel, code: u32| {
        let _ = ch.exit_status(code);
        let _ = ch.eof();
        let _ = ch.close();
    };
    match verb {
        "echo" => {
            let _ = ch.data(format!("{arg}\n").as_bytes()).await;
            finish(&ch, 0);
        }
        "stderr" => {
            let _ = ch.extended_data(1, format!("{arg}\n").as_bytes()).await;
            finish(&ch, 3);
        }
        "signal" => {
            let _ = ch.request(
                &ChannelRequest::ExitSignal {
                    name: "TERM".into(),
                    core_dumped: false,
                    message: "killed".into(),
                    lang: String::new(),
                },
                false,
            );
            let _ = ch.eof();
            let _ = ch.close();
        }
        "cat" => loop {
            match ch.wait().await {
                Some(ChannelMsg::Data(d)) => {
                    if ch.data(&d).await.is_err() {
                        return;
                    }
                }
                Some(ChannelMsg::Eof) => {
                    finish(&ch, 0);
                    return;
                }
                Some(ChannelMsg::Close) | None => return,
                Some(_) => {}
            }
        },
        "flood" | "slow-flood" => {
            // `flood N`: N bytes of output (stdin is read and dropped);
            // `slow-flood N` also takes stdin slowly
            let total: usize = arg.parse().unwrap();
            let slow = verb == "slow-flood";
            let reader = {
                let ch = ch.clone();
                tokio::spawn(async move {
                    while let Some(m) = ch.wait().await {
                        if matches!(m, ChannelMsg::Data(_)) && slow {
                            tokio::time::sleep(Duration::from_millis(2)).await;
                        }
                    }
                })
            };
            let chunk = vec![b'f'; 32 * 1024];
            let mut sent = 0;
            while sent < total {
                let n = chunk.len().min(total - sent);
                if ch.data(&chunk[..n]).await.is_err() {
                    reader.abort();
                    return;
                }
                sent += n;
                up.flooded.fetch_add(n, Ordering::SeqCst);
            }
            finish(&ch, 0);
            reader.abort();
        }
        "drop" => server.disconnect("bye"),
        _ => {
            // "sleep": never answers
            while ch.wait().await.is_some() {}
        }
    }
}

/// Starts an upstream server; returns its port and host key.
async fn start_upstream(authorized: PublicKey) -> (u16, PrivateKey, Upstream) {
    let host_key = key(7);
    let up =
        Upstream { authorized, log: Arc::default(), open: Arc::default(), flooded: Arc::default() };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server_up = up.clone();
    let hk = host_key.clone();
    tokio::spawn(async move {
        loop {
            let (sock, _) = listener.accept().await.unwrap();
            server_up.log.lock().unwrap().connections += 1;
            server_up.open.fetch_add(1, Ordering::SeqCst);
            let up = server_up.clone();
            let policy_up = server_up.clone();
            let transport = TransportConfig::server("SSH-2.0-test-upstream", vec![hk.clone()]);
            let auth = Arc::new(move |req: &gondolin_sshproxy::ssh::connection::AuthRequest| {
                match &req.method {
                    AuthMethod::PublicKey { key, signed, .. } => {
                        if *signed {
                            policy_up.log.lock().unwrap().users.push(req.user.clone());
                        }
                        key == &policy_up.authorized
                    }
                    _ => false,
                }
            });
            tokio::spawn(async move {
                let server =
                    Server::start(sock, transport, SessionConfig::default(), auth).unwrap();
                let mut tasks = tokio::task::JoinSet::new();
                while let Some(ch) = server.accept().await {
                    tasks.spawn(upstream_channel(up.clone(), server.clone(), ch));
                }
                drop(tasks);
                drop(server);
                up.open.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    (port, host_key, up)
}

// ---------------------------------------------------------------------------
// Guest client

#[derive(Default)]
struct RecordAbort(AtomicBool);
impl FlowAbort for RecordAbort {
    fn abort(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

struct Guest {
    client: Client,
    aborted: Arc<RecordAbort>,
}

async fn guest_connect(proxy: &SshProxy, hostname: &str, port: u16, user: &str) -> Guest {
    guest_connect_with(proxy, hostname, port, user, 64 * 1024).await
}

/// Connects a guest over an in-memory pipe of `pipe` bytes.
async fn guest_connect_with(
    proxy: &SshProxy,
    hostname: &str,
    port: u16,
    user: &str,
    pipe: usize,
) -> Guest {
    let (guest_end, proxy_end) = tokio::io::duplex(pipe);
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
    let client = Client::connect(
        guest_end,
        TransportConfig::client("SSH-2.0-test-guest"),
        SessionConfig::default(),
    )
    .await
    .unwrap();
    assert!(client.authenticate_none(user).await.unwrap());
    Guest { client, aborted }
}

#[derive(Debug, Default)]
struct ExecResult {
    stdout: Vec<u8>,
    stderr: String,
    exit_status: Option<u32>,
    exit_signal: Option<String>,
    request_ok: bool,
}

async fn collect(channel: &Channel) -> ExecResult {
    let mut r = ExecResult::default();
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Success => r.request_ok = true,
            ChannelMsg::Data(data) => r.stdout.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, ext: 1 } => {
                r.stderr.push_str(&String::from_utf8_lossy(&data))
            }
            ChannelMsg::Request { request: ChannelRequest::ExitStatus { code }, .. } => {
                r.exit_status = Some(code)
            }
            ChannelMsg::Request { request: ChannelRequest::ExitSignal { name, .. }, .. } => {
                r.exit_signal = Some(name)
            }
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    r
}

async fn run(guest: &Guest, command: &str) -> ExecResult {
    let channel = guest.client.open_session().await.unwrap();
    channel.exec(true, command).unwrap();
    tokio::time::timeout(Duration::from_secs(20), collect(&channel)).await.expect("exec timed out")
}

struct Setup {
    proxy: SshProxy,
    port: u16,
    up: Upstream,
    _known_hosts: tempfile::NamedTempFile,
}

fn known_hosts_for(port: u16, host_key: &PrivateKey) -> tempfile::NamedTempFile {
    let mut f = tempfile::NamedTempFile::new().unwrap();
    writeln!(f, "[127.0.0.1]:{port} {}", host_key.public_key().to_openssh()).unwrap();
    f
}

fn credential(port: u16, client_key: &PrivateKey) -> SshCredential {
    SshCredential {
        host: format!("127.0.0.1:{port}"),
        username: Some("deploy".into()),
        private_key: client_key.to_openssh(),
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

/// An in-process ssh-agent holding `keys`.
fn start_agent(path: &std::path::Path, keys: Vec<PrivateKey>) {
    let listener = tokio::net::UnixListener::bind(path).unwrap();
    let keys = Arc::new(keys);
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            let keys = keys.clone();
            tokio::spawn(async move {
                while let Ok(req) = agent::read_message(&mut sock).await {
                    let reply = match req[0] {
                        agent::REQUEST_IDENTITIES => {
                            let mut w = Writer::msg(agent::IDENTITIES_ANSWER);
                            w.u32(keys.len() as u32);
                            for k in keys.iter() {
                                w.string(k.public_key().to_blob()).string("test");
                            }
                            w.finish()
                        }
                        agent::SIGN_REQUEST => {
                            let mut r = Reader::new(&req[1..]);
                            let blob = r.string().unwrap();
                            let data = r.string().unwrap();
                            let k = keys.iter().find(|k| k.public_key().to_blob() == blob).unwrap();
                            let alg = k.signature_algorithms()[0];
                            let mut w = Writer::msg(agent::SIGN_RESPONSE);
                            w.string(k.sign(alg, data).unwrap());
                            w.finish()
                        }
                        _ => vec![agent::FAILURE],
                    };
                    if agent::write_message(&mut sock, &reply).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
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
    assert_eq!(r.exit_signal.as_deref(), Some("TERM"));

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

/// Runs `cat` upstream with `size` bytes written and read concurrently.
async fn cat_both_ways(guest: &Guest, size: usize, seed: u32, timeout: Duration) {
    let channel = Arc::new(guest.client.open_session().await.unwrap());
    channel.exec(true, "cat").unwrap();
    let payload: Vec<u8> = (0..size as u32).map(|i| (i.wrapping_add(seed) % 251) as u8).collect();
    let wr = channel.clone();
    let sent = payload.clone();
    let writer = tokio::spawn(async move {
        wr.data(&sent).await.unwrap();
        wr.eof().unwrap();
    });
    let r = tokio::time::timeout(timeout, collect(&channel))
        .await
        .unwrap_or_else(|_| panic!("cat of {size} bytes both ways stalled"));
    writer.await.unwrap();
    assert_eq!(r.exit_status, Some(0));
    assert_eq!(r.stdout.len(), payload.len());
    assert!(r.stdout == payload);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stdin_is_streamed_both_ways() {
    let s = setup().await;
    let guest = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;
    cat_both_ways(&guest, 3_000_000, 0, Duration::from_secs(30)).await;
}

/// The bidirectional transfer 50 times: 5 guests at once, 10 rounds each.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stdin_is_streamed_both_ways_repeatedly() {
    let s = setup().await;
    let mut tasks = tokio::task::JoinSet::new();
    for g in 0..5u32 {
        let proxy = s.proxy.clone();
        let port = s.port;
        tasks.spawn(async move {
            let guest = guest_connect(&proxy, "127.0.0.1", port, "git").await;
            for round in 0..10u32 {
                cat_both_ways(&guest, 3_000_000, g * 100 + round, Duration::from_secs(60)).await;
            }
        });
    }
    while let Some(r) = tasks.join_next().await {
        r.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_payload_is_streamed_both_ways() {
    let s = setup().await;
    let guest = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;
    cat_both_ways(&guest, 48 << 20, 7, Duration::from_secs(120)).await;
}

/// A 4 KiB guest pipe: the guest stops reading while it writes, so the proxy
/// must never wait for its own writes to the guest before reading again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tiny_guest_pipe_is_streamed_both_ways() {
    let s = setup().await;
    let guest = guest_connect_with(&s.proxy, "127.0.0.1", s.port, "git", 4096).await;
    for round in 0..5 {
        cat_both_ways(&guest, 4 << 20, round, Duration::from_secs(60)).await;
    }
}

/// Upstream floods output while the guest saturates stdin and reads the output
/// slowly: the transfer completes, and while the guest pauses, the upstream is
/// held back by SSH windows instead of the proxy buffering its output.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_guest_reader_backpressures_upstream() {
    const TOTAL: usize = 64 << 20;
    // windows (upstream→proxy, proxy→guest, 2 MiB each) plus socket and
    // output buffers. Granting window on receipt instead (russh's default),
    // the proxy's channel buffers added 8 MiB more (~15 MiB).
    const IN_FLIGHT: usize = 10 << 20;
    let s = setup().await;
    let guest = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;
    let channel = Arc::new(guest.client.open_session().await.unwrap());
    channel.exec(true, &format!("flood {TOTAL}")).unwrap();
    let (rd, wr) = (channel.clone(), channel.clone());
    // stdin at full speed the whole time (dropped upstream)
    let writer = tokio::spawn(async move {
        let chunk = vec![b's'; 256 * 1024];
        for _ in 0..(TOTAL / chunk.len()) {
            if wr.data(&chunk).await.is_err() {
                break;
            }
        }
        let _ = wr.eof();
    });
    let flooded = s.up.flooded.clone();
    let read = async {
        let mut received = 0usize;
        let mut paused = 0;
        let mut exit = None;
        while let Some(msg) = rd.wait().await {
            match msg {
                ChannelMsg::Data(data) => {
                    received += data.len();
                    // a slow reader: long pauses every 8 MiB
                    if received / (8 << 20) > paused {
                        paused += 1;
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        let ahead = flooded.load(Ordering::SeqCst).saturating_sub(received);
                        assert!(ahead <= IN_FLIGHT, "upstream {ahead} bytes ahead of the guest");
                    }
                }
                ChannelMsg::Request { request: ChannelRequest::ExitStatus { code }, .. } => {
                    exit = Some(code)
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        (received, exit)
    };
    let (received, exit) =
        tokio::time::timeout(Duration::from_secs(120), read).await.expect("flood stalled");
    assert_eq!(received, TOTAL);
    assert_eq!(exit, Some(0));
    // The upstream closed the channel with stdin still flowing; the writer
    // may wait for window that never comes, so stop it.
    writer.abort();
    // The proxy released the upstream connection.
    for _ in 0..100 {
        if s.proxy.upstream_connections() == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("upstream connection still open");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shells_and_subsystems_are_denied() {
    let s = setup().await;
    let guest = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;

    let channel = guest.client.open_session().await.unwrap();
    channel
        .request(&ChannelRequest::Pty { term: "xterm".into(), cols: 80, rows: 24 }, true)
        .unwrap();
    channel.request(&ChannelRequest::Shell, true).unwrap();
    let r = tokio::time::timeout(Duration::from_secs(10), collect(&channel)).await.unwrap();
    assert_eq!(r.stderr, "gondolin ssh proxy: interactive shells are not supported\n");
    assert_eq!(r.exit_status, Some(1));

    let channel = guest.client.open_session().await.unwrap();
    channel.request(&ChannelRequest::Subsystem { name: "sftp".into() }, true).unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(10), channel.wait()).await.unwrap();
    assert!(matches!(reply, Some(ChannelMsg::Failure)), "{reply:?}");

    // Other channel types (port forwarding) are refused.
    let mut extra = Writer::new();
    extra.string("127.0.0.1").u32(22).string("127.0.0.1").u32(1);
    let forward = guest.client.open_channel("direct-tcpip", &extra.finish()).await;
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

impl SshHooks for PolicyHooks {
    fn ssh_hook_call(
        &self,
        call: SshHookCall,
    ) -> gondolin_netstack::BoxFuture<'_, Result<SshHookResult, String>> {
        Box::pin(async move {
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
        })
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

    // In-process agent holding the key (and one not authorized upstream first).
    let path = std::env::temp_dir().join(format!("gsp-agent-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    start_agent(&path, vec![key(3), client_key.clone()]);

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
    let held = guest.client.open_session().await.unwrap();
    held.exec(true, "sleep").unwrap();
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
    let held2 = guest2.client.open_session().await.unwrap();
    held2.exec(true, "sleep").unwrap();
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
    held.close().unwrap();
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
    let channel = guest.client.open_session().await.unwrap();
    channel.exec(true, "drop").unwrap();
    // In production abort() resets the guest TCP connection; here it only records.
    let _pending = tokio::spawn(async move { collect(&channel).await });
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

/// Both directions saturated with a slow consumer on each far end: the guest
/// writes stdin at full speed into an upstream that reads it slowly, while the
/// upstream floods output that the guest reads with pauses. With SSH window
/// granted on receipt, the proxy's guest connection stopped being read once
/// the stdin buffer filled, so the guest's window adjusts for the output never
/// arrived and both directions stalled for good.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn both_directions_saturated_with_slow_consumers() {
    const TOTAL: usize = 24 << 20;
    let s = setup().await;
    let guest = guest_connect(&s.proxy, "127.0.0.1", s.port, "git").await;
    let channel = Arc::new(guest.client.open_session().await.unwrap());
    channel.exec(true, &format!("slow-flood {TOTAL}")).unwrap();
    let (rd, wr) = (channel.clone(), channel.clone());
    let writer = tokio::spawn(async move {
        let chunk = vec![b's'; 256 * 1024];
        loop {
            if wr.data(&chunk).await.is_err() {
                break;
            }
        }
    });
    let read = async {
        let mut received = 0usize;
        let mut paused = 0;
        let mut exit = None;
        while let Some(msg) = rd.wait().await {
            match msg {
                ChannelMsg::Data(data) => {
                    received += data.len();
                    if received / (4 << 20) > paused {
                        paused += 1;
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                }
                ChannelMsg::Request { request: ChannelRequest::ExitStatus { code }, .. } => {
                    exit = Some(code)
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        (received, exit)
    };
    let (received, exit) =
        tokio::time::timeout(Duration::from_secs(60), read).await.expect("transfer stalled");
    assert_eq!(received, TOTAL);
    assert_eq!(exit, Some(0));
    writer.abort();
}

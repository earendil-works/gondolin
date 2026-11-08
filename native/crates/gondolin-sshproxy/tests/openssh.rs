//! Interop with OpenSSH: our client against `sshd` (run unprivileged on a
//! random port with a temporary config) and the `ssh` client against our
//! server, across every key exchange, cipher, host key and client key type
//! we support, with rekeying in both directions and ssh-agent signing.
//! Skipped when `sshd`/`ssh`/`ssh-keygen` are not installed.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use gondolin_sshproxy::ssh::agent::AgentClient;
use gondolin_sshproxy::ssh::connection::{AuthMethod, ChannelMsg, ChannelRequest};
use gondolin_sshproxy::ssh::session::{Channel, Client, Server, SessionConfig};
use gondolin_sshproxy::ssh::transport::TransportConfig;
use gondolin_sshproxy::ssh::{PrivateKey, PublicKey, decode_secret_key};

const SSHD: &str = "/usr/sbin/sshd";

fn have(cmd: &str) -> bool {
    std::process::Command::new(cmd)
        .arg("-V")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

fn tools() -> bool {
    let ok = Path::new(SSHD).exists() && have("ssh") && have("ssh-keygen");
    if !ok {
        eprintln!("skipping: OpenSSH (sshd, ssh, ssh-keygen) not installed");
    }
    ok
}

fn keygen(dir: &Path, name: &str, args: &[&str]) -> PathBuf {
    let path = dir.join(name);
    let status = std::process::Command::new("ssh-keygen")
        .args(["-q", "-N", "", "-C", name, "-f"])
        .arg(&path)
        .args(args)
        .stdin(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "ssh-keygen {name}");
    path
}

fn private(path: &Path) -> PrivateKey {
    decode_secret_key(&std::fs::read_to_string(path).unwrap(), None).unwrap()
}

fn public(path: &Path) -> PublicKey {
    let text = std::fs::read_to_string(format!("{}.pub", path.display())).unwrap();
    PublicKey::parse_openssh(&text).unwrap()
}

struct Keys {
    dir: tempfile::TempDir,
    hosts: Vec<PathBuf>,
    clients: Vec<PathBuf>,
}

fn keys() -> Keys {
    let dir = tempfile::tempdir().unwrap();
    let hosts = vec![
        keygen(dir.path(), "host_ed25519", &["-t", "ed25519"]),
        keygen(dir.path(), "host_ecdsa256", &["-t", "ecdsa", "-b", "256"]),
        keygen(dir.path(), "host_ecdsa384", &["-t", "ecdsa", "-b", "384"]),
        keygen(dir.path(), "host_rsa", &["-t", "rsa", "-b", "2048"]),
    ];
    let clients = vec![
        keygen(dir.path(), "client_ed25519", &["-t", "ed25519"]),
        keygen(dir.path(), "client_ecdsa", &["-t", "ecdsa", "-b", "256"]),
        keygen(dir.path(), "client_rsa", &["-t", "rsa", "-b", "3072"]),
    ];
    let mut authorized = String::new();
    for c in &clients {
        authorized += &std::fs::read_to_string(format!("{}.pub", c.display())).unwrap();
    }
    std::fs::write(dir.path().join("authorized_keys"), authorized).unwrap();
    Keys { dir, hosts, clients }
}

struct Sshd {
    child: tokio::process::Child,
    port: u16,
}

async fn free_port() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    l.local_addr().unwrap().port()
}

async fn sshd(keys: &Keys, options: &[&str]) -> Option<Sshd> {
    let dir = keys.dir.path();
    let port = free_port().await;
    let mut config = format!(
        "Port {port}\nListenAddress 127.0.0.1\nAuthorizedKeysFile {}\nPasswordAuthentication no\n\
         KbdInteractiveAuthentication no\nStrictModes no\nUsePAM no\nPidFile none\nLogLevel ERROR\n",
        dir.join("authorized_keys").display()
    );
    for k in &keys.hosts {
        config += &format!("HostKey {}\n", k.display());
    }
    let path = dir.join(format!("sshd_config_{port}"));
    std::fs::write(&path, config).unwrap();
    let mut cmd = tokio::process::Command::new(SSHD);
    cmd.arg("-D").arg("-e").arg("-f").arg(&path);
    for o in options {
        cmd.arg("-o").arg(o);
    }
    // stderr explains a failed start (unprivileged sshd also warns about
    // audit sessions on macOS, which we don't read)
    let log = dir.join(format!("sshd_{port}.log"));
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(&log).unwrap())
        .kill_on_drop(true);
    let mut child = cmd.spawn().unwrap();
    for _ in 0..300 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Some(Sshd { child, port });
        }
        if let Ok(Some(status)) = child.try_wait() {
            // sshd that cannot run here at all (e.g. as root without its
            // privilege separation user or directory): skip, don't fail
            let why = std::fs::read_to_string(&log).unwrap_or_default();
            eprintln!("skipping: sshd exited ({status}): {}", why.trim());
            return None;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    panic!("sshd did not start: {}", std::fs::read_to_string(&log).unwrap_or_default());
}

fn user() -> String {
    std::env::var("USER").unwrap_or_else(|_| "root".into())
}

async fn connect(port: u16, host_key_alg: &str, rekey: u64) -> Client {
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut transport = TransportConfig::client("SSH-2.0-gondolin-test");
    transport.host_key_algorithms = vec![host_key_alg.to_string()];
    transport.rekey_after_bytes = rekey;
    Client::connect(tcp, transport, SessionConfig::default()).await.unwrap()
}

#[derive(Debug, Default)]
struct Output {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: Option<u32>,
    signal: Option<String>,
}

async fn collect(ch: &Channel) -> Output {
    let mut out = Output::default();
    while let Some(m) = ch.wait().await {
        match m {
            ChannelMsg::Data(d) => out.stdout.extend_from_slice(&d),
            ChannelMsg::ExtendedData { data, .. } => out.stderr.extend_from_slice(&data),
            ChannelMsg::Request { request: ChannelRequest::ExitStatus { code }, .. } => {
                out.status = Some(code)
            }
            ChannelMsg::Request { request: ChannelRequest::ExitSignal { name, .. }, .. } => {
                out.signal = Some(name)
            }
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    out
}

async fn exec(client: &Client, command: &str, stdin: &[u8]) -> Output {
    let ch = Arc::new(client.open_session().await.unwrap());
    ch.exec(true, command).unwrap();
    assert_eq!(ch.wait_reply().await, Ok(true), "exec {command}");
    let writer = {
        let ch = ch.clone();
        let stdin = stdin.to_vec();
        tokio::spawn(async move {
            if !stdin.is_empty() {
                ch.data(&stdin).await.unwrap();
            }
            // a command that ignores stdin may have closed the channel already
            let _ = ch.eof();
        })
    };
    let out = tokio::time::timeout(Duration::from_secs(60), collect(&ch)).await.expect("exec hung");
    writer.await.unwrap();
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_against_sshd_every_algorithm() {
    if !tools() {
        return;
    }
    let keys = keys();
    let kexes = [
        "curve25519-sha256",
        "curve25519-sha256@libssh.org",
        "ecdh-sha2-nistp256",
        "ecdh-sha2-nistp384",
    ];
    let ciphers =
        ["chacha20-poly1305@openssh.com", "aes128-gcm@openssh.com", "aes256-gcm@openssh.com"];
    let host_algs = [
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "rsa-sha2-512",
        "rsa-sha2-256",
    ];
    for i in 0..kexes.len().max(ciphers.len()).max(host_algs.len()).max(keys.clients.len()) {
        let (kex, cipher) = (kexes[i % kexes.len()], ciphers[i % ciphers.len()]);
        let host_alg = host_algs[i % host_algs.len()];
        let client_key = &keys.clients[i % keys.clients.len()];
        let Some(mut d) =
            sshd(&keys, &[&format!("KexAlgorithms={kex}"), &format!("Ciphers={cipher}")]).await
        else {
            return;
        };
        let client = connect(d.port, host_alg, 1 << 30).await;
        let host_index = [0, 1, 2, 3, 3][i % host_algs.len()];
        let expected = public(&keys.hosts[host_index]);
        assert_eq!(client.host_key(), Some(&expected), "{kex}/{cipher}/{host_alg}");
        let key = private(client_key);
        assert!(
            client.authenticate_publickey(&user(), &key).await.unwrap(),
            "auth with {client_key:?}"
        );
        let out = exec(&client, "echo ok", b"").await;
        assert_eq!(out.stdout, b"ok\n", "{kex}/{cipher}/{host_alg}: {out:?}");
        assert_eq!(out.status, Some(0));
        drop(client);
        let _ = d.child.kill().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_against_sshd_bulk_rekey_status_signal() {
    if !tools() {
        return;
    }
    let keys = keys();
    // the server rekeys every 256 KiB, our client every 300 KB
    let Some(mut d) = sshd(&keys, &["RekeyLimit=256K"]).await else { return };
    let client = connect(d.port, "ssh-ed25519", 300_000).await;
    assert!(client.authenticate_publickey(&user(), &private(&keys.clients[0])).await.unwrap());
    // a wrong key is refused, the connection stays usable
    let other = PrivateKey::from_ed25519_seed(&[42; 32]);
    let client2 = connect(d.port, "ssh-ed25519", 1 << 30).await;
    assert!(!client2.authenticate_publickey(&user(), &other).await.unwrap());
    assert!(client2.authenticate_publickey(&user(), &private(&keys.clients[2])).await.unwrap());

    let payload: Vec<u8> = (0..8_000_000u32).map(|i| (i % 253) as u8).collect();
    let out = exec(&client, "cat", &payload).await;
    assert_eq!(out.stdout.len(), payload.len());
    assert!(out.stdout == payload);
    assert_eq!(out.status, Some(0));
    // 16 MB through: rekeyed by both sides many times
    assert!(client.key_exchanges() > 20, "{} key exchanges", client.key_exchanges());

    let out = exec(&client, "echo err >&2; exit 7", b"").await;
    assert_eq!((out.stderr.as_slice(), out.status), (&b"err\n"[..], Some(7)));
    let out = exec(&client2, "kill -TERM $$", b"").await;
    assert_eq!(out.signal.as_deref(), Some("TERM"), "{out:?}");
    // several channels on one connection
    let (a, b) = tokio::join!(exec(&client, "echo a", b""), exec(&client, "echo b", b""));
    assert_eq!((a.stdout, b.stdout), (b"a\n".to_vec(), b"b\n".to_vec()));
    let _ = d.child.kill().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_with_ssh_agent() {
    if !tools() || !have("ssh-agent") {
        return;
    }
    let keys = keys();
    let sock = keys.dir.path().join("agent.sock");
    let mut agent = tokio::process::Command::new("ssh-agent")
        .arg("-D")
        .arg("-a")
        .arg(&sock)
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if sock.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    for c in [&keys.clients[2], &keys.clients[1]] {
        let status = std::process::Command::new("ssh-add")
            .arg("-q")
            .arg(c)
            .env("SSH_AUTH_SOCK", &sock)
            .status()
            .unwrap();
        assert!(status.success());
    }
    let Some(mut d) = sshd(&keys, &[]).await else { return };
    let mut agent_client = AgentClient::connect(&sock).await.unwrap();
    let ids = agent_client.identities().await.unwrap();
    assert_eq!(ids.len(), 2);
    for id in ids {
        let key = PublicKey::from_blob(&id.blob).unwrap();
        let client = connect(d.port, "ssh-ed25519", 1 << 30).await;
        assert!(
            client.authenticate_agent(&user(), &mut agent_client, &key).await.unwrap(),
            "agent auth with {}",
            key.key_type()
        );
        assert_eq!(exec(&client, "echo agent", b"").await.stdout, b"agent\n");
    }
    let _ = d.child.kill().await;
    let _ = agent.kill().await;
}

/// Our server with every host key type, an exec app that echoes, cats and
/// exits with a status.
async fn start_server() -> (u16, Vec<PrivateKey>) {
    let dir = tempfile::tempdir().unwrap();
    let host_keys = vec![
        private(&keygen(dir.path(), "h1", &["-t", "ed25519"])),
        private(&keygen(dir.path(), "h2", &["-t", "ecdsa", "-b", "256"])),
        private(&keygen(dir.path(), "h3", &["-t", "ecdsa", "-b", "384"])),
        private(&keygen(dir.path(), "h4", &["-t", "rsa", "-b", "2048"])),
    ];
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let hk = host_keys.clone();
    tokio::spawn(async move {
        loop {
            let (sock, _) = listener.accept().await.unwrap();
            let mut transport = TransportConfig::server("SSH-2.0-gondolin-test", hk.clone());
            transport.rekey_after_bytes = 500_000;
            let auth = Arc::new(|r: &gondolin_sshproxy::ssh::connection::AuthRequest| {
                matches!(r.method, AuthMethod::None | AuthMethod::PublicKey { .. })
            });
            let server = Server::start(sock, transport, SessionConfig::default(), auth).unwrap();
            tokio::spawn(async move {
                while let Some(ch) = server.accept().await {
                    tokio::spawn(serve_channel(ch));
                }
            });
        }
    });
    (port, host_keys)
}

async fn serve_channel(ch: Channel) {
    loop {
        match ch.wait().await {
            Some(ChannelMsg::Request { request: ChannelRequest::Exec { command }, want_reply }) => {
                if want_reply {
                    let _ = ch.reply(true);
                }
                let command = String::from_utf8_lossy(&command).into_owned();
                if command == "cat" {
                    while let Some(m) = ch.wait().await {
                        match m {
                            ChannelMsg::Data(d) => ch.data(&d).await.unwrap(),
                            ChannelMsg::Eof => break,
                            _ => {}
                        }
                    }
                    let _ = ch.exit_status(0);
                } else {
                    let _ = ch.data(format!("{command}\n").as_bytes()).await;
                    let _ = ch.extended_data(1, b"to stderr\n").await;
                    let _ = ch.exit_status(5);
                }
                let _ = ch.eof();
                let _ = ch.close();
                return;
            }
            Some(ChannelMsg::Request { want_reply: true, .. }) => {
                let _ = ch.reply(false);
            }
            Some(_) => {}
            None => return,
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openssh_client_against_server_every_algorithm() {
    if !tools() {
        return;
    }
    let (port, _keys) = start_server().await;
    let combos = [
        ("curve25519-sha256", "chacha20-poly1305@openssh.com", "ssh-ed25519"),
        ("curve25519-sha256@libssh.org", "aes128-gcm@openssh.com", "ecdsa-sha2-nistp256"),
        ("ecdh-sha2-nistp256", "aes256-gcm@openssh.com", "ecdsa-sha2-nistp384"),
        ("ecdh-sha2-nistp384", "chacha20-poly1305@openssh.com", "rsa-sha2-512"),
        ("curve25519-sha256", "aes256-gcm@openssh.com", "rsa-sha2-256"),
    ];
    for (kex, cipher, host_alg) in combos {
        let out = tokio::process::Command::new("ssh")
            .args(["-p", &port.to_string(), "-F", "/dev/null"])
            .args(["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no"])
            .args(["-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"])
            .args(["-o", "IdentityAgent=none", "-o", "IdentitiesOnly=yes"])
            .args(["-o", &format!("KexAlgorithms={kex}"), "-o", &format!("Ciphers={cipher}")])
            .args(["-o", &format!("HostKeyAlgorithms={host_alg}")])
            .args(["git@127.0.0.1", "hello"])
            .stdin(Stdio::null())
            .output();
        let out = tokio::time::timeout(Duration::from_secs(20), out).await.unwrap().unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            "hello\n",
            "{kex}/{cipher}/{host_alg}: {out:?}"
        );
        assert_eq!(String::from_utf8_lossy(&out.stderr), "to stderr\n");
        assert_eq!(out.status.code(), Some(5));
    }

    // bulk data with rekeying started by both sides (client: RekeyLimit,
    // server: every 500 KB)
    let payload: Vec<u8> = (0..6_000_000u32).map(|i| (i % 249) as u8).collect();
    let mut child = tokio::process::Command::new("ssh")
        .args(["-p", &port.to_string(), "-F", "/dev/null"])
        .args(["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no"])
        .args(["-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"])
        .args(["-o", "IdentityAgent=none", "-o", "IdentitiesOnly=yes", "-o", "RekeyLimit=300K"])
        .args(["git@127.0.0.1", "cat"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let sent = payload.clone();
    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(&sent).await.unwrap();
    });
    let out = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(out.stdout.len(), payload.len());
    assert!(out.stdout == payload);
    assert_eq!(out.status.code(), Some(0));
}

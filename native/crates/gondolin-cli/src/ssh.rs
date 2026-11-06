//! `gondolin bash --ssh` (`vm.enableSsh()`): sshd in the guest, reachable
//! through a localhost port forward over the guest's `virtio-ssh` channel.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;

use crate::configure::WorkDir;
use crate::vm::{ExecRequest, Vm};

/// Guest setup (authorized_keys, sandboxssh, sshd); `{SSH_USER}` and
/// `{PUB_KEY}` are substituted. Kept in sync with `VM.enableSsh()`.
const SETUP_SCRIPT: &str = r#"set -eu
SSH_USER={SSH_USER}
if ! command -v sshd >/dev/null 2>&1; then
  echo "sshd not found in guest image" 1>&2
  exit 127
fi

if ! command -v sandboxssh >/dev/null 2>&1; then
  echo "sandboxssh not found in guest image" 1>&2
  exit 126
fi

if ! id "$SSH_USER" >/dev/null 2>&1; then
  echo "ssh user '$SSH_USER' does not exist in guest image" 1>&2
  exit 125
fi

SSH_UID=$(id -u "$SSH_USER")
SSH_GID=$(id -g "$SSH_USER")

SSH_HOME=""
if command -v getent >/dev/null 2>&1; then
  SSH_HOME=$(getent passwd "$SSH_USER" | cut -d: -f6 || true)
fi
if [ -z "$SSH_HOME" ] && [ -r /etc/passwd ]; then
  SSH_HOME=$(awk -F: -v u="$SSH_USER" '$1==u{print $6;exit}' /etc/passwd || true)
fi
if [ -z "$SSH_HOME" ]; then
  if [ "$SSH_UID" = "0" ]; then
    SSH_HOME=/root
  else
    SSH_HOME="/home/$SSH_USER"
  fi
fi

# Ensure loopback is up (needed for ListenAddress=127.0.0.1 and tcp forwarding)
if command -v ip >/dev/null 2>&1; then
  ip link set lo up || true
else
  ifconfig lo up || true
fi

# sshd on Alpine wants /var/empty to be root-owned
mkdir -p /var/empty
chown root:root /var/empty || true
chmod 755 /var/empty || true

mkdir -p "$SSH_HOME" "$SSH_HOME/.ssh" /run/sshd /etc/ssh

chown "$SSH_UID:$SSH_GID" "$SSH_HOME" "$SSH_HOME/.ssh" || true
if [ "$SSH_UID" = "0" ]; then
  chmod 700 "$SSH_HOME" || true
else
  chmod 755 "$SSH_HOME" || true
fi
chmod 700 "$SSH_HOME/.ssh" || true

cat > "$SSH_HOME/.ssh/authorized_keys" <<'EOF'
{PUB_KEY}
EOF
chown "$SSH_UID:$SSH_GID" "$SSH_HOME/.ssh/authorized_keys" || true
chmod 600 "$SSH_HOME/.ssh/authorized_keys"

# Generate host keys if missing
ssh-keygen -A >/dev/null 2>&1 || true

# Start sandboxssh if it's not already running (required for host-side TCP forwarding)
if ! ps | grep -q '[s]andboxssh'; then
  sandboxssh >/tmp/sandboxssh.log 2>&1 &
fi

# Start sshd bound to loopback only
#
# Don't try to be clever about whether it's already running; it's easy to
# accidentally match our own command line. Starting twice is harmless (it will fail
# to bind), and we validate by probing the port from the host.
/usr/sbin/sshd -D -e -p 22 \
  -o ListenAddress=127.0.0.1 \
  -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no \
  -o ChallengeResponseAuthentication=no \
  -o PubkeyAuthentication=yes \
  -o AllowUsers=$SSH_USER \
  -o AllowAgentForwarding=no \
  -o AllowTcpForwarding=no \
  -o X11Forwarding=no \
  -o PermitTunnel=no \
  -o PermitRootLogin=prohibit-password \
  -o PidFile=/run/sshd.pid \
  >/tmp/sshd.log 2>&1 &
"#;

/// An enabled SSH forward.
pub struct SshAccess {
    pub command: String,
    _keys: WorkDir,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for SshAccess {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn sh_quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', "'\\''"))
}

/// Configures sshd in the guest and listens on `listen_host:listen_port`.
pub async fn enable(
    vm: &Arc<Vm>,
    user: &str,
    listen_host: &str,
    listen_port: u16,
) -> Result<SshAccess, String> {
    let keys = WorkDir::create("gondolin-ssh").map_err(|e| e.to_string())?;
    let key_path = keys.0.join("id_ed25519");
    let status = std::process::Command::new("ssh-keygen")
        .args(["-t", "ed25519", "-N", "", "-f"])
        .arg(&key_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => return Err(format!("failed to run ssh-keygen (needed for --ssh): {s}")),
        Err(e) => return Err(format!("failed to run ssh-keygen (needed for --ssh): {e}")),
    }
    let pub_key = std::fs::read_to_string(key_path.with_extension("pub"))
        .map_err(|e| e.to_string())?
        .trim()
        .to_string();
    let script = SETUP_SCRIPT.replace("{SSH_USER}", &sh_quote(user)).replace("{PUB_KEY}", &pub_key);
    let r = vm
        .exec(ExecRequest {
            cmd: "/bin/sh".into(),
            argv: vec!["-lc".into(), script],
            ..Default::default()
        })
        .await
        .collect()
        .await?;
    match r.exit_code {
        0 => {}
        127 => return Err("sshd not available in guest image. Rebuild guest assets with openssh installed (default images should include it).".into()),
        126 => return Err("sandboxssh not available in guest image. Rebuild guest assets to include sandboxssh.".into()),
        125 => return Err(format!("ssh user '{user}' does not exist in guest image")),
        code => {
            return Err(format!(
                "failed to configure ssh in guest (exit {code}): {}",
                String::from_utf8_lossy(&r.stderr).trim()
            ));
        }
    }
    // wait for sshd's banner through the forwarder
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match probe(vm).await {
            Ok(()) => break,
            Err(e) if tokio::time::Instant::now() >= deadline => {
                return Err(format!("ssh port-forward is not available: {e}"));
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(150)).await,
        }
    }
    let listener = TcpListener::bind((listen_host, listen_port))
        .await
        .map_err(|e| format!("cannot listen on {listen_host}:{listen_port}: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let engine = vm.engine.clone();
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let _ = socket.set_nodelay(true);
            let engine = engine.clone();
            tokio::spawn(async move {
                if let Ok(mut tunnel) =
                    crate::fwd::open(&engine, "ssh", "127.0.0.1", 22, Duration::from_secs(30)).await
                {
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut tunnel).await;
                }
            });
        }
    });
    let key = key_path.display();
    let command = format!(
        "ssh -p {port} -i {key} -o ForwardAgent=no -o ClearAllForwardings=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null {user}@{listen_host}"
    );
    Ok(SshAccess { command, _keys: keys, task })
}

async fn probe(vm: &Vm) -> Result<(), String> {
    let mut s =
        crate::fwd::open(&vm.engine, "ssh", "127.0.0.1", 22, Duration::from_secs(2)).await?;
    let mut buf = [0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(1), s.read(&mut buf))
        .await
        .map_err(|_| "ssh banner timeout".to_string())?
        .map_err(|e| e.to_string())?;
    if !buf[..n].starts_with(b"SSH-") {
        return Err(format!("unexpected ssh banner: {:?}", String::from_utf8_lossy(&buf[..n])));
    }
    Ok(())
}

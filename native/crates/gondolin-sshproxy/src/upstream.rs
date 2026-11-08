//! Upstream SSH client: connect, verify the host key, authenticate, exec.

use std::sync::Arc;

use crate::ssh::PublicKey;
use crate::ssh::agent::AgentClient;
use crate::ssh::connection::ChannelMsg;
use crate::ssh::keys::{RSA_SHA256, RSA_SHA512, SSH_RSA};
use crate::ssh::session::{Channel, Client, SessionConfig};
use crate::ssh::transport::{DEFAULT_HOST_KEY_ALGORITHMS, TransportConfig};
use crate::{HostVerifier, Inner, SshHookCall, SshTarget};

const AUTH_FAILED: &str = "All configured authentication methods failed";
const CLIENT_ID: &str = "SSH-2.0-gondolin-ssh-proxy";

/// Host key algorithms, those recorded in known_hosts for the target first
/// (OpenSSH does the same), so hosts with several keys verify against
/// whichever one the user has.
fn host_key_algorithms(inner: &Inner, target: &SshTarget) -> Vec<String> {
    let mut order: Vec<String> = Vec::new();
    if let HostVerifier::KnownHosts(known) = &inner.verifier {
        let recorded = known.key_types(&target.hostname, target.port);
        for alg in DEFAULT_HOST_KEY_ALGORITHMS {
            let wanted = recorded.iter().any(|r| {
                // an `ssh-rsa` known_hosts key covers every RSA signature hash
                r == alg || (r == SSH_RSA && (*alg == RSA_SHA256 || *alg == RSA_SHA512))
            });
            if wanted {
                order.push(alg.to_string());
            }
        }
    }
    for alg in DEFAULT_HOST_KEY_ALGORITHMS {
        if !order.iter().any(|o| o == alg) {
            order.push(alg.to_string());
        }
    }
    order
}

async fn verify_host_key(inner: &Inner, target: &SshTarget, key: &PublicKey) -> bool {
    let blob = key.to_blob();
    match &inner.verifier {
        HostVerifier::KnownHosts(known) => known.verify(&target.hostname, &blob, target.port),
        HostVerifier::Hook => inner
            .hooks
            .ssh_hook_call(SshHookCall::HostVerify {
                hostname: target.hostname.clone(),
                port: target.port,
                key: blob,
            })
            .await
            .map(|r| r.allow)
            .unwrap_or(false),
        HostVerifier::Reject => false,
    }
}

/// Connects, verifies and authenticates within the ready timeout.
pub(crate) async fn connect(
    inner: &Arc<Inner>,
    target: &SshTarget,
    guest_username: &str,
) -> Result<Client, String> {
    let work = async {
        let tcp = tokio::net::TcpStream::connect((target.hostname.as_str(), target.port))
            .await
            .map_err(|e| format!("connect {}:{} failed: {e}", target.hostname, target.port))?;
        let _ = tcp.set_nodelay(true);
        let mut transport = TransportConfig::client(CLIENT_ID);
        transport.host_key_algorithms = host_key_algorithms(inner, target);
        let session = SessionConfig {
            keepalive_interval: inner.keepalive_interval,
            keepalive_max: inner.keepalive_max,
            ..Default::default()
        };
        let client = Client::connect(tcp, transport, session).await.map_err(|e| e.to_string())?;
        let verified = match client.host_key() {
            Some(key) => verify_host_key(inner, target, key).await,
            None => false,
        };
        if !verified {
            client.disconnect();
            return Err("Host denied (verification failed)".to_string());
        }
        authenticate(inner, target, guest_username, &client).await?;
        Ok::<_, String>(client)
    };
    match tokio::time::timeout(inner.ready_timeout, work).await {
        Ok(result) => result,
        Err(_) => Err("Timed out while waiting for handshake".into()),
    }
}

async fn authenticate(
    inner: &Inner,
    target: &SshTarget,
    guest_username: &str,
    client: &Client,
) -> Result<(), String> {
    if let Some(index) = target.credential {
        let credential = &inner.credentials[index];
        let user = credential.username.clone().unwrap_or_else(|| "git".into());
        let ok = client
            .authenticate_publickey(&user, &credential.key)
            .await
            .map_err(|e| e.to_string())?;
        return if ok { Ok(()) } else { Err(AUTH_FAILED.into()) };
    }

    let Some(path) = &inner.agent else {
        return Err(AUTH_FAILED.into());
    };
    let user = if guest_username.is_empty() { "git" } else { guest_username };
    let mut agent = AgentClient::connect(path)
        .await
        .map_err(|e| format!("failed to connect to ssh agent at {}: {e}", path.display()))?;
    let identities = agent
        .identities()
        .await
        .map_err(|e| format!("failed to list ssh agent identities: {e}"))?;
    for identity in identities {
        // certificates and key types we cannot use are skipped
        let Ok(key) = PublicKey::from_blob(&identity.blob) else {
            continue;
        };
        match client.authenticate_agent(user, &mut agent, &key).await {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(e) => {
                gondolin_log::debug!(target: "gondolin::ssh", "ssh agent signing failed: {e}")
            }
        }
    }
    Err(AUTH_FAILED.into())
}

/// Opens a session channel and starts `command`.
pub(crate) async fn exec(client: &Client, command: &str) -> Result<Channel, String> {
    let channel = client.open_session().await.map_err(|e| e.to_string())?;
    channel.exec(true, command).map_err(|e| e.to_string())?;
    match channel.wait().await {
        Some(ChannelMsg::Success) => Ok(channel),
        Some(ChannelMsg::Failure) => Err("Unable to exec".into()),
        // Servers answer the exec request before anything else.
        Some(other) => Err(format!("unexpected upstream message before exec reply: {other:?}")),
        None => Err("upstream ssh closed before exec".into()),
    }
}

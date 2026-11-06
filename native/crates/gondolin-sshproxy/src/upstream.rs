//! Upstream SSH client: connect, verify the host key, authenticate, exec.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use russh::client::{self, Handle, Msg};
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::AgentClient;
use russh::keys::{Algorithm, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg, Disconnect};

use crate::{HostVerifier, Inner, SshHookCall, SshTarget};

const AUTH_FAILED: &str = "All configured authentication methods failed";

pub(crate) struct UpstreamHandler {
    inner: Arc<Inner>,
    hostname: String,
    port: u16,
    /// set when the host key was rejected (better error message)
    rejected: Arc<AtomicBool>,
}

impl client::Handler for UpstreamHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            self.rejected.store(true, Ordering::SeqCst);
            return Ok(false);
        };
        let Ok(blob) = key.to_bytes() else {
            self.rejected.store(true, Ordering::SeqCst);
            return Ok(false);
        };
        let ok = match &self.inner.verifier {
            HostVerifier::KnownHosts(known) => known.verify(&self.hostname, &blob, self.port),
            HostVerifier::Hook => self
                .inner
                .hooks
                .ssh_hook_call(SshHookCall::HostVerify {
                    hostname: self.hostname.clone(),
                    port: self.port,
                    key: blob,
                })
                .await
                .map(|r| r.allow)
                .unwrap_or(false),
            HostVerifier::Reject => false,
        };
        if !ok {
            self.rejected.store(true, Ordering::SeqCst);
        }
        Ok(ok)
    }
}

fn algorithm_from_name(name: &str) -> Option<Algorithm> {
    name.parse().ok()
}

/// Client config; host key algorithms recorded in known_hosts for the target
/// are preferred (OpenSSH does the same), so hosts with several keys verify
/// against whichever one the user has.
fn client_config(inner: &Inner, target: &SshTarget) -> client::Config {
    let mut config = client::Config {
        keepalive_interval: inner.keepalive_interval,
        keepalive_max: inner.keepalive_max,
        inactivity_timeout: None,
        nodelay: true,
        channel_buffer_size: crate::server::CHANNEL_BUFFER,
        window_on_consume: true,
        ..Default::default()
    };
    if let HostVerifier::KnownHosts(known) = &inner.verifier {
        let recorded: Vec<Algorithm> = known
            .key_types(&target.hostname, target.port)
            .iter()
            .filter_map(|name| algorithm_from_name(name))
            .collect();
        if !recorded.is_empty() {
            let mut order: Vec<Algorithm> = Vec::new();
            for alg in config.preferred.key.iter() {
                let wanted = recorded.iter().any(|r| match (r, alg) {
                    // an `ssh-rsa` known_hosts key covers every RSA signature hash
                    (Algorithm::Rsa { .. }, Algorithm::Rsa { .. }) => true,
                    _ => r == alg,
                });
                if wanted {
                    order.push(alg.clone());
                }
            }
            for alg in config.preferred.key.iter() {
                if !order.contains(alg) {
                    order.push(alg.clone());
                }
            }
            config.preferred.key = order.into();
        }
    }
    config
}

/// Connects, verifies and authenticates within the ready timeout.
pub(crate) async fn connect(
    inner: &Arc<Inner>,
    target: &SshTarget,
    guest_username: &str,
) -> Result<Handle<UpstreamHandler>, String> {
    let work = async {
        let tcp = tokio::net::TcpStream::connect((target.hostname.as_str(), target.port))
            .await
            .map_err(|e| format!("connect {}:{} failed: {e}", target.hostname, target.port))?;
        let _ = tcp.set_nodelay(true);
        let rejected = Arc::new(AtomicBool::new(false));
        let handler = UpstreamHandler {
            inner: inner.clone(),
            hostname: target.hostname.clone(),
            port: target.port,
            rejected: rejected.clone(),
        };
        let mut handle = client::connect_stream(
            Arc::new(client_config(inner, target)),
            crate::pump::Pumped::new(tcp),
            handler,
        )
        .await
        .map_err(|e| {
            if rejected.load(Ordering::SeqCst) {
                "Host denied (verification failed)".to_string()
            } else {
                e.to_string()
            }
        })?;
        authenticate(inner, target, guest_username, &mut handle).await?;
        Ok::<_, String>(handle)
    };
    match tokio::time::timeout(inner.ready_timeout, work).await {
        Ok(result) => result,
        Err(_) => Err("Timed out while waiting for handshake".into()),
    }
}

async fn rsa_hash(
    handle: &Handle<UpstreamHandler>,
    algorithm: &Algorithm,
) -> Result<Option<HashAlg>, String> {
    if !algorithm.clone().is_rsa() {
        return Ok(None);
    }
    Ok(handle.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten())
}

async fn authenticate(
    inner: &Inner,
    target: &SshTarget,
    guest_username: &str,
    handle: &mut Handle<UpstreamHandler>,
) -> Result<(), String> {
    if let Some(index) = target.credential {
        let credential = &inner.credentials[index];
        let user = credential.username.clone().unwrap_or_else(|| "git".into());
        let hash = rsa_hash(handle, &credential.key.algorithm()).await?;
        let result = handle
            .authenticate_publickey(user, PrivateKeyWithHashAlg::new(credential.key.clone(), hash))
            .await
            .map_err(|e| e.to_string())?;
        return if result.success() { Ok(()) } else { Err(AUTH_FAILED.into()) };
    }

    let Some(path) = &inner.agent else {
        return Err(AUTH_FAILED.into());
    };
    let user = if guest_username.is_empty() { "git" } else { guest_username };
    let mut agent = AgentClient::connect_uds(path)
        .await
        .map_err(|e| format!("failed to connect to ssh agent at {}: {e}", path.display()))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("failed to list ssh agent identities: {e}"))?;
    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        let hash = rsa_hash(handle, &key.algorithm()).await?;
        match handle.authenticate_publickey_with(user, key, hash, &mut agent).await {
            Ok(result) if result.success() => return Ok(()),
            Ok(_) => {}
            Err(e) => tracing::debug!(target: "gondolin::ssh", "ssh agent signing failed: {e}"),
        }
    }
    Err(AUTH_FAILED.into())
}

/// Opens a session channel and starts `command`.
pub(crate) async fn exec(
    handle: &Handle<UpstreamHandler>,
    command: &str,
) -> Result<Channel<Msg>, String> {
    let mut channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.exec(true, command).await.map_err(|e| e.to_string())?;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(channel),
            Some(ChannelMsg::Failure) => return Err("Unable to exec".into()),
            Some(ChannelMsg::WindowAdjusted { .. }) => {}
            Some(other) => {
                // Servers answer the exec request before anything else.
                return Err(format!("unexpected upstream message before exec reply: {other:?}"));
            }
            None => return Err("upstream ssh closed before exec".into()),
        }
    }
}

pub(crate) async fn disconnect(handle: Handle<UpstreamHandler>) {
    let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
}

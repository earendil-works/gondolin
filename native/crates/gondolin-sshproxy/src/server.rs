//! Guest-facing SSH server and the per-exec bridge to upstream.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use gondolin_netstack::{FlowControl, TcpFlow};
use tokio::task::JoinSet;

use crate::ssh::PrivateKey;
use crate::ssh::connection::{ChannelMsg, ChannelRequest};
use crate::ssh::session::{Channel, Server, SessionConfig};
use crate::ssh::transport::TransportConfig;
use crate::{Inner, SshConfigError, SshExecRequest, SshHookCall, SshTarget, upstream};

/// Identification string of the guest-facing server (as the node engine).
const SERVER_ID: &str = "SSH-2.0-gondolin-ssh-proxy";

pub(crate) fn ephemeral_host_key() -> Result<PrivateKey, SshConfigError> {
    PrivateKey::generate_ed25519()
        .map_err(|_| SshConfigError("failed to generate ssh host key".into()))
}

/// The guest-facing server's configuration.
///
/// Both of our sessions advertise SSH window only as the bridge consumes data
/// (a channel holds at most one window, 2 MiB). Flow control is the SSH
/// window: a direction blocked on its far side stops consuming, its sender
/// runs out of window, and the connection keeps being read, so window adjusts
/// for the other direction get through.
pub(crate) fn server_config(host_key: PrivateKey) -> (TransportConfig, SessionConfig) {
    (TransportConfig::server(SERVER_ID, vec![host_key]), SessionConfig::default())
}

pub(crate) async fn serve(inner: Arc<Inner>, flow: TcpFlow, target: SshTarget) {
    let TcpFlow { meta, stream, control } = flow;
    gondolin_log::debug!(target: "gondolin::ssh", "flow {}: ssh proxy start {} -> {}:{}", meta.id,
        meta.src,
        target.hostname,
        target.port
    );
    let ctx = Arc::new(FlowCtx {
        inner: inner.clone(),
        target,
        src: meta.src,
        control: control.clone(),
        upstreams: AtomicUsize::new(0),
        flow_id: meta.id,
    });
    let (transport, session) = inner.server_config.clone();
    // Any authentication is accepted: the guest is not trusted with anything
    // by authenticating; upstream auth happens with host-side credentials.
    let server = match Server::start(stream, transport, session, Arc::new(|_| true)) {
        Ok(server) => server,
        Err(err) => {
            gondolin_log::debug!(target: "gondolin::ssh", "flow {}: ssh proxy error: {err}", meta.id);
            control.abort();
            return;
        }
    };
    // channel tasks; dropped (aborted) with the connection
    let mut tasks = JoinSet::new();
    while let Some(channel) = server.accept().await {
        let username = server.user().unwrap_or_default();
        tasks.spawn(channel_task(ctx.clone(), channel, username));
        while tasks.try_join_next().is_some() {}
    }
    if let Some(err) = server.closed().await {
        gondolin_log::debug!(target: "gondolin::ssh", "flow {}: ssh proxy error: {err}", meta.id);
        control.abort();
    }
}

/// Per guest connection.
struct FlowCtx {
    inner: Arc<Inner>,
    target: SshTarget,
    src: SocketAddr,
    control: FlowControl,
    /// upstream connections of this flow
    upstreams: AtomicUsize,
    flow_id: u64,
}

async fn finish(channel: &Channel, stderr: Option<String>, exit: u32) {
    if let Some(message) = stderr {
        let _ = channel.extended_data(1, message.as_bytes()).await;
    }
    let _ = channel.exit_status(exit);
    let _ = channel.eof();
    let _ = channel.close();
}

async fn channel_task(ctx: Arc<FlowCtx>, channel: Channel, username: String) {
    loop {
        let Some(m) = channel.wait().await else { return };
        let ChannelMsg::Request { request, want_reply } = m else { continue };
        match request {
            ChannelRequest::Exec { command } => {
                if want_reply {
                    let _ = channel.reply(true);
                }
                let command = String::from_utf8_lossy(&command).into_owned();
                exec(ctx, channel, username, command).await;
                return;
            }
            ChannelRequest::Shell => {
                // accepted, then answered with an error (node behavior)
                if want_reply {
                    let _ = channel.reply(true);
                }
                finish(
                    &channel,
                    Some("gondolin ssh proxy: interactive shells are not supported\n".into()),
                    1,
                )
                .await;
                return;
            }
            ChannelRequest::Subsystem { name } => {
                gondolin_log::debug!(target: "gondolin::ssh", "flow {}: ssh subsystem {name:?} denied", ctx.flow_id);
                if want_reply {
                    let _ = channel.reply(false);
                }
            }
            ChannelRequest::Pty { .. }
            | ChannelRequest::Env { .. }
            | ChannelRequest::WindowChange { .. } => {
                if want_reply {
                    let _ = channel.reply(true);
                }
            }
            _ => {
                if want_reply {
                    let _ = channel.reply(false);
                }
            }
        }
    }
}

/// Releases upstream connection slots.
struct Slot<'a> {
    flow: &'a AtomicUsize,
    total: &'a AtomicUsize,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.flow.fetch_sub(1, Ordering::SeqCst);
        self.total.fetch_sub(1, Ordering::SeqCst);
    }
}

fn acquire_slot(ctx: &FlowCtx) -> Result<Slot<'_>, String> {
    let inner = &ctx.inner;
    if ctx.upstreams.fetch_add(1, Ordering::SeqCst) >= inner.max_per_flow {
        ctx.upstreams.fetch_sub(1, Ordering::SeqCst);
        return Err(format!(
            "too many concurrent upstream ssh connections for this guest flow (limit {})",
            inner.max_per_flow
        ));
    }
    if inner.total.fetch_add(1, Ordering::SeqCst) >= inner.max_total {
        inner.total.fetch_sub(1, Ordering::SeqCst);
        ctx.upstreams.fetch_sub(1, Ordering::SeqCst);
        return Err(format!(
            "too many concurrent upstream ssh connections on host (limit {})",
            inner.max_total
        ));
    }
    Ok(Slot { flow: &ctx.upstreams, total: &inner.total })
}

enum Rejection {
    /// execPolicy denied: optional stderr message, exit code
    Denied(Option<String>, u32),
    /// anything else: reported as `gondolin ssh proxy error: ...`, exit 255
    Error(String),
}

async fn exec(ctx: Arc<FlowCtx>, guest: Channel, username: String, command: String) {
    let flow_id = ctx.flow_id;
    let target = &ctx.target;
    let prepared = async {
        if ctx.inner.exec_policy_hook {
            let request = SshExecRequest {
                hostname: target.hostname.clone(),
                port: target.port,
                guest_username: username.clone(),
                command: command.clone(),
                src_ip: ctx.src.ip().to_string(),
                src_port: ctx.src.port(),
            };
            let decision = ctx
                .inner
                .hooks
                .ssh_hook_call(SshHookCall::ExecPolicy { request })
                .await
                .map_err(Rejection::Error)?;
            if !decision.allow {
                gondolin_log::debug!(target: "gondolin::ssh", "flow {}: ssh proxy exec denied {}:{} {command:?}", flow_id,
                    target.hostname,
                    target.port
                );
                return Err(Rejection::Denied(
                    decision.message.map(|m| format!("{m}\n")),
                    decision.exit_code.unwrap_or(1),
                ));
            }
        }
        let slot = acquire_slot(&ctx).map_err(Rejection::Error)?;
        let upstream =
            upstream::connect(&ctx.inner, target, &username).await.map_err(Rejection::Error)?;
        let channel = upstream::exec(&upstream, &command).await.map_err(Rejection::Error)?;
        Ok((slot, upstream, channel))
    };
    let (slot, upstream, up) = match prepared.await {
        Ok(ok) => ok,
        Err(Rejection::Denied(message, code)) => {
            finish(&guest, message, code).await;
            return;
        }
        Err(Rejection::Error(message)) => {
            gondolin_log::debug!(target: "gondolin::ssh", "flow {}: ssh proxy exec failed: {message}", flow_id);
            finish(&guest, Some(format!("gondolin ssh proxy error: {message}\n")), 255).await;
            return;
        }
    };
    gondolin_log::debug!(target: "gondolin::ssh", "flow {}: ssh proxy exec {} {command:?}", flow_id, target.hostname);

    let guest_closed = AtomicBool::new(false);

    // guest -> upstream
    let to_upstream = async {
        loop {
            match guest.wait().await {
                Some(ChannelMsg::Data(data)) => {
                    // once the upstream closed its side, stdin is dropped while
                    // the output still drains to the guest
                    let _ = up.data(&data).await;
                }
                Some(ChannelMsg::Eof) => {
                    let _ = up.eof();
                }
                Some(ChannelMsg::Request { request, want_reply }) => {
                    let ok = match request {
                        ChannelRequest::Signal { name } => {
                            let _ = up.request(&ChannelRequest::Signal { name }, false);
                            true
                        }
                        ChannelRequest::WindowChange { .. }
                        | ChannelRequest::Env { .. }
                        | ChannelRequest::Pty { .. } => true,
                        _ => false,
                    };
                    if want_reply {
                        let _ = guest.reply(ok);
                    }
                }
                Some(ChannelMsg::Close) | None => {
                    guest_closed.store(true, Ordering::SeqCst);
                    let _ = up.close();
                    break;
                }
                Some(_) => {}
            }
        }
    };

    // upstream -> guest
    let to_guest = async {
        loop {
            match up.wait().await {
                Some(ChannelMsg::Data(data)) => {
                    if guest.data(&data).await.is_err() {
                        break;
                    }
                }
                Some(ChannelMsg::ExtendedData { ext, data }) => {
                    if guest.extended_data(ext, &data).await.is_err() {
                        break;
                    }
                }
                Some(ChannelMsg::Request { request, want_reply }) => match request {
                    ChannelRequest::ExitStatus { code } => {
                        let _ = guest.exit_status(code);
                    }
                    request @ ChannelRequest::ExitSignal { .. } => {
                        let _ = guest.request(&request, false);
                    }
                    _ => {
                        if want_reply {
                            let _ = up.reply(false);
                        }
                    }
                },
                Some(ChannelMsg::Eof) => {
                    let _ = guest.eof();
                }
                Some(ChannelMsg::Close) => {
                    let _ = guest.close();
                    break;
                }
                None => {
                    if !guest_closed.load(Ordering::SeqCst) {
                        // Upstream connection lost mid-exec (node: ssh-upstream-error).
                        gondolin_log::debug!(target: "gondolin::ssh", "flow {}: ssh upstream connection lost", flow_id);
                        ctx.control.abort();
                    }
                    break;
                }
                Some(_) => {}
            }
        }
    };

    // Once either side closed the channel the other direction has nothing left
    // to deliver (closing peers don't confirm reliably), so stop both.
    gondolin_netstack::race(to_upstream, to_guest).await;
    drop(up);
    upstream.disconnect();
    drop(slot);
}

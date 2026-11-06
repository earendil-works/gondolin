//! Guest-facing SSH server and the per-exec bridge to upstream.

use std::borrow::Cow;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use gondolin_netstack::{FlowControl, TcpFlow};
use russh::keys::PrivateKey;
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId, ChannelMsg, MethodKind, MethodSet, SshId};
use tokio::task::JoinSet;

use crate::{Inner, SshConfigError, SshExecRequest, SshHookCall, SshTarget, upstream};

/// Identification string of the guest-facing server (as the node engine).
const SERVER_ID: &str = "SSH-2.0-gondolin-ssh-proxy";
/// Messages (≤ 32 KiB each) russh buffers per channel before it stops reading
/// the whole connection. russh grants SSH window eagerly, so this buffer is
/// the real flow control; it must be large enough that a channel saturated in
/// both directions (guest→upstream blocked on upstream, upstream→guest blocked
/// on the guest) does not stall both connections at once.
pub(crate) const CHANNEL_BUFFER: usize = 256;

pub(crate) fn ephemeral_host_key() -> Result<PrivateKey, SshConfigError> {
    let mut seed = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut seed)
        .map_err(|_| SshConfigError("failed to generate ssh host key".into()))?;
    Ok(PrivateKey::from(Ed25519Keypair::from_seed(&seed)))
}

pub(crate) fn server_config(host_key: PrivateKey) -> Arc<server::Config> {
    Arc::new(server::Config {
        server_id: SshId::Standard(Cow::Borrowed(SERVER_ID)),
        methods: MethodSet::from(
            &[
                MethodKind::None,
                MethodKind::Password,
                MethodKind::PublicKey,
                MethodKind::KeyboardInteractive,
            ][..],
        ),
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        keys: vec![host_key],
        // The guest connection lives as long as the guest wants it to.
        inactivity_timeout: None,
        nodelay: true,
        channel_buffer_size: CHANNEL_BUFFER,
        ..Default::default()
    })
}

pub(crate) async fn serve(inner: Arc<Inner>, flow: TcpFlow, target: SshTarget) {
    let TcpFlow { meta, stream, control } = flow;
    tracing::debug!(
        target: "gondolin::ssh",
        flow = meta.id,
        "ssh proxy start {} -> {}:{}",
        meta.src,
        target.hostname,
        target.port
    );
    let handler = GuestHandler {
        ctx: Arc::new(FlowCtx {
            inner: inner.clone(),
            target,
            src: meta.src,
            control: control.clone(),
            upstreams: AtomicUsize::new(0),
            flow_id: meta.id,
        }),
        username: String::new(),
        tasks: JoinSet::new(),
    };
    let result = match server::run_stream(inner.server_config.clone(), stream, handler).await {
        Ok(session) => session.await,
        Err(e) => Err(e),
    };
    if let Err(err) = result {
        tracing::debug!(target: "gondolin::ssh", flow = meta.id, "ssh proxy error: {err}");
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

struct GuestHandler {
    ctx: Arc<FlowCtx>,
    /// username the guest authenticated as
    username: String,
    /// channel tasks; dropped (aborted) with the connection
    tasks: JoinSet<()>,
}

impl GuestHandler {
    fn accept(&mut self, user: &str) -> Result<Auth, russh::Error> {
        if !user.is_empty() {
            self.username = user.to_string();
        }
        Ok(Auth::Accept)
    }
}

impl server::Handler for GuestHandler {
    type Error = russh::Error;

    // Any authentication is accepted: the guest is not trusted with anything
    // by authenticating; upstream auth happens with host-side credentials.
    async fn auth_none(&mut self, user: &str) -> Result<Auth, Self::Error> {
        self.accept(user)
    }

    async fn auth_password(&mut self, user: &str, _password: &str) -> Result<Auth, Self::Error> {
        self.accept(user)
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        _key: russh::server::VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        self.accept(user)
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        user: &str,
        _submethods: &str,
        _response: Option<server::Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        self.accept(user)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        let ctx = self.ctx.clone();
        let username = self.username.clone();
        let handle = session.handle();
        self.tasks.spawn(channel_task(ctx, channel, handle, username));
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)
    }

    async fn env_request(
        &mut self,
        channel: ChannelId,
        _name: &str,
        _value: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Accepted, then answered with an error by the channel task (node behavior).
        session.channel_success(channel)
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        tracing::debug!(target: "gondolin::ssh", flow = self.ctx.flow_id, "ssh subsystem {name:?} denied");
        session.channel_failure(channel)
    }
}

async fn finish(writer: &russh::ChannelWriteHalf<Msg>, stderr: Option<String>, exit: u32) {
    if let Some(message) = stderr {
        let _ = writer.extended_data_bytes(1, message.into_bytes()).await;
    }
    let _ = writer.exit_status(exit).await;
    let _ = writer.eof().await;
    let _ = writer.close().await;
}

async fn channel_task(
    ctx: Arc<FlowCtx>,
    channel: Channel<Msg>,
    handle: server::Handle,
    username: String,
) {
    let id = channel.id();
    let (mut reader, writer) = channel.split();
    loop {
        match reader.wait().await {
            Some(ChannelMsg::Exec { command, .. }) => {
                let command = String::from_utf8_lossy(&command).into_owned();
                exec(ctx, id, reader, writer, handle, username, command).await;
                return;
            }
            Some(ChannelMsg::RequestShell { .. }) => {
                finish(
                    &writer,
                    Some("gondolin ssh proxy: interactive shells are not supported\n".into()),
                    1,
                )
                .await;
                return;
            }
            Some(_) => {}
            None => return,
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

fn acquire_slot<'a>(ctx: &'a FlowCtx) -> Result<Slot<'a>, String> {
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

async fn exec(
    ctx: Arc<FlowCtx>,
    id: ChannelId,
    mut guest_rd: russh::ChannelReadHalf,
    guest_wr: russh::ChannelWriteHalf<Msg>,
    handle: server::Handle,
    username: String,
    command: String,
) {
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
                tracing::debug!(
                    target: "gondolin::ssh",
                    flow = flow_id,
                    "ssh proxy exec denied {}:{} {command:?}",
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
    let (slot, upstream, up_channel) = match prepared.await {
        Ok(ok) => ok,
        Err(Rejection::Denied(message, code)) => {
            finish(&guest_wr, message, code).await;
            return;
        }
        Err(Rejection::Error(message)) => {
            tracing::debug!(target: "gondolin::ssh", flow = flow_id, "ssh proxy exec failed: {message}");
            finish(&guest_wr, Some(format!("gondolin ssh proxy error: {message}\n")), 255).await;
            return;
        }
    };
    tracing::debug!(target: "gondolin::ssh", flow = flow_id, "ssh proxy exec {} {command:?}", target.hostname);

    let (mut up_rd, up_wr) = up_channel.split();
    let guest_closed = AtomicBool::new(false);

    // guest -> upstream
    let to_upstream = async {
        loop {
            match guest_rd.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    if up_wr.data_bytes(data).await.is_err() {
                        break;
                    }
                }
                Some(ChannelMsg::Eof) => {
                    let _ = up_wr.eof().await;
                }
                Some(ChannelMsg::Signal { signal }) => {
                    let _ = up_wr.signal(signal).await;
                }
                Some(ChannelMsg::Close) | None => {
                    guest_closed.store(true, Ordering::SeqCst);
                    let _ = up_wr.close().await;
                    break;
                }
                Some(_) => {}
            }
        }
    };

    // upstream -> guest
    let to_guest = async {
        loop {
            match up_rd.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    if guest_wr.data_bytes(data).await.is_err() {
                        break;
                    }
                }
                Some(ChannelMsg::ExtendedData { data, ext }) => {
                    if guest_wr.extended_data_bytes(ext, data).await.is_err() {
                        break;
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    let _ = guest_wr.exit_status(exit_status).await;
                }
                Some(ChannelMsg::ExitSignal {
                    signal_name,
                    core_dumped,
                    error_message,
                    lang_tag,
                }) => {
                    let _ = handle
                        .exit_signal_request(id, signal_name, core_dumped, error_message, lang_tag)
                        .await;
                }
                Some(ChannelMsg::Eof) => {
                    let _ = guest_wr.eof().await;
                }
                Some(ChannelMsg::Close) => {
                    let _ = guest_wr.close().await;
                    break;
                }
                None => {
                    if !guest_closed.load(Ordering::SeqCst) {
                        // Upstream connection lost mid-exec (node: ssh-upstream-error).
                        tracing::debug!(target: "gondolin::ssh", flow = flow_id, "ssh upstream connection lost");
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
    tokio::select! {
        () = to_upstream => {}
        () = to_guest => {}
    }
    upstream::disconnect(upstream).await;
    drop(slot);
}

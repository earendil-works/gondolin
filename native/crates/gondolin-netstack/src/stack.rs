//! The stack: QEMU netdev transport, L2/L3 dispatch, DHCP/DNS/ICMP, and the
//! smoltcp interface terminating guest TCP.
//!
//! Concurrency: all protocol state lives in one [`State`] behind a mutex.
//! `serve` runs three futures: the reader (frames from QEMU → state), the
//! writer (queued frames → QEMU) and the ticker (smoltcp timers and polls
//! requested by flow streams). Flow streams lock the state to move bytes in and
//! out of their smoltcp socket buffers, mark their entry dirty and wake the ticker.
//!
//! Each TCP socket sits alone in its own smoltcp `SocketSet`: smoltcp finds the
//! socket of a packet and the sockets with something to send by scanning the
//! whole set, so with one shared set every packet cost O(open connections).
//! Guest packets are routed by their 4-tuple instead, and a poll only touches
//! the entries that got packets, were used by their stream, or have a timer due.

use std::cmp::Reverse;
use std::collections::hash_map::RandomState;
use std::collections::{BinaryHeap, HashMap, VecDeque};
use std::future::Future;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::pin::Pin;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};
use smoltcp::iface::{
    Config as IfaceConfig, Interface, PollIngressSingleResult, SocketHandle, SocketSet,
};
use smoltcp::phy::{self, DeviceCapabilities, Medium};
use smoltcp::socket::tcp;
use smoltcp::time::Instant as SmolInstant;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr, IpListenEndpoint};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::UdpSocket;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::config::{DnsMode, MacAddr, NetConfig, SyntheticHostMapping};
use crate::dns::{self, SyntheticAnswer, SyntheticHostMap};
use crate::flow;
use crate::frames::FrameSocket;
use crate::offload::{self, VNET_HDR_LEN, VnetHdr};
use crate::wire::{self, Ipv4};
use crate::{FlowHandler, FlowMeta, SyntheticHostLookup, TcpFlow};

/// Largest Ethernet frame accepted from QEMU in `bytes`; anything larger means
/// the stream is desynchronized.
const MAX_FRAME_LEN: usize = 65_550;
/// Read buffer growth step in `bytes`.
const READ_CHUNK: usize = 256 * 1024;

/// Errors constructing or serving a [`NetStack`].
#[derive(Debug)]
pub enum NetStackError {
    NoTrustedResolvers,
    InvalidConfig(String),
}

impl std::fmt::Display for NetStackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetStackError::NoTrustedResolvers => f.write_str(
                "dns mode 'trusted' requires at least one IPv4 resolver (none found); configure dns.trusted_servers or an IPv4 resolver on the host",
            ),
            NetStackError::InvalidConfig(m) => write!(f, "invalid network configuration: {m}"),
        }
    }
}

impl std::error::Error for NetStackError {}

/// Counters for diagnostics and tests.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetStats {
    /// smoltcp TCP sockets (listening, handshaking, open and closing)
    pub tcp_sockets: usize,
    /// flows handed to the [`FlowHandler`] and not yet fully closed
    pub tcp_flows: usize,
    /// open upstream UDP (DNS) sockets
    pub udp_sessions: usize,
    /// framed bytes queued for QEMU (incl. the write in progress)
    pub tx_queued_bytes: usize,
    /// frames dropped because the QEMU queue hit its cap
    pub tx_dropped_frames: u64,
    /// smoltcp polls so far (diagnostics: detects busy loops)
    pub polls: u64,
    /// stream reads released by [`READ_HOLD`] expiring instead of a PSH
    pub read_hold_timeouts: u64,
}

/// Userspace network stack serving one QEMU stream netdev at a time.
pub struct NetStack {
    shared: Arc<Shared>,
}

impl NetStack {
    /// Validates `config` and builds the stack. Fails fast in `trusted` DNS mode
    /// without usable IPv4 resolvers.
    pub fn new(config: NetConfig, handler: Arc<dyn FlowHandler>) -> Result<Self, NetStackError> {
        Self::with_system_resolvers(config, handler, dns::system_ipv4_resolvers())
    }

    /// Like [`NetStack::new`] with an explicit list standing in for the host's
    /// resolvers (`trusted` default and `open` DHCP advertisement).
    pub fn with_system_resolvers(
        config: NetConfig,
        handler: Arc<dyn FlowHandler>,
        system_resolvers: Vec<Ipv4Addr>,
    ) -> Result<Self, NetStackError> {
        if config.prefix_len == 0 || config.prefix_len > 30 {
            return Err(NetStackError::InvalidConfig("prefix_len must be 1..=30".into()));
        }
        if config.mtu < 576 {
            return Err(NetStackError::InvalidConfig("mtu must be at least 576".into()));
        }
        if config.gateway_ip == config.guest_ip {
            return Err(NetStackError::InvalidConfig("gateway_ip and guest_ip must differ".into()));
        }
        if !config.gateway_mac.is_unicast() {
            return Err(NetStackError::InvalidConfig("gateway_mac must be unicast".into()));
        }
        let limits = &config.limits;
        if limits.tcp_rx_buffer_bytes < 2048
            || limits.tcp_tx_buffer_bytes < 2048
            || limits.tcp_rx_buffer_bytes > (1 << 30)
        {
            return Err(NetStackError::InvalidConfig(
                "tcp buffers must be between 2 KiB and 1 GiB".into(),
            ));
        }

        let trusted = if config.dns.trusted_servers.is_empty() {
            system_resolvers.clone()
        } else {
            config.dns.trusted_servers.clone()
        };
        if config.dns.mode == DnsMode::Trusted && trusted.is_empty() {
            return Err(NetStackError::NoTrustedResolvers);
        }
        let dhcp_dns = match config.dns.mode {
            DnsMode::Open => dns::guest_reachable_resolvers(&system_resolvers),
            DnsMode::Synthetic | DnsMode::Trusted => vec![config.gateway_ip],
        };

        let state = State::new(&config, 0, Instant::now());
        let shared = Arc::new(Shared {
            state: Mutex::new(state),
            poll_notify: Notify::new(),
            read_hold_bytes: (config.limits.tcp_rx_buffer_bytes / 4).min(64 * 1024),
            tx_notify: Notify::new(),
            tx_drained: Notify::new(),
            handler,
            hosts: Arc::new(SyntheticHostMap::new()),
            dhcp_dns,
            trusted,
            dns_upstream_port: AtomicU16::new(53),
            epoch: Instant::now(),
            config,
        });
        Ok(NetStack { shared })
    }

    /// The synthetic hostname table (per-host mapping); shared with egress.
    pub fn synthetic_hosts(&self) -> Arc<SyntheticHostMap> {
        self.shared.hosts.clone()
    }

    /// Same table as a trait object.
    pub fn host_lookup(&self) -> Arc<dyn SyntheticHostLookup> {
        self.shared.hosts.clone()
    }

    /// Overrides the upstream DNS port (tests run resolvers on unprivileged ports).
    #[doc(hidden)]
    pub fn set_dns_upstream_port(&self, port: u16) {
        self.shared.dns_upstream_port.store(port, Ordering::Relaxed);
    }

    pub fn config(&self) -> &NetConfig {
        &self.shared.config
    }

    /// The DNS servers the guest is offered over DHCP.
    pub fn guest_dns_servers(&self) -> Vec<Ipv4Addr> {
        crate::dhcp::offered_dns(&self.shared.dhcp_dns)
    }

    pub fn stats(&self) -> NetStats {
        let st = self.shared.lock();
        NetStats {
            tcp_sockets: st.entries.len(),
            tcp_flows: st
                .entries
                .values()
                .filter(|e| !matches!(e.phase, Phase::Handshake { .. }))
                .count(),
            udp_sessions: st.udp.len(),
            tx_queued_bytes: st.device.tx.len() + st.device.tx_inflight,
            tx_dropped_frames: st.tx_dropped,
            polls: st.polls,
            read_hold_timeouts: st.read_hold_timeouts,
        }
    }

    /// Serves QEMU's stream netdev on `stream` until it closes (QEMU exited) or
    /// fails. All flows of the session are aborted when it returns; a later call
    /// starts a fresh session (like the node engine on socket reattach), keeping
    /// the synthetic host table.
    pub async fn serve<S>(&self, stream: S) -> io::Result<()>
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let shared = &self.shared;
        let _guard = self.begin_session()?;
        let (rd, wr) = tokio::io::split(stream);
        crate::race(
            reader(shared, rd),
            crate::race(writer(shared, wr), async {
                ticker(shared).await;
                Ok(())
            }),
        )
        .await
    }

    /// Serves raw Ethernet frames on `socket` (one frame per datagram, see
    /// [`FrameSocket`]) until the socket fails or the future is dropped. Like
    /// [`NetStack::serve`], all flows of the session are aborted when it
    /// returns and a later call starts a fresh session.
    pub async fn serve_frames<F: FrameSocket + ?Sized>(&self, socket: Arc<F>) -> io::Result<()> {
        let shared = &self.shared;
        let _guard = self.begin_session()?;
        crate::race(
            frame_reader(shared, &*socket),
            crate::race(frame_writer(shared, &*socket), async {
                ticker(shared).await;
                Ok(())
            }),
        )
        .await
    }

    /// Starts a netdev session; the guard shuts it down when dropped.
    fn begin_session(&self) -> io::Result<SessionGuard<'_>> {
        let shared = &self.shared;
        {
            let mut st = shared.lock();
            if st.running {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "netstack is already serving a netdev stream",
                ));
            }
            let session = st.session + 1;
            let next_flow_id = st.next_flow_id;
            *st = State::new(&shared.config, session, shared.epoch);
            st.next_flow_id = next_flow_id;
            st.running = true;
        }
        Ok(SessionGuard(shared))
    }
}

/// Shuts the netdev session down even if the serving future is dropped.
struct SessionGuard<'a>(&'a Shared);

impl Drop for SessionGuard<'_> {
    fn drop(&mut self) {
        self.0.lock().shutdown();
    }
}

/// Phase of a TCP socket tracked outside smoltcp.
pub(crate) enum Phase {
    /// SYN received, waiting for the guest's ACK
    Handshake { deadline: Instant },
    /// handed to the flow handler; the stream owns it
    Open { id: u64 },
    /// stream dropped (or handshake failed); removed once fully closed
    Orphan { deadline: Instant },
}

/// Key of a TCP socket entry (unique within a [`State`]).
pub(crate) type FlowKey = u64;

pub(crate) struct Entry {
    pub(crate) phase: Phase,
    /// guest address, destination address
    tuple: (SocketAddrV4, SocketAddrV4),
    /// set by [`crate::FlowControl::abort`]
    pub(crate) aborted: bool,
    /// the connection's socket, alone in its set (see the module docs)
    set: SocketSet<'static>,
    handle: SocketHandle,
    /// guest packets for the next poll
    rx: VecDeque<Bytes>,
    /// queued in `State::dirty`
    dirty: bool,
    /// queued in `State::blocked`
    blocked: bool,
    /// when the entry needs its next poll (smoltcp timer, phase or read deadline)
    wake_at: Option<Instant>,
    /// a packet with PSH, FIN or RST is queued in `rx`
    rx_push: bool,
    /// the receive buffer holds data up to a PSH (or FIN/RST): hand it out
    pub(crate) push: bool,
    /// stream waiting for a push or more data (see [`READ_HOLD`])
    pub(crate) read_waker: Option<Waker>,
    /// when a held read is released anyway
    pub(crate) read_deadline: Option<Instant>,
}

impl Entry {
    pub(crate) fn socket(&mut self) -> &mut tcp::Socket<'static> {
        self.set.get_mut::<tcp::Socket>(self.handle)
    }

    pub(crate) fn wake_reader(&mut self) {
        self.read_deadline = None;
        if let Some(waker) = self.read_waker.take() {
            waker.wake();
        }
    }
}

/// Longest a stream read is held back waiting for a PSH.
///
/// Guest data is handed to the flow when a segment with PSH (the end of a
/// guest write; Linux also pushes every half window), FIN or RST arrived, or
/// [`Shared::read_hold_bytes`] are buffered. Without this the flow task ran per
/// QEMU read (a few segments), and so did everything downstream (an upstream
/// write syscall per ~6 KiB of upload). A guest that never pushes still gets
/// its data after this delay.
pub const READ_HOLD: Duration = Duration::from_millis(1);

pub(crate) struct Shared {
    state: Mutex<State>,
    /// asks the ticker to poll smoltcp (data written/read by a flow, queue drained)
    pub(crate) poll_notify: Notify,
    /// buffered guest data in `bytes` that releases a held read (see [`READ_HOLD`])
    pub(crate) read_hold_bytes: usize,
    /// tells the writer frames are queued
    tx_notify: Notify,
    /// tells the reader the writer finished a write
    tx_drained: Notify,
    handler: Arc<dyn FlowHandler>,
    hosts: Arc<SyntheticHostMap>,
    /// DNS servers advertised via DHCP
    dhcp_dns: Vec<Ipv4Addr>,
    /// upstream resolvers for `trusted` mode
    trusted: Vec<Ipv4Addr>,
    /// UDP port DNS is forwarded to (53; tests override it)
    dns_upstream_port: AtomicU16,
    epoch: Instant,
    config: NetConfig,
}

impl Shared {
    pub(crate) fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn linger_ms(&self) -> u64 {
        self.config.limits.tcp_linger_timeout_ms
    }

    fn smol_now(&self, now: Instant) -> SmolInstant {
        SmolInstant::from_micros(now.saturating_duration_since(self.epoch).as_micros() as i64)
    }
}

/// smoltcp device: IP packets from the guest in, framed Ethernet to QEMU out.
pub(crate) struct Device {
    rx: VecDeque<Bytes>,
    /// QEMU-framed bytes waiting for the writer
    tx: BytesMut,
    /// bytes the writer took and has not finished writing
    tx_inflight: usize,
    /// queued bytes above which entries are not polled for egress
    tx_soft: usize,
    mtu: usize,
    /// skip verifying guest TCP checksums (checksum offload)
    checksum_offload: bool,
    gateway_mac: MacAddr,
    guest_mac: MacAddr,
}

impl Device {
    fn queued(&self) -> usize {
        self.tx.len() + self.tx_inflight
    }

    fn over_soft_cap(&self) -> bool {
        self.queued() >= self.tx_soft
    }
}

pub(crate) struct RxTok(Bytes);

impl phy::RxToken for RxTok {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

pub(crate) struct TxTok<'a> {
    tx: &'a mut BytesMut,
    dst: MacAddr,
    src: MacAddr,
}

impl phy::TxToken for TxTok<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut out = None;
        wire::put_frame(self.tx, self.dst, self.src, wire::ETHERTYPE_IPV4, len, |buf| {
            out = Some(f(buf));
        });
        out.expect("frame body written")
    }
}

impl phy::Device for Device {
    type RxToken<'a> = RxTok;
    type TxToken<'a> = TxTok<'a>;

    fn receive(&mut self, _ts: SmolInstant) -> Option<(RxTok, TxTok<'_>)> {
        let packet = self.rx.pop_front()?;
        Some((
            RxTok(packet),
            TxTok { tx: &mut self.tx, dst: self.guest_mac, src: self.gateway_mac },
        ))
    }

    fn transmit(&mut self, _ts: SmolInstant) -> Option<TxTok<'_>> {
        // Never refused: smoltcp loses a pending fast retransmit when emitting
        // it fails (the retransmit timer is cleared first). The soft cap is
        // applied per poll instead (`State::poll_entry`).
        Some(TxTok { tx: &mut self.tx, dst: self.guest_mac, src: self.gateway_mac })
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ip;
        caps.max_transmission_unit = self.mtu;
        if self.checksum_offload {
            // compute ours, accept the guest's partial ones
            caps.checksum.tcp = smoltcp::phy::Checksum::Tx;
            caps.checksum.udp = smoltcp::phy::Checksum::Tx;
        }
        caps
    }
}

struct UdpSession {
    /// send side: a plain non-blocking socket, so sends never wait on reactor readiness
    sender: std::net::UdpSocket,
    generation: u64,
    last_used: Instant,
    task: JoinHandle<()>,
}

impl Drop for UdpSession {
    fn drop(&mut self) {
        self.task.abort();
    }
}

type Tuple = (SocketAddrV4, SocketAddrV4);

pub(crate) struct State {
    /// increments per `serve`; streams of older sessions are dead
    pub(crate) session: u64,
    pub(crate) running: bool,
    iface: Interface,
    device: Device,
    pub(crate) entries: HashMap<FlowKey, Entry>,
    tuples: HashMap<Tuple, FlowKey>,
    next_key: FlowKey,
    /// entries to poll (packets, stream activity, due timers)
    dirty: Vec<FlowKey>,
    /// entries that could not transmit because the QEMU queue was full
    blocked: Vec<FlowKey>,
    /// entry wake-ups; stale items (not the entry's `wake_at`) are skipped
    timers: BinaryHeap<Reverse<(Instant, FlowKey)>>,
    /// TCP packets of no entry; smoltcp answers them with RST
    stray: VecDeque<Bytes>,
    /// the socket set strays are polled with
    no_sockets: SocketSet<'static>,
    udp: HashMap<Tuple, UdpSession>,
    udp_generation: u64,
    trusted_index: usize,
    next_flow_id: u64,
    /// earliest time the stack needs a poll
    next_poll: Option<Instant>,
    /// deadline the ticker is sleeping until
    armed: Option<Instant>,
    tx_dropped: u64,
    polls: u64,
    read_hold_timeouts: u64,
}

impl State {
    fn new(config: &NetConfig, session: u64, epoch: Instant) -> State {
        let mut device = Device {
            rx: VecDeque::new(),
            tx: BytesMut::new(),
            tx_inflight: 0,
            tx_soft: config.limits.tx_queue_soft_bytes.max(4096),
            mtu: usize::from(config.mtu),
            checksum_offload: config.checksum_offload,
            gateway_mac: config.gateway_mac,
            guest_mac: config.guest_mac,
        };
        let mut iface_config = IfaceConfig::new(HardwareAddress::Ip);
        iface_config.random_seed = RandomState::new().build_hasher().finish();
        let now = SmolInstant::from_micros(
            Instant::now().saturating_duration_since(epoch).as_micros() as i64,
        );
        let mut iface = Interface::new(iface_config, &mut device, now);
        iface.update_ip_addrs(|addrs| {
            let _ = addrs.push(IpCidr::new(IpAddress::Ipv4(config.gateway_ip), config.prefix_len));
        });
        // Accept TCP to any destination: every guest connection terminates here.
        iface.set_any_ip(true);
        State {
            session,
            running: false,
            iface,
            device,
            entries: HashMap::new(),
            tuples: HashMap::new(),
            next_key: 1,
            dirty: Vec::new(),
            blocked: Vec::new(),
            timers: BinaryHeap::new(),
            stray: VecDeque::new(),
            no_sockets: SocketSet::new(Vec::new()),
            udp: HashMap::new(),
            udp_generation: 0,
            trusted_index: 0,
            next_flow_id: 1,
            next_poll: None,
            armed: None,
            tx_dropped: 0,
            polls: 0,
            read_hold_timeouts: 0,
        }
    }

    fn shutdown(&mut self) {
        self.running = false;
        for (_, mut entry) in self.entries.drain() {
            // abort() wakes any task blocked on the socket.
            entry.socket().abort();
            entry.wake_reader();
        }
        self.tuples.clear();
        self.dirty.clear();
        self.blocked.clear();
        self.timers.clear();
        self.stray.clear();
        self.udp.clear();
        self.device.rx.clear();
        self.device.tx.clear();
    }

    /// Queues a non-TCP frame unless the QEMU queue is at its hard cap.
    fn can_queue(&mut self, shared: &Shared, len: usize) -> bool {
        if self.device.queued() + len + wire::QEMU_FRAME_PREFIX
            > shared.config.limits.tx_queue_max_bytes
        {
            self.tx_dropped += 1;
            gondolin_log::debug!("tx-drop: qemu queue full len={len}");
            return false;
        }
        true
    }

    fn emit_ipv4(
        &mut self,
        shared: &Shared,
        dst_mac: MacAddr,
        src: Ipv4Addr,
        dst: Ipv4Addr,
        proto: u8,
        l4: &[u8],
    ) {
        let len = wire::ETH_HEADER_LEN + wire::IPV4_HEADER_LEN + l4.len();
        if !self.can_queue(shared, len) {
            return;
        }
        wire::put_ipv4_frame(
            &mut self.device.tx,
            dst_mac,
            self.device.gateway_mac,
            src,
            dst,
            proto,
            l4,
        );
    }

    fn handle_frame(&mut self, shared: &Arc<Shared>, frame: Bytes) {
        let Some(eth) = wire::parse_ethernet(&frame) else {
            return;
        };
        if eth.src.is_unicast() {
            self.device.guest_mac = eth.src;
        }
        match eth.ethertype {
            wire::ETHERTYPE_ARP => self.handle_arp(shared, eth.payload),
            wire::ETHERTYPE_IPV4 => {
                let ip = match wire::parse_ipv4(eth.payload) {
                    Ok(ip) => ip,
                    Err(err) => {
                        gondolin_log::trace!("dropping ipv4 packet: {err:?}");
                        return;
                    }
                };
                match ip.protocol {
                    wire::IP_PROTO_UDP => self.handle_udp(shared, &ip),
                    _ if ip.src != shared.config.guest_ip => {
                        gondolin_log::trace!("dropping packet from foreign source src={}", ip.src);
                    }
                    wire::IP_PROTO_ICMP => self.handle_icmp(shared, &ip),
                    wire::IP_PROTO_TCP => {
                        let offset = ip.packet.as_ptr() as usize - frame.as_ptr() as usize;
                        let packet = frame.slice(offset..offset + ip.packet.len());
                        self.handle_tcp(shared, &ip, packet);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    fn handle_arp(&mut self, shared: &Shared, p: &[u8]) {
        if p.len() < 28 {
            return;
        }
        let htype = u16::from_be_bytes([p[0], p[1]]);
        let ptype = u16::from_be_bytes([p[2], p[3]]);
        let op = u16::from_be_bytes([p[6], p[7]]);
        if htype != 1 || ptype != wire::ETHERTYPE_IPV4 || p[4] != 6 || p[5] != 4 || op != 1 {
            return;
        }
        if p[24..28] != shared.config.gateway_ip.octets() {
            return;
        }
        let sender_mac = MacAddr(p[8..14].try_into().unwrap());
        if !self.can_queue(shared, wire::ETH_HEADER_LEN + 28) {
            return;
        }
        let gateway_mac = self.device.gateway_mac;
        wire::put_frame(
            &mut self.device.tx,
            sender_mac,
            gateway_mac,
            wire::ETHERTYPE_ARP,
            28,
            |r| {
                r[0..6].copy_from_slice(&p[0..6]);
                r[6..8].copy_from_slice(&2u16.to_be_bytes());
                r[8..14].copy_from_slice(&gateway_mac.0);
                r[14..18].copy_from_slice(&p[24..28]);
                r[18..24].copy_from_slice(&p[8..14]);
                r[24..28].copy_from_slice(&p[14..18]);
            },
        );
    }

    fn handle_icmp(&mut self, shared: &Shared, ip: &Ipv4<'_>) {
        let data = ip.payload;
        // Echo request with a valid checksum; replies come from whatever address
        // the guest pinged (node engine behavior).
        if data.len() < 8 || data[0] != 8 || wire::checksum(data) != 0 {
            return;
        }
        let mut reply = data.to_vec();
        reply[0] = 0;
        reply[2] = 0;
        reply[3] = 0;
        let ck = wire::checksum(&reply);
        reply[2..4].copy_from_slice(&ck.to_be_bytes());
        gondolin_log::trace!(
            "icmp echo src={} dst={} id={} seq={} size={}",
            ip.src,
            ip.dst,
            u16::from_be_bytes([data[4], data[5]]),
            u16::from_be_bytes([data[6], data[7]]),
            data.len()
        );
        let mac = self.device.guest_mac;
        self.emit_ipv4(shared, mac, ip.dst, ip.src, wire::IP_PROTO_ICMP, &reply);
    }

    fn handle_udp(&mut self, shared: &Arc<Shared>, ip: &Ipv4<'_>) {
        let Some(udp) = wire::parse_udp(ip, !shared.config.checksum_offload) else {
            return;
        };
        let config = &shared.config;
        if udp.src_port == crate::dhcp::DHCP_CLIENT_PORT
            && udp.dst_port == crate::dhcp::DHCP_SERVER_PORT
        {
            if let Some(reply) = crate::dhcp::handle(udp.payload, config, &shared.dhcp_dns) {
                gondolin_log::debug!(
                    "dhcp kind={} ip={}",
                    if reply.msg_type == crate::dhcp::DHCP_OFFER { "OFFER" } else { "ACK" },
                    config.guest_ip
                );
                let dgram = wire::udp_datagram(
                    config.gateway_ip,
                    crate::dhcp::DHCP_SERVER_PORT,
                    Ipv4Addr::BROADCAST,
                    crate::dhcp::DHCP_CLIENT_PORT,
                    &reply.payload,
                );
                self.emit_ipv4(
                    shared,
                    reply.dst_mac,
                    config.gateway_ip,
                    Ipv4Addr::BROADCAST,
                    wire::IP_PROTO_UDP,
                    &dgram,
                );
            }
            return;
        }
        if ip.src != config.guest_ip {
            return;
        }
        if udp.dst_port != 53 {
            gondolin_log::debug!(
                "udp blocked src={} sport={} dst={} dport={}",
                ip.src,
                udp.src_port,
                ip.dst,
                udp.dst_port
            );
            return;
        }
        let guest = SocketAddrV4::new(ip.src, udp.src_port);
        let target = SocketAddrV4::new(ip.dst, udp.dst_port);
        match config.dns.mode {
            DnsMode::Synthetic => self.synthetic_dns(shared, guest, target, udp.payload),
            DnsMode::Trusted => {
                if dns::parse_query(udp.payload).is_none() {
                    gondolin_log::debug!(
                        "dns blocked (non-dns payload) guest={guest} target={target}"
                    );
                    return;
                }
                self.forward_dns(shared, guest, target, udp.payload);
            }
            DnsMode::Open => self.forward_dns(shared, guest, target, udp.payload),
        }
    }

    fn synthetic_dns(
        &mut self,
        shared: &Shared,
        guest: SocketAddrV4,
        target: SocketAddrV4,
        payload: &[u8],
    ) {
        let Some(query) = dns::parse_query(payload) else {
            return;
        };
        let dns_config = &shared.config.dns;
        let mut ipv4 = dns_config.synthetic_ipv4;
        if dns_config.synthetic_host_mapping == SyntheticHostMapping::PerHost
            && !dns::is_localhost(&query.question.name)
            && let Some(mapped) = shared.hosts.allocate(&query.question.name)
        {
            ipv4 = mapped;
        }
        let response = dns::build_synthetic_response(
            &query,
            SyntheticAnswer {
                ipv4,
                ipv6: dns_config.synthetic_ipv6,
                ttl_seconds: dns_config.synthetic_ttl_seconds,
            },
        );
        gondolin_log::trace!(
            "dns synthetic guest={guest} target={target} name={}",
            query.question.name
        );
        self.udp_to_guest(shared, target, guest, &response);
    }

    fn udp_to_guest(
        &mut self,
        shared: &Shared,
        from: SocketAddrV4,
        to: SocketAddrV4,
        payload: &[u8],
    ) {
        let dgram = wire::udp_datagram(*from.ip(), from.port(), *to.ip(), to.port(), payload);
        let mac = self.device.guest_mac;
        self.emit_ipv4(shared, mac, *from.ip(), *to.ip(), wire::IP_PROTO_UDP, &dgram);
    }

    fn forward_dns(
        &mut self,
        shared: &Arc<Shared>,
        guest: SocketAddrV4,
        target: SocketAddrV4,
        payload: &[u8],
    ) {
        let key = (guest, target);
        let now = Instant::now();
        if !self.udp.contains_key(&key) {
            let limits = &shared.config.limits;
            while self.udp.len() >= limits.max_udp_sessions.max(1) {
                let oldest = self.udp.iter().min_by_key(|(_, s)| s.last_used).map(|(k, _)| *k);
                match oldest {
                    Some(k) => {
                        gondolin_log::debug!("udp session evicted guest={} target={}", k.0, k.1);
                        self.udp.remove(&k);
                    }
                    None => break,
                }
            }
            let port = shared.dns_upstream_port.load(Ordering::Relaxed);
            let upstream = match shared.config.dns.mode {
                DnsMode::Trusted => {
                    let server = shared.trusted[self.trusted_index % shared.trusted.len()];
                    self.trusted_index = self.trusted_index.wrapping_add(1);
                    SocketAddrV4::new(server, port)
                }
                _ => SocketAddrV4::new(*target.ip(), port),
            };
            let (sender, socket) = match open_udp(upstream) {
                Ok(pair) => pair,
                Err(err) => {
                    gondolin_log::debug!("dns upstream socket failed upstream={upstream}: {err}");
                    return;
                }
            };
            self.udp_generation += 1;
            let generation = self.udp_generation;
            let task = tokio::spawn(udp_receiver(
                shared.clone(),
                self.session,
                key,
                generation,
                socket,
                Duration::from_millis(limits.udp_session_idle_timeout_ms.max(1)),
            ));
            gondolin_log::trace!(
                "dns session opened guest={guest} target={target} upstream={upstream}"
            );
            self.udp.insert(key, UdpSession { sender, generation, last_used: now, task });
        }
        let session = self.udp.get_mut(&key).expect("session inserted");
        session.last_used = now;
        if let Err(err) = session.sender.send(payload) {
            gondolin_log::debug!("dns send failed: {err}");
        }
    }

    /// Queues `key` for the next poll.
    pub(crate) fn mark_dirty(&mut self, key: FlowKey) {
        if let Some(entry) = self.entries.get_mut(&key)
            && !entry.dirty
        {
            entry.dirty = true;
            self.dirty.push(key);
        }
    }

    fn handle_tcp(&mut self, shared: &Shared, ip: &Ipv4<'_>, packet: Bytes) {
        let Some(hdr) = wire::parse_tcp_header(ip.payload) else {
            return;
        };
        if !is_unicast_destination(ip.dst, &shared.config) {
            return;
        }
        let tuple =
            (SocketAddrV4::new(ip.src, hdr.src_port), SocketAddrV4::new(ip.dst, hdr.dst_port));
        let mut key = self.tuples.get(&tuple).copied();
        let is_syn = hdr.flags & (wire::TCP_SYN | wire::TCP_ACK | wire::TCP_RST) == wire::TCP_SYN;
        if is_syn && hdr.dst_port != 0 {
            // A SYN reuses the tuple's socket unless that one is closed (a dying
            // orphan, removed once it is done).
            let live = key.filter(|k| {
                self.entries.get_mut(k).is_some_and(|e| e.socket().state() != tcp::State::Closed)
            });
            if live.is_none() {
                key = self.listen(shared, tuple);
            }
        }
        match key.and_then(|k| self.entries.get_mut(&k).map(|e| (k, e))) {
            Some((k, entry)) => {
                entry.rx_push |= hdr.flags & (wire::TCP_PSH | wire::TCP_FIN | wire::TCP_RST) != 0;
                entry.rx.push_back(packet);
                self.mark_dirty(k);
            }
            None => self.stray.push_back(packet),
        }
    }

    /// A listening socket for a guest SYN, as a new handshake entry.
    fn listen(&mut self, shared: &Shared, tuple: Tuple) -> Option<FlowKey> {
        let limits = &shared.config.limits;
        if self.entries.len() >= limits.max_tcp_flows {
            gondolin_log::debug!("tcp flow limit reached guest={} dst={}", tuple.0, tuple.1);
            return None;
        }
        let mut socket = tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0u8; limits.tcp_rx_buffer_bytes]),
            tcp::SocketBuffer::new(vec![0u8; limits.tcp_tx_buffer_bytes]),
        );
        socket.set_nagle_enabled(false);
        socket.set_ack_delay(None);
        let endpoint =
            IpListenEndpoint { addr: Some(IpAddress::Ipv4(*tuple.1.ip())), port: tuple.1.port() };
        socket.listen(endpoint).ok()?;
        let mut set = SocketSet::new(Vec::with_capacity(1));
        let handle = set.add(socket);
        let key = self.next_key;
        self.next_key += 1;
        let deadline = Instant::now() + Duration::from_millis(limits.tcp_handshake_timeout_ms);
        self.entries.insert(
            key,
            Entry {
                phase: Phase::Handshake { deadline },
                tuple,
                aborted: false,
                set,
                handle,
                rx: VecDeque::new(),
                dirty: false,
                blocked: false,
                wake_at: None,
                rx_push: false,
                push: false,
                read_waker: None,
                read_deadline: None,
            },
        );
        // An older socket of the tuple (closed, not yet removed) keeps its entry.
        self.tuples.insert(tuple, key);
        Some(key)
    }

    /// Runs smoltcp for the entries that need it and the per-socket
    /// bookkeeping; returns flows to spawn.
    fn poll(&mut self, shared: &Arc<Shared>) -> Vec<TcpFlow> {
        let now = Instant::now();
        let ts = shared.smol_now(now);
        let mut spawn = Vec::new();
        self.polls += 1;

        if !self.stray.is_empty() {
            self.device.rx = std::mem::take(&mut self.stray);
            self.iface.poll(ts, &mut self.device, &mut self.no_sockets);
            self.device.rx.clear();
        }
        while let Some(&Reverse((at, key))) = self.timers.peek() {
            if at > now {
                break;
            }
            self.timers.pop();
            if self.entries.get(&key).is_some_and(|e| e.wake_at == Some(at)) {
                self.entries.get_mut(&key).expect("entry").wake_at = None;
                self.mark_dirty(key);
            }
        }
        let mut dirty = std::mem::take(&mut self.dirty);
        for key in dirty.drain(..) {
            self.poll_entry(shared, key, now, ts, &mut spawn);
        }
        // keep the allocation
        if self.dirty.is_empty() {
            self.dirty = dirty;
        }

        self.next_poll = loop {
            match self.timers.peek() {
                Some(&Reverse((at, key))) => {
                    if self.entries.get(&key).is_some_and(|e| e.wake_at == Some(at)) {
                        break Some(at);
                    }
                    self.timers.pop();
                }
                None => break None,
            }
        };
        if !self.dirty.is_empty() {
            // marked while polling (a re-poll was needed)
            self.next_poll = Some(now);
        }
        spawn
    }

    /// Polls one entry and advances its phase.
    fn poll_entry(
        &mut self,
        shared: &Arc<Shared>,
        key: FlowKey,
        now: Instant,
        ts: SmolInstant,
        spawn: &mut Vec<TcpFlow>,
    ) {
        let Some(entry) = self.entries.get_mut(&key) else {
            return;
        };
        entry.dirty = false;
        debug_assert!(self.device.rx.is_empty());
        std::mem::swap(&mut self.device.rx, &mut entry.rx);
        // Over the soft cap the entry only takes its packets in (replies such as
        // RST still go out) and sends once the writer drained the queue.
        let blocked = self.device.over_soft_cap();
        if blocked {
            while self.iface.poll_ingress_single(ts, &mut self.device, &mut entry.set)
                != PollIngressSingleResult::None
            {}
        } else {
            self.iface.poll(ts, &mut self.device, &mut entry.set);
        }
        std::mem::swap(&mut self.device.rx, &mut entry.rx);
        entry.rx.clear();
        // The pushed data is in the receive buffer now.
        entry.push |= std::mem::take(&mut entry.rx_push);

        let mut remove = false;
        let mut repoll = false;
        let state = entry.socket().state();
        match entry.phase {
            Phase::Handshake { deadline } => match state {
                tcp::State::SynReceived => {
                    if now >= deadline {
                        entry.socket().abort();
                        repoll = true;
                        entry.phase = Phase::Orphan { deadline: now };
                    }
                }
                tcp::State::Listen | tcp::State::Closed => remove = true,
                _ => {
                    let id = self.next_flow_id;
                    self.next_flow_id += 1;
                    entry.phase = Phase::Open { id };
                    let (guest, dst) = entry.tuple;
                    let synthetic_hostname = match shared.config.dns.synthetic_host_mapping {
                        SyntheticHostMapping::PerHost => shared.hosts.lookup(*dst.ip()),
                        SyntheticHostMapping::Single => None,
                    };
                    let meta = FlowMeta {
                        id,
                        src: SocketAddr::V4(guest),
                        dst: SocketAddr::V4(dst),
                        synthetic_hostname,
                    };
                    gondolin_log::debug!("tcp flow established id={id} guest={guest} dst={dst}");
                    spawn.push(flow::new_flow(shared.clone(), self.session, key, meta));
                }
            },
            Phase::Open { .. } => {}
            Phase::Orphan { deadline } => {
                let socket = entry.socket();
                let done = match state {
                    tcp::State::TimeWait | tcp::State::Listen => true,
                    tcp::State::Closed => socket.local_endpoint().is_none(),
                    _ => false,
                };
                if done {
                    remove = true;
                } else if state != tcp::State::Closed && (socket.can_recv() || now >= deadline) {
                    // Data after close, or the guest never finished the close.
                    socket.abort();
                    repoll = true;
                }
            }
        }
        if repoll {
            // emit the RST
            self.iface.poll(ts, &mut self.device, &mut entry.set);
        }
        if remove {
            entry.wake_reader();
            self.remove_entry(key);
            return;
        }
        if entry.read_waker.is_some() {
            let read_hold_bytes = shared.read_hold_bytes;
            let expired = entry.read_deadline.is_some_and(|d| now >= d);
            let socket = entry.socket();
            if socket.recv_queue() >= read_hold_bytes || !socket.may_recv() {
                entry.push = true;
            } else if expired && !entry.push {
                entry.push = true;
                self.read_hold_timeouts += 1;
                gondolin_log::debug!("tcp read released without push key={key}");
            }
            if entry.push {
                entry.wake_reader();
            }
        }
        if blocked && !entry.blocked {
            entry.blocked = true;
            self.blocked.push(key);
        }
        // While blocked, the writer's progress triggers the next poll.
        let timer = if blocked {
            None
        } else {
            self.iface.poll_at(ts, &entry.set).map(|at| epoch_at(shared, at))
        };
        let deadline = match entry.phase {
            Phase::Handshake { deadline } | Phase::Orphan { deadline } => Some(deadline),
            Phase::Open { .. } => entry.read_deadline,
        };
        let wake_at = match (timer, deadline) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        if wake_at != entry.wake_at {
            entry.wake_at = wake_at;
            if let Some(at) = wake_at {
                self.timers.push(Reverse((at, key)));
            }
        }
    }

    /// Makes sure `key` is polled at `at` (see `poll_entry` for the timers).
    pub(crate) fn schedule(&mut self, key: FlowKey, at: Instant) {
        let Some(entry) = self.entries.get_mut(&key) else {
            return;
        };
        if entry.wake_at.is_some_and(|w| w <= at) {
            return;
        }
        entry.wake_at = Some(at);
        self.timers.push(Reverse((at, key)));
        if self.next_poll.is_none_or(|n| at < n) {
            self.next_poll = Some(at);
        }
    }

    /// Whether the ticker sleeps past `next_poll` and must be woken.
    pub(crate) fn ticker_late(&self) -> bool {
        match (self.next_poll, self.armed) {
            (Some(next), Some(armed)) => next < armed,
            (Some(_), None) => true,
            (None, _) => false,
        }
    }

    fn remove_entry(&mut self, key: FlowKey) {
        if let Some(entry) = self.entries.remove(&key)
            && self.tuples.get(&entry.tuple) == Some(&key)
        {
            self.tuples.remove(&entry.tuple);
        }
    }

    /// Re-polls the entries that were blocked on the QEMU queue (it drained).
    fn unblock(&mut self) -> bool {
        let blocked = std::mem::take(&mut self.blocked);
        let any = !blocked.is_empty();
        for key in blocked {
            if let Some(entry) = self.entries.get_mut(&key) {
                entry.blocked = false;
            }
            self.mark_dirty(key);
        }
        any
    }

    /// Updates `next_poll`-dependent wakeups and the writer after a state change.
    fn after_change(&mut self, shared: &Shared) {
        if !self.device.tx.is_empty() {
            shared.tx_notify.notify_one();
        }
        if !self.dirty.is_empty() {
            shared.poll_notify.notify_one();
        } else if let Some(next) = self.next_poll
            && self.armed.is_none_or(|armed| next < armed)
        {
            shared.poll_notify.notify_one();
        }
    }
}

/// Converts a smoltcp timestamp back to an `Instant`.
fn epoch_at(shared: &Shared, at: SmolInstant) -> Instant {
    shared.epoch + Duration::from_micros(at.total_micros().max(0) as u64)
}

fn is_unicast_destination(ip: Ipv4Addr, config: &NetConfig) -> bool {
    !(ip.is_unspecified() || ip.is_broadcast() || ip.is_multicast() || ip == config.broadcast())
}

fn open_udp(upstream: SocketAddrV4) -> io::Result<(std::net::UdpSocket, UdpSocket)> {
    let socket = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
    socket.set_nonblocking(true)?;
    // Connected: only the chosen upstream's replies are accepted.
    socket.connect(upstream)?;
    let sender = socket.try_clone()?;
    Ok((sender, UdpSocket::from_std(socket)?))
}

async fn udp_receiver(
    shared: Arc<Shared>,
    session: u64,
    key: Tuple,
    generation: u64,
    socket: UdpSocket,
    idle: Duration,
) {
    let mut buf = vec![0u8; 65_535];
    loop {
        let result = tokio::time::timeout(idle, socket.recv(&mut buf)).await;
        let mut st = shared.lock();
        if st.session != session || st.udp.get(&key).map(|s| s.generation) != Some(generation) {
            return;
        }
        match result {
            Ok(Ok(n)) => {
                if let Some(s) = st.udp.get_mut(&key) {
                    s.last_used = Instant::now();
                }
                gondolin_log::trace!("dns reply guest={} target={} n={n}", key.0, key.1);
                // Reply as if it came from the address the guest targeted.
                st.udp_to_guest(&shared, key.1, key.0, &buf[..n]);
                st.after_change(&shared);
            }
            Ok(Err(err)) => {
                gondolin_log::debug!("dns upstream socket error: {err}");
                let removed = st.udp.remove(&key);
                drop(st);
                drop(removed);
                return;
            }
            Err(_) => {
                let idle_for = st.udp.get(&key).map(|s| s.last_used.elapsed()).unwrap_or(idle);
                if idle_for >= idle {
                    gondolin_log::trace!("udp session idle guest={} target={}", key.0, key.1);
                    let removed = st.udp.remove(&key);
                    drop(st);
                    drop(removed);
                    return;
                }
            }
        }
    }
}

fn spawn_flows(shared: &Arc<Shared>, flows: Vec<TcpFlow>) {
    for flow in flows {
        let handler = shared.handler.clone();
        let control = flow.control.clone();
        let id = flow.meta.id;
        tokio::spawn(async move {
            // A panicking handler is contained: reset the guest connection
            // before the flow (and its socket) is dropped, so the guest sees
            // RST instead of a clean close and the socket is released as
            // aborted.
            let handled = CatchUnwind(Box::pin(handler.handle_tcp(flow))).await;
            if handled.is_err() {
                gondolin_log::error!(
                    target: "gondolin::netstack",
                    "flow handler panicked; connection reset flow={id}"
                );
                control.abort();
            }
        });
    }
}

/// Polls a future inside `catch_unwind`; resolves to `Err` when it panicked.
/// The future is dropped only after the caller saw the panic.
struct CatchUnwind<F>(Pin<Box<F>>);

impl<F: Future> Future for CatchUnwind<F> {
    type Output = Result<F::Output, ()>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let fut = self.0.as_mut();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fut.poll(cx))) {
            Ok(Poll::Pending) => Poll::Pending,
            Ok(Poll::Ready(out)) => Poll::Ready(Ok(out)),
            Err(_) => Poll::Ready(Err(())),
        }
    }
}

async fn reader<R: AsyncRead>(shared: &Arc<Shared>, rd: R) -> io::Result<()> {
    let mut rd = std::pin::pin!(rd);
    let mut buf = BytesMut::with_capacity(READ_CHUNK);
    loop {
        wait_tx_room(shared).await;
        if buf.capacity() - buf.len() < READ_CHUNK / 4 {
            buf.reserve(READ_CHUNK);
        }
        let n = rd.read_buf(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        let mut frames = Vec::new();
        while buf.len() >= wire::QEMU_FRAME_PREFIX {
            let len = u32::from_be_bytes(buf[..4].try_into().unwrap()) as usize;
            if len > MAX_FRAME_LEN {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("netdev frame too large ({len} bytes)"),
                ));
            }
            if buf.len() < wire::QEMU_FRAME_PREFIX + len {
                break;
            }
            let mut frame = buf.split_to(wire::QEMU_FRAME_PREFIX + len);
            let _ = frame.split_to(wire::QEMU_FRAME_PREFIX);
            frames.push(frame.freeze());
        }
        handle_frames(shared, frames);
    }
}

async fn writer<W: AsyncWrite>(shared: &Arc<Shared>, wr: W) -> io::Result<()> {
    let mut wr = std::pin::pin!(wr);
    loop {
        let chunk = {
            let mut st = shared.lock();
            if st.device.tx.is_empty() {
                None
            } else {
                let chunk = st.device.tx.split().freeze();
                st.device.tx_inflight = chunk.len();
                Some(chunk)
            }
        };
        let Some(chunk) = chunk else {
            shared.tx_notify.notified().await;
            continue;
        };
        wr.write_all(&chunk).await?;
        wr.flush().await?;
        let mut st = shared.lock();
        st.device.tx_inflight = 0;
        if st.unblock() {
            shared.poll_notify.notify_one();
        }
        drop(st);
        shared.tx_drained.notify_waiters();
    }
}

/// Waits until the queue towards the guest is back under its hard cap
/// (replies to guest packets are queued unconditionally, so a guest that sends
/// without receiving must be throttled at the source).
async fn wait_tx_room(shared: &Arc<Shared>) {
    let max_queued = shared.config.limits.tx_queue_max_bytes;
    loop {
        let drained = shared.tx_drained.notified();
        let mut drained = std::pin::pin!(drained);
        drained.as_mut().enable();
        if shared.lock().device.queued() <= max_queued {
            break;
        }
        drained.await;
    }
}

/// Feeds guest frames to the stack and polls it once.
fn handle_frames(shared: &Arc<Shared>, frames: Vec<Bytes>) {
    if frames.is_empty() {
        return;
    }
    let spawn = {
        let mut st = shared.lock();
        for frame in frames {
            st.handle_frame(shared, frame);
        }
        let spawn = st.poll(shared);
        st.after_change(shared);
        spawn
    };
    spawn_flows(shared, spawn);
}

/// Most frames taken from a [`FrameSocket`] per stack poll.
const FRAME_BATCH: usize = 64;

/// Turns one received datagram into guest frames (expanding offloads).
fn push_datagram(vnet: bool, datagram: &[u8], frames: &mut Vec<Bytes>) {
    if !vnet {
        if datagram.len() <= MAX_FRAME_LEN {
            frames.push(Bytes::copy_from_slice(datagram));
        }
        return;
    }
    let Some((hdr, frame)) = VnetHdr::parse(datagram) else {
        gondolin_log::trace!("dropping datagram without virtio_net_hdr ({} bytes)", datagram.len());
        return;
    };
    if let Err(err) = offload::expand(&hdr, frame, frames) {
        gondolin_log::debug!("dropping offloaded frame: {err:?} ({hdr:?})");
    }
}

async fn frame_reader<F: FrameSocket + ?Sized>(shared: &Arc<Shared>, socket: &F) -> io::Result<()> {
    let vnet = socket.vnet_hdr();
    let mut buf = vec![0u8; MAX_FRAME_LEN + VNET_HDR_LEN];
    loop {
        wait_tx_room(shared).await;
        let n = std::future::poll_fn(|cx| socket.poll_recv_frame(cx, &mut buf)).await?;
        let mut frames = Vec::new();
        push_datagram(vnet, &buf[..n], &mut frames);
        // drain what is already queued, one stack poll for the batch
        for _ in 1..FRAME_BATCH {
            match socket.try_recv_frame(&mut buf) {
                Ok(n) => push_datagram(vnet, &buf[..n], &mut frames),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
        handle_frames(shared, frames);
    }
}

async fn frame_writer<F: FrameSocket + ?Sized>(shared: &Arc<Shared>, socket: &F) -> io::Result<()> {
    let vnet = socket.vnet_hdr();
    let mut datagram = Vec::with_capacity(MAX_FRAME_LEN + VNET_HDR_LEN);
    loop {
        let chunk = {
            let mut st = shared.lock();
            if st.device.tx.is_empty() {
                None
            } else {
                let chunk = st.device.tx.split().freeze();
                st.device.tx_inflight = chunk.len();
                Some(chunk)
            }
        };
        let Some(chunk) = chunk else {
            shared.tx_notify.notified().await;
            continue;
        };
        // the queue holds QEMU-framed frames: send each without its prefix
        let mut rest = &chunk[..];
        while rest.len() >= wire::QEMU_FRAME_PREFIX {
            let len = u32::from_be_bytes(rest[..4].try_into().unwrap()) as usize;
            let frame = &rest[wire::QEMU_FRAME_PREFIX..wire::QEMU_FRAME_PREFIX + len];
            rest = &rest[wire::QEMU_FRAME_PREFIX + len..];
            let out: &[u8] = if vnet {
                datagram.clear();
                datagram.extend_from_slice(&VnetHdr::default().encode());
                datagram.extend_from_slice(frame);
                &datagram
            } else {
                frame
            };
            std::future::poll_fn(|cx| socket.poll_send_frame(cx, out)).await?;
        }
        let mut st = shared.lock();
        st.device.tx_inflight = 0;
        if st.unblock() {
            shared.poll_notify.notify_one();
        }
        drop(st);
        shared.tx_drained.notify_waiters();
    }
}

async fn ticker(shared: &Arc<Shared>) {
    loop {
        let deadline = {
            let mut st = shared.lock();
            st.armed = st.next_poll;
            st.next_poll
        };
        match deadline {
            Some(deadline) => {
                let _ =
                    tokio::time::timeout_at(deadline.into(), shared.poll_notify.notified()).await;
            }
            None => shared.poll_notify.notified().await,
        }
        let spawn = {
            let mut st = shared.lock();
            st.armed = None;
            let spawn = st.poll(shared);
            if !st.device.tx.is_empty() {
                shared.tx_notify.notify_one();
            }
            spawn
        };
        spawn_flows(shared, spawn);
    }
}

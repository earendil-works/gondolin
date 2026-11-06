//! The stack: QEMU netdev transport, L2/L3 dispatch, DHCP/DNS/ICMP, and the
//! smoltcp interface terminating guest TCP.
//!
//! Concurrency: all protocol state lives in one [`State`] behind a mutex.
//! `serve` runs three futures: the reader (frames from QEMU → state), the
//! writer (queued frames → QEMU) and the ticker (smoltcp timers and polls
//! requested by flow streams). Flow streams lock the state to move bytes in and
//! out of their smoltcp socket buffers and wake the ticker.

use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};
use smoltcp::iface::{Config as IfaceConfig, Interface, SocketHandle, SocketSet};
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
use crate::wire::{self, Ipv4};
use crate::{FlowHandler, FlowMeta, SyntheticHostLookup, TcpFlow};

/// Largest Ethernet frame accepted from QEMU in `bytes`; anything larger means
/// the stream is desynchronized.
const MAX_FRAME_LEN: usize = 65_550;
/// Read buffer growth step in `bytes`.
const READ_CHUNK: usize = 256 * 1024;

/// Errors constructing or serving a [`NetStack`].
#[derive(Debug, thiserror::Error)]
pub enum NetStackError {
    #[error(
        "dns mode 'trusted' requires at least one IPv4 resolver (none found); configure dns.trusted_servers or an IPv4 resolver on the host"
    )]
    NoTrustedResolvers,
    #[error("invalid network configuration: {0}")]
    InvalidConfig(String),
}

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

    pub fn stats(&self) -> NetStats {
        let st = self.shared.lock();
        NetStats {
            tcp_sockets: st.sockets.iter().count(),
            tcp_flows: st
                .entries
                .values()
                .filter(|e| !matches!(e.phase, Phase::Handshake { .. }))
                .count(),
            udp_sessions: st.udp.len(),
            tx_queued_bytes: st.device.tx.len() + st.device.tx_inflight,
            tx_dropped_frames: st.tx_dropped,
            polls: st.polls,
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

        // Shuts the session down even if this future is dropped.
        struct Guard<'a>(&'a Shared);
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                self.0.lock().shutdown();
            }
        }
        let _guard = Guard(shared);

        let (rd, wr) = tokio::io::split(stream);
        tokio::select! {
            r = reader(shared, rd) => r,
            r = writer(shared, wr) => r,
            () = ticker(shared) => Ok(()),
        }
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

pub(crate) struct Entry {
    pub(crate) phase: Phase,
    /// guest address, destination address
    tuple: (SocketAddrV4, SocketAddrV4),
    /// set by [`crate::FlowControl::abort`]
    pub(crate) aborted: bool,
}

pub(crate) struct Shared {
    state: Mutex<State>,
    /// asks the ticker to poll smoltcp (data written/read by a flow, queue drained)
    pub(crate) poll_notify: Notify,
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
    tx_soft: usize,
    /// smoltcp wanted to transmit but the queue was over the soft cap
    tx_blocked: bool,
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
        // Replies to received packets (RST, ACK) are bounded by what we read, so
        // they bypass the soft cap.
        Some((
            RxTok(packet),
            TxTok { tx: &mut self.tx, dst: self.guest_mac, src: self.gateway_mac },
        ))
    }

    fn transmit(&mut self, _ts: SmolInstant) -> Option<TxTok<'_>> {
        if self.queued() >= self.tx_soft {
            self.tx_blocked = true;
            return None;
        }
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
    pub(crate) sockets: SocketSet<'static>,
    device: Device,
    /// listeners created for SYNs of the batch being processed
    listeners: Vec<SocketHandle>,
    pending_syns: HashSet<Tuple>,
    pub(crate) entries: HashMap<SocketHandle, Entry>,
    tuples: HashMap<Tuple, SocketHandle>,
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
}

impl State {
    fn new(config: &NetConfig, session: u64, epoch: Instant) -> State {
        let mut device = Device {
            rx: VecDeque::new(),
            tx: BytesMut::new(),
            tx_inflight: 0,
            tx_soft: config.limits.tx_queue_soft_bytes.max(4096),
            tx_blocked: false,
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
            sockets: SocketSet::new(Vec::new()),
            device,
            listeners: Vec::new(),
            pending_syns: HashSet::new(),
            entries: HashMap::new(),
            tuples: HashMap::new(),
            udp: HashMap::new(),
            udp_generation: 0,
            trusted_index: 0,
            next_flow_id: 1,
            next_poll: None,
            armed: None,
            tx_dropped: 0,
            polls: 0,
        }
    }

    fn shutdown(&mut self) {
        self.running = false;
        for (handle, _) in self.entries.drain() {
            // abort() wakes any task blocked on the socket.
            self.sockets.get_mut::<tcp::Socket>(handle).abort();
        }
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
            tracing::debug!(len, "tx-drop: qemu queue full");
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
                        tracing::trace!(?err, "dropping ipv4 packet");
                        return;
                    }
                };
                match ip.protocol {
                    wire::IP_PROTO_UDP => self.handle_udp(shared, &ip),
                    _ if ip.src != shared.config.guest_ip => {
                        tracing::trace!(src = %ip.src, "dropping packet from foreign source");
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
        tracing::trace!(
            src = %ip.src,
            dst = %ip.dst,
            id = u16::from_be_bytes([data[4], data[5]]),
            seq = u16::from_be_bytes([data[6], data[7]]),
            size = data.len(),
            "icmp echo"
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
                tracing::debug!(
                    kind = if reply.msg_type == crate::dhcp::DHCP_OFFER { "OFFER" } else { "ACK" },
                    ip = %config.guest_ip,
                    "dhcp"
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
            tracing::debug!(src = %ip.src, sport = udp.src_port, dst = %ip.dst, dport = udp.dst_port, "udp blocked");
            return;
        }
        let guest = SocketAddrV4::new(ip.src, udp.src_port);
        let target = SocketAddrV4::new(ip.dst, udp.dst_port);
        match config.dns.mode {
            DnsMode::Synthetic => self.synthetic_dns(shared, guest, target, udp.payload),
            DnsMode::Trusted => {
                if dns::parse_query(udp.payload).is_none() {
                    tracing::debug!(%guest, %target, "dns blocked (non-dns payload)");
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
        tracing::trace!(%guest, %target, name = %query.question.name, "dns synthetic");
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
                        tracing::debug!(guest = %k.0, target = %k.1, "udp session evicted");
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
                    tracing::debug!(%upstream, %err, "dns upstream socket failed");
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
            tracing::trace!(%guest, %target, %upstream, "dns session opened");
            self.udp.insert(key, UdpSession { sender, generation, last_used: now, task });
        }
        let session = self.udp.get_mut(&key).expect("session inserted");
        session.last_used = now;
        if let Err(err) = session.sender.send(payload) {
            tracing::debug!(%err, "dns send failed");
        }
    }

    fn tcp_socket_count(&self) -> usize {
        self.entries.len() + self.listeners.len()
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
        let is_syn = hdr.flags & (wire::TCP_SYN | wire::TCP_ACK | wire::TCP_RST) == wire::TCP_SYN;
        if is_syn && hdr.dst_port != 0 && !self.pending_syns.contains(&tuple) {
            let existing = self
                .tuples
                .get(&tuple)
                .copied()
                .filter(|h| self.sockets.get::<tcp::Socket>(*h).state() != tcp::State::Closed);
            if existing.is_none() {
                if self.tcp_socket_count() >= shared.config.limits.max_tcp_flows {
                    tracing::debug!(guest = %tuple.0, dst = %tuple.1, "tcp flow limit reached");
                } else {
                    self.tuples.remove(&tuple);
                    let limits = &shared.config.limits;
                    let mut socket = tcp::Socket::new(
                        tcp::SocketBuffer::new(vec![0u8; limits.tcp_rx_buffer_bytes]),
                        tcp::SocketBuffer::new(vec![0u8; limits.tcp_tx_buffer_bytes]),
                    );
                    socket.set_nagle_enabled(false);
                    socket.set_ack_delay(None);
                    let endpoint = IpListenEndpoint {
                        addr: Some(IpAddress::Ipv4(ip.dst)),
                        port: hdr.dst_port,
                    };
                    if socket.listen(endpoint).is_ok() {
                        let handle = self.sockets.add(socket);
                        self.listeners.push(handle);
                        self.pending_syns.insert(tuple);
                    }
                }
            }
        }
        self.device.rx.push_back(packet);
    }

    /// Runs smoltcp and the per-socket bookkeeping; returns flows to spawn.
    fn poll(&mut self, shared: &Arc<Shared>) -> Vec<TcpFlow> {
        let now = Instant::now();
        let ts = shared.smol_now(now);
        let mut spawn = Vec::new();
        self.polls += 1;
        self.iface.poll(ts, &mut self.device, &mut self.sockets);
        if self.maintain(shared, now, &mut spawn) {
            self.iface.poll(ts, &mut self.device, &mut self.sockets);
        }

        let mut next = None;
        if !self.device.tx_blocked {
            // While blocked, the writer's progress triggers the next poll.
            next = self
                .iface
                .poll_delay(ts, &self.sockets)
                .map(|d| now + Duration::from_micros(d.total_micros()));
        }
        for entry in self.entries.values() {
            let deadline = match entry.phase {
                Phase::Handshake { deadline } | Phase::Orphan { deadline } => deadline,
                Phase::Open { .. } => continue,
            };
            next = Some(next.map_or(deadline, |n: Instant| n.min(deadline)));
        }
        self.next_poll = next;
        spawn
    }

    /// Resolves new listeners, completes handshakes and garbage-collects closed
    /// sockets. Returns whether a socket was aborted (needs another poll).
    fn maintain(&mut self, shared: &Arc<Shared>, now: Instant, spawn: &mut Vec<TcpFlow>) -> bool {
        let limits = &shared.config.limits;
        for handle in std::mem::take(&mut self.listeners) {
            let socket = self.sockets.get_mut::<tcp::Socket>(handle);
            let endpoints = match socket.state() {
                tcp::State::Listen | tcp::State::Closed => None,
                _ => socket.remote_endpoint().zip(socket.local_endpoint()),
            };
            let tuple = endpoints.and_then(|(remote, local)| Some((v4(remote)?, v4(local)?)));
            match tuple {
                Some(tuple) => {
                    self.tuples.insert(tuple, handle);
                    self.entries.insert(
                        handle,
                        Entry {
                            phase: Phase::Handshake {
                                deadline: now
                                    + Duration::from_millis(limits.tcp_handshake_timeout_ms),
                            },
                            tuple,
                            aborted: false,
                        },
                    );
                }
                None => {
                    self.sockets.remove(handle);
                }
            }
        }
        self.pending_syns.clear();

        let mut aborted_any = false;
        let mut remove = Vec::new();
        for (&handle, entry) in self.entries.iter_mut() {
            let socket = self.sockets.get_mut::<tcp::Socket>(handle);
            let state = socket.state();
            match entry.phase {
                Phase::Handshake { deadline } => match state {
                    tcp::State::SynReceived => {
                        if now >= deadline {
                            socket.abort();
                            aborted_any = true;
                            entry.phase = Phase::Orphan { deadline: now };
                        }
                    }
                    tcp::State::Listen | tcp::State::Closed => remove.push(handle),
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
                        tracing::debug!(id, %guest, %dst, "tcp flow established");
                        spawn.push(flow::new_flow(shared.clone(), self.session, handle, meta));
                    }
                },
                Phase::Open { .. } => {}
                Phase::Orphan { deadline } => {
                    let done = match state {
                        tcp::State::TimeWait | tcp::State::Listen => true,
                        tcp::State::Closed => socket.local_endpoint().is_none(),
                        _ => false,
                    };
                    if done {
                        remove.push(handle);
                    } else if state != tcp::State::Closed && (socket.can_recv() || now >= deadline)
                    {
                        // Data after close, or the guest never finished the close.
                        socket.abort();
                        aborted_any = true;
                    }
                }
            }
        }
        for handle in remove {
            self.remove_socket(handle);
        }
        aborted_any
    }

    fn remove_socket(&mut self, handle: SocketHandle) {
        if let Some(entry) = self.entries.remove(&handle)
            && self.tuples.get(&entry.tuple) == Some(&handle)
        {
            self.tuples.remove(&entry.tuple);
        }
        self.sockets.remove(handle);
    }

    /// Updates `next_poll`-dependent wakeups and the writer after a state change.
    fn after_change(&mut self, shared: &Shared) {
        if !self.device.tx.is_empty() {
            shared.tx_notify.notify_one();
        }
        if let Some(next) = self.next_poll
            && self.armed.is_none_or(|armed| next < armed)
        {
            shared.poll_notify.notify_one();
        }
    }
}

fn v4(endpoint: smoltcp::wire::IpEndpoint) -> Option<SocketAddrV4> {
    match endpoint.addr {
        IpAddress::Ipv4(ip) => Some(SocketAddrV4::new(ip, endpoint.port)),
        #[allow(unreachable_patterns)]
        _ => None,
    }
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
                tracing::trace!(guest = %key.0, target = %key.1, n, "dns reply");
                // Reply as if it came from the address the guest targeted.
                st.udp_to_guest(&shared, key.1, key.0, &buf[..n]);
                st.after_change(&shared);
            }
            Ok(Err(err)) => {
                tracing::debug!(%err, "dns upstream socket error");
                let removed = st.udp.remove(&key);
                drop(st);
                drop(removed);
                return;
            }
            Err(_) => {
                let idle_for = st.udp.get(&key).map(|s| s.last_used.elapsed()).unwrap_or(idle);
                if idle_for >= idle {
                    tracing::trace!(guest = %key.0, target = %key.1, "udp session idle");
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
        tokio::spawn(async move { handler.handle_tcp(flow).await });
    }
}

async fn reader<R: AsyncRead>(shared: &Arc<Shared>, rd: R) -> io::Result<()> {
    tokio::pin!(rd);
    let mut buf = BytesMut::with_capacity(READ_CHUNK);
    let max_queued = shared.config.limits.tx_queue_max_bytes;
    loop {
        // Stop reading from QEMU while our queue towards it is over the hard cap:
        // replies to guest packets (ACK/RST) are queued unconditionally, so a guest
        // that sends without receiving must be throttled here.
        loop {
            let drained = shared.tx_drained.notified();
            tokio::pin!(drained);
            drained.as_mut().enable();
            if shared.lock().device.queued() <= max_queued {
                break;
            }
            drained.await;
        }
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
        if frames.is_empty() {
            continue;
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
}

async fn writer<W: AsyncWrite>(shared: &Arc<Shared>, wr: W) -> io::Result<()> {
    tokio::pin!(wr);
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
        if std::mem::take(&mut st.device.tx_blocked) {
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
                tokio::select! {
                    () = shared.poll_notify.notified() => {}
                    () = tokio::time::sleep_until(deadline.into()) => {}
                }
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

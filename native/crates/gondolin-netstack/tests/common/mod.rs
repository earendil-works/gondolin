//! Test harness: runs a [`NetStack`] on one end of an in-memory duplex pipe and
//! gives tests the other end, either as raw QEMU frames ([`RawGuest`]) or as a
//! smoltcp "guest" with real TCP sockets ([`Guest`]).

#![allow(dead_code)]

use std::collections::VecDeque;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::{Buf, BytesMut};
use gondolin_netstack::wire;
use gondolin_netstack::{FlowHandler, MacAddr, NetConfig, NetStack, TcpFlow};
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{self, DeviceCapabilities, Medium};
use smoltcp::socket::tcp;
use smoltcp::time::Instant as SmolInstant;
use smoltcp::wire::{EthernetAddress, HardwareAddress, IpAddress, IpCidr};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, ReadHalf, WriteHalf};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub const GATEWAY_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 127, 1);
pub const GUEST_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 127, 3);
pub const GATEWAY_MAC: MacAddr = MacAddr([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
pub const GUEST_MAC: MacAddr = MacAddr([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

/// Flow handler that passes every flow to the test.
pub struct ChannelHandler(pub mpsc::UnboundedSender<TcpFlow>);

impl FlowHandler for ChannelHandler {
    fn handle_tcp(&self, flow: TcpFlow) -> gondolin_netstack::BoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self.0.send(flow);
        })
    }
}

/// Echoes every flow back (until EOF, then half-closes).
pub struct EchoHandler;

impl FlowHandler for EchoHandler {
    fn handle_tcp(&self, flow: TcpFlow) -> gondolin_netstack::BoxFuture<'_, ()> {
        Box::pin(async move {
            let (mut rd, mut wr) = tokio::io::split(flow.stream);
            let _ = tokio::io::copy(&mut rd, &mut wr).await;
            let _ = wr.shutdown().await;
        })
    }
}

/// A running stack plus the guest end of its netdev pipe.
pub struct Harness {
    pub stack: Arc<NetStack>,
    pub serve: JoinHandle<std::io::Result<()>>,
    pub pipe: Option<DuplexStream>,
}

pub fn start(config: NetConfig, handler: Arc<dyn FlowHandler>) -> Harness {
    start_with_resolvers(config, handler, vec![Ipv4Addr::new(10, 0, 0, 53)])
}

pub fn start_with_resolvers(
    config: NetConfig,
    handler: Arc<dyn FlowHandler>,
    resolvers: Vec<Ipv4Addr>,
) -> Harness {
    let stack = Arc::new(NetStack::with_system_resolvers(config, handler, resolvers).unwrap());
    let (guest_end, host_end) = tokio::io::duplex(1 << 20);
    let serve_stack = stack.clone();
    let serve = tokio::spawn(async move { serve_stack.serve(host_end).await });
    Harness { stack, serve, pipe: Some(guest_end) }
}

pub fn channel_harness(config: NetConfig) -> (Harness, mpsc::UnboundedReceiver<TcpFlow>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (start(config, Arc::new(ChannelHandler(tx))), rx)
}

// ---------------------------------------------------------------------------
// Raw frames

pub fn eth_frame(dst: MacAddr, src: MacAddr, ethertype: u16, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(14 + payload.len());
    out.extend_from_slice(&dst.0);
    out.extend_from_slice(&src.0);
    out.extend_from_slice(&ethertype.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn ipv4_packet(src: Ipv4Addr, dst: Ipv4Addr, proto: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; 20];
    wire::write_ipv4_header(&mut out, src, dst, proto, payload.len());
    out.extend_from_slice(payload);
    out
}

pub fn guest_ip_frame(src: Ipv4Addr, dst: Ipv4Addr, proto: u8, l4: &[u8]) -> Vec<u8> {
    eth_frame(GATEWAY_MAC, GUEST_MAC, wire::ETHERTYPE_IPV4, &ipv4_packet(src, dst, proto, l4))
}

pub fn guest_udp_frame(src_port: u16, dst: Ipv4Addr, dst_port: u16, payload: &[u8]) -> Vec<u8> {
    let dgram = wire::udp_datagram(GUEST_IP, src_port, dst, dst_port, payload);
    guest_ip_frame(GUEST_IP, dst, wire::IP_PROTO_UDP, &dgram)
}

/// Builds a TCP segment with a valid checksum.
#[allow(clippy::too_many_arguments)]
pub fn tcp_segment(
    src: Ipv4Addr,
    sport: u16,
    dst: Ipv4Addr,
    dport: u16,
    seq: u32,
    ack: u32,
    flags: u8,
    payload: &[u8],
) -> Vec<u8> {
    let mut seg = vec![0u8; 20];
    seg[0..2].copy_from_slice(&sport.to_be_bytes());
    seg[2..4].copy_from_slice(&dport.to_be_bytes());
    seg[4..8].copy_from_slice(&seq.to_be_bytes());
    seg[8..12].copy_from_slice(&ack.to_be_bytes());
    seg[12] = 0x50;
    seg[13] = flags;
    seg[14..16].copy_from_slice(&65535u16.to_be_bytes());
    seg.extend_from_slice(payload);
    let ck =
        wire::fold(wire::sum16(wire::pseudo_sum(src, dst, wire::IP_PROTO_TCP, seg.len()), &seg));
    seg[16..18].copy_from_slice(&ck.to_be_bytes());
    seg
}

pub fn qemu_frame(frame: &[u8]) -> Vec<u8> {
    let mut out = (frame.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(frame);
    out
}

/// Guest end speaking raw frames.
pub struct RawGuest {
    rd: ReadHalf<DuplexStream>,
    wr: WriteHalf<DuplexStream>,
    buf: BytesMut,
}

impl RawGuest {
    pub fn new(h: &mut Harness) -> Self {
        let (rd, wr) = tokio::io::split(h.pipe.take().unwrap());
        RawGuest { rd, wr, buf: BytesMut::new() }
    }

    pub async fn send(&mut self, frame: &[u8]) {
        self.wr.write_all(&qemu_frame(frame)).await.unwrap();
    }

    pub async fn send_raw(&mut self, bytes: &[u8]) {
        self.wr.write_all(bytes).await.unwrap();
    }

    /// Next frame from the stack, or `None` after `wait`.
    pub async fn recv_within(&mut self, wait: Duration) -> Option<Vec<u8>> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            if self.buf.len() >= 4 {
                let len = u32::from_be_bytes(self.buf[..4].try_into().unwrap()) as usize;
                if self.buf.len() >= 4 + len {
                    self.buf.advance(4);
                    return Some(self.buf.split_to(len).to_vec());
                }
            }
            match tokio::time::timeout_at(deadline, self.rd.read_buf(&mut self.buf)).await {
                Ok(Ok(0)) | Ok(Err(_)) | Err(_) => return None,
                Ok(Ok(_)) => {}
            }
        }
    }

    pub async fn recv(&mut self) -> Vec<u8> {
        self.recv_within(Duration::from_secs(30)).await.expect("expected a frame")
    }

    /// Asserts nothing arrives for a short while.
    pub async fn expect_silence(&mut self) {
        if let Some(frame) = self.recv_within(Duration::from_millis(150)).await {
            panic!("unexpected frame: {frame:02x?}");
        }
    }

    pub fn into_parts(self) -> (ReadHalf<DuplexStream>, WriteHalf<DuplexStream>) {
        (self.rd, self.wr)
    }
}

/// Parsed IPv4 frame from the stack.
pub struct RxIp {
    pub dst_mac: MacAddr,
    pub src: Ipv4Addr,
    pub dst: Ipv4Addr,
    pub proto: u8,
    pub ttl: u8,
    pub payload: Vec<u8>,
}

pub fn parse_ip_frame(frame: &[u8]) -> RxIp {
    let eth = wire::parse_ethernet(frame).expect("ethernet");
    assert_eq!(eth.ethertype, wire::ETHERTYPE_IPV4);
    assert_eq!(eth.src, GATEWAY_MAC);
    let ip = wire::parse_ipv4(eth.payload).expect("valid ipv4 (checksum)");
    RxIp {
        dst_mac: eth.dst,
        src: ip.src,
        dst: ip.dst,
        proto: ip.protocol,
        ttl: eth.payload[8],
        payload: ip.payload.to_vec(),
    }
}

/// Parses a UDP frame from the stack and verifies its checksum.
pub fn parse_udp_frame(frame: &[u8]) -> (RxIp, u16, u16, Vec<u8>) {
    let eth = wire::parse_ethernet(frame).expect("ethernet");
    let ip = wire::parse_ipv4(eth.payload).expect("valid ipv4");
    assert_eq!(ip.protocol, wire::IP_PROTO_UDP);
    let udp = wire::parse_udp(&ip, true).expect("valid udp checksum");
    let (sport, dport, payload) = (udp.src_port, udp.dst_port, udp.payload.to_vec());
    (parse_ip_frame(frame), sport, dport, payload)
}

// ---------------------------------------------------------------------------
// smoltcp guest

pub struct GuestDevice {
    rx: VecDeque<Vec<u8>>,
    tx: Vec<u8>,
}

pub struct GuestRx(Vec<u8>);
impl phy::RxToken for GuestRx {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

pub struct GuestTx<'a>(&'a mut Vec<u8>);
impl phy::TxToken for GuestTx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        self.0.extend_from_slice(&(len as u32).to_be_bytes());
        let start = self.0.len();
        self.0.resize(start + len, 0);
        f(&mut self.0[start..])
    }
}

impl phy::Device for GuestDevice {
    type RxToken<'a> = GuestRx;
    type TxToken<'a> = GuestTx<'a>;

    fn receive(&mut self, _: SmolInstant) -> Option<(GuestRx, GuestTx<'_>)> {
        let frame = self.rx.pop_front()?;
        Some((GuestRx(frame), GuestTx(&mut self.tx)))
    }

    fn transmit(&mut self, _: SmolInstant) -> Option<GuestTx<'_>> {
        // Bound what one poll can queue, like a NIC ring.
        if self.tx.len() > 512 * 1024 {
            return None;
        }
        Some(GuestTx(&mut self.tx))
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ethernet;
        caps.max_transmission_unit = 1514;
        caps
    }
}

/// Userspace TCP/IP "guest" (smoltcp over Ethernet) driven over the netdev pipe.
pub struct Guest {
    pub iface: Interface,
    pub sockets: SocketSet<'static>,
    dev: GuestDevice,
    rd: ReadHalf<DuplexStream>,
    wr: WriteHalf<DuplexStream>,
    rbuf: BytesMut,
    epoch: Instant,
    next_port: u16,
    /// raw frames received from the stack that were not IPv4/ARP for smoltcp
    pub frames_in: u64,
}

impl Guest {
    pub fn new(h: &mut Harness) -> Self {
        let (rd, wr) = tokio::io::split(h.pipe.take().unwrap());
        let mut dev = GuestDevice { rx: VecDeque::new(), tx: Vec::new() };
        let mut config = Config::new(HardwareAddress::Ethernet(EthernetAddress(GUEST_MAC.0)));
        config.random_seed = 42;
        let mut iface = Interface::new(config, &mut dev, SmolInstant::from_millis(0));
        iface.update_ip_addrs(|a| {
            a.push(IpCidr::new(IpAddress::Ipv4(GUEST_IP), 24)).unwrap();
        });
        iface.routes_mut().add_default_ipv4_route(GATEWAY_IP).unwrap();
        Guest {
            iface,
            sockets: SocketSet::new(Vec::new()),
            dev,
            rd,
            wr,
            rbuf: BytesMut::with_capacity(1 << 20),
            epoch: Instant::now(),
            next_port: 40000,
            frames_in: 0,
        }
    }

    fn now(&self) -> SmolInstant {
        SmolInstant::from_micros(self.epoch.elapsed().as_micros() as i64)
    }

    /// Opens a TCP connection; returns the socket handle.
    pub fn connect(&mut self, dst: Ipv4Addr, port: u16, buf: usize) -> SocketHandle {
        let mut socket = tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0; buf]),
            tcp::SocketBuffer::new(vec![0; buf]),
        );
        socket.set_nagle_enabled(false);
        let local = self.next_port;
        self.next_port += 1;
        socket.connect(self.iface.context(), (dst, port), local).unwrap();
        self.sockets.add(socket)
    }

    pub fn tcp(&mut self, h: SocketHandle) -> &mut tcp::Socket<'static> {
        self.sockets.get_mut::<tcp::Socket>(h)
    }

    async fn flush(&mut self) {
        if !self.dev.tx.is_empty() {
            let out = std::mem::take(&mut self.dev.tx);
            self.wr.write_all(&out).await.unwrap();
        }
    }

    /// Runs the guest until `f` returns `Some`, failing after `timeout`
    /// (the panic names the caller).
    #[track_caller]
    pub fn run_until<'a, T: 'a>(
        &'a mut self,
        timeout: Duration,
        f: impl FnMut(&mut Guest) -> Option<T> + 'a,
    ) -> impl std::future::Future<Output = T> + 'a {
        let caller = std::panic::Location::caller();
        self.run_until_at(timeout, f, caller)
    }

    async fn run_until_at<T>(
        &mut self,
        timeout: Duration,
        mut f: impl FnMut(&mut Guest) -> Option<T>,
        caller: &'static std::panic::Location<'static>,
    ) -> T {
        let deadline = Instant::now() + timeout;
        loop {
            let now = self.now();
            self.iface.poll(now, &mut self.dev, &mut self.sockets);
            if let Some(out) = f(self) {
                self.iface.poll(self.now(), &mut self.dev, &mut self.sockets);
                self.flush().await;
                return out;
            }
            self.iface.poll(self.now(), &mut self.dev, &mut self.sockets);
            self.flush().await;
            assert!(Instant::now() < deadline, "guest timed out ({caller})");
            let delay = self
                .iface
                .poll_delay(self.now(), &self.sockets)
                .map(|d| Duration::from_micros(d.total_micros()))
                .unwrap_or(Duration::from_millis(5))
                .min(Duration::from_millis(5));
            if !self.dev.tx.is_empty() || delay.is_zero() {
                continue;
            }
            if let Ok(res) = tokio::time::timeout(delay, self.rd.read_buf(&mut self.rbuf)).await {
                let n = res.unwrap();
                assert!(n > 0, "stack closed the netdev stream");
                while self.rbuf.len() >= 4 {
                    let len = u32::from_be_bytes(self.rbuf[..4].try_into().unwrap()) as usize;
                    if self.rbuf.len() < 4 + len {
                        break;
                    }
                    self.rbuf.advance(4);
                    let frame = self.rbuf.split_to(len).to_vec();
                    self.frames_in += 1;
                    self.dev.rx.push_back(frame);
                }
            }
        }
    }

    /// Runs the guest for `dur` (keeps ACKing etc.).
    pub async fn idle(&mut self, dur: Duration) {
        let end = Instant::now() + dur;
        self.run_until(dur + Duration::from_secs(30), |_| (Instant::now() >= end).then_some(()))
            .await
    }

    /// Connects and waits for the handshake.
    #[track_caller]
    pub fn connect_established(
        &mut self,
        dst: Ipv4Addr,
        port: u16,
        buf: usize,
    ) -> impl std::future::Future<Output = SocketHandle> + '_ {
        let caller = std::panic::Location::caller();
        let h = self.connect(dst, port, buf);
        async move {
            self.run_until_at(
                Duration::from_secs(30),
                |g| {
                    let s = g.tcp(h);
                    assert!(s.is_open(), "connect failed: {}", s.state());
                    (s.state() == tcp::State::Established).then_some(())
                },
                caller,
            )
            .await;
            h
        }
    }
}

/// Deterministic test pattern.
pub fn pattern(offset: usize, len: usize) -> Vec<u8> {
    (offset..offset + len).map(|i| (i % 251) as u8).collect()
}

//! `NetStack::serve_frames`: one Ethernet frame per datagram, with and without
//! Linux `virtio_net_hdr` offload headers (the Firecracker tap transport).

mod common;

use std::io;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use common::*;
use gondolin_netstack::offload::{VNET_HDR_LEN, VnetHdr};
use gondolin_netstack::wire;
use gondolin_netstack::{FrameSocket, MacAddr, NetConfig, NetStack, TcpFlow};
use tokio::io::AsyncReadExt;
use tokio::net::UnixDatagram;
use tokio::sync::mpsc;

/// A datagram socket whose frames carry a `virtio_net_hdr`.
struct VnetSocket(UnixDatagram);

impl FrameSocket for VnetSocket {
    fn poll_recv_frame(&self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        self.0.poll_recv_frame(cx, buf)
    }
    fn try_recv_frame(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.try_recv_frame(buf)
    }
    fn poll_send_frame(&self, cx: &mut Context<'_>, frame: &[u8]) -> Poll<io::Result<usize>> {
        self.0.poll_send_frame(cx, frame)
    }
    fn vnet_hdr(&self) -> bool {
        true
    }
}

fn spawn_stack<F: FrameSocket>(
    socket: F,
) -> (Arc<NetStack>, mpsc::UnboundedReceiver<TcpFlow>, tokio::task::JoinHandle<io::Result<()>>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let stack = Arc::new(
        NetStack::with_system_resolvers(
            NetConfig::default(),
            Arc::new(ChannelHandler(tx)),
            vec![Ipv4Addr::new(10, 0, 0, 53)],
        )
        .unwrap(),
    );
    let serving = stack.clone();
    let socket = Arc::new(socket);
    let task = tokio::spawn(async move { serving.serve_frames(socket).await });
    (stack, rx, task)
}

async fn recv(guest: &UnixDatagram) -> Vec<u8> {
    let mut buf = vec![0u8; 70_000];
    let n = tokio::time::timeout(Duration::from_secs(5), guest.recv(&mut buf))
        .await
        .expect("frame from the stack")
        .unwrap();
    buf.truncate(n);
    buf
}

fn arp_request(target: Ipv4Addr) -> Vec<u8> {
    let mut p = vec![0u8; 28];
    p[0..2].copy_from_slice(&1u16.to_be_bytes());
    p[2..4].copy_from_slice(&0x0800u16.to_be_bytes());
    p[4] = 6;
    p[5] = 4;
    p[6..8].copy_from_slice(&1u16.to_be_bytes());
    p[8..14].copy_from_slice(&GUEST_MAC.0);
    p[14..18].copy_from_slice(&GUEST_IP.octets());
    p[24..28].copy_from_slice(&target.octets());
    eth_frame(MacAddr::BROADCAST, GUEST_MAC, wire::ETHERTYPE_ARP, &p)
}

#[tokio::test]
async fn plain_datagrams() {
    let (guest, host) = UnixDatagram::pair().unwrap();
    let (_stack, _flows, _task) = spawn_stack(host);
    guest.send(&arp_request(GATEWAY_IP)).await.unwrap();
    let reply = recv(&guest).await;
    let eth = wire::parse_ethernet(&reply).unwrap();
    assert_eq!(eth.ethertype, wire::ETHERTYPE_ARP);
    assert_eq!(eth.src, GATEWAY_MAC);
    assert_eq!(eth.dst, GUEST_MAC);
}

const DST: Ipv4Addr = Ipv4Addr::new(93, 184, 216, 34);
const SPORT: u16 = 40000;
const DPORT: u16 = 80;

/// A guest TCP frame as a NIC with offloads receives it: the TCP checksum
/// field holds only the pseudo-header sum, and `gso_size` > 0 asks for
/// segmentation.
fn offloaded(seq: u32, ack: u32, flags: u8, payload: &[u8], gso_size: u16) -> Vec<u8> {
    let mut seg = tcp_segment(GUEST_IP, SPORT, DST, DPORT, seq, ack, flags, payload);
    let pseudo = wire::pseudo_sum(GUEST_IP, DST, wire::IP_PROTO_TCP, seg.len());
    seg[16..18].copy_from_slice(&(!wire::fold(pseudo)).to_be_bytes());
    let mut ip = ipv4_packet(GUEST_IP, DST, wire::IP_PROTO_TCP, &seg);
    if gso_size > 0 {
        // a super-frame's IP length covers the whole payload
        let len = ip.len() as u16;
        ip[2..4].copy_from_slice(&len.to_be_bytes());
    }
    let frame = eth_frame(GATEWAY_MAC, GUEST_MAC, wire::ETHERTYPE_IPV4, &ip);
    let hdr = VnetHdr {
        flags: 1,                                   // NEEDS_CSUM
        gso_type: if gso_size > 0 { 1 } else { 0 }, // TCPV4
        hdr_len: (wire::ETH_HEADER_LEN + 40) as u16,
        gso_size,
        csum_start: (wire::ETH_HEADER_LEN + 20) as u16,
        csum_offset: 16,
    };
    let mut out = hdr.encode().to_vec();
    out.extend_from_slice(&frame);
    out
}

/// TCP header fields of a frame from the stack (behind its vnet header).
fn tcp_from_stack(datagram: &[u8]) -> (u32, u32, u8, Vec<u8>) {
    let (hdr, frame) = VnetHdr::parse(datagram).unwrap();
    assert_eq!(hdr, VnetHdr::default(), "the stack offloads nothing");
    let ip = parse_ip_frame(frame);
    assert_eq!(ip.proto, wire::IP_PROTO_TCP);
    let t = &ip.payload;
    let seq = u32::from_be_bytes(t[4..8].try_into().unwrap());
    let ack = u32::from_be_bytes(t[8..12].try_into().unwrap());
    let doff = usize::from(t[12] >> 4) * 4;
    (seq, ack, t[13], t[doff..].to_vec())
}

#[tokio::test]
async fn offloaded_tcp_is_completed_and_segmented() {
    let (guest, host) = UnixDatagram::pair().unwrap();
    let (_stack, mut flows, _task) = spawn_stack(VnetSocket(host));
    const SYN: u8 = 0x02;
    const ACK: u8 = 0x10;
    const PSH: u8 = 0x08;

    // handshake, every guest frame with a partial checksum
    let isn = 1000;
    guest.send(&offloaded(isn, 0, SYN, &[], 0)).await.unwrap();
    let (server_isn, ack, flags, _) = tcp_from_stack(&recv(&guest).await);
    assert_eq!(flags & (SYN | ACK), SYN | ACK);
    assert_eq!(ack, isn + 1);
    guest.send(&offloaded(isn + 1, server_isn + 1, ACK, &[], 0)).await.unwrap();
    let flow = tokio::time::timeout(Duration::from_secs(5), flows.recv()).await.unwrap().unwrap();
    assert_eq!(flow.meta.dst.port(), DPORT);

    // one TSO super-frame cut into four segments: the flow sees every byte,
    // in order (kept under macOS's 2 KiB unix datagram limit)
    let payload = pattern(0, 1900);
    guest.send(&offloaded(isn + 1, server_isn + 1, ACK | PSH, &payload, 600)).await.unwrap();
    let mut stream = flow.stream;
    let mut got = vec![0u8; payload.len()];
    tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut got))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got, payload);

    // and the stack acknowledges everything
    let mut acked = 0;
    while acked != isn + 1 + payload.len() as u32 {
        let (_, ack, flags, data) = tcp_from_stack(&recv(&guest).await);
        assert!(data.is_empty() && flags & ACK != 0);
        acked = ack;
    }
}

#[tokio::test]
async fn datagrams_without_a_vnet_header_are_dropped() {
    let (guest, host) = UnixDatagram::pair().unwrap();
    let (_stack, _flows, _task) = spawn_stack(VnetSocket(host));
    guest.send(&[0u8; VNET_HDR_LEN - 1]).await.unwrap();
    // still serving: an ARP request behind a header is answered
    let mut req = VnetHdr::default().encode().to_vec();
    req.extend_from_slice(&arp_request(GATEWAY_IP));
    guest.send(&req).await.unwrap();
    let reply = recv(&guest).await;
    let (_, frame) = VnetHdr::parse(&reply).unwrap();
    assert_eq!(wire::parse_ethernet(frame).unwrap().ethertype, wire::ETHERTYPE_ARP);
}

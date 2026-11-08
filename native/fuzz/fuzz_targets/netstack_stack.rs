//! netstack end to end: a structured sequence of guest frames (raw, ARP, ICMP,
//! UDP/DNS/DHCP, TCP with sequence numbers optionally taken from the stack's
//! last segment so handshakes complete) is fed to a real `NetStack`; flows are
//! echoed. Checks that nothing panics or hangs.
#![no_main]

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use arbitrary::Arbitrary;
use bytes::{Buf, BytesMut};
use gondolin_netstack::{
    DnsConfig, FlowHandler, MacAddr, NetConfig, NetStack, SyntheticHostMapping, TcpFlow, wire,
};
use libfuzzer_sys::fuzz_target;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const GUEST_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 127, 3);
const GATEWAY_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 127, 1);
const GUEST_MAC: MacAddr = MacAddr([0x02, 0, 0, 0, 0, 1]);
const GATEWAY_MAC: MacAddr = MacAddr([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);

#[derive(Debug, Arbitrary)]
enum Packet {
    Raw(Vec<u8>),
    Ethernet {
        ethertype: u16,
        body: Vec<u8>,
    },
    Ip {
        proto: u8,
        dst: [u8; 4],
        body: Vec<u8>,
    },
    Udp {
        sport: u16,
        dport: u16,
        dst: [u8; 4],
        payload: Vec<u8>,
        bad_checksum: bool,
    },
    Dns {
        sport: u16,
        payload: Vec<u8>,
    },
    Dhcp {
        payload: Vec<u8>,
    },
    Icmp {
        dst: [u8; 4],
        payload: Vec<u8>,
    },
    Tcp {
        sport: u8,
        dport: u16,
        flags: u8,
        seq_delta: u16,
        /// acknowledge the stack's last segment on this port
        ack_stack: bool,
        window: u16,
        payload: Vec<u8>,
    },
    /// SYN, ACK of the stack's SYN-ACK, then data (completes handshakes)
    Connect {
        sport: u8,
        dport: u16,
        payload: Vec<u8>,
    },
    Wait(u8),
}

struct Echo;

static FLOWS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl FlowHandler for Echo {
    fn handle_tcp(&self, flow: TcpFlow) -> gondolin_netstack::BoxFuture<'_, ()> {
        Box::pin(async move {
            // `FUZZ_REPORT_FLOWS=1`: shows that handshakes complete
            let n = FLOWS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if n.is_power_of_two() && std::env::var_os("FUZZ_REPORT_FLOWS").is_some() {
                eprintln!("netstack_stack: {} flows accepted", n + 1);
            }
            let (mut rd, mut wr) = tokio::io::split(flow.stream);
            let _ = tokio::io::copy(&mut rd, &mut wr).await;
            let _ = wr.shutdown().await;
        })
    }
}

#[derive(Default, Clone, Copy)]
struct TcpState {
    /// next sequence number we send
    seq: u32,
    /// next sequence number expected from the stack
    ack: u32,
}

fn tcp_segment(
    src: Ipv4Addr,
    sport: u16,
    dst: Ipv4Addr,
    dport: u16,
    seq: u32,
    ack: u32,
    flags: u8,
    window: u16,
    payload: &[u8],
) -> Vec<u8> {
    let mut seg = vec![0u8; 20];
    seg[0..2].copy_from_slice(&sport.to_be_bytes());
    seg[2..4].copy_from_slice(&dport.to_be_bytes());
    seg[4..8].copy_from_slice(&seq.to_be_bytes());
    seg[8..12].copy_from_slice(&ack.to_be_bytes());
    seg[12] = 0x50;
    seg[13] = flags;
    seg[14..16].copy_from_slice(&window.to_be_bytes());
    seg.extend_from_slice(payload);
    let ck =
        wire::fold(wire::sum16(wire::pseudo_sum(src, dst, wire::IP_PROTO_TCP, seg.len()), &seg));
    seg[16..18].copy_from_slice(&ck.to_be_bytes());
    seg
}

/// Updates per-port TCP state from frames the stack sent.
fn observe(out: &mut BytesMut, tcp: &mut HashMap<u16, TcpState>) {
    while out.len() >= 4 {
        let len = u32::from_be_bytes(out[..4].try_into().unwrap()) as usize;
        if out.len() < 4 + len {
            return;
        }
        out.advance(4);
        let frame = out.split_to(len);
        let Some(eth) = wire::parse_ethernet(&frame) else { continue };
        let Ok(ip) = wire::parse_ipv4(eth.payload) else { continue };
        if ip.protocol != wire::IP_PROTO_TCP || ip.payload.len() < 20 {
            continue;
        }
        let p = ip.payload;
        let dport = u16::from_be_bytes([p[2], p[3]]);
        let seq = u32::from_be_bytes([p[4], p[5], p[6], p[7]]);
        let ack = u32::from_be_bytes([p[8], p[9], p[10], p[11]]);
        let flags = p[13];
        let hlen = usize::from(p[12] >> 4) * 4;
        let data = p.len().saturating_sub(hlen) as u32;
        let syn_fin = u32::from(flags & (wire::TCP_SYN | wire::TCP_FIN) != 0);
        let state = tcp.entry(dport).or_default();
        state.ack = seq.wrapping_add(data).wrapping_add(syn_fin);
        if flags & wire::TCP_ACK != 0 {
            state.seq = ack;
        }
    }
}

fuzz_target!(|packets: Vec<Packet>| {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async move {
        let config = NetConfig {
            dns: DnsConfig {
                synthetic_host_mapping: SyntheticHostMapping::PerHost,
                ..DnsConfig::default()
            },
            ..NetConfig::default()
        };
        let stack = Arc::new(
            NetStack::with_system_resolvers(
                config,
                Arc::new(Echo),
                vec![Ipv4Addr::new(10, 0, 0, 53)],
            )
            .unwrap(),
        );
        let (guest, host) = tokio::io::duplex(1 << 20);
        let serve_stack = stack.clone();
        let serve = tokio::spawn(async move { serve_stack.serve(host).await });
        let (mut rd, mut wr) = tokio::io::split(guest);
        let mut out = BytesMut::new();
        let mut tcp: HashMap<u16, TcpState> = HashMap::new();

        let run = async {
            let mut queue: std::collections::VecDeque<Packet> =
                packets.into_iter().take(64).collect();
            while let Some(packet) = queue.pop_front() {
                let mut frame = BytesMut::new();
                match packet {
                    Packet::Connect { sport, dport, payload } => {
                        let syn = Packet::Tcp {
                            sport,
                            dport,
                            flags: wire::TCP_SYN,
                            seq_delta: 0,
                            ack_stack: false,
                            window: 65535,
                            payload: Vec::new(),
                        };
                        let ack = Packet::Tcp {
                            sport,
                            dport,
                            flags: wire::TCP_ACK,
                            seq_delta: 0,
                            ack_stack: true,
                            window: 65535,
                            payload: Vec::new(),
                        };
                        let data = Packet::Tcp {
                            sport,
                            dport,
                            flags: wire::TCP_ACK | 0x08,
                            seq_delta: 0,
                            ack_stack: true,
                            window: 65535,
                            payload,
                        };
                        queue.push_front(data);
                        queue.push_front(ack);
                        queue.push_front(syn);
                        continue;
                    }
                    Packet::Raw(bytes) => {
                        frame.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
                        frame.extend_from_slice(&bytes);
                    }
                    Packet::Ethernet { ethertype, body } => {
                        wire::put_frame(
                            &mut frame,
                            GATEWAY_MAC,
                            GUEST_MAC,
                            ethertype,
                            body.len(),
                            |b| b.copy_from_slice(&body),
                        );
                    }
                    Packet::Ip { proto, dst, body } => {
                        wire::put_ipv4_frame(
                            &mut frame,
                            GATEWAY_MAC,
                            GUEST_MAC,
                            GUEST_IP,
                            dst.into(),
                            proto,
                            &body,
                        );
                    }
                    Packet::Udp { sport, dport, dst, payload, bad_checksum } => {
                        let mut dgram =
                            wire::udp_datagram(GUEST_IP, sport, dst.into(), dport, &payload);
                        if bad_checksum && dgram.len() >= 8 {
                            dgram[6] ^= 0x55;
                        }
                        wire::put_ipv4_frame(
                            &mut frame,
                            GATEWAY_MAC,
                            GUEST_MAC,
                            GUEST_IP,
                            dst.into(),
                            wire::IP_PROTO_UDP,
                            &dgram,
                        );
                    }
                    Packet::Dns { sport, payload } => {
                        let dgram = wire::udp_datagram(GUEST_IP, sport, GATEWAY_IP, 53, &payload);
                        wire::put_ipv4_frame(
                            &mut frame,
                            GATEWAY_MAC,
                            GUEST_MAC,
                            GUEST_IP,
                            GATEWAY_IP,
                            wire::IP_PROTO_UDP,
                            &dgram,
                        );
                    }
                    Packet::Dhcp { payload } => {
                        let bcast = Ipv4Addr::BROADCAST;
                        let dgram =
                            wire::udp_datagram(Ipv4Addr::UNSPECIFIED, 68, bcast, 67, &payload);
                        wire::put_ipv4_frame(
                            &mut frame,
                            MacAddr::BROADCAST,
                            GUEST_MAC,
                            Ipv4Addr::UNSPECIFIED,
                            bcast,
                            wire::IP_PROTO_UDP,
                            &dgram,
                        );
                    }
                    Packet::Icmp { dst, payload } => {
                        let mut icmp = vec![8, 0, 0, 0, 0, 1, 0, 1];
                        icmp.extend_from_slice(&payload);
                        let ck = wire::checksum(&icmp);
                        icmp[2..4].copy_from_slice(&ck.to_be_bytes());
                        wire::put_ipv4_frame(
                            &mut frame,
                            GATEWAY_MAC,
                            GUEST_MAC,
                            GUEST_IP,
                            dst.into(),
                            wire::IP_PROTO_ICMP,
                            &icmp,
                        );
                    }
                    Packet::Tcp { sport, dport, flags, seq_delta, ack_stack, window, payload } => {
                        let sport = 40000 + u16::from(sport % 8);
                        let state = *tcp.entry(sport).or_insert(TcpState { seq: 1000, ack: 0 });
                        let seq = state.seq.wrapping_add(u32::from(seq_delta));
                        let ack = if ack_stack { state.ack } else { 0 };
                        let flags = if ack_stack { flags | wire::TCP_ACK } else { flags };
                        let dst = Ipv4Addr::new(93, 184, 216, 34);
                        let seg = tcp_segment(
                            GUEST_IP,
                            sport,
                            dst,
                            dport,
                            seq,
                            ack,
                            flags,
                            window.max(1024),
                            &payload,
                        );
                        wire::put_ipv4_frame(
                            &mut frame,
                            GATEWAY_MAC,
                            GUEST_MAC,
                            GUEST_IP,
                            dst,
                            wire::IP_PROTO_TCP,
                            &seg,
                        );
                        let advance = payload.len() as u32
                            + u32::from(flags & (wire::TCP_SYN | wire::TCP_FIN) != 0);
                        tcp.get_mut(&sport).unwrap().seq = seq.wrapping_add(advance);
                    }
                    Packet::Wait(ms) => {
                        tokio::time::sleep(Duration::from_millis(u64::from(ms % 20))).await;
                    }
                }
                if !frame.is_empty() && wr.write_all(&frame).await.is_err() {
                    break;
                }
                // let the stack react, then learn its sequence numbers
                for _ in 0..8 {
                    tokio::task::yield_now().await;
                }
                let mut buf = [0u8; 65536];
                while let Ok(Ok(n)) =
                    tokio::time::timeout(Duration::from_millis(1), rd.read(&mut buf)).await
                {
                    if n == 0 {
                        break;
                    }
                    out.extend_from_slice(&buf[..n]);
                }
                observe(&mut out, &mut tcp);
            }
        };
        tokio::time::timeout(Duration::from_secs(10), run).await.expect("stack hung");
        drop(wr);
        drop(rd);
        tokio::time::timeout(Duration::from_secs(10), serve)
            .await
            .expect("serve did not end after the netdev closed")
            .unwrap()
            .ok();
    });
});

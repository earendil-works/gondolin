//! Synthetic-frame tests: ARP, DHCP, ICMP, DNS in every mode, malformed input.

mod common;

use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use gondolin_netstack::dhcp::parse_options;
use gondolin_netstack::wire;
use gondolin_netstack::{
    DnsConfig, DnsMode, MacAddr, NetConfig, NetStack, NetStackError, SyntheticHostMapping,
};

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
async fn arp_request_for_gateway_gets_reply() {
    let (mut h, _flows) = channel_harness(NetConfig::default());
    let mut g = RawGuest::new(&mut h);
    g.send(&arp_request(GATEWAY_IP)).await;
    let reply = g.recv().await;
    let eth = wire::parse_ethernet(&reply).unwrap();
    assert_eq!(eth.ethertype, wire::ETHERTYPE_ARP);
    assert_eq!(eth.dst, GUEST_MAC);
    assert_eq!(eth.src, GATEWAY_MAC);
    let p = eth.payload;
    assert_eq!(u16::from_be_bytes([p[6], p[7]]), 2);
    assert_eq!(&p[8..14], &GATEWAY_MAC.0);
    assert_eq!(&p[14..18], &GATEWAY_IP.octets());
    assert_eq!(&p[18..24], &GUEST_MAC.0);
    assert_eq!(&p[24..28], &GUEST_IP.octets());

    // Other targets and truncated requests are ignored.
    g.send(&arp_request(Ipv4Addr::new(192, 168, 127, 9))).await;
    let truncated = arp_request(GATEWAY_IP);
    g.send(&truncated[..30]).await;
    g.expect_silence().await;
}

fn icmp_echo(id: u16, seq: u16, data: &[u8]) -> Vec<u8> {
    let mut p = vec![8, 0, 0, 0];
    p.extend_from_slice(&id.to_be_bytes());
    p.extend_from_slice(&seq.to_be_bytes());
    p.extend_from_slice(data);
    let ck = wire::checksum(&p);
    p[2..4].copy_from_slice(&ck.to_be_bytes());
    p
}

#[tokio::test]
async fn icmp_echo_gets_reply_from_any_destination() {
    let (mut h, _flows) = channel_harness(NetConfig::default());
    let mut g = RawGuest::new(&mut h);
    for dst in [GATEWAY_IP, Ipv4Addr::new(8, 8, 8, 8)] {
        let echo = icmp_echo(0x1234, 7, b"ping payload");
        g.send(&guest_ip_frame(GUEST_IP, dst, wire::IP_PROTO_ICMP, &echo)).await;
        let rx = parse_ip_frame(&g.recv().await);
        assert_eq!(rx.proto, wire::IP_PROTO_ICMP);
        assert_eq!(rx.src, dst);
        assert_eq!(rx.dst, GUEST_IP);
        assert_eq!(rx.dst_mac, GUEST_MAC);
        assert_eq!(rx.ttl, 64);
        assert_eq!(rx.payload[0], 0);
        assert_eq!(wire::checksum(&rx.payload), 0);
        assert_eq!(&rx.payload[4..], &echo[4..]);
    }

    // Bad ICMP checksum, non-echo types and spoofed sources get nothing.
    let mut bad = icmp_echo(1, 1, b"x");
    bad[2] ^= 0xff;
    g.send(&guest_ip_frame(GUEST_IP, GATEWAY_IP, wire::IP_PROTO_ICMP, &bad)).await;
    let mut reply_type = icmp_echo(1, 1, b"x");
    reply_type[0] = 0;
    g.send(&guest_ip_frame(GUEST_IP, GATEWAY_IP, wire::IP_PROTO_ICMP, &reply_type)).await;
    let echo = icmp_echo(1, 1, b"x");
    g.send(&guest_ip_frame(Ipv4Addr::new(10, 1, 1, 1), GATEWAY_IP, wire::IP_PROTO_ICMP, &echo))
        .await;
    g.expect_silence().await;
}

fn dhcp_request(msg_type: u8, broadcast: bool) -> Vec<u8> {
    let mut bootp = vec![0u8; 240];
    bootp[0] = 1;
    bootp[1] = 1;
    bootp[2] = 6;
    bootp[4..8].copy_from_slice(&0x0a0b0c0du32.to_be_bytes());
    if broadcast {
        bootp[10] = 0x80;
    }
    bootp[28..34].copy_from_slice(&GUEST_MAC.0);
    bootp[236..240].copy_from_slice(&0x63825363u32.to_be_bytes());
    bootp.extend_from_slice(&[53, 1, msg_type, 0, 255]);
    let dgram = wire::udp_datagram(Ipv4Addr::UNSPECIFIED, 68, Ipv4Addr::BROADCAST, 67, &bootp);
    eth_frame(
        MacAddr::BROADCAST,
        GUEST_MAC,
        wire::ETHERTYPE_IPV4,
        &ipv4_packet(Ipv4Addr::UNSPECIFIED, Ipv4Addr::BROADCAST, wire::IP_PROTO_UDP, &dgram),
    )
}

fn option(opts: &[(u8, Vec<u8>)], code: u8) -> Vec<u8> {
    opts.iter()
        .find(|(c, _)| *c == code)
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| panic!("missing dhcp option {code}"))
}

async fn dhcp_exchange(config: NetConfig, resolvers: Vec<Ipv4Addr>) -> Vec<(u8, Vec<u8>)> {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut h = start_with_resolvers(config, Arc::new(ChannelHandler(tx)), resolvers);
    let mut g = RawGuest::new(&mut h);

    g.send(&dhcp_request(1, true)).await;
    let (rx, sport, dport, offer) = parse_udp_frame(&g.recv().await);
    assert_eq!((sport, dport), (67, 68));
    assert_eq!(rx.src, GATEWAY_IP);
    assert_eq!(rx.dst, Ipv4Addr::BROADCAST);
    assert_eq!(rx.dst_mac, MacAddr::BROADCAST);
    assert_eq!(offer.len(), 300);
    assert_eq!(offer[0], 2);
    assert_eq!(&offer[4..8], &0x0a0b0c0du32.to_be_bytes());
    assert_eq!(&offer[16..20], &GUEST_IP.octets());
    assert_eq!(&offer[20..24], &GATEWAY_IP.octets());
    assert_eq!(&offer[28..34], &GUEST_MAC.0);
    let opts = parse_options(&offer);
    assert_eq!(option(&opts, 53), vec![2]);

    // Unicast reply when the client did not ask for broadcast.
    g.send(&dhcp_request(3, false)).await;
    let (rx, _, _, ack) = parse_udp_frame(&g.recv().await);
    assert_eq!(rx.dst_mac, GUEST_MAC);
    let opts = parse_options(&ack);
    assert_eq!(option(&opts, 53), vec![5]);
    assert_eq!(option(&opts, 54), GATEWAY_IP.octets().to_vec());
    assert_eq!(option(&opts, 51), 86400u32.to_be_bytes().to_vec());
    assert_eq!(option(&opts, 1), vec![255, 255, 255, 0]);
    assert_eq!(option(&opts, 3), GATEWAY_IP.octets().to_vec());
    assert_eq!(option(&opts, 28), vec![192, 168, 127, 255]);

    // Other message types (RELEASE) get no answer.
    g.send(&dhcp_request(7, true)).await;
    g.expect_silence().await;
    opts
}

#[tokio::test]
async fn dhcp_offer_and_ack_advertise_gateway_dns() {
    let opts = dhcp_exchange(NetConfig::default(), vec![Ipv4Addr::new(10, 0, 0, 2)]).await;
    assert_eq!(option(&opts, 6), GATEWAY_IP.octets().to_vec());

    let trusted = NetConfig {
        dns: DnsConfig { mode: DnsMode::Trusted, ..DnsConfig::default() },
        ..NetConfig::default()
    };
    let opts = dhcp_exchange(trusted, vec![Ipv4Addr::new(10, 0, 0, 2)]).await;
    assert_eq!(option(&opts, 6), GATEWAY_IP.octets().to_vec());
}

#[tokio::test]
async fn dhcp_open_mode_advertises_host_resolvers_without_loopback() {
    let open = || NetConfig {
        dns: DnsConfig { mode: DnsMode::Open, ..DnsConfig::default() },
        ..NetConfig::default()
    };
    let opts =
        dhcp_exchange(open(), vec![Ipv4Addr::new(127, 0, 0, 53), Ipv4Addr::new(10, 0, 0, 2)]).await;
    assert_eq!(option(&opts, 6), vec![10, 0, 0, 2]);
    let opts = dhcp_exchange(open(), vec![Ipv4Addr::new(127, 0, 0, 53)]).await;
    assert_eq!(option(&opts, 6), vec![8, 8, 8, 8]);
}

fn dns_query(id: u16, name: &str, qtype: u16) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(&0x0100u16.to_be_bytes());
    out.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 0]);
    for label in name.split('.').filter(|l| !l.is_empty()) {
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    out.extend_from_slice(&qtype.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    out
}

fn answer_rdata(resp: &[u8]) -> Vec<u8> {
    assert_eq!(u16::from_be_bytes([resp[6], resp[7]]), 1, "one answer");
    // Skip header and the question.
    let mut off = 12;
    while resp[off] != 0 {
        off += 1 + usize::from(resp[off]);
    }
    off += 5;
    let rdlen = usize::from(u16::from_be_bytes([resp[off + 10], resp[off + 11]]));
    resp[off + 12..off + 12 + rdlen].to_vec()
}

#[tokio::test]
async fn dns_synthetic_single_mapping() {
    let config = NetConfig {
        dns: DnsConfig {
            synthetic_ipv4: Ipv4Addr::new(192, 0, 2, 42),
            synthetic_ipv6: Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0x42),
            synthetic_ttl_seconds: 5,
            ..DnsConfig::default()
        },
        ..NetConfig::default()
    };
    let (mut h, _flows) = channel_harness(config);
    let mut g = RawGuest::new(&mut h);
    // Any destination IP works; the reply comes from that IP.
    let target = Ipv4Addr::new(1, 1, 1, 1);
    g.send(&guest_udp_frame(5353, target, 53, &dns_query(9, "example.com", 1))).await;
    let (rx, sport, dport, resp) = parse_udp_frame(&g.recv().await);
    assert_eq!((rx.src, rx.dst, sport, dport), (target, GUEST_IP, 53, 5353));
    assert_eq!(&resp[0..2], &9u16.to_be_bytes());
    assert_eq!(answer_rdata(&resp), vec![192, 0, 2, 42]);

    g.send(&guest_udp_frame(5353, GATEWAY_IP, 53, &dns_query(10, "example.com", 28))).await;
    let (_, _, _, resp) = parse_udp_frame(&g.recv().await);
    assert_eq!(
        answer_rdata(&resp),
        Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0x42).octets().to_vec()
    );

    g.send(&guest_udp_frame(5353, GATEWAY_IP, 53, &dns_query(11, "db.localhost", 1))).await;
    let (_, _, _, resp) = parse_udp_frame(&g.recv().await);
    assert_eq!(answer_rdata(&resp), vec![127, 0, 0, 1]);

    // Not DNS, not port 53, or a response: dropped.
    g.send(&guest_udp_frame(5353, GATEWAY_IP, 53, b"tunnel")).await;
    g.send(&guest_udp_frame(5353, GATEWAY_IP, 5300, &dns_query(12, "example.com", 1))).await;
    let mut response = dns_query(13, "example.com", 1);
    response[2] |= 0x80;
    g.send(&guest_udp_frame(5353, GATEWAY_IP, 53, &response)).await;
    g.expect_silence().await;
    assert_eq!(h.stack.stats().udp_sessions, 0);
}

#[tokio::test]
async fn dns_synthetic_per_host_mapping() {
    let config = NetConfig {
        dns: DnsConfig {
            synthetic_host_mapping: SyntheticHostMapping::PerHost,
            ..DnsConfig::default()
        },
        ..NetConfig::default()
    };
    let (mut h, _flows) = channel_harness(config);
    let mut g = RawGuest::new(&mut h);
    let mut resolve = async |name: &str| {
        g.send(&guest_udp_frame(5353, GATEWAY_IP, 53, &dns_query(1, name, 1))).await;
        let (_, _, _, resp) = parse_udp_frame(&g.recv().await);
        answer_rdata(&resp)
    };
    assert_eq!(resolve("api.example.com").await, vec![198, 19, 0, 1]);
    assert_eq!(resolve("github.com").await, vec![198, 19, 0, 2]);
    assert_eq!(resolve("API.Example.com").await, vec![198, 19, 0, 1]);
    assert_eq!(resolve("localhost").await, vec![127, 0, 0, 1]);
    // The root name can't be mapped and falls back to the single address.
    assert_eq!(resolve("").await, vec![192, 0, 2, 1]);
    let hosts = h.stack.synthetic_hosts();
    assert_eq!(hosts.lookup(Ipv4Addr::new(198, 19, 0, 2)).as_deref(), Some("github.com"));
}

#[tokio::test]
async fn dns_trusted_requires_resolvers() {
    let config = NetConfig {
        dns: DnsConfig { mode: DnsMode::Trusted, ..DnsConfig::default() },
        ..NetConfig::default()
    };
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let err = NetStack::with_system_resolvers(config.clone(), Arc::new(ChannelHandler(tx)), vec![])
        .err()
        .expect("must fail");
    assert!(matches!(err, NetStackError::NoTrustedResolvers));
    let mut explicit = config;
    explicit.dns.trusted_servers = vec![Ipv4Addr::new(1, 1, 1, 1)];
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    assert!(
        NetStack::with_system_resolvers(explicit, Arc::new(ChannelHandler(tx)), vec![]).is_ok()
    );
}

/// Runs a fake resolver on 127.0.0.1 that answers with `reply_prefix + query`.
async fn fake_resolver(reply_prefix: &'static [u8]) -> (u16, tokio::task::JoinHandle<()>) {
    let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = socket.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let mut buf = vec![0u8; 2048];
        loop {
            let (n, peer) = socket.recv_from(&mut buf).await.unwrap();
            let mut reply = reply_prefix.to_vec();
            reply.extend_from_slice(&buf[..n]);
            socket.send_to(&reply, peer).await.unwrap();
        }
    });
    (port, task)
}

#[tokio::test]
async fn dns_trusted_forwards_valid_queries_to_trusted_resolver() {
    let (port, _server) = fake_resolver(b"T:").await;
    let config = NetConfig {
        dns: DnsConfig {
            mode: DnsMode::Trusted,
            trusted_servers: vec![Ipv4Addr::LOCALHOST],
            ..DnsConfig::default()
        },
        ..NetConfig::default()
    };
    let (mut h, _flows) = channel_harness(config);
    h.stack.set_dns_upstream_port(port);
    let mut g = RawGuest::new(&mut h);
    // The guest targets some other resolver; the query goes to the trusted one
    // and the reply appears to come from the targeted address.
    let target = Ipv4Addr::new(9, 9, 9, 9);
    let query = dns_query(77, "example.com", 1);
    g.send(&guest_udp_frame(40000, target, 53, &query)).await;
    let (rx, sport, dport, resp) = parse_udp_frame(&g.recv().await);
    assert_eq!((rx.src, sport, dport), (target, 53, 40000));
    assert_eq!(&resp[..2], b"T:");
    assert_eq!(&resp[2..], &query[..]);
    assert_eq!(h.stack.stats().udp_sessions, 1);

    // Non-DNS payloads are not forwarded.
    g.send(&guest_udp_frame(40001, target, 53, b"not dns at all")).await;
    g.expect_silence().await;
    assert_eq!(h.stack.stats().udp_sessions, 1);
}

#[tokio::test]
async fn dns_open_forwards_anything_to_the_targeted_ip() {
    let (port, _server) = fake_resolver(b"O:").await;
    let config = NetConfig {
        dns: DnsConfig { mode: DnsMode::Open, ..DnsConfig::default() },
        limits: gondolin_netstack::NetLimits {
            max_udp_sessions: 2,
            // long enough that a slow (emulated, loaded) machine still sees
            // the replies before the sessions go idle
            udp_session_idle_timeout_ms: 2_000,
            ..Default::default()
        },
        ..NetConfig::default()
    };
    let (mut h, _flows) = channel_harness(config);
    h.stack.set_dns_upstream_port(port);
    let mut g = RawGuest::new(&mut h);
    for sport in [41000, 41001, 41002] {
        g.send(&guest_udp_frame(sport, Ipv4Addr::LOCALHOST, 53, b"opaque")).await;
        let (rx, _, dport, resp) = parse_udp_frame(&g.recv().await);
        assert_eq!((rx.src, dport), (Ipv4Addr::LOCALHOST, sport));
        assert_eq!(resp, b"O:opaque");
    }
    // Capped (LRU eviction) and closed when idle.
    assert_eq!(h.stack.stats().udp_sessions, 2);
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while h.stack.stats().udp_sessions != 0 {
        assert!(std::time::Instant::now() < deadline, "udp sessions never went idle");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn qemu_framing_handles_partial_and_coalesced_writes() {
    let (mut h, _flows) = channel_harness(NetConfig::default());
    let mut g = RawGuest::new(&mut h);
    let mut bytes = qemu_frame(&arp_request(GATEWAY_IP));
    bytes.extend_from_slice(&qemu_frame(&arp_request(GATEWAY_IP)));
    // Byte-at-a-time across two frames, then both at once.
    for b in &bytes {
        g.send_raw(&[*b]).await;
    }
    g.recv().await;
    g.recv().await;
    g.send_raw(&bytes).await;
    g.recv().await;
    g.recv().await;
}

#[tokio::test]
async fn malformed_packets_are_dropped() {
    let (mut h, _flows) = channel_harness(NetConfig::default());
    let mut g = RawGuest::new(&mut h);
    let query = dns_query(1, "example.com", 1);
    let good = guest_udp_frame(5353, GATEWAY_IP, 53, &query);

    // Short frames.
    g.send(&[]).await;
    g.send(&good[..10]).await;
    // Truncated IPv4 header / total length beyond the frame.
    g.send(&good[..20]).await;
    g.send(&good[..good.len() - 4]).await;
    // Bad IP header checksum.
    let mut bad_ip = good.clone();
    bad_ip[14 + 10] ^= 0x55;
    g.send(&bad_ip).await;
    // Bad UDP checksum.
    let mut bad_udp = good.clone();
    let last = bad_udp.len() - 1;
    bad_udp[last] ^= 0x55;
    g.send(&bad_udp).await;
    // Fragments (MF set, and non-zero offset).
    for frag in [0x2000u16, 0x0001] {
        let mut ip = ipv4_packet(
            GUEST_IP,
            GATEWAY_IP,
            wire::IP_PROTO_UDP,
            &wire::udp_datagram(GUEST_IP, 5353, GATEWAY_IP, 53, &query),
        );
        ip[6..8].copy_from_slice(&frag.to_be_bytes());
        ip[10..12].fill(0);
        let ck = wire::checksum(&ip[..20]);
        ip[10..12].copy_from_slice(&ck.to_be_bytes());
        g.send(&eth_frame(GATEWAY_MAC, GUEST_MAC, wire::ETHERTYPE_IPV4, &ip)).await;
    }
    // IPv6 and unknown ethertypes / protocols.
    g.send(&eth_frame(GATEWAY_MAC, GUEST_MAC, 0x86dd, &[0x60; 60])).await;
    g.send(&guest_ip_frame(GUEST_IP, GATEWAY_IP, 47, b"gre")).await;
    // Truncated TCP header.
    g.send(&guest_ip_frame(GUEST_IP, GATEWAY_IP, wire::IP_PROTO_TCP, &[0; 10])).await;
    g.expect_silence().await;

    // The stack still works afterwards.
    g.send(&good).await;
    let (_, _, _, resp) = parse_udp_frame(&g.recv().await);
    assert_eq!(answer_rdata(&resp), vec![192, 0, 2, 1]);
}

#[tokio::test]
async fn oversized_frame_length_ends_serve() {
    let (mut h, _flows) = channel_harness(NetConfig::default());
    let mut g = RawGuest::new(&mut h);
    g.send_raw(&0x0100_0000u32.to_be_bytes()).await;
    let result =
        tokio::time::timeout(Duration::from_secs(30), &mut h.serve).await.unwrap().unwrap();
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::InvalidData);
}

#[tokio::test]
async fn tcp_from_unknown_flow_gets_rst_and_spoofed_source_is_ignored() {
    let (mut h, _flows) = channel_harness(NetConfig::default());
    let mut g = RawGuest::new(&mut h);
    let dst = Ipv4Addr::new(93, 184, 216, 34);
    // ACK for a connection that does not exist → RST.
    let seg = tcp_segment(GUEST_IP, 40000, dst, 80, 1000, 5000, wire::TCP_ACK, b"hi");
    g.send(&guest_ip_frame(GUEST_IP, dst, wire::IP_PROTO_TCP, &seg)).await;
    let rx = parse_ip_frame(&g.recv().await);
    assert_eq!(rx.proto, wire::IP_PROTO_TCP);
    assert_eq!((rx.src, rx.dst), (dst, GUEST_IP));
    assert_ne!(rx.payload[13] & wire::TCP_RST, 0);

    // SYN from a source that is not the guest: nothing.
    let other = Ipv4Addr::new(192, 168, 127, 50);
    let syn = tcp_segment(other, 40001, dst, 80, 1, 0, wire::TCP_SYN, b"");
    g.send(&guest_ip_frame(other, dst, wire::IP_PROTO_TCP, &syn)).await;
    // SYN with a bad TCP checksum: nothing, and no socket leaks.
    let mut bad = tcp_segment(GUEST_IP, 40002, dst, 80, 1, 0, wire::TCP_SYN, b"");
    bad[16] ^= 0xff;
    g.send(&guest_ip_frame(GUEST_IP, dst, wire::IP_PROTO_TCP, &bad)).await;
    // SYN to a broadcast address: nothing.
    let syn = tcp_segment(GUEST_IP, 40003, Ipv4Addr::BROADCAST, 80, 1, 0, wire::TCP_SYN, b"");
    g.send(&guest_ip_frame(GUEST_IP, Ipv4Addr::BROADCAST, wire::IP_PROTO_TCP, &syn)).await;
    g.expect_silence().await;
    assert_eq!(h.stack.stats().tcp_sockets, 0);
}

#[tokio::test]
async fn tcp_syn_gets_syn_ack_with_mss_and_window_scale() {
    let (mut h, _flows) = channel_harness(NetConfig::default());
    let mut g = RawGuest::new(&mut h);
    let dst = Ipv4Addr::new(93, 184, 216, 34);
    // SYN with MSS 1460 and window scale 7.
    let mut syn = tcp_segment(GUEST_IP, 40000, dst, 443, 1000, 0, wire::TCP_SYN, b"");
    syn[12] = 0x70; // 28 bytes header
    syn.extend_from_slice(&[2, 4, 0x05, 0xb4, 1, 3, 3, 7]);
    syn[16..18].fill(0);
    let ck = wire::fold(wire::sum16(
        wire::pseudo_sum(GUEST_IP, dst, wire::IP_PROTO_TCP, syn.len()),
        &syn,
    ));
    syn[16..18].copy_from_slice(&ck.to_be_bytes());
    g.send(&guest_ip_frame(GUEST_IP, dst, wire::IP_PROTO_TCP, &syn)).await;
    let rx = parse_ip_frame(&g.recv().await);
    let tcp = &rx.payload;
    assert_eq!(tcp[13] & (wire::TCP_SYN | wire::TCP_ACK), wire::TCP_SYN | wire::TCP_ACK);
    assert_eq!(u32::from_be_bytes(tcp[8..12].try_into().unwrap()), 1001);
    assert_eq!((rx.src, rx.dst), (dst, GUEST_IP));
    let header_len = usize::from(tcp[12] >> 4) * 4;
    let opts = &tcp[20..header_len];
    assert!(opts.windows(2).any(|w| w == [2, 4]), "MSS option: {opts:02x?}");
    assert!(opts.windows(2).any(|w| w == [3, 3]), "window scale option: {opts:02x?}");
    // A retransmitted SYN doesn't create a second socket.
    g.send(&guest_ip_frame(GUEST_IP, dst, wire::IP_PROTO_TCP, &syn)).await;
    let _ = g.recv_within(Duration::from_millis(200)).await;
    assert_eq!(h.stack.stats().tcp_sockets, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guest_that_never_reads_is_throttled() {
    let config = NetConfig {
        limits: gondolin_netstack::NetLimits {
            tx_queue_max_bytes: 64 * 1024,
            ..Default::default()
        },
        ..NetConfig::default()
    };
    let (mut h, _flows) = channel_harness(config);
    let (mut rd, mut wr) = RawGuest::new(&mut h).into_parts();
    let dst = Ipv4Addr::new(93, 184, 216, 34);
    // Each segment elicits a RST; the guest never reads them.
    let mut burst = Vec::new();
    for i in 0..1000u32 {
        let seg = tcp_segment(GUEST_IP, 40000, dst, 80, i, 1, wire::TCP_ACK, b"");
        burst.extend_from_slice(&qemu_frame(&guest_ip_frame(
            GUEST_IP,
            dst,
            wire::IP_PROTO_TCP,
            &seg,
        )));
    }
    let sender = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        for _ in 0..100 {
            wr.write_all(&burst).await.unwrap();
        }
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!sender.is_finished(), "stack must stop reading");
    let queued = h.stack.stats().tx_queued_bytes;
    assert!(queued < 64 * 1024 + 512 * 1024, "queued {queued}");

    // Once the guest reads, everything flows again.
    let reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 1 << 16];
        let mut total = 0usize;
        while let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(3), rd.read(&mut buf)).await
        {
            if n == 0 {
                break;
            }
            total += n;
        }
        total
    });
    tokio::time::timeout(Duration::from_secs(120), sender).await.unwrap().unwrap();
    let total = reader.await.unwrap();
    // 100k RSTs of 4 + 14 + 20 + 20 bytes.
    assert_eq!(total, 100_000 * 58);
}

/// Guest data is handed to the flow at a PSH; without one, after `READ_HOLD`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_wait_for_push_or_hold_timeout() {
    use tokio::io::AsyncReadExt;
    let (mut h, mut flows) = channel_harness(NetConfig::default());
    let mut g = RawGuest::new(&mut h);
    let dst = Ipv4Addr::new(93, 184, 216, 34);
    let send = |seq: u32, ack: u32, flags: u8, data: &[u8]| {
        let seg = tcp_segment(GUEST_IP, 40000, dst, 80, seq, ack, flags, data);
        guest_ip_frame(GUEST_IP, dst, wire::IP_PROTO_TCP, &seg)
    };
    g.send(&send(1000, 0, wire::TCP_SYN, b"")).await;
    let syn_ack = parse_ip_frame(&g.recv().await).payload;
    let isn = u32::from_be_bytes(syn_ack[4..8].try_into().unwrap());
    g.send(&send(1001, isn + 1, wire::TCP_ACK, b"")).await;
    let mut flow = flows.recv().await.unwrap();

    // With PSH: no hold.
    g.send(&send(1001, isn + 1, wire::TCP_ACK | wire::TCP_PSH, b"hello")).await;
    let mut buf = [0u8; 16];
    let n = flow.stream.read(&mut buf).await.unwrap();
    assert_eq!(&buf[..n], b"hello");
    assert_eq!(h.stack.stats().read_hold_timeouts, 0);

    // Without: delivered once the hold expires.
    g.send(&send(1006, isn + 1, wire::TCP_ACK, b"world")).await;
    let start = std::time::Instant::now();
    let n = flow.stream.read(&mut buf).await.unwrap();
    assert_eq!(&buf[..n], b"world");
    assert!(start.elapsed() >= gondolin_netstack::READ_HOLD / 2);
    assert_eq!(h.stack.stats().read_hold_timeouts, 1);

    // A FIN releases it too.
    g.send(&send(1011, isn + 1, wire::TCP_ACK, b"bye")).await;
    g.send(&send(1014, isn + 1, wire::TCP_ACK | wire::TCP_FIN, b"")).await;
    let mut rest = Vec::new();
    flow.stream.read_to_end(&mut rest).await.unwrap();
    assert_eq!(rest, b"bye");
    assert_eq!(h.stack.stats().read_hold_timeouts, 1);
}

#[tokio::test]
async fn guest_dns_servers_match_the_dhcp_offer() {
    let stack = |mode, resolvers: Vec<Ipv4Addr>| {
        let config =
            NetConfig { dns: DnsConfig { mode, ..DnsConfig::default() }, ..NetConfig::default() };
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        NetStack::with_system_resolvers(config, Arc::new(ChannelHandler(tx)), resolvers).unwrap()
    };
    let gateway = NetConfig::default().gateway_ip;
    // the stack answers DNS itself
    assert_eq!(stack(DnsMode::Synthetic, vec![]).guest_dns_servers(), vec![gateway]);
    // the host's resolvers, else a public one
    let resolver = Ipv4Addr::new(1, 1, 1, 1);
    assert_eq!(stack(DnsMode::Open, vec![resolver]).guest_dns_servers(), vec![resolver]);
    assert_eq!(stack(DnsMode::Open, vec![]).guest_dns_servers(), vec![Ipv4Addr::new(8, 8, 8, 8)]);
}

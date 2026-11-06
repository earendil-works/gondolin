//! netstack: Ethernet/IPv4/UDP/TCP header parsing, DNS queries and synthetic
//! answers, DHCP requests, resolv.conf (all guest-controlled bytes except the
//! last).
#![no_main]

use std::net::{Ipv4Addr, Ipv6Addr};

use gondolin_netstack::{NetConfig, SyntheticHostMap, dhcp, dns, wire};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Some(eth) = wire::parse_ethernet(data)
        && let Ok(ip) = wire::parse_ipv4(eth.payload)
    {
        for verify in [true, false] {
            let _ = wire::parse_udp(&ip, verify);
        }
        let _ = wire::parse_tcp_header(ip.payload);
        let _ = wire::checksum(ip.payload);
    }
    let _ = wire::parse_ipv4(data);

    if let Some(query) = dns::parse_query(data) {
        let answer = dns::SyntheticAnswer {
            ipv4: Ipv4Addr::new(192, 0, 2, 1),
            ipv6: Ipv6Addr::LOCALHOST,
            ttl_seconds: 60,
        };
        let response = dns::build_synthetic_response(&query, answer);
        // the answer must parse as a response to the same query
        assert!(response.len() >= 12);
        let hosts = SyntheticHostMap::new();
        let name = &query.question.name;
        if let Some(ip) = hosts.allocate(name) {
            assert_eq!(
                hosts.lookup(ip).as_deref(),
                Some(name.trim().to_ascii_lowercase().as_str())
            );
        }
    }

    let config = NetConfig::default();
    let _ = dhcp::handle(data, &config, &[Ipv4Addr::new(10, 0, 0, 53)]);
    let _ = dhcp::parse_options(data);

    if let Ok(text) = std::str::from_utf8(data) {
        let _ = dns::parse_resolv_conf(text);
    }
});

//! Internal address ranges (port of `host/src/utils/ip.ts`).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Parses an ip literal like `net.isIP` accepts it (IPv6 zone ids allowed).
pub fn parse_ip(ip: &str) -> Option<IpAddr> {
    if let Ok(addr) = ip.parse::<IpAddr>() {
        return Some(addr);
    }
    // `fe80::1%eth0`
    let (addr, zone) = ip.split_once('%')?;
    if zone.is_empty() {
        return None;
    }
    addr.parse::<Ipv6Addr>().ok().map(IpAddr::V6)
}

/// Whether `ip` is loopback, private, link-local or otherwise internal.
/// Strings that are not ip literals are not internal.
pub fn is_internal_ip_str(ip: &str) -> bool {
    parse_ip(ip).is_some_and(is_internal_ip)
}

/// Whether `ip` is in an internal range.
pub fn is_internal_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_internal_v4(v4),
        IpAddr::V6(v6) => is_internal_v6(v6),
    }
}

fn is_internal_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 100 && (64..=127).contains(&b))
        || a == 255
}

fn v4(hi: u16, lo: u16) -> Ipv4Addr {
    Ipv4Addr::new((hi >> 8) as u8, (hi & 0xff) as u8, (lo >> 8) as u8, (lo & 0xff) as u8)
}

/// IPv4 addresses embedded in IPv6 transition formats (NAT64 RFC 6052, 6to4,
/// Teredo, IPv4-mapped/-compatible): a destination like `64:ff9b::127.0.0.1`
/// reaches the embedded address through a translator.
fn embedded_v4(h: &[u16; 8]) -> Vec<Ipv4Addr> {
    let b = Ipv6Addr::from(*h).octets();
    let mut out = Vec::new();
    // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
    if h[..5].iter().all(|&s| s == 0) && (h[5] == 0xffff || h[5] == 0) {
        out.push(v4(h[6], h[7]));
    }
    // NAT64 well-known prefix 64:ff9b::/96
    if h[0] == 0x64 && h[1] == 0xff9b && h[2..6].iter().all(|&s| s == 0) {
        out.push(v4(h[6], h[7]));
    }
    // NAT64 local-use prefix 64:ff9b:1::/48: the embedding depends on the
    // network's prefix length (/48../96, RFC 6052), so every candidate counts;
    // the zero candidates make this fail closed for the whole prefix
    if h[0] == 0x64 && h[1] == 0xff9b && h[2] == 1 {
        out.push(Ipv4Addr::new(b[6], b[7], b[9], b[10])); // /48 (bits 64..71: "u" octet)
        out.push(Ipv4Addr::new(b[7], b[9], b[10], b[11])); // /56
        out.push(Ipv4Addr::new(b[9], b[10], b[11], b[12])); // /64
        out.push(v4(h[6], h[7])); // /96
    }
    // 6to4 2002:a.b.c.d::/48
    if h[0] == 0x2002 {
        out.push(v4(h[1], h[2]));
    }
    // Teredo 2001:0::/32: server address and the obfuscated client address
    if h[0] == 0x2001 && h[1] == 0 {
        out.push(v4(h[2], h[3]));
        out.push(v4(!h[6], !h[7]));
    }
    out
}

fn is_internal_v6(ip: Ipv6Addr) -> bool {
    let h = ip.segments();
    if h.iter().all(|&s| s == 0) {
        return true;
    }
    if h[..7].iter().all(|&s| s == 0) && h[7] == 1 {
        return true;
    }
    if (h[0] & 0xfe00) == 0xfc00 || (h[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    embedded_v4(&h).into_iter().any(is_internal_v4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v4_ranges() {
        for ip in [
            "0.1.2.3",
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "100.64.0.1",
            "100.127.0.1",
            "255.255.255.255",
        ] {
            assert!(is_internal_ip_str(ip), "{ip}");
        }
        for ip in ["8.8.8.8", "172.32.0.1", "100.128.0.1", "203.0.113.10", "192.169.0.1"] {
            assert!(!is_internal_ip_str(ip), "{ip}");
        }
    }

    #[test]
    fn v6_ranges() {
        for ip in [
            "::",
            "::1",
            "fc00::1",
            "fd12:3456:789a::1",
            "fe80::1",
            "fe80::1%eth0",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
        ] {
            assert!(is_internal_ip_str(ip), "{ip}");
        }
        for ip in ["::ffff:8.8.8.8", "64:ff9b::8.8.8.8", "2001:db8::1", "zzzz::1"] {
            assert!(!is_internal_ip_str(ip), "{ip}");
        }
    }

    #[test]
    fn v6_transition_formats_embed_v4() {
        for ip in [
            "64:ff9b::127.0.0.1",
            "64:ff9b::10.1.2.3",
            "64:ff9b::a9fe:a9fe",    // 169.254.169.254
            "64:ff9b:1::7f00:1",     // local-use, /96
            "64:ff9b:1:a00:1::",     // local-use, /48: 10.0.0.1
            "64:ff9b:1:c0:a8:100::", // local-use, /56: 192.168.1.0 (u octet skipped)
            "2002:7f00:1::1",        // 6to4 127.0.0.1
            "2002:c0a8:101::",       // 6to4 192.168.1.1
            "::127.0.0.1",           // IPv4-compatible
            "::10.0.0.1",
            "::ffff:169.254.169.254",
            "2001:0:7f00:1::",           // Teredo server 127.0.0.1
            "2001:0:808:808::f5ff:fffe", // Teredo client 10.0.0.1 (obfuscated)
        ] {
            assert!(is_internal_ip_str(ip), "{ip}");
        }
        for ip in [
            "64:ff9b::808:808",
            "2002:808:808::1",
            "::8.8.8.8",
            "2001:0:808:808::f7f7:f7f7", // Teredo client 8.8.8.8
            "2001:4860:4860::8888",
        ] {
            assert!(!is_internal_ip_str(ip), "{ip}");
        }
    }
}

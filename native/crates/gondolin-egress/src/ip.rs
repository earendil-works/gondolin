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
    if h[..5].iter().all(|&s| s == 0) && h[5] == 0xffff {
        let v4 = Ipv4Addr::new(
            (h[6] >> 8) as u8,
            (h[6] & 0xff) as u8,
            (h[7] >> 8) as u8,
            (h[7] & 0xff) as u8,
        );
        return is_internal_v4(v4);
    }
    false
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
}

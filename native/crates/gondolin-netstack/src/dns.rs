//! DNS helpers: query validation, synthetic answers and the per-host synthetic
//! address table.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Mutex;

use crate::SyntheticHostLookup;

pub const DNS_TYPE_A: u16 = 1;
pub const DNS_TYPE_AAAA: u16 = 28;
pub const DNS_CLASS_IN: u16 = 1;

/// First question of a validated DNS query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsQuestion {
    /// lowercase name in presentation format without trailing dot (`""` for the root)
    pub name: String,
    pub qtype: u16,
    pub qclass: u16,
}

/// A validated standard DNS query.
#[derive(Debug, Clone)]
pub struct DnsQuery<'a> {
    pub id: u16,
    pub flags: u16,
    /// wire bytes of the first question (echoed in synthetic answers)
    pub question_section: &'a [u8],
    pub question: DnsQuestion,
}

/// Parses an uncompressed name at `off`; returns the name and the next offset.
fn parse_name(packet: &[u8], mut off: usize) -> Option<(String, usize)> {
    let mut name = String::new();
    let mut labels = 0;
    loop {
        let len = usize::from(*packet.get(off)?);
        off += 1;
        if len == 0 {
            break;
        }
        // Compression pointers (and the reserved 0x40/0x80 label types) are not
        // accepted in queries: stub resolvers don't use them and refusing them
        // avoids pointer cycles on untrusted input.
        if len > 63 {
            return None;
        }
        let label = packet.get(off..off + len)?;
        off += len;
        // Only ASCII names look "normal"; this also keeps the per-host map and
        // the hostnames handed to egress free of ambiguous encodings.
        if !label.is_ascii() {
            return None;
        }
        if !name.is_empty() {
            name.push('.');
        }
        name.extend(label.iter().map(|b| b.to_ascii_lowercase() as char));
        labels += 1;
        if labels > 128 {
            return None;
        }
    }
    Some((name, off))
}

/// Validates `packet` as a standard query (QR=0, opcode 0, no answer/authority
/// records, 1..=16 questions) and returns its first question.
pub fn parse_query(packet: &[u8]) -> Option<DnsQuery<'_>> {
    if packet.len() < 12 {
        return None;
    }
    let be = |i: usize| u16::from_be_bytes([packet[i], packet[i + 1]]);
    let id = be(0);
    let flags = be(2);
    let qdcount = be(4);
    let ancount = be(6);
    let nscount = be(8);
    if flags & 0x8000 != 0 || (flags >> 11) & 0x0f != 0 {
        return None;
    }
    if ancount != 0 || nscount != 0 || qdcount == 0 || qdcount > 16 {
        return None;
    }
    let mut off = 12;
    let mut first: Option<(DnsQuestion, usize)> = None;
    for _ in 0..qdcount {
        let (name, next) = parse_name(packet, off)?;
        off = next;
        let fixed = packet.get(off..off + 4)?;
        let qtype = u16::from_be_bytes([fixed[0], fixed[1]]);
        let qclass = u16::from_be_bytes([fixed[2], fixed[3]]);
        off += 4;
        if first.is_none() {
            first = Some((DnsQuestion { name, qtype, qclass }, off));
        }
    }
    let (question, end) = first?;
    Some(DnsQuery { id, flags, question_section: &packet[12..end], question })
}

/// RFC 6761 `localhost` / `*.localhost`.
pub fn is_localhost(name: &str) -> bool {
    name == "localhost" || name.ends_with(".localhost")
}

/// Answer addresses for a synthetic response.
#[derive(Debug, Clone, Copy)]
pub struct SyntheticAnswer {
    pub ipv4: Ipv4Addr,
    pub ipv6: Ipv6Addr,
    pub ttl_seconds: u32,
}

/// Builds the synthetic response: QR+RA, RD copied, the first question echoed,
/// and one `A`/`AAAA` answer for class IN (empty NOERROR otherwise).
pub fn build_synthetic_response(query: &DnsQuery<'_>, answer: SyntheticAnswer) -> Vec<u8> {
    let flags = 0x8000 | (query.flags & 0x0100) | 0x0080;
    let q = &query.question;
    let local = is_localhost(&q.name);
    let rdata: Option<(u16, Vec<u8>)> = if q.qclass != DNS_CLASS_IN {
        None
    } else if q.qtype == DNS_TYPE_A {
        let ip = if local { Ipv4Addr::LOCALHOST } else { answer.ipv4 };
        Some((DNS_TYPE_A, ip.octets().to_vec()))
    } else if q.qtype == DNS_TYPE_AAAA {
        let ip = if local { Ipv6Addr::LOCALHOST } else { answer.ipv6 };
        Some((DNS_TYPE_AAAA, ip.octets().to_vec()))
    } else {
        None
    };

    let mut out = Vec::with_capacity(12 + query.question_section.len() + 28);
    out.extend_from_slice(&query.id.to_be_bytes());
    out.extend_from_slice(&flags.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&u16::from(rdata.is_some()).to_be_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(query.question_section);
    if let Some((rtype, rdata)) = rdata {
        out.extend_from_slice(&0xc00cu16.to_be_bytes());
        out.extend_from_slice(&rtype.to_be_bytes());
        out.extend_from_slice(&DNS_CLASS_IN.to_be_bytes());
        out.extend_from_slice(&answer.ttl_seconds.to_be_bytes());
        out.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
        out.extend_from_slice(&rdata);
    }
    out
}

const HOSTS_PER_BUCKET: u32 = 254;
const MAX_HOSTS: u32 = 0x100 * HOSTS_PER_BUCKET;

#[derive(Default)]
struct HostMapInner {
    host_to_ip: HashMap<String, Ipv4Addr>,
    ip_to_host: HashMap<Ipv4Addr, String>,
    next_id: u32,
}

/// Stable hostname ⇄ synthetic IPv4 table for `per-host` mapping
/// (`198.19.<hi>.<lo>`, `lo` in `1..=254`).
#[derive(Default)]
pub struct SyntheticHostMap {
    inner: Mutex<HostMapInner>,
}

impl SyntheticHostMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Allocates (or returns) the address for `hostname`; `None` for empty or
    /// over-long names and when the table is exhausted.
    pub fn allocate(&self, hostname: &str) -> Option<Ipv4Addr> {
        let normalized = hostname.trim().to_ascii_lowercase();
        if normalized.is_empty() || normalized.len() > 253 {
            return None;
        }
        let mut inner = self.inner.lock().unwrap();
        if let Some(ip) = inner.host_to_ip.get(&normalized) {
            return Some(*ip);
        }
        if inner.next_id >= MAX_HOSTS {
            return None;
        }
        let index = inner.next_id;
        inner.next_id += 1;
        let hi = (index / HOSTS_PER_BUCKET) as u8;
        let lo = (index % HOSTS_PER_BUCKET) as u8 + 1;
        let ip = Ipv4Addr::new(198, 19, hi, lo);
        inner.host_to_ip.insert(normalized.clone(), ip);
        inner.ip_to_host.insert(ip, normalized);
        Some(ip)
    }

    pub fn lookup(&self, ip: Ipv4Addr) -> Option<String> {
        self.inner.lock().unwrap().ip_to_host.get(&ip).cloned()
    }

    #[cfg(test)]
    fn exhaust_for_test(&self) {
        self.inner.lock().unwrap().next_id = MAX_HOSTS;
    }
}

impl SyntheticHostLookup for SyntheticHostMap {
    fn hostname_for(&self, ip: IpAddr) -> Option<String> {
        match ip {
            IpAddr::V4(ip) => self.lookup(ip),
            IpAddr::V6(_) => None,
        }
    }
}

/// IPv4 nameservers from `/etc/resolv.conf` (deduplicated, in order).
pub fn system_ipv4_resolvers() -> Vec<Ipv4Addr> {
    std::fs::read_to_string("/etc/resolv.conf").map(|s| parse_resolv_conf(&s)).unwrap_or_default()
}

pub fn parse_resolv_conf(contents: &str) -> Vec<Ipv4Addr> {
    let mut out = Vec::new();
    for line in contents.lines() {
        let mut words = line.split_whitespace();
        if words.next() != Some("nameserver") {
            continue;
        }
        let Some(addr) = words.next() else { continue };
        let addr = addr.split('%').next().unwrap_or(addr);
        if let Ok(ip) = addr.parse::<Ipv4Addr>()
            && !out.contains(&ip)
        {
            out.push(ip);
        }
    }
    out
}

/// Resolvers the DHCP server advertises in `open` mode: guest-reachable host
/// resolvers (no loopback/unspecified/broadcast), else `8.8.8.8`.
pub fn guest_reachable_resolvers(candidates: &[Ipv4Addr]) -> Vec<Ipv4Addr> {
    let out: Vec<Ipv4Addr> = candidates
        .iter()
        .copied()
        .filter(|ip| !ip.is_loopback() && !ip.is_unspecified() && !ip.is_broadcast())
        .collect();
    if out.is_empty() { vec![Ipv4Addr::new(8, 8, 8, 8)] } else { out }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn build_query(id: u16, name: &str, qtype: u16, extra_questions: usize) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&id.to_be_bytes());
        out.extend_from_slice(&0x0100u16.to_be_bytes());
        out.extend_from_slice(&(1 + extra_questions as u16).to_be_bytes());
        out.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        for i in 0..=extra_questions {
            let qname = if i == 0 { name.to_string() } else { format!("q{i}.{name}") };
            for label in qname.split('.').filter(|l| !l.is_empty()) {
                out.push(label.len() as u8);
                out.extend_from_slice(label.as_bytes());
            }
            out.push(0);
            out.extend_from_slice(&qtype.to_be_bytes());
            out.extend_from_slice(&DNS_CLASS_IN.to_be_bytes());
        }
        out
    }

    const ANSWER: SyntheticAnswer = SyntheticAnswer {
        ipv4: Ipv4Addr::new(192, 0, 2, 1),
        ipv6: Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1),
        ttl_seconds: 60,
    };

    fn answer_rdata(resp: &[u8], question_len: usize) -> (u16, u32, Vec<u8>) {
        let rr = &resp[12 + question_len..];
        assert_eq!(&rr[0..2], &[0xc0, 0x0c]);
        let rtype = u16::from_be_bytes([rr[2], rr[3]]);
        let ttl = u32::from_be_bytes([rr[6], rr[7], rr[8], rr[9]]);
        let rdlen = usize::from(u16::from_be_bytes([rr[10], rr[11]]));
        (rtype, ttl, rr[12..12 + rdlen].to_vec())
    }

    #[test]
    fn a_query_gets_synthetic_answer() {
        let q = build_query(0x1234, "Example.COM", DNS_TYPE_A, 0);
        let query = parse_query(&q).unwrap();
        assert_eq!(query.question.name, "example.com");
        let resp = build_synthetic_response(&query, ANSWER);
        assert_eq!(&resp[0..2], &[0x12, 0x34]);
        assert_eq!(u16::from_be_bytes([resp[2], resp[3]]), 0x8180);
        assert_eq!(&resp[4..12], &[0, 1, 0, 1, 0, 0, 0, 0]);
        let (rtype, ttl, rdata) = answer_rdata(&resp, query.question_section.len());
        assert_eq!(rtype, DNS_TYPE_A);
        assert_eq!(ttl, 60);
        assert_eq!(rdata, vec![192, 0, 2, 1]);
    }

    #[test]
    fn localhost_is_loopback() {
        for (name, qtype, expected) in [
            ("localhost", DNS_TYPE_A, vec![127, 0, 0, 1]),
            ("foo.localhost", DNS_TYPE_A, vec![127, 0, 0, 1]),
            ("localhost", DNS_TYPE_AAAA, Ipv6Addr::LOCALHOST.octets().to_vec()),
        ] {
            let q = build_query(1, name, qtype, 0);
            let query = parse_query(&q).unwrap();
            let resp = build_synthetic_response(&query, ANSWER);
            let (_, _, rdata) = answer_rdata(&resp, query.question_section.len());
            assert_eq!(rdata, expected, "{name}");
        }
    }

    #[test]
    fn only_first_question_is_echoed() {
        let q = build_query(7, "example.com", DNS_TYPE_AAAA, 2);
        let query = parse_query(&q).unwrap();
        let resp = build_synthetic_response(&query, ANSWER);
        assert_eq!(u16::from_be_bytes([resp[4], resp[5]]), 1);
        let (rtype, _, rdata) = answer_rdata(&resp, query.question_section.len());
        assert_eq!(rtype, DNS_TYPE_AAAA);
        assert_eq!(rdata, ANSWER.ipv6.octets().to_vec());
    }

    #[test]
    fn other_types_get_empty_answer() {
        let q = build_query(7, "example.com", 16, 0);
        let query = parse_query(&q).unwrap();
        let resp = build_synthetic_response(&query, ANSWER);
        assert_eq!(&resp[6..8], &[0, 0]);
        assert_eq!(resp.len(), 12 + query.question_section.len());
    }

    #[test]
    fn rejects_abnormal_queries() {
        assert!(parse_query(&[0; 11]).is_none());
        let mut response = build_query(1, "a.com", DNS_TYPE_A, 0);
        response[2] |= 0x80; // QR
        assert!(parse_query(&response).is_none());
        let mut opcode = build_query(1, "a.com", DNS_TYPE_A, 0);
        opcode[2] |= 0x08; // opcode 1
        assert!(parse_query(&opcode).is_none());
        let mut answers = build_query(1, "a.com", DNS_TYPE_A, 0);
        answers[7] = 1;
        assert!(parse_query(&answers).is_none());
        let mut no_q = build_query(1, "a.com", DNS_TYPE_A, 0);
        no_q[5] = 0;
        assert!(parse_query(&no_q).is_none());
        let mut many = build_query(1, "a.com", DNS_TYPE_A, 0);
        many[5] = 17;
        assert!(parse_query(&many).is_none());
        // compression pointer
        let mut ptr = build_query(1, "a.com", DNS_TYPE_A, 0);
        ptr[12] = 0xc0;
        assert!(parse_query(&ptr).is_none());
        // truncated
        let full = build_query(1, "example.com", DNS_TYPE_A, 0);
        assert!(parse_query(&full[..full.len() - 2]).is_none());
        // non-ascii
        let mut bin = build_query(1, "example.com", DNS_TYPE_A, 0);
        bin[13] = 0xe7;
        assert!(parse_query(&bin).is_none());
        // root query parses with an empty name
        let root = build_query(1, "", DNS_TYPE_A, 0);
        assert_eq!(parse_query(&root).unwrap().question.name, "");
    }

    #[test]
    fn host_map_is_stable_and_unique() {
        let map = SyntheticHostMap::new();
        let a = map.allocate("api.example.com").unwrap();
        let b = map.allocate("other.example.com").unwrap();
        assert_eq!(a, Ipv4Addr::new(198, 19, 0, 1));
        assert_eq!(b, Ipv4Addr::new(198, 19, 0, 2));
        assert_eq!(map.allocate("API.example.com"), Some(a));
        assert_eq!(map.hostname_for(IpAddr::V4(b)).as_deref(), Some("other.example.com"));
        assert_eq!(map.allocate(""), None);
        assert_eq!(map.allocate(&"a".repeat(254)), None);
        for i in 2..300 {
            map.allocate(&format!("h{i}")).unwrap();
        }
        assert_eq!(map.allocate("h253"), Some(Ipv4Addr::new(198, 19, 0, 254)));
        assert_eq!(map.allocate("h254"), Some(Ipv4Addr::new(198, 19, 1, 1)));
        map.exhaust_for_test();
        assert_eq!(map.allocate("new.example.com"), None);
        assert_eq!(map.allocate("api.example.com"), Some(a));
    }

    #[test]
    fn resolv_conf_and_dhcp_filter() {
        let parsed = parse_resolv_conf(
            "# comment\nnameserver 127.0.0.53\nnameserver fe80::1%en0\nnameserver 10.0.0.2\nnameserver 10.0.0.2\nsearch lan\n",
        );
        assert_eq!(parsed, vec![Ipv4Addr::new(127, 0, 0, 53), Ipv4Addr::new(10, 0, 0, 2)]);
        assert_eq!(guest_reachable_resolvers(&parsed), vec![Ipv4Addr::new(10, 0, 0, 2)]);
        assert_eq!(
            guest_reachable_resolvers(&[Ipv4Addr::new(127, 0, 0, 53)]),
            vec![Ipv4Addr::new(8, 8, 8, 8)]
        );
    }
}

//! Packet parsing and building helpers for the parts of the stack that are not
//! TCP (TCP segments are produced by smoltcp).

use std::net::Ipv4Addr;

use bytes::{BufMut, BytesMut};

use crate::config::MacAddr;

pub const ETH_HEADER_LEN: usize = 14;
pub const ETHERTYPE_IPV4: u16 = 0x0800;
pub const ETHERTYPE_ARP: u16 = 0x0806;
pub const IPV4_HEADER_LEN: usize = 20;
pub const IP_PROTO_ICMP: u8 = 1;
pub const IP_PROTO_TCP: u8 = 6;
pub const IP_PROTO_UDP: u8 = 17;
/// Bytes of the QEMU stream netdev length prefix (`u32` big endian).
pub const QEMU_FRAME_PREFIX: usize = 4;

/// One's complement sum of `data` (big-endian 16-bit words) added to `acc`.
pub fn sum16(mut acc: u32, data: &[u8]) -> u32 {
    let (words, rest) = data.as_chunks::<2>();
    for w in words {
        acc += u32::from(u16::from_be_bytes(*w));
    }
    if let [last] = rest {
        acc += u32::from(*last) << 8;
    }
    acc
}

/// Folds a [`sum16`] accumulator into the final internet checksum.
pub fn fold(mut acc: u32) -> u16 {
    while acc >> 16 != 0 {
        acc = (acc & 0xffff) + (acc >> 16);
    }
    !(acc as u16)
}

/// Internet checksum of `data` (RFC 1071).
pub fn checksum(data: &[u8]) -> u16 {
    fold(sum16(0, data))
}

/// Pseudo-header sum for TCP/UDP checksums.
pub fn pseudo_sum(src: Ipv4Addr, dst: Ipv4Addr, proto: u8, len: usize) -> u32 {
    let mut acc = sum16(0, &src.octets());
    acc = sum16(acc, &dst.octets());
    acc += u32::from(proto);
    acc += len as u32;
    acc
}

/// Parsed Ethernet frame.
pub struct Ethernet<'a> {
    pub dst: MacAddr,
    pub src: MacAddr,
    pub ethertype: u16,
    pub payload: &'a [u8],
}

pub fn parse_ethernet(frame: &[u8]) -> Option<Ethernet<'_>> {
    if frame.len() < ETH_HEADER_LEN {
        return None;
    }
    Some(Ethernet {
        dst: MacAddr(frame[0..6].try_into().ok()?),
        src: MacAddr(frame[6..12].try_into().ok()?),
        ethertype: u16::from_be_bytes([frame[12], frame[13]]),
        payload: &frame[ETH_HEADER_LEN..],
    })
}

/// Validated IPv4 packet.
pub struct Ipv4<'a> {
    pub src: Ipv4Addr,
    pub dst: Ipv4Addr,
    pub protocol: u8,
    /// whole packet (header + payload) trimmed to the total length
    pub packet: &'a [u8],
    /// L4 payload
    pub payload: &'a [u8],
}

/// Why an IPv4 packet was dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ipv4Error {
    Truncated,
    NotIpv4,
    BadHeaderLength,
    BadTotalLength,
    BadChecksum,
    Fragment,
}

/// Parses and validates an IPv4 packet: version, header length, total length,
/// header checksum, and rejects fragments (neither engine reassembles).
pub fn parse_ipv4(packet: &[u8]) -> Result<Ipv4<'_>, Ipv4Error> {
    if packet.len() < IPV4_HEADER_LEN {
        return Err(Ipv4Error::Truncated);
    }
    if packet[0] >> 4 != 4 {
        return Err(Ipv4Error::NotIpv4);
    }
    let ihl = usize::from(packet[0] & 0x0f) * 4;
    if ihl < IPV4_HEADER_LEN || ihl > packet.len() {
        return Err(Ipv4Error::BadHeaderLength);
    }
    let total = usize::from(u16::from_be_bytes([packet[2], packet[3]]));
    if total < ihl || total > packet.len() {
        return Err(Ipv4Error::BadTotalLength);
    }
    if checksum(&packet[..ihl]) != 0 {
        return Err(Ipv4Error::BadChecksum);
    }
    let frag = u16::from_be_bytes([packet[6], packet[7]]);
    // MF set or a non-zero fragment offset.
    if frag & 0x2000 != 0 || frag & 0x1fff != 0 {
        return Err(Ipv4Error::Fragment);
    }
    Ok(Ipv4 {
        src: Ipv4Addr::new(packet[12], packet[13], packet[14], packet[15]),
        dst: Ipv4Addr::new(packet[16], packet[17], packet[18], packet[19]),
        protocol: packet[9],
        packet: &packet[..total],
        payload: &packet[ihl..total],
    })
}

/// Appends a QEMU-framed Ethernet frame (`u32` BE length + frame) whose body is
/// produced by `body` writing exactly `body_len` bytes.
pub fn put_frame(
    out: &mut BytesMut,
    dst: MacAddr,
    src: MacAddr,
    ethertype: u16,
    body_len: usize,
    body: impl FnOnce(&mut [u8]),
) {
    let frame_len = ETH_HEADER_LEN + body_len;
    out.reserve(QEMU_FRAME_PREFIX + frame_len);
    out.put_u32(frame_len as u32);
    out.put_slice(&dst.0);
    out.put_slice(&src.0);
    out.put_u16(ethertype);
    let start = out.len();
    out.put_bytes(0, body_len);
    body(&mut out[start..]);
}

/// Writes an IPv4 header (no options, TTL 64, DF clear) into `buf[..20]`.
pub fn write_ipv4_header(
    buf: &mut [u8],
    src: Ipv4Addr,
    dst: Ipv4Addr,
    proto: u8,
    payload_len: usize,
) {
    let total = (IPV4_HEADER_LEN + payload_len) as u16;
    buf[0] = 0x45;
    buf[1] = 0;
    buf[2..4].copy_from_slice(&total.to_be_bytes());
    buf[4..8].fill(0);
    buf[8] = 64;
    buf[9] = proto;
    buf[10..12].fill(0);
    buf[12..16].copy_from_slice(&src.octets());
    buf[16..20].copy_from_slice(&dst.octets());
    let ck = checksum(&buf[..IPV4_HEADER_LEN]);
    buf[10..12].copy_from_slice(&ck.to_be_bytes());
}

/// Appends a framed IPv4 packet carrying `l4` (already checksummed).
pub fn put_ipv4_frame(
    out: &mut BytesMut,
    dst_mac: MacAddr,
    src_mac: MacAddr,
    src: Ipv4Addr,
    dst: Ipv4Addr,
    proto: u8,
    l4: &[u8],
) {
    put_frame(out, dst_mac, src_mac, ETHERTYPE_IPV4, IPV4_HEADER_LEN + l4.len(), |buf| {
        write_ipv4_header(buf, src, dst, proto, l4.len());
        buf[IPV4_HEADER_LEN..].copy_from_slice(l4);
    });
}

/// Builds a UDP datagram with a valid checksum.
pub fn udp_datagram(
    src: Ipv4Addr,
    src_port: u16,
    dst: Ipv4Addr,
    dst_port: u16,
    payload: &[u8],
) -> Vec<u8> {
    let len = 8 + payload.len();
    let mut out = Vec::with_capacity(len);
    out.extend_from_slice(&src_port.to_be_bytes());
    out.extend_from_slice(&dst_port.to_be_bytes());
    out.extend_from_slice(&(len as u16).to_be_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(payload);
    let ck = fold(sum16(pseudo_sum(src, dst, IP_PROTO_UDP, len), &out));
    let ck = if ck == 0 { 0xffff } else { ck };
    out[6..8].copy_from_slice(&ck.to_be_bytes());
    out
}

/// Parsed UDP datagram.
pub struct Udp<'a> {
    pub src_port: u16,
    pub dst_port: u16,
    pub payload: &'a [u8],
}

/// Parses a UDP datagram, validating length and (non-zero, when `verify`) checksum.
pub fn parse_udp<'a>(ip: &Ipv4<'a>, verify: bool) -> Option<Udp<'a>> {
    let seg = ip.payload;
    if seg.len() < 8 {
        return None;
    }
    let len = usize::from(u16::from_be_bytes([seg[4], seg[5]]));
    if len < 8 || len > seg.len() {
        return None;
    }
    let seg = &seg[..len];
    let ck = u16::from_be_bytes([seg[6], seg[7]]);
    if verify && ck != 0 && fold(sum16(pseudo_sum(ip.src, ip.dst, IP_PROTO_UDP, len), seg)) != 0 {
        return None;
    }
    Some(Udp {
        src_port: u16::from_be_bytes([seg[0], seg[1]]),
        dst_port: u16::from_be_bytes([seg[2], seg[3]]),
        payload: &seg[8..],
    })
}

/// Minimal TCP header view used before handing packets to smoltcp.
pub struct TcpHeader {
    pub src_port: u16,
    pub dst_port: u16,
    pub flags: u8,
}

pub const TCP_FIN: u8 = 0x01;
pub const TCP_SYN: u8 = 0x02;
pub const TCP_RST: u8 = 0x04;
pub const TCP_PSH: u8 = 0x08;
pub const TCP_ACK: u8 = 0x10;

pub fn parse_tcp_header(payload: &[u8]) -> Option<TcpHeader> {
    if payload.len() < 20 {
        return None;
    }
    Some(TcpHeader {
        src_port: u16::from_be_bytes([payload[0], payload[1]]),
        dst_port: u16::from_be_bytes([payload[2], payload[3]]),
        flags: payload[13],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Straightforward reference implementation (as in the TS test).
    fn reference_checksum(buf: &[u8]) -> u16 {
        let mut sum: u32 = 0;
        let mut i = 0;
        while i + 1 < buf.len() {
            sum += (u32::from(buf[i]) << 8) | u32::from(buf[i + 1]);
            sum = (sum & 0xffff) + (sum >> 16);
            i += 2;
        }
        if buf.len() % 2 == 1 {
            sum += u32::from(buf[buf.len() - 1]) << 8;
            sum = (sum & 0xffff) + (sum >> 16);
        }
        !(sum as u16)
    }

    #[test]
    fn checksum_matches_reference() {
        let mut seed = 0x1234_5678u32;
        for len in 0..300 {
            let data: Vec<u8> = (0..len)
                .map(|_| {
                    seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                    (seed >> 16) as u8
                })
                .collect();
            assert_eq!(checksum(&data), reference_checksum(&data), "len {len}");
        }
    }

    #[test]
    fn ipv4_roundtrip_and_validation() {
        let mut buf = vec![0u8; 24];
        write_ipv4_header(&mut buf, Ipv4Addr::new(1, 2, 3, 4), Ipv4Addr::new(5, 6, 7, 8), 17, 4);
        let ip = parse_ipv4(&buf).unwrap();
        assert_eq!(ip.src, Ipv4Addr::new(1, 2, 3, 4));
        assert_eq!(ip.payload.len(), 4);

        let mut bad = buf.clone();
        bad[8] = 1; // TTL changed, checksum stale
        assert_eq!(parse_ipv4(&bad).err(), Some(Ipv4Error::BadChecksum));

        let mut frag = buf.clone();
        frag[6] = 0x20; // MF
        frag[10..12].fill(0);
        let ck = checksum(&frag[..20]);
        frag[10..12].copy_from_slice(&ck.to_be_bytes());
        assert_eq!(parse_ipv4(&frag).err(), Some(Ipv4Error::Fragment));

        assert_eq!(parse_ipv4(&buf[..10]).err(), Some(Ipv4Error::Truncated));
        let mut long = buf.clone();
        long[2..4].copy_from_slice(&100u16.to_be_bytes());
        assert!(parse_ipv4(&long).is_err());
    }

    #[test]
    fn udp_checksum_validates() {
        let src = Ipv4Addr::new(192, 168, 127, 1);
        let dst = Ipv4Addr::new(192, 168, 127, 3);
        let dgram = udp_datagram(src, 53, dst, 40000, b"hello");
        let mut packet = vec![0u8; 20];
        write_ipv4_header(&mut packet, src, dst, IP_PROTO_UDP, dgram.len());
        packet.extend_from_slice(&dgram);
        let ip = parse_ipv4(&packet).unwrap();
        let udp = parse_udp(&ip, true).unwrap();
        assert_eq!(udp.payload, b"hello");
        assert_eq!(udp.src_port, 53);
        let mut corrupt = packet.clone();
        let last = corrupt.len() - 1;
        corrupt[last] ^= 0xff;
        let ip = parse_ipv4(&corrupt).unwrap();
        assert!(parse_udp(&ip, true).is_none());
        assert!(parse_udp(&ip, false).is_some());
    }
}

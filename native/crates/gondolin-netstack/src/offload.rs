//! Linux `virtio_net_hdr` offloads on raw frames.
//!
//! A tap device used by a virtio-net backend (Firecracker) carries the guest's
//! checksum and segmentation offloads: a packet socket bound to it with
//! `PACKET_VNET_HDR` receives each frame behind a [`VNET_HDR_LEN`]-byte header
//! that says whether the frame still needs its transport checksum
//! (`NEEDS_CSUM`) and whether it is a TCP "super-frame" to be cut into
//! `gso_size`-byte segments (TSO).  The stack verifies checksums and handles
//! MTU-sized frames only, so [`expand`] turns such a frame into the plain
//! frames the guest would have sent without offloads.
//!
//! Supported: partial checksums (any protocol), TCP/IPv4 segmentation (with
//! or without the ECN bit).  Other GSO types (UDP, IPv6) are dropped: the stack
//! is IPv4-only and Linux guests no longer send UDP fragmentation offload.

use bytes::{Bytes, BytesMut};

use crate::wire::{self, ETH_HEADER_LEN, ETHERTYPE_IPV4, IP_PROTO_TCP, IP_PROTO_UDP};

/// Bytes of `struct virtio_net_hdr` (without `num_buffers`).
pub const VNET_HDR_LEN: usize = 10;

const F_NEEDS_CSUM: u8 = 1;
const GSO_NONE: u8 = 0;
const GSO_TCPV4: u8 = 1;
const GSO_ECN: u8 = 0x80;

/// `struct virtio_net_hdr` (little-endian fields, as on every Linux target we
/// build for).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VnetHdr {
    pub flags: u8,
    pub gso_type: u8,
    pub hdr_len: u16,
    pub gso_size: u16,
    pub csum_start: u16,
    pub csum_offset: u16,
}

impl VnetHdr {
    /// Splits `buf` into its header and the frame behind it.
    pub fn parse(buf: &[u8]) -> Option<(VnetHdr, &[u8])> {
        if buf.len() < VNET_HDR_LEN {
            return None;
        }
        let u16_at = |i: usize| u16::from_le_bytes([buf[i], buf[i + 1]]);
        let hdr = VnetHdr {
            flags: buf[0],
            gso_type: buf[1],
            hdr_len: u16_at(2),
            gso_size: u16_at(4),
            csum_start: u16_at(6),
            csum_offset: u16_at(8),
        };
        Some((hdr, &buf[VNET_HDR_LEN..]))
    }

    pub fn encode(&self) -> [u8; VNET_HDR_LEN] {
        let mut out = [0u8; VNET_HDR_LEN];
        out[0] = self.flags;
        out[1] = self.gso_type;
        out[2..4].copy_from_slice(&self.hdr_len.to_le_bytes());
        out[4..6].copy_from_slice(&self.gso_size.to_le_bytes());
        out[6..8].copy_from_slice(&self.csum_start.to_le_bytes());
        out[8..10].copy_from_slice(&self.csum_offset.to_le_bytes());
        out
    }
}

/// Why [`expand`] dropped a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dropped {
    /// GSO type other than TCP/IPv4
    UnsupportedGso(u8),
    /// headers or checksum position outside the frame
    Malformed,
}

/// Appends the plain frames carried by `frame` (received behind `hdr`) to
/// `out`: the frame itself, with its checksum completed when it was partial,
/// or the segments of a TCP/IPv4 super-frame.
pub fn expand(hdr: &VnetHdr, frame: &[u8], out: &mut Vec<Bytes>) -> Result<(), Dropped> {
    match hdr.gso_type & !GSO_ECN {
        GSO_NONE => {
            if hdr.flags & F_NEEDS_CSUM == 0 {
                out.push(Bytes::copy_from_slice(frame));
                return Ok(());
            }
            let mut frame = BytesMut::from(frame);
            complete_checksum(
                &mut frame,
                usize::from(hdr.csum_start),
                usize::from(hdr.csum_offset),
            )?;
            out.push(frame.freeze());
            Ok(())
        }
        GSO_TCPV4 if hdr.gso_size == 0 => {
            // nothing to cut: a plain frame whose checksum may be partial
            let plain = VnetHdr { gso_type: GSO_NONE, ..*hdr };
            expand(&plain, frame, out)
        }
        GSO_TCPV4 => segment_tcpv4(frame, usize::from(hdr.gso_size), out),
        other => Err(Dropped::UnsupportedGso(other)),
    }
}

/// Finishes a partial checksum: the 16-bit field at `start + offset` holds the
/// pseudo-header sum, the checksum covers `frame[start..]`.
fn complete_checksum(frame: &mut [u8], start: usize, offset: usize) -> Result<(), Dropped> {
    let field = start.checked_add(offset).ok_or(Dropped::Malformed)?;
    if start > frame.len() || field + 2 > frame.len() {
        return Err(Dropped::Malformed);
    }
    let mut sum = wire::fold(wire::sum16(0, &frame[start..]));
    if sum == 0 && udp_checksum_field(frame, field) {
        // a computed UDP checksum of 0 is sent as all ones (RFC 768)
        sum = 0xffff;
    }
    frame[field..field + 2].copy_from_slice(&sum.to_be_bytes());
    Ok(())
}

/// Whether `field` is the checksum of a UDP/IPv4 packet in `frame`.
fn udp_checksum_field(frame: &[u8], field: usize) -> bool {
    let Some((ihl, proto)) = ipv4_header(frame) else { return false };
    proto == IP_PROTO_UDP && field == ETH_HEADER_LEN + ihl + 6
}

/// IPv4 header length and protocol of an Ethernet frame.
fn ipv4_header(frame: &[u8]) -> Option<(usize, u8)> {
    if frame.len() < ETH_HEADER_LEN + 20
        || u16::from_be_bytes([frame[12], frame[13]]) != ETHERTYPE_IPV4
    {
        return None;
    }
    let ip = &frame[ETH_HEADER_LEN..];
    if ip[0] >> 4 != 4 {
        return None;
    }
    let ihl = usize::from(ip[0] & 0x0f) * 4;
    if ihl < 20 || ip.len() < ihl {
        return None;
    }
    Some((ihl, ip[9]))
}

/// Cuts a TCP/IPv4 super-frame into segments of at most `mss` payload bytes,
/// as the NIC would: consecutive sequence numbers and IP ids, FIN/PSH only on
/// the last segment, CWR only on the first, full IP and TCP checksums.
fn segment_tcpv4(frame: &[u8], mss: usize, out: &mut Vec<Bytes>) -> Result<(), Dropped> {
    let (ihl, proto) = ipv4_header(frame).ok_or(Dropped::Malformed)?;
    if proto != IP_PROTO_TCP {
        return Err(Dropped::Malformed);
    }
    let ip_start = ETH_HEADER_LEN;
    let tcp_start = ip_start + ihl;
    if frame.len() < tcp_start + 20 {
        return Err(Dropped::Malformed);
    }
    let doff = usize::from(frame[tcp_start + 12] >> 4) * 4;
    let headers = tcp_start + doff;
    if doff < 20 || frame.len() < headers {
        return Err(Dropped::Malformed);
    }
    let src: [u8; 4] = frame[ip_start + 12..ip_start + 16].try_into().unwrap();
    let dst: [u8; 4] = frame[ip_start + 16..ip_start + 20].try_into().unwrap();
    let id = u16::from_be_bytes([frame[ip_start + 4], frame[ip_start + 5]]);
    let seq = u32::from_be_bytes(frame[tcp_start + 4..tcp_start + 8].try_into().unwrap());
    let tcp_flags = frame[tcp_start + 13];
    let payload = &frame[headers..];

    const FIN: u8 = 0x01;
    const PSH: u8 = 0x08;
    const CWR: u8 = 0x80;
    let chunks: Vec<&[u8]> =
        if payload.is_empty() { vec![payload] } else { payload.chunks(mss).collect() };
    let last = chunks.len() - 1;
    let mut offset = 0u32;
    for (i, chunk) in chunks.into_iter().enumerate() {
        let mut seg = BytesMut::with_capacity(headers + chunk.len());
        seg.extend_from_slice(&frame[..headers]);
        seg.extend_from_slice(chunk);

        let ip_len = (ihl + doff + chunk.len()) as u16;
        seg[ip_start + 2..ip_start + 4].copy_from_slice(&ip_len.to_be_bytes());
        seg[ip_start + 4..ip_start + 6].copy_from_slice(&id.wrapping_add(i as u16).to_be_bytes());
        seg[ip_start + 10..ip_start + 12].fill(0);
        let ip_sum = wire::checksum(&seg[ip_start..tcp_start]);
        seg[ip_start + 10..ip_start + 12].copy_from_slice(&ip_sum.to_be_bytes());

        seg[tcp_start + 4..tcp_start + 8].copy_from_slice(&seq.wrapping_add(offset).to_be_bytes());
        let mut flags = tcp_flags;
        if i != last {
            flags &= !(FIN | PSH);
        }
        if i != 0 {
            flags &= !CWR;
        }
        seg[tcp_start + 13] = flags;
        seg[tcp_start + 16..tcp_start + 18].fill(0);
        let tcp_len = doff + chunk.len();
        let pseudo = wire::pseudo_sum(src.into(), dst.into(), IP_PROTO_TCP, tcp_len);
        let tcp_sum = wire::fold(wire::sum16(pseudo, &seg[tcp_start..]));
        seg[tcp_start + 16..tcp_start + 18].copy_from_slice(&tcp_sum.to_be_bytes());

        offset = offset.wrapping_add(chunk.len() as u32);
        out.push(seg.freeze());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    const SRC: Ipv4Addr = Ipv4Addr::new(192, 168, 127, 3);
    const DST: Ipv4Addr = Ipv4Addr::new(93, 184, 216, 34);

    /// Ethernet + IPv4 + TCP frame with valid checksums.
    fn tcp_frame(seq: u32, flags: u8, payload: &[u8]) -> Vec<u8> {
        let mut f = vec![0u8; ETH_HEADER_LEN + 20 + 20 + payload.len()];
        f[12..14].copy_from_slice(&ETHERTYPE_IPV4.to_be_bytes());
        let ip = ETH_HEADER_LEN;
        f[ip] = 0x45;
        f[ip + 2..ip + 4].copy_from_slice(&((40 + payload.len()) as u16).to_be_bytes());
        f[ip + 4..ip + 6].copy_from_slice(&100u16.to_be_bytes());
        f[ip + 6] = 0x40; // DF
        f[ip + 8] = 64;
        f[ip + 9] = IP_PROTO_TCP;
        f[ip + 12..ip + 16].copy_from_slice(&SRC.octets());
        f[ip + 16..ip + 20].copy_from_slice(&DST.octets());
        let sum = wire::checksum(&f[ip..ip + 20]);
        f[ip + 10..ip + 12].copy_from_slice(&sum.to_be_bytes());
        let tcp = ip + 20;
        f[tcp..tcp + 2].copy_from_slice(&40000u16.to_be_bytes());
        f[tcp + 2..tcp + 4].copy_from_slice(&443u16.to_be_bytes());
        f[tcp + 4..tcp + 8].copy_from_slice(&seq.to_be_bytes());
        f[tcp + 12] = 5 << 4;
        f[tcp + 13] = flags;
        f[tcp + 14..tcp + 16].copy_from_slice(&64240u16.to_be_bytes());
        f[tcp + 20..].copy_from_slice(payload);
        let pseudo = wire::pseudo_sum(SRC, DST, IP_PROTO_TCP, 20 + payload.len());
        let sum = wire::fold(wire::sum16(pseudo, &f[tcp..]));
        f[tcp + 16..tcp + 18].copy_from_slice(&sum.to_be_bytes());
        f
    }

    /// The frame as a NIC with checksum offload receives it: only the
    /// pseudo-header sum in the TCP checksum field.
    fn partial(mut f: Vec<u8>) -> (VnetHdr, Vec<u8>) {
        let tcp = ETH_HEADER_LEN + 20;
        let len = f.len() - tcp;
        let pseudo = wire::pseudo_sum(SRC, DST, IP_PROTO_TCP, len);
        let folded = !wire::fold(pseudo);
        f[tcp + 16..tcp + 18].copy_from_slice(&folded.to_be_bytes());
        let hdr = VnetHdr {
            flags: F_NEEDS_CSUM,
            csum_start: tcp as u16,
            csum_offset: 16,
            ..Default::default()
        };
        (hdr, f)
    }

    fn tcp_checksum_ok(f: &[u8]) -> bool {
        let tcp = ETH_HEADER_LEN + 20;
        let pseudo = wire::pseudo_sum(SRC, DST, IP_PROTO_TCP, f.len() - tcp);
        wire::fold(wire::sum16(pseudo, &f[tcp..])) == 0
    }

    #[test]
    fn header_round_trip() {
        let hdr = VnetHdr {
            flags: 1,
            gso_type: GSO_TCPV4 | GSO_ECN,
            hdr_len: 54,
            gso_size: 1448,
            csum_start: 34,
            csum_offset: 16,
        };
        let mut buf = hdr.encode().to_vec();
        buf.extend_from_slice(b"frame");
        let (parsed, rest) = VnetHdr::parse(&buf).unwrap();
        assert_eq!(parsed, hdr);
        assert_eq!(rest, b"frame");
        assert!(VnetHdr::parse(&buf[..9]).is_none());
    }

    #[test]
    fn plain_frames_pass_through() {
        let f = tcp_frame(1, 0x18, b"hello");
        let mut out = Vec::new();
        expand(&VnetHdr::default(), &f, &mut out).unwrap();
        assert_eq!(out, vec![Bytes::from(f)]);
    }

    #[test]
    fn partial_checksum_is_completed() {
        let full = tcp_frame(7, 0x18, b"some payload of odd length");
        let (hdr, f) = partial(full.clone());
        assert_ne!(f, full);
        let mut out = Vec::new();
        expand(&hdr, &f, &mut out).unwrap();
        assert_eq!(out, vec![Bytes::from(full)]);
    }

    #[test]
    fn udp_zero_checksum_becomes_all_ones() {
        // UDP/IPv4 frame whose data makes the checksum compute to 0
        let mut f = vec![0u8; ETH_HEADER_LEN + 20 + 8];
        f[12..14].copy_from_slice(&ETHERTYPE_IPV4.to_be_bytes());
        f[ETH_HEADER_LEN] = 0x45;
        f[ETH_HEADER_LEN + 9] = IP_PROTO_UDP;
        let udp = ETH_HEADER_LEN + 20;
        // data summing to 0xffff: the checksum (its complement) is 0
        f[udp..udp + 2].copy_from_slice(&0xffffu16.to_be_bytes());
        let mut out = Vec::new();
        let hdr = VnetHdr {
            flags: F_NEEDS_CSUM,
            csum_start: udp as u16,
            csum_offset: 6,
            ..Default::default()
        };
        expand(&hdr, &f, &mut out).unwrap();
        assert_eq!(&out[0][udp + 6..udp + 8], &[0xff, 0xff]);
    }

    #[test]
    fn checksum_position_outside_the_frame_is_dropped() {
        let f = tcp_frame(1, 0x10, b"x");
        let hdr = VnetHdr {
            flags: F_NEEDS_CSUM,
            csum_start: f.len() as u16,
            csum_offset: 16,
            ..Default::default()
        };
        assert_eq!(expand(&hdr, &f, &mut Vec::new()), Err(Dropped::Malformed));
    }

    #[test]
    fn tso_super_frame_is_segmented() {
        let payload: Vec<u8> = (0..3500u32).map(|i| i as u8).collect();
        let seq = 0xffff_fff0; // wraps
        let (mut hdr, f) = partial(tcp_frame(seq, 0x80 | 0x18 | 0x01, &payload)); // CWR PSH ACK FIN... ACK below
        hdr.gso_type = GSO_TCPV4 | GSO_ECN;
        hdr.gso_size = 1448;
        let mut out = Vec::new();
        expand(&hdr, &f, &mut out).unwrap();
        assert_eq!(out.len(), 3);

        let mut joined = Vec::new();
        let mut expect_seq = seq;
        for (i, seg) in out.iter().enumerate() {
            let ip = ETH_HEADER_LEN;
            let tcp = ip + 20;
            let len = seg.len() - tcp - 20;
            assert_eq!(len, if i < 2 { 1448 } else { 3500 - 2 * 1448 });
            // IP: total length, id, checksum
            assert_eq!(u16::from_be_bytes([seg[ip + 2], seg[ip + 3]]) as usize, 40 + len);
            assert_eq!(u16::from_be_bytes([seg[ip + 4], seg[ip + 5]]), 100 + i as u16);
            assert_eq!(wire::checksum(&seg[ip..ip + 20]), 0);
            // TCP: sequence, flags, checksum
            assert_eq!(u32::from_be_bytes(seg[tcp + 4..tcp + 8].try_into().unwrap()), expect_seq);
            let flags = seg[tcp + 13];
            assert_eq!(flags & 0x80 != 0, i == 0, "CWR only on the first segment");
            assert_eq!(flags & 0x09 != 0, i == 2, "FIN/PSH only on the last segment");
            assert!(tcp_checksum_ok(seg));
            // the stack's own parser accepts the segment
            assert!(wire::parse_ipv4(&seg[ip..]).is_ok());
            joined.extend_from_slice(&seg[tcp + 20..]);
            expect_seq = expect_seq.wrapping_add(len as u32);
        }
        assert_eq!(joined, payload);
    }

    #[test]
    fn tso_without_gso_size_is_a_plain_partial_frame() {
        let full = tcp_frame(1, 0x18, b"abc");
        let (mut hdr, f) = partial(full.clone());
        hdr.gso_type = GSO_TCPV4;
        let mut out = Vec::new();
        expand(&hdr, &f, &mut out).unwrap();
        assert_eq!(out, vec![Bytes::from(full)]);
    }

    #[test]
    fn other_gso_types_are_dropped() {
        let f = tcp_frame(1, 0x10, &[0; 2000]);
        for gso_type in [3u8, 4, 5] {
            let hdr = VnetHdr { gso_type, gso_size: 1448, ..Default::default() };
            assert_eq!(expand(&hdr, &f, &mut Vec::new()), Err(Dropped::UnsupportedGso(gso_type)));
        }
    }
}

//! Minimal DHCP server: DISCOVER → OFFER, REQUEST → ACK, always
//! leasing the configured guest address for a day.

use std::net::Ipv4Addr;

use crate::config::{MacAddr, NetConfig};

pub const DHCP_SERVER_PORT: u16 = 67;
pub const DHCP_CLIENT_PORT: u16 = 68;
const MAGIC_COOKIE: u32 = 0x6382_5363;

pub const DHCP_DISCOVER: u8 = 1;
pub const DHCP_OFFER: u8 = 2;
pub const DHCP_REQUEST: u8 = 3;
pub const DHCP_ACK: u8 = 5;

const OPT_SUBNET_MASK: u8 = 1;
const OPT_ROUTER: u8 = 3;
const OPT_DNS: u8 = 6;
const OPT_BROADCAST: u8 = 28;
const OPT_LEASE_TIME: u8 = 51;
const OPT_MSG_TYPE: u8 = 53;
const OPT_SERVER_ID: u8 = 54;
const OPT_END: u8 = 255;

const LEASE_SECONDS: u32 = 86_400;
const REPLY_LEN: usize = 300;

/// DHCP reply to send to the guest.
pub struct DhcpReply {
    /// `DHCP_OFFER` or `DHCP_ACK`
    pub msg_type: u8,
    /// BOOTP payload (UDP 67 → 68, IP gateway → 255.255.255.255)
    pub payload: Vec<u8>,
    /// broadcast when the client set the BROADCAST flag, else its `chaddr`
    pub dst_mac: MacAddr,
}

/// Handles one BOOTREQUEST; returns the reply for DISCOVER/REQUEST.
/// The DNS servers a reply offers for the stack's `dns_servers`.
pub fn offered_dns(dns_servers: &[Ipv4Addr]) -> Vec<Ipv4Addr> {
    if dns_servers.is_empty() {
        vec![Ipv4Addr::new(8, 8, 8, 8)]
    } else {
        // Option length is a byte: at most 63 servers.
        dns_servers.iter().copied().take(63).collect()
    }
}

pub fn handle(request: &[u8], config: &NetConfig, dns_servers: &[Ipv4Addr]) -> Option<DhcpReply> {
    if request.len() < 240 || request[0] != 1 {
        return None;
    }
    let xid = &request[4..8];
    let flags = u16::from_be_bytes([request[10], request[11]]);
    let chaddr = &request[28..44];
    if u32::from_be_bytes(request[236..240].try_into().ok()?) != MAGIC_COOKIE {
        return None;
    }

    let mut msg_type = 0;
    let mut i = 240;
    while i < request.len() {
        let opt = request[i];
        if opt == OPT_END {
            break;
        }
        if opt == 0 {
            i += 1;
            continue;
        }
        let Some(&len) = request.get(i + 1) else {
            break;
        };
        let len = usize::from(len);
        let data = request.get(i + 2..(i + 2 + len).min(request.len()))?;
        if opt == OPT_MSG_TYPE && !data.is_empty() {
            msg_type = data[0];
        }
        i += 2 + len;
    }

    let reply_type = match msg_type {
        DHCP_DISCOVER => DHCP_OFFER,
        DHCP_REQUEST => DHCP_ACK,
        _ => return None,
    };

    let gw = config.gateway_ip.octets();
    let mut out = vec![0u8; REPLY_LEN];
    out[0] = 2; // BOOTREPLY
    out[1] = 1; // ethernet
    out[2] = 6;
    out[4..8].copy_from_slice(xid);
    out[10..12].copy_from_slice(&flags.to_be_bytes());
    out[16..20].copy_from_slice(&config.guest_ip.octets()); // yiaddr
    out[20..24].copy_from_slice(&gw); // siaddr
    out[28..44].copy_from_slice(chaddr);
    out[236..240].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());

    let dns = offered_dns(dns_servers);

    let mut opts: Vec<u8> = Vec::with_capacity(64);
    opts.extend_from_slice(&[OPT_MSG_TYPE, 1, reply_type]);
    opts.extend_from_slice(&[OPT_SERVER_ID, 4]);
    opts.extend_from_slice(&gw);
    opts.extend_from_slice(&[OPT_LEASE_TIME, 4]);
    opts.extend_from_slice(&LEASE_SECONDS.to_be_bytes());
    opts.extend_from_slice(&[OPT_SUBNET_MASK, 4]);
    opts.extend_from_slice(&config.netmask().octets());
    opts.extend_from_slice(&[OPT_ROUTER, 4]);
    opts.extend_from_slice(&gw);
    opts.extend_from_slice(&[OPT_DNS, (dns.len() * 4) as u8]);
    for server in &dns {
        opts.extend_from_slice(&server.octets());
    }
    opts.extend_from_slice(&[OPT_BROADCAST, 4]);
    opts.extend_from_slice(&config.broadcast().octets());
    opts.push(OPT_END);
    if 240 + opts.len() > out.len() {
        out.resize(240 + opts.len(), 0);
    }
    out[240..240 + opts.len()].copy_from_slice(&opts);

    let dst_mac = if flags & 0x8000 != 0 {
        MacAddr::BROADCAST
    } else {
        MacAddr(chaddr[..6].try_into().ok()?)
    };
    Some(DhcpReply { msg_type: reply_type, payload: out, dst_mac })
}

/// Parses DHCP options of a reply into `(code, data)` pairs (tests and debugging).
pub fn parse_options(payload: &[u8]) -> Vec<(u8, Vec<u8>)> {
    let mut out = Vec::new();
    let mut i = 240;
    while i < payload.len() {
        let code = payload[i];
        if code == OPT_END {
            break;
        }
        if code == 0 {
            i += 1;
            continue;
        }
        let Some(&len) = payload.get(i + 1) else {
            break;
        };
        let end = (i + 2 + usize::from(len)).min(payload.len());
        out.push((code, payload[i + 2..end].to_vec()));
        i = end;
    }
    out
}

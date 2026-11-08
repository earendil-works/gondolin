//! Network configuration (`configure.net` in the controller protocol).
//!
//! Addresses are encoded as strings so the
//! CBOR form is readable from TypeScript (`"192.168.127.1"`, `"5a:94:ef:e4:0c:dd"`).

use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

use gondolin_wire::{DecodeError, FromValue, ToValue, Value, wire_enum, wire_struct};

wire_struct! {
    /// Userspace network stack configuration; absent fields take the defaults.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct NetConfig {
        /// host-side gateway address (ARP, DHCP server, synthetic DNS server)
        pub gateway_ip: Ipv4Addr = NetConfig::default().gateway_ip,
        /// address leased to the guest via DHCP
        pub guest_ip: Ipv4Addr = NetConfig::default().guest_ip,
        /// subnet prefix length of the virtual LAN
        pub prefix_len: u8 = NetConfig::default().prefix_len,
        /// gateway MAC address
        pub gateway_mac: MacAddr = NetConfig::default().gateway_mac,
        /// guest MAC address (QEMU `-device ...,mac=`); updated from frames the guest sends
        pub guest_mac: MacAddr = NetConfig::default().guest_mac,
        /// IP MTU of the virtual link in `bytes`
        pub mtu: u16 = NetConfig::default().mtu,
        /// whether the guest NIC offloads TCP/UDP checksums (krun's virtio-net
        /// `CSUM` feature: guest packets may carry partial checksums, so they are
        /// not verified)
        pub checksum_offload: bool = false,
        /// DNS behavior
        pub dns: DnsConfig = DnsConfig::default(),
        /// resource limits
        pub limits: NetLimits = NetLimits::default(),
    }
}

impl Default for NetConfig {
    fn default() -> Self {
        NetConfig {
            gateway_ip: Ipv4Addr::new(192, 168, 127, 1),
            guest_ip: Ipv4Addr::new(192, 168, 127, 3),
            prefix_len: 24,
            gateway_mac: MacAddr([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]),
            guest_mac: MacAddr([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]),
            mtu: 1500,
            checksum_offload: false,
            dns: DnsConfig::default(),
            limits: NetLimits::default(),
        }
    }
}

impl NetConfig {
    /// Subnet mask derived from [`NetConfig::prefix_len`].
    pub fn netmask(&self) -> Ipv4Addr {
        let prefix = u32::from(self.prefix_len.min(32));
        let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
        Ipv4Addr::from(mask)
    }

    /// Directed broadcast address of the virtual LAN.
    pub fn broadcast(&self) -> Ipv4Addr {
        Ipv4Addr::from(u32::from(self.guest_ip) | !u32::from(self.netmask()))
    }
}

wire_enum! {
    /// How UDP/53 traffic from the guest is handled (`docs/network.md`).
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub enum DnsMode {
        /// answer A/AAAA locally with synthetic addresses; nothing leaves the host
        #[default]
        Synthetic = "synthetic",
        /// forward validated queries to trusted IPv4 resolvers only
        Trusted = "trusted",
        /// forward UDP/53 to whatever IP the guest targeted
        Open = "open",
    }
}

wire_enum! {
    /// Synthetic `A` answer strategy.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub enum SyntheticHostMapping {
        /// every name resolves to [`DnsConfig::synthetic_ipv4`]
        #[default]
        Single = "single",
        /// every name gets its own address in `198.19.0.0/16` (reverse-mappable)
        PerHost = "per-host",
    }
}

wire_struct! {
    /// DNS options (`VMOptions.dns`, resolved by the controller); absent
    /// fields take the defaults.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct DnsConfig {
        /// DNS mode
        pub mode: DnsMode = DnsMode::default(),
        /// trusted IPv4 resolvers (mode `trusted`); empty = the daemon host's resolvers
        pub trusted_servers: Vec<Ipv4Addr> = Vec::new(),
        /// synthetic `A` answer (mode `synthetic`, single mapping)
        pub synthetic_ipv4: Ipv4Addr = DnsConfig::default().synthetic_ipv4,
        /// synthetic `AAAA` answer (mode `synthetic`)
        pub synthetic_ipv6: Ipv6Addr = DnsConfig::default().synthetic_ipv6,
        /// synthetic answer TTL in `seconds`
        pub synthetic_ttl_seconds: u32 = DnsConfig::default().synthetic_ttl_seconds,
        /// synthetic `A` strategy; the controller resolves the node engine's auto
        /// default (`per-host` when SSH or mapped TCP egress is enabled)
        pub synthetic_host_mapping: SyntheticHostMapping = SyntheticHostMapping::default(),
    }
}

impl Default for DnsConfig {
    fn default() -> Self {
        DnsConfig {
            mode: DnsMode::Synthetic,
            trusted_servers: Vec::new(),
            synthetic_ipv4: Ipv4Addr::new(192, 0, 2, 1),
            synthetic_ipv6: Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1),
            synthetic_ttl_seconds: 60,
            synthetic_host_mapping: SyntheticHostMapping::Single,
        }
    }
}

wire_struct! {
    /// Resource limits. Every buffer in the stack is bounded by one of these;
    /// absent fields take the defaults.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct NetLimits {
        /// max concurrent guest TCP connections (incl. handshakes and lingering closes)
        pub max_tcp_flows: usize = NetLimits::default().max_tcp_flows,
        /// per-flow receive buffer (guest -> host) in `bytes`; bounds the advertised window
        pub tcp_rx_buffer_bytes: usize = NetLimits::default().tcp_rx_buffer_bytes,
        /// per-flow send buffer (host -> guest) in `bytes`
        pub tcp_tx_buffer_bytes: usize = NetLimits::default().tcp_tx_buffer_bytes,
        /// queued frames to QEMU in `bytes` above which TCP stops emitting segments
        pub tx_queue_soft_bytes: usize = NetLimits::default().tx_queue_soft_bytes,
        /// queued frames to QEMU in `bytes` above which other frames (DNS, ICMP, ...) are dropped
        pub tx_queue_max_bytes: usize = NetLimits::default().tx_queue_max_bytes,
        /// max concurrent upstream UDP (DNS) sockets; least recently used is evicted
        pub max_udp_sessions: usize = NetLimits::default().max_udp_sessions,
        /// idle time in `ms` after which an upstream UDP socket is closed
        pub udp_session_idle_timeout_ms: u64 = NetLimits::default().udp_session_idle_timeout_ms,
        /// time in `ms` a guest connection may stay in the handshake
        pub tcp_handshake_timeout_ms: u64 = NetLimits::default().tcp_handshake_timeout_ms,
        /// time in `ms` a closed flow may linger waiting for the guest's FIN/ACK before RST
        pub tcp_linger_timeout_ms: u64 = NetLimits::default().tcp_linger_timeout_ms,
    }
}

impl Default for NetLimits {
    fn default() -> Self {
        NetLimits {
            max_tcp_flows: 1024,
            tcp_rx_buffer_bytes: 256 * 1024,
            tcp_tx_buffer_bytes: 256 * 1024,
            tx_queue_soft_bytes: 512 * 1024,
            tx_queue_max_bytes: 8 * 1024 * 1024,
            max_udp_sessions: 128,
            udp_session_idle_timeout_ms: 10_000,
            tcp_handshake_timeout_ms: 30_000,
            tcp_linger_timeout_ms: 60_000,
        }
    }
}

/// Ethernet MAC address, serialized as `"aa:bb:cc:dd:ee:ff"`.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct MacAddr(pub [u8; 6]);

impl MacAddr {
    pub const BROADCAST: MacAddr = MacAddr([0xff; 6]);

    pub fn is_unicast(&self) -> bool {
        self.0[0] & 1 == 0 && self.0 != [0; 6]
    }
}

impl fmt::Display for MacAddr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let m = self.0;
        write!(f, "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}", m[0], m[1], m[2], m[3], m[4], m[5])
    }
}

impl fmt::Debug for MacAddr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

/// Error parsing a [`MacAddr`].
#[derive(Debug)]
pub struct InvalidMac;

impl fmt::Display for InvalidMac {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid MAC address")
    }
}

impl std::error::Error for InvalidMac {}

impl FromStr for MacAddr {
    type Err = InvalidMac;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let mut out = [0u8; 6];
        let mut parts = s.split([':', '-']);
        for byte in &mut out {
            let part = parts.next().ok_or(InvalidMac)?;
            if part.len() != 2 {
                return Err(InvalidMac);
            }
            *byte = u8::from_str_radix(part, 16).map_err(|_| InvalidMac)?;
        }
        if parts.next().is_some() {
            return Err(InvalidMac);
        }
        Ok(MacAddr(out))
    }
}

impl ToValue for MacAddr {
    fn to_value(&self) -> Value {
        Value::Text(self.to_string())
    }
}

impl FromValue for MacAddr {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        let text = value.as_text().ok_or_else(|| DecodeError::expected("a MAC address", value))?;
        text.parse().map_err(|_| DecodeError::new(format!("invalid MAC address {text:?}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_roundtrip() {
        let mac: MacAddr = "5a:94:ef:e4:0c:dd".parse().unwrap();
        assert_eq!(mac.0, [0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
        assert_eq!(mac.to_string(), "5a:94:ef:e4:0c:dd");
        assert!("5a:94:ef:e4:0c".parse::<MacAddr>().is_err());
        assert!("5a:94:ef:e4:0c:dd:00".parse::<MacAddr>().is_err());
    }

    #[test]
    fn cbor_uses_strings_and_defaults() {
        let config = NetConfig {
            dns: DnsConfig {
                mode: DnsMode::Trusted,
                trusted_servers: vec![Ipv4Addr::new(1, 1, 1, 1)],
                synthetic_host_mapping: SyntheticHostMapping::PerHost,
                ..DnsConfig::default()
            },
            ..NetConfig::default()
        };
        let buf = gondolin_wire::encode(&config).unwrap();
        let value: Value = gondolin_wire::decode(&buf).unwrap();
        assert_eq!(value.get("gateway_ip").and_then(Value::as_text), Some("192.168.127.1"));
        assert_eq!(value.get("gateway_mac").and_then(Value::as_text), Some("5a:94:ef:e4:0c:dd"));
        let dns = value.get("dns").unwrap();
        assert_eq!(dns.get("synthetic_host_mapping").and_then(Value::as_text), Some("per-host"));
        let servers = dns.get("trusted_servers").and_then(Value::as_array).unwrap();
        assert_eq!(servers[0].as_text(), Some("1.1.1.1"));

        let back: NetConfig = gondolin_wire::decode(&buf).unwrap();
        assert_eq!(back, config);

        // Missing fields take defaults.
        let partial = gondolin_wire::value!({ "dns": { "mode": "open" } });
        let parsed: NetConfig = gondolin_wire::from_value(&partial).unwrap();
        assert_eq!(parsed.dns.mode, DnsMode::Open);
        assert_eq!(parsed.guest_ip, Ipv4Addr::new(192, 168, 127, 3));
        assert_eq!(parsed.limits, NetLimits::default());
    }

    #[test]
    fn netmask_and_broadcast() {
        let config = NetConfig::default();
        assert_eq!(config.netmask(), Ipv4Addr::new(255, 255, 255, 0));
        assert_eq!(config.broadcast(), Ipv4Addr::new(192, 168, 127, 255));
    }
}

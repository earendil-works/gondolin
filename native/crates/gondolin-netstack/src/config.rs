//! Network configuration (`configure.net` in the controller protocol).
//!
//! Defaults match the node engine (`host/src/qemu/net.ts`,
//! `host/src/qemu/network-stack.ts`). Addresses are encoded as strings so the
//! CBOR form is readable from TypeScript (`"192.168.127.1"`, `"5a:94:ef:e4:0c:dd"`).

use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Userspace network stack configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct NetConfig {
    /// host-side gateway address (ARP, DHCP server, synthetic DNS server)
    #[serde(with = "as_str")]
    pub gateway_ip: Ipv4Addr,
    /// address leased to the guest via DHCP
    #[serde(with = "as_str")]
    pub guest_ip: Ipv4Addr,
    /// subnet prefix length of the virtual LAN
    pub prefix_len: u8,
    /// gateway MAC address
    pub gateway_mac: MacAddr,
    /// guest MAC address (QEMU `-device ...,mac=`); updated from frames the guest sends
    pub guest_mac: MacAddr,
    /// IP MTU of the virtual link in `bytes`
    pub mtu: u16,
    /// whether the guest NIC offloads TCP/UDP checksums (krun's virtio-net
    /// `CSUM` feature: guest packets may carry partial checksums, so they are
    /// not verified)
    pub checksum_offload: bool,
    /// DNS behavior
    pub dns: DnsConfig,
    /// resource limits
    pub limits: NetLimits,
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

/// How UDP/53 traffic from the guest is handled (`docs/network.md`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DnsMode {
    /// answer A/AAAA locally with synthetic addresses; nothing leaves the host
    #[default]
    Synthetic,
    /// forward validated queries to trusted IPv4 resolvers only
    Trusted,
    /// forward UDP/53 to whatever IP the guest targeted
    Open,
}

/// Synthetic `A` answer strategy.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyntheticHostMapping {
    /// every name resolves to [`DnsConfig::synthetic_ipv4`]
    #[default]
    Single,
    /// every name gets its own address in `198.19.0.0/16` (reverse-mappable)
    PerHost,
}

/// DNS options (`VMOptions.dns`, resolved by the controller).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DnsConfig {
    /// DNS mode
    pub mode: DnsMode,
    /// trusted IPv4 resolvers (mode `trusted`); empty = the daemon host's resolvers
    #[serde(with = "as_str_vec")]
    pub trusted_servers: Vec<Ipv4Addr>,
    /// synthetic `A` answer (mode `synthetic`, single mapping)
    #[serde(with = "as_str")]
    pub synthetic_ipv4: Ipv4Addr,
    /// synthetic `AAAA` answer (mode `synthetic`)
    #[serde(with = "as_str")]
    pub synthetic_ipv6: Ipv6Addr,
    /// synthetic answer TTL in `seconds`
    pub synthetic_ttl_seconds: u32,
    /// synthetic `A` strategy; the controller resolves the node engine's auto
    /// default (`per-host` when SSH or mapped TCP egress is enabled)
    pub synthetic_host_mapping: SyntheticHostMapping,
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

/// Resource limits. Every buffer in the stack is bounded by one of these.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct NetLimits {
    /// max concurrent guest TCP connections (incl. handshakes and lingering closes)
    pub max_tcp_flows: usize,
    /// per-flow receive buffer (guest -> host) in `bytes`; bounds the advertised window
    pub tcp_rx_buffer_bytes: usize,
    /// per-flow send buffer (host -> guest) in `bytes`
    pub tcp_tx_buffer_bytes: usize,
    /// queued frames to QEMU in `bytes` above which TCP stops emitting segments
    pub tx_queue_soft_bytes: usize,
    /// queued frames to QEMU in `bytes` above which other frames (DNS, ICMP, ...) are dropped
    pub tx_queue_max_bytes: usize,
    /// max concurrent upstream UDP (DNS) sockets; least recently used is evicted
    pub max_udp_sessions: usize,
    /// idle time in `ms` after which an upstream UDP socket is closed
    pub udp_session_idle_timeout_ms: u64,
    /// time in `ms` a guest connection may stay in the handshake
    pub tcp_handshake_timeout_ms: u64,
    /// time in `ms` a closed flow may linger waiting for the guest's FIN/ACK before RST
    pub tcp_linger_timeout_ms: u64,
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
#[derive(Debug, thiserror::Error)]
#[error("invalid MAC address")]
pub struct InvalidMac;

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

impl Serialize for MacAddr {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        as_str::serialize(self, s)
    }
}

impl<'de> Deserialize<'de> for MacAddr {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        as_str::deserialize(d)
    }
}

/// Serde helpers encoding `Display`/`FromStr` types as strings (CBOR is not
/// human-readable, so std's IP impls would otherwise produce byte arrays).
pub(crate) mod as_str {
    use std::fmt::Display;
    use std::str::FromStr;

    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<T: Display, S: Serializer>(value: &T, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(value)
    }

    pub fn deserialize<'de, T, D>(d: D) -> Result<T, D::Error>
    where
        T: FromStr,
        T::Err: Display,
        D: Deserializer<'de>,
    {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

pub(crate) mod as_str_vec {
    use std::fmt::Display;
    use std::str::FromStr;

    use serde::ser::SerializeSeq;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<T: Display, S: Serializer>(values: &[T], s: S) -> Result<S::Ok, S::Error> {
        let mut seq = s.serialize_seq(Some(values.len()))?;
        for value in values {
            seq.serialize_element(&value.to_string())?;
        }
        seq.end()
    }

    pub fn deserialize<'de, T, D>(d: D) -> Result<Vec<T>, D::Error>
    where
        T: FromStr,
        T::Err: Display,
        D: Deserializer<'de>,
    {
        Vec::<String>::deserialize(d)?
            .iter()
            .map(|s| s.parse().map_err(serde::de::Error::custom))
            .collect()
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
        let mut buf = Vec::new();
        ciborium::into_writer(&config, &mut buf).unwrap();
        let value: ciborium::Value = ciborium::from_reader(&buf[..]).unwrap();
        let map = value.as_map().unwrap();
        let get = |k: &str| {
            map.iter().find(|(key, _)| key.as_text() == Some(k)).map(|(_, v)| v.clone()).unwrap()
        };
        assert_eq!(get("gateway_ip").as_text(), Some("192.168.127.1"));
        assert_eq!(get("gateway_mac").as_text(), Some("5a:94:ef:e4:0c:dd"));
        let dns = get("dns");
        let dns_map = dns.as_map().unwrap();
        let mapping =
            dns_map.iter().find(|(k, _)| k.as_text() == Some("synthetic_host_mapping")).unwrap();
        assert_eq!(mapping.1.as_text(), Some("per-host"));

        let back: NetConfig = ciborium::from_reader(&buf[..]).unwrap();
        assert_eq!(back, config);

        // Missing fields take defaults.
        let mut partial = Vec::new();
        ciborium::into_writer(
            &ciborium::Value::Map(vec![(
                ciborium::Value::Text("dns".into()),
                ciborium::Value::Map(vec![(
                    ciborium::Value::Text("mode".into()),
                    ciborium::Value::Text("open".into()),
                )]),
            )]),
            &mut partial,
        )
        .unwrap();
        let parsed: NetConfig = ciborium::from_reader(&partial[..]).unwrap();
        assert_eq!(parsed.dns.mode, DnsMode::Open);
        assert_eq!(parsed.guest_ip, Ipv4Addr::new(192, 168, 127, 3));
    }

    #[test]
    fn netmask_and_broadcast() {
        let config = NetConfig::default();
        assert_eq!(config.netmask(), Ipv4Addr::new(255, 255, 255, 0));
        assert_eq!(config.broadcast(), Ipv4Addr::new(192, 168, 127, 255));
    }
}

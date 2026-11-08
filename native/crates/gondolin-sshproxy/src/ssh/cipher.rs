//! Binary packet protection: none (before the first NEWKEYS),
//! `chacha20-poly1305@openssh.com` and `aes{128,256}-gcm@openssh.com`.

use ring::aead::{self, chacha20_poly1305_openssh as chacha};

use super::Error;

pub const CHACHA: &str = "chacha20-poly1305@openssh.com";
pub const AES128_GCM: &str = "aes128-gcm@openssh.com";
pub const AES256_GCM: &str = "aes256-gcm@openssh.com";

/// Ciphers we offer, preferred first.
pub const CIPHERS: &[&str] = &[CHACHA, AES128_GCM, AES256_GCM];

/// Largest packet (`packet_length`) we accept in `bytes` (OpenSSH: 256 KiB).
pub const MAX_PACKET_LEN: usize = 256 * 1024;

/// (key length, iv length) in `bytes`.
pub fn key_sizes(name: &str) -> (usize, usize) {
    match name {
        CHACHA => (64, 0),
        AES128_GCM => (16, 12),
        AES256_GCM => (32, 12),
        _ => (0, 0),
    }
}

#[allow(clippy::large_enum_variant)]
enum Kind {
    None,
    ChaCha { seal: Option<chacha::SealingKey>, open: Option<chacha::OpeningKey> },
    Gcm { key: aead::LessSafeKey, iv: [u8; 12] },
}

/// One direction's packet protection.
pub struct PacketCipher {
    kind: Kind,
}

fn gcm_nonce(iv: &mut [u8; 12]) -> aead::Nonce {
    let nonce = aead::Nonce::assume_unique_for_key(*iv);
    // the low 8 bytes are the invocation counter (RFC 5647 section 7.1)
    let mut counter = u64::from_be_bytes(iv[4..].try_into().expect("8 bytes"));
    counter = counter.wrapping_add(1);
    iv[4..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

impl PacketCipher {
    pub fn none() -> PacketCipher {
        PacketCipher { kind: Kind::None }
    }

    /// `seal`: for sending (else receiving).
    pub fn new(name: &str, key: &[u8], iv: &[u8], seal: bool) -> Result<PacketCipher, Error> {
        let bad = || Error::Protocol("bad cipher key".into());
        let kind = match name {
            CHACHA => {
                let k: &[u8; 64] = key.try_into().map_err(|_| bad())?;
                if seal {
                    Kind::ChaCha { seal: Some(chacha::SealingKey::new(k)), open: None }
                } else {
                    Kind::ChaCha { seal: None, open: Some(chacha::OpeningKey::new(k)) }
                }
            }
            AES128_GCM | AES256_GCM => {
                let alg = if name == AES128_GCM { &aead::AES_128_GCM } else { &aead::AES_256_GCM };
                let key =
                    aead::LessSafeKey::new(aead::UnboundKey::new(alg, key).map_err(|_| bad())?);
                Kind::Gcm { key, iv: iv.try_into().map_err(|_| bad())? }
            }
            other => return Err(Error::Negotiation(format!("unsupported cipher {other}"))),
        };
        Ok(PacketCipher { kind })
    }

    fn block_size(&self) -> usize {
        match self.kind {
            Kind::Gcm { .. } => 16,
            _ => 8,
        }
    }

    /// Whether the length field is excluded from the padding alignment.
    fn aead(&self) -> bool {
        !matches!(self.kind, Kind::None)
    }

    /// Frames, pads and protects `payload`, appending the packet to `out`.
    pub fn seal(&mut self, seq: u32, payload: &[u8], out: &mut Vec<u8>) {
        let bs = self.block_size();
        let aad = if self.aead() { 0 } else { 4 };
        let unpadded = aad + 1 + payload.len();
        let mut pad = bs - unpadded % bs;
        if pad < 4 {
            pad += bs;
        }
        let len = 1 + payload.len() + pad;
        let start = out.len();
        out.reserve(4 + len + 16);
        out.extend_from_slice(&(len as u32).to_be_bytes());
        out.push(pad as u8);
        out.extend_from_slice(payload);
        out.resize(out.len() + pad, 0);
        match &mut self.kind {
            Kind::None => {}
            Kind::ChaCha { seal, .. } => {
                let mut tag = [0u8; 16];
                seal.as_ref().expect("sealing key").seal_in_place(seq, &mut out[start..], &mut tag);
                out.extend_from_slice(&tag);
            }
            Kind::Gcm { key, iv } => {
                let nonce = gcm_nonce(iv);
                let (head, body) = out[start..].split_at_mut(4);
                let tag = key
                    .seal_in_place_separate_tag(nonce, aead::Aad::from(&*head), body)
                    .expect("gcm seal");
                out.extend_from_slice(tag.as_ref());
            }
        }
    }

    /// Opens the packet at the start of `buf`: `Ok(None)` when incomplete,
    /// else the payload and the number of bytes the packet used.
    pub fn open(&mut self, seq: u32, buf: &mut [u8]) -> Result<Option<(Vec<u8>, usize)>, Error> {
        if buf.len() < 4 {
            return Ok(None);
        }
        let head: [u8; 4] = buf[..4].try_into().expect("4 bytes");
        let len = match &self.kind {
            Kind::ChaCha { open, .. } => u32::from_be_bytes(
                open.as_ref().expect("opening key").decrypt_packet_length(seq, head),
            ),
            _ => u32::from_be_bytes(head),
        } as usize;
        let bs = self.block_size();
        let aligned =
            if self.aead() { len.is_multiple_of(bs) } else { (len + 4).is_multiple_of(bs) };
        if !(5..=MAX_PACKET_LEN).contains(&len) || !aligned {
            return Err(Error::Protocol(format!("bad packet length {len}")));
        }
        let tag_len = if self.aead() { 16 } else { 0 };
        let total = 4 + len + tag_len;
        if buf.len() < total {
            return Ok(None);
        }
        let mac_error = || Error::Protocol("message authentication failed".into());
        let plain: &[u8] = match &mut self.kind {
            Kind::None => &buf[4..4 + len],
            Kind::ChaCha { open, .. } => {
                let (packet, rest) = buf[..total].split_at_mut(4 + len);
                let tag: &[u8; 16] = (&*rest).try_into().expect("16-byte tag");
                open.as_ref()
                    .expect("opening key")
                    .open_in_place(seq, packet, tag)
                    .map_err(|_| mac_error())?
            }
            Kind::Gcm { key, iv } => {
                let nonce = gcm_nonce(iv);
                let (head, body) = buf[..total].split_at_mut(4);
                let plain = key
                    .open_in_place(nonce, aead::Aad::from(&*head), body)
                    .map_err(|_| mac_error())?;
                &*plain
            }
        };
        let pad = plain[0] as usize;
        if pad < 4 || pad + 1 > plain.len() {
            return Err(Error::Protocol("bad padding".into()));
        }
        Ok(Some((plain[1..plain.len() - pad].to_vec(), total)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_every_cipher() {
        for name in ["none", CHACHA, AES128_GCM, AES256_GCM] {
            let (kl, il) = key_sizes(name);
            let key = vec![7u8; kl];
            let iv = vec![9u8; il];
            let (mut s, mut o) = if name == "none" {
                (PacketCipher::none(), PacketCipher::none())
            } else {
                (
                    PacketCipher::new(name, &key, &iv, true).unwrap(),
                    PacketCipher::new(name, &key, &iv, false).unwrap(),
                )
            };
            let mut wire = Vec::new();
            for (seq, payload) in [&b"hello"[..], &[0u8; 0], &[1u8; 1000]].iter().enumerate() {
                s.seal(seq as u32, payload, &mut wire);
            }
            let mut off = 0;
            for (seq, payload) in [&b"hello"[..], &[0u8; 0], &[1u8; 1000]].iter().enumerate() {
                // incomplete input waits for more
                assert!(o.open(seq as u32, &mut wire[off..off + 3].to_vec()).unwrap().is_none());
                let (got, used) = o.open(seq as u32, &mut wire[off..]).unwrap().unwrap();
                assert_eq!(&got, payload, "{name}");
                off += used;
            }
            assert_eq!(off, wire.len());
            if name != "none" {
                // a flipped bit fails authentication
                let mut wire2 = Vec::new();
                let mut s = PacketCipher::new(name, &key, &iv, true).unwrap();
                let mut o = PacketCipher::new(name, &key, &iv, false).unwrap();
                s.seal(0, b"x", &mut wire2);
                let last = wire2.len() - 1;
                wire2[last] ^= 1;
                assert!(o.open(0, &mut wire2).is_err());
            }
        }
    }
}

//! Algorithm negotiation (KEXINIT) and ECDH key agreement.

use ring::agreement::{self, EphemeralPrivateKey, UnparsedPublicKey};
use ring::digest;
use ring::rand::SystemRandom;

use super::Error;
use super::cipher;
use super::wire::{Reader, Writer};

pub const CURVE25519: &str = "curve25519-sha256";
pub const CURVE25519_LIBSSH: &str = "curve25519-sha256@libssh.org";
pub const ECDH_P256: &str = "ecdh-sha2-nistp256";
pub const ECDH_P384: &str = "ecdh-sha2-nistp384";
pub const KEX_ALGORITHMS: &[&str] = &[CURVE25519, CURVE25519_LIBSSH, ECDH_P256, ECDH_P384];

pub const EXT_INFO_C: &str = "ext-info-c";
pub const STRICT_C: &str = "kex-strict-c-v00@openssh.com";
pub const STRICT_S: &str = "kex-strict-s-v00@openssh.com";

/// MACs we list for peers that insist on one; never used (all our ciphers are AEAD).
pub const MACS: &[&str] = &["hmac-sha2-256-etm@openssh.com", "hmac-sha2-256"];

/// A parsed `SSH_MSG_KEXINIT`.
#[derive(Debug, Clone)]
pub struct KexInit {
    pub kex: Vec<String>,
    pub host_key: Vec<String>,
    pub enc_c2s: Vec<String>,
    pub enc_s2c: Vec<String>,
    pub comp_c2s: Vec<String>,
    pub comp_s2c: Vec<String>,
    pub first_kex_follows: bool,
    /// the whole payload (`I_C` / `I_S` in the exchange hash)
    pub raw: Vec<u8>,
}

impl KexInit {
    pub fn build(kex: &[&str], host_key: &[String]) -> Result<KexInit, Error> {
        let mut cookie = [0u8; 16];
        ring::rand::SecureRandom::fill(&SystemRandom::new(), &mut cookie)
            .map_err(|_| Error::Protocol("random generator failed".into()))?;
        let mut w = Writer::msg(super::msg::KEXINIT);
        w.raw(&cookie)
            .name_list(kex)
            .name_list(host_key)
            .name_list(cipher::CIPHERS)
            .name_list(cipher::CIPHERS)
            .name_list(MACS)
            .name_list(MACS)
            .name_list(&["none"])
            .name_list(&["none"])
            .name_list::<&str>(&[])
            .name_list::<&str>(&[])
            .bool(false)
            .u32(0);
        KexInit::parse(&w.finish())
    }

    pub fn parse(payload: &[u8]) -> Result<KexInit, Error> {
        let mut r = Reader::new(payload);
        r.u8()?;
        r.bytes(16)?;
        let kex = r.name_list()?;
        let host_key = r.name_list()?;
        let enc_c2s = r.name_list()?;
        let enc_s2c = r.name_list()?;
        let _mac_c2s = r.name_list()?;
        let _mac_s2c = r.name_list()?;
        let comp_c2s = r.name_list()?;
        let comp_s2c = r.name_list()?;
        let _lang_c2s = r.name_list()?;
        let _lang_s2c = r.name_list()?;
        let first_kex_follows = r.bool()?;
        let _reserved = r.u32()?;
        Ok(KexInit {
            kex,
            host_key,
            enc_c2s,
            enc_s2c,
            comp_c2s,
            comp_s2c,
            first_kex_follows,
            raw: payload.to_vec(),
        })
    }
}

/// The outcome of negotiation.
#[derive(Debug, Clone)]
pub struct Negotiated {
    pub kex: String,
    pub host_key: String,
    pub enc_c2s: String,
    pub enc_s2c: String,
    /// the peer's guessed first kex packet is wrong and must be ignored
    pub ignore_guess: bool,
}

fn pseudo(name: &str) -> bool {
    name.starts_with("ext-info-") || name.starts_with("kex-strict-")
}

fn choose(client: &[String], server: &[String], what: &str) -> Result<String, Error> {
    client
        .iter()
        .find(|c| !pseudo(c) && server.contains(c))
        .cloned()
        .ok_or_else(|| Error::Negotiation(format!("no common {what} algorithm")))
}

pub fn negotiate(
    client: &KexInit,
    server: &KexInit,
    server_role: bool,
) -> Result<Negotiated, Error> {
    let kex = choose(&client.kex, &server.kex, "key exchange")?;
    let host_key = choose(&client.host_key, &server.host_key, "host key")?;
    let enc_c2s = choose(&client.enc_c2s, &server.enc_c2s, "cipher")?;
    let enc_s2c = choose(&client.enc_s2c, &server.enc_s2c, "cipher")?;
    for comp in [&client.comp_c2s, &client.comp_s2c, &server.comp_c2s, &server.comp_s2c] {
        if !comp.iter().any(|c| c == "none") {
            return Err(Error::Negotiation("compression is not supported".into()));
        }
    }
    // the guess is right when the sender's first choices are the negotiated ones
    let peer = if server_role { client } else { server };
    let ignore_guess = peer.first_kex_follows
        && (peer.kex.first() != Some(&kex) || peer.host_key.first() != Some(&host_key));
    Ok(Negotiated { kex, host_key, enc_c2s, enc_s2c, ignore_guess })
}

/// Our half of an ECDH exchange.
pub struct Ephemeral {
    private: EphemeralPrivateKey,
    pub public: Vec<u8>,
    hash: &'static digest::Algorithm,
}

fn agreement_alg(
    kex: &str,
) -> Result<(&'static agreement::Algorithm, &'static digest::Algorithm), Error> {
    match kex {
        CURVE25519 | CURVE25519_LIBSSH => Ok((&agreement::X25519, &digest::SHA256)),
        ECDH_P256 => Ok((&agreement::ECDH_P256, &digest::SHA256)),
        ECDH_P384 => Ok((&agreement::ECDH_P384, &digest::SHA384)),
        other => Err(Error::Negotiation(format!("unsupported key exchange {other}"))),
    }
}

impl Ephemeral {
    pub fn new(kex: &str) -> Result<Ephemeral, Error> {
        let (alg, hash) = agreement_alg(kex)?;
        let rng = SystemRandom::new();
        let private = EphemeralPrivateKey::generate(alg, &rng)
            .map_err(|_| Error::Protocol("key generation failed".into()))?;
        let public = private
            .compute_public_key()
            .map_err(|_| Error::Protocol("key generation failed".into()))?
            .as_ref()
            .to_vec();
        Ok(Ephemeral { private, public, hash })
    }

    /// The shared secret `K` (big-endian magnitude) with the peer's public value.
    pub fn agree(self, peer: &[u8]) -> Result<(Vec<u8>, &'static digest::Algorithm), Error> {
        let alg = self.private.algorithm();
        let hash = self.hash;
        agreement::agree_ephemeral(self.private, &UnparsedPublicKey::new(alg, peer), |k| k.to_vec())
            .map(|k| (k, hash))
            .map_err(|_| Error::Protocol("key agreement failed".into()))
    }
}

/// Inputs of the exchange hash `H`.
pub struct HashInput<'a> {
    pub v_c: &'a [u8],
    pub v_s: &'a [u8],
    pub i_c: &'a [u8],
    pub i_s: &'a [u8],
    pub k_s: &'a [u8],
    pub q_c: &'a [u8],
    pub q_s: &'a [u8],
    pub k: &'a [u8],
}

pub fn exchange_hash(alg: &'static digest::Algorithm, h: &HashInput<'_>) -> Vec<u8> {
    let mut w = Writer::new();
    w.string(h.v_c)
        .string(h.v_s)
        .string(h.i_c)
        .string(h.i_s)
        .string(h.k_s)
        .string(h.q_c)
        .string(h.q_s)
        .mpint(h.k);
    digest::digest(alg, &w.buf).as_ref().to_vec()
}

/// RFC 4253 section 7.2 key derivation: `len` bytes for `letter`.
pub fn derive(
    alg: &'static digest::Algorithm,
    k: &[u8],
    h: &[u8],
    letter: u8,
    session_id: &[u8],
    len: usize,
) -> Vec<u8> {
    let mut kw = Writer::new();
    kw.mpint(k);
    let k_enc = kw.finish();
    let mut ctx = digest::Context::new(alg);
    ctx.update(&k_enc);
    ctx.update(h);
    ctx.update(&[letter]);
    ctx.update(session_id);
    let mut out = ctx.finish().as_ref().to_vec();
    while out.len() < len {
        let mut ctx = digest::Context::new(alg);
        ctx.update(&k_enc);
        ctx.update(h);
        ctx.update(&out);
        out.extend_from_slice(ctx.finish().as_ref());
    }
    out.truncate(len);
    out
}

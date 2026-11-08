//! Private key files: OpenSSH (`openssh-key-v1`, optionally passphrase
//! protected with bcrypt + AES), PEM PKCS#1 RSA and SEC1 EC keys (optionally
//! with OpenSSL's legacy `Proc-Type: 4,ENCRYPTED` AES-CBC encryption) and
//! unencrypted PKCS#8 — the formats the node engine (ssh2) reads, plus PKCS#8.

use ring::aead;

use super::Error;
use super::crypto::{aes::Aes, blowfish::bcrypt_pbkdf, md5::md5};
use super::der::{self, Der, oid};
use super::keys::{Curve, PrivateKey, PublicKey};
use super::wire::{Reader, Writer};

const OPENSSH_MAGIC: &[u8] = b"openssh-key-v1\0";

fn err(msg: impl Into<String>) -> Error {
    Error::Key(msg.into())
}

struct Pem {
    label: String,
    headers: Vec<(String, String)>,
    der: Vec<u8>,
}

fn parse_pem(text: &str) -> Result<Pem, Error> {
    let text = text.trim();
    let mut lines = text.lines().map(str::trim);
    let first = lines.next().unwrap_or_default();
    let label = first
        .strip_prefix("-----BEGIN ")
        .and_then(|l| l.strip_suffix("-----"))
        .ok_or_else(|| err("not a PEM private key"))?
        .to_string();
    let end = format!("-----END {label}-----");
    let mut headers = Vec::new();
    let mut body = String::new();
    let mut in_headers = true;
    let mut ended = false;
    for line in lines {
        if line == end {
            ended = true;
            break;
        }
        if in_headers {
            if let Some((k, v)) = line.split_once(':') {
                headers.push((k.trim().to_string(), v.trim().to_string()));
                continue;
            }
            in_headers = false;
            if line.is_empty() {
                continue;
            }
        }
        body.push_str(line);
    }
    if !ended {
        return Err(err("PEM end marker missing"));
    }
    let der = crate::b64::decode(body.as_bytes()).map_err(|_| err("invalid base64 in key"))?;
    Ok(Pem { label, headers, der })
}

/// Decodes a private key file; `passphrase` decrypts protected keys.
pub fn decode_secret_key(text: &str, passphrase: Option<&str>) -> Result<PrivateKey, Error> {
    let pem = parse_pem(text)?;
    match pem.label.as_str() {
        "OPENSSH PRIVATE KEY" => decode_openssh(&pem.der, passphrase),
        "RSA PRIVATE KEY" | "EC PRIVATE KEY" => {
            let der = decrypt_legacy_pem(&pem, passphrase)?;
            if pem.label.starts_with("RSA") { decode_pkcs1(&der) } else { decode_sec1(&der, None) }
        }
        "PRIVATE KEY" => decode_pkcs8(&pem.der),
        "ENCRYPTED PRIVATE KEY" => Err(err("encrypted PKCS#8 keys are not supported")),
        other => Err(err(format!("unsupported key format {other:?}"))),
    }
}

fn decode_openssh(data: &[u8], passphrase: Option<&str>) -> Result<PrivateKey, Error> {
    let body = data.strip_prefix(OPENSSH_MAGIC).ok_or_else(|| err("bad openssh key magic"))?;
    let mut r = Reader::new(body);
    let cipher = r.utf8()?.to_string();
    let kdf = r.utf8()?.to_string();
    let kdf_options = r.string()?;
    let count = r.u32()?;
    if count != 1 {
        return Err(err("openssh key files with several keys are not supported"));
    }
    let public = PublicKey::from_blob(r.string()?)?;
    let encrypted = r.string()?;
    let mut private = encrypted.to_vec();
    if cipher != "none" {
        let Some(pass) = passphrase.filter(|p| !p.is_empty()) else {
            return Err(err("key is encrypted, a passphrase is required"));
        };
        if kdf != "bcrypt" {
            return Err(err(format!("unsupported key derivation {kdf}")));
        }
        let mut o = Reader::new(kdf_options);
        let salt = o.string()?;
        let rounds = o.u32()?;
        let (key_len, iv_len) = match cipher.as_str() {
            "aes128-ctr" | "aes128-cbc" => (16, 16),
            "aes192-ctr" | "aes192-cbc" => (24, 16),
            "aes256-ctr" | "aes256-cbc" => (32, 16),
            "aes128-gcm@openssh.com" => (16, 12),
            "aes256-gcm@openssh.com" => (32, 12),
            other => return Err(err(format!("unsupported key cipher {other}"))),
        };
        if rounds > 1 << 16 {
            return Err(err("too many bcrypt rounds"));
        }
        let mut km = vec![0u8; key_len + iv_len];
        bcrypt_pbkdf(pass.as_bytes(), salt, rounds, &mut km)
            .map_err(|_| err("invalid key derivation parameters"))?;
        let (key, iv) = km.split_at(key_len);
        if cipher.ends_with("-gcm@openssh.com") {
            // the tag follows the encrypted string
            let tag = r.bytes(16)?;
            let alg = if key_len == 16 { &aead::AES_128_GCM } else { &aead::AES_256_GCM };
            let k = aead::LessSafeKey::new(
                aead::UnboundKey::new(alg, key).map_err(|_| err("bad key"))?,
            );
            let nonce = aead::Nonce::try_assume_unique_for_key(iv).map_err(|_| err("bad iv"))?;
            private.extend_from_slice(tag);
            let len = k
                .open_in_place(nonce, aead::Aad::empty(), &mut private)
                .map_err(|_| err("wrong passphrase"))?
                .len();
            private.truncate(len);
        } else {
            let aes = Aes::new(key).ok_or_else(|| err("bad key"))?;
            let iv: [u8; 16] = iv.try_into().map_err(|_| err("bad iv"))?;
            if cipher.ends_with("-ctr") {
                aes.ctr_apply(&iv, &mut private);
            } else {
                aes.cbc_decrypt(&iv, &mut private).ok_or_else(|| err("bad key length"))?;
            }
        }
    }
    let mut p = Reader::new(&private);
    let (c1, c2) = (p.u32()?, p.u32()?);
    if c1 != c2 {
        return Err(err(if cipher == "none" { "corrupt private key" } else { "wrong passphrase" }));
    }
    let kind = p.string()?;
    let key = match kind {
        b"ssh-ed25519" => {
            let pk = p.string()?;
            let both = p.string()?;
            if both.len() != 64 {
                return Err(err("bad ed25519 private key"));
            }
            PrivateKey::ed25519(&both[..32], pk)?
        }
        b"ecdsa-sha2-nistp256" | b"ecdsa-sha2-nistp384" => {
            let curve = match p.string()? {
                b"nistp256" => Curve::P256,
                b"nistp384" => Curve::P384,
                _ => return Err(err("unsupported ecdsa curve")),
            };
            let point = p.string()?;
            let scalar = p.mpint()?;
            PrivateKey::ecdsa(curve, scalar, point)?
        }
        b"ssh-rsa" => {
            let n = p.mpint()?;
            let e = p.mpint()?;
            let d = p.mpint()?;
            let iqmp = p.mpint()?;
            let pp = p.mpint()?;
            let q = p.mpint()?;
            PrivateKey::rsa(n, e, d, pp, q, iqmp)?
        }
        other => {
            return Err(err(format!("unsupported key type {:?}", String::from_utf8_lossy(other))));
        }
    };
    let comment = p.text().unwrap_or_default();
    if key.public_key() != &public {
        return Err(err("private key does not match its public key"));
    }
    Ok(key.with_comment(comment))
}

/// OpenSSL's `EVP_BytesToKey` with MD5 and one iteration.
fn evp_bytes_to_key(pass: &[u8], salt: &[u8], len: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut prev: Vec<u8> = Vec::new();
    while out.len() < len {
        let mut input = prev.clone();
        input.extend_from_slice(pass);
        input.extend_from_slice(salt);
        prev = md5(&input).to_vec();
        out.extend_from_slice(&prev);
    }
    out.truncate(len);
    out
}

fn decrypt_legacy_pem(pem: &Pem, passphrase: Option<&str>) -> Result<Vec<u8>, Error> {
    let header = |name: &str| pem.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    if !header("Proc-Type").is_some_and(|v| v.contains("ENCRYPTED")) {
        return Ok(pem.der.clone());
    }
    let Some(pass) = passphrase.filter(|p| !p.is_empty()) else {
        return Err(err("key is encrypted, a passphrase is required"));
    };
    let dek = header("DEK-Info").ok_or_else(|| err("DEK-Info missing"))?;
    let (alg, iv_hex) = dek.split_once(',').ok_or_else(|| err("bad DEK-Info"))?;
    let key_len = match alg.trim().to_ascii_uppercase().as_str() {
        "AES-128-CBC" => 16,
        "AES-192-CBC" => 24,
        "AES-256-CBC" => 32,
        other => return Err(err(format!("unsupported PEM cipher {other}"))),
    };
    let iv_hex = iv_hex.trim();
    if iv_hex.len() != 32 {
        return Err(err("bad DEK-Info iv"));
    }
    let mut iv = [0u8; 16];
    for (i, b) in iv.iter_mut().enumerate() {
        *b = u8::from_str_radix(iv_hex.get(2 * i..2 * i + 2).unwrap_or("zz"), 16)
            .map_err(|_| err("bad DEK-Info iv"))?;
    }
    let key = evp_bytes_to_key(pass.as_bytes(), &iv[..8], key_len);
    let aes = Aes::new(&key).ok_or_else(|| err("bad key"))?;
    let mut data = pem.der.clone();
    aes.cbc_decrypt(&iv, &mut data).ok_or_else(|| err("bad encrypted key length"))?;
    let pad = *data.last().ok_or_else(|| err("wrong passphrase"))? as usize;
    if pad == 0
        || pad > 16
        || pad > data.len()
        || !data[data.len() - pad..].iter().all(|&b| b as usize == pad)
    {
        return Err(err("wrong passphrase"));
    }
    data.truncate(data.len() - pad);
    Ok(data)
}

fn decode_pkcs1(der: &[u8]) -> Result<PrivateKey, Error> {
    let bad = || err("invalid PKCS#1 RSA key");
    let mut seq = Der::new(der).sequence().ok_or_else(bad)?;
    let _version = seq.uint().ok_or_else(bad)?;
    let n = seq.uint().ok_or_else(bad)?;
    let e = seq.uint().ok_or_else(bad)?;
    let d = seq.uint().ok_or_else(bad)?;
    let p = seq.uint().ok_or_else(bad)?;
    let q = seq.uint().ok_or_else(bad)?;
    let _dp = seq.uint().ok_or_else(bad)?;
    let _dq = seq.uint().ok_or_else(bad)?;
    let iqmp = seq.uint().ok_or_else(bad)?;
    PrivateKey::rsa(n, e, d, p, q, iqmp)
}

/// SEC1 `ECPrivateKey`; `curve` comes from PKCS#8 when the key omits it.
fn decode_sec1(der: &[u8], curve: Option<Curve>) -> Result<PrivateKey, Error> {
    let bad = || err("invalid EC private key");
    let mut seq = Der::new(der).sequence().ok_or_else(bad)?;
    let _version = seq.uint().ok_or_else(bad)?;
    let scalar = seq.expect(der::OCTET_STRING).ok_or_else(bad)?;
    let mut curve = curve;
    let mut point = None;
    while !seq.is_empty() {
        let (tag, contents) = seq.any().ok_or_else(bad)?;
        match tag {
            0xa0 => {
                // a named curve; explicit parameters (LibreSSL) are inferred below
                if let Some(id) = Der::new(contents).expect(der::OID) {
                    curve = Some(curve_from_oid(id)?);
                }
            }
            0xa1 => {
                let bits = Der::new(contents).expect(der::BIT_STRING).ok_or_else(bad)?;
                point = Some(bits.get(1..).ok_or_else(bad)?);
            }
            _ => {}
        }
    }
    let point = point.ok_or_else(|| err("EC keys without a public key are not supported"))?;
    // explicit curve parameters: the point size names the curve, and ring
    // checks that the scalar and point belong together on it
    let curve = match (curve, point.len()) {
        (Some(c), _) => c,
        (None, 65) => Curve::P256,
        (None, 97) => Curve::P384,
        _ => return Err(err("unsupported EC curve")),
    };
    PrivateKey::ecdsa(curve, scalar, point)
}

fn curve_from_oid(id: &[u8]) -> Result<Curve, Error> {
    match id {
        oid::P256 => Ok(Curve::P256),
        oid::P384 => Ok(Curve::P384),
        _ => Err(err("unsupported EC curve")),
    }
}

fn decode_pkcs8(der: &[u8]) -> Result<PrivateKey, Error> {
    let bad = || err("invalid PKCS#8 key");
    let mut seq = Der::new(der).sequence().ok_or_else(bad)?;
    let _version = seq.uint().ok_or_else(bad)?;
    let mut alg = seq.sequence().ok_or_else(bad)?;
    let alg_oid = alg.expect(der::OID).ok_or_else(bad)?;
    let key = seq.expect(der::OCTET_STRING).ok_or_else(bad)?;
    match alg_oid {
        oid::RSA => decode_pkcs1(key),
        oid::EC_PUBLIC_KEY => {
            let curve = match alg.optional(der::OID) {
                Some(id) => Some(curve_from_oid(id)?),
                None => None,
            };
            decode_sec1(key, curve)
        }
        oid::ED25519 => {
            let seed = Der::new(key).expect(der::OCTET_STRING).ok_or_else(bad)?;
            let seed: [u8; 32] = seed.try_into().map_err(|_| bad())?;
            Ok(PrivateKey::from_ed25519_seed(&seed))
        }
        _ => Err(err("unsupported PKCS#8 key algorithm")),
    }
}

impl PrivateKey {
    /// Unencrypted OpenSSH private key file (`ssh-keygen` format).
    pub fn to_openssh(&self) -> String {
        let mut private = Writer::new();
        let check = 0x5eed_c0deu32;
        private.u32(check).u32(check);
        self.write_private_fields(&mut private);
        private.string(self.comment());
        let mut pad = 1u8;
        while !private.buf.len().is_multiple_of(8) {
            private.u8(pad);
            pad += 1;
        }
        let mut w = Writer::new();
        w.raw(OPENSSH_MAGIC)
            .string("none")
            .string("none")
            .string("")
            .u32(1)
            .string(self.public_key().to_blob())
            .string(private.finish());
        let b64 = crate::b64::encode(w.finish());
        let mut out = String::from("-----BEGIN OPENSSH PRIVATE KEY-----\n");
        for chunk in b64.as_bytes().chunks(70) {
            out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
            out.push('\n');
        }
        out.push_str("-----END OPENSSH PRIVATE KEY-----\n");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openssh_roundtrip_ed25519() {
        let key = PrivateKey::from_ed25519_seed(&[3; 32]);
        let text = key.to_openssh();
        let back = decode_secret_key(&text, None).unwrap();
        assert_eq!(back.public_key(), key.public_key());
        let sig = back.sign("ssh-ed25519", b"data").unwrap();
        key.public_key().verify("ssh-ed25519", b"data", &sig).unwrap();
    }

    #[test]
    fn garbage_is_rejected() {
        for text in [
            "",
            "not a key",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
        ] {
            assert!(decode_secret_key(text, None).is_err());
        }
    }
}

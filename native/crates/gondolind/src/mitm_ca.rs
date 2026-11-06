//! The MITM certificate authority, generated and cached by the daemon when
//! the controller does not provide one (remote sessions).
//!
//! Compatible with `host/src/mitm.ts` both ways: `ca.key` (PKCS#1 RSA PEM) and
//! `ca.crt` in `<cache>/gondolin/ssl` (or a given directory); RSA 2048, CN
//! `gondolin-mitm-ca`, positive 16-byte serial, 10 years validity backdated by
//! 5 minutes, critical basic constraints and key usage (keyCertSign, cRLSign),
//! SHA-1 subject/authority key identifiers (RFC 5280 method 1), so the node
//! engine accepts a CA the daemon created and vice versa.

use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, KeyIdMethod, KeyPair,
    KeyUsagePurpose, PKCS_RSA_SHA256, PublicKeyData, SerialNumber,
};
use ring::rand::SecureRandom;
use rsa::pkcs1::{DecodeRsaPrivateKey, EncodeRsaPrivateKey};
use rsa::pkcs8::EncodePrivateKey;

const RSA_KEY_BITS: usize = 2048;
const CA_VALIDITY: Duration = Duration::from_secs(3650 * 24 * 60 * 60);
const NOT_BEFORE_SKEW: Duration = Duration::from_secs(5 * 60);

/// The CA as PEM.
#[derive(Debug, Clone)]
pub struct MitmCaPem {
    /// `ca.crt`
    pub cert_pem: String,
    /// `ca.key` (PKCS#1 RSA)
    pub key_pem: String,
}

/// `getDefaultMitmCertDir`: `<cache>/gondolin/ssl`.
pub fn default_dir() -> PathBuf {
    gondolin_assets::store::gondolin_cache_dir().join("ssl")
}

/// `loadOrCreateMitmCa`: loads a valid persisted CA or creates (and persists)
/// a new one. Blocking (RSA key generation); run it off the async runtime.
pub fn load_or_create(dir: &Path) -> Result<MitmCaPem, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let key_path = dir.join("ca.key");
    let cert_path = dir.join("ca.crt");
    if let (Ok(key_pem), Ok(cert_pem)) =
        (std::fs::read_to_string(&key_path), std::fs::read_to_string(&cert_path))
        && validate(&key_pem, &cert_pem).is_ok()
    {
        return Ok(MitmCaPem { cert_pem, key_pem });
    }
    let ca = generate()?;
    write_atomic(&key_path, ca.key_pem.as_bytes(), 0o600)?;
    write_atomic(&cert_path, ca.cert_pem.as_bytes(), 0o644)?;
    Ok(ca)
}

fn write_atomic(path: &Path, data: &[u8], mode: u32) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let res = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    res.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot write {}: {e}", path.display())
    })
}

/// `ring`'s system RNG for the `rsa` crate.
struct SystemRng(ring::rand::SystemRandom);

impl rand_core::TryRng for SystemRng {
    type Error = Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Infallible> {
        let mut b = [0u8; 4];
        self.try_fill_bytes(&mut b)?;
        Ok(u32::from_le_bytes(b))
    }

    fn try_next_u64(&mut self) -> Result<u64, Infallible> {
        let mut b = [0u8; 8];
        self.try_fill_bytes(&mut b)?;
        Ok(u64::from_le_bytes(b))
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Infallible> {
        self.0.fill(dst).expect("system random number generator failed");
        Ok(())
    }
}

impl rand_core::TryCryptoRng for SystemRng {}

/// SHA-1 over the subjectPublicKey bits of a SubjectPublicKeyInfo
/// (`computeKeyIdentifier`).
fn key_identifier(spki_der: &[u8]) -> Result<Vec<u8>, String> {
    let bits = spki_public_key_bits(spki_der).ok_or("invalid subject public key info")?;
    Ok(ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, bits).as_ref().to_vec())
}

/// Minimal DER walk: SEQUENCE { algorithm SEQUENCE, subjectPublicKey BIT STRING }.
fn spki_public_key_bits(der: &[u8]) -> Option<&[u8]> {
    fn header(d: &[u8]) -> Option<(u8, usize, usize)> {
        let tag = *d.first()?;
        let first = *d.get(1)? as usize;
        if first < 0x80 {
            return Some((tag, 2, first));
        }
        let n = first & 0x7f;
        if n == 0 || n > 4 {
            return None;
        }
        let mut len = 0usize;
        for i in 0..n {
            len = (len << 8) | *d.get(2 + i)? as usize;
        }
        Some((tag, 2 + n, len))
    }
    let (tag, hl, len) = header(der)?;
    if tag != 0x30 {
        return None;
    }
    let body = der.get(hl..hl + len)?;
    let (_, ahl, alen) = header(body)?;
    let rest = body.get(ahl + alen..)?;
    let (btag, bhl, blen) = header(rest)?;
    if btag != 0x03 {
        return None;
    }
    // skip the unused-bits octet
    rest.get(bhl + 1..bhl + blen)
}

fn rcgen_key(key_pem: &str) -> Result<(KeyPair, Vec<u8>), String> {
    let key =
        rsa::RsaPrivateKey::from_pkcs1_pem(key_pem).map_err(|e| format!("invalid ca key: {e}"))?;
    let pkcs8 = key.to_pkcs8_der().map_err(|e| format!("cannot encode ca key: {e}"))?;
    let der = rustls_pki_types::PrivatePkcs8KeyDer::from(pkcs8.as_bytes().to_vec());
    let kp = KeyPair::from_pkcs8_der_and_sign_algo(&der, &PKCS_RSA_SHA256)
        .map_err(|e| format!("invalid ca key: {e}"))?;
    let ski = key_identifier(&kp.subject_public_key_info())?;
    Ok((kp, ski))
}

/// Generates a new CA.
pub fn generate() -> Result<MitmCaPem, String> {
    let mut rng = SystemRng(ring::rand::SystemRandom::new());
    let key = rsa::RsaPrivateKey::new(&mut rng, RSA_KEY_BITS)
        .map_err(|e| format!("rsa key generation failed: {e}"))?;
    let key_pem = key
        .to_pkcs1_pem(rsa::pkcs8::LineEnding::LF)
        .map_err(|e| format!("cannot encode ca key: {e}"))?
        .to_string();
    let (kp, ski) = rcgen_key(&key_pem)?;

    let mut serial = [0u8; 16];
    rng.0.fill(&mut serial).map_err(|_| "random number generator failed")?;
    // positive and minimally encoded
    serial[0] &= 0x7f;
    if serial[0] == 0 {
        serial[0] = 1;
    }

    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "gondolin-mitm-ca");
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    params.serial_number = Some(SerialNumber::from_slice(&serial));
    let not_before = time::OffsetDateTime::now_utc() - NOT_BEFORE_SKEW;
    params.not_before = not_before;
    params.not_after = not_before + CA_VALIDITY;
    params.key_identifier_method = KeyIdMethod::PreSpecified(ski);
    params.use_authority_key_identifier_extension = true;
    let cert = params.self_signed(&kp).map_err(|e| format!("cannot create ca certificate: {e}"))?;
    Ok(MitmCaPem { cert_pem: cert.pem(), key_pem })
}

/// Checks a persisted CA: the key parses and matches the certificate, which
/// has a positive serial and the key identifiers derived from its key.
pub fn validate(key_pem: &str, cert_pem: &str) -> Result<(), String> {
    let (kp, ski) = rcgen_key(key_pem)?;
    let der = pem_der(cert_pem).ok_or("invalid ca certificate pem")?;
    let spki = kp.subject_public_key_info();
    let find = |needle: &[u8]| der.windows(needle.len()).any(|w| w == needle);
    if !find(&spki) {
        return Err("persisted mitm ca key does not match cert".into());
    }
    // SKI (OCTET STRING of the id) and AKI keyIdentifier ([0] of the id)
    let mut ski_der = vec![0x04, ski.len() as u8];
    ski_der.extend_from_slice(&ski);
    let mut aki_der = vec![0x80, ski.len() as u8];
    aki_der.extend_from_slice(&ski);
    if !find(&ski_der) || !find(&aki_der) {
        return Err("persisted mitm ca cert is missing required key identifiers".into());
    }
    serial_is_positive(&der)
        .then_some(())
        .ok_or_else(|| "persisted mitm ca cert has an unsafe serial number".into())
}

fn pem_der(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem
        .lines()
        .skip_while(|l| !l.starts_with("-----BEGIN CERTIFICATE-----"))
        .skip(1)
        .take_while(|l| !l.starts_with("-----END"))
        .collect();
    base64_decode(body.trim())
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b'\r' | b'\n' | b' ' => continue,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Certificate ::= SEQUENCE { tbs SEQUENCE { [0] version?, serial INTEGER, ... } }
fn serial_is_positive(der: &[u8]) -> bool {
    fn skip_header(d: &[u8]) -> Option<(u8, usize, usize)> {
        let tag = *d.first()?;
        let first = *d.get(1)? as usize;
        if first < 0x80 {
            return Some((tag, 2, first));
        }
        let n = first & 0x7f;
        let mut len = 0usize;
        for i in 0..n {
            len = (len << 8) | *d.get(2 + i)? as usize;
        }
        Some((tag, 2 + n, len))
    }
    (|| {
        let (_, hl, _) = skip_header(der)?;
        let tbs = der.get(hl..)?;
        let (_, thl, _) = skip_header(tbs)?;
        let mut rest = tbs.get(thl..)?;
        let (tag, h, l) = skip_header(rest)?;
        if tag == 0xa0 {
            rest = rest.get(h + l..)?;
        }
        let (tag, h, l) = skip_header(rest)?;
        let serial = rest.get(h..h + l)?;
        Some(tag == 0x02 && !serial.is_empty() && serial[0] & 0x80 == 0)
    })()
    .unwrap_or(false)
}

/// Controller request `mitm_ca { dir? }` → `mitm_ca_result { cert_pem, dir }`:
/// loads or creates the daemon-side CA (the key never leaves the daemon), so a
/// remote controller can install the certificate in the guest.
pub struct MitmCaHandler;

/// Request type of [`MitmCaHandler`].
pub const MITM_CA: &str = "mitm_ca";

#[async_trait::async_trait]
impl crate::controller::ControllerHandler for MitmCaHandler {
    async fn handle(
        &self,
        msg: gondolin_wire::RawEnvelope,
        ctl: &std::sync::Arc<crate::controller::Controller>,
    ) {
        let dir = crate::fields::Fields::of(&msg.p)
            .text("dir")
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_dir);
        let ctl = ctl.clone();
        tokio::spawn(async move {
            let shown = dir.display().to_string();
            let res = tokio::task::spawn_blocking(move || load_or_create(&dir))
                .await
                .unwrap_or_else(|e| Err(e.to_string()));
            match res {
                Ok(ca) => ctl.reply_ok(
                    MITM_CA,
                    msg.id,
                    vec![
                        (
                            gondolin_wire::Value::Text("cert_pem".into()),
                            gondolin_wire::Value::Text(ca.cert_pem),
                        ),
                        (
                            gondolin_wire::Value::Text("dir".into()),
                            gondolin_wire::Value::Text(shown),
                        ),
                    ],
                ),
                Err(err) => ctl.reply_err(MITM_CA, msg.id, "mitm_ca_failed", &err),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_persist_and_reload() {
        let dir = std::env::temp_dir().join(format!("gondolind-ca-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = load_or_create(&dir).unwrap();
        assert!(a.key_pem.starts_with("-----BEGIN RSA PRIVATE KEY-----"));
        validate(&a.key_pem, &a.cert_pem).unwrap();
        let b = load_or_create(&dir).unwrap();
        assert_eq!(a.cert_pem, b.cert_pem);
        // a broken cert is replaced
        std::fs::write(dir.join("ca.crt"), "garbage").unwrap();
        let c = load_or_create(&dir).unwrap();
        assert_ne!(c.cert_pem, a.cert_pem);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

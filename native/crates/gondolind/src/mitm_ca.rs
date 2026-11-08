//! The MITM certificate authority, generated and cached by the daemon when
//! the controller does not provide one (remote sessions).
//!
//! Compatible with `host/src/mitm.ts` both ways: `ca.key` and `ca.crt` in
//! `<cache>/gondolin/ssl` (or a given directory); CN `gondolin-mitm-ca`,
//! positive 16-byte serial, 10 years validity backdated by 5 minutes, critical
//! basic constraints and key usage (keyCertSign, cRLSign), SHA-1
//! subject/authority key identifiers (RFC 5280 method 1).
//!
//! Keys: the daemon creates ECDSA P-256 CAs (PKCS#8 `PRIVATE KEY`; ring can
//! sign with RSA but not generate RSA keys) and loads existing ones of either
//! kind: RSA 2048 CAs created by the node engine (PKCS#1 `RSA PRIVATE KEY`) or
//! older daemons, and ECDSA ones. The node engine signs leaves with both
//! (`createCertificate` supports RSA and ECDSA issuers) and keeps creating RSA
//! CAs itself.

use std::path::{Path, PathBuf};

use gondolin_egress::x509::{self, SigningKey};
use ring::rand::SecureRandom;

/// CA validity in `s` (10 years)
const CA_VALIDITY_SECS: i64 = 3650 * 24 * 60 * 60;
/// notBefore backdating in `s`
const NOT_BEFORE_SKEW_SECS: i64 = 5 * 60;

/// The CA as PEM.
#[derive(Debug, Clone)]
pub struct MitmCaPem {
    /// `ca.crt`
    pub cert_pem: String,
    /// `ca.key` (PKCS#8 ECDSA for CAs created here; PKCS#1 RSA from the node engine)
    pub key_pem: String,
}

/// `getDefaultMitmCertDir`: `<cache>/gondolin/ssl`.
pub fn default_dir() -> PathBuf {
    gondolin_assets::store::gondolin_cache_dir().join("ssl")
}

/// `loadOrCreateMitmCa`: loads a valid persisted CA or creates (and persists)
/// a new one. Blocking (file I/O, key generation); run it off the async runtime.
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

/// Loads a CA key (PKCS#1 RSA, or PKCS#8 RSA/ECDSA) and its key identifier.
fn load_key(key_pem: &str) -> Result<(SigningKey, Vec<u8>), String> {
    let key = SigningKey::from_pem(key_pem).map_err(|e| format!("invalid ca key: {e}"))?;
    let ski = x509::key_identifier(&key.spki()).map_err(|e| e.to_string())?;
    Ok((key, ski))
}

/// Generates a new CA (ECDSA P-256): CN `gondolin-mitm-ca`, critical basic
/// constraints (CA) and key usage (keyCertSign, cRLSign), SHA-1 subject and
/// authority key identifiers.
pub fn generate() -> Result<MitmCaPem, String> {
    let (key, pkcs8) = SigningKey::generate_p256().map_err(|e| e.to_string())?;
    let spki = key.spki();
    let ski = x509::key_identifier(&spki).map_err(|e| e.to_string())?;

    let mut serial = [0u8; 16];
    ring::rand::SystemRandom::new()
        .fill(&mut serial)
        .map_err(|_| "random number generator failed")?;
    // positive and minimally encoded
    serial[0] &= 0x7f;
    if serial[0] == 0 {
        serial[0] = 1;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();
    let not_before = now - NOT_BEFORE_SKEW_SECS;
    let name = x509::common_name("gondolin-mitm-ca");
    let der = x509::issue(
        &x509::CertificateParams {
            serial: &serial,
            not_before,
            not_after: not_before + CA_VALIDITY_SECS,
            issuer: &name,
            subject: &name,
            spki: &spki,
            extensions: &[
                x509::basic_constraints(true, true),
                x509::key_usage(&[5, 6], true),
                x509::subject_key_identifier(&ski),
                x509::authority_key_identifier(&ski),
            ],
        },
        &key,
    )
    .map_err(|e| format!("cannot create ca certificate: {e}"))?;
    Ok(MitmCaPem {
        cert_pem: x509::pem("CERTIFICATE", &der),
        key_pem: x509::pem("PRIVATE KEY", &pkcs8),
    })
}

/// Checks a persisted CA: the key parses and matches the certificate, which
/// has a positive serial and the key identifiers derived from its key.
pub fn validate(key_pem: &str, cert_pem: &str) -> Result<(), String> {
    let (_, ski) = load_key(key_pem)?;
    let der = pem_der(cert_pem).ok_or("invalid ca certificate pem")?;
    let info = x509::parse_certificate(&der).map_err(|e| e.to_string())?;
    if x509::key_identifier(&info.spki).ok().as_ref() != Some(&ski) {
        return Err("persisted mitm ca key does not match cert".into());
    }
    let find = |needle: &[u8]| der.windows(needle.len()).any(|w| w == needle);
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

impl crate::controller::ControllerHandler for MitmCaHandler {
    fn handle<'a>(
        &'a self,
        msg: gondolin_wire::RawEnvelope,
        ctl: &'a std::sync::Arc<crate::controller::Controller>,
    ) -> crate::BoxFuture<'a, ()> {
        Box::pin(async move {
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
        })
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn generate_persist_and_reload() {
        let dir = std::env::temp_dir().join(format!("gondolind-ca-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = load_or_create(&dir).unwrap();
        assert!(a.key_pem.starts_with("-----BEGIN PRIVATE KEY-----"));
        validate(&a.key_pem, &a.cert_pem).unwrap();
        let b = load_or_create(&dir).unwrap();
        assert_eq!(a.cert_pem, b.cert_pem);
        // a broken cert is replaced
        std::fs::write(dir.join("ca.crt"), "garbage").unwrap();
        let c = load_or_create(&dir).unwrap();
        assert_ne!(c.cert_pem, a.cert_pem);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn node_rsa_ca_is_loaded_and_signs_leaves() {
        // created by host/src/mitm.ts (RSA 2048, PKCS#1 key)
        let cert = include_str!("../../gondolin-egress/tests/fixtures/node-ca.crt");
        let key = include_str!("../../gondolin-egress/tests/fixtures/node-ca.key");
        assert!(key.starts_with("-----BEGIN RSA PRIVATE KEY-----"));
        validate(key, cert).unwrap();
        let dir = std::env::temp_dir().join(format!("gondolind-ca-rsa-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ca.crt"), cert).unwrap();
        std::fs::write(dir.join("ca.key"), key).unwrap();
        // kept, not regenerated
        assert_eq!(load_or_create(&dir).unwrap().cert_pem, cert);
        let authority =
            gondolin_egress::MitmAuthority::from_pem(cert, key, 4, Duration::from_secs(60))
                .unwrap();
        authority.generate_leaf("example.com").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ecdsa_ca_signs_leaves() {
        let ca = generate().unwrap();
        let authority = gondolin_egress::MitmAuthority::from_pem(
            &ca.cert_pem,
            &ca.key_pem,
            4,
            Duration::from_secs(60),
        )
        .unwrap();
        authority.server_config("example.com").unwrap();
    }

    #[test]
    fn openssl_verifies_ca_and_leaves() {
        let Ok(out) = std::process::Command::new("openssl").arg("version").output() else {
            return;
        };
        if !out.status.success() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("gondolind-ca-openssl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let node_cert = include_str!("../../gondolin-egress/tests/fixtures/node-ca.crt");
        let node_key = include_str!("../../gondolin-egress/tests/fixtures/node-ca.key");
        let ours = generate().unwrap();
        for (i, (cert, key)) in
            [(ours.cert_pem.as_str(), ours.key_pem.as_str()), (node_cert, node_key)]
                .iter()
                .enumerate()
        {
            let authority =
                gondolin_egress::MitmAuthority::from_pem(cert, key, 4, Duration::from_secs(60))
                    .unwrap();
            for name in ["example.com", "192.0.2.1", "::1"] {
                let (leaf, _) = authority.generate_leaf(name).unwrap();
                let ca_path = dir.join(format!("ca{i}.pem"));
                let leaf_path = dir.join(format!("leaf{i}.pem"));
                std::fs::write(&ca_path, cert).unwrap();
                std::fs::write(&leaf_path, gondolin_egress::x509::pem("CERTIFICATE", &leaf))
                    .unwrap();
                let out = std::process::Command::new("openssl")
                    .args(["verify", "-x509_strict", "-purpose", "sslserver", "-CAfile"])
                    .arg(&ca_path)
                    .arg(&leaf_path)
                    .output()
                    .unwrap();
                assert!(
                    out.status.success(),
                    "{name}: {}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

//! TLS MITM: per-host leaf certificates signed by the controller's CA
//! (compatible with the CA cached by `host/src/mitm.ts`), cached as ready
//! rustls server configs.

use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use lru::LruCache;
use rcgen::{
    CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, SanType, SerialNumber,
};
use ring::rand::SecureRandom;
use rustls::ServerConfig;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

/// Leaf validity in days (`LEAF_VALIDITY_DAYS`)
const LEAF_VALIDITY_DAYS: i64 = 825;
/// notBefore backdating for clock skew
const NOT_BEFORE_SKEW: time::Duration = time::Duration::minutes(5);

#[derive(Debug, thiserror::Error)]
pub enum MitmError {
    #[error("invalid mitm ca certificate: {0}")]
    Cert(String),
    #[error("invalid mitm ca key: {0}")]
    Key(String),
    #[error("leaf certificate generation failed: {0}")]
    Leaf(String),
    #[error("tls config: {0}")]
    Tls(#[from] rustls::Error),
}

/// Signs leaf certificates and caches server configs per server name.
pub struct MitmAuthority {
    issuer: Issuer<'static, KeyPair>,
    ca_der: CertificateDer<'static>,
    cache: Mutex<LruCache<String, (Arc<ServerConfig>, Instant)>>,
    max_entries: usize,
    ttl: Duration,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl std::fmt::Debug for MitmAuthority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MitmAuthority").finish_non_exhaustive()
    }
}

impl MitmAuthority {
    /// Loads the CA from PEM. Keys may be PKCS#1 RSA (as written by
    /// `host/src/mitm.ts`), PKCS#8 RSA, ECDSA or Ed25519.
    pub fn from_pem(
        cert_pem: &str,
        key_pem: &str,
        max_entries: usize,
        ttl: Duration,
    ) -> Result<Self, MitmError> {
        let ca_der = CertificateDer::from_pem_slice(cert_pem.as_bytes())
            .map_err(|e| MitmError::Cert(e.to_string()))?;
        let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes())
            .map_err(|e| MitmError::Key(e.to_string()))?;
        let pkcs8: Vec<u8> = match &key {
            PrivateKeyDer::Pkcs8(k) => k.secret_pkcs8_der().to_vec(),
            PrivateKeyDer::Pkcs1(k) => pkcs1_to_pkcs8(k.secret_pkcs1_der()),
            _ => return Err(MitmError::Key("unsupported key format (SEC1)".into())),
        };
        let key_pair =
            KeyPair::try_from(pkcs8.as_slice()).map_err(|e| MitmError::Key(e.to_string()))?;
        let issuer = Issuer::from_ca_cert_der(&ca_der, key_pair)
            .map_err(|e| MitmError::Cert(e.to_string()))?;
        Ok(Self {
            issuer,
            ca_der,
            cache: Mutex::new(LruCache::unbounded()),
            max_entries,
            ttl,
            provider: Arc::new(rustls::crypto::ring::default_provider()),
        })
    }

    /// CA certificate (DER).
    pub fn ca_der(&self) -> &CertificateDer<'static> {
        &self.ca_der
    }

    /// Server config presenting a leaf for `servername` (trimmed; `unknown` when empty).
    pub fn server_config(&self, servername: &str) -> Result<Arc<ServerConfig>, MitmError> {
        let name = match servername.trim() {
            "" => "unknown".to_string(),
            n => n.to_string(),
        };
        let caching = self.max_entries > 0 && !self.ttl.is_zero();
        if caching {
            let mut cache = self.cache.lock().unwrap();
            let now = Instant::now();
            if let Some((config, at)) = cache.get_mut(&name) {
                if now.duration_since(*at) <= self.ttl {
                    *at = now;
                    return Ok(config.clone());
                }
                cache.pop(&name);
            }
        }
        let config = Arc::new(self.build_config(&name)?);
        if caching {
            let mut cache = self.cache.lock().unwrap();
            let now = Instant::now();
            cache.put(name, (config.clone(), now));
            // prune expired, then enforce the size bound (LRU)
            while let Some((_, (_, at))) = cache.peek_lru() {
                if now.duration_since(*at) > self.ttl {
                    cache.pop_lru();
                } else {
                    break;
                }
            }
            while cache.len() > self.max_entries {
                cache.pop_lru();
            }
        }
        Ok(config)
    }

    /// Number of cached server configs.
    pub fn cached_entries(&self) -> usize {
        self.cache.lock().unwrap().len()
    }

    fn build_config(&self, name: &str) -> Result<ServerConfig, MitmError> {
        let (leaf_der, key_der) = self.generate_leaf(name)?;
        let mut config = ServerConfig::builder_with_provider(self.provider.clone())
            .with_safe_default_protocol_versions()?
            .with_no_client_auth()
            .with_single_cert(
                vec![leaf_der, self.ca_der.clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der)),
            )?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(config)
    }

    /// Generates an ECDSA P-256 leaf for `name` (DER cert, PKCS#8 key).
    pub fn generate_leaf(
        &self,
        name: &str,
    ) -> Result<(CertificateDer<'static>, Vec<u8>), MitmError> {
        let leaf_err = |e: rcgen::Error| MitmError::Leaf(e.to_string());
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(leaf_err)?;
        let mut params = CertificateParams::default();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, name.replace(['\r', '\n'], ""));
        params.distinguished_name = dn;
        params.subject_alt_names = vec![match name.parse::<IpAddr>() {
            Ok(ip) => SanType::IpAddress(ip),
            Err(_) => SanType::DnsName(
                name.to_string()
                    .try_into()
                    .map_err(|e: rcgen::Error| MitmError::Leaf(e.to_string()))?,
            ),
        }];
        let not_before = time::OffsetDateTime::now_utc() - NOT_BEFORE_SKEW;
        params.not_before = not_before;
        params.not_after = not_before + time::Duration::days(LEAF_VALIDITY_DAYS);
        params.serial_number = Some(positive_serial());
        params.is_ca = IsCa::ExplicitNoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.use_authority_key_identifier_extension = true;
        let cert = params.signed_by(&key, &self.issuer).map_err(leaf_err)?;
        Ok((cert.der().clone(), key.serialize_der()))
    }
}

/// Random positive 16-byte serial (`generatePositiveSerialNumber`).
fn positive_serial() -> SerialNumber {
    let mut bytes = [0u8; 16];
    ring::rand::SystemRandom::new().fill(&mut bytes).expect("system rng");
    bytes[0] &= 0x7f;
    if bytes[0] == 0 {
        bytes[0] = 1;
    }
    SerialNumber::from_slice(&bytes)
}

fn der_len(len: usize, out: &mut Vec<u8>) {
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let bytes = (len as u64).to_be_bytes();
        let skip = bytes.iter().take_while(|b| **b == 0).count();
        out.push(0x80 | (8 - skip) as u8);
        out.extend_from_slice(&bytes[skip..]);
    }
}

fn der_tlv(tag: u8, content: &[u8], out: &mut Vec<u8>) {
    out.push(tag);
    der_len(content.len(), out);
    out.extend_from_slice(content);
}

/// Wraps a PKCS#1 RSAPrivateKey into PKCS#8 PrivateKeyInfo.
fn pkcs1_to_pkcs8(pkcs1: &[u8]) -> Vec<u8> {
    const RSA_ALG: [u8; 15] =
        [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
    let mut content = vec![0x02, 0x01, 0x00];
    content.extend_from_slice(&RSA_ALG);
    der_tlv(0x04, pkcs1, &mut content);
    let mut out = Vec::with_capacity(content.len() + 8);
    der_tlv(0x30, &content, &mut out);
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use rustls::client::danger::ServerCertVerifier;

    /// A CA like the one `host/src/mitm.ts` creates, generated with rcgen.
    pub fn test_ca() -> (String, String) {
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let mut params = CertificateParams::default();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "gondolin-mitm-ca");
        params.distinguished_name = dn;
        params.is_ca = IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let cert = params.self_signed(&key).unwrap();
        (cert.pem(), key.serialize_pem())
    }

    #[test]
    fn issues_verifiable_leaf() {
        let (cert, key) = test_ca();
        let ca = MitmAuthority::from_pem(&cert, &key, 4, Duration::from_secs(60)).unwrap();
        let (leaf, _) = ca.generate_leaf("example.com").unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(ca.ca_der().clone()).unwrap();
        let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(
            Arc::new(roots),
            Arc::new(rustls::crypto::ring::default_provider()),
        )
        .build()
        .unwrap();
        verifier
            .verify_server_cert(
                &leaf,
                &[],
                &rustls_pki_types::ServerName::try_from("example.com").unwrap(),
                &[],
                rustls_pki_types::UnixTime::now(),
            )
            .unwrap();
    }

    #[test]
    fn cache_is_lru_bounded() {
        let (cert, key) = test_ca();
        let ca = MitmAuthority::from_pem(&cert, &key, 2, Duration::from_secs(60)).unwrap();
        let a = ca.server_config("a.example").unwrap();
        ca.server_config("b.example").unwrap();
        assert!(Arc::ptr_eq(&a, &ca.server_config("a.example").unwrap()));
        ca.server_config("c.example").unwrap();
        assert_eq!(ca.cached_entries(), 2);
        // b was least recently used
        assert!(Arc::ptr_eq(&a, &ca.server_config("a.example").unwrap()));

        let no_cache = MitmAuthority::from_pem(&cert, &key, 2, Duration::ZERO).unwrap();
        no_cache.server_config("a.example").unwrap();
        assert_eq!(no_cache.cached_entries(), 0);
    }

    #[test]
    fn ip_leaf() {
        let (cert, key) = test_ca();
        let ca = MitmAuthority::from_pem(&cert, &key, 2, Duration::from_secs(60)).unwrap();
        ca.generate_leaf("192.0.2.1").unwrap();
    }
}

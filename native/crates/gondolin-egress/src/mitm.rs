//! TLS MITM: per-host leaf certificates signed by the controller's CA
//! (compatible with the CA cached by `host/src/mitm.ts`), cached as ready
//! rustls server configs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ring::rand::SecureRandom;
use rustls::ServerConfig;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

use crate::x509::{self, SigningKey};

/// Leaf validity in days (`LEAF_VALIDITY_DAYS`)
const LEAF_VALIDITY_DAYS: i64 = 825;
/// notBefore backdating for clock skew in `s`
const NOT_BEFORE_SKEW_SECS: i64 = 5 * 60;

#[derive(Debug)]
pub enum MitmError {
    Cert(String),
    Key(String),
    Leaf(String),
    Tls(rustls::Error),
}

impl From<rustls::Error> for MitmError {
    fn from(e: rustls::Error) -> Self {
        MitmError::Tls(e)
    }
}

impl std::fmt::Display for MitmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MitmError::Cert(e) => write!(f, "invalid mitm ca certificate: {e}"),
            MitmError::Key(e) => write!(f, "invalid mitm ca key: {e}"),
            MitmError::Leaf(e) => write!(f, "leaf certificate generation failed: {e}"),
            MitmError::Tls(e) => write!(f, "tls config: {e}"),
        }
    }
}

impl std::error::Error for MitmError {}

/// Signs leaf certificates and caches server configs per server name.
pub struct MitmAuthority {
    signer: SigningKey,
    /// CA subject Name (DER), the leaves' issuer
    issuer_name: Vec<u8>,
    /// CA key identifier (leaves' authority key identifier)
    ca_key_id: Vec<u8>,
    ca_der: CertificateDer<'static>,
    /// server name → config and last use (the least recently used is evicted)
    cache: Mutex<HashMap<String, (Arc<ServerConfig>, Instant)>>,
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
        let signer = SigningKey::from_pem(key_pem).map_err(|e| MitmError::Key(e.to_string()))?;
        let info = x509::parse_certificate(&ca_der).map_err(|e| MitmError::Cert(e.to_string()))?;
        if x509::key_identifier(&signer.spki()).ok() != x509::key_identifier(&info.spki).ok() {
            return Err(MitmError::Key("ca key does not match the ca certificate".into()));
        }
        let ca_key_id = match info.key_identifier {
            Some(id) => id,
            None => x509::key_identifier(&info.spki).map_err(|e| MitmError::Cert(e.to_string()))?,
        };
        Ok(Self {
            signer,
            issuer_name: info.subject,
            ca_key_id,
            ca_der,
            cache: Mutex::new(HashMap::new()),
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
                cache.remove(&name);
            }
        }
        let config = Arc::new(self.build_config(&name)?);
        if caching {
            let mut cache = self.cache.lock().unwrap();
            let now = Instant::now();
            cache.insert(name, (config.clone(), now));
            // prune expired, then enforce the size bound (LRU)
            cache.retain(|_, (_, at)| now.duration_since(*at) <= self.ttl);
            while cache.len() > self.max_entries {
                let oldest = cache.iter().min_by_key(|(_, (_, at))| *at).map(|(k, _)| k.clone());
                match oldest {
                    Some(k) => cache.remove(&k),
                    None => break,
                };
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
        let leaf_err = |e: x509::X509Error| MitmError::Leaf(e.to_string());
        let (key, pkcs8) = SigningKey::generate_p256().map_err(leaf_err)?;
        let spki = key.spki();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default();
        let not_before = now - NOT_BEFORE_SKEW_SECS;
        let extensions = vec![
            x509::basic_constraints(false, true),
            x509::key_usage(&[0], true),
            x509::ext_key_usage_server_auth(),
            x509::subject_alt_name(name).map_err(leaf_err)?,
            x509::subject_key_identifier(&x509::key_identifier(&spki).map_err(leaf_err)?),
            x509::authority_key_identifier(&self.ca_key_id),
        ];
        let der = x509::issue(
            &x509::CertificateParams {
                serial: &positive_serial(),
                not_before,
                not_after: not_before + LEAF_VALIDITY_DAYS * 86_400,
                issuer: &self.issuer_name,
                subject: &x509::common_name(&name.replace(['\r', '\n'], "")),
                spki: &spki,
                extensions: &extensions,
            },
            &self.signer,
        )
        .map_err(leaf_err)?;
        Ok((CertificateDer::from(der), pkcs8))
    }
}

/// Random positive 16-byte serial (`generatePositiveSerialNumber`).
fn positive_serial() -> [u8; 16] {
    let mut bytes = [0u8; 16];
    ring::rand::SystemRandom::new().fill(&mut bytes).expect("system rng");
    bytes[0] &= 0x7f;
    if bytes[0] == 0 {
        bytes[0] = 1;
    }
    bytes
}

/// Wraps a PKCS#1 RSAPrivateKey into PKCS#8 PrivateKeyInfo.
pub fn pkcs1_to_pkcs8(pkcs1: &[u8]) -> Vec<u8> {
    const RSA_ALG: [u8; 15] =
        [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
    let mut content = vec![0x02, 0x01, 0x00];
    content.extend_from_slice(&RSA_ALG);
    content.extend_from_slice(&x509::tlv(0x04, pkcs1));
    x509::tlv(0x30, &content)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use rcgen::{CertificateParams, DistinguishedName, DnType, IsCa, KeyPair, KeyUsagePurpose};
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

//! Minimal X.509 over ring: DER writing for the certificates gondolind
//! issues (MITM leaves, its own MITM CA), signing keys (RSA PKCS#1 v1.5,
//! ECDSA P-256, Ed25519) and just enough DER reading to take the subject,
//! public key and key identifier from a CA certificate. Mirrors
//! `host/src/x509.ts` (same extensions, SHA-1 key identifiers, UTCTime
//! through 2049).

use ring::rand::SystemRandom;
use ring::signature::{self, EcdsaKeyPair, Ed25519KeyPair, KeyPair, RsaKeyPair};

/// `rsaEncryption`
const OID_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
/// `sha256WithRSAEncryption`
const OID_SHA256_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
/// `id-ecPublicKey`
const OID_EC_PUBLIC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
/// `prime256v1`
const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
/// `ecdsa-with-SHA256`
const OID_ECDSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
/// `id-Ed25519`
const OID_ED25519: &[u8] = &[0x2b, 0x65, 0x70];
const OID_COMMON_NAME: &[u8] = &[0x55, 0x04, 0x03];
const OID_SUBJECT_KEY_ID: &[u8] = &[0x55, 0x1d, 0x0e];
const OID_KEY_USAGE: &[u8] = &[0x55, 0x1d, 0x0f];
const OID_SUBJECT_ALT_NAME: &[u8] = &[0x55, 0x1d, 0x11];
const OID_BASIC_CONSTRAINTS: &[u8] = &[0x55, 0x1d, 0x13];
const OID_AUTHORITY_KEY_ID: &[u8] = &[0x55, 0x1d, 0x23];
const OID_EXT_KEY_USAGE: &[u8] = &[0x55, 0x1d, 0x25];
/// `id-kp-serverAuth`
const OID_SERVER_AUTH: &[u8] = &[0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01];

const TAG_BOOLEAN: u8 = 0x01;
const TAG_INTEGER: u8 = 0x02;
const TAG_BIT_STRING: u8 = 0x03;
const TAG_OCTET_STRING: u8 = 0x04;
const TAG_NULL: u8 = 0x05;
const TAG_OID: u8 = 0x06;
const TAG_UTF8_STRING: u8 = 0x0c;
const TAG_UTC_TIME: u8 = 0x17;
const TAG_GENERALIZED_TIME: u8 = 0x18;
const TAG_SEQUENCE: u8 = 0x30;
const TAG_SET: u8 = 0x31;

/// Errors of this module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum X509Error {
    Key(String),
    Cert(&'static str),
    Sign,
}

impl std::fmt::Display for X509Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            X509Error::Key(e) => write!(f, "invalid key: {e}"),
            X509Error::Cert(e) => write!(f, "invalid certificate: {e}"),
            X509Error::Sign => f.write_str("signing failed"),
        }
    }
}

impl std::error::Error for X509Error {}

/// DER TLV.
pub fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len() + 6);
    out.push(tag);
    let len = content.len();
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let bytes = (len as u64).to_be_bytes();
        let skip = bytes.iter().take_while(|b| **b == 0).count();
        out.push(0x80 | (8 - skip) as u8);
        out.extend_from_slice(&bytes[skip..]);
    }
    out.extend_from_slice(content);
    out
}

fn seq(parts: &[&[u8]]) -> Vec<u8> {
    tlv(TAG_SEQUENCE, &parts.concat())
}

fn oid(der: &[u8]) -> Vec<u8> {
    tlv(TAG_OID, der)
}

/// A signing key with its public key info.
pub enum SigningKey {
    Rsa(RsaKeyPair),
    Ecdsa(EcdsaKeyPair),
    Ed25519(Ed25519KeyPair),
}

impl std::fmt::Debug for SigningKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            SigningKey::Rsa(_) => "SigningKey::Rsa",
            SigningKey::Ecdsa(_) => "SigningKey::Ecdsa",
            SigningKey::Ed25519(_) => "SigningKey::Ed25519",
        })
    }
}

impl SigningKey {
    /// From PKCS#8 (RSA, ECDSA P-256 or Ed25519).
    pub fn from_pkcs8(der: &[u8]) -> Result<Self, X509Error> {
        let rng = SystemRandom::new();
        if let Ok(k) =
            EcdsaKeyPair::from_pkcs8(&signature::ECDSA_P256_SHA256_ASN1_SIGNING, der, &rng)
        {
            return Ok(SigningKey::Ecdsa(k));
        }
        if let Ok(k) = RsaKeyPair::from_pkcs8(der) {
            return Ok(SigningKey::Rsa(k));
        }
        if let Ok(k) = Ed25519KeyPair::from_pkcs8_maybe_unchecked(der) {
            return Ok(SigningKey::Ed25519(k));
        }
        Err(X509Error::Key("unsupported key (RSA, ECDSA P-256 or Ed25519 PKCS#8)".into()))
    }

    /// From PEM: PKCS#1 `RSA PRIVATE KEY` or PKCS#8 `PRIVATE KEY`.
    pub fn from_pem(pem: &str) -> Result<Self, X509Error> {
        use rustls_pki_types::PrivateKeyDer;
        use rustls_pki_types::pem::PemObject;
        let key = PrivateKeyDer::from_pem_slice(pem.as_bytes())
            .map_err(|e| X509Error::Key(e.to_string()))?;
        match &key {
            PrivateKeyDer::Pkcs8(k) => Self::from_pkcs8(k.secret_pkcs8_der()),
            PrivateKeyDer::Pkcs1(k) => RsaKeyPair::from_der(k.secret_pkcs1_der())
                .map(SigningKey::Rsa)
                .map_err(|e| X509Error::Key(e.to_string())),
            _ => Err(X509Error::Key("unsupported key format (SEC1)".into())),
        }
    }

    /// Generates an ECDSA P-256 key; returns it and its PKCS#8 DER.
    pub fn generate_p256() -> Result<(Self, Vec<u8>), X509Error> {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&signature::ECDSA_P256_SHA256_ASN1_SIGNING, &rng)
            .map_err(|_| X509Error::Key("key generation failed".into()))?;
        let der = pkcs8.as_ref().to_vec();
        Ok((Self::from_pkcs8(&der)?, der))
    }

    /// SubjectPublicKeyInfo (DER).
    pub fn spki(&self) -> Vec<u8> {
        let (alg, key) = match self {
            SigningKey::Rsa(k) => {
                (seq(&[&oid(OID_RSA), &tlv(TAG_NULL, &[])]), k.public().as_ref().to_vec())
            }
            SigningKey::Ecdsa(k) => {
                (seq(&[&oid(OID_EC_PUBLIC_KEY), &oid(OID_P256)]), k.public_key().as_ref().to_vec())
            }
            SigningKey::Ed25519(k) => (seq(&[&oid(OID_ED25519)]), k.public_key().as_ref().to_vec()),
        };
        seq(&[&alg, &bit_string(&key)])
    }

    /// The signature AlgorithmIdentifier (DER).
    pub fn signature_algorithm(&self) -> Vec<u8> {
        match self {
            SigningKey::Rsa(_) => seq(&[&oid(OID_SHA256_RSA), &tlv(TAG_NULL, &[])]),
            SigningKey::Ecdsa(_) => seq(&[&oid(OID_ECDSA_SHA256)]),
            SigningKey::Ed25519(_) => seq(&[&oid(OID_ED25519)]),
        }
    }

    pub fn sign(&self, message: &[u8]) -> Result<Vec<u8>, X509Error> {
        let rng = SystemRandom::new();
        match self {
            SigningKey::Rsa(k) => {
                let mut sig = vec![0u8; k.public().modulus_len()];
                k.sign(&signature::RSA_PKCS1_SHA256, &rng, message, &mut sig)
                    .map_err(|_| X509Error::Sign)?;
                Ok(sig)
            }
            SigningKey::Ecdsa(k) => {
                k.sign(&rng, message).map(|s| s.as_ref().to_vec()).map_err(|_| X509Error::Sign)
            }
            SigningKey::Ed25519(k) => Ok(k.sign(message).as_ref().to_vec()),
        }
    }
}

fn bit_string(bytes: &[u8]) -> Vec<u8> {
    let mut content = Vec::with_capacity(bytes.len() + 1);
    content.push(0);
    content.extend_from_slice(bytes);
    tlv(TAG_BIT_STRING, &content)
}

/// RFC 5280 method 1 key identifier: SHA-1 of the subjectPublicKey bits.
pub fn key_identifier(spki: &[u8]) -> Result<Vec<u8>, X509Error> {
    let (outer, _) = read(spki).ok_or(X509Error::Cert("invalid subject public key info"))?;
    let children = children(outer.content).ok_or(X509Error::Cert("invalid public key info"))?;
    match children.get(1) {
        Some(bits) if bits.tag == TAG_BIT_STRING && !bits.content.is_empty() => {
            Ok(ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, &bits.content[1..])
                .as_ref()
                .to_vec())
        }
        _ => Err(X509Error::Cert("invalid subject public key info")),
    }
}

/// A Name with a single CN (UTF8String).
pub fn common_name(cn: &str) -> Vec<u8> {
    seq(&[&tlv(TAG_SET, &seq(&[&oid(OID_COMMON_NAME), &tlv(TAG_UTF8_STRING, cn.as_bytes())]))])
}

/// A certificate extension.
pub fn extension(oid_der: &[u8], critical: bool, value: &[u8]) -> Vec<u8> {
    let crit = if critical { tlv(TAG_BOOLEAN, &[0xff]) } else { Vec::new() };
    seq(&[&oid(oid_der), &crit, &tlv(TAG_OCTET_STRING, value)])
}

/// basicConstraints (`cA` only when true, no path length).
pub fn basic_constraints(ca: bool, critical: bool) -> Vec<u8> {
    let value = if ca { seq(&[&tlv(TAG_BOOLEAN, &[0xff])]) } else { seq(&[]) };
    extension(OID_BASIC_CONSTRAINTS, critical, &value)
}

/// keyUsage bits (RFC 5280 numbering: 0 digitalSignature, 5 keyCertSign, 6 cRLSign).
pub fn key_usage(bits: &[u8], critical: bool) -> Vec<u8> {
    let highest = bits.iter().copied().max().unwrap_or(0);
    let mut bytes = vec![0u8; usize::from(highest / 8) + 1];
    for b in bits {
        bytes[usize::from(b >> 3)] |= 0x80 >> (b & 7);
    }
    let mut content = vec![7 - highest % 8];
    content.extend_from_slice(&bytes);
    extension(OID_KEY_USAGE, critical, &tlv(TAG_BIT_STRING, &content))
}

/// extKeyUsage serverAuth.
pub fn ext_key_usage_server_auth() -> Vec<u8> {
    extension(OID_EXT_KEY_USAGE, false, &seq(&[&oid(OID_SERVER_AUTH)]))
}

/// subjectAltName with one dNSName or iPAddress.
pub fn subject_alt_name(name: &str) -> Result<Vec<u8>, X509Error> {
    let general = match name.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => tlv(0x87, &ip.octets()),
        Ok(std::net::IpAddr::V6(ip)) => tlv(0x87, &ip.octets()),
        Err(_) if name.is_ascii() && !name.is_empty() => tlv(0x82, name.as_bytes()),
        Err(_) => return Err(X509Error::Cert("subject alt name is not an ascii dns name")),
    };
    Ok(extension(OID_SUBJECT_ALT_NAME, false, &seq(&[&general])))
}

pub fn subject_key_identifier(id: &[u8]) -> Vec<u8> {
    extension(OID_SUBJECT_KEY_ID, false, &tlv(TAG_OCTET_STRING, id))
}

pub fn authority_key_identifier(id: &[u8]) -> Vec<u8> {
    extension(OID_AUTHORITY_KEY_ID, false, &seq(&[&tlv(0x80, id)]))
}

/// RFC 5280 time: UTCTime through 2049, GeneralizedTime afterwards.
pub fn encode_time(unix_secs: i64) -> Vec<u8> {
    let days = unix_secs.div_euclid(86_400);
    let secs = unix_secs.rem_euclid(86_400);
    // civil from days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let rest =
        format!("{month:02}{day:02}{:02}{:02}{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60);
    if (1950..2050).contains(&year) {
        tlv(TAG_UTC_TIME, format!("{:02}{rest}", year % 100).as_bytes())
    } else {
        tlv(TAG_GENERALIZED_TIME, format!("{year:04}{rest}").as_bytes())
    }
}

/// Fields of a certificate to issue.
pub struct CertificateParams<'a> {
    /// positive serial, minimally encoded (no leading zero bytes)
    pub serial: &'a [u8],
    /// validity in unix `s`
    pub not_before: i64,
    pub not_after: i64,
    /// issuer Name (DER)
    pub issuer: &'a [u8],
    /// subject Name (DER)
    pub subject: &'a [u8],
    /// subject public key info (DER)
    pub spki: &'a [u8],
    /// encoded extensions
    pub extensions: &'a [Vec<u8>],
}

/// Builds and signs an X.509 v3 certificate.
pub fn issue(params: &CertificateParams<'_>, signer: &SigningKey) -> Result<Vec<u8>, X509Error> {
    let alg = signer.signature_algorithm();
    let mut serial = params.serial.to_vec();
    if serial.first().is_none_or(|b| b & 0x80 != 0) {
        serial.insert(0, 0);
    }
    let ext_refs: Vec<&[u8]> = params.extensions.iter().map(Vec::as_slice).collect();
    let extensions = if ext_refs.is_empty() { Vec::new() } else { tlv(0xa3, &seq(&ext_refs)) };
    let tbs = seq(&[
        &tlv(0xa0, &tlv(TAG_INTEGER, &[2])),
        &tlv(TAG_INTEGER, &serial),
        &alg,
        params.issuer,
        &seq(&[&encode_time(params.not_before), &encode_time(params.not_after)]),
        params.subject,
        params.spki,
        &extensions,
    ]);
    let signature = signer.sign(&tbs)?;
    Ok(seq(&[&tbs, &alg, &bit_string(&signature)]))
}

/// PEM armor.
pub fn pem(label: &str, der: &[u8]) -> String {
    let b64 = gondolin_wire::base64::encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).expect("base64 is ascii"));
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

/// A DER element.
#[derive(Debug, Clone, Copy)]
pub struct Der<'a> {
    pub tag: u8,
    pub content: &'a [u8],
    /// the whole element (header and content)
    pub raw: &'a [u8],
}

/// Reads one DER element; returns it and the rest.
pub fn read(input: &[u8]) -> Option<(Der<'_>, &[u8])> {
    let tag = *input.first()?;
    if tag & 0x1f == 0x1f {
        return None;
    }
    let first = *input.get(1)?;
    let (len, header) = if first < 0x80 {
        (usize::from(first), 2)
    } else {
        let n = usize::from(first & 0x7f);
        if n == 0 || n > 4 {
            return None;
        }
        let mut len = 0usize;
        for i in 0..n {
            len = (len << 8) | usize::from(*input.get(2 + i)?);
        }
        (len, 2 + n)
    };
    let end = header.checked_add(len)?;
    let raw = input.get(..end)?;
    Some((Der { tag, content: &raw[header..], raw }, &input[end..]))
}

/// The elements of a constructed value.
pub fn children(mut content: &[u8]) -> Option<Vec<Der<'_>>> {
    let mut out = Vec::new();
    while !content.is_empty() {
        let (el, rest) = read(content)?;
        out.push(el);
        content = rest;
    }
    Some(out)
}

/// What issuing needs from a CA certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaInfo {
    /// subject Name (DER), the issuer of leaves
    pub subject: Vec<u8>,
    /// subject public key info (DER)
    pub spki: Vec<u8>,
    /// subjectKeyIdentifier extension value, when present
    pub key_identifier: Option<Vec<u8>>,
    /// serial INTEGER content
    pub serial: Vec<u8>,
}

/// Parses the parts of a certificate needed to issue leaves under it.
pub fn parse_certificate(der: &[u8]) -> Result<CaInfo, X509Error> {
    let bad = X509Error::Cert("malformed certificate");
    let (cert, _) = read(der).ok_or(bad.clone())?;
    let parts = children(cert.content).ok_or(bad.clone())?;
    let tbs = parts.first().filter(|t| t.tag == TAG_SEQUENCE).ok_or(bad.clone())?;
    let mut fields = children(tbs.content).ok_or(bad.clone())?.into_iter().peekable();
    if fields.peek().is_some_and(|f| f.tag == 0xa0) {
        fields.next();
    }
    let serial = fields.next().filter(|f| f.tag == TAG_INTEGER).ok_or(bad.clone())?;
    let _signature = fields.next().ok_or(bad.clone())?;
    let _issuer = fields.next().ok_or(bad.clone())?;
    let _validity = fields.next().ok_or(bad.clone())?;
    let subject = fields.next().filter(|f| f.tag == TAG_SEQUENCE).ok_or(bad.clone())?;
    let spki = fields.next().filter(|f| f.tag == TAG_SEQUENCE).ok_or(bad.clone())?;
    let mut key_identifier = None;
    for field in fields {
        if field.tag != 0xa3 {
            continue;
        }
        let (exts, _) = read(field.content).ok_or(bad.clone())?;
        for ext in children(exts.content).ok_or(bad.clone())? {
            let items = children(ext.content).ok_or(bad.clone())?;
            let (Some(id), Some(value)) = (items.first(), items.last()) else {
                return Err(bad);
            };
            if id.tag == TAG_OID
                && id.content == OID_SUBJECT_KEY_ID
                && value.tag == TAG_OCTET_STRING
            {
                let (inner, _) = read(value.content).ok_or(bad.clone())?;
                if inner.tag == TAG_OCTET_STRING {
                    key_identifier = Some(inner.content.to_vec());
                }
            }
        }
    }
    Ok(CaInfo {
        subject: subject.raw.to_vec(),
        spki: spki.raw.to_vec(),
        key_identifier,
        serial: serial.content.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times() {
        assert_eq!(encode_time(0), tlv(TAG_UTC_TIME, b"700101000000Z"));
        assert_eq!(encode_time(951_782_400), tlv(TAG_UTC_TIME, b"000229000000Z"));
        assert_eq!(encode_time(2_524_608_000), tlv(TAG_GENERALIZED_TIME, b"20500101000000Z"));
        assert_eq!(encode_time(1_700_000_000), tlv(TAG_UTC_TIME, b"231114221320Z"));
    }

    #[test]
    fn key_usage_bits() {
        // keyCertSign + cRLSign: 03 02 01 06
        let ext = key_usage(&[5, 6], true);
        assert!(ext.ends_with(&[0x04, 0x04, 0x03, 0x02, 0x01, 0x06]));
        // digitalSignature: 03 02 07 80
        assert!(key_usage(&[0], false).ends_with(&[0x03, 0x02, 0x07, 0x80]));
    }

    #[test]
    fn self_signed_round_trip() {
        let (key, _) = SigningKey::generate_p256().unwrap();
        let spki = key.spki();
        let ski = key_identifier(&spki).unwrap();
        let name = common_name("test-ca");
        let der = issue(
            &CertificateParams {
                serial: &[0x01, 0x02],
                not_before: 1_700_000_000,
                not_after: 1_800_000_000,
                issuer: &name,
                subject: &name,
                spki: &spki,
                extensions: &[basic_constraints(true, true), subject_key_identifier(&ski)],
            },
            &key,
        )
        .unwrap();
        let info = parse_certificate(&der).unwrap();
        assert_eq!(info.subject, name);
        assert_eq!(info.spki, spki);
        assert_eq!(info.key_identifier, Some(ski));
        assert_eq!(info.serial, vec![1, 2]);
    }
}

//! Public and private keys: SSH wire encoding, signing and verification
//! (ssh-ed25519, ecdsa-sha2-nistp256/384, RSA with rsa-sha2-256/512).

use std::fmt;
use std::sync::Arc;

use ring::rand::SystemRandom;
use ring::signature::{self, EcdsaKeyPair, Ed25519KeyPair, KeyPair, RsaKeyPair};

use super::Error;
use super::wire::{Reader, Writer};

pub const ED25519: &str = "ssh-ed25519";
pub const ECDSA_P256: &str = "ecdsa-sha2-nistp256";
pub const ECDSA_P384: &str = "ecdsa-sha2-nistp384";
pub const SSH_RSA: &str = "ssh-rsa";
pub const RSA_SHA256: &str = "rsa-sha2-256";
pub const RSA_SHA512: &str = "rsa-sha2-512";

fn key_err(msg: impl Into<String>) -> Error {
    Error::Key(msg.into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Curve {
    P256,
    P384,
}

impl Curve {
    pub fn key_type(self) -> &'static str {
        match self {
            Curve::P256 => ECDSA_P256,
            Curve::P384 => ECDSA_P384,
        }
    }

    pub fn ssh_name(self) -> &'static str {
        match self {
            Curve::P256 => "nistp256",
            Curve::P384 => "nistp384",
        }
    }

    fn from_ssh_name(name: &[u8]) -> Option<Curve> {
        match name {
            b"nistp256" => Some(Curve::P256),
            b"nistp384" => Some(Curve::P384),
            _ => None,
        }
    }

    /// Scalar size in `bytes`.
    fn size(self) -> usize {
        match self {
            Curve::P256 => 32,
            Curve::P384 => 48,
        }
    }

    fn signing(self) -> &'static signature::EcdsaSigningAlgorithm {
        match self {
            Curve::P256 => &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            Curve::P384 => &signature::ECDSA_P384_SHA384_FIXED_SIGNING,
        }
    }

    fn verifying(self) -> &'static signature::EcdsaVerificationAlgorithm {
        match self {
            Curve::P256 => &signature::ECDSA_P256_SHA256_FIXED,
            Curve::P384 => &signature::ECDSA_P384_SHA384_FIXED,
        }
    }
}

/// A public key.
#[derive(Clone, PartialEq, Eq)]
pub enum PublicKey {
    Ed25519([u8; 32]),
    /// uncompressed SEC1 point
    Ecdsa {
        curve: Curve,
        point: Vec<u8>,
    },
    /// exponent and modulus as unsigned big-endian magnitudes
    Rsa {
        e: Vec<u8>,
        n: Vec<u8>,
    },
}

impl fmt::Debug for PublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PublicKey({})", self.to_openssh())
    }
}

impl PublicKey {
    /// Decodes the SSH wire encoding (`ssh-ed25519`, `ecdsa-sha2-*`, `ssh-rsa`).
    pub fn from_blob(blob: &[u8]) -> Result<PublicKey, Error> {
        let mut r = Reader::new(blob);
        let key = Self::read_fields(r.string()?, &mut r)?;
        if !r.is_empty() {
            return Err(key_err("trailing bytes in public key"));
        }
        Ok(key)
    }

    /// Reads the type-specific public fields after the key type.
    fn read_fields(kind: &[u8], r: &mut Reader<'_>) -> Result<PublicKey, Error> {
        match kind {
            b"ssh-ed25519" => {
                let pk: [u8; 32] =
                    r.string()?.try_into().map_err(|_| key_err("bad ed25519 public key"))?;
                Ok(PublicKey::Ed25519(pk))
            }
            b"ecdsa-sha2-nistp256" | b"ecdsa-sha2-nistp384" => {
                let curve = Curve::from_ssh_name(r.string()?)
                    .ok_or_else(|| key_err("unsupported ecdsa curve"))?;
                if curve.key_type().as_bytes() != kind {
                    return Err(key_err("ecdsa curve does not match key type"));
                }
                let point = r.string()?;
                if point.len() != 1 + 2 * curve.size() || point[0] != 4 {
                    return Err(key_err("bad ecdsa public key"));
                }
                Ok(PublicKey::Ecdsa { curve, point: point.to_vec() })
            }
            b"ssh-rsa" => {
                let e = r.mpint()?.to_vec();
                let n = r.mpint()?.to_vec();
                if n.is_empty() || e.is_empty() {
                    return Err(key_err("bad rsa public key"));
                }
                Ok(PublicKey::Rsa { e, n })
            }
            other => {
                Err(key_err(format!("unsupported key type {:?}", String::from_utf8_lossy(other))))
            }
        }
    }

    pub fn key_type(&self) -> &'static str {
        match self {
            PublicKey::Ed25519(_) => ED25519,
            PublicKey::Ecdsa { curve, .. } => curve.key_type(),
            PublicKey::Rsa { .. } => SSH_RSA,
        }
    }

    fn write_fields(&self, w: &mut Writer) {
        match self {
            PublicKey::Ed25519(pk) => {
                w.string(pk);
            }
            PublicKey::Ecdsa { curve, point } => {
                w.string(curve.ssh_name()).string(point);
            }
            PublicKey::Rsa { e, n } => {
                w.mpint(e).mpint(n);
            }
        }
    }

    pub fn to_blob(&self) -> Vec<u8> {
        let mut w = Writer::new();
        w.string(self.key_type());
        self.write_fields(&mut w);
        w.finish()
    }

    /// `TYPE BASE64` (authorized_keys / known_hosts form, without comment).
    pub fn to_openssh(&self) -> String {
        format!("{} {}", self.key_type(), crate::b64::encode(self.to_blob()))
    }

    /// Parses `TYPE BASE64 [COMMENT]`.
    pub fn parse_openssh(line: &str) -> Result<PublicKey, Error> {
        let mut parts = line.split_whitespace();
        let kind = parts.next().ok_or_else(|| key_err("empty public key"))?;
        let data = parts.next().ok_or_else(|| key_err("missing key data"))?;
        let blob = crate::b64::decode(data).map_err(|_| key_err("invalid base64 in public key"))?;
        let key = PublicKey::from_blob(&blob)?;
        if key.key_type() != kind {
            return Err(key_err("public key type mismatch"));
        }
        Ok(key)
    }

    /// Signature algorithms this key can verify.
    pub fn signature_algorithms(&self) -> &'static [&'static str] {
        match self {
            PublicKey::Ed25519(_) => &[ED25519],
            PublicKey::Ecdsa { curve: Curve::P256, .. } => &[ECDSA_P256],
            PublicKey::Ecdsa { curve: Curve::P384, .. } => &[ECDSA_P384],
            PublicKey::Rsa { .. } => &[RSA_SHA512, RSA_SHA256, SSH_RSA],
        }
    }

    /// Verifies a signature blob (`string alg, string signature`) over `data`;
    /// `alg` is the algorithm the signature must use.
    pub fn verify(&self, alg: &str, data: &[u8], sig_blob: &[u8]) -> Result<(), Error> {
        let bad = || Error::Protocol("signature verification failed".into());
        let mut r = Reader::new(sig_blob);
        let sig_alg = r.utf8()?;
        let sig = r.string()?;
        if sig_alg != alg || !self.signature_algorithms().contains(&alg) {
            return Err(Error::Protocol(format!("unexpected signature algorithm {sig_alg}")));
        }
        match self {
            PublicKey::Ed25519(pk) => signature::UnparsedPublicKey::new(&signature::ED25519, pk)
                .verify(data, sig)
                .map_err(|_| bad()),
            PublicKey::Ecdsa { curve, point } => {
                let mut sr = Reader::new(sig);
                let (rr, ss) = (sr.mpint()?, sr.mpint()?);
                let size = curve.size();
                if rr.len() > size || ss.len() > size {
                    return Err(bad());
                }
                let mut fixed = vec![0u8; 2 * size];
                fixed[size - rr.len()..size].copy_from_slice(rr);
                fixed[2 * size - ss.len()..].copy_from_slice(ss);
                signature::UnparsedPublicKey::new(curve.verifying(), point)
                    .verify(data, &fixed)
                    .map_err(|_| bad())
            }
            PublicKey::Rsa { e, n } => {
                let components = signature::RsaPublicKeyComponents { n, e };
                let alg = match alg {
                    RSA_SHA512 => &signature::RSA_PKCS1_2048_8192_SHA512,
                    RSA_SHA256 => &signature::RSA_PKCS1_2048_8192_SHA256,
                    _ => &signature::RSA_PKCS1_2048_8192_SHA1_FOR_LEGACY_USE_ONLY,
                };
                components.verify(alg, data, sig).map_err(|_| bad())
            }
        }
    }
}

/// Private material, kept for re-encoding the key (OpenSSH format).
#[derive(Clone)]
enum Secret {
    Ed25519 { seed: [u8; 32] },
    Ecdsa { scalar: Vec<u8> },
    Rsa { d: Vec<u8>, iqmp: Vec<u8>, p: Vec<u8>, q: Vec<u8> },
}

enum Signer {
    Ed25519(Ed25519KeyPair),
    Ecdsa(EcdsaKeyPair),
    Rsa(RsaKeyPair),
}

struct PrivateInner {
    public: PublicKey,
    secret: Secret,
    signer: Signer,
    comment: String,
}

/// A private key that can sign.
#[derive(Clone)]
pub struct PrivateKey {
    inner: Arc<PrivateInner>,
}

impl fmt::Debug for PrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PrivateKey({})", self.inner.public.key_type())
    }
}

impl PrivateKey {
    pub fn from_ed25519_seed(seed: &[u8; 32]) -> PrivateKey {
        let kp = Ed25519KeyPair::from_seed_unchecked(seed).expect("32-byte seed");
        let pk: [u8; 32] = kp.public_key().as_ref().try_into().expect("32-byte public key");
        PrivateKey {
            inner: Arc::new(PrivateInner {
                public: PublicKey::Ed25519(pk),
                secret: Secret::Ed25519 { seed: *seed },
                signer: Signer::Ed25519(kp),
                comment: String::new(),
            }),
        }
    }

    /// A fresh random Ed25519 key.
    pub fn generate_ed25519() -> Result<PrivateKey, Error> {
        let mut seed = [0u8; 32];
        ring::rand::SecureRandom::fill(&SystemRandom::new(), &mut seed)
            .map_err(|_| key_err("random generator failed"))?;
        Ok(PrivateKey::from_ed25519_seed(&seed))
    }

    pub(crate) fn ed25519(seed: &[u8], public: &[u8]) -> Result<PrivateKey, Error> {
        let seed: [u8; 32] = seed.try_into().map_err(|_| key_err("bad ed25519 private key"))?;
        let key = PrivateKey::from_ed25519_seed(&seed);
        if key.public_key() != &PublicKey::Ed25519(public.try_into().unwrap_or([0; 32])) {
            return Err(key_err("ed25519 private and public key do not match"));
        }
        Ok(key)
    }

    pub(crate) fn ecdsa(curve: Curve, scalar: &[u8], point: &[u8]) -> Result<PrivateKey, Error> {
        let size = curve.size();
        if scalar.len() > size {
            return Err(key_err("bad ecdsa private key"));
        }
        let mut fixed = vec![0u8; size];
        fixed[size - scalar.len()..].copy_from_slice(scalar);
        let kp = EcdsaKeyPair::from_private_key_and_public_key(
            curve.signing(),
            &fixed,
            point,
            &SystemRandom::new(),
        )
        .map_err(|e| key_err(format!("invalid ecdsa key: {e}")))?;
        Ok(PrivateKey {
            inner: Arc::new(PrivateInner {
                public: PublicKey::Ecdsa { curve, point: point.to_vec() },
                secret: Secret::Ecdsa { scalar: fixed },
                signer: Signer::Ecdsa(kp),
                comment: String::new(),
            }),
        })
    }

    /// From the RSA components (unsigned big-endian magnitudes).
    pub(crate) fn rsa(
        n: &[u8],
        e: &[u8],
        d: &[u8],
        p: &[u8],
        q: &[u8],
        iqmp: &[u8],
    ) -> Result<PrivateKey, Error> {
        let dp = bignum::rem(d, &bignum::sub_one(p));
        let dq = bignum::rem(d, &bignum::sub_one(q));
        let components = ring::rsa::KeyPairComponents {
            public_key: ring::rsa::PublicKeyComponents { n, e },
            d,
            p,
            q,
            dP: dp.as_slice(),
            dQ: dq.as_slice(),
            qInv: iqmp,
        };
        let kp = RsaKeyPair::from_components(&components)
            .map_err(|e| key_err(format!("invalid rsa key: {e}")))?;
        Ok(PrivateKey {
            inner: Arc::new(PrivateInner {
                public: PublicKey::Rsa { e: e.to_vec(), n: n.to_vec() },
                secret: Secret::Rsa {
                    d: d.to_vec(),
                    iqmp: iqmp.to_vec(),
                    p: p.to_vec(),
                    q: q.to_vec(),
                },
                signer: Signer::Rsa(kp),
                comment: String::new(),
            }),
        })
    }

    pub(crate) fn with_comment(self, comment: String) -> PrivateKey {
        match Arc::try_unwrap(self.inner) {
            Ok(mut inner) => {
                inner.comment = comment;
                PrivateKey { inner: Arc::new(inner) }
            }
            Err(inner) => PrivateKey { inner },
        }
    }

    pub fn public_key(&self) -> &PublicKey {
        &self.inner.public
    }

    pub fn comment(&self) -> &str {
        &self.inner.comment
    }

    /// Signature algorithms this key can produce, preferred first.
    pub fn signature_algorithms(&self) -> &'static [&'static str] {
        match &self.inner.public {
            PublicKey::Rsa { .. } => &[RSA_SHA512, RSA_SHA256],
            other => other.signature_algorithms(),
        }
    }

    /// Signs `data`; returns the signature blob (`string alg, string sig`).
    pub fn sign(&self, alg: &str, data: &[u8]) -> Result<Vec<u8>, Error> {
        if !self.signature_algorithms().contains(&alg) {
            return Err(key_err(format!("key cannot sign with {alg}")));
        }
        let rng = SystemRandom::new();
        let fail = |_| key_err("signing failed");
        let mut w = Writer::new();
        w.string(alg);
        match &self.inner.signer {
            Signer::Ed25519(kp) => {
                w.string(kp.sign(data));
            }
            Signer::Ecdsa(kp) => {
                let sig = kp.sign(&rng, data).map_err(fail)?;
                let (r, s) = sig.as_ref().split_at(sig.as_ref().len() / 2);
                let mut inner = Writer::new();
                inner.mpint(r).mpint(s);
                w.string(inner.finish());
            }
            Signer::Rsa(kp) => {
                let padding: &'static dyn signature::RsaEncoding = match alg {
                    RSA_SHA512 => &signature::RSA_PKCS1_SHA512,
                    _ => &signature::RSA_PKCS1_SHA256,
                };
                let mut sig = vec![0u8; kp.public().modulus_len()];
                kp.sign(padding, &rng, data, &mut sig).map_err(fail)?;
                w.string(sig);
            }
        }
        Ok(w.finish())
    }

    /// The type-specific private fields of the OpenSSH key format.
    pub(crate) fn write_private_fields(&self, w: &mut Writer) {
        let public = &self.inner.public;
        w.string(public.key_type());
        match (&self.inner.secret, public) {
            (Secret::Ed25519 { seed }, PublicKey::Ed25519(pk)) => {
                let mut both = seed.to_vec();
                both.extend_from_slice(pk);
                w.string(pk).string(both);
            }
            (Secret::Ecdsa { scalar }, PublicKey::Ecdsa { curve, point }) => {
                w.string(curve.ssh_name()).string(point).mpint(scalar);
            }
            (Secret::Rsa { d, iqmp, p, q }, PublicKey::Rsa { e, n }) => {
                w.mpint(n).mpint(e).mpint(d).mpint(iqmp).mpint(p).mpint(q);
            }
            _ => unreachable!("secret matches public key"),
        }
    }
}

/// Unsigned big-endian arithmetic for deriving RSA CRT exponents at key load
/// (not constant time; runs once per configured key file).
mod bignum {
    fn to_limbs(x: &[u8]) -> Vec<u32> {
        // little-endian u32 limbs
        let mut out = Vec::with_capacity(x.len() / 4 + 1);
        let mut i = x.len();
        while i > 0 {
            let start = i.saturating_sub(4);
            let mut w = 0u32;
            for &b in &x[start..i] {
                w = (w << 8) | b as u32;
            }
            out.push(w);
            i = start;
        }
        out
    }

    fn from_limbs(l: &[u32]) -> Vec<u8> {
        let mut out: Vec<u8> = l.iter().rev().flat_map(|w| w.to_be_bytes()).collect();
        while let [0, ..] = out.as_slice() {
            out.remove(0);
        }
        out
    }

    fn cmp(a: &[u32], b: &[u32]) -> std::cmp::Ordering {
        let len = a.len().max(b.len());
        for i in (0..len).rev() {
            let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
            if x != y {
                return x.cmp(&y);
            }
        }
        std::cmp::Ordering::Equal
    }

    fn sub_in_place(a: &mut [u32], b: &[u32]) {
        let mut borrow = 0i64;
        for (i, x) in a.iter_mut().enumerate() {
            let v = *x as i64 - b.get(i).copied().unwrap_or(0) as i64 - borrow;
            if v < 0 {
                *x = (v + (1i64 << 32)) as u32;
                borrow = 1;
            } else {
                *x = v as u32;
                borrow = 0;
            }
        }
    }

    pub fn sub_one(x: &[u8]) -> Vec<u8> {
        let mut l = to_limbs(x);
        sub_in_place(&mut l, &[1]);
        from_limbs(&l)
    }

    /// `a mod m` by binary long division.
    pub fn rem(a: &[u8], m: &[u8]) -> Vec<u8> {
        let m = to_limbs(m);
        let a = to_limbs(a);
        let mut r: Vec<u32> = vec![0; m.len() + 1];
        for i in (0..a.len() * 32).rev() {
            // r = r << 1 | bit
            let mut carry = (a[i / 32] >> (i % 32)) & 1;
            for w in r.iter_mut() {
                let next = *w >> 31;
                *w = (*w << 1) | carry;
                carry = next;
            }
            if cmp(&r, &m) != std::cmp::Ordering::Less {
                sub_in_place(&mut r, &m);
            }
        }
        from_limbs(&r)
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn rem_and_sub() {
            assert_eq!(super::rem(&[0x01, 0x00, 0x00], &[0x07]), vec![(65536u32 % 7) as u8]);
            assert_eq!(super::sub_one(&[0x01, 0x00]), vec![0xff]);
            let a = 0x1234_5678_9abc_def0u64;
            let m = 0xfedc_ba98u64;
            assert_eq!(super::rem(&a.to_be_bytes(), &m.to_be_bytes()), {
                let v = (a % m).to_be_bytes().to_vec();
                v.into_iter().skip_while(|b| *b == 0).collect::<Vec<_>>()
            });
        }
    }
}

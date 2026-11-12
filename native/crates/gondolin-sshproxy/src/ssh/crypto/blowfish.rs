//! `bcrypt_pbkdf` (OpenBSD), the key derivation of passphrase-protected
//! OpenSSH private keys, with the Eksblowfish state it needs.
//!
//! Only used to decrypt configured key files, never on guest input.

use ring::digest::{SHA512, digest};

#[path = "blowfish_tables.rs"]
mod tables;

#[derive(Clone)]
struct Blowfish {
    p: [u32; 18],
    s: [[u32; 256]; 4],
}

/// Next big-endian word of `data`, cycling (`Blowfish_stream2word`).
fn stream_word(data: &[u8], pos: &mut usize) -> u32 {
    let mut w = 0u32;
    for _ in 0..4 {
        if *pos >= data.len() {
            *pos = 0;
        }
        w = (w << 8) | u32::from(data.get(*pos).copied().unwrap_or(0));
        *pos += 1;
    }
    w
}

impl Blowfish {
    fn new() -> Blowfish {
        Blowfish { p: tables::P, s: tables::S }
    }

    #[inline]
    fn f(&self, x: u32) -> u32 {
        let a = self.s[0][(x >> 24) as usize];
        let b = self.s[1][((x >> 16) & 0xff) as usize];
        let c = self.s[2][((x >> 8) & 0xff) as usize];
        let d = self.s[3][(x & 0xff) as usize];
        (a.wrapping_add(b) ^ c).wrapping_add(d)
    }

    fn encipher(&self, l: &mut u32, r: &mut u32) {
        let (mut xl, mut xr) = (*l, *r);
        for i in (0..16).step_by(2) {
            xl ^= self.p[i];
            xr ^= self.f(xl);
            xr ^= self.p[i + 1];
            xl ^= self.f(xr);
        }
        xl ^= self.p[16];
        xr ^= self.p[17];
        *l = xr;
        *r = xl;
    }

    /// `Blowfish_expandstate` (with `data`) / `Blowfish_expand0state` (without).
    fn expand(&mut self, data: Option<&[u8]>, key: &[u8]) {
        let mut j = 0;
        for p in &mut self.p {
            *p ^= stream_word(key, &mut j);
        }
        let mut j = 0;
        let (mut l, mut r) = (0u32, 0u32);
        let mut next = |l: &mut u32, r: &mut u32| {
            if let Some(data) = data {
                *l ^= stream_word(data, &mut j);
                *r ^= stream_word(data, &mut j);
            }
        };
        for i in (0..18).step_by(2) {
            next(&mut l, &mut r);
            self.encipher(&mut l, &mut r);
            self.p[i] = l;
            self.p[i + 1] = r;
        }
        for sbox in 0..4 {
            for k in (0..256).step_by(2) {
                next(&mut l, &mut r);
                self.encipher(&mut l, &mut r);
                self.s[sbox][k] = l;
                self.s[sbox][k + 1] = r;
            }
        }
    }
}

/// `bcrypt_hash`: 32 bytes from the SHA-512 of the passphrase and salt.
fn bcrypt_hash(sha2pass: &[u8], sha2salt: &[u8]) -> [u8; 32] {
    let mut bf = Blowfish::new();
    bf.expand(Some(sha2salt), sha2pass);
    for _ in 0..64 {
        bf.expand(None, sha2salt);
        bf.expand(None, sha2pass);
    }
    let magic = b"OxychromaticBlowfishSwatDynamite";
    let mut cdata = [0u32; 8];
    let mut j = 0;
    for w in cdata.iter_mut() {
        *w = stream_word(magic, &mut j);
    }
    for _ in 0..64 {
        for [l, r] in cdata.as_chunks_mut::<2>().0 {
            bf.encipher(l, r);
        }
    }
    let mut out = [0u8; 32];
    for (i, w) in cdata.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&w.to_le_bytes());
    }
    out
}

/// Invalid `bcrypt_pbkdf` parameters.
#[derive(Debug)]
pub struct InvalidParams;

/// `bcrypt_pbkdf` into `out`; fails on empty passphrase/salt/output or zero rounds.
pub fn bcrypt_pbkdf(
    pass: &[u8],
    salt: &[u8],
    rounds: u32,
    out: &mut [u8],
) -> Result<(), InvalidParams> {
    if rounds == 0 || pass.is_empty() || salt.is_empty() || out.is_empty() || out.len() > 1024 {
        return Err(InvalidParams);
    }
    let keylen = out.len();
    let stride = keylen.div_ceil(32);
    let amt = keylen.div_ceil(stride);
    let sha2pass = digest(&SHA512, pass);
    let mut remaining = keylen;
    let mut count: u32 = 1;
    while remaining > 0 {
        let mut countsalt = salt.to_vec();
        countsalt.extend_from_slice(&count.to_be_bytes());
        let mut sha2salt = digest(&SHA512, &countsalt);
        let mut tmp = bcrypt_hash(sha2pass.as_ref(), sha2salt.as_ref());
        let mut block = tmp;
        for _ in 1..rounds {
            sha2salt = digest(&SHA512, &tmp);
            tmp = bcrypt_hash(sha2pass.as_ref(), sha2salt.as_ref());
            for (b, t) in block.iter_mut().zip(tmp.iter()) {
                *b ^= t;
            }
        }
        let take = amt.min(remaining);
        let mut written = 0;
        for (i, byte) in block.iter().enumerate().take(take) {
            let dest = i * stride + (count as usize - 1);
            if dest >= keylen {
                break;
            }
            out[dest] = *byte;
            written += 1;
        }
        remaining -= written;
        count += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn openbsd_vectors() {
        for (pass, salt, rounds, out) in [
            (
                &b"password"[..],
                &b"salt"[..],
                4,
                "5bbf0cc293587f1c3635555c27796598d47e579071bf427e9d8fbe842aba34d9",
            ),
            (b"password", b"\0", 4, "c12b566235eee04c212598970a579a67"),
            (b"\0", b"salt", 4, "6051be18c2f4f82cbf0efee5471b4bb9"),
            (
                b"password\0",
                b"salt\0",
                4,
                "7410e44cf4fa07bfaac8a928b1727fac001375e7bf7384370f48efd121743050",
            ),
            (b"pass\0wor", b"sa\0l", 4, "c2bffd9db38f6569efef4372f4de83c0"),
            (b"pass\0word", b"sa\0lt", 4, "4ba4ac3925c0e8d7f0cdb6bb1684a56f"),
        ] {
            let want = hex(out);
            let mut got = vec![0u8; want.len()];
            bcrypt_pbkdf(pass, salt, rounds, &mut got).unwrap();
            assert_eq!(got, want, "{pass:?}/{salt:?}");
        }
    }
}

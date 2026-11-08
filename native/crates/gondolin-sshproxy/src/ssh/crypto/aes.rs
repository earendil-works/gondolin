//! Byte-oriented AES block cipher (FIPS-197) for the CTR/CBC modes of
//! passphrase-protected key files (ring exposes no raw AES).
//!
//! Table based and not constant time: only used to decrypt configured key
//! files once at startup, never on guest or network input. Packet encryption
//! uses ring's AEADs.

const fn gen_sbox() -> [u8; 256] {
    let mut sbox = [0u8; 256];
    let (mut p, mut q) = (1u8, 1u8);
    loop {
        // p *= 3, q /= 3 in GF(2^8)
        p = p ^ (p << 1) ^ (if p & 0x80 != 0 { 0x1b } else { 0 });
        q ^= q << 1;
        q ^= q << 2;
        q ^= q << 4;
        if q & 0x80 != 0 {
            q ^= 0x09;
        }
        let x = q ^ q.rotate_left(1) ^ q.rotate_left(2) ^ q.rotate_left(3) ^ q.rotate_left(4);
        sbox[p as usize] = x ^ 0x63;
        if p == 1 {
            break;
        }
    }
    sbox[0] = 0x63;
    sbox
}

const fn invert(sbox: &[u8; 256]) -> [u8; 256] {
    let mut inv = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        inv[sbox[i] as usize] = i as u8;
        i += 1;
    }
    inv
}

const SBOX: [u8; 256] = gen_sbox();
const INV_SBOX: [u8; 256] = invert(&SBOX);

#[inline]
fn xtime(x: u8) -> u8 {
    (x << 1) ^ (if x & 0x80 != 0 { 0x1b } else { 0 })
}

fn mul(mut a: u8, mut b: u8) -> u8 {
    let mut r = 0;
    while b != 0 {
        if b & 1 != 0 {
            r ^= a;
        }
        a = xtime(a);
        b >>= 1;
    }
    r
}

/// An expanded AES-128/192/256 key.
pub struct Aes {
    round_keys: Vec<[u8; 16]>,
}

impl Aes {
    /// Key of 16, 24 or 32 bytes.
    pub fn new(key: &[u8]) -> Option<Aes> {
        let nk = match key.len() {
            16 | 24 | 32 => key.len() / 4,
            _ => return None,
        };
        let rounds = nk + 6;
        let total = 4 * (rounds + 1);
        let mut w: Vec<[u8; 4]> = key.chunks(4).map(|c| [c[0], c[1], c[2], c[3]]).collect();
        let mut rcon = 1u8;
        for i in nk..total {
            let mut t = w[i - 1];
            if i % nk == 0 {
                t = [
                    SBOX[t[1] as usize],
                    SBOX[t[2] as usize],
                    SBOX[t[3] as usize],
                    SBOX[t[0] as usize],
                ];
                t[0] ^= rcon;
                rcon = xtime(rcon);
            } else if nk > 6 && i % nk == 4 {
                t = t.map(|b| SBOX[b as usize]);
            }
            let prev = w[i - nk];
            w.push([prev[0] ^ t[0], prev[1] ^ t[1], prev[2] ^ t[2], prev[3] ^ t[3]]);
        }
        let round_keys = w
            .chunks(4)
            .map(|c| {
                let mut k = [0u8; 16];
                for (j, word) in c.iter().enumerate() {
                    k[4 * j..4 * j + 4].copy_from_slice(word);
                }
                k
            })
            .collect();
        Some(Aes { round_keys })
    }

    fn rounds(&self) -> usize {
        self.round_keys.len() - 1
    }

    pub fn encrypt_block(&self, b: &mut [u8; 16]) {
        xor(b, &self.round_keys[0]);
        for round in 1..=self.rounds() {
            for x in b.iter_mut() {
                *x = SBOX[*x as usize];
            }
            shift_rows(b);
            if round != self.rounds() {
                mix_columns(b);
            }
            xor(b, &self.round_keys[round]);
        }
    }

    pub fn decrypt_block(&self, b: &mut [u8; 16]) {
        let rounds = self.rounds();
        xor(b, &self.round_keys[rounds]);
        for round in (0..rounds).rev() {
            inv_shift_rows(b);
            for x in b.iter_mut() {
                *x = INV_SBOX[*x as usize];
            }
            xor(b, &self.round_keys[round]);
            if round != 0 {
                inv_mix_columns(b);
            }
        }
    }

    /// CTR mode with a 128-bit big-endian counter (OpenSSH `aes*-ctr`).
    pub fn ctr_apply(&self, iv: &[u8; 16], data: &mut [u8]) {
        let mut counter = u128::from_be_bytes(*iv);
        for chunk in data.chunks_mut(16) {
            let mut ks = counter.to_be_bytes();
            self.encrypt_block(&mut ks);
            for (d, k) in chunk.iter_mut().zip(ks.iter()) {
                *d ^= k;
            }
            counter = counter.wrapping_add(1);
        }
    }

    /// CBC decryption in place; `data` must be a multiple of 16 bytes.
    pub fn cbc_decrypt(&self, iv: &[u8; 16], data: &mut [u8]) -> Option<()> {
        if !data.len().is_multiple_of(16) {
            return None;
        }
        let mut prev = *iv;
        for chunk in data.chunks_mut(16) {
            let mut block: [u8; 16] = chunk.try_into().ok()?;
            let cipher = block;
            self.decrypt_block(&mut block);
            xor(&mut block, &prev);
            chunk.copy_from_slice(&block);
            prev = cipher;
        }
        Some(())
    }
}

fn xor(b: &mut [u8; 16], k: &[u8; 16]) {
    for (x, y) in b.iter_mut().zip(k.iter()) {
        *x ^= y;
    }
}

// state layout: column-major (byte i is row i % 4, column i / 4)
fn shift_rows(b: &mut [u8; 16]) {
    let s = *b;
    for c in 0..4 {
        for r in 0..4 {
            b[4 * c + r] = s[4 * ((c + r) % 4) + r];
        }
    }
}

fn inv_shift_rows(b: &mut [u8; 16]) {
    let s = *b;
    for c in 0..4 {
        for r in 0..4 {
            b[4 * ((c + r) % 4) + r] = s[4 * c + r];
        }
    }
}

fn mix_columns(b: &mut [u8; 16]) {
    for c in b.as_chunks_mut::<4>().0 {
        let a = *c;
        let t = a[0] ^ a[1] ^ a[2] ^ a[3];
        for i in 0..4 {
            c[i] = a[i] ^ t ^ xtime(a[i] ^ a[(i + 1) % 4]);
        }
    }
}

fn inv_mix_columns(b: &mut [u8; 16]) {
    for c in b.as_chunks_mut::<4>().0 {
        let a = *c;
        for i in 0..4 {
            c[i] = mul(a[i], 14)
                ^ mul(a[(i + 1) % 4], 11)
                ^ mul(a[(i + 2) % 4], 13)
                ^ mul(a[(i + 3) % 4], 9);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn fips197_vectors() {
        let pt: [u8; 16] = hex("00112233445566778899aabbccddeeff").try_into().unwrap();
        for (keylen, ct) in [
            (16, "69c4e0d86a7b0430d8cdb78070b4c55a"),
            (24, "dda97ca4864cdfe06eaf70a0ec0d7191"),
            (32, "8ea2b7ca516745bfeafc49904b496089"),
        ] {
            let key: Vec<u8> = (0..keylen as u8).collect();
            let aes = Aes::new(&key).unwrap();
            let mut b = pt;
            aes.encrypt_block(&mut b);
            assert_eq!(b.to_vec(), hex(ct));
            aes.decrypt_block(&mut b);
            assert_eq!(b, pt);
        }
    }

    #[test]
    fn sp800_38a_ctr_and_cbc() {
        let key = hex("2b7e151628aed2a6abf7158809cf4f3c");
        let aes = Aes::new(&key).unwrap();
        let pt = hex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51");
        let iv: [u8; 16] = hex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff").try_into().unwrap();
        let mut data = pt.clone();
        aes.ctr_apply(&iv, &mut data);
        assert_eq!(data, hex("874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff"));
        let iv: [u8; 16] = hex("000102030405060708090a0b0c0d0e0f").try_into().unwrap();
        let mut ct = hex("7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2");
        aes.cbc_decrypt(&iv, &mut ct).unwrap();
        assert_eq!(ct, pt);
    }
}

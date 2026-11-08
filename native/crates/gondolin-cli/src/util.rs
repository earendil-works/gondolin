//! Small helpers.

/// Fills `buf` from the system's secure random source.
fn fill_random(buf: &mut [u8]) {
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), buf)
        .expect("system randomness");
}

/// `n` random bytes as lowercase hex.
pub fn random_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    fill_random(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// A random (v4) UUID.
pub fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    fill_random(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

#[cfg(test)]
mod tests {
    #[test]
    fn uuid_shape() {
        let u = super::uuid_v4();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
    }
}

//! Minimal DER reader for PEM key files (PKCS#1, SEC1, PKCS#8).

pub const SEQUENCE: u8 = 0x30;
pub const INTEGER: u8 = 0x02;
pub const OCTET_STRING: u8 = 0x04;
pub const BIT_STRING: u8 = 0x03;
pub const OID: u8 = 0x06;
pub const NULL: u8 = 0x05;

#[derive(Debug, Clone, Copy)]
pub struct Der<'a> {
    buf: &'a [u8],
}

impl<'a> Der<'a> {
    pub fn new(buf: &'a [u8]) -> Der<'a> {
        Der { buf }
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// The next element: (tag, contents).
    pub fn any(&mut self) -> Option<(u8, &'a [u8])> {
        let (&tag, rest) = self.buf.split_first()?;
        let (&first, mut rest) = rest.split_first()?;
        let len = if first < 0x80 {
            first as usize
        } else {
            let n = (first & 0x7f) as usize;
            if n == 0 || n > 4 || rest.len() < n {
                return None;
            }
            let mut len = 0usize;
            for &b in &rest[..n] {
                len = (len << 8) | b as usize;
            }
            rest = &rest[n..];
            len
        };
        if rest.len() < len {
            return None;
        }
        let (contents, tail) = rest.split_at(len);
        self.buf = tail;
        Some((tag, contents))
    }

    pub fn expect(&mut self, tag: u8) -> Option<&'a [u8]> {
        match self.any()? {
            (t, c) if t == tag => Some(c),
            _ => None,
        }
    }

    pub fn sequence(&mut self) -> Option<Der<'a>> {
        self.expect(SEQUENCE).map(Der::new)
    }

    /// An unsigned INTEGER magnitude (leading zero bytes stripped).
    pub fn uint(&mut self) -> Option<&'a [u8]> {
        let mut v = self.expect(INTEGER)?;
        if v.first().is_some_and(|b| b & 0x80 != 0) {
            return None;
        }
        while let [0, rest @ ..] = v {
            v = rest;
        }
        Some(v)
    }

    /// The next element if it has `tag`, else nothing is consumed.
    pub fn optional(&mut self, tag: u8) -> Option<&'a [u8]> {
        let mut probe = *self;
        match probe.any() {
            Some((t, c)) if t == tag => {
                *self = probe;
                Some(c)
            }
            _ => None,
        }
    }
}

/// Well-known OIDs (DER contents).
pub mod oid {
    /// 1.2.840.113549.1.1.1
    pub const RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
    /// 1.2.840.10045.2.1
    pub const EC_PUBLIC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
    /// 1.2.840.10045.3.1.7
    pub const P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
    /// 1.3.132.0.34
    pub const P384: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x22];
    /// 1.3.101.112
    pub const ED25519: &[u8] = &[0x2b, 0x65, 0x70];
}

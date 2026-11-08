//! CRC-32 (IEEE 802.3, reflected polynomial `0xEDB88320`), slicing-by-8.

const fn tables() -> [[u32; 256]; 8] {
    let mut t = [[0u32; 256]; 8];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[0][i] = c;
        i += 1;
    }
    let mut i = 0;
    while i < 256 {
        let mut s = 1;
        while s < 8 {
            let prev = t[s - 1][i];
            t[s][i] = (prev >> 8) ^ t[0][(prev & 0xff) as usize];
            s += 1;
        }
        i += 1;
    }
    t
}

static TABLES: [[u32; 256]; 8] = tables();

/// Running CRC-32.
#[derive(Debug, Clone, Copy)]
pub struct Crc32(u32);

impl Default for Crc32 {
    fn default() -> Self {
        Crc32::new()
    }
}

impl Crc32 {
    pub const fn new() -> Crc32 {
        Crc32(!0)
    }

    pub fn update(&mut self, data: &[u8]) {
        let t = &TABLES;
        let mut c = self.0;
        let (chunks, rest) = data.as_chunks::<8>();
        for b in chunks {
            let lo = c ^ u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            c = t[7][(lo & 0xff) as usize]
                ^ t[6][((lo >> 8) & 0xff) as usize]
                ^ t[5][((lo >> 16) & 0xff) as usize]
                ^ t[4][(lo >> 24) as usize]
                ^ t[3][b[4] as usize]
                ^ t[2][b[5] as usize]
                ^ t[1][b[6] as usize]
                ^ t[0][b[7] as usize];
        }
        for &b in rest {
            c = (c >> 8) ^ t[0][((c ^ b as u32) & 0xff) as usize];
        }
        self.0 = c;
    }

    pub fn value(&self) -> u32 {
        !self.0
    }
}

#[cfg(test)]
mod tests {
    use super::Crc32;

    fn crc(data: &[u8]) -> u32 {
        let mut c = Crc32::new();
        c.update(data);
        c.value()
    }

    #[test]
    fn known_values() {
        assert_eq!(crc(b""), 0);
        assert_eq!(crc(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc(b"The quick brown fox jumps over the lazy dog"), 0x414F_A339);
        // split updates match one-shot
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 7) as u8).collect();
        let mut c = Crc32::new();
        for part in data.chunks(13) {
            c.update(part);
        }
        assert_eq!(c.value(), crc(&data));
    }
}

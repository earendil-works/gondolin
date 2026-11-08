//! Response body decoding for `onResponse` (`content-encoding: gzip` /
//! `deflate`), so tier-2 hooks see decoded bodies like tier-3 hooks (which
//! read them through `DecompressionStream`). Bounded by the response body
//! limit (decompression bombs).

use miniz_oxide::inflate::{decompress_to_vec_with_limit, decompress_to_vec_zlib_with_limit};

/// A content coding the hook sees decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coding {
    Gzip,
    Deflate,
}

impl Coding {
    /// The decoded coding of a `content-encoding` value (others stay encoded).
    pub fn of(value: &str) -> Option<Coding> {
        match value.trim().to_ascii_lowercase().as_str() {
            "gzip" | "x-gzip" => Some(Coding::Gzip),
            "deflate" => Some(Coding::Deflate),
            _ => None,
        }
    }

    /// Decodes `data` to at most `limit` bytes.
    pub fn decode(self, data: &[u8], limit: usize) -> Result<Vec<u8>, String> {
        let too_large = || format!("decoded response body exceeds {limit} bytes");
        match self {
            Coding::Gzip => {
                let raw = gzip_payload(data)?;
                decompress_to_vec_with_limit(raw, limit).map_err(|e| match e.status {
                    miniz_oxide::inflate::TINFLStatus::HasMoreOutput => too_large(),
                    _ => "invalid gzip body".to_string(),
                })
            }
            Coding::Deflate => decompress_to_vec_zlib_with_limit(data, limit)
                // servers sometimes send raw DEFLATE as `deflate`
                .or_else(|_| decompress_to_vec_with_limit(data, limit))
                .map_err(|e| match e.status {
                    miniz_oxide::inflate::TINFLStatus::HasMoreOutput => too_large(),
                    _ => "invalid deflate body".to_string(),
                }),
        }
    }
}

/// The DEFLATE data of a gzip member (RFC 1952 header skipped; the trailer
/// and further members are ignored).
fn gzip_payload(data: &[u8]) -> Result<&[u8], String> {
    let bad = || "invalid gzip header".to_string();
    if data.len() < 10 || data[0] != 0x1f || data[1] != 0x8b || data[2] != 8 {
        return Err(bad());
    }
    let flags = data[3];
    let mut pos = 10;
    if flags & 4 != 0 {
        let len = usize::from(u16::from_le_bytes([
            *data.get(pos).ok_or_else(bad)?,
            *data.get(pos + 1).ok_or_else(bad)?,
        ]));
        pos += 2 + len;
    }
    for flag in [8u8, 16] {
        if flags & flag != 0 {
            let end =
                data.get(pos..).ok_or_else(bad)?.iter().position(|&b| b == 0).ok_or_else(bad)?;
            pos += end + 1;
        }
    }
    if flags & 2 != 0 {
        pos += 2;
    }
    data.get(pos..).ok_or_else(bad)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut out = vec![0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 3];
        out.extend_from_slice(b"name\0");
        out.extend(miniz_oxide::deflate::compress_to_vec(data, 6));
        out.extend_from_slice(&[0; 8]);
        out
    }

    #[test]
    fn gzip_and_deflate() {
        assert_eq!(Coding::Gzip.decode(&gzip(b"hello"), 100).unwrap(), b"hello");
        let z = miniz_oxide::deflate::compress_to_vec_zlib(b"zlib", 6);
        assert_eq!(Coding::Deflate.decode(&z, 100).unwrap(), b"zlib");
        let raw = miniz_oxide::deflate::compress_to_vec(b"raw", 6);
        assert_eq!(Coding::Deflate.decode(&raw, 100).unwrap(), b"raw");
        assert!(Coding::Gzip.decode(b"nope", 100).is_err());
    }

    #[test]
    fn bomb_is_bounded() {
        let big = vec![0u8; 1 << 20];
        let err = Coding::Gzip.decode(&gzip(&big), 1000).unwrap_err();
        assert!(err.contains("exceeds"), "{err}");
    }

    #[test]
    fn codings() {
        assert_eq!(Coding::of(" GZIP "), Some(Coding::Gzip));
        assert_eq!(Coding::of("br"), None);
    }
}

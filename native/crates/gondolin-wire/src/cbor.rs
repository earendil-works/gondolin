//! CBOR (RFC 8949) encoder and decoder for [`Value`].
//!
//! Encoding always uses the shortest argument encoding and never emits
//! tags or indefinite lengths. Decoding has two profiles:
//!
//! - [`Profile::Guest`]: the guest protocols' subset (`guest/ARCHITECTURE.md`
//!   §3.3): integers within `i64`, byte/text strings, arrays, maps, `false`,
//!   `true`, `null`; floats, tags, `undefined` and indefinite lengths are
//!   errors.
//! - [`Profile::Controller`]: additionally the full CBOR integer range, half,
//!   single and double floats, and `undefined` (as `null`), which the
//!   TypeScript controller may send.
//!
//! Both: nesting depth ≤ 64, a container claiming more elements than there
//! are remaining input bytes (≥ 1 per array item, ≥ 2 per map entry) is
//! rejected before allocating, a single container holds at most 8 MiB worth
//! of elements, text must be UTF-8. Trailing bytes after the first item are
//! ignored.

use std::fmt;

use crate::value::Value;

/// Maximum nesting depth of arrays and maps.
pub const MAX_DEPTH: usize = 64;
/// Maximum backing store of one array or map in `bytes`.
pub const MAX_CONTAINER_BYTES: usize = 8 * 1024 * 1024;

/// Which CBOR subset [`decode_with`] accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// the guest protocols' subset (§3.3)
    Guest,
    /// what the controller protocol carries (full integers, floats)
    Controller,
}

/// A CBOR decode error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CborError {
    /// byte offset of the offending item
    pub offset: usize,
    pub message: &'static str,
}

impl fmt::Display for CborError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at offset {}", self.message, self.offset)
    }
}

impl std::error::Error for CborError {}

/// Encodes one item.
pub fn encode(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    encode_into(value, &mut out);
    out
}

fn head(out: &mut Vec<u8>, major: u8, n: u64) {
    let m = major << 5;
    if n < 24 {
        out.push(m | n as u8);
    } else if n <= u8::MAX as u64 {
        out.extend_from_slice(&[m | 24, n as u8]);
    } else if n <= u16::MAX as u64 {
        out.push(m | 25);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else if n <= u32::MAX as u64 {
        out.push(m | 26);
        out.extend_from_slice(&(n as u32).to_be_bytes());
    } else {
        out.push(m | 27);
        out.extend_from_slice(&n.to_be_bytes());
    }
}

/// Length of an item head (major type and argument `n`) in `bytes`.
fn head_len(n: u64) -> usize {
    match n {
        0..24 => 1,
        24..=0xff => 2,
        0x100..=0xffff => 3,
        0x1_0000..=0xffff_ffff => 5,
        _ => 9,
    }
}

/// Length of `value`'s encoding (what [`encode_into`] appends) in `bytes`.
pub fn encoded_len(value: &Value) -> usize {
    match value {
        Value::Null | Value::Bool(_) => 1,
        Value::Integer(i) => head_len(
            if *i >= 0 { u64::try_from(*i) } else { u64::try_from(-1 - *i) }.unwrap_or(u64::MAX),
        ),
        Value::Float(f) => {
            let single = *f as f32;
            if single as f64 == *f || f.is_nan() { 5 } else { 9 }
        }
        Value::Bytes(b) => head_len(b.len() as u64) + b.len(),
        Value::Text(s) => head_len(s.len() as u64) + s.len(),
        Value::Array(a) => head_len(a.len() as u64) + a.iter().map(encoded_len).sum::<usize>(),
        Value::Map(m) => {
            head_len(m.len() as u64)
                + m.iter().map(|(k, v)| encoded_len(k) + encoded_len(v)).sum::<usize>()
        }
    }
}

/// Appends one item to `out`.
pub fn encode_into(value: &Value, out: &mut Vec<u8>) {
    match value {
        Value::Null => out.push(0xf6),
        Value::Bool(false) => out.push(0xf4),
        Value::Bool(true) => out.push(0xf5),
        Value::Integer(i) => {
            if *i >= 0 {
                // values beyond u64 cannot be encoded without bignums: clamp
                head(out, 0, u64::try_from(*i).unwrap_or(u64::MAX));
            } else {
                head(out, 1, u64::try_from(-1 - *i).unwrap_or(u64::MAX));
            }
        }
        Value::Float(f) => {
            // shortest of f32/f64 that is exact (no half floats needed by peers)
            let single = *f as f32;
            if single as f64 == *f || f.is_nan() {
                out.push(0xfa);
                out.extend_from_slice(&single.to_be_bytes());
            } else {
                out.push(0xfb);
                out.extend_from_slice(&f.to_be_bytes());
            }
        }
        Value::Bytes(b) => {
            head(out, 2, b.len() as u64);
            out.extend_from_slice(b);
        }
        Value::Text(s) => {
            head(out, 3, s.len() as u64);
            out.extend_from_slice(s.as_bytes());
        }
        Value::Array(a) => {
            head(out, 4, a.len() as u64);
            for v in a {
                encode_into(v, out);
            }
        }
        Value::Map(m) => {
            head(out, 5, m.len() as u64);
            for (k, v) in m {
                encode_into(k, out);
                encode_into(v, out);
            }
        }
    }
}

/// Decodes the first item of `bytes` with [`Profile::Controller`].
pub fn decode(bytes: &[u8]) -> Result<Value, CborError> {
    decode_with(bytes, Profile::Controller)
}

/// Decodes the first item of `bytes`.
pub fn decode_with(bytes: &[u8], profile: Profile) -> Result<Value, CborError> {
    let mut d = Decoder { buf: bytes, pos: 0, profile };
    d.item(0)
}

struct Decoder<'a> {
    buf: &'a [u8],
    pos: usize,
    profile: Profile,
}

impl Decoder<'_> {
    fn err<T>(&self, offset: usize, message: &'static str) -> Result<T, CborError> {
        Err(CborError { offset, message })
    }

    fn take(&mut self, n: usize) -> Result<&[u8], CborError> {
        if self.buf.len() - self.pos < n {
            return self.err(self.pos, "unexpected end of input");
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn arg(&mut self, info: u8, start: usize) -> Result<u64, CborError> {
        Ok(match info {
            0..=23 => info as u64,
            24 => self.take(1)?[0] as u64,
            25 => u16::from_be_bytes(self.take(2)?.try_into().unwrap()) as u64,
            26 => u32::from_be_bytes(self.take(4)?.try_into().unwrap()) as u64,
            27 => u64::from_be_bytes(self.take(8)?.try_into().unwrap()),
            31 => return self.err(start, "indefinite lengths are not supported"),
            _ => return self.err(start, "invalid additional information"),
        })
    }

    fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }

    fn item(&mut self, depth: usize) -> Result<Value, CborError> {
        let start = self.pos;
        if depth > MAX_DEPTH {
            return self.err(start, "nesting too deep");
        }
        let initial = self.take(1)?[0];
        let major = initial >> 5;
        let info = initial & 0x1f;
        let guest = self.profile == Profile::Guest;
        match major {
            0 => {
                let n = self.arg(info, start)?;
                if guest && n > i64::MAX as u64 {
                    return self.err(start, "integer out of range");
                }
                Ok(Value::Integer(n as i128))
            }
            1 => {
                let n = self.arg(info, start)?;
                if guest && n > i64::MAX as u64 {
                    return self.err(start, "integer out of range");
                }
                Ok(Value::Integer(-1 - n as i128))
            }
            2 | 3 => {
                let n = self.arg(info, start)?;
                if n > self.remaining() as u64 {
                    return self.err(start, "string longer than the input");
                }
                let s = self.take(n as usize)?.to_vec();
                if major == 2 {
                    Ok(Value::Bytes(s))
                } else {
                    String::from_utf8(s)
                        .map(Value::Text)
                        .or_else(|_| self.err(start, "text is not valid UTF-8"))
                }
            }
            4 => {
                let n = self.arg(info, start)?;
                if n > self.remaining() as u64 {
                    return self.err(start, "array longer than the input");
                }
                let n = n as usize;
                if n.saturating_mul(size_of::<Value>()) > MAX_CONTAINER_BYTES {
                    return self.err(start, "array too large");
                }
                let mut out = Vec::with_capacity(n);
                for _ in 0..n {
                    out.push(self.item(depth + 1)?);
                }
                Ok(Value::Array(out))
            }
            5 => {
                let n = self.arg(info, start)?;
                if n > (self.remaining() / 2) as u64 {
                    return self.err(start, "map longer than the input");
                }
                let n = n as usize;
                if n.saturating_mul(2 * size_of::<Value>()) > MAX_CONTAINER_BYTES {
                    return self.err(start, "map too large");
                }
                let mut out = Vec::with_capacity(n);
                for _ in 0..n {
                    let k = self.item(depth + 1)?;
                    let v = self.item(depth + 1)?;
                    out.push((k, v));
                }
                Ok(Value::Map(out))
            }
            6 => self.err(start, "tags are not supported"),
            _ => match info {
                20 => Ok(Value::Bool(false)),
                21 => Ok(Value::Bool(true)),
                22 => Ok(Value::Null),
                23 if !guest => Ok(Value::Null),
                25 if !guest => {
                    let h = u16::from_be_bytes(self.take(2)?.try_into().unwrap());
                    Ok(Value::Float(half_to_f64(h)))
                }
                26 if !guest => {
                    let b = self.take(4)?.try_into().unwrap();
                    Ok(Value::Float(f32::from_be_bytes(b) as f64))
                }
                27 if !guest => {
                    let b = self.take(8)?.try_into().unwrap();
                    Ok(Value::Float(f64::from_be_bytes(b)))
                }
                25..=27 => self.err(start, "floats are not supported"),
                31 => self.err(start, "unexpected break"),
                _ => self.err(start, "unsupported simple value"),
            },
        }
    }
}

/// IEEE 754 half precision to `f64`.
fn half_to_f64(h: u16) -> f64 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = (h >> 10) & 0x1f;
    let mant = (h & 0x3ff) as f64;
    match exp {
        0 => sign * mant * 2f64.powi(-24),
        0x1f if mant == 0.0 => sign * f64::INFINITY,
        0x1f => f64::NAN,
        e => sign * (1.0 + mant / 1024.0) * 2f64.powi(e as i32 - 15),
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn encoded_len_matches_the_encoding() {
        let values = vec![
            Value::Null,
            Value::Bool(true),
            Value::Integer(0),
            Value::Integer(23),
            Value::Integer(24),
            Value::Integer(255),
            Value::Integer(256),
            Value::Integer(65_535),
            Value::Integer(65_536),
            Value::Integer(u32::MAX as i128 + 1),
            Value::Integer(-1),
            Value::Integer(-25),
            Value::Integer(i64::MIN as i128),
            Value::Float(1.5),
            Value::Float(0.1),
            Value::Bytes(vec![7; 70_000]),
            Value::Text("x".repeat(300)),
            Value::Array(vec![Value::Integer(1); 30]),
            Value::Map(vec![(Value::Text("data".into()), Value::Bytes(vec![1; 1 << 20]))]),
        ];
        for v in &values {
            assert_eq!(encoded_len(v), encode(v).len(), "{v:?}");
        }
        let all = Value::Array(values);
        assert_eq!(encoded_len(&all), encode(&all).len());
        let framed = crate::frame_value(&all).unwrap();
        assert_eq!(framed, crate::frame(&encode(&all)).unwrap());
    }

    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn rfc8949_appendix_a() {
        // (diagnostic value, encoding)
        let cases: Vec<(Value, &str)> = vec![
            (Value::Integer(0), "00"),
            (Value::Integer(23), "17"),
            (Value::Integer(24), "1818"),
            (Value::Integer(100), "1864"),
            (Value::Integer(1000), "1903e8"),
            (Value::Integer(1_000_000), "1a000f4240"),
            (Value::Integer(1_000_000_000_000), "1b000000e8d4a51000"),
            (Value::Integer(u64::MAX as i128), "1bffffffffffffffff"),
            (Value::Integer(-(u64::MAX as i128) - 1), "3bffffffffffffffff"),
            (Value::Integer(-1), "20"),
            (Value::Integer(-1000), "3903e7"),
            (Value::Float(1.5), "fa3fc00000"),
            (Value::Float(1.1), "fb3ff199999999999a"),
            (Value::Bool(false), "f4"),
            (Value::Null, "f6"),
            (Value::Bytes(vec![1, 2, 3, 4]), "4401020304"),
            (Value::Text("\u{00fc}".into()), "62c3bc"),
            (Value::Text("IETF".into()), "6449455446"),
            (
                Value::Array(vec![
                    Value::Integer(1),
                    Value::Array(vec![Value::Integer(2), Value::Integer(3)]),
                ]),
                "8201820203",
            ),
            (
                Value::Map(vec![
                    (Value::Text("a".into()), Value::Integer(1)),
                    (
                        Value::Text("b".into()),
                        Value::Array(vec![Value::Integer(2), Value::Integer(3)]),
                    ),
                ]),
                "a26161016162820203",
            ),
        ];
        for (v, h) in cases {
            assert_eq!(encode(&v), hex(h), "{v:?}");
            assert_eq!(decode(&hex(h)).unwrap(), v, "{h}");
        }
        // half floats and undefined decode on the controller profile
        assert_eq!(decode(&hex("f93e00")).unwrap(), Value::Float(1.5));
        assert_eq!(decode(&hex("f97c00")).unwrap(), Value::Float(f64::INFINITY));
        assert_eq!(decode(&hex("f90001")).unwrap(), Value::Float(5.960464477539063e-8));
        assert_eq!(decode(&hex("f7")).unwrap(), Value::Null);
    }

    #[test]
    fn guest_profile_and_limits() {
        let g = |h: &str| decode_with(&hex(h), Profile::Guest);
        assert_eq!(g("1b7fffffffffffffff").unwrap(), Value::Integer(i64::MAX as i128));
        assert!(g("1b8000000000000000").is_err());
        assert_eq!(g("3b7fffffffffffffff").unwrap(), Value::Integer(i64::MIN as i128));
        assert!(g("3b8000000000000000").is_err());
        assert!(g("fa3fc00000").is_err());
        assert!(g("f7").is_err());
        assert!(g("c11a514b67b0").is_err()); // tag
        assert!(decode(&hex("5f42010243030405ff")).is_err()); // indefinite
        assert!(decode(&hex("9a7fffffff")).is_err()); // huge array claim
        assert!(decode(&hex("bbffffffffffffffff")).is_err()); // huge map claim
        assert!(decode(&hex("62c328")).is_err()); // invalid UTF-8
        assert!(decode(&hex("63616263")[..3]).is_err()); // truncated
        let mut deep = vec![0x81; MAX_DEPTH + 1];
        deep.push(0x00);
        assert!(decode(&deep).is_err());
        let mut ok = vec![0x81; MAX_DEPTH];
        ok.push(0x00);
        assert!(decode(&ok).is_ok());
        // trailing bytes are ignored
        assert_eq!(decode(&hex("0102")).unwrap(), Value::Integer(1));
    }
}

//! Sans-io body decoding (Content-Length, chunked, close-delimited) and
//! chunked encoding.

use bytes::{Buf, Bytes, BytesMut};

use crate::head::Framing;

/// Max bytes of chunk extensions per message (hyper's limit)
const MAX_EXTENSION_BYTES: u64 = 16 * 1024;
/// Max bytes of a trailer section
const MAX_TRAILER_BYTES: usize = 64 * 1024;

/// Malformed body framing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// invalid chunk size line or chunk delimiter
    InvalidChunk(&'static str),
    /// the connection ended before the body did
    UnexpectedEof,
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::InvalidChunk(what) => write!(f, "invalid chunked body: {what}"),
            DecodeError::UnexpectedEof => f.write_str("connection closed before message completed"),
        }
    }
}

impl std::error::Error for DecodeError {}

/// Result of one [`Decoder::decode`] step.
#[derive(Debug, PartialEq, Eq)]
pub enum Decoded {
    /// body bytes
    Data(Bytes),
    /// more input needed
    NeedMore,
    /// end of body (input after it belongs to the next message)
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chunk {
    /// reading the hex size; `digits` read so far
    Size {
        size: u64,
        digits: u8,
    },
    /// whitespace after the size
    SizeLws {
        size: u64,
    },
    /// in a chunk extension
    Extension {
        size: u64,
    },
    /// expecting LF after the size line's CR
    SizeLf {
        size: u64,
    },
    /// chunk data left in `bytes`
    Data {
        left: u64,
    },
    /// expecting CR after chunk data
    DataCr,
    /// expecting LF after chunk data
    DataLf,
    /// in the trailer section (`line` bytes into the current line)
    Trailer {
        line: usize,
    },
    /// LF after a trailer line's CR
    TrailerLf {
        line: usize,
    },
    Done,
}

/// Incremental body decoder.
#[derive(Debug, Clone)]
pub struct Decoder {
    kind: Kind,
}

#[derive(Debug, Clone)]
enum Kind {
    Length(u64),
    Chunked { state: Chunk, extension_bytes: u64, trailer_bytes: usize },
    Close { eof: bool },
}

impl Decoder {
    pub fn new(framing: Framing) -> Self {
        let kind = match framing {
            Framing::Length(n) => Kind::Length(n),
            Framing::Chunked => Kind::Chunked {
                state: Chunk::Size { size: 0, digits: 0 },
                extension_bytes: 0,
                trailer_bytes: 0,
            },
            Framing::Close => Kind::Close { eof: false },
        };
        Self { kind }
    }

    /// Whether the whole body was decoded.
    pub fn is_done(&self) -> bool {
        match self.kind {
            Kind::Length(n) => n == 0,
            Kind::Chunked { state, .. } => state == Chunk::Done,
            Kind::Close { eof } => eof,
        }
    }

    /// Exact remaining size in `bytes`, when known.
    pub fn remaining(&self) -> Option<u64> {
        match self.kind {
            Kind::Length(n) => Some(n),
            Kind::Chunked { state: Chunk::Done, .. } | Kind::Close { eof: true } => Some(0),
            _ => None,
        }
    }

    /// Consumes framing from `buf` and returns the next data, `NeedMore` or `Done`.
    pub fn decode(&mut self, buf: &mut BytesMut) -> Result<Decoded, DecodeError> {
        match &mut self.kind {
            Kind::Length(0) => Ok(Decoded::Done),
            Kind::Length(left) => {
                if buf.is_empty() {
                    return Ok(Decoded::NeedMore);
                }
                let n = (*left).min(buf.len() as u64) as usize;
                *left -= n as u64;
                Ok(Decoded::Data(buf.split_to(n).freeze()))
            }
            Kind::Close { eof: true } => Ok(Decoded::Done),
            Kind::Close { eof: false } => {
                if buf.is_empty() {
                    return Ok(Decoded::NeedMore);
                }
                Ok(Decoded::Data(buf.split().freeze()))
            }
            Kind::Chunked { state, extension_bytes, trailer_bytes } => {
                decode_chunked(state, extension_bytes, trailer_bytes, buf)
            }
        }
    }

    /// Signals the end of input; `Ok` when that ends the body (close-delimited).
    pub fn eof(&mut self) -> Result<(), DecodeError> {
        if let Kind::Close { eof } = &mut self.kind {
            *eof = true;
        }
        if self.is_done() { Ok(()) } else { Err(DecodeError::UnexpectedEof) }
    }
}

fn hex(b: u8) -> Option<u64> {
    (b as char).to_digit(16).map(u64::from)
}

fn decode_chunked(
    state: &mut Chunk,
    extension_bytes: &mut u64,
    trailer_bytes: &mut usize,
    buf: &mut BytesMut,
) -> Result<Decoded, DecodeError> {
    use DecodeError::InvalidChunk as E;
    loop {
        if let Chunk::Data { left } = *state {
            if buf.is_empty() {
                return Ok(Decoded::NeedMore);
            }
            let n = left.min(buf.len() as u64) as usize;
            let left = left - n as u64;
            *state = if left == 0 { Chunk::DataCr } else { Chunk::Data { left } };
            return Ok(Decoded::Data(buf.split_to(n).freeze()));
        }
        if *state == Chunk::Done {
            return Ok(Decoded::Done);
        }
        let Some(&b) = buf.first() else {
            return Ok(Decoded::NeedMore);
        };
        buf.advance(1);
        *state = match *state {
            Chunk::Size { size, digits } => match (b, hex(b)) {
                (_, Some(d)) => {
                    if digits >= 16 {
                        return Err(E("chunk size overflow"));
                    }
                    Chunk::Size { size: size * 16 + d, digits: digits + 1 }
                }
                _ if digits == 0 => return Err(E("missing chunk size")),
                (b'\t' | b' ', _) => Chunk::SizeLws { size },
                (b';', _) => Chunk::Extension { size },
                (b'\r', _) => Chunk::SizeLf { size },
                _ => return Err(E("invalid chunk size")),
            },
            Chunk::SizeLws { size } => match b {
                b'\t' | b' ' => Chunk::SizeLws { size },
                b';' => Chunk::Extension { size },
                b'\r' => Chunk::SizeLf { size },
                _ => return Err(E("invalid chunk size")),
            },
            Chunk::Extension { size } => {
                *extension_bytes += 1;
                if *extension_bytes > MAX_EXTENSION_BYTES {
                    return Err(E("chunk extensions too large"));
                }
                match b {
                    b'\r' => Chunk::SizeLf { size },
                    b'\n' => return Err(E("invalid chunk extension")),
                    _ => Chunk::Extension { size },
                }
            }
            Chunk::SizeLf { size } => match b {
                b'\n' if size == 0 => Chunk::Trailer { line: 0 },
                b'\n' => Chunk::Data { left: size },
                _ => return Err(E("invalid chunk size line")),
            },
            Chunk::DataCr => match b {
                b'\r' => Chunk::DataLf,
                _ => return Err(E("missing chunk delimiter")),
            },
            Chunk::DataLf => match b {
                b'\n' => Chunk::Size { size: 0, digits: 0 },
                _ => return Err(E("missing chunk delimiter")),
            },
            Chunk::Trailer { line } => {
                *trailer_bytes += 1;
                if *trailer_bytes > MAX_TRAILER_BYTES {
                    return Err(E("trailers too large"));
                }
                match b {
                    b'\r' => Chunk::TrailerLf { line },
                    b'\n' => return Err(E("invalid trailer")),
                    _ => Chunk::Trailer { line: line + 1 },
                }
            }
            Chunk::TrailerLf { line } => match b {
                b'\n' if line == 0 => Chunk::Done,
                b'\n' => Chunk::Trailer { line: 0 },
                _ => return Err(E("invalid trailer")),
            },
            Chunk::Data { .. } | Chunk::Done => unreachable!(),
        };
    }
}

/// Chunk-size line for `len` data bytes (`<hex>\r\n`).
pub fn chunk_header(len: usize) -> Vec<u8> {
    format!("{len:X}\r\n").into_bytes()
}

/// Last chunk and empty trailer section.
pub const CHUNKED_END: &[u8] = b"0\r\n\r\n";

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_all(
        framing: Framing,
        input: &[u8],
        step: usize,
    ) -> Result<(Vec<u8>, Vec<u8>), DecodeError> {
        let mut dec = Decoder::new(framing);
        let mut buf = BytesMut::new();
        let mut out = Vec::new();
        let mut pos = 0;
        loop {
            match dec.decode(&mut buf)? {
                Decoded::Data(d) => out.extend_from_slice(&d),
                Decoded::Done => return Ok((out, buf.to_vec())),
                Decoded::NeedMore => {
                    if pos >= input.len() {
                        dec.eof()?;
                        continue;
                    }
                    let end = (pos + step).min(input.len());
                    buf.extend_from_slice(&input[pos..end]);
                    pos = end;
                }
            }
        }
    }

    #[test]
    fn chunked() {
        let input =
            b"5\r\nhello\r\n6;ext=1\r\n world\r\nA \r\n0123456789\r\n0\r\nX-T: 1\r\n\r\nNEXT";
        for step in [1, 2, 3, 7, 100] {
            let (body, rest) = decode_all(Framing::Chunked, input, step).unwrap();
            assert_eq!(body, b"hello world0123456789");
            // input after the body stays in the buffer (only what was fed)
            assert!(b"NEXT".starts_with(&rest[..]), "{step}");
        }
        for bad in [
            &b"x\r\n"[..],
            b"5\nhello\r\n0\r\n\r\n",
            b"5\r\nhelloXX0\r\n\r\n",
            b"11111111111111111\r\n",
            b"\r\n",
            b"0\r\nbad\n\r\n",
        ] {
            assert!(decode_all(Framing::Chunked, bad, 1).is_err(), "{bad:?}");
        }
        assert_eq!(decode_all(Framing::Chunked, b"5\r\nhel", 2), Err(DecodeError::UnexpectedEof));
    }

    #[test]
    fn length_and_close() {
        let (body, rest) = decode_all(Framing::Length(5), b"helloNEXT", 100).unwrap();
        assert_eq!(body, b"hello");
        assert_eq!(rest, b"NEXT");
        assert_eq!(decode_all(Framing::Length(5), b"hel", 1), Err(DecodeError::UnexpectedEof));
        let (body, _) = decode_all(Framing::Close, b"all of it", 4).unwrap();
        assert_eq!(body, b"all of it");
    }
}

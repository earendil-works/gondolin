//! Streaming gzip decoder (RFC 1952): our own member header/trailer parsing
//! and CRC-32 around `miniz_oxide`'s raw DEFLATE inflater. Concatenated
//! members are decoded in sequence; trailing zero padding is accepted, any
//! other trailing data is an error.

use std::io::{self, Read};

use miniz_oxide::inflate::stream::{InflateState, inflate};
use miniz_oxide::{DataFormat, MZError, MZFlush, MZStatus};

use super::crc32::Crc32;

const FTEXT: u8 = 1;
const FHCRC: u8 = 2;
const FEXTRA: u8 = 4;
const FNAME: u8 = 8;
const FCOMMENT: u8 = 16;
/// Longest accepted header name or comment in `bytes`.
const MAX_HEADER_STRING: usize = 64 * 1024;
const INPUT_BUFFER: usize = 64 * 1024;

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("gzip: {}", message.into()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// before a member header (`first`: no member decoded yet)
    Header {
        first: bool,
    },
    Body,
    Done,
}

/// Decompresses a gzip stream read from `R`.
pub struct GzipReader<R> {
    inner: R,
    buf: Box<[u8]>,
    pos: usize,
    len: usize,
    eof: bool,
    state: Box<InflateState>,
    crc: Crc32,
    /// uncompressed size of the current member modulo 2^32
    size: u32,
    phase: Phase,
    /// decode the members that follow the first (else stop after it)
    multi: bool,
}

impl<R: Read> GzipReader<R> {
    pub fn new(inner: R) -> GzipReader<R> {
        GzipReader {
            inner,
            buf: vec![0; INPUT_BUFFER].into_boxed_slice(),
            pos: 0,
            len: 0,
            eof: false,
            state: InflateState::new_boxed(DataFormat::Raw),
            crc: Crc32::new(),
            size: 0,
            phase: Phase::Header { first: true },
            multi: true,
        }
    }

    /// Like [`GzipReader::new`], but decodes only the first member and ignores
    /// whatever follows it, as for a gzip payload embedded in a larger file
    /// (a compressed kernel image).
    pub fn first_member(inner: R) -> GzipReader<R> {
        GzipReader { multi: false, ..GzipReader::new(inner) }
    }

    /// Refills the input buffer when it is empty; returns whether data is available.
    fn fill(&mut self) -> io::Result<bool> {
        if self.pos < self.len {
            return Ok(true);
        }
        if self.eof {
            return Ok(false);
        }
        loop {
            match self.inner.read(&mut self.buf) {
                Ok(0) => {
                    self.eof = true;
                    return Ok(false);
                }
                Ok(n) => {
                    self.pos = 0;
                    self.len = n;
                    return Ok(true);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
    }

    fn byte(&mut self, hcrc: &mut Crc32) -> io::Result<u8> {
        if !self.fill()? {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "gzip: truncated header"));
        }
        let b = self.buf[self.pos];
        self.pos += 1;
        hcrc.update(&[b]);
        Ok(b)
    }

    fn zero_terminated(&mut self, hcrc: &mut Crc32) -> io::Result<()> {
        for _ in 0..MAX_HEADER_STRING {
            if self.byte(hcrc)? == 0 {
                return Ok(());
            }
        }
        Err(invalid("header string too long"))
    }

    /// Parses a member header. `Ok(false)` when the input ended (or only zero
    /// padding followed) after at least one member.
    fn header(&mut self, first: bool) -> io::Result<bool> {
        if !first {
            // trailing zero padding (e.g. tape blocking) ends the stream
            let mut padded = false;
            loop {
                if !self.fill()? {
                    return Ok(false);
                }
                while self.pos < self.len && self.buf[self.pos] == 0 {
                    self.pos += 1;
                    padded = true;
                }
                if self.pos < self.len {
                    break;
                }
            }
            if padded || self.buf[self.pos] != 0x1f {
                return Err(invalid("trailing garbage after the last member"));
            }
        }
        let mut hcrc = Crc32::new();
        let id1 = self.byte(&mut hcrc)?;
        let id2 = self.byte(&mut hcrc)?;
        if id1 != 0x1f || id2 != 0x8b {
            return Err(invalid("not a gzip stream"));
        }
        if self.byte(&mut hcrc)? != 8 {
            return Err(invalid("unsupported compression method"));
        }
        let flags = self.byte(&mut hcrc)?;
        if flags & !(FTEXT | FHCRC | FEXTRA | FNAME | FCOMMENT) != 0 {
            return Err(invalid("reserved header flags set"));
        }
        // MTIME (4), XFL, OS
        for _ in 0..6 {
            self.byte(&mut hcrc)?;
        }
        if flags & FEXTRA != 0 {
            let xlen = u16::from_le_bytes([self.byte(&mut hcrc)?, self.byte(&mut hcrc)?]);
            for _ in 0..xlen {
                self.byte(&mut hcrc)?;
            }
        }
        if flags & FNAME != 0 {
            self.zero_terminated(&mut hcrc)?;
        }
        if flags & FCOMMENT != 0 {
            self.zero_terminated(&mut hcrc)?;
        }
        if flags & FHCRC != 0 {
            let expected = (hcrc.value() & 0xffff) as u16;
            let mut ignore = Crc32::new();
            let got = u16::from_le_bytes([self.byte(&mut ignore)?, self.byte(&mut ignore)?]);
            if got != expected {
                return Err(invalid("header checksum mismatch"));
            }
        }
        self.state.reset(DataFormat::Raw);
        self.crc = Crc32::new();
        self.size = 0;
        Ok(true)
    }

    fn trailer(&mut self) -> io::Result<()> {
        let mut ignore = Crc32::new();
        let mut t = [0u8; 8];
        for b in &mut t {
            *b = self.byte(&mut ignore).map_err(|e| {
                if e.kind() == io::ErrorKind::UnexpectedEof {
                    io::Error::new(io::ErrorKind::UnexpectedEof, "gzip: truncated trailer")
                } else {
                    e
                }
            })?;
        }
        let crc = u32::from_le_bytes([t[0], t[1], t[2], t[3]]);
        let isize = u32::from_le_bytes([t[4], t[5], t[6], t[7]]);
        if crc != self.crc.value() {
            return Err(invalid("CRC-32 mismatch"));
        }
        if isize != self.size {
            return Err(invalid("length mismatch"));
        }
        Ok(())
    }
}

impl<R: Read> Read for GzipReader<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        loop {
            match self.phase {
                Phase::Done => return Ok(0),
                Phase::Header { first } => {
                    if self.header(first)? {
                        self.phase = Phase::Body;
                    } else {
                        self.phase = Phase::Done;
                    }
                }
                Phase::Body => {
                    let has_input = self.fill()?;
                    let input = &self.buf[self.pos..self.len];
                    let r = inflate(&mut self.state, input, out, MZFlush::None);
                    self.pos += r.bytes_consumed;
                    let written = &out[..r.bytes_written];
                    self.crc.update(written);
                    self.size = self.size.wrapping_add(written.len() as u32);
                    match r.status {
                        Ok(MZStatus::StreamEnd) => {
                            self.trailer()?;
                            self.phase = if self.multi {
                                Phase::Header { first: false }
                            } else {
                                Phase::Done
                            };
                            if r.bytes_written > 0 {
                                return Ok(r.bytes_written);
                            }
                        }
                        Ok(_) => {
                            if r.bytes_written > 0 {
                                return Ok(r.bytes_written);
                            }
                            if r.bytes_consumed == 0 && !has_input {
                                return Err(io::Error::new(
                                    io::ErrorKind::UnexpectedEof,
                                    "gzip: truncated stream",
                                ));
                            }
                        }
                        Err(MZError::Buf) => {
                            if r.bytes_written > 0 {
                                return Ok(r.bytes_written);
                            }
                            if !has_input {
                                return Err(io::Error::new(
                                    io::ErrorKind::UnexpectedEof,
                                    "gzip: truncated stream",
                                ));
                            }
                        }
                        Err(e) => return Err(invalid(format!("corrupt deflate data ({e:?})"))),
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A gzip member around stored (uncompressed) DEFLATE blocks.
    fn stored_gzip(data: &[u8], flags: u8) -> Vec<u8> {
        let mut out = vec![0x1f, 0x8b, 8, flags, 0, 0, 0, 0, 0, 3];
        if flags & FEXTRA != 0 {
            out.extend_from_slice(&[2, 0, b'a', b'b']);
        }
        if flags & FNAME != 0 {
            out.extend_from_slice(b"name\0");
        }
        if flags & FCOMMENT != 0 {
            out.extend_from_slice(b"comment\0");
        }
        if flags & FHCRC != 0 {
            let mut c = Crc32::new();
            c.update(&out);
            out.extend_from_slice(&((c.value() & 0xffff) as u16).to_le_bytes());
        }
        let blocks: Vec<&[u8]> =
            if data.is_empty() { vec![&[]] } else { data.chunks(65535).collect() };
        for (i, block) in blocks.iter().enumerate() {
            out.push(u8::from(i + 1 == blocks.len()));
            let len = block.len() as u16;
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(&(!len).to_le_bytes());
            out.extend_from_slice(block);
        }
        let mut c = Crc32::new();
        c.update(data);
        out.extend_from_slice(&c.value().to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out
    }

    fn decode(bytes: &[u8]) -> io::Result<Vec<u8>> {
        // tiny reads exercise the buffering paths
        struct Trickle<'a>(&'a [u8]);
        impl Read for Trickle<'_> {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                let n = buf.len().min(self.0.len()).min(7);
                buf[..n].copy_from_slice(&self.0[..n]);
                self.0 = &self.0[n..];
                Ok(n)
            }
        }
        let mut out = Vec::new();
        GzipReader::new(Trickle(bytes)).read_to_end(&mut out)?;
        Ok(out)
    }

    #[test]
    fn stored_members_flags_and_concatenation() {
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        for flags in [0, FNAME, FEXTRA | FNAME | FCOMMENT | FHCRC] {
            assert_eq!(decode(&stored_gzip(&data, flags)).unwrap(), data);
        }
        let mut two = stored_gzip(b"hello ", 0);
        two.extend(stored_gzip(b"world", FNAME));
        two.extend([0u8; 100]);
        assert_eq!(decode(&two).unwrap(), b"hello world");
        assert_eq!(decode(&stored_gzip(b"", 0)).unwrap(), b"");
    }

    #[test]
    fn compressed_member() {
        let data: Vec<u8> = b"gondolin ".repeat(10_000);
        let deflated = miniz_oxide::deflate::compress_to_vec(&data, 6);
        let mut gz = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3];
        gz.extend(deflated);
        let mut c = Crc32::new();
        c.update(&data);
        gz.extend(c.value().to_le_bytes());
        gz.extend((data.len() as u32).to_le_bytes());
        assert_eq!(decode(&gz).unwrap(), data);
    }

    #[test]
    fn first_member_ignores_what_follows() {
        let mut embedded = stored_gzip(b"kernel", 0);
        embedded.extend_from_slice(b"\x01rest of the image");
        // a whole stream must end after its members
        assert!(decode(&embedded).is_err());
        let mut out = Vec::new();
        GzipReader::first_member(&embedded[..]).read_to_end(&mut out).unwrap();
        assert_eq!(out, b"kernel");
        // the first member is still checked
        let n = embedded.len() - b"\x01rest of the image".len();
        embedded[n - 8] ^= 1;
        assert!(GzipReader::first_member(&embedded[..]).read_to_end(&mut out).is_err());
    }

    #[test]
    fn corruption_is_detected() {
        let good = stored_gzip(b"payload", 0);
        let mut bad_crc = good.clone();
        let n = bad_crc.len();
        bad_crc[n - 8] ^= 1;
        assert!(decode(&bad_crc).unwrap_err().to_string().contains("CRC"));
        let mut bad_len = good.clone();
        bad_len[n - 1] ^= 1;
        assert!(decode(&bad_len).unwrap_err().to_string().contains("length"));
        assert_eq!(decode(&good[..n - 3]).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        assert_eq!(decode(&good[..5]).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        let mut garbage = good.clone();
        garbage.extend(b"xyz");
        assert!(decode(&garbage).is_err());
        let mut hcrc = stored_gzip(b"x", FHCRC);
        hcrc[10] ^= 1;
        assert!(decode(&hcrc).is_err());
        assert!(decode(b"not gzip at all").is_err());
        let mut reserved = good;
        reserved[3] = 0x80;
        assert!(decode(&reserved).is_err());
    }
}

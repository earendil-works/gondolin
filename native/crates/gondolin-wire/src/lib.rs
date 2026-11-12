//! Framing shared by every gondolind protocol: a `u32` big-endian length
//! followed by one CBOR item (`guest/ARCHITECTURE.md` §3.2), plus the
//! `{ v, t, id, p }` message envelope (§3.4) used by the guest protocols and the
//! controller protocol (`native/DESIGN.md`).
//!
//! The data model is our own [`Value`] with a CBOR codec ([`cbor`]) and a JSON
//! codec ([`json`]); typed messages convert through [`ToValue`]/[`FromValue`],
//! implemented with the declarative [`wire_struct!`], [`wire_enum!`] and
//! [`wire_tagged!`] macros (no serde, no proc macros). Encoders follow the
//! guest's CBOR subset (§3.3): optional fields are omitted when absent, raw
//! data is a byte string (`Vec<u8>`), no floats are sent to the guest.

use std::{fmt, io};

use bytes::{Buf, Bytes, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub mod base64;
pub mod cbor;
pub mod convert;
pub mod json;
pub mod value;

pub use convert::{DecodeError, FromValue, ToValue};
pub use value::Value;

/// Maximum frame payload in `bytes`, the same limit as the guest protocols.
pub const MAX_FRAME: usize = 4 * 1024 * 1024;

/// Errors of encoding, decoding and frame I/O.
#[derive(Debug)]
pub enum WireError {
    Io(io::Error),
    Encode(String),
    Decode(String),
    FrameTooLarge(usize),
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WireError::Io(e) => write!(f, "i/o error: {e}"),
            WireError::Encode(e) => write!(f, "cbor encode error: {e}"),
            WireError::Decode(e) => write!(f, "cbor decode error: {e}"),
            WireError::FrameTooLarge(n) => {
                write!(f, "frame of {n} bytes exceeds the {MAX_FRAME} byte limit")
            }
        }
    }
}

impl std::error::Error for WireError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            WireError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for WireError {
    fn from(e: io::Error) -> Self {
        WireError::Io(e)
    }
}

impl From<DecodeError> for WireError {
    fn from(e: DecodeError) -> Self {
        WireError::Decode(e.to_string())
    }
}

impl From<cbor::CborError> for WireError {
    fn from(e: cbor::CborError) -> Self {
        WireError::Decode(e.to_string())
    }
}

/// Encodes `value` as one CBOR item (never fails; `Result` for call sites
/// that propagate errors).
pub fn encode<T: ToValue + ?Sized>(value: &T) -> Result<Vec<u8>, WireError> {
    Ok(cbor::encode(&value.to_value()))
}

/// Decodes one CBOR item from `bytes` (controller profile; trailing bytes are
/// ignored).
pub fn decode<T: FromValue>(bytes: &[u8]) -> Result<T, WireError> {
    let value = cbor::decode(bytes)?;
    Ok(T::from_value(&value)?)
}

/// Decodes one CBOR item of a guest protocol (§3.3 subset: `i64` integers,
/// no floats).
pub fn decode_guest<T: FromValue>(bytes: &[u8]) -> Result<T, WireError> {
    let value = cbor::decode_with(bytes, cbor::Profile::Guest)?;
    Ok(T::from_value(&value)?)
}

/// Converts a decoded value into a typed value.
pub fn from_value<T: FromValue>(value: impl AsRef<Value>) -> Result<T, WireError> {
    Ok(T::from_value(value.as_ref())?)
}

/// Converts a typed value into a value (never fails).
pub fn to_value<T: ToValue + ?Sized>(value: &T) -> Result<Value, WireError> {
    Ok(value.to_value())
}

impl AsRef<Value> for Value {
    fn as_ref(&self) -> &Value {
        self
    }
}

/// Encodes `value` as one frame (`u32` big-endian length, then the CBOR) in a
/// single allocation, without an intermediate payload copy (large `Bytes`).
pub fn frame_value(value: &Value) -> Result<Vec<u8>, WireError> {
    let len = cbor::encoded_len(value);
    if len > MAX_FRAME {
        return Err(WireError::FrameTooLarge(len));
    }
    let mut out = Vec::with_capacity(4 + len);
    out.extend_from_slice(&(len as u32).to_be_bytes());
    cbor::encode_into(value, &mut out);
    debug_assert_eq!(out.len(), 4 + len);
    Ok(out)
}

/// Prefixes `payload` with its `u32` big-endian length.
pub fn frame(payload: &[u8]) -> Result<Vec<u8>, WireError> {
    if payload.len() > MAX_FRAME {
        return Err(WireError::FrameTooLarge(payload.len()));
    }
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// The `{ v, t, id, p }` envelope with a typed payload.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope<P> {
    /// protocol version (always 1 when sending)
    pub v: u32,
    /// message type
    pub t: String,
    /// correlation id (`0` for unsolicited messages)
    pub id: u64,
    /// payload map
    pub p: P,
}

impl<P> Envelope<P> {
    pub fn new(t: impl Into<String>, id: u64, p: P) -> Self {
        Envelope { v: 1, t: t.into(), id, p }
    }
}

impl<P: ToValue> ToValue for Envelope<P> {
    fn to_value(&self) -> Value {
        Value::Map(vec![
            (Value::Text("v".into()), self.v.to_value()),
            (Value::Text("t".into()), Value::Text(self.t.clone())),
            (Value::Text("id".into()), self.id.to_value()),
            (Value::Text("p".into()), self.p.to_value()),
        ])
    }
}

impl<P: FromValue> FromValue for Envelope<P> {
    fn from_value(value: &Value) -> Result<Self, DecodeError> {
        let map = convert::expect_map(value, "a map (envelope)")?;
        Ok(Envelope {
            v: convert::field(map, "v")?,
            t: convert::field(map, "t")?,
            id: convert::field(map, "id")?,
            p: convert::field(map, "p")?,
        })
    }
}

/// An envelope whose payload is kept as a value, for dispatch on `t`.
pub type RawEnvelope = Envelope<Value>;

impl RawEnvelope {
    /// Decodes the payload as `P`.
    pub fn payload<P: FromValue>(&self) -> Result<P, WireError> {
        Ok(P::from_value(&self.p)?)
    }
}

/// Reads frames from a byte stream. Oversized frames are skipped (their bytes
/// are read and discarded) so the stream stays in sync, as the guest does.
pub struct FrameReader<R> {
    inner: R,
    buf: BytesMut,
    /// bytes still to discard from an oversized frame
    skip: usize,
    /// number of oversized frames skipped so far
    pub skipped_frames: u64,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub fn new(inner: R) -> Self {
        FrameReader { inner, buf: BytesMut::with_capacity(64 * 1024), skip: 0, skipped_frames: 0 }
    }

    /// Returns the next frame payload, or `None` on a clean EOF at a frame
    /// boundary. EOF inside a frame is an `UnexpectedEof` error.
    pub async fn read_frame(&mut self) -> Result<Option<Bytes>, WireError> {
        loop {
            if self.skip > 0 {
                let n = self.skip.min(self.buf.len());
                self.buf.advance(n);
                self.skip -= n;
            }
            if self.skip == 0 && self.buf.len() >= 4 {
                let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]])
                    as usize;
                if len > MAX_FRAME {
                    self.buf.advance(4);
                    self.skip = len;
                    self.skipped_frames += 1;
                    continue;
                }
                if self.buf.len() >= 4 + len {
                    self.buf.advance(4);
                    return Ok(Some(self.buf.split_to(len).freeze()));
                }
                self.buf.reserve(4 + len - self.buf.len());
            }
            let n = self.inner.read_buf(&mut self.buf).await?;
            if n == 0 {
                if self.buf.is_empty() && self.skip == 0 {
                    return Ok(None);
                }
                return Err(WireError::Io(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "eof inside a frame",
                )));
            }
        }
    }

    /// Reads and decodes the next envelope.
    pub async fn read_envelope(&mut self) -> Result<Option<RawEnvelope>, WireError> {
        match self.read_frame().await? {
            Some(frame) => Ok(Some(decode(&frame)?)),
            None => Ok(None),
        }
    }

    pub fn into_inner(self) -> R {
        self.inner
    }
}

/// Writes whole frames to a byte stream.
pub struct FrameWriter<W> {
    inner: W,
}

impl<W: AsyncWrite + Unpin> FrameWriter<W> {
    pub fn new(inner: W) -> Self {
        FrameWriter { inner }
    }

    pub async fn write_frame(&mut self, payload: &[u8]) -> Result<(), WireError> {
        if payload.len() > MAX_FRAME {
            return Err(WireError::FrameTooLarge(payload.len()));
        }
        self.inner.write_all(&(payload.len() as u32).to_be_bytes()).await?;
        self.inner.write_all(payload).await?;
        Ok(())
    }

    /// Encodes and writes `value` as one frame.
    pub async fn write_message<T: ToValue + ?Sized>(&mut self, value: &T) -> Result<(), WireError> {
        let payload = encode(value)?;
        self.write_frame(&payload).await
    }

    pub async fn flush(&mut self) -> Result<(), WireError> {
        self.inner.flush().await?;
        Ok(())
    }

    pub fn into_inner(self) -> W {
        self.inner
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    crate::wire_struct! {
        #[derive(Debug, Clone, PartialEq)]
        struct Payload {
            name: String,
            cwd: Option<String>,
            data: Vec<u8>,
        }
    }

    #[test]
    fn envelope_round_trip_and_subset() {
        let env = Envelope::new(
            "exec_output",
            7,
            Payload { name: "x".into(), cwd: None, data: vec![1, 2, 3] },
        );
        let bytes = encode(&env).unwrap();
        // no `cwd` key, data as a byte string (major type 2, length 3)
        assert!(!bytes.windows(3).any(|w| w == b"cwd"));
        assert!(bytes.windows(4).any(|w| w == [0x43, 1, 2, 3]));
        let raw: RawEnvelope = decode(&bytes).unwrap();
        assert_eq!(raw.t, "exec_output");
        assert_eq!(raw.id, 7);
        let p: Payload = raw.payload().unwrap();
        assert_eq!(p, env.p);
    }

    #[tokio::test]
    async fn frames_and_oversize_skip() {
        let (a, b) = tokio::io::duplex(1024);
        let writer = tokio::spawn(async move {
            let mut w = FrameWriter::new(a);
            w.write_frame(b"one").await.unwrap();
            // a hand-made oversized frame header followed by its payload
            let big = vec![0u8; MAX_FRAME + 1];
            let mut raw = w.into_inner();
            raw.write_all(&((MAX_FRAME + 1) as u32).to_be_bytes()).await.unwrap();
            raw.write_all(&big).await.unwrap();
            let mut w = FrameWriter::new(raw);
            w.write_frame(b"two").await.unwrap();
        });
        let mut r = FrameReader::new(b);
        assert_eq!(&r.read_frame().await.unwrap().unwrap()[..], b"one");
        assert_eq!(&r.read_frame().await.unwrap().unwrap()[..], b"two");
        assert_eq!(r.skipped_frames, 1);
        writer.await.unwrap();
        assert!(r.read_frame().await.unwrap().is_none());
    }
}

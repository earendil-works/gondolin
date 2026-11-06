//! Framing shared by every gondolind protocol: a `u32` big-endian length
//! followed by one CBOR item (`guest/ARCHITECTURE.md` §3.2), plus the
//! `{ v, t, id, p }` message envelope (§3.4) used by the guest protocols and the
//! controller protocol (`native/DESIGN.md`).
//!
//! CBOR is produced and consumed through serde (`ciborium`). Encoders must
//! follow the guest's CBOR subset (§3.3) when talking to the guest: omit absent
//! optional fields (`#[serde(skip_serializing_if = "Option::is_none")]`), use
//! byte strings for raw data (`serde_bytes`), and never emit floats.

use std::io;

use bytes::{Buf, Bytes, BytesMut};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub use ciborium::Value;

/// Maximum frame payload in `bytes`, the same limit as the guest protocols.
pub const MAX_FRAME: usize = 4 * 1024 * 1024;

/// Errors of encoding, decoding and frame I/O.
#[derive(Debug, thiserror::Error)]
pub enum WireError {
    #[error("i/o error: {0}")]
    Io(#[from] io::Error),
    #[error("cbor encode error: {0}")]
    Encode(String),
    #[error("cbor decode error: {0}")]
    Decode(String),
    #[error("frame of {0} bytes exceeds the {MAX_FRAME} byte limit")]
    FrameTooLarge(usize),
}

/// Encodes `value` as one CBOR item.
pub fn encode<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>, WireError> {
    let mut out = Vec::new();
    ciborium::into_writer(value, &mut out).map_err(|e| WireError::Encode(e.to_string()))?;
    Ok(out)
}

/// Decodes one CBOR item from `bytes` (trailing bytes are ignored).
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, WireError> {
    ciborium::from_reader(bytes).map_err(|e| WireError::Decode(e.to_string()))
}

/// Converts a decoded CBOR value into a typed value.
pub fn from_value<T: DeserializeOwned>(value: Value) -> Result<T, WireError> {
    value.deserialized().map_err(|e| WireError::Decode(e.to_string()))
}

/// Converts a typed value into a CBOR value.
pub fn to_value<T: Serialize + ?Sized>(value: &T) -> Result<Value, WireError> {
    Value::serialized(value).map_err(|e| WireError::Encode(e.to_string()))
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

/// An envelope whose payload is kept as a CBOR value, for dispatch on `t`.
pub type RawEnvelope = Envelope<Value>;

impl RawEnvelope {
    /// Decodes the payload as `P`.
    pub fn payload<P: DeserializeOwned>(&self) -> Result<P, WireError> {
        from_value(self.p.clone())
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
    pub async fn write_message<T: Serialize + ?Sized>(
        &mut self,
        value: &T,
    ) -> Result<(), WireError> {
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

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Payload {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        cwd: Option<String>,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
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

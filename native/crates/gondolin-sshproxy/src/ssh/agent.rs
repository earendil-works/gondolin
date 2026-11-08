//! ssh-agent client (draft-miller-ssh-agent): list identities, sign.

use std::path::Path;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use super::Error;
use super::wire::{Reader, Writer};

pub const FAILURE: u8 = 5;
pub const REQUEST_IDENTITIES: u8 = 11;
pub const IDENTITIES_ANSWER: u8 = 12;
pub const SIGN_REQUEST: u8 = 13;
pub const SIGN_RESPONSE: u8 = 14;
/// sign flag: `rsa-sha2-256`
pub const RSA_SHA2_256: u32 = 2;
/// sign flag: `rsa-sha2-512`
pub const RSA_SHA2_512: u32 = 4;

/// Largest agent message we accept in `bytes`.
pub const MAX_MESSAGE: usize = 256 * 1024;

/// An identity the agent holds.
#[derive(Debug, Clone)]
pub struct Identity {
    /// public key blob (may be a type we cannot use, e.g. a certificate)
    pub blob: Vec<u8>,
    pub comment: String,
}

pub fn parse_identities(payload: &[u8]) -> Result<Vec<Identity>, Error> {
    let mut r = Reader::new(payload);
    if r.u8()? != IDENTITIES_ANSWER {
        return Err(Error::Protocol("agent refused to list identities".into()));
    }
    let n = r.u32()?;
    let mut out = Vec::new();
    for _ in 0..n.min(1024) {
        let blob = r.string()?.to_vec();
        let comment = r.text()?;
        out.push(Identity { blob, comment });
    }
    Ok(out)
}

pub fn sign_request(blob: &[u8], data: &[u8], flags: u32) -> Vec<u8> {
    let mut w = Writer::msg(SIGN_REQUEST);
    w.string(blob).string(data).u32(flags);
    w.finish()
}

pub fn parse_sign_response(payload: &[u8]) -> Result<Vec<u8>, Error> {
    let mut r = Reader::new(payload);
    if r.u8()? != SIGN_RESPONSE {
        return Err(Error::Protocol("agent refused to sign".into()));
    }
    Ok(r.string()?.to_vec())
}

/// Reads one length-prefixed agent message.
pub async fn read_message<S: tokio::io::AsyncRead + Unpin>(s: &mut S) -> std::io::Result<Vec<u8>> {
    let len = s.read_u32().await? as usize;
    if len == 0 || len > MAX_MESSAGE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bad agent message length",
        ));
    }
    let mut buf = vec![0u8; len];
    s.read_exact(&mut buf).await?;
    Ok(buf)
}

pub async fn write_message<S: tokio::io::AsyncWrite + Unpin>(
    s: &mut S,
    payload: &[u8],
) -> std::io::Result<()> {
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    s.write_all(&frame).await
}

pub struct AgentClient {
    stream: UnixStream,
}

fn io(e: std::io::Error) -> Error {
    Error::Io(e.to_string())
}

impl AgentClient {
    pub async fn connect(path: &Path) -> std::io::Result<AgentClient> {
        Ok(AgentClient { stream: UnixStream::connect(path).await? })
    }

    async fn call(&mut self, request: &[u8]) -> Result<Vec<u8>, Error> {
        write_message(&mut self.stream, request).await.map_err(io)?;
        read_message(&mut self.stream).await.map_err(io)
    }

    pub async fn identities(&mut self) -> Result<Vec<Identity>, Error> {
        let reply = self.call(&[REQUEST_IDENTITIES]).await?;
        parse_identities(&reply)
    }

    /// Signs `data` with the key `blob`; returns the signature blob.
    pub async fn sign(&mut self, blob: &[u8], data: &[u8], flags: u32) -> Result<Vec<u8>, Error> {
        let reply = self.call(&sign_request(blob, data, flags)).await?;
        parse_sign_response(&reply)
    }
}

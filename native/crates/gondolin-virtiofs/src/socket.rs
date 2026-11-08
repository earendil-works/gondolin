//! FUSE over a stream socket: the transport of libkrun's virtio-fs device
//! with gondolin's `krun_add_virtiofs_socket` patch
//! (`host/krun-runner/patches`). The VMM owns the virtqueues and forwards
//! every request as one frame; replies go back in order.
//!
//! Request frame (little-endian `u32`s): `len` (bytes after this field),
//! `queue`, `reply_capacity`, then the FUSE request. Reply frame: `len` (at
//! most `reply_capacity`), then the FUSE reply (empty for FORGET and other
//! requests without a reply).

use std::io::{self, Read, Write};

use crate::vhost_user::QueueHandler;
use crate::virtq::Writer;

/// Largest request or reply accepted, in `bytes` (the VMM's own limit).
pub const MAX_FRAME: usize = 64 << 20;

/// Serves one VMM connection until it closes (`Ok`) or breaks the framing.
pub fn serve<H: QueueHandler, S: Read + Write>(handler: &H, mut conn: S) -> io::Result<()> {
    let mut request = Vec::new();
    let mut reply = Vec::new();
    loop {
        let mut header = [0u8; 12];
        match conn.read_exact(&mut header[..4]) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e),
        }
        conn.read_exact(&mut header[4..])?;
        let u32_at = |i: usize| u32::from_le_bytes(header[i..i + 4].try_into().unwrap()) as usize;
        let (len, queue, capacity) = (u32_at(0), u32_at(4), u32_at(8));
        if !(8..=MAX_FRAME + 8).contains(&len) || capacity > MAX_FRAME {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid virtio-fs frame"));
        }
        request.resize(len - 8, 0);
        conn.read_exact(&mut request)?;
        // reused across requests; only the written part goes back
        if reply.len() < capacity {
            reply.resize(capacity, 0);
        }
        let mut writer = Writer::new(vec![&mut reply[..capacity]]);
        let written = handler.handle(queue, &request, &mut writer).min(capacity);
        conn.write_all(&(written as u32).to_le_bytes())?;
        conn.write_all(&reply[..written])?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Echoes the request reversed, as much as fits.
    struct Reverse;

    impl QueueHandler for Reverse {
        fn handle(&self, queue: usize, request: &[u8], reply: &mut Writer<'_>) -> usize {
            let mut out: Vec<u8> = request.iter().rev().copied().collect();
            out.push(queue as u8);
            reply.write(&out)
        }
    }

    fn frame(queue: u32, capacity: u32, body: &[u8]) -> Vec<u8> {
        let mut f = Vec::new();
        f.extend_from_slice(&(8 + body.len() as u32).to_le_bytes());
        f.extend_from_slice(&queue.to_le_bytes());
        f.extend_from_slice(&capacity.to_le_bytes());
        f.extend_from_slice(body);
        f
    }

    #[test]
    fn round_trips_in_order() {
        let (mut vmm, daemon) = std::os::unix::net::UnixStream::pair().unwrap();
        let server = std::thread::spawn(move || serve(&Reverse, daemon));
        vmm.write_all(&frame(1, 64, b"abc")).unwrap();
        vmm.write_all(&frame(0, 2, b"xyz")).unwrap();
        vmm.write_all(&frame(1, 0, b"")).unwrap();
        let mut read = |expected: &[u8]| {
            let mut len = [0u8; 4];
            vmm.read_exact(&mut len).unwrap();
            let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
            vmm.read_exact(&mut body).unwrap();
            assert_eq!(body, expected);
        };
        read(b"cba\x01");
        read(b"zy");
        read(b"");
        drop(vmm);
        server.join().unwrap().unwrap();
    }

    #[test]
    fn rejects_bad_frames() {
        let (mut vmm, daemon) = std::os::unix::net::UnixStream::pair().unwrap();
        let server = std::thread::spawn(move || serve(&Reverse, daemon));
        vmm.write_all(&4u32.to_le_bytes()).unwrap();
        vmm.write_all(&[0u8; 8]).unwrap();
        assert!(server.join().unwrap().is_err());
    }
}

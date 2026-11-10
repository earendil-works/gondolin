//! Datagram transport for [`crate::NetStack::serve_frames`]: one Ethernet
//! frame per receive/send, as from a tap device or a packet socket bound to
//! one, instead of QEMU's length-prefixed stream.

use std::io;
use std::task::{Context, Poll};

/// A socket that carries one Ethernet frame per datagram.
///
/// When [`FrameSocket::vnet_hdr`] is true every received datagram starts with
/// a Linux `virtio_net_hdr` ([`crate::offload::VNET_HDR_LEN`] bytes) describing
/// pending checksum/segmentation offloads, and every sent datagram must start
/// with one too (the stack sends an all-zero header: nothing offloaded).
pub trait FrameSocket: Send + Sync + 'static {
    /// Receives one datagram into `buf`, registering `cx` when none is ready.
    fn poll_recv_frame(&self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>>;

    /// Receives one datagram without waiting (`WouldBlock` when none is ready).
    fn try_recv_frame(&self, buf: &mut [u8]) -> io::Result<usize>;

    /// Sends one datagram, registering `cx` when the socket is not writable.
    fn poll_send_frame(&self, cx: &mut Context<'_>, frame: &[u8]) -> Poll<io::Result<usize>>;

    /// Whether datagrams carry a `virtio_net_hdr`.
    fn vnet_hdr(&self) -> bool {
        false
    }
}

impl FrameSocket for tokio::net::UnixDatagram {
    fn poll_recv_frame(&self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        let mut rb = tokio::io::ReadBuf::new(buf);
        match tokio::net::UnixDatagram::poll_recv(self, cx, &mut rb) {
            Poll::Ready(Ok(())) => Poll::Ready(Ok(rb.filled().len())),
            Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
            Poll::Pending => Poll::Pending,
        }
    }

    fn try_recv_frame(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.try_recv(buf)
    }

    fn poll_send_frame(&self, cx: &mut Context<'_>, frame: &[u8]) -> Poll<io::Result<usize>> {
        tokio::net::UnixDatagram::poll_send(self, cx, frame)
    }
}

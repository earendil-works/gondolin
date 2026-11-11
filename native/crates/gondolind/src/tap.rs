//! Network plumbing of the Firecracker backend: a tap device in a private
//! network namespace, served to the network stack through a packet socket.
//!
//! Firecracker attaches the VM's virtio-net device to a tap by name. The
//! daemon creates that tap (persistent, so Firecracker can open it) and
//! reads/writes the guest's frames with an `AF_PACKET` socket bound to it
//! ([`PacketSocket`], a `FrameSocket` for `NetStack::serve_frames`).
//! Firecracker enables checksum and segmentation offloads towards the tap, so
//! the socket uses `PACKET_VNET_HDR` and the stack expands offloaded frames
//! (`gondolin_netstack::offload`).
//!
//! The tap is a kernel interface, but the guest must not reach the host
//! through it: the network stack has to stay the only way out. So the tap
//! lives in a network namespace of its own ([`TapNet`]) that has nothing but
//! the tap: no addresses, no routes, no other interfaces. Whatever the guest
//! sends to the tap's MAC address, the kernel has nothing to deliver it to
//! and nowhere to route it, independent of sysctls (which udev may rewrite
//! for new interfaces). Firecracker is started inside the namespace (it opens
//! the tap by name there); the packet socket is created there and stays bound
//! to it. The namespace, and the tap with it, disappears once the daemon's
//! descriptors are closed and Firecracker has exited.
//!
//! Needs `CAP_SYS_ADMIN` (new namespace), `CAP_NET_ADMIN` (tap) and
//! `CAP_NET_RAW` (packet socket): the daemon runs as root for this backend.

#[cfg(target_os = "linux")]
pub use linux::{PacketSocket, TapNet};

/// A name for this daemon's `n`-th tap (`IFNAMSIZ`: at most 15 bytes).
pub fn tap_name(pid: u32, n: u32) -> String {
    format!("gfc{:x}x{:x}", pid & 0xff_ffff, n & 0xf_ffff)
}

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::CString;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::task::{Context, Poll};

    use gondolin_netstack::FrameSocket;
    use tokio::io::unix::AsyncFd;

    const IFNAMSIZ: usize = 16;
    const TUNSETIFF: libc::c_ulong = 0x4004_54ca;
    const TUNSETPERSIST: libc::c_ulong = 0x4004_54cb;
    const TUNSETOWNER: libc::c_ulong = 0x4004_54cc;
    const TUNSETGROUP: libc::c_ulong = 0x4004_54ce;
    const IFF_TAP: libc::c_short = 0x0002;
    const IFF_NO_PI: libc::c_short = 0x1000;
    const IFF_VNET_HDR: libc::c_short = 0x4000;
    const PACKET_VNET_HDR: libc::c_int = 15;
    const PACKET_IGNORE_OUTGOING: libc::c_int = 23;
    const ETH_P_ALL: u16 = 0x0003;
    /// socket buffer sizes in `bytes` (bursts of 64 KiB offloaded frames)
    const SOCKET_BUFFER: libc::c_int = 8 * 1024 * 1024;

    #[repr(C)]
    struct IfReqFlags {
        name: [libc::c_char; IFNAMSIZ],
        flags: libc::c_short,
        _pad: [u8; 22],
    }

    fn ifreq(name: &str, flags: libc::c_short) -> io::Result<IfReqFlags> {
        if name.is_empty() || name.len() >= IFNAMSIZ || name.contains('/') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid tap name {name:?}"),
            ));
        }
        let mut req = IfReqFlags { name: [0; IFNAMSIZ], flags, _pad: [0; 22] };
        for (dst, src) in req.name.iter_mut().zip(name.bytes()) {
            *dst = src as libc::c_char;
        }
        Ok(req)
    }

    fn cvt(rc: libc::c_int) -> io::Result<libc::c_int> {
        if rc < 0 { Err(io::Error::last_os_error()) } else { Ok(rc) }
    }

    /// Opens `/dev/net/tun` attached to tap `name` (creating it if needed).
    fn attach(name: &str) -> io::Result<OwnedFd> {
        // SAFETY: plain open(2) of a NUL-terminated path.
        let fd =
            cvt(unsafe { libc::open(c"/dev/net/tun".as_ptr(), libc::O_RDWR | libc::O_CLOEXEC) })
                .map_err(|e| io::Error::new(e.kind(), format!("cannot open /dev/net/tun: {e}")))?;
        // SAFETY: we own the fresh descriptor.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let mut req = ifreq(name, IFF_TAP | IFF_NO_PI | IFF_VNET_HDR)?;
        // SAFETY: TUNSETIFF reads/writes an ifreq.
        cvt(unsafe { libc::ioctl(fd.as_raw_fd(), TUNSETIFF as _, &mut req) })?;
        Ok(fd)
    }

    fn set_persist(fd: &OwnedFd, persist: bool) -> io::Result<()> {
        // SAFETY: TUNSETPERSIST takes an integer argument.
        cvt(unsafe {
            libc::ioctl(fd.as_raw_fd(), TUNSETPERSIST as _, libc::c_ulong::from(persist))
        })?;
        Ok(())
    }

    /// Sets `IFF_UP | IFF_NOARP` on interface `name`.
    fn bring_up(name: &str) -> io::Result<()> {
        // SAFETY: socket(2) for interface ioctls.
        let sock =
            cvt(unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) })?;
        // SAFETY: we own the fresh descriptor.
        let sock = unsafe { OwnedFd::from_raw_fd(sock) };
        let mut req = ifreq(name, 0)?;
        // SAFETY: SIOCGIFFLAGS/SIOCSIFFLAGS read/write an ifreq.
        cvt(unsafe { libc::ioctl(sock.as_raw_fd(), libc::SIOCGIFFLAGS as _, &mut req) })?;
        req.flags |= (libc::IFF_UP | libc::IFF_NOARP) as libc::c_short;
        cvt(unsafe { libc::ioctl(sock.as_raw_fd(), libc::SIOCSIFFLAGS as _, &mut req) })?;
        Ok(())
    }

    /// A tap in a network namespace of its own, with the packet socket that
    /// serves it (see the module docs).
    pub struct TapNet {
        name: String,
        /// the namespace (`/proc/thread-self/ns/net` of the creating thread)
        netns: OwnedFd,
        /// packet socket bound to the tap, until [`TapNet::take_socket`]
        socket: Option<OwnedFd>,
    }

    impl TapNet {
        /// Creates a namespace holding tap `name` (up, no addresses, no ARP,
        /// IPv6 off) and a packet socket bound to it. With `owner`
        /// (uid, gid) that user can attach to the tap without privileges
        /// (a jailed Firecracker).
        pub fn create(name: &str, owner: Option<(u32, u32)>) -> io::Result<TapNet> {
            let name = name.to_string();
            ifreq(&name, 0)?; // validate the name before doing anything
            // namespaces are per thread: do the setup on a thread that leaves
            // the daemon's namespace and exits afterwards
            let thread_name = name.clone();
            let (netns, socket) = std::thread::Builder::new()
                .name("tap-netns".into())
                .spawn(move || -> io::Result<(OwnedFd, OwnedFd)> {
                    let name = thread_name;
                    // SAFETY: unshare only affects this thread.
                    cvt(unsafe { libc::unshare(libc::CLONE_NEWNET) }).map_err(|e| {
                        io::Error::new(
                            e.kind(),
                            format!("cannot create a network namespace (needs CAP_SYS_ADMIN): {e}"),
                        )
                    })?;
                    // SAFETY: plain open(2) of a NUL-terminated path.
                    let ns = cvt(unsafe {
                        libc::open(
                            c"/proc/thread-self/ns/net".as_ptr(),
                            libc::O_RDONLY | libc::O_CLOEXEC,
                        )
                    })?;
                    // SAFETY: we own the fresh descriptor.
                    let ns = unsafe { OwnedFd::from_raw_fd(ns) };
                    let fd = attach(&name).map_err(|e| {
                        io::Error::new(
                            e.kind(),
                            format!("cannot create tap {name} (needs CAP_NET_ADMIN): {e}"),
                        )
                    })?;
                    if let Some((uid, gid)) = owner {
                        // SAFETY: TUNSETOWNER/TUNSETGROUP take an integer.
                        cvt(unsafe {
                            libc::ioctl(fd.as_raw_fd(), TUNSETOWNER as _, libc::c_ulong::from(uid))
                        })?;
                        cvt(unsafe {
                            libc::ioctl(fd.as_raw_fd(), TUNSETGROUP as _, libc::c_ulong::from(gid))
                        })?;
                    }
                    set_persist(&fd, true)?;
                    drop(fd);
                    // /proc/sys/net shows the namespace of the opening thread;
                    // no IPv6 autoconfiguration or neighbour discovery on the
                    // tap (absent when IPv6 is disabled)
                    let ipv6 = format!("/proc/sys/net/ipv6/conf/{name}/disable_ipv6");
                    if std::path::Path::new(&ipv6).exists() {
                        std::fs::write(&ipv6, "1")
                            .map_err(|e| io::Error::new(e.kind(), format!("{ipv6}: {e}")))?;
                    }
                    bring_up(&name)?;
                    let socket = packet_socket(interface_index(&name)?)?;
                    Ok((ns, socket))
                })?
                .join()
                .map_err(|_| io::Error::other("tap setup thread panicked"))??;
            Ok(TapNet { name, netns, socket: Some(socket) })
        }

        pub fn name(&self) -> &str {
            &self.name
        }

        /// The namespace Firecracker must run in (`VmmProcess::spawn_in`).
        pub fn netns(&self) -> std::os::fd::RawFd {
            self.netns.as_raw_fd()
        }

        /// The packet socket (once; must run inside a tokio runtime).
        pub fn take_socket(&mut self) -> io::Result<PacketSocket> {
            let fd = self
                .socket
                .take()
                .ok_or_else(|| io::Error::other("packet socket already taken"))?;
            // SAFETY: `fd` is a valid socket owned by the AsyncFd, never
            // replaced or closed while registered.
            Ok(PacketSocket { fd: unsafe { AsyncFd::register(fd)? } })
        }
    }

    fn interface_index(name: &str) -> io::Result<u32> {
        let cname = CString::new(name).expect("validated name");
        // SAFETY: NUL-terminated name.
        match unsafe { libc::if_nametoindex(cname.as_ptr()) } {
            0 => Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("tap {name}: {}", io::Error::last_os_error()),
            )),
            index => Ok(index),
        }
    }

    /// `AF_PACKET` socket bound to a tap, carrying `virtio_net_hdr` frames.
    pub struct PacketSocket {
        fd: AsyncFd<OwnedFd>,
    }

    fn setsockopt_int(
        fd: &OwnedFd,
        level: libc::c_int,
        name: libc::c_int,
        value: libc::c_int,
    ) -> io::Result<()> {
        // SAFETY: setsockopt with an int option.
        cvt(unsafe {
            libc::setsockopt(
                fd.as_raw_fd(),
                level,
                name,
                (&raw const value).cast(),
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            )
        })?;
        Ok(())
    }

    /// `AF_PACKET` socket bound to interface `index` (of the calling
    /// thread's namespace), non-blocking.
    fn packet_socket(index: u32) -> io::Result<OwnedFd> {
        let protocol = ETH_P_ALL.to_be();
        // Protocol 0: the socket receives nothing until `bind` sets the
        // protocol and the interface. Opened with ETH_P_ALL it would see
        // every interface's frames until then, and the bind would have to
        // unhook it first, which waits for an RCU grace period (~65 ms).
        // SAFETY: socket(2).
        let raw = cvt(unsafe {
            libc::socket(
                libc::AF_PACKET,
                libc::SOCK_RAW | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
                0,
            )
        })
        .map_err(|e| {
            io::Error::new(
                e.kind(),
                format!("cannot open a packet socket (needs CAP_NET_RAW): {e}"),
            )
        })?;
        // SAFETY: we own the fresh descriptor.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        setsockopt_int(&fd, libc::SOL_PACKET, PACKET_VNET_HDR, 1)?;
        // frames we send would otherwise come back to us
        setsockopt_int(&fd, libc::SOL_PACKET, PACKET_IGNORE_OUTGOING, 1)?;
        // best effort: *FORCE ignores rmem_max/wmem_max (needs CAP_NET_ADMIN)
        for (force, plain) in
            [(libc::SO_RCVBUFFORCE, libc::SO_RCVBUF), (libc::SO_SNDBUFFORCE, libc::SO_SNDBUF)]
        {
            if setsockopt_int(&fd, libc::SOL_SOCKET, force, SOCKET_BUFFER).is_err() {
                let _ = setsockopt_int(&fd, libc::SOL_SOCKET, plain, SOCKET_BUFFER);
            }
        }
        // SAFETY: zeroed sockaddr_ll is valid; we fill the fields we use.
        let mut addr: libc::sockaddr_ll = unsafe { std::mem::zeroed() };
        addr.sll_family = libc::AF_PACKET as u16;
        addr.sll_protocol = protocol;
        addr.sll_ifindex = index as i32;
        // SAFETY: bind with a sockaddr_ll of the right size.
        cvt(unsafe {
            libc::bind(
                fd.as_raw_fd(),
                (&raw const addr).cast(),
                std::mem::size_of::<libc::sockaddr_ll>() as libc::socklen_t,
            )
        })?;
        Ok(fd)
    }

    impl PacketSocket {
        fn recv_raw(fd: &OwnedFd, buf: &mut [u8]) -> io::Result<usize> {
            loop {
                // SAFETY: recv into a valid buffer.
                let n =
                    unsafe { libc::recv(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len(), 0) };
                if n >= 0 {
                    return Ok(n as usize);
                }
                let err = io::Error::last_os_error();
                if err.kind() != io::ErrorKind::Interrupted {
                    return Err(err);
                }
            }
        }

        fn send_raw(fd: &OwnedFd, frame: &[u8]) -> io::Result<usize> {
            loop {
                // SAFETY: send from a valid buffer.
                let n =
                    unsafe { libc::send(fd.as_raw_fd(), frame.as_ptr().cast(), frame.len(), 0) };
                if n >= 0 {
                    return Ok(n as usize);
                }
                let err = io::Error::last_os_error();
                match err.raw_os_error() {
                    Some(libc::EINTR) => continue,
                    // the tap is not attached yet (VM booting or restarting):
                    // the frame is lost, as on a link without carrier
                    Some(libc::ENETDOWN) | Some(libc::ENXIO) => return Ok(frame.len()),
                    _ => return Err(err),
                }
            }
        }
    }

    impl FrameSocket for PacketSocket {
        fn poll_recv_frame(&self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
            loop {
                let mut guard = match self.fd.poll_read_ready(cx) {
                    Poll::Ready(Ok(guard)) => guard,
                    Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                    Poll::Pending => return Poll::Pending,
                };
                match guard.try_io(|fd| Self::recv_raw(fd.get_ref(), buf)) {
                    Ok(result) => return Poll::Ready(result),
                    Err(_would_block) => continue,
                }
            }
        }

        fn try_recv_frame(&self, buf: &mut [u8]) -> io::Result<usize> {
            Self::recv_raw(self.fd.get_ref(), buf)
        }

        fn poll_send_frame(&self, cx: &mut Context<'_>, frame: &[u8]) -> Poll<io::Result<usize>> {
            loop {
                let mut guard = match self.fd.poll_write_ready(cx) {
                    Poll::Ready(Ok(guard)) => guard,
                    Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                    Poll::Pending => return Poll::Pending,
                };
                match guard.try_io(|fd| Self::send_raw(fd.get_ref(), frame)) {
                    Ok(result) => return Poll::Ready(result),
                    Err(_would_block) => continue,
                }
            }
        }

        fn vnet_hdr(&self) -> bool {
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tap_names_fit_ifnamsiz() {
        assert_eq!(tap_name(0x1234, 1), "gfc1234x1");
        assert!(tap_name(u32::MAX, u32::MAX).len() <= 15);
    }
}

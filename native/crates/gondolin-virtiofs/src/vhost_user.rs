//! Minimal vhost-user backend (device side) over a unix socket: enough of the
//! protocol for QEMU's `vhost-user-fs-pci` on Linux and macOS (QEMU >= 9.1
//! built with `--enable-vhost-user`, guest RAM in `memory-backend-shm` or
//! `memory-backend-memfd`). Kick/call notifiers may be eventfds (Linux) or
//! pipes (macOS); both are driven with plain `read`/`write`.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crate::virtq::{Memory, Region, Vring};

const GET_FEATURES: u32 = 1;
const SET_FEATURES: u32 = 2;
const SET_OWNER: u32 = 3;
const RESET_OWNER: u32 = 4;
const SET_MEM_TABLE: u32 = 5;
const SET_VRING_NUM: u32 = 8;
const SET_VRING_ADDR: u32 = 9;
const SET_VRING_BASE: u32 = 10;
const GET_VRING_BASE: u32 = 11;
const SET_VRING_KICK: u32 = 12;
const SET_VRING_CALL: u32 = 13;
const SET_VRING_ERR: u32 = 14;
const GET_PROTOCOL_FEATURES: u32 = 15;
const SET_PROTOCOL_FEATURES: u32 = 16;
const GET_QUEUE_NUM: u32 = 17;
const SET_VRING_ENABLE: u32 = 18;

const FLAG_VERSION: u32 = 0x1;
const FLAG_REPLY: u32 = 0x4;
const FLAG_NEED_REPLY: u32 = 0x8;

const VIRTIO_F_VERSION_1: u64 = 1 << 32;
const VHOST_USER_F_PROTOCOL_FEATURES: u64 = 1 << 30;
const PROTOCOL_F_MQ: u64 = 1 << 0;
const PROTOCOL_F_REPLY_ACK: u64 = 1 << 3;

/// Handles the requests of one virtqueue (FUSE for virtio-fs).
pub trait QueueHandler: Send + Sync + 'static {
    /// `request`: the device-readable bytes of a descriptor chain; the reply
    /// is written to `reply` (device-writable space of `reply_capacity` bytes).
    /// Returns the number of bytes written.
    fn handle(&self, queue: usize, request: &[u8], reply: &mut crate::virtq::Writer<'_>) -> usize;
}

struct QueueThread {
    stop: Arc<AtomicBool>,
    join: JoinHandle<Vring>,
}

/// One vhost-user connection.
pub struct Backend<H: QueueHandler> {
    handler: Arc<H>,
    num_queues: usize,
    memory: Arc<Mutex<Option<Arc<Memory>>>>,
    rings: Vec<Option<Vring>>,
    threads: Vec<Option<QueueThread>>,
    acked_protocol: u64,
}

/// `(request, flags, payload, fds)` of one vhost-user message.
type Message = (u32, u32, Vec<u8>, Vec<OwnedFd>);

fn recv_msg(sock: &UnixStream) -> io::Result<Option<Message>> {
    let mut header = [0u8; 12];
    let fds = recv_with_fds(sock, &mut header)?;
    let Some(fds) = fds else { return Ok(None) };
    let request = u32::from_le_bytes(header[0..4].try_into().unwrap());
    let flags = u32::from_le_bytes(header[4..8].try_into().unwrap());
    let size = u32::from_le_bytes(header[8..12].try_into().unwrap()) as usize;
    let mut payload = vec![0u8; size];
    let mut fds = fds;
    if size > 0 {
        let extra = recv_with_fds(sock, &mut payload)?.ok_or_else(|| {
            io::Error::new(io::ErrorKind::UnexpectedEof, "short vhost-user message")
        })?;
        fds.extend(extra);
    }
    Ok(Some((request, flags, payload, fds)))
}

/// Receives exactly `buf.len()` bytes plus any fds; `None` on EOF at start.
fn recv_with_fds(sock: &UnixStream, buf: &mut [u8]) -> io::Result<Option<Vec<OwnedFd>>> {
    let mut fds = Vec::new();
    let mut filled = 0;
    while filled < buf.len() {
        let mut iov = libc::iovec {
            iov_base: buf[filled..].as_mut_ptr().cast(),
            iov_len: buf.len() - filled,
        };
        let mut cmsg = [0u64; 64];
        let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = cmsg.as_mut_ptr().cast();
        msg.msg_controllen = std::mem::size_of_val(&cmsg) as _;
        let n = unsafe { libc::recvmsg(sock.as_raw_fd(), &mut msg, 0) };
        if n < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        if n == 0 {
            if filled == 0 {
                return Ok(None);
            }
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "vhost-user peer closed"));
        }
        unsafe {
            let mut c = libc::CMSG_FIRSTHDR(&msg);
            while !c.is_null() {
                if (*c).cmsg_level == libc::SOL_SOCKET && (*c).cmsg_type == libc::SCM_RIGHTS {
                    let data = libc::CMSG_DATA(c) as *const RawFd;
                    let count = ((*c).cmsg_len as usize - libc::CMSG_LEN(0) as usize)
                        / std::mem::size_of::<RawFd>();
                    for i in 0..count {
                        fds.push(OwnedFd::from_raw_fd(*data.add(i)));
                    }
                }
                c = libc::CMSG_NXTHDR(&msg, c);
            }
        }
        filled += n as usize;
    }
    Ok(Some(fds))
}

fn send_reply(sock: &UnixStream, request: u32, payload: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut out = Vec::with_capacity(12 + payload.len());
    out.extend_from_slice(&request.to_le_bytes());
    out.extend_from_slice(&(FLAG_VERSION | FLAG_REPLY).to_le_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    (&*sock).write_all(&out)
}

fn u32_at(p: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(p[off..off + 4].try_into().unwrap())
}

fn u64_at(p: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(p[off..off + 8].try_into().unwrap())
}

impl<H: QueueHandler> Backend<H> {
    pub fn new(handler: Arc<H>, num_queues: usize) -> Self {
        Backend {
            handler,
            num_queues,
            memory: Arc::new(Mutex::new(None)),
            rings: (0..num_queues).map(|_| Some(Vring::default())).collect(),
            threads: (0..num_queues).map(|_| None).collect(),
            acked_protocol: 0,
        }
    }

    /// Serves one frontend connection until it closes.
    pub fn serve(&mut self, sock: UnixStream) -> io::Result<()> {
        while let Some((request, flags, payload, fds)) = recv_msg(&sock)? {
            let result = self.dispatch(&sock, request, &payload, fds);
            let failed = result.is_err();
            if let Err(err) = &result {
                eprintln!("vhost-user: request {request} failed: {err}");
            }
            if flags & FLAG_NEED_REPLY != 0
                && self.acked_protocol & PROTOCOL_F_REPLY_ACK != 0
                && !matches!(
                    request,
                    GET_FEATURES | GET_PROTOCOL_FEATURES | GET_VRING_BASE | GET_QUEUE_NUM
                )
            {
                send_reply(&sock, request, &(failed as u64).to_le_bytes())?;
            }
        }
        for i in 0..self.num_queues {
            self.stop_queue(i);
        }
        Ok(())
    }

    fn ring(&mut self, index: usize) -> io::Result<&mut Vring> {
        self.rings.get_mut(index).and_then(|r| r.as_mut()).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, format!("bad or busy vring {index}"))
        })
    }

    fn dispatch(
        &mut self,
        sock: &UnixStream,
        request: u32,
        p: &[u8],
        mut fds: Vec<OwnedFd>,
    ) -> io::Result<()> {
        match request {
            GET_FEATURES => {
                let features = VIRTIO_F_VERSION_1 | VHOST_USER_F_PROTOCOL_FEATURES;
                send_reply(sock, request, &features.to_le_bytes())?;
            }
            SET_FEATURES | SET_OWNER | RESET_OWNER => {}
            GET_PROTOCOL_FEATURES => {
                send_reply(sock, request, &(PROTOCOL_F_MQ | PROTOCOL_F_REPLY_ACK).to_le_bytes())?;
            }
            SET_PROTOCOL_FEATURES => self.acked_protocol = u64_at(p, 0),
            GET_QUEUE_NUM => send_reply(sock, request, &(self.num_queues as u64).to_le_bytes())?,
            SET_MEM_TABLE => {
                let count = u32_at(p, 0) as usize;
                if fds.len() != count {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "mem table fd count mismatch",
                    ));
                }
                let mut regions = Vec::new();
                for (i, fd) in fds.drain(..).enumerate() {
                    let off = 8 + i * 32;
                    regions.push(Region::map(
                        fd,
                        u64_at(p, off),
                        u64_at(p, off + 8),
                        u64_at(p, off + 16),
                        u64_at(p, off + 24),
                    )?);
                }
                *self.memory.lock().unwrap() = Some(Arc::new(Memory { regions }));
            }
            SET_VRING_NUM => {
                let (index, num) = (u32_at(p, 0) as usize, u32_at(p, 4));
                self.ring(index)?.size = num as u16;
            }
            SET_VRING_ADDR => {
                let index = u32_at(p, 0) as usize;
                let ring = self.ring(index)?;
                ring.desc = u64_at(p, 8);
                ring.used = u64_at(p, 16);
                ring.avail = u64_at(p, 24);
            }
            SET_VRING_BASE => {
                let (index, base) = (u32_at(p, 0) as usize, u32_at(p, 4));
                self.ring(index)?.last_avail = base as u16;
            }
            GET_VRING_BASE => {
                let index = u32_at(p, 0) as usize;
                self.stop_queue(index);
                let base = self.ring(index).map(|r| r.last_avail).unwrap_or(0);
                let mut reply = Vec::new();
                reply.extend_from_slice(&(index as u32).to_le_bytes());
                reply.extend_from_slice(&(base as u32).to_le_bytes());
                send_reply(sock, request, &reply)?;
            }
            SET_VRING_KICK | SET_VRING_CALL | SET_VRING_ERR => {
                let value = u64_at(p, 0);
                let index = (value & 0xff) as usize;
                let fd = if value & 0x100 != 0 { None } else { fds.pop() };
                if request == SET_VRING_KICK {
                    self.stop_queue(index);
                    self.ring(index)?.kick = fd;
                    // Without negotiated protocol features rings start on kick.
                    if self.acked_protocol == 0 || self.ring(index)?.enabled {
                        self.start_queue(index)?;
                    }
                } else if request == SET_VRING_CALL {
                    let running = self.threads.get(index).is_some_and(|t| t.is_some());
                    self.stop_queue(index);
                    self.ring(index)?.call = fd.map(Arc::new);
                    if running {
                        self.start_queue(index)?;
                    }
                }
            }
            SET_VRING_ENABLE => {
                let (index, enable) = (u32_at(p, 0) as usize, u32_at(p, 4) != 0);
                if enable {
                    self.ring(index)?.enabled = true;
                    if self.ring(index)?.kick.is_some() {
                        self.start_queue(index)?;
                    }
                } else {
                    self.stop_queue(index);
                    self.ring(index)?.enabled = false;
                }
            }
            other => {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    format!("unsupported vhost-user request {other}"),
                ));
            }
        }
        Ok(())
    }

    fn start_queue(&mut self, index: usize) -> io::Result<()> {
        if self.threads.get(index).is_some_and(|t| t.is_some()) {
            return Ok(());
        }
        let memory = self
            .memory
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no memory table"))?;
        let mut ring = self.rings[index].take().expect("ring present");
        if ring.size == 0 || ring.kick.is_none() {
            self.rings[index] = Some(ring);
            return Ok(());
        }
        let stop = Arc::new(AtomicBool::new(false));
        let handler = self.handler.clone();
        let thread_stop = stop.clone();
        let join =
            std::thread::Builder::new().name(format!("virtiofs-q{index}")).spawn(move || {
                ring.run(index, &memory, &*handler, &thread_stop);
                ring
            })?;
        self.threads[index] = Some(QueueThread { stop, join });
        Ok(())
    }

    fn stop_queue(&mut self, index: usize) {
        if let Some(Some(t)) = self.threads.get_mut(index).map(Option::take) {
            t.stop.store(true, Ordering::SeqCst);
            if let Ok(ring) = t.join.join() {
                self.rings[index] = Some(ring);
            }
        }
    }
}

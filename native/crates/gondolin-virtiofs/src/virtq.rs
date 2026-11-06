//! Guest memory mapping and split virtqueue processing (no indirect
//! descriptors, no event index: neither feature is offered).

use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering, fence};

use crate::vhost_user::QueueHandler;

/// One shared guest memory region mapped into this process.
pub struct Region {
    gpa: u64,
    size: u64,
    uaddr: u64,
    /// host address of `gpa`
    host: *mut u8,
    map: *mut libc::c_void,
    map_len: usize,
    _fd: OwnedFd,
}

unsafe impl Send for Region {}
unsafe impl Sync for Region {}

impl Region {
    pub fn map(fd: OwnedFd, gpa: u64, size: u64, uaddr: u64, offset: u64) -> io::Result<Region> {
        let map_len = (size + offset) as usize;
        let map = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                map_len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd.as_raw_fd(),
                0,
            )
        };
        if map == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }
        Ok(Region {
            gpa,
            size,
            uaddr,
            host: unsafe { (map as *mut u8).add(offset as usize) },
            map,
            map_len,
            _fd: fd,
        })
    }
}

impl Drop for Region {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.map, self.map_len);
        }
    }
}

/// Guest memory (the frontend's memory table).
pub struct Memory {
    pub regions: Vec<Region>,
}

impl Memory {
    /// Host pointer for `len` bytes at guest physical address `gpa`.
    pub fn gpa(&self, gpa: u64, len: u64) -> Option<*mut u8> {
        self.regions.iter().find_map(|r| {
            (gpa >= r.gpa && gpa.checked_add(len)? <= r.gpa + r.size)
                .then(|| unsafe { r.host.add((gpa - r.gpa) as usize) })
        })
    }

    /// Host pointer for a frontend virtual address (vring addresses).
    pub fn uaddr(&self, addr: u64, len: u64) -> Option<*mut u8> {
        self.regions.iter().find_map(|r| {
            (addr >= r.uaddr && addr.checked_add(len)? <= r.uaddr + r.size)
                .then(|| unsafe { r.host.add((addr - r.uaddr) as usize) })
        })
    }
}

/// Writes a reply across the device-writable buffers of a chain.
pub struct Writer<'a> {
    segments: Vec<(*mut u8, usize)>,
    seg: usize,
    off: usize,
    written: usize,
    _buffers: std::marker::PhantomData<&'a mut [u8]>,
}

impl<'a> Writer<'a> {
    /// A writer over plain buffers (tests, other transports).
    pub fn new(buffers: Vec<&'a mut [u8]>) -> Writer<'a> {
        Writer {
            segments: buffers.into_iter().map(|b| (b.as_mut_ptr(), b.len())).collect(),
            seg: 0,
            off: 0,
            written: 0,
            _buffers: std::marker::PhantomData,
        }
    }

    pub fn capacity(&self) -> usize {
        self.segments.iter().map(|s| s.1).sum::<usize>() - self.written
    }

    pub fn written(&self) -> usize {
        self.written
    }

    /// Mutable views of the `len` bytes that follow `skip` bytes after the
    /// current position, without advancing (zero-copy fills; see
    /// [`Writer::advance`] and [`Writer::patch`]).
    pub fn reserve(&mut self, skip: usize, len: usize) -> Vec<&'a mut [u8]> {
        let mut out = Vec::new();
        let (mut seg, mut off) = (self.seg, self.off);
        let mut skip = skip;
        let mut len = len;
        while seg < self.segments.len() && len > 0 {
            let (ptr, seg_len) = self.segments[seg];
            let avail = seg_len - off;
            if skip >= avail {
                skip -= avail;
                seg += 1;
                off = 0;
                continue;
            }
            let start = off + skip;
            skip = 0;
            let n = (seg_len - start).min(len);
            // SAFETY: the segment is guest memory validated for `seg_len`
            // bytes; views never overlap the header or each other.
            out.push(unsafe { std::slice::from_raw_parts_mut(ptr.add(start), n) });
            len -= n;
            seg += 1;
            off = 0;
        }
        out
    }

    /// Advances the position by `n` bytes filled through [`Writer::reserve`].
    pub fn advance(&mut self, mut n: usize) {
        self.written += n;
        while n > 0 && self.seg < self.segments.len() {
            let step = (self.segments[self.seg].1 - self.off).min(n);
            self.off += step;
            n -= step;
            if self.off == self.segments[self.seg].1 {
                self.seg += 1;
                self.off = 0;
            }
        }
    }

    /// Overwrites already written bytes at absolute position `pos`.
    pub fn patch(&mut self, mut pos: usize, mut data: &[u8]) {
        for &(ptr, len) in &self.segments {
            if data.is_empty() {
                break;
            }
            if pos >= len {
                pos -= len;
                continue;
            }
            let n = (len - pos).min(data.len());
            unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), ptr.add(pos), n) };
            data = &data[n..];
            pos = 0;
        }
    }

    /// Copies as much of `data` as fits; returns the bytes written.
    pub fn write(&mut self, mut data: &[u8]) -> usize {
        let mut total = 0;
        while !data.is_empty() && self.seg < self.segments.len() {
            let (ptr, len) = self.segments[self.seg];
            let n = (len - self.off).min(data.len());
            unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), ptr.add(self.off), n) };
            self.off += n;
            data = &data[n..];
            total += n;
            if self.off == len {
                self.seg += 1;
                self.off = 0;
            }
        }
        self.written += total;
        total
    }
}

const DESC_F_NEXT: u16 = 1;
const DESC_F_WRITE: u16 = 2;
const AVAIL_F_NO_INTERRUPT: u16 = 1;
/// Busy-wait after a burst for more requests in `µs`.
const SPIN_MICROS: u64 = 50;
const USED_F_NO_NOTIFY: u16 = 1;

/// Split virtqueue state.
#[derive(Default)]
pub struct Vring {
    pub size: u16,
    pub desc: u64,
    pub avail: u64,
    pub used: u64,
    pub last_avail: u16,
    pub used_idx: u16,
    pub kick: Option<OwnedFd>,
    pub call: Option<Arc<OwnedFd>>,
    pub enabled: bool,
}

impl Vring {
    /// Waits for kicks and processes requests until `stop` is set.
    pub fn run(
        &mut self,
        index: usize,
        memory: &Memory,
        handler: &dyn QueueHandler,
        stop: &AtomicBool,
    ) {
        let Some(kick) = self.kick.as_ref().map(|k| k.as_raw_fd()) else { return };
        let size = self.size as u64;
        let (Some(desc), Some(avail), Some(used)) = (
            memory.uaddr(self.desc, 16 * size),
            memory.uaddr(self.avail, 4 + 2 * size),
            memory.uaddr(self.used, 4 + 8 * size),
        ) else {
            eprintln!("virtiofs: vring {index} addresses not in guest memory");
            return;
        };
        // The used index continues from what the guest last saw.
        self.used_idx = unsafe { std::ptr::read_volatile(used.add(2) as *const u16) };
        let mut request = Vec::with_capacity(64 * 1024);
        loop {
            // Drain everything available, then wait for the next kick.
            let mut processed = false;
            loop {
                let avail_idx = unsafe { std::ptr::read_volatile(avail.add(2) as *const u16) };
                if avail_idx == self.last_avail {
                    break;
                }
                fence(Ordering::Acquire);
                let slot = (self.last_avail as u64 % size) as usize;
                let head =
                    unsafe { std::ptr::read_volatile((avail.add(4) as *const u16).add(slot)) };
                self.last_avail = self.last_avail.wrapping_add(1);
                let written = self.process_chain(index, memory, desc, head, handler, &mut request);
                let used_slot = (self.used_idx as u64 % size) as usize;
                unsafe {
                    let elem = used.add(4 + used_slot * 8);
                    std::ptr::write_volatile(elem as *mut u32, head as u32);
                    std::ptr::write_volatile(elem.add(4) as *mut u32, written as u32);
                }
                fence(Ordering::Release);
                self.used_idx = self.used_idx.wrapping_add(1);
                unsafe { std::ptr::write_volatile(used.add(2) as *mut u16, self.used_idx) };
                processed = true;
            }
            if processed {
                fence(Ordering::SeqCst);
                let flags = unsafe { std::ptr::read_volatile(avail as *const u16) };
                if flags & AVAIL_F_NO_INTERRUPT == 0
                    && let Some(call) = &self.call
                {
                    let one = 1u64.to_ne_bytes();
                    unsafe { libc::write(call.as_raw_fd(), one.as_ptr().cast(), 8) };
                }
            }
            if stop.load(Ordering::SeqCst) {
                return;
            }
            // Requests often come back to back: spin briefly before sleeping,
            // which saves the kick/wakeup latency of the next one.
            // While spinning the guest need not kick (VRING_USED_F_NO_NOTIFY).
            if processed && SPIN_MICROS > 0 {
                unsafe { std::ptr::write_volatile(used as *mut u16, USED_F_NO_NOTIFY) };
                let spin_until =
                    std::time::Instant::now() + std::time::Duration::from_micros(SPIN_MICROS);
                let mut more = false;
                while std::time::Instant::now() < spin_until {
                    let avail_idx = unsafe { std::ptr::read_volatile(avail.add(2) as *const u16) };
                    if avail_idx != self.last_avail {
                        more = true;
                        break;
                    }
                    std::hint::spin_loop();
                }
                unsafe { std::ptr::write_volatile(used as *mut u16, 0) };
                fence(Ordering::SeqCst);
                // Re-check after re-enabling notifications (a request may have
                // been queued without a kick in between).
                let avail_idx = unsafe { std::ptr::read_volatile(avail.add(2) as *const u16) };
                if more || avail_idx != self.last_avail {
                    continue;
                }
            }
            let mut pfd = libc::pollfd { fd: kick, events: libc::POLLIN, revents: 0 };
            let n = unsafe { libc::poll(&mut pfd, 1, 100) };
            if n > 0 {
                // eventfd: one 8-byte read; pipe: drain what's there.
                let mut buf = [0u8; 64];
                unsafe { libc::read(kick, buf.as_mut_ptr().cast(), buf.len()) };
            }
        }
    }

    fn process_chain(
        &self,
        index: usize,
        memory: &Memory,
        desc: *mut u8,
        head: u16,
        handler: &dyn QueueHandler,
        request: &mut Vec<u8>,
    ) -> usize {
        request.clear();
        let mut segments = Vec::new();
        let mut i = head;
        for _ in 0..self.size {
            let d = unsafe { desc.add(16 * (i as usize % self.size as usize)) };
            let (addr, len, flags, next) = unsafe {
                (
                    std::ptr::read_volatile(d as *const u64),
                    std::ptr::read_volatile(d.add(8) as *const u32),
                    std::ptr::read_volatile(d.add(12) as *const u16),
                    std::ptr::read_volatile(d.add(14) as *const u16),
                )
            };
            let Some(ptr) = memory.gpa(addr, len as u64) else {
                eprintln!("virtiofs: descriptor outside guest memory");
                return 0;
            };
            if flags & DESC_F_WRITE != 0 {
                segments.push((ptr, len as usize));
            } else {
                request.extend_from_slice(unsafe { std::slice::from_raw_parts(ptr, len as usize) });
            }
            if flags & DESC_F_NEXT == 0 {
                break;
            }
            i = next;
        }
        let mut writer =
            Writer { segments, seg: 0, off: 0, written: 0, _buffers: std::marker::PhantomData };
        handler.handle(index, request, &mut writer)
    }
}

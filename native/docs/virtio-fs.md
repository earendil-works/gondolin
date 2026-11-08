# virtio-fs for gondolind (M7)

Status: implemented (November 2026). `gondolind` serves the VFS over
virtio-fs whenever the QEMU binary supports vhost-user-fs or the krun runner
has gondolin's libkrun patch (`krun_add_virtiofs_socket`), and falls back to
sandboxfs otherwise (see "Implementation" below). Sections 1–7 are the
original feasibility study of the prototype in
`native/crates/gondolin-virtiofs`.

> Status note: the prototype's vhost-user, virtqueue and FUSE code is the
> production `gondolin-virtiofs`; its `passthrough.rs` is only used by the
> demo (`examples/virtiofs_demo.rs`) and the crate's tests, production serves `gondolin-vfs`'s
> `FsCore`. Release builds now unwind, so the "release builds abort" remark
> under "Robustness" is outdated: a panicking request answers EIO there too.
> macOS needs a QEMU with vhost-user (`qemu-macos-vhost-user.md`); guests
> need sandbox helpers with `--virtiofs` (source-built until the next helper
> release, `PLAN.md` M7).

## Implementation

- **Selection.** `configure.vfs.transport` (`auto` by default;
  `GONDOLIN_VIRTIOFS=0|1` on the controller) and a probe of the QEMU binary
  (`-machine none -device help` for `vhost-user-fs-pci`/`vhost-user-fs-device`,
  `-object help` for `memory-backend-memfd` on Linux or `memory-backend-shm`
  elsewhere). The probe runs once per binary (path, size, mtime) and is cached
  in memory and in `<cache>/gondolin/qemu-virtiofs.json`. krun: see
  "krun" below.
- **QEMU.** `-object <backend>,id=mem,size=<memory>,share=on`,
  `-machine <type>,memory-backend=mem`, `-chardev socket,id=vhostfs0,...` and
  `-device vhost-user-fs-pci` (`vhost-user-fs-device` on microvm) with tag
  `gondolin`, `queue-size=1024` and `num-request-queues=min(cpus, 4)`.
- **Guest.** The kernel command line gets `sandboxfs.virtiofs=gondolin`. init
  loads `virtiofs` and starts `sandboxfs --virtiofs gondolin`, which fetches
  the bind list over the RPC port as before, mounts the tag and exits; if the
  mount fails it serves FUSE over virtio-serial as before. Images without the
  flag ignore it, so old images keep working with new hosts and vice versa.
  The host waits for either `fuse.sandboxfs` or `virtiofs` in `/proc/mounts`.
- **Backend.** `gondolin-vfs` keeps the mount table; `FsCore` (`core.rs`) is
  the inode-level state shared by both transports (lookup counts and FORGET,
  file and directory handles with listing snapshots, flush/fsync, utimes),
  and `virtiofs.rs` implements the prototype's `FileSystem` trait over it.
  Every request is driven on the tokio runtime with `block_on` from its queue
  thread; host filesystem calls run inline on that thread. Host reads go
  straight into guest memory (`preadv` into the descriptor buffers).
- **Commit errors.** FLUSH is forwarded when an object mount buffers writes
  (`commit: close`) and commits there; FSYNC commits too. A failing commit is
  the guest's `close()`/`fsync()` error. Without buffered mounts FLUSH answers
  ENOSYS once, so the kernel stops sending it.
- **Robustness.** A panicking request answers EIO and the queue keeps
  serving (debug builds; release builds abort, like every daemon panic). Idle
  pause (QMP `stop`/`cont`) and VMM restarts reconnect through the
  vhost-user protocol.

Measured on the M5 Max (release build, QEMU 10.2.1 with vhost-user, a busy
machine: load average 12–20), `host/bench` vfs suite on a `RealFSProvider`
mount, same daemon with `GONDOLIN_VIRTIOFS=0` vs `1`:

| workload | sandboxfs | virtio-fs | speedup |
|---|---|---|---|
| small-create 1,000 × 4 KiB | 1,680 ms | 749 ms | 2.2× |
| small-stat 1,000 | 288 ms | 144 ms | 2.0× |
| small-read 1,000 | 1,104 ms | 487 ms | 2.3× |
| readdir 5,000 | 79 ms | 18 ms | 4.4× |
| tree find | 1,305 ms | 581 ms | 2.2× |
| untar 2,000 files | 13,724 ms | 7,696 ms | 1.8× |
| 256 MiB write | 102 MB/s | 1,051 MB/s | 10× |
| 256 MiB read | 102 MB/s | 1,446 MB/s | 14× |

Since then host mounts keep a directory fd cache (per symlink-free path,
opened `O_NOFOLLOW` per component or with `openat2(RESOLVE_BENEATH |
RESOLVE_NO_SYMLINKS)`, trusted for 1 s, at most 256 fds per mount with LRU
eviction, dropped when the provider renames or removes the directory or an
ancestor), hide rules take the real path of symlink-free paths from that
cache instead of walking, FLUSH no longer fsyncs host files (it made every
`close()` an `F_FULLFSYNC` whenever an object mount was present), and host
writes go from the request buffer to `pwrite` without a copy. Same machine,
same load, before → after, virtio-fs:

| workload | realfs | shadow |
|---|---|---|
| small-create | 5,387 → 662 ms | 5,406 → 278 ms |
| small-stat | 120 → 72 ms | 155 → 30 ms |
| small-read | 475 → 405 ms | 550 → 173 ms |
| tree find | 452 → 281 ms | 604 → 139 ms |
| untar | 14,833 → 5,043 ms | 13,367 → 1,757 ms |

(the "before" small-create/untar numbers include the FLUSH bug; at low load
without it the directory cache alone gave stat 1.7×, find 2.4×, untar 1.2×
on realfs and find 3.7×, untar 1.45× on shadow). With sandboxfs the same
changes help less (its per-request round trip dominates): find 1.3–3×,
readonly find 1.4–4.7×, shadow up to 3× (load-dependent).

## Summary

- **Feasible, and much faster.** A Linux guest mounts a virtio-fs share
  served by gondolind through vhost-user. On macOS (QEMU + HVF) the prototype
  is 3–5× faster than sandboxfs for metadata-heavy work and 15–25× faster for
  large I/O (table below).
- **Guest:** nothing new is needed in the kernel. `fuse.ko` and `virtiofs.ko`
  ship in the image's rootfs, and the krun kernel has virtio-fs built in. Only
  the guest's mount step changes: `mount -t virtiofs` instead of starting
  sandboxfs.
- **Linux hosts:** distribution QEMU has `vhost-user-fs-pci` and
  `memory-backend-memfd`. Nothing else is needed.
- **macOS hosts:** this is the blocker. Homebrew's QEMU 10.2.1 is built
  without vhost-user, because QEMU only auto-enables it on Linux. A QEMU
  10.2.1 that I built with `--enable-vhost-user --disable-vhost-net` works
  with `memory-backend-shm` and pipes as notifiers. Verified for real: mount,
  smoke test, benchmarks. Using it in production means shipping our own QEMU
  build or getting Homebrew (and a small QEMU build fix) to enable it.
- **Rust:** the rust-vmm `vhost` / `vhost-user-backend` crates and virtiofsd
  do not build on macOS. The prototype therefore implements vhost-user, the
  split virtqueue and FUSE dispatch itself, with only libc. It is about 1,300
  lines and also compiles for Linux.
- **VFS fit:** the backend calls an inode-level `FileSystem` trait that maps
  one-to-one onto the sandboxfs RPC operations (`guest/ARCHITECTURE.md`
  §6.3). `gondolin-vfs` (mount table, hide rules, object tier) can sit behind
  it unchanged.
- **krun:** libkrun's virtio-fs is a built-in host-directory passthrough with
  no hook for a custom filesystem. libkrun's generic vhost-user device needs
  the `vhost` crate, so it exists on Linux only.

**Recommendation:** do it, in this order:

1. Linux / QEMU with `gondolin-vfs` behind the trait.
2. macOS, gated on a QEMU that offers `vhost-user-fs-pci`: probe it and fall
   back to sandboxfs otherwise. Pursue a QEMU with vhost-user for macOS in
   parallel.
3. Keep sandboxfs as the fallback, and keep it for krun on macOS.

## 1. Guest kernel

| image | kernel | FUSE | virtio-fs |
|---|---|---|---|
| alpine-base 0.4.0 (`9ec8f6c5…`) | `vmlinuz-virt` 6.18.58-0-virt | `kernel/fs/fuse/fuse.ko.gz` (module, used by sandboxfs today) | `kernel/fs/fuse/virtiofs.ko.gz` (module, depends on `fuse.ko`); `dax` built in |
| same, krun | `krun-kernel` (libkrunfw 5.2.1) | built in | built in (`virtio_fs_*` and `virtio_fs_setup_dax` symbols present) |

The modules are in the rootfs (`/lib/modules/6.18.58-0-virt`), not in the
initramfs. The initramfs only carries `virtio_blk` and `ext4`
(`host/src/alpine/kernel-modules.ts`). That is fine, because `/data` is
mounted after `switch_root`. The guest change is to `modprobe virtiofs` and
`mount -t virtiofs <tag> /data` instead of starting sandboxfs, selected by a
boot-config flag so that old hosts keep working. Binds (`sandboxfs.bind=`)
stay as they are, since they are plain bind mounts inside the guest.

## 2. QEMU on macOS

- **Homebrew QEMU 10.2.1 has no vhost-user devices.** QEMU's `meson.build`
  says
  `have_vhost_user = get_option('vhost_user').disable_auto_if(host_os != 'linux')`,
  and the Homebrew formula doesn't pass `--enable-vhost-user`.
- **Building with `--enable-vhost-user` needs a workaround.** The build fails
  in `hw/net/vhost_net.c`, which includes `linux/vhost_types.h`. Adding
  `--disable-vhost-net` (and `--disable-vhost-crypto`) fixes it.
  `--disable-pvg` is unrelated to vhost-user; Homebrew passes it too on
  current macOS. The result has `vhost-user-fs-pci`, `vhost-user-fs-device`
  and `memory-backend-shm` (POSIX `shm_open`, QEMU ≥ 9.1).
  `crates/gondolin-virtiofs/examples/linux-guest/build-qemu-macos.sh`
  reproduces the build in about 5 minutes.
- **It works with HVF.** I used
  `-object memory-backend-shm,id=mem,size=2G,share=on -M virt,accel=hvf,memory-backend=mem`
  plus `-chardev socket,...` and
  `-device vhost-user-fs-pci,chardev=…,tag=gondolin,queue-size=1024`.
  - Kick and call notifiers are pipe file descriptors rather than eventfds.
  - Guest RAM is mapped into the backend from the `shm` file descriptors.
  - The guest mounted the share and passed the smoke test (create, append,
    rename, symlink, hard link, chmod, truncate, utime, readdir, O_EXCL,
    ENOTEMPTY, rmtree, statfs) and the benchmarks.
- **Linux:** stock QEMU (Debian, Fedora, Ubuntu) ships vhost-user-fs, and
  `memory-backend-memfd` provides the shared RAM.

Getting a vhost-user-capable QEMU to macOS users, options from cheapest
(the write-up with a recommendation and the ready QEMU patch is
`qemu-macos-vhost-user.md`):

1. A Homebrew formula change: add `--enable-vhost-user --disable-vhost-net`.
   This also needs a QEMU fix so `vhost-net` builds or is auto-disabled on
   non-Linux.
2. Ship a QEMU build with the krun-runner-style optional npm packages.
3. Detect it at runtime (`-device help` lists `vhost-user-fs-pci`) and fall
   back to sandboxfs. This is needed in every case.

**Not usable:** `virtio-9p` (built into Homebrew QEMU) only passes through a
host directory, so it can't serve the object tier or hide rules, and it is
slow. `vfio-user` is Linux-only.

## 3. Rust backend

| crate | macOS | notes |
|---|---|---|
| `vhost` (rust-vmm, `vhost-user-backend` feature) | ✗ | `vmm_sys_util::eventfd`, `libc::SO_DOMAIN` |
| `vhost-user-backend` | ✗ | depends on the above, plus epoll |
| `virtio-queue`, `vm-memory` (`backend-mmap`) | ✓ | |
| `fuse-backend-rs` (no default features) | ✓ | but `virtiofs` fails: it picks the macOS FUSE ABI by host OS, while virtio-fs always speaks the Linux ABI |
| virtiofsd | ✗ | Linux only (namespaces, `/proc`, `openat2`) |

The prototype therefore has its own small stack (libc only; also checked for
`aarch64-unknown-linux-musl`):

- **`vhost_user.rs`:** the backend side of the protocol over a unix socket.
  It handles features, protocol features (MQ, REPLY_ACK), the memory table,
  vring num/addr/base/kick/call/enable and `GET_VRING_BASE`. File descriptors
  arrive via `SCM_RIGHTS`. There is one thread per queue.
- **`virtq.rs`:** the guest memory map and split virtqueue processing. No
  indirect descriptors and no event index (neither is offered). Descriptors
  are bounds-checked against guest memory and chain length is limited.
  - After a burst it spins for 50 µs with `VRING_USED_F_NO_NOTIFY`.
  - It drains eventfds and pipes alike.
- **`fuse.rs`:** Linux FUSE 7.31 dispatch over a `FileSystem` trait.
  - Supported: INIT (async read, big writes, readdirplus, parallel dirops,
    1 MiB `max_pages`, optional writeback cache); LOOKUP (optional negative
    entries); GETATTR, SETATTR (mode, size, times); the namespace operations
    (symlink, mkdir, unlink, rmdir, rename/rename2, link); file I/O (open,
    create, read, write, release, fsync, statfs); directories (opendir,
    readdir, readdirplus, releasedir); forget, batch forget and interrupt.
  - FLUSH answers ENOSYS so the kernel stops sending it.
  - xattr and mknod answer EOPNOTSUPP, ioctl answers ENOTTY (the same as
    sandboxfs).
  - Per-opcode counters exist for diagnostics.
- **`passthrough.rs`:** a path-based host-directory filesystem standing in
  for `gondolin-vfs`. It is not hardened. It translates Linux open flags and
  errno values (macOS → Linux).

The `FileSystem` trait (lookup/forget/getattr/setattr/…/readdir/statfs, with
Linux errno values) matches the sandboxfs RPC operations in
`guest/ARCHITECTURE.md` §6.3, so the `fs_request` handlers in `gondolin-vfs`
can implement it directly. The object tier (fetch on open, commit on
release/fsync) works the same; note that FLUSH is not sent once ENOSYS was
answered.

What the backend handles itself (the guest's sandboxfs does it today):

- nodeid lookup counts and FORGET, file and directory handles, readdir
  cookies;
- packing readdirplus (and undoing the lookup of an entry that doesn't fit);
- INIT negotiation and cache TTLs.

Work left for production:

- a request thread pool or several request queues;
- zero-copy reads and writes straight into and out of guest memory;
- handle-based inodes in the real VFS (the prototype tracks paths);
- interrupts, `fallocate`, `lseek`, `copy_file_range`;
- reconnect handling (`GET_VRING_BASE` on stop);
- the QEMU arguments in gondolind, plus the guest mount switch.

## 4. krun

> Implemented (gondolin's libkrun patch, `host/krun-runner/patches`): a
> fourth virtio-fs server in libkrun's worker, next to the passthrough,
> read-only and null servers, forwards each request over a Unix socket
> (`krun_add_virtiofs_socket(ctx, tag, fd)`; frames: `u32 len, u32 queue,
> u32 reply_capacity` + FUSE request, answered by `u32 len` + FUSE reply).
> gondolind serves it with the same `FuseServer`
> (`gondolin-virtiofs/src/socket.rs`), so mount rules and hardening are those
> of the QEMU path. It needs no shared guest memory, so it works on macOS.
> The runner reports it with `--capabilities` (`virtiofs-socket`); without
> it the daemon keeps sandboxfs. M5 Max, krun, `host/bench` vfs (quick,
> `realfs`), sandboxfs → virtio-fs: small-create 123 → 68 ms, small-stat
> 21 → 11 ms, tree find 162 → 58 ms, untar 763 → 380 ms, 256 MiB write
> 275 → 878 MB/s, read 290 → 1,037 MB/s. Requests are handled one at a time
> and copied through the runner; zero-copy and pipelining are open.
>
> The study below predates it.

- **Built-in virtio-fs:** libkrun has its own in-process virtio-fs.
  - The new API offers `krun_fs_device_new(tag, host_path)`, a read-only
    variant, NullFs, an overlay of synthetic files, fixed owner, cache policy
    and a DAX window. The older `krun_add_virtiofs` is equivalent.
  - It is a host-directory passthrough implemented inside libkrun. Neither
    the C API nor the runner (`host/krun-runner/*.zig`) can plug in a custom
    filesystem.
- **vhost-user devices:** libkrun `main` has generic vhost-user devices
  (`krun_vhost_user_device_new(device_type, socket, …)`). Device type 26
  would connect to our backend. But the feature depends on the `vhost` crate
  (vhost-user-frontend), so it is Linux-only, and it is newer than the libkrun
  we pin.
- **Consequence for krun:**
  - On Linux, vhost-user-fs to `gondolin-virtiofs` once we move to a libkrun
    built with `vhost-user`.
  - On macOS, keep sandboxfs for custom VFS mounts. For plain `host` mounts
    without hide rules, libkrun's built-in passthrough is an option.
  - A deeper alternative is a libkrun fork accepting a Rust
    `Box<dyn FileSystem>`: libkrun is Rust, and its `devices` crate has such a
    trait. It is possible, but it means a fork.

## 5. Measurements

Host: Apple M5 Max, macOS 26.6, QEMU 10.2.1 built with vhost-user, HVF.
Guest: 2 vCPUs, 2 GiB. The guest timed itself, with workloads mirroring
`host/bench/suites/vfs.ts`:

- untar of 2,000 files (the same generator), 23 MB;
- `fsbench.py` for 1,000 × 4 KiB create/stat/read, with caches dropped
  before stat and read;
- 5,000-entry readdir;
- `find` and `ls -lR` over the untarred tree;
- 256 MiB `dd` write with `conv=fsync`, then a read after dropping caches.

The prototype ran with 1 s entry/attribute TTLs and negative lookup caching,
and the share was a host temporary directory on APFS. Prototype figures are
the range over 3 runs; node figures are medians of the since-removed node
engine from `host/bench/results/SUMMARY.md` at the time (realfs provider; the
result files are in git history).

| workload | node engine (sandboxfs, realfs) | prototype virtio-fs | speedup | guest tmpfs |
|---|---|---|---|---|
| untar 2,000 files | 6,075 ms | 1,720–1,910 ms | 3.3× | 22 ms |
| small-create 1,000 × 4 KiB | 946 ms | 185–323 ms | 3–5× | 4 ms |
| small-stat 1,000 | 158 ms | 30–45 ms | 4× | <1 ms |
| small-read 1,000 | 650 ms | 143–230 ms | 3–4× | 3 ms |
| readdir 5,000 | 111 ms | 8–10 ms | 12× | <1 ms |
| tree find | 930 ms | 110–160 ms | 6–8× | 3 ms |
| tree `ls -lR` | 773 ms | 103–160 ms | 5–7× | 4 ms |
| 256 MiB write | 153 MB/s | 1,950–2,350 MiB/s | ≈14× | 5,500 MiB/s |
| 256 MiB read | 143 MB/s | 2,700–3,900 MiB/s | ≈20× | 17,000+ MiB/s |

For reference, a native host `tar -xf` of the same archive on APFS takes
0.69 s.

**Where the time goes.** Untar issues about 36,000 FUSE requests (15,900
lookups, 8,500 setattrs, 4,800 getattrs, 2,000 creates, 2,000 writes, 2,000
releases, 820 mkdirs). The backend spent only about 245 ms on them: about
1.7 µs per lookup and 40 µs per create or mkdir on APFS. The remaining
roughly 1.3 s is the request round trip, about 35–40 µs each:

- the guest's MMIO notify exits to the HVF vCPU thread;
- QEMU writes the notifier pipe and our thread wakes;
- on completion, QEMU's main loop reads the call pipe and injects an
  interrupt, waking the guest vCPU from WFI.

Spinning while suppressing notifications, negative-entry caching, longer TTLs
and the writeback cache changed untar by less than ±10% on macOS.

On Linux/KVM, ioeventfd and irqfd bypass QEMU on both paths, so round trips
should be well below the macOS figure. Expect metadata workloads to gain more
there than on macOS. Large I/O is limited by copying,
not round trips, and benefits further from zero-copy and several queues.
(Not measured on Linux; no Linux host was available.)

**Why sandboxfs is slow, for comparison:** every FUSE request crosses guest
kernel → sandboxfs (guest userspace) → virtio-serial → host → reply. Reads and
writes are chunked to 60 KiB, and only one request is in flight.

## 6. Risks and open questions

- **QEMU on macOS (above):** the deciding factor for macOS.
- **Shared guest RAM:** guest RAM must live in shared memory (`memfd` or
  `shm`), and gondolind maps all of it. Descriptors are guest-controlled, so
  the backend must keep validating every address and length (the prototype
  does). The backend runs inside gondolind, so a bug there is a host bug.
  Isolating it (a separate process, sandboxing) is cheap to add later.
- **Migration:** QEMU forbids migration and `savevm` with vhost-user-fs
  unless backend state transfer is implemented. Gondolin's checkpoints are
  qcow2 disk overlays (`vm/core.ts`), not RAM snapshots, so this should not
  matter. This needs checking against the checkpoint code once wired.
- **DAX:** the DAX cache window for vhost-user-fs is not in upstream QEMU
  (it is in libkrun and Cloud Hypervisor), so no mmap-shared page cache on
  QEMU.
- **Cache coherence:** host-side changes to `host` mounts are seen after the
  TTL (1 s; sandboxfs behaves the same). Object-tier mounts that only the
  guest writes can use long TTLs, and the writeback cache can be enabled per
  mount kind.

## 7. Reproducing

```
native/crates/gondolin-virtiofs/examples/linux-guest/build-qemu-macos.sh /tmp/qemu-vu
NEGATIVE=1 native/crates/gondolin-virtiofs/examples/linux-guest/run.sh \
  ~/.cache/gondolin/images/objects/<build-id> /tmp/qemu-vu/qemu-10.2.1/build/qemu-system-aarch64
```

`run.sh` boots the image with `rdinit=/fsinit` from an overlay initramfs. It
serves a temporary directory with `examples/virtiofs_demo.rs` and runs
`fstest.sh`, which does the smoke test and the workloads on guest tmpfs and on
the virtio-fs mount. Optional settings:

- `FSTEST=untar`: untar only;
- `WRITEBACK=1`: enable the writeback cache;
- `CACHE_SECS=N`: entry/attribute TTL in seconds.

The demo prints per-opcode counts and time when the guest disconnects.

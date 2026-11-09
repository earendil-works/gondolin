# QEMU Backend

This document explains how Gondolin uses QEMU, why it is operated this way, and
how we keep behavior consistent across macOS and Linux.

Gondolin runs untrusted code inside a real Linux VM. QEMU is one of the two VM
backends that provide the hardware boundary and the virtio devices that Gondolin
uses for I/O mediation: the default where the `krun` backend cannot run (hosts
without libkrun support or KVM, no krun runner installed, images without krun
boot assets, guests of another architecture), and whenever it is selected
explicitly (`sandbox.vmm: "qemu"`, `--vmm qemu`, `GONDOLIN_VMM=qemu`) or a
qemu-only option is set.

For backend selection and capability differences (`qemu` vs `krun`), see
[VM Backends](./backends.md).

## Why QEMU

Gondolin is designed to behave the same way on developer laptops and in CI.

QEMU was chosen primarily because:

- It runs on both macOS and Linux with widely available acceleration backends.
- It supports the virtio devices we need (virtio-net, virtio-serial, virtio-blk, virtio-rng,
  and vhost-user-fs for virtio-fs).
- It is flexible enough to run in a minimal, tightly controlled configuration.

Alternatives like Firecracker are attractive on Linux, but they do not provide
the same cross-platform story on macOS, and divergence in VM behavior across
OSes is a long-term maintenance and security risk.

## What the Guest Sees

From inside the VM, the guest sees familiar devices:

- A block device for the root filesystem
- A network interface (typically as eth0)
- Four virtio-serial ports used for exec control, VFS RPC, SSH forwarding, and ingress
- Optionally a virtio-fs device (tag `gondolin`) for the programmable
  filesystem, see [virtio-fs](#virtio-fs-and-vhost-user)

The guest experience is intentionally "normal Linux" so that standard tooling
works without custom kernels or unusual userspace stacks.

## How Gondolin Connects to QEMU

QEMU runs as a child process of the Gondolin daemon (`gondolind`, see
[Architecture](./architecture.md#process-model)), which connects to it over
Unix domain sockets in a private directory (mode `0700`) and also talks QMP to
QEMU (to [pause an idle VM](#idle-pause), for example).  The daemon is
responsible for:

- Launching and shutting down the VM process
- Wiring up virtio channels used for exec control and filesystem RPC
- Providing a network backend that receives raw frames from QEMU

The key design is that Gondolin does not treat QEMU networking as a black box.
Instead, it positions itself as the network peer of the guest.

## Why We Do Not Use Vsock

It is tempting to use virtio-vsock for host-guest communication, especially for
control channels.  Gondolin intentionally avoids relying on vsock as the primary
transport for a few reasons:

- Portability: vsock support and behavior can vary across platforms,
  hypervisors, and guest kernels.  We want the same setup on macOS (HVF) and Linux
  (KVM).
- Semantics: vsock gives you a socket-like abstraction, not Ethernet.  Gondolin's
  network security model depends on inspecting and controlling traffic at the
  packet and stream level.
- Policy enforcement: if you provide the guest a general socket transport to the
  host, it becomes easier to accidentally create a generic tunnel.  Gondolin wants
  the host to be the policy enforcement point for egress.
- Debuggability and isolation: QEMU can be configured to expose distinct
  channels for distinct purposes (network frames vs control messages).  Keeping
  these channels separate helps reasoning about security boundaries.

Instead, Gondolin uses:

- virtio-net for a normal guest network interface
- a host network backend that receives and emits frames
- virtio-serial ports for structured control protocols (exec, VFS RPC, SSH forwarding, and ingress)

This combination is stable, well-understood, and keeps the guest environment conventional.

## Networking: Why a Custom Backend

Gondolin does not connect the guest to the host network via a generic NAT or a
bridged tap device. Instead, the host is the guest's network peer.

This is required for Gondolin's goals:

- Only allow specific mediated protocols (primarily HTTP and TLS that can be intercepted)
- Enforce destination policy (allowlist + internal-range blocking)
- Prevent arbitrary TCP tunneling (with only narrow explicit exceptions like SSH egress and mapped TCP rules)
- Enable request and response hooks
- Inject secrets at the network layer without exposing them to the guest

A generic NAT would turn the guest into a normal machine on your network, which
is the opposite of the threat model.

For details of the mediation pipeline, see [Network stack](./network.md).

## Control Plane: Virtio-Serial

Gondolin uses dedicated virtio-serial ports for host-guest control traffic
(`virtio-port` for exec, `virtio-fs` for the filesystem RPC, `virtio-ssh` and
`virtio-ingress` for the TCP forwarders).

Reasons:

- Structured framing: messages can be length-delimited and authenticated by
  protocol invariants.
- Separation of concerns: exec control and filesystem RPC are not mixed with
  network traffic.
- Cross-platform stability: virtio-serial is widely supported and behaves
  consistently across macOS and Linux when run under QEMU.

## Making QEMU Configuration Stable

Gondolin tries to keep the QEMU device model minimal and predictable:

- Only necessary devices are exposed.
- Console is non-graphical and intended for programmatic control.
- The root disk is typically treated as ephemeral for a run (writes do not
  persist to the base image): a qcow2 overlay the daemon creates, or QEMU's
  `snapshot=on` for `rootfs.mode: "memory"` without `rootfs.size` (see
  [Persistence and Snapshots](./snapshots.md#root-disk-modes)). Only the
  `qemu-system-*` binary is needed; Gondolin does not run `qemu-img`.

The exact QEMU flags may evolve over time, but the stability goals are:

- No unexpected devices that widen the guest attack surface
- Consistent device naming in the guest
- Consistent performance characteristics across supported platforms

## macOS vs Linux Differences

Gondolin aims for the same guest-visible behavior on macOS and Linux.  The
primary differences are in the acceleration backend and QEMU machine defaults.

### Acceleration

- Linux: uses KVM when available.
    - Requires access to /dev/kvm.
    - Typically provides very good performance.
- macOS: uses HVF.
    - Works on Apple Silicon and on Intel Macs with HVF support.
    - Some QEMU features may differ slightly from KVM.

Gondolin falls back to software emulation (TCG) when `/dev/kvm` is not
usable on Linux or the guest architecture differs from the host's.  This is
much slower and is not the recommended mode for regular use.

### Machine Type and CPU Model

QEMU has different machine models depending on architecture and platform.
Gondolin selects machine types and CPU models that are supported by the host
QEMU build and that work well with virtio devices. The CPU model is `host`
when the VM is accelerated (KVM or HVF) and `max` under TCG. To override it,
set `sandbox.cpu` or the `GONDOLIN_CPU` environment variable:

```bash
GONDOLIN_CPU=cortex-a72 gondolin bash
```

The defaults are `virt` on aarch64, `microvm` for x86_64 guests under KVM
and `q35` otherwise; `sandbox.machineType` overrides them.  You should
generally not rely on a specific QEMU machine type as part of the public
API. The important guarantee is that the guest boots quickly and exposes
the expected virtio devices.

### File and Socket Handling

Both platforms use local IPC primitives to connect to QEMU.  The details differ:

- Linux: Unix sockets are common and predictable.
- macOS: Unix sockets are also available, but filesystem and sandboxing rules can differ.

Gondolin treats these as implementation details: the daemon owns the socket
directory, and the socket paths are not configurable.

## Idle Pause

On macOS with HVF, an idle QEMU process still costs host CPU, so the daemon
pauses the VM (QMP `stop`) after 30 seconds without guest activity: no
running or queued command, no file operation or filesystem request, and no
open TCP connection (guest egress, SSH or ingress). The next interaction resumes it (QMP
`cont`) and resynchronizes the guest clock before it proceeds, so a paused VM
is transparent to callers apart from the resume latency.

`sandbox.qemuIdlePauseMs` sets the timeout in `ms` (`0` disables it) and also
enables idle pause on other hosts; the option is QEMU-only and is rejected
with `vmm: "krun"`. For a daemon on another machine only an explicit value
applies.

## virtio-fs and vhost-user

The daemon can serve the guest's programmable filesystem over virtio-fs
instead of sandboxfs (FUSE over virtio-serial), which is much faster (see
[Files and Mounts](./vfs.md)).  `gondolind` implements the vhost-user-fs
device itself; QEMU only needs to support vhost-user:

- a `vhost-user-fs-pci` device (`vhost-user-fs-device` on `microvm`), and
- a shared memory backend for guest RAM (`memory-backend-memfd` on Linux,
  else `memory-backend-shm`).

The daemon probes the QEMU binary for both (`-device help`, `-object help`)
and caches the result per binary in `~/.cache/gondolin/qemu-virtiofs.json`.
When either is missing, the guest uses sandboxfs; so do guest images whose
`sandboxfs` predates `--virtiofs`.  Linux distribution QEMU builds support
vhost-user; Homebrew's QEMU on macOS does not (see
[`native/docs/qemu-macos-vhost-user.md`](https://github.com/earendil-works/gondolin/blob/main/native/docs/qemu-macos-vhost-user.md)
for building one).  `GONDOLIN_VIRTIOFS=0` forces sandboxfs,
`GONDOLIN_VIRTIOFS=1` logs a warning when virtio-fs is unavailable.  The krun
backend serves virtio-fs through its runner instead (see
[VM Backends](./backends.md#runtime-caveats)).

## Inspecting the Command Line

The daemon can print the QEMU command line it would use for a configuration
(the daemon's configuration payload as JSON on stdin), without starting a VM:

```bash
echo '{"vm": {"qemu_path": "qemu-system-aarch64", "kernel_path": "/k", "initrd_path": "/i", "memory": "1G", "cpus": 2}}' \
  | gondolind --qemu-args
```

With the `protocol` debug flag (`GONDOLIN_DEBUG=protocol`), QEMU's own output
is forwarded to your debug callback (see
[Debugging and Troubleshooting](./debug.md)).

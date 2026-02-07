# QEMU

This document explains how Gondolin uses QEMU, why it is operated this way, and
how we keep behavior consistent across macOS and Linux.

Gondolin runs untrusted code inside a real Linux VM. QEMU is the VM engine that
provides the hardware boundary and the virtio devices that Gondolin uses for I/O
mediation.

## Why QEMU

Gondolin is designed to behave the same way on developer laptops and in CI.

QEMU was chosen primarily because:

- It runs on both macOS and Linux with widely available acceleration backends.
- It supports the virtio devices we need (virtio-net, virtio-serial, virtio-blk, virtio-rng).
- It is flexible enough to run in a minimal, tightly controlled configuration.

Alternatives like Firecracker are attractive on Linux, but they do not provide
the same cross-platform story on macOS, and divergence in VM behavior across
OSes is a long-term maintenance and security risk.

## What the guest sees

From inside the VM, the guest sees familiar devices:

- A block device for the root filesystem
- A network interface (typically as eth0)
- One or more virtio-serial ports used for control and services

The guest experience is intentionally "normal Linux" so that standard tooling
works without custom kernels or unusual userspace stacks.

## How Gondolin connects to QEMU

Gondolin runs QEMU as a child process and connects to it over local transports
(Unix domain sockets and file descriptors).  The host side is responsible for:

- Launching and shutting down the VM process
- Wiring up virtio channels used for exec control and filesystem RPC
- Providing a network backend that receives raw frames from QEMU

The key design is that Gondolin does not treat QEMU networking as a black box.
Instead, it positions itself as the network peer of the guest.

## Why we do not use vsock

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
- virtio-serial ports for structured control protocols (exec, VFS RPC, and other services)

This combination is stable, well-understood, and keeps the guest environment conventional.

## Networking: why a custom backend

Gondolin does not connect the guest to the host network via a generic NAT or a
bridged tap device. Instead, the host is the guest's network peer.

This is required for Gondolin's goals:

- Only allow specific protocols (primarily HTTP and TLS that can be intercepted)
- Enforce destination policy (allowlist + internal-range blocking)
- Prevent arbitrary TCP tunneling
- Enable request and response hooks
- Inject secrets at the network layer without exposing them to the guest

A generic NAT would turn the guest into a normal machine on your network, which
is the opposite of the threat model.

For details of the mediation pipeline, see [Network stack](./network.md).

## Control plane: virtio-serial

Gondolin uses dedicated virtio-serial ports for host-guest control traffic.

Reasons:

- Structured framing: messages can be length-delimited and authenticated by
  protocol invariants.
- Separation of concerns: exec control and filesystem RPC are not mixed with
  network traffic.
- Cross-platform stability: virtio-serial is widely supported and behaves
  consistently across macOS and Linux when run under QEMU.

## Making QEMU configuration stable

Gondolin tries to keep the QEMU device model minimal and predictable:

- Only necessary devices are exposed.
- Console is non-graphical and intended for programmatic control.
- The root disk is typically treated as ephemeral for a run (writes do not
  persist to the base image).

The exact QEMU flags may evolve over time, but the stability goals are:

- No unexpected devices that widen the guest attack surface
- Consistent device naming in the guest
- Consistent performance characteristics across supported platforms

## macOS vs Linux differences

Gondolin aims for the same guest-visible behavior on macOS and Linux.  The
primary differences are in the acceleration backend and QEMU machine defaults.

### Acceleration

- Linux: uses KVM when available.
  - Requires access to /dev/kvm.
  - Typically provides very good performance.
- macOS: uses HVF.
  - Works on Apple Silicon and on Intel Macs with HVF support.
  - Some QEMU features may differ slightly from KVM.

If hardware acceleration is not available, QEMU can fall back to software
emulation (TCG).  This is much slower and is not the recommended mode for regular
use.

### Machine type and CPU model

QEMU has different machine models depending on architecture and platform.
Gondolin selects machine types and CPU models that are supported by the host
QEMU build and that work well with virtio devices.

You should generally not rely on a specific QEMU machine type as part of the
public API. The important guarantee is that the guest boots quickly and exposes
the expected virtio devices.

### File and socket handling

Both platforms use local IPC primitives to connect to QEMU.  The details differ:

- Linux: Unix sockets and file descriptor passing are common and predictable.
- macOS: Unix sockets are also available, but filesystem and sandboxing rules can differ.

Gondolin treats these as implementation details and keeps them behind the host
controller abstraction.

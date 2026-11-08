# Architecture Overview

This document answers the question: **"what is Gondolin?"**

Gondolin is not a single binary. It is a small system made of:

- **A host-side library + CLI**: for TypeScript / Node.js, also called the control plane
- **A host engine**: `gondolind`, a static Rust daemon that runs the VM and
  mediates its I/O
- **A guest-side runtime**: a minimal Linux VM image plus a few small daemons
- **VM backend**: `libkrun` (default where it can run) or QEMU

The high-level idea is:

> Run untrusted code inside a real Linux VM, but keep the VM's *I/O surface*
> (network + persistence) mediated by host code you control.

If you already read [Security Design](./security.md): this page focuses on
**components and data flow**, not threat modeling.

## The Pieces

This gives you an overview of what they are.

### Host

This is the code you import (`@earendil-works/gondolin`) and also what powers
the CLI, together with the host engine it drives (see "Host engines" below).
It manages not just the lifecycle of the VM but it's also a crucial
counterpart to the guest as the guest delegates a lot of functionality to the
host.

Responsibilities:

- Start/stop the selected VM backend and wire up the devices Gondolin needs
- Provide the **exec** (`vm.exec(...)`)
- Provide the **programmable filesystem** (VFS providers)
- Provide the **programmable network policy** (HTTP/TLS mediation + hooks, plus explicit SSH/mapped-TCP exception paths)
- Download/cache guest assets (kernel/initramfs/rootfs) on demand

Key concepts you interact with:

- `VM` (lifecycle + `exec`)
- `httpHooks` / `createHttpHooks()` (network allowlists, secrets, request/response hooks)
- VFS providers (`MemoryProvider`, `RealFSProvider`, `ReadonlyProvider`, ...)

### Guest

The guest is a conventional Linux userspace (kernel + initramfs/rootfs) with a
few small Gondolin-specific helpers.

Responsibilities:

- Boot fast and provide a familiar Linux environment for tools
- Execute commands requested by the host
- Proxy filesystem operations to the host (for mounted VFS paths)

Guest daemons/components:

- `sandboxd`: receives exec requests and spawns processes
- `sandboxfs`: mounts the programmable filesystem: over virtio-fs when the host
  offers it, else as a FUSE daemon that forwards filesystem operations to the
  host via RPC
- `sandboxssh`: a dedicated host-to-guest TCP forwarder for SSH access (loopback-only inside the guest)
- `sandboxingress`: a dedicated host-to-guest TCP forwarder for inbound HTTP traffic (ingress gateway)
- `/init`: mounts tmpfs, brings up networking, starts services

### Host engine (native)

`gondolind`, a static Rust daemon, runs the VM, the guest protocols, the
network stack, the HTTP/TLS mediation and the guest filesystem server. Your
Node.js process stays the *controller*: it owns the configuration, your hooks
and VFS providers, and talks to the daemon over its stdin/stdout. Because the
daemon needs no runtime, it can also run on another machine (for example over
SSH) while the controller, credentials and providers stay local. The static
`gondolin` CLI runs the same daemon code without Node.js.

See [Native Engine](./native.md).

### VM backend (krun where available, otherwise QEMU)

The VM backend is the primary isolation boundary. Gondolin uses `libkrun` (via
the `gondolin-krun-runner` helper) by default where it can run: macOS on Apple
silicon and Linux arm64/x86_64 with KVM, with a runner installed and an image
that ships krun boot assets. Everywhere else, or when selected explicitly, it
uses QEMU.

See [VM Backends (QEMU vs krun)](./backends.md) for capability differences and
[QEMU](./qemu.md) for QEMU-specific internals.

## System Diagram

```
+--------------------------- Host machine (trusted) ---------------------------+
|                                                                              |
|  Your Node.js app / CLI                                                      |
|  (policy + secrets + VFS providers)                                          |
|                                                                              |
|  +------------------------------ VM boundary ------------------------------+ |
|  | Guest Linux VM (untrusted)                                              | |
|  |                                                                         | |
|  |  [virtio-net]   eth0  <---- Ethernet frames ---->  host network backend | |
|  |                                                                         | |
|  |  [virtio-serial]  exec RPC    <---------------->  sandbox server        | |
|  |  [virtio-serial]  fs RPC      <---------------->  VFS RPC service       | |
|  |  [virtio-fs]      (optional)  <---------------->  vhost-user-fs server  | |
|  |  [virtio-serial]  ssh fwd     <---------------->  loopback-only proxy   | |
|  |  [virtio-serial]  ingress fwd <---------------->  ingress gateway       | |
|  +-------------------------------------------------------------------------+ |
|                                                                              |
+------------------------------------------------------------------------------+
```

The important architectural choice: **the host is the enforcement point** for
both networking and persistence.

The right-hand side of this diagram (sandbox server, network backend, VFS
server, forwarders) lives in `gondolind`; the controller is reached over the
daemon's stdin/stdout for hooks, VFS providers and the `vm.exec`/`vm.fs` API:

```
 Node.js controller  <-- stdio (local child, or SSH) -->  gondolind  <-- virtio -->  guest
 (VM API, policy,                                         (QEMU, exec, network,
  hooks, providers)                                        TLS mediation, VFS port)
```

## Control Plane vs Data Plane

It's useful to think of Gondolin as two planes:

- **Control plane:** structured RPC over virtio-serial

    - command execution (`vm.exec`)
    - filesystem RPC for the programmable mounts (or virtio-fs, a separate
      shared-memory device, when the host's QEMU supports vhost-user)
    - a small set of host <-> guest utility channels

- **Data plane:** guest-visible "normal" Linux interfaces

    - `eth0` exists, but egress is mediated by the host (no generic NAT)
    - files under mounted VFS paths behave like normal paths, but operations are
    served by host providers

## What Happens When You Run `vm.exec(...)`

1. Your code calls `vm.exec("...")` (or the CLI does).
2. The host sends an **exec request** over a virtio-serial channel.
3. In the guest, `sandboxd` spawns the process and attaches pipes.
4. stdout/stderr/stdin are streamed back to the host.
5. The host assembles an `ExecResult` (exit code + captured output).

This is why Gondolin can provide a nice programmatic API without needing SSH for
normal operation.

## What Happens on Network Access

From the guest's point of view, networking looks ordinary: it opens TCP sockets
and writes bytes.

On the host side, Gondolin does **not** provide a generic NAT. Instead:

1. The guest emits Ethernet frames via virtio-net.
2. The host receives frames and implements a small userspace network stack
   (native engine: `gondolin-netstack`, built on smoltcp, plus
   `gondolin-egress` for the mediation).
3. Outbound TCP flows either match an explicit mapped TCP rule first, or are
   classified as **HTTP**, **TLS**, or **SSH** (anything else is blocked).
4. If a mapped TCP rule matches, the host connects to the explicit mapped
   upstream `HOST:PORT` and forwards bytes.
5. For HTTP requests, data is parsed, checked against policy, optionally transformed
   (hooks), and replayed by the host's own HTTP client (`gondolin-http` in
   the daemon).
6. For TLS flows, the host performs a controlled MITM so it can see the HTTP
   request inside TLS and apply the same policy/hook pipeline.
7. For SSH egress flows, the host runs the SSH proxy path (allowlist + host-key
   verification + exec restrictions).

For HTTP/TLS-mediated flows, this is the reason Gondolin can:

- enforce allowlists by hostname
- block internal ranges robustly
- inject secrets into headers without exposing real values to the guest

Mapped TCP/SSH exception paths use different controls (explicit target mapping/
allowlisting and protocol constraints) and do not run the HTTP hook/secrets pipeline.

See [Network Stack](./network.md) for the full details.

## What Happens on Filesystem Access

The guest has two kinds of storage:

- **Image-backed root filesystem** (usually ephemeral per run)
- **Explicit host-provided mounts** (programmable VFS)

For a programmable mount (e.g. `/workspace` or `/data`):

1. In the guest, the mountpoint is mounted as virtio-fs when the VMM offers it
   (a QEMU with vhost-user, or the bundled krun runner), else served by
   `sandboxfs` (FUSE).
2. Each file operation becomes an RPC message over virtio-serial (or a FUSE
   request on a virtio-fs queue).
3. The host dispatches it to the configured provider(s) through `gondolind`'s
   mount table (native mounts directly, JS providers through the controller).

Providers can implement very different semantics (in-memory, read-only host
directories, remote-backed content, policy wrappers, etc.) while the guest still
sees normal POSIX paths.

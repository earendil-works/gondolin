# Architecture Overview

This document answers the question: **"what is Gondolin?"**

Gondolin is not a single binary. It is a small system made of:

- **A host-side library + CLI**: for TypeScript / Node.js, also called the control plane
- **A guest-side runtime**: a minimal Linux VM image plus a few small daemons
- **QEMU**: that is our VM

The high-level idea is:

> Run untrusted code inside a real Linux VM, but keep the VM's *I/O surface*
> (network + persistence) mediated by host code you control.

If you already read [Security Design](./security.md): this page focuses on
**components and data flow**, not threat modeling.

## The Pieces

This gives you an overview of what they are.

### Host

This is the code you import (`@earendil-works/gondolin`) and also what powers
the CLI.  It manages not just the lifecycle of the VM but it's also a crucial
counterpart to the guest as the guest delegates a lot of functionality to the
host.

Responsibilities:

- Start/stop QEMU and wire up the devices Gondolin needs
- Provide the **exec** (`vm.exec(...)`)
- Provide the **programmable filesystem** (VFS providers)
- Provide the **programmable network policy** (HTTP/TLS mediation + hooks)
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
- `sandboxfs`: a FUSE daemon that forwards filesystem operations to the host via RPC
- `sandboxssh`: a dedicated host-to-guest TCP forwarder (loopback-only inside the guest)
- `/init`: mounts tmpfs, brings up networking, starts services

### QEMU

QEMU is the VM engine (and the primary isolation boundary).  Gondolin runs QEMU
in a minimal configuration and uses virtio devices for I/O.

See [QEMU](./qemu.md) for details.

## System Diagram

```
+--------------------------- Host machine (trusted) ---------------------------+
|                                                                              |
|  Your Node.js app / CLI                                                      |
|  (policy + secrets + VFS providers)                                          |
|                                                                              |
|  +----------------------------- QEMU boundary -----------------------------+ |
|  | Guest Linux VM (untrusted)                                              | |
|  |                                                                         | |
|  |  [virtio-net]   eth0  <---- Ethernet frames ---->  host network backend | |
|  |                                                                         | |
|  |  [virtio-serial]  exec RPC  <------------------>  sandbox server        | |
|  |  [virtio-serial]  fs RPC    <------------------>  VFS RPC service       | |
|  |  [virtio-serial]  ssh fwd   <------------------>  loopback-only proxy   | |
|  +-------------------------------------------------------------------------+ |
|                                                                              |
+------------------------------------------------------------------------------+
```

The important architectural choice: **the host is the enforcement point** for
both networking and persistence.

## Control Plane vs Data Plane

It's useful to think of Gondolin as two planes:

- **Control plane:** structured RPC over virtio-serial

  - command execution (`vm.exec`)
  - filesystem RPC for the programmable mounts
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
2. The host receives frames and implements a small userspace network stack.
3. Outbound TCP flows are classified as **HTTP** or **TLS** (anything else is
   blocked).
4. HTTP requests are parsed, checked against policy, optionally transformed
   (hooks), and replayed via host `fetch`.
5. For TLS flows, the host performs a controlled MITM so it can see the HTTP
   request inside TLS and apply the same policy/hook pipeline.

This is the reason Gondolin can:

- enforce allowlists by hostname
- block internal ranges robustly
- inject secrets into headers without exposing real values to the guest

See [Network Stack](./network.md) for the full details.

## What Happens on Filesystem Access

The guest has two kinds of storage:

- **Image-backed root filesystem** (usually ephemeral per run)
- **Explicit host-provided mounts** (programmable VFS)

For a programmable mount (e.g. `/workspace` or `/data`):

1. In the guest, the mountpoint is served by `sandboxfs` (FUSE).
2. Each file operation becomes an RPC message over virtio-serial.
3. The host `FsRpcService` dispatches it to the configured provider(s).

Providers can implement very different semantics (in-memory, read-only host
directories, remote-backed content, policy wrappers, etc.) while the guest still
sees normal POSIX paths.

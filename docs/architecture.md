# Architecture

This page answers the question: **"what is Gondolin made of, and where does
each piece run?"**

Gondolin is not a single binary. It is a small system made of:

- **Your process**: the TypeScript SDK (`@earendil-works/gondolin`) or the
  Node CLI built on it, running in your Node.js process
- **The Gondolin daemon** (`gondolind`): a static Rust binary that runs the
  VM and mediates all of its I/O
- **A VM backend**: `libkrun` (default where it can run) or QEMU, started by
  the daemon
- **A guest**: a minimal Linux image plus a few small Gondolin daemons

The high-level idea is:

> Run untrusted code inside a real Linux VM, but keep the VM's *I/O surface*
> (network + persistence) mediated by host code you control.

If you already read [Security Design](./security.md): this page focuses on
**components and data flow**, not threat modeling.

## The Pieces

### Your Process (the Controller)

The code you import (`@earendil-works/gondolin`) and the Node CLI that is
built on it. On this page it is called the *controller*: it owns the
configuration and everything that has to stay in JavaScript.

Responsibilities:

- The `VM` API: lifecycle, `vm.exec(...)`, `vm.fs`, sessions
- Compiling your configuration (network policy, secrets, VFS mounts, image
  selection) into one declarative configuration for the daemon
- Running the things that are JavaScript by nature: your HTTP hooks, custom
  VFS providers, VFS hooks (see
  [What Calls Back Into Your Process](#what-calls-back-into-your-process))
- The SSH and ingress listeners (`vm.enableSsh()`, `vm.enableIngress()`)
- For a daemon on the same machine: resolving and downloading guest images
  and creating the TLS interception CA

Key concepts you interact with:

- `VM` (lifecycle + `exec`)
- `httpHooks` / `createHttpHooks()` (network allowlists, secrets,
  request/response hooks)
- VFS providers (`MemoryProvider`, `RealFSProvider`, `ReadonlyProvider`,
  `nativeMounts`, ...)

### The Gondolin Daemon (`gondolind`)

`gondolind` runs the VM, the guest protocols, the userspace network stack,
the HTTP/TLS mediation and the guest filesystem server. It needs no runtime
(no Node.js), so it can run on the same machine as your process or on another
one, for example over SSH, while your policy, credentials and providers stay
local (see [Remote Machines](./remote.md)).

It ships as one multi-call binary, `gondolin`: the static CLI, and the daemon
when started as `gondolin daemon` (or under the name `gondolind`). The SDK
starts it as a child process; see [Installation](./install.md) for how the
binary is found.

What it does itself, without calling back into your process:

- Starts and supervises the VMM (QEMU or the krun runner)
- Prepares the root disk with its own qcow2 implementation (copy-on-write
  overlays, `rootfs.size`, checkpoint export and resume; no `qemu-img`) and
  validates every disk it did not create before the VMM opens it (see
  [Security Design](./security.md#root-disks-and-checkpoints))
- Speaks the guest control protocol (exec, file transfer, clock sync)
- Runs the network stack (Ethernet, ARP, DHCP, IPv4, ICMP, DNS, TCP), the
  HTTP/1.1 bridge, TLS interception, WebSockets, mapped TCP and the SSH
  egress proxy
- Evaluates the declarative network policy (allowlists, internal-range
  blocking) and substitutes secrets
- Runs [tier-2 hooks](./hooks.md) (self-contained JavaScript policies) on its
  embedded JavaScript engine
- Serves the guest filesystem from its own mount table: host directories and
  in-memory filesystems natively, other providers through a cache in front of
  your process

### VM Backend (krun Where Available, Otherwise QEMU)

The VM backend is the primary isolation boundary. Gondolin uses `libkrun` (via
the `gondolin-krun-runner` helper) by default where it can run: macOS on Apple
silicon and Linux arm64/x86_64 with KVM, with a runner installed and an image
that ships krun boot assets. Everywhere else, or when selected explicitly, it
uses QEMU.

See [VM Backends](./backends.md) for selection and capability differences and
[QEMU Backend](./qemu.md) for QEMU-specific internals.

### Guest

The guest is a conventional Linux userspace (kernel + initramfs/rootfs) with a
few small Gondolin-specific helpers.

Responsibilities:

- Boot fast and provide a familiar Linux environment for tools
- Execute commands requested by the host
- Mount the programmable filesystem served by the host

Guest daemons/components:

- `sandboxd`: receives exec requests and spawns processes
- `sandboxfs`: mounts the programmable filesystem: over virtio-fs when the host
  offers it, else as a FUSE daemon that forwards filesystem operations to the
  host via RPC
- `sandboxssh`: a dedicated host-to-guest TCP forwarder for SSH access
  (loopback-only inside the guest)
- `sandboxingress`: a dedicated host-to-guest TCP forwarder for inbound HTTP
  traffic (ingress gateway)
- `/init`: mounts tmpfs, brings up networking, starts services

## Process Model

```
 your Node.js process  -- stdin/stdout -->  gondolind  -- child -->  QEMU or krun runner
 (controller)             (local child,                                (the VM)
                           or e.g. SSH)
```

- The SDK spawns `gondolind` and talks to it over its stdin/stdout with a
  length-prefixed CBOR protocol. Starting a VM costs one extra process spawn
  and handshake (a few milliseconds).
- The VMM is a child of the daemon, not of your process (controller →
  `gondolind` → VMM). `vm.getHostPid()` returns the VMM's pid for a local
  daemon and `null` for a remote one.
- The daemon exits, and kills its VM, when its stdin closes, so a crashed or
  killed controller never leaves VMs running behind. On Linux the VMM is also
  tied to the daemon's lifetime (`PR_SET_PDEATHSIG`); on macOS a small
  watchdog process does the same.
- The daemon keeps its VMM sockets in a private directory (mode `0700`); the
  socket paths are not configurable.
- For a remote daemon the same protocol runs over any byte pipe (an SSH
  command, or a connection object); see [Remote Machines](./remote.md).
- The static `gondolin` CLI has no separate daemon process: it runs the
  daemon's session code in-process, with a Rust controller in place of the
  SDK, and starts the VMM as its own child.

## What Calls Back Into Your Process

Most work never leaves the daemon. It calls back into the controller only for
things that must run in your JavaScript, and only when you registered them:

| Feature | Cost |
| --- | --- |
| HTTP hooks (`isRequestAllowed`, `isIpAllowed`, `onRequest`, `onResponse`) | one round trip per registered phase; bodies are transferred only when a hook reads them |
| Custom VFS providers (`MemoryProvider`, your own `VirtualProvider`s, `ObjectProvider`s) | one round trip per uncached operation (metadata is cached briefly, contents are revalidated on open) |
| VFS `before` hooks | one round trip per hooked operation |
| VFS `after` hooks | asynchronous notification after the guest got its reply |
| SSH and ingress access | the listeners run in your process; connections are tunneled to the guest through the daemon |
| Debug output | events are forwarded to your debug callback |

Everything else runs in the daemon at no per-request cost to your process:
the declarative `createHttpHooks()` options (allowlists, internal ranges,
secrets), tier-2 hooks (`createDjsHooks()`), DNS, TLS interception, SSH
egress and mapped TCP, and native mounts (`RealFSProvider` and wrappers
around it for a local daemon, `nativeMounts.memory()`, `nativeMounts.host()`).
See [HTTP Hooks and Policies](./hooks.md) and [Files and Mounts](./vfs.md) for
how to pick the cheapest form.

## Configuration and Errors

`VM.create()` validates the options it can check locally and compiles them
into one configuration message. The daemon validates the rest on its machine
when the VM starts, so some configuration errors surface from `vm.start()` (or
the first `vm.exec()` that starts the VM) rather than from `VM.create()`: for
example SSH credential files, a missing QEMU binary or krun runner, or an
unknown image. Options that cannot be honoured at all (for example explicit
`sandbox.virtio*SocketPath` values) are rejected with an error naming the
option. See [Debugging and Troubleshooting](./debug.md) for the messages.

## System Diagram

```
+------------------------------ Host machine(s) (trusted) ------------------------------+
|                                                                                       |
|  Your Node.js process            gondolind                                            |
|  (VM API, policy, secrets,  <->  (network stack, HTTP/TLS mediation,                  |
|   hooks, VFS providers,           policy, mount table, exec, VMM)                     |
|   SSH/ingress listeners)                                                              |
|                                                                                       |
|  +---------------------------------- VM boundary ----------------------------------+  |
|  | Guest Linux VM (untrusted)                                                      |  |
|  |                                                                                 |  |
|  |  [virtio-net]     eth0        <-- Ethernet frames -->  daemon network stack     |  |
|  |  [virtio-serial]  exec RPC    <------------------->  daemon guest control       |  |
|  |  [virtio-serial]  fs RPC      <------------------->  daemon mount table         |  |
|  |  [virtio-fs]      (optional)  <------------------->  daemon virtio-fs server    |  |
|  |  [virtio-serial]  ssh fwd     <------------------->  daemon -> controller       |  |
|  |  [virtio-serial]  ingress fwd <------------------->  daemon -> controller       |  |
|  +---------------------------------------------------------------------------------+  |
|                                                                                       |
+---------------------------------------------------------------------------------------+
```

The important architectural choice: **the host is the enforcement point** for
both networking and persistence. The guest only ever talks to the daemon; the
daemon decides what reaches the network, the host filesystem or your process.

## Control Plane vs Data Plane

It's useful to think of Gondolin as two planes:

- **Control plane:** structured RPC over virtio-serial

    - command execution (`vm.exec`)
    - filesystem RPC for the programmable mounts (or virtio-fs, a separate
      device, when the VM backend supports it)
    - a small set of host <-> guest utility channels (SSH and ingress
      forwarding, clock sync)

- **Data plane:** guest-visible "normal" Linux interfaces

    - `eth0` exists, but egress is mediated by the host (no generic NAT)
    - files under mounted VFS paths behave like normal paths, but operations
      are served by host providers

## What Happens When You Run `vm.exec(...)`

1. Your code calls `vm.exec("...")` (or the CLI does).
2. The controller sends the request to the daemon, which forwards it as an
   **exec request** over a virtio-serial channel.
3. In the guest, `sandboxd` spawns the process and attaches pipes.
4. stdout/stderr/stdin are streamed between the guest and your process through
   the daemon (with flow control in both directions).
5. The SDK assembles an `ExecResult` (exit code + captured output).

This is why Gondolin can provide a programmatic API without needing SSH for
normal operation. See [Running Commands](./exec.md).

## What Happens on Network Access

From the guest's point of view, networking looks ordinary: it opens TCP sockets
and writes bytes.

On the host side, Gondolin does **not** provide a generic NAT. Instead:

1. The guest emits Ethernet frames via virtio-net.
2. The daemon receives the frames and implements a small userspace network
   stack (`gondolin-netstack`, built on smoltcp, plus `gondolin-egress` for
   the mediation).
3. Outbound TCP flows either match an explicit mapped TCP rule first, or are
   classified as **HTTP**, **TLS**, or **SSH** (anything else is blocked).
4. If a mapped TCP rule matches, the daemon connects to the explicit mapped
   upstream `HOST:PORT` and forwards bytes.
5. For HTTP requests, data is parsed, checked against policy, optionally
   transformed (hooks), and replayed by the daemon's own HTTP client
   (`gondolin-http`).
6. For TLS flows, the daemon performs a controlled MITM so it can see the HTTP
   request inside TLS and apply the same policy/hook pipeline.
7. For SSH egress flows, the daemon runs the SSH proxy path (allowlist +
   host-key verification + exec restrictions).

For HTTP/TLS-mediated flows, this is the reason Gondolin can:

- enforce allowlists by hostname
- block internal ranges robustly
- inject secrets into headers without exposing real values to the guest

Mapped TCP/SSH exception paths use different controls (explicit target
mapping/allowlisting and protocol constraints) and do not run the HTTP
hook/secrets pipeline.

See [Network Access](./network-access.md) for how to configure it and
[Network Stack](./network.md) for the full details.

## What Happens on Filesystem Access

The guest has two kinds of storage:

- **Image-backed root filesystem** (usually ephemeral per run)
- **Explicit host-provided mounts** (programmable VFS)

For a programmable mount (e.g. `/workspace` or `/data`):

1. In the guest, the mountpoint is mounted as virtio-fs when the VM backend
   offers it (a QEMU with vhost-user, or the bundled krun runner), else served
   by `sandboxfs` (FUSE).
2. Each file operation becomes a FUSE request on a virtio-fs queue (or an RPC
   message over virtio-serial with `sandboxfs`).
3. The daemon dispatches it through its mount table: native mounts (host
   directories, in-memory filesystems) are served directly, other providers
   through a cache that calls your process.

Providers can implement very different semantics (in-memory, read-only host
directories, remote-backed content, policy wrappers, etc.) while the guest
still sees normal POSIX paths. See [Files and Mounts](./vfs.md).

## Protocol Details

The protocol between controller and daemon, the Rust crates and their
responsibilities, and the daemon's internals are specified in
[`native/DESIGN.md`](https://github.com/earendil-works/gondolin/blob/main/native/DESIGN.md).

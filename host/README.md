# Gondolin Host Controller

This package contains the host-side CLI and WebSocket controller for the sandbox
VM.

## Current state

- QEMU is launched with a **virtio-serial** control channel and a **virtio-net** device wired to a host socket backend.
- A WebSocket server exposes an exec API (stdin/pty + streaming stdout/stderr) that the CLI and `VM` client use.
- The host runs a **TypeScript network stack** (`NetworkStack`) that implements Ethernet framing, ARP, IPv4, ICMP, DHCP, TCP, and UDP.
- TCP flows are classified; only HTTP and TLS are accepted (CONNECT is rejected). Other TCP traffic is dropped.
- HTTP/HTTPS requests are terminated on the host and bridged via `fetch`, with optional request/response hooks.
- TLS MITM is implemented: a local CA + per-host leaf certs are generated under `var/mitm` and used to re-encrypt TLS.
- UDP forwarding is limited to DNS (port 53). The guest still points at `8.8.8.8` by default.
- A WS test (`pnpm run test:ws`) exercises guest HTTP/HTTPS fetches against icanhazip.com.
- The `VM` client exposes hookable VFS mounts (defaults to a `MemoryProvider` at `/`) for filesystem policy experiments.

## What is *not* implemented yet
- SandboxPolicy allow/deny rules are defined but not enforced for DNS/HTTP/TLS.
- Generic TCP/UDP passthrough (beyond HTTP/TLS + DNS) is not supported.

## Networking approach

Instead of attaching the VM to a real bridge/tap device, QEMU streams raw
Ethernet frames over a Unix socket into a TypeScript network stack.  That stack
decodes ARP/IP/TCP/UDP and deliberately only allows HTTP and TLS.  When an HTTP
flow is detected (or TLS that can be MITM'ed), the host intercepts the request
in JavaScript and replays it via `fetch`.  This gives a single, portable control
point for policy enforcement, logging, and request/response hooks without
granting the guest arbitrary socket access or requiring privileged host network
setup.

## Filesystem hooks

`VM` can expose hookable VFS mounts (defaults to `MemoryProvider` at `/`). Pass
mounts and optional hooks via `vfs` (or set `vfs: null` to disable) and access
the provider with `getVfs()`:

```ts
import { VM } from "./src/vm";
import { MemoryProvider } from "./src/vfs";

const vm = new VM({
  vfs: {
    mounts: { "/": new MemoryProvider() },
    hooks: {
      before: (ctx) => console.log("before", ctx.op, ctx.path),
      after: (ctx) => console.log("after", ctx.op, ctx.path),
    },
  },
});

const vfs = vm.getVfs();
```

Use `fuseMount` in the `vfs` options to change the guest mount point (defaults to `/data`).

## Useful commands
- `pnpm run dev:ws -- --net-debug` to start the WS server with network debug logging.
- `GONDOLIN_DEBUG=net pnpm run dev:ws` to enable the same logging via env (comma separated).
- `pnpm run test:ws` to run the guest HTTP/HTTPS fetch test via WS.
- `pnpm run bash` to launch a quick interactive Bash session against the VM.

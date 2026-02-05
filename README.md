# Gondolin

**Local Linux micro-VMs with a fully programmable network stack and filesystem.**

AI agents are generating code that runs immediately and increasingly without
human review.  That code often calls external APIs, which means it needs
credentials and network access.  Sandboxing the compute isn't enough as you need
to control network egress and protect secrets from exfiltration.  You also
want to be able to tighly control the file system, for convenience of the agent
and to control persistence.

Gondolin gives you that.  Lightweight QEMU micro-VMs boot in seconds on your Mac
or Linux machine.  The network stack and virtual filesystem are implemented
entirely in JavaScript, giving you complete programmatic control over what the
sandbox can access and what secrets it can use.

```ts
import { VM, createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.openai.com"],
  secrets: {
    OPENAI_API_KEY: {
      hosts: ["api.openai.com"],
      value: process.env.OPENAI_API_KEY,
    },
  },
});

const vm = await VM.create({ httpHooks, env });
await vm.exec("curl -H \"Authorization: Bearer $OPENAI_API_KEY\" https://api.openai.com/v1/models");
await vm.close();
```

The guest never sees the real API key. It only gets a placeholder.  The actual
secret is injected by the host, only when making requests to approved hosts.  If
prompt-injected code tries to exfiltrate that placeholder to an unauthorized
server it won't be able to get it quite as easily.

## Quick Start

```bash
npx @earendil-works/gondolin bash
```

Guest images (~200MB) are downloaded automatically on first run.  You'll need
QEMU and Node installed:

| macOS | Linux (Debian/Ubuntu) |
|-------|----------------------|
| `brew install qemu node` | `sudo apt install qemu-system-arm nodejs npm` |

> **Note:** Only ARM64 (Apple Silicon, Linux aarch64) is currently tested.

## Why Gondolin?

- **Runs locally.** Same behavior on macOS and Linux without a specific cloud dependency.
- **Secrets that can't be stolen.** Credentials are injected at the network layer, never visible inside the VM (implemented as a hook that can be changed)
- **Programmable network policy.** Allowlist hosts, hook requests/responses, block internal ranges—all in JavaScript.
- **Programmable filesystem.** Mount in-memory filesystems, proxy to remote storage, or hook every operation.
- **Fast.** Boots quickly, optimized for LLM workflows that spin up, execute, and tear down frequently.
- **Familiar environment.** A real Linux VM that LLMs know how to use.

## Programmable Filesystem

The VFS layer lets you control what the guest sees. Mount in-memory filesystems,
expose host directories (read-only or read-write), or implement custom providers
that proxy to remote storage:

```ts
import { VM, MemoryProvider, RealFSProvider, ReadonlyProvider } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: {
      "/workspace": new MemoryProvider(),
      "/data": new ReadonlyProvider(new RealFSProvider("/host/data")),
    },
  },
});
```

See [`host/README.md`](host/README.md) for full API details.

## Choices

* **VM:** we looked at Firecracker and QEMU and went with the latter.  A key motivation
  here is that firecracker cannot run on Macs which makes it harder to achieve
  parity between Mac and Linux, and divergence of behavior is always scary.
* **Networking:** the approach we went for here is to implement an ethernet stack in
  JavaScript.  From the perspective of the guest it's just a normal network, but all
  HTTP requests are implicitly re-encrypted by the host.  While this means that the
  trust store needs to trust the certificate of the host, it also means that the guest
  is well protected against sending bad HTTP request to untrusted destinations.  DNS
  is passed through, but DNS results are actually not used by the host at all.  The
  host triggers another resolve from scratch and ensures that blocked IPs cannot be
  accessed through DNS rebinding.
* **Filesystem:** the guest uses the file system from the image, plus a bunch of tmpfs
  mounds for temporary changes.  For persistance node VFS mounts are added through a
  singular FUSE instance.  Bind mounts are used to re-bind that instance to different
  paths.  This allows you to implement different virtual file system behavior in
  JavaScript.  While from a performance perspective very suboptimal, it has the benefit
  that you can lazy load resources from your own APIs or storage layers without writing
  complex native code.
* **Linux distribution:** currently this targets archlinux because of its quick boot
  times.  There might be better choices and this is something we should experiment with.
  In particular using nixOS is very appealing for agentic use.
* **Host bridge:** the host spawns a process that manages the QEMU lifecycle and
  plumbing for the sandbox to work (it's the endpoint for the virtio protocol). The
  TypeScript library talks to that host controller in-process (same Node runtime),
  keeping the control path local and synchronous.
* **Programming languages:** the sandbox is written in Zig because it produces small
  binaries and allows trivial cross compilation.  The host is written in TypeScript
  because it allows plugging in custom behavior trivially for the VM.

## Components

- [`guest/`](guest/) — Zig-based `sandboxd` daemon, Alpine initramfs build, and QEMU helpers.
- [`host/`](host/) — TypeScript host controller and in-process control plane for the guest.

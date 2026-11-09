# Gondolin Agent Sandbox

**Local Linux micro-VMs with programmable network and filesystem control.**

AI agents increasingly run generated code without human review.  That code often
needs network access and credentials, which creates exfiltration risk.

Gondolin runs that code inside a fast local Linux micro-VM (`libkrun` where
available, QEMU otherwise) while keeping network and filesystem access under
host-side policy control.  That policy layer can be
customized via JavaScript.

## Quick Example

```ts
import { VM, createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN!,
    },
  },
});

const vm = await VM.create({ httpHooks, env });

// String form runs in /bin/sh -lc "..."
const result = await vm.exec(`
  curl -sS -f \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    https://api.github.com/user
`);

console.log("exitCode:", result.exitCode);
console.log("stdout:\n", result.stdout);
console.log("stderr:\n", result.stderr);

await vm.close();
```

The guest only sees a placeholder token. The real secret is injected by the
host only for allowed destinations (including `Authorization: Basic ...` flows).

## CLI Quick Start

```bash
npx @earendil-works/gondolin bash
```

Useful session commands:

```bash
# List running sessions
npx @earendil-works/gondolin list

# Attach to an existing session
npx @earendil-works/gondolin attach <session-id>

# Snapshot a running session (stops it)
npx @earendil-works/gondolin snapshot <session-id>

# Resume from snapshot id/path
npx @earendil-works/gondolin bash --resume <snapshot-id-or-path>
```

Guest images (~200MB+) are downloaded on first use from the builtin registry
and cached locally (default: `alpine-base:latest`).

## Requirements

| Host                                 | VM backend | Install                                                    |
| ------------------------------------ | ---------- | ---------------------------------------------------------- |
| macOS, Apple silicon                 | krun       | Node.js only (`brew install node`)                         |
| Linux x86_64 with `/dev/kvm`         | krun       | Node.js only                                               |
| macOS, Intel                         | QEMU       | `brew install qemu node`                                   |
| Linux arm64 (Debian/Ubuntu)          | QEMU       | `sudo apt install qemu-system-arm nodejs npm`              |
| Linux x86_64 without `/dev/kvm`      | QEMU (TCG) | `sudo apt install qemu-system-x86 nodejs npm`              |

Node.js 22.19 or newer. `npm install @earendil-works/gondolin` also installs
the platform packages with the Gondolin daemon (`gondolind`, macOS and Linux on
arm64 and x64) and, on macOS arm64 and Linux x86_64, the krun runner. VMs run
on libkrun where it can (Apple silicon, Linux x86_64 with read/write
`/dev/kvm`) and on QEMU otherwise, so QEMU is only needed on the other hosts
or when you select the `qemu` backend. See
[Installation](https://earendil-works.github.io/gondolin/install/) for the
details, krun on Linux arm64, the static CLI without Node.js, and building
from a checkout.

## Feature Highlights

- **Local disposable micro-VMs** for agent turns/tasks
- **Programmable HTTP/TLS egress policy** (allowlists + request/response hooks)
- **Secret injection without guest exposure** via placeholders
- **Programmable VFS mounts** that allow you to write custom file system behavior in JavaScript.
- **Ingress gateway** to expose guest HTTP services on host (`--listen`, `vm.enableIngress()`)
- **Attaching** allows you to attach a shell to an already running VM
- **SSH support**
  - host -> guest access (`vm.enableSsh()`)
  - optional guest -> upstream allowlisted SSH egress (proxied, exec-oriented)
- **Disk checkpoints (snapshots)** with resume support
- **Custom image builds** (Alpine-based build pipeline, optional OCI rootfs source)
- **Remote machines**: the VM runs under a static Rust daemon (`gondolind`) that also works on another machine without Node.js, while policy, hooks and credentials stay local; the same binary is a static CLI
- **Daemon-side policies**: self-contained JavaScript policies (`createDjsHooks()`, `--hooks-script`) that run inside the daemon without a round trip to your process
- **Configurable DNS behavior** (`synthetic`, `trusted`, `open`), rootfs modes (`readonly`, `memory`, `cow`), and runtime rootfs sizing

## Documentation

- [Installation](https://earendil-works.github.io/gondolin/install/) and [Quick Start](https://earendil-works.github.io/gondolin/quickstart/)
- [Running Commands](https://earendil-works.github.io/gondolin/exec/)
- [Network Access](https://earendil-works.github.io/gondolin/network-access/), [HTTP Hooks and Policies](https://earendil-works.github.io/gondolin/hooks/) and [Secrets](https://earendil-works.github.io/gondolin/secrets/)
- [Files and Mounts](https://earendil-works.github.io/gondolin/vfs/) and [Persistence and Snapshots](https://earendil-works.github.io/gondolin/snapshots/)
- [Ingress](https://earendil-works.github.io/gondolin/ingress/) and [SSH](https://earendil-works.github.io/gondolin/ssh/)
- [Images](https://earendil-works.github.io/gondolin/images/) and [Building Custom Images](https://earendil-works.github.io/gondolin/custom-images/)
- [Remote Machines](https://earendil-works.github.io/gondolin/remote/)
- [CLI Reference](https://earendil-works.github.io/gondolin/cli/), [SDK Reference](https://earendil-works.github.io/gondolin/sdk/) and [Environment Variables](https://earendil-works.github.io/gondolin/environment/)
- [Architecture](https://earendil-works.github.io/gondolin/architecture/), [Security Design](https://earendil-works.github.io/gondolin/security/) and [Limitations](https://earendil-works.github.io/gondolin/limitations/)
- [Upgrading](https://earendil-works.github.io/gondolin/upgrading/)

## Repository Guides

- [Host package](host/README.md): installation, CLI usage, and SDK examples
- [Guest sandbox](guest/README.md): Zig build and image/initramfs pipeline
- [`images/`](images): canonical image release build configs (used by image-release workflow)
- [Examples](host/examples): end-to-end integration examples


## Pi Extension

There is a [Pi + Gondolin extension](host/examples/pi-gondolin.ts) that runs
pi tools inside a micro-VM and mounts your project at `/workspace`.

## Browser Use

There is a [Browser Use example](host/examples/browser-use.ts) that runs
Chromium inside a micro-VM and drives it from a [Browser
Use](https://github.com/browser-use/browser-use) agent on the host through the
ingress gateway.  Only the guest-local Chrome DevTools endpoint is exposed:

```bash
node host/bin/gondolin.ts build --config host/examples/chromium.json --tag browser-use:latest
OPENAI_API_KEY=... node host/examples/browser-use.ts
```

## AI Use Disclaimer

This codebase has been built with the support of coding agents.

## License and Links

- [Documentation](https://earendil-works.github.io/gondolin/)
- [Issue Tracker](https://github.com/earendil-works/gondolin/issues)
- License: [Apache-2.0](https://github.com/earendil-works/gondolin/blob/main/LICENSE)

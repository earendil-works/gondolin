# Gondolin Agent Sandbox

**Local Linux micro-VMs with programmable network and filesystem control.**

AI agents increasingly run generated code without human review.  That code often
needs network access and credentials, which creates exfiltration risk.

Gondolin runs that code inside a fast local QEMU VM while keeping network and
filesystem access under host-side policy control.  That policy layer can be
customized via JavaScript.

## Quick Example

```ts
import { VM, createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN,
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

Guest assets (kernel/initramfs/rootfs, ~200MB) are resolved automatically on
first use via `builtin-image-registry.json` and cached locally. When no image
is specified, Gondolin uses `GONDOLIN_DEFAULT_IMAGE` (default:
`alpine-base:latest`).

Requirements:

| macOS                    | Linux (Debian/Ubuntu)                         |
| ------------------------ | --------------------------------------------- |
| `brew install qemu node` | `sudo apt install qemu-system-arm nodejs npm` |

> Linux and macOS are supported. ARM64 is the most tested path today.

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
- **Configurable DNS behavior** (`synthetic`, `trusted`, `open`) and rootfs modes (`readonly`, `memory`, `cow`)

## Documentation

- [Introduction](https://earendil-works.github.io/gondolin/)
- [CLI](https://earendil-works.github.io/gondolin/cli/)
- [SDK](https://earendil-works.github.io/gondolin/sdk/)
- [Secrets Handling](https://earendil-works.github.io/gondolin/secrets/)
- [SSH](https://earendil-works.github.io/gondolin/ssh/)
- [Custom Images](https://earendil-works.github.io/gondolin/custom-images/)
- [Architecture Overview](https://earendil-works.github.io/gondolin/architecture/)
- [Security Design](https://earendil-works.github.io/gondolin/security/)
- [Limitations](https://earendil-works.github.io/gondolin/limitations/)

## Repository Guides

- [Host package](host/README.md): installation, CLI usage, and SDK examples
- [Guest sandbox](guest/README.md): Zig build and image/initramfs pipeline
- [Examples](host/examples): end-to-end integration examples


## Pi Extension

There is a [Pi + Gondolin extension](host/examples/pi-gondolin.ts) that runs
pi tools inside a micro-VM and mounts your project at `/workspace`.

## AI Use Disclaimer

This codebase has been built with the support of coding agents.

## License and Links

- [Documentation](https://earendil-works.github.io/gondolin/)
- [Issue Tracker](https://github.com/earendil-works/gondolin/issues)
- License: [Apache-2.0](https://github.com/earendil-works/gondolin/blob/main/LICENSE)

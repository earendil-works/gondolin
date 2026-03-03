# Gondolin

**Local Linux micro-VMs with a fully programmable network stack and filesystem.**

Gondolin runs lightweight micro-VMs on your Mac or Linux machine (QEMU by
default, optional `krun` backend). The network stack and virtual filesystem are
implemented in TypeScript, giving you complete programmatic control over what
the sandbox can access and what secrets it can use.

## Requirements

You need QEMU installed to run the micro-VMs (default backend):

| macOS               | Linux (Debian/Ubuntu)              |
| ------------------- | ---------------------------------- |
| `brew install qemu` | `sudo apt install qemu-system-arm` |

Optional experimental backend:

- `libkrun` + `host/krun-runner` (`sandbox.vmm = "krun"`)
- `make krun-runner` from repo root stages dependencies locally, extracts a libkrunfw-compatible kernel, and builds the runner
  - on macOS, it also ad-hoc signs the runner with `com.apple.security.hypervisor`
  - if `libkrunfw-prebuilt-<arch>.tgz` is unavailable (for example `x86_64`), Gondolin falls back to `libkrunfw-<arch>.tgz` automatically
- `GONDOLIN_VMM=krun` selects it globally
- `GONDOLIN_KRUN_RUNNER=/path/to/gondolin-krun-runner` overrides runner path
- `GONDOLIN_KRUN_KERNEL=/path/to/Image` overrides the krun kernel image
- `GONDOLIN_KRUN_INITRD=/path/to/initrd` overrides the krun initrd (defaults to an auto-created empty file)
- backend parity matrix: [docs/backends.md](../docs/backends.md)

Linux prerequisites for `make krun-runner` (Ubuntu/Debian):

```bash
sudo apt install \
  build-essential curl git make pkg-config clang lld xz-utils \
  libclang-dev llvm-dev libcap-ng-dev

# libkrun needs current stable Rust (edition2024 crates)
curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"

# install Zig 0.15.1 for your Linux architecture
```

- Node.js >= 23.6

> **Note:** Runtime validation is currently strongest on ARM64 (Apple Silicon, Linux aarch64).
> Linux x86_64 is currently smoke-tested for `make krun-runner` in CI.

## Installation

```bash
npm install @earendil-works/gondolin
```

## Quick start (CLI)

```bash
npx @earendil-works/gondolin bash
```

You can also discover and re-attach to running VMs from another terminal:

```bash
# List running sessions
npx @earendil-works/gondolin list

# Attach a second shell to a running VM by UUID/prefix
npx @earendil-works/gondolin attach <session-id>

# Snapshot a running VM session (stops that session)
npx @earendil-works/gondolin snapshot <session-id>

# Resume from snapshot id/path
npx @earendil-works/gondolin bash --resume <snapshot-id-or-path>
```

Guest images (~200MB) are automatically resolved on first run via
`builtin-image-registry.json` and cached in `~/.cache/gondolin/images/`.
If no explicit image is provided, Gondolin uses `GONDOLIN_DEFAULT_IMAGE`
(default: `alpine-base:latest`).

## Hello world

```ts
import { VM, createHttpHooks, MemoryProvider } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN!,
    },
  },
});

const vm = await VM.create({
  httpHooks,
  env,
  vfs: {
    mounts: { "/workspace": new MemoryProvider() },
  },
});

// NOTE:
// - `vm.exec("...")` runs via `/bin/sh -lc "..."` (shell features work)
// - `vm.exec([cmd, ...argv])` executes `cmd` directly and does not search `$PATH`
//   so `cmd` must be an absolute path
const cmd = `
  curl -sS -f \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    https://api.github.com/user
`;

// You can pass a string to `vm.exec(...)` as shorthand for `/bin/sh -lc "..."`.
const result = await vm.exec(cmd);

console.log("exitCode:", result.exitCode);
console.log("stdout:\n", result.stdout);
console.log("stderr:\n", result.stderr);

await vm.close();
```

The guest never sees the real secret values. It only gets placeholders.
Placeholders are substituted by the host in outbound HTTP headers, including
`Authorization: Basic …` (the base64 token is decoded and placeholders in
`username:password` are replaced).

By default, placeholders in URL query parameters are not substituted. You can
opt in with `replaceSecretsInQuery: true`, but this increases reflection
risk and should only be used when required.

> **Note:** Avoid mounting a `MemoryProvider` at `/` unless you also provide a
> system CA bundle. Gondolin injects its MITM CA at `/etc/gondolin/mitm/ca.crt`,
> but if your root mount hides distro CA files then public TLS verification can
> still fail (e.g. `curl: (60)`).

## Outbound SSH host allowlist

SSH egress can be enabled with an explicit host allowlist:

```ts
const vm = await VM.create({
  dns: {
    mode: "synthetic",
    syntheticHostMapping: "per-host",
  },
  ssh: {
    allowedHosts: ["github.com"],

    // Upstream host key verification
    //
    // If `hostVerifier` is not provided, gondolin verifies upstream host keys using
    // OpenSSH known_hosts (by default: ~/.ssh/known_hosts and /etc/ssh/ssh_known_hosts).
    // You can override this with `knownHostsFile`.
    // knownHostsFile: "/path/to/known_hosts",

    // Option A: use an ssh-agent (recommended for encrypted keys)
    agent: process.env.SSH_AUTH_SOCK,

    // Option B: provide a raw private key
    credentials: {
      "github.com": {
        username: "git",
        privateKey: process.env.GITHUB_DEPLOY_KEY!,
      },
    },
  },
});
```

`syntheticHostMapping: "per-host"` is required so the host can map outbound
TCP connections on port `22` back to the intended hostname.

When credentials or an SSH agent are configured, the host terminates the guest SSH
session and proxies `exec` requests (including Git smart-protocol commands) to the
real upstream host using host-side authentication. The private key is never
visible in the guest.

If no matching credential is configured for a host and no `ssh.agent` is set, the
SSH flow is blocked (direct passthrough is not supported).

Because this is SSH termination, the guest sees a host-provided SSH host key;
configure guest `known_hosts` (or disable strict checking explicitly) as needed.

Upstream SSH host keys are verified against OpenSSH `known_hosts` by default.
If the upstream host is missing (or the key changes), the proxied SSH request
will fail.

## License and Links

- [Documentation](https://earendil-works.github.io/gondolin/)
- [Issue Tracker](https://github.com/earendil-works/gondolin/issues)
- License: [Apache-2.0](https://github.com/earendil-works/gondolin/blob/main/LICENSE)

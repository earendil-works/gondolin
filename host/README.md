# Gondolin

**Local Linux micro-VMs with a fully programmable network stack and filesystem.**

Gondolin runs lightweight micro-VMs on your Mac or Linux machine (`krun`
where available, QEMU otherwise). Every guest network connection and file
access goes through the host, and this TypeScript SDK gives you complete
programmatic control over what the sandbox can access and what secrets it can
use.

## Requirements

- Node.js >= 22.19.0
- QEMU (`qemu-img` is used on both VM backends; QEMU runs the VM where libkrun
  cannot):

| macOS               | Linux (Debian/Ubuntu)                                                              |
| ------------------- | ---------------------------------------------------------------------------------- |
| `brew install qemu` | `sudo apt install qemu-system-arm qemu-utils` (arm64) or `qemu-system-x86 qemu-utils` (x64) |

Installing this package also installs, as optional platform packages, the
Gondolin daemon (`gondolind`, `@earendil-works/gondolin-native-*` for macOS
and Linux on arm64 and x64) and, on macOS arm64 and Linux x86_64, the krun
runner. VMs use libkrun where it can run (Apple silicon, Linux with
read/write `/dev/kvm`) and QEMU otherwise. See
[Installation](https://earendil-works.github.io/gondolin/install/) for
details, installs without optional dependencies (`GONDOLIN_NATIVE_BIN`), Linux
arm64 krun, and building from a checkout.

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

The same commands (except `build` and `tools`) are also available without
Node.js in the static `gondolin` binary of the platform packages; see
[CLI: Static CLI](https://earendil-works.github.io/gondolin/cli/#static-cli-no-nodejs).

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
// - `vm.exec([cmd, ...argv])` executes `cmd` directly (no shell); a bare name
//   is looked up in the guest's `$PATH`
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
By default (`secretPlaceholderMode: "shared"`) those placeholders look like
`<random-marker>.<normalized_secret_name>`, where all generated secrets share
one random marker. `secretPlaceholderMode: "unique"` instead gives each secret
its own fully random placeholder like `GONDOLIN_SECRET_<random>`.
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

`syntheticHostMapping: "per-host"` (the default when `ssh` is configured) is
required so the host can map outbound TCP connections on port `22` back to the
intended hostname.

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

# Gondolin

**Local Linux micro-VMs with a fully programmable network stack and filesystem.**

Gondolin runs lightweight QEMU micro-VMs on your Mac or Linux machine. The
network stack and virtual filesystem are implemented in TypeScript, giving you
complete programmatic control over what the sandbox can access and what secrets
it can use.

## Requirements

You need QEMU installed to run the micro-VMs:

| macOS | Linux (Debian/Ubuntu) |
|-------|----------------------|
| `brew install qemu` | `sudo apt install qemu-system-arm` |

- Node.js >= 22

> **Note:** Only ARM64 (Apple Silicon, Linux aarch64) is currently tested.

## Installation

```bash
npm install @earendil-works/gondolin
```

## Quick start (CLI)

```bash
npx @earendil-works/gondolin bash
```

Guest images (~200MB) are automatically downloaded on first run and cached in
`~/.cache/gondolin/`.

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

> **Note:** Avoid mounting a `MemoryProvider` at `/` unless you also provide CA
> certificates; doing so hides `/etc/ssl/certs` and will cause TLS verification
> failures (e.g. `curl: (60)`).

## License and Links

- [Documentation](https://earendil-works.github.io/gondolin/)
- [Issue Tracker](https://github.com/earendil-works/gondolin/issues)
- License: [Apache-2.0](https://github.com/earendil-works/gondolin/blob/main/LICENSE)

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

const result = await vm.exec(
  "curl -H 'Authorization: Bearer $GITHUB_TOKEN' https://api.github.com/user"
);
console.log(result.stdout);

await vm.close();
```

> **Note:** Avoid mounting a `MemoryProvider` at `/` unless you also provide CA
> certificates; doing so hides `/etc/ssl/certs` and will cause TLS verification
> failures (e.g. `curl: (60)`).

## License and Links

- [Documentation](https://earendil-works.github.io/gondolin/)
- [Issue Tracker](https://github.com/earendil-works/gondolin/issues)
- License: [Apache-2.0](https://github.com/earendil-works/gondolin/blob/main/LICENSE)

# Gondolin SDK

This document contains the more detailed, programmatic documentation for the
`@earendil-works/gondolin` TypeScript SDK (VM lifecycle, network policy, VFS,
asset management, and development notes).

If you're looking for a quick overview + a minimal "hello world", see:
- [`host/README.md`](../host/README.md)

## Network policy (HTTP allowlists + secret injection)

The network stack only allows HTTP and TLS traffic. TCP flows are classified and
non-HTTP traffic is dropped. Requests are intercepted and replayed via `fetch`
on the host side, enabling:

- Host allowlists with wildcard support
- Request/response hooks for logging and modification
- Secret injection without exposing credentials to the guest
- DNS rebinding protection

```ts
import { createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.example.com", "*.github.com"],
  secrets: {
    API_KEY: { hosts: ["api.example.com"], value: process.env.API_KEY! },
  },
  blockInternalRanges: true, // default: true
  onRequest: async (req) => {
    console.log(req.url);
    return req;
  },
  onResponse: async (req, res) => {
    console.log(res.status);
    return res;
  },
});
```

Notable consequences:

- ICMP echo requests in the guest "work", but are synthetic (you can ping any address).
- HTTP redirects are resolved on the host and hidden from the guest (the guest only
  sees the final response), so redirects cannot escape the allowlist.
- Even though the guest does DNS resolutions, they're largely disregarded for
  policy; the host enforces policy against the HTTP `Host` header and does its own
  resolution to prevent DNS rebinding attacks.

For deeper conceptual background, see [Network stack](./network.md).

## VFS providers

The VM exposes hookable VFS mounts:

```ts
import {
  VM,
  MemoryProvider,
  RealFSProvider,
  ReadonlyProvider,
} from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: {
      "/": new MemoryProvider(),
      "/data": new RealFSProvider("/host/data"),
      "/config": new ReadonlyProvider(new RealFSProvider("/host/config")),
    },
    hooks: {
      before: (ctx) => console.log("before", ctx.op, ctx.path),
      after: (ctx) => console.log("after", ctx.op, ctx.path),
    },
  },
});
```

> Note: Avoid mounting a `MemoryProvider` at `/` unless you also provide CA
> certificates; doing so hides `/etc/ssl/certs` and will cause TLS verification
> failures (e.g. `curl: (60)`).

## Asset management

Guest images (kernel, initramfs, rootfs) are automatically downloaded from
GitHub releases on first use. The default cache location is `~/.cache/gondolin/`.

Override the cache location:

```bash
export GONDOLIN_GUEST_DIR=/path/to/assets
```

Check asset status programmatically:

```ts
import {
  hasGuestAssets,
  ensureGuestAssets,
  getAssetDirectory,
} from "@earendil-works/gondolin";

console.log("Assets available:", hasGuestAssets());
console.log("Asset directory:", getAssetDirectory());

// Download if needed
const assets = await ensureGuestAssets();
console.log("Kernel:", assets.kernelPath);
```

## Building custom guest images

The full custom image documentation is here:
- [Building Custom Images](./custom-images.md)

Quick-start reminder:

```bash
gondolin build --init-config > build-config.json
# Edit build-config.json to add packages (rust, go, etc.)
gondolin build --config build-config.json --output ./my-assets
GONDOLIN_GUEST_DIR=./my-assets gondolin bash
```

Use the custom assets programmatically by pointing `sandbox.imagePath` at the
asset directory:

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  sandbox: {
    imagePath: "./my-assets",
  },
});

await vm.exec("uname -a");
await vm.close();
```

## Debug logging

See [Debug Logging](./debug.md).

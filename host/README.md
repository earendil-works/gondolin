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

## Requirements

You need QEMU installed to run the micro-VMs:

| macOS | Linux (Debian/Ubuntu) |
|-------|----------------------|
| `brew install qemu` | `sudo apt install qemu-system-arm` |

> **Note:** Only ARM64 (Apple Silicon, Linux aarch64) is currently tested.

## Installation

```bash
npm install @earendil-works/gondolin
```

## Quick Start

```bash
npx @earendil-works/gondolin bash
```

Guest images (~200MB) are automatically downloaded on first run and cached in
`~/.cache/gondolin/`.

## Library Usage

```ts
import { VM, createHttpHooks, MemoryProvider } from "@earendil-works/gondolin";

// Create a VM with network policy
const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN!,
    },
  },
});

// Use VM.create() to auto-download guest assets if needed
const vm = await VM.create({
  httpHooks,
  env,
  vfs: {
    mounts: { "/workspace": new MemoryProvider() },
  },
});

// Run commands
const result = await vm.exec("curl -H 'Authorization: Bearer $GITHUB_TOKEN' https://api.github.com/user");
console.log(result.stdout);

await vm.close();
```

> **Note:** Avoid mounting a `MemoryProvider` at `/` unless you also provide CA
> certificates; doing so hides `/etc/ssl/certs` and will cause TLS verification
> failures (e.g. `curl: (60)`).

## Features

- **QEMU micro-VM** with virtio-serial control channel and virtio-net device
- **In-process control API** for exec (stdin/pty + streaming stdout/stderr)
- **TypeScript network stack** implementing Ethernet, ARP, IPv4, ICMP, DHCP, TCP, UDP
- **HTTP/HTTPS interception** with request/response hooks and DNS-rebind-safe allowlists
- **TLS MITM** with auto-generated CA and per-host leaf certificates
- **VFS mounts** with hookable providers (memory, real filesystem, read-only)
- **Secret injection** that never exposes credentials inside the guest

> **Note:** The secret-hiding strategy is inspired by [Deno Sandbox](https://deno.com/blog/introducing-deno-sandbox#secrets-that-cant-be-stolen).

## CLI Commands

### gondolin bash

Launch an interactive bash session:

```bash
gondolin bash [options]
```

Options:
- `--mount-hostfs HOST:GUEST[:ro]` - Mount host directory at guest path
- `--mount-memfs PATH` - Create memory-backed mount at path
- `--allow-host HOST` - Allow HTTP requests to host (supports wildcards)
- `--host-secret NAME@HOST[,HOST...][=VALUE]` - Add secret for specified hosts

Examples:

```bash
# Mount a project directory
gondolin bash --mount-hostfs ~/project:/workspace

# Mount read-only with network access
gondolin bash --mount-hostfs /data:/data:ro --allow-host api.github.com

# With secret injection (reads from $GITHUB_TOKEN env var)
gondolin bash --allow-host api.github.com --host-secret GITHUB_TOKEN@api.github.com
```

### gondolin exec

Run a command in the sandbox:

```bash
gondolin exec [options] -- COMMAND [ARGS...]
```

Examples:

```bash
# Simple command
gondolin exec -- ls -la /

# With mounted filesystem
gondolin exec --mount-hostfs ~/project:/workspace -- npm test
```

## Network Policy

The network stack only allows HTTP and TLS traffic. TCP flows are classified and
non-HTTP traffic is dropped. Requests are intercepted and replayed via `fetch`
on the host side, enabling:

- Host allowlists with wildcard support
- Request/response hooks for logging and modification
- Secret injection without exposing credentials to the guest
- DNS rebinding protection

```ts
const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.example.com", "*.github.com"],
  secrets: {
    API_KEY: { hosts: ["api.example.com"], value: "secret" },
  },
  blockInternalRanges: true, // default: true
  onRequest: async (req) => { console.log(req.url); return req; },
  onResponse: async (req, res) => { console.log(res.status); return res; },
});
```

This also has some other consequences that are notable:

* ICMP echo requests in the guest just work.  But they are total lies.  You can
  ping any address and you get a response back, it's not actually ever sending
  a request there.
* HTTP redirects are resolved on the host, and hidden form the guest.  When the
  guest does an HTTP request, it only gets the final redirect response, not any
  request in the chain.  This is done for security reasons because it means that
  the host can ensure that no redirect is going somewhere, where the policy does
  not permit it (we never trust the IP the client resolves).
* Even though the guest does DNS resolutions, they are for the most part
  disregarded as the actual HTTP request is done by the host based on the `Host`
  header in the request.

## VFS Providers

The VM exposes hookable VFS mounts:

```ts
import { VM, MemoryProvider, RealFSProvider, ReadonlyProvider } from "@earendil-works/gondolin";

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

## Asset Management

Guest images (kernel, initramfs, rootfs) are automatically downloaded from
GitHub releases on first use. The default cache location is `~/.cache/gondolin/`.

Override the cache location:
```bash
export GONDOLIN_GUEST_DIR=/path/to/assets
```

Check asset status programmatically:
```ts
import { hasGuestAssets, ensureGuestAssets, getAssetDirectory } from "@earendil-works/gondolin";

console.log("Assets available:", hasGuestAssets());
console.log("Asset directory:", getAssetDirectory());

// Download if needed
const assets = await ensureGuestAssets();
console.log("Kernel:", assets.kernelPath);
```

## Building Custom Guest Images

You can build custom guest images with different packages or configurations using
the `gondolin build` command.

### Quick Start

Build a custom image with the default configuration:

```bash
gondolin build --output ./my-assets
```

### Customization Workflow

1. Generate a default configuration:
```bash
gondolin build --init-config > build-config.json
```

2. Edit the configuration to customize packages, settings, etc.:
```json
{
  "arch": "aarch64",
  "distro": "alpine",
  "alpine": {
    "version": "3.23.0",
    "kernelPackage": "linux-virt",
    "kernelImage": "vmlinuz-virt",
    "rootfsPackages": [
      "linux-virt", "rng-tools", "bash", "ca-certificates", "curl",
      "nodejs", "npm", "python3", "git", "your-custom-package"
    ]
  },
  "rootfs": {
    "label": "gondolin-root"
  }
}
```

3. Build with your configuration:
```bash
gondolin build --config build-config.json --output ./my-assets
```

4. Use the custom assets:
```bash
GONDOLIN_GUEST_DIR=./my-assets gondolin bash
```

### Build Options

- `--init-config` - Generate a default build configuration to stdout
- `--config FILE` - Use a custom configuration file
- `--output DIR` - Output directory for built assets (required)
- `--arch ARCH` - Target architecture (`aarch64` or `x86_64`)
- `--verify DIR` - Verify assets in a directory against their manifest
- `--quiet` - Reduce output verbosity

> **Note:** If you set a custom Alpine `kernelPackage` (e.g., `linux-lts`), also
> set `kernelImage` to the corresponding filename inside the package (e.g.,
> `vmlinuz-lts`).

### Build Requirements

Building custom images requires:
- **Zig 0.15.2** compiler (for cross-compiling sandboxd/sandboxfs)
- **lz4** for initramfs compression
- **curl** for downloading Alpine packages
- **python3** for package dependency resolution
- **e2fsprogs** (mke2fs) for creating ext4 rootfs images

On macOS:
```bash
brew install zig@0.15 lz4 e2fsprogs
```

On Linux:
```bash
# Install Zig 0.15.2 from https://ziglang.org/download/
sudo apt install lz4 curl python3 e2fsprogs
```

### Architecture Cross-Compilation

The build system supports cross-compiling for different architectures:

```bash
# Build for x86_64 on an ARM64 host
gondolin build --arch x86_64 --output ./x64-assets

# Build for ARM64 on an x86_64 host
gondolin build --arch aarch64 --output ./arm64-assets
```

### Using Custom Assets Programmatically

Point `imagePath` at the asset directory (it will use `manifest.json` when present):

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  server: {
    imagePath: "./my-assets",
  },
});
```

## Development

When working in the gondolin repository, assets are loaded from
`guest/image/out/` automatically if present.

```bash
# Build the guest image
cd guest && make build

# Run development CLI
pnpm run bash

# Run tests (includes VM/FUSE end-to-end checks; requires QEMU + guest image assets)
pnpm run test
```

## License

Apache-2.0

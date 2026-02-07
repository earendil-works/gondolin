# Building Custom Images

Gondolin supports building custom guest images with your own package selection,
kernel configuration, and init scripts. This is useful for:

- Adding language runtimes (Rust, Go, Ruby, etc.)
- Pre-installing project dependencies
- Customizing the boot process
- Creating minimal images for faster startup

## Quick Start

```bash
# Generate a default configuration
gondolin build --init-config > build-config.json

# Edit the config to add packages, change settings, etc.
# Then build:
gondolin build --config build-config.json --output ./my-assets

# Use your custom image:
GONDOLIN_GUEST_DIR=./my-assets gondolin bash
```

## Build Requirements

Building custom images requires the following tools:

| Tool | Purpose |
|------|---------|
| **Zig 0.15.2** | Cross-compiling sandboxd/sandboxfs binaries |
| **lz4** | Initramfs compression |
| **curl** | Downloading Alpine packages |
| **python3** | Package dependency resolution |
| **e2fsprogs** | Creating ext4 rootfs images (mke2fs) |

### macOS

```bash
brew install zig@0.15 lz4 e2fsprogs
```

Note: On macOS, you may need to add e2fsprogs to your PATH:
```bash
export PATH="/opt/homebrew/opt/e2fsprogs/sbin:/opt/homebrew/opt/e2fsprogs/bin:$PATH"
```

### Linux (Debian/Ubuntu)

```bash
# Install Zig 0.15.2 from https://ziglang.org/download/
sudo apt install lz4 curl python3 e2fsprogs
```

## Configuration Reference

The build configuration is a JSON file with the following structure:

```json
{
  "arch": "aarch64",
  "distro": "alpine",
  "alpine": {
    "version": "3.23.0",
    "kernelPackage": "linux-virt",
    "kernelImage": "vmlinuz-virt",
    "rootfsPackages": [
      "linux-virt",
      "rng-tools",
      "bash",
      "ca-certificates",
      "curl",
      "nodejs",
      "npm",
      "uv",
      "python3"
    ],
    "initramfsPackages": []
  },
  "rootfs": {
    "label": "gondolin-root"
  }
}
```

### Top-Level Options

| Field | Type | Description |
|-------|------|-------------|
| `arch` | `"aarch64"` \| `"x86_64"` | Target architecture |
| `distro` | `"alpine"` | Distribution (only Alpine is currently supported) |
| `alpine` | object | Alpine-specific configuration |
| `rootfs` | object | Rootfs image settings |
| `init` | object | Custom init script paths |
| `container` | object | Container build settings (for cross-platform) |
| `sandboxdPath` | string | Path to custom sandboxd binary |
| `sandboxfsPath` | string | Path to custom sandboxfs binary |

### Alpine Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | string | `"3.23.0"` | Alpine Linux version |
| `branch` | string | derived | Alpine branch (e.g., `"v3.23"`) |
| `mirror` | string | official CDN | Custom mirror URL |
| `kernelPackage` | string | `"linux-virt"` | Kernel package name |
| `kernelImage` | string | `"vmlinuz-virt"` | Kernel image filename |
| `rootfsPackages` | string[] | see below | Packages for the root filesystem |
| `initramfsPackages` | string[] | `[]` | Packages for the initramfs |

### Rootfs Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `label` | string | `"gondolin-root"` | Filesystem volume label |
| `sizeMb` | number | auto | Fixed size in MB (auto-calculated if omitted) |

### Init Configuration

| Field | Type | Description |
|-------|------|-------------|
| `rootfsInit` | string | Path to custom rootfs init script |
| `initramfsInit` | string | Path to custom initramfs init script |

### Container Configuration

Used for cross-platform builds (e.g., building Linux images on macOS):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `force` | boolean | `false` | Force container usage even on Linux |
| `image` | string | `"alpine:3.23"` | Container image to use |
| `runtime` | `"docker"` \| `"podman"` | auto-detect | Container runtime |

### Fixed Rootfs Size

By default, the rootfs size is auto-calculated. To set a fixed size:

```json
{
  "rootfs": {
    "sizeMb": 2048
  }
}
```

## Cross-Architecture Builds

Build images for a different architecture:

```bash
# Build for x86_64 on an ARM64 Mac
gondolin build --arch x86_64 --config build-config.json --output ./x64-assets

# Build for ARM64 on an x86_64 Linux host
gondolin build --arch aarch64 --config build-config.json --output ./arm64-assets
```

Cross-architecture builds may use a container (Docker/Podman) automatically
when native tools aren't available.

## Verifying Built Assets

After building, verify the assets are valid:

```bash
gondolin build --verify ./my-assets
```

This checks the manifest and file checksums.

## Using Custom Assets

### Environment Variable

```bash
GONDOLIN_GUEST_DIR=./my-assets gondolin bash
```

### Programmatic API

Point `imagePath` at the asset directory (it will use `manifest.json` when present):

```typescript
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  sandbox: {
    imagePath: "./my-assets",
  },
});

await vm.exec("rustc --version");
await vm.close();
```

## Build Output

A successful build creates:

```
my-assets/
  manifest.json        # Build metadata and checksums
  vmlinuz-virt         # Linux kernel
  initramfs.cpio.lz4   # Compressed initramfs
  rootfs.ext4          # Root filesystem image
```

The `manifest.json` contains the build configuration, timestamps, and SHA-256
checksums for verification.

## Troubleshooting

### "mke2fs: command not found"

Install e2fsprogs:
- macOS: `brew install e2fsprogs`
- Linux: `sudo apt install e2fsprogs`

On macOS, add to PATH:
```bash
export PATH="/opt/homebrew/opt/e2fsprogs/sbin:$PATH"
```

### Build times out / VM doesn't boot

Ensure the built architecture matches your host:
- Apple Silicon Macs: use `aarch64`
- Intel Macs / x86_64 Linux: use `x86_64`

### Package not found

Alpine packages are split across `main` and `community` repositories. Both are
enabled by default. Search for packages at https://pkgs.alpinelinux.org/packages

### Image too large

- Remove unnecessary packages from `rootfsPackages`
- The `linux-virt` kernel is smaller than `linux-lts`
- Set a fixed `rootfs.sizeMb` to prevent over-allocation

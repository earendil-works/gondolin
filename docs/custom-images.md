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

Prebuilt example config with `postBuild.commands` (installs `llm` + plugin via pip):

```bash
gondolin build --config host/examples/llm.json --output ./llm-assets
GONDOLIN_GUEST_DIR=./llm-assets gondolin exec -- llm --help
```

Use an OCI image (Docker Hub/GHCR/private registry) as the rootfs base:

```json
{
  "arch": "aarch64",
  "distro": "alpine",
  "oci": {
    "image": "docker.io/library/debian:bookworm-slim"
  }
}
```

```bash
gondolin build --config host/examples/oci-debian.json --output ./oci-assets
```

## Build Requirements

Building custom images requires the following tools:

| Tool | Purpose |
|------|---------|
| **Zig 0.15.2+** | Cross-compiling sandboxd/sandboxfs binaries |
| **cpio** | Creating initramfs archives |
| **lz4** | Initramfs compression |
| **e2fsprogs** | Creating ext4 rootfs images (mke2fs) |
| **Docker or Podman** *(optional)* | Pull/export OCI rootfs images (`oci.image`) |

### macOS

```bash
brew install zig@0.15 lz4 e2fsprogs
```

The build tries to locate `mke2fs` automatically (including common Homebrew locations). If you still see `mke2fs: command not found`, make sure `mke2fs` is available on your `PATH` (you can check where Homebrew installed it with `brew --prefix e2fsprogs`).

### Linux (Debian/Ubuntu)

```bash
# Install Zig 0.15.2+ from https://ziglang.org/download/
sudo apt install lz4 cpio e2fsprogs
```

## Configuration Reference

The build configuration is a JSON file. To generate a starting point, run:

```bash
gondolin build --init-config > build-config.json
```

Then pass it to the builder via `--config build-config.json`.

The file has the following structure:

```json
{
  "arch": "aarch64",
  "distro": "alpine",
  "env": {
    "FOO": "bar"
  },
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
      "python3",
      "openssh"
    ],
    "initramfsPackages": []
  },
  "rootfs": {
    "label": "gondolin-root"
  },
  "postBuild": {
    "commands": [
      "pip3 install llm llm-anthropic"
    ]
  }
}
```

### Top-Level Options

| Field | Type | Description |
|-------|------|-------------|
| `arch` | `"aarch64"` \| `"x86_64"` | Target architecture |
| `distro` | `"alpine"` | Distribution (only Alpine is currently supported) |
| `env` | object \| string[] | Default environment variables baked into the guest image |
| `alpine` | object | Alpine-specific configuration |
| `oci` | object | OCI rootfs source (uses exported container filesystem as rootfs base) |
| `rootfs` | object | Rootfs image settings |
| `init` | object | Custom init script paths |
| `postBuild` | object | Post-package commands executed in the rootfs |
| `container` | object | Container build settings (for cross-platform) |
| `sandboxdPath` | string | Path to custom sandboxd binary |
| `sandboxfsPath` | string | Path to custom sandboxfs binary |
| `sandboxsshPath` | string | Path to custom sandboxssh binary |
| `sandboxingressPath` | string | Path to custom sandboxingress binary |

#### Baked-in environment (`env`)

`env` lets you bake a default environment into the image at build time.
These variables are exported by the guest init script right before `sandboxd`
starts, so they become the default environment for all `exec` commands unless
explicitly overridden.

Because `env` is stored in the image, **do not put real secrets here**.

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

### OCI Support

When `oci` is set, Gondolin exports the OCI image filesystem and uses it as the rootfs base.
The Alpine minirootfs is still used for initramfs generation and kernel packaging.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `image` | string | required | OCI image reference (`repo/name[:tag]` or `repo/name@sha256:...`) |
| `runtime` | `"docker" \| "podman"` | auto-detect | Runtime used for pull/create/export |
| `platform` | string | derived from `arch` | Platform passed to runtime (e.g. `linux/arm64`) |
| `pullPolicy` | `"if-not-present" \| "always" \| "never"` | `"if-not-present"` | Pull behavior before export |

Notes:

- `alpine.rootfsPackages` is ignored when `oci` is set
- `alpine.initramfsPackages` automatically includes the configured kernel package when `oci` is set
- The exported rootfs must contain `/bin/sh`, or provide a custom `init.rootfsInit`
- `container.force=true` is currently not supported together with `oci`

OCI support swaps the **root filesystem contents**, not the whole image build pipeline.
Gondolin still assembles boot artifacts from Alpine components, and then layers the
exported OCI filesystem on top as `rootfs.ext4`.

In practice, the build is split into two parts:

- **Boot layer (still Alpine-based):** kernel package selection, kernel image, and initramfs generation
- **Rootfs layer (from OCI):** userspace filesystem exported from `oci.image` (Debian, Ubuntu, etc.)

That is why OCI examples still use:

- `"distro": "alpine"`
- `alpine.kernelPackage` / `alpine.kernelImage`
- `alpine.initramfsPackages`

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
| `rootfsInitExtra` | string | Path to a shell script appended to the rootfs init before sandboxd starts |

### Runtime Defaults

| Field | Type | Description |
|-------|------|-------------|
| `rootfsMode` | `"readonly" \| "memory" \| "cow"` | Default VM rootfs mode baked into `manifest.json` |

Example:

```json
{
  "runtimeDefaults": {
    "rootfsMode": "readonly"
  }
}
```

### Post-Build Configuration

Run shell commands inside the built rootfs after APK packages are extracted.
This is useful for package managers like `pip` that need to install files into
`/usr` during image creation.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `commands` | string[] | `[]` | Commands executed in order via `/bin/sh -lc` inside chroot |

Notes:

- Commands run in a Linux chroot environment
- Native Linux builds need root privileges for chroot (or use `container.force=true`)
- On macOS, builds with `postBuild.commands` automatically use a container
- The build runtime architecture must match `arch` when using post-build commands

### Container Configuration

Used for the *build environment* (e.g., building Linux images on macOS).
This is separate from `oci`, which controls the guest rootfs source.

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

const result = await vm.exec("rustc --version");
console.log("exitCode:", result.exitCode);
console.log("stdout:\n", result.stdout);
console.log("stderr:\n", result.stderr);

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

The `manifest.json` contains the build configuration, timestamps, SHA-256
checksums for verification, and a deterministic `buildId` derived from those
checksums. When `oci.image` is used, it also records `ociSource` metadata
including the resolved image digest used during export.

That `buildId` is used by snapshots/checkpoints to locate the correct guest
assets without embedding absolute host paths.

## Troubleshooting

### `mke2fs`: Command Not Found

Install e2fsprogs:

- macOS: `brew install e2fsprogs`
- Linux: `sudo apt install e2fsprogs`

On macOS, ensure `mke2fs` is on your `PATH` (use `brew --prefix e2fsprogs` to find where it was installed).

### Build Times Out / VM Doesn't Boot

Ensure the built architecture matches your host:

- Apple Silicon Macs: use `aarch64`
- Intel Macs / x86_64 Linux: use `x86_64`

### Package Not Found

Alpine packages are split across `main` and `community` repositories. Both are
enabled by default. Search for packages at https://pkgs.alpinelinux.org/packages

### Image Too Large

- Remove unnecessary packages from `rootfsPackages`
- The `linux-virt` kernel is smaller than `linux-lts`
- Set a fixed `rootfs.sizeMb` to prevent over-allocation

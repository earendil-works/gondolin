# Gondolin Guest Sandbox

This directory contains the guest-side components for the Gondolin sandbox: the
Zig sandbox helper daemons and Alpine initramfs build inputs.

## What it does

- Builds sandbox helper binaries, including `sandboxd`, the supervisor that
  listens on a virtio-serial port for exec requests, spawns processes inside the
  guest, and streams stdout/stderr/stdin over the wire.
- Assembles a minimal Alpine initramfs with `sandboxd`, an init script, and
  optional packages for networking and certificates.

## Layout

- `src/sandboxd/` — Zig sources for `sandboxd` and exec RPC handling.
- `src/sandboxfs/` — Zig sources for the FUSE filesystem daemon.
- `src/shared/` — Shared CBOR/protocol/RPC helpers.
- `image/` — initramfs build scripts and the minimal `/init`.
- `build.zig` — Zig build definition for the sandbox helper binaries.
- `Makefile` — helpers to build and create images.

## Requirements

For image assembly (`make build`, via the shared `gondolin build` pipeline):

| macOS | Linux (Debian/Ubuntu) |
|-------|----------------------|
| `brew install lz4 e2fsprogs` | `sudo apt install lz4 cpio e2fsprogs` |

The build resolves prebuilt sandbox helper binaries by default, so Zig is not
required for ordinary image builds. Make sure host Node dependencies are
installed (e.g., `pnpm install` at the repo root or `pnpm -C host install`).

For contributor helper builds and guest tests, install Zig 0.16.0. To force the
image build pipeline to build helpers from local Zig sources, set
`GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE=1`; if invoking from outside the
checkout, also set `GONDOLIN_GUEST_SRC` to this `guest/` directory.

## Common tasks

Mandatory build command (builds kernel, initramfs, rootfs, and krun boot assets without booting):

```sh
make build
```

Build sandbox helper binaries from source (requires Zig 0.16.0):

```sh
make build-bins
```

Build guest assets using a custom build config:

```sh
make build GONDOLIN_BUILD_CONFIG=../build-config.json
```

`make build` invokes the shared `gondolin build` pipeline and will produce all
assets in `image/out/`.

Boot the guest in a VM (builds assets if needed):

```sh
npx @earendil-works/gondolin bash
```

The host manages the full QEMU lifecycle automatically.

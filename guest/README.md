# Gondolin Guest Sandbox

This directory contains the guest-side components for the Gondolin sandbox: the
Zig `sandboxd` supervisor and the Alpine initramfs image builder.

## What it does

- Builds `sandboxd`, a tiny supervisor that listens on a virtio-serial port for
  exec requests, spawns processes inside the guest, and streams
  stdout/stderr/stdin over the wire.
- Assembles a minimal Alpine initramfs with `sandboxd`, an init script, and
  optional packages for networking and certificates.

## Layout

- `src/sandboxd/` — Zig sources for `sandboxd` and exec RPC handling.
- `src/sandboxfs/` — Zig sources for the FUSE filesystem daemon.
- `src/shared/` — Shared CBOR/protocol/RPC helpers.
- `image/` — initramfs build scripts and the minimal `/init`.
- `build.zig` — Zig build definition for `sandboxd`.
- `Makefile` — helpers to build and create images.

## Requirements

| macOS | Linux (Debian/Ubuntu) |
|-------|----------------------|
| Install Zig 0.16.0, then `brew install lz4 e2fsprogs` | Install Zig 0.16.0, then `sudo apt install lz4 cpio curl e2fsprogs` |

The `make build` target invokes the shared `gondolin build` pipeline through
the host CLI. Make sure host Node dependencies are installed (e.g., `pnpm install`
at the repo root or `pnpm -C host install`).

## Common tasks

Mandatory build command (builds kernel, initramfs, rootfs, and krun boot assets without booting):

```sh
make build
```

Build `sandboxd` only:

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

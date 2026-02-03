# Eregion Sandbox POC

This repo is a proof-of-concept for running a tiny Alpine guest in QEMU,
driving it via a virtio-serial RPC, and exposing a host WebSocket API for exec
requests.

## Repository layout

- `guest/` — Zig-based `sandboxd` daemon, Alpine initramfs build, and QEMU helpers.
  - `guest/src/` contains the virtio-serial RPC implementation and exec handling.
  - `guest/image/` builds an Alpine minirootfs + init script into an initramfs.
  - `guest/Makefile` provides `build`, `image`, `kernel`, and `qemu` targets.
- `host/` — TypeScript host controller + WebSocket server.
  - `host/src/ws-server.ts` manages QEMU lifecycle and bridges WebSocket exec requests to virtio-serial.
  - `host/src/exec.ts` is a CLI for sending exec requests directly over the virtio socket.
  - `host/src/virtio-protocol.ts` and `host/src/ws-protocol.ts` define encoding/framing.
  - `host/WS_PROTOCOL.md` documents the WebSocket protocol.
- `plans/` — POC planning docs.
  - `plans/POC_PLAN.md` is the source of truth for the current phase.
  - `plans/POC_PROTOCOL.md` defines the CBOR-based virtio framing.
  - `plans/FOLLOWUP_PLAN.md` captures post-POC milestones.

## Current state (February 2026)

- **Guest daemon (`sandboxd`)**
  - Zig binary that listens on `/dev/vport0p0`/`/dev/vport0p1` (virtio-serial).
  - Handles `exec_request` frames, spawns processes, streams stdout/stderr, and returns exit code.
  - Supports stdin streaming and optional PTY allocation (see protocol fields).
- **Guest image**
  - `guest/image/build.sh` assembles an Alpine minirootfs, installs extra packages, and produces `initramfs.cpio.gz`.
  - `guest/image/init` mounts `/proc`, `/sys`, `/dev`, loads virtio modules, and launches `sandboxd` as PID 1.
  - `guest/image/out/` contains the generated initramfs and downloaded kernel artifacts.
- **Host controller**
  - `host/src/ws-server.ts` starts QEMU, exposes a WebSocket API, and bridges exec messages to virtio.
  - Automatic restart logic and state notifications are implemented in `SandboxController`.
  - `host/src/exec.ts` can send direct exec requests over the virtio socket for quick testing.

## Useful entry points

- POC plan: `plans/POC_PLAN.md`
- Virtio RPC protocol: `plans/POC_PROTOCOL.md`
- WebSocket protocol: `host/WS_PROTOCOL.md`

## What’s next

The next POC step is adding host-controlled networking with a transparent proxy (see `plans/POC_PLAN.md`, step 8). The host/guest plumbing for exec RPCs is already in place, so the focus shifts to routing guest egress through a host MITM proxy and injecting a trusted CA into the guest image.

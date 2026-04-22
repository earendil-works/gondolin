# Current Limitations

This page tracks the current limitations of Gondolin. If you are evaluating
Gondolin for a production workflow, treat this as a "known gaps" checklist.

## No Full VM Save/Restore (Memory Snapshots)

Gondolin does not provide full VM save/restore (capturing in-VM process state +
RAM) today.

However, Gondolin _does_ support **disk-only checkpoints** (qcow2-backed) via
`vm.checkpoint(<absolute qcow2 path>)` and `checkpoint.resume()`.

See also: [Snapshots](./snapshots.md).

Tracking issue: [#8](https://github.com/earendil-works/gondolin/issues/8).

**Note:** Some guest paths are tmpfs-backed by design (eg. `/root`, `/tmp`,
`/var/tmp`, `/var/cache`, `/var/log`). Writes under those paths are not part of
disk checkpoints.

## Adding Extra Packages Requires Building a New Image

The default guest image is intentionally minimal. If you need additional
packages (for example: compilers, language runtimes, or extra system tools), you
currently need to build a custom guest image and point Gondolin at it. This is
in some ways a consequence of the lack of snapshotting.

See [Custom Images](./custom-images.md).

## Only Alpine

The image builder currently only supports Alpine Linux.

## No HTTP/2 or HTTP/3 support

Gondolin's network mediation currently focuses on HTTP/1.x over plain TCP and
HTTPS via TLS interception.

As a result, HTTP/2 and HTTP/3 are not supported today.

## No QUIC or WebRTC support

Related to the lack of HTTP/3 support, QUIC is not supported. Likewise WebRTC
is not supported.

This means software that relies on UDP-based application protocols (or generic
UDP connectivity) will not work in the default network model.

## Backend parity gaps (QEMU vs krun)

Gondolin supports both `qemu` (default) and an experimental `krun` backend, but
feature parity is not complete.

Notable gaps today:

- Cross-backend checkpoint resume (`qemu` ↔ `krun`) requires asset builds that include `manifest.assets.krunKernel`
- qemu-specific backend knobs (`machineType`, `accel`, `cpu`, `qemuPath`) are
  rejected when `vmm=krun`
- `rootfs.mode="memory"` is not truly RAM-backed on `krun`; it is implemented
  as a temporary qcow2 overlay file on disk that is deleted on close

See [VM Backends (QEMU vs krun)](./backends.md) for the maintained matrix.

## Windows support notes

The QEMU backend is supported on Windows x64, where Gondolin uses loopback TCP
endpoints instead of Unix sockets and prefers WHPX when the installed
`qemu-system-x86_64` build advertises it.

The experimental `krun` backend remains unsupported on Windows; use
`vmm=qemu` there.

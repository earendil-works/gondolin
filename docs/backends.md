# VM Backends: QEMU vs libkrun

Gondolin supports two VM backends:

- `krun` (default where it can run; uses `libkrun` via the `gondolin-krun-runner` helper)
- `qemu` (the fallback everywhere else, broader feature support and tuning knobs)

Both backends work with both host engines (`native`, the default, and the
deprecated `node`; see [Native Engine](./native.md)).

This page is the authoritative backend-parity reference for SDK/CLI behavior.

## Default Backend Selection

The backend is chosen in this order:

1. `sandbox.vmm` (SDK) or `--vmm qemu|krun` (CLI)
2. `GONDOLIN_VMM=qemu|krun`
3. Otherwise `krun` when all of these hold, else `qemu`:
    - the host supports libkrun: macOS on Apple silicon (arm64), or Linux on
      arm64/x86_64 with read/write access to `/dev/kvm` (libkrun has no
      software emulation, QEMU falls back to TCG)
    - a krun runner is installed (see [runner path resolution](#krun) below;
      published installs ship it for macOS arm64 and Linux x86_64)
    - the image ships krun boot assets (`manifest.assets.krunKernel`) for the
      host architecture; explicit asset paths (`sandbox.imagePath` as an
      object) always use `qemu`
    - no qemu-only option is set (`sandbox.qemuPath`, `machineType`, `accel`,
      `cpu`, `qemuIdlePauseMs`); setting one selects `qemu`

So macOS arm64 and Linux x86_64 installs from npm boot with `krun` out of the
box, and every other setup keeps working with `qemu`.  Pin a backend with
`GONDOLIN_VMM=qemu` (or `sandbox.vmm`) when you rely on QEMU-only behavior such
as virtio-fs on Linux.

Two cases keep `qemu` as the default:

- Resuming a checkpoint whose metadata does not list `krun` as compatible
  (built from an image without krun boot assets) without an explicit backend.
- A [remote native daemon](./native.md#remote-daemons): the runner and
  `/dev/kvm` live on the daemon's machine, so the controller cannot detect
  them; set `sandbox.vmm: "krun"` (and `sandbox.krunRunnerPath` if the runner
  is not on the daemon's `PATH`) to use krun there.

## Feature Parity Matrix

| Capability / setting                                           | `qemu` | `krun` | Notes                                                                                                                        |
| -------------------------------------------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.vmm`                                                  | ✓      | ✓      | Select backend (`"qemu"` or `"krun"`); default: see [above](#default-backend-selection)                                     |
| `sandbox.qemuPath`                                             | ✓      |        | Rejected when `vmm=krun`                                                                                                     |
| `sandbox.krunRunnerPath`                                       |        | ✓      | Used only with `vmm=krun`                                                                                                    |
| `sandbox.machineType`                                          | ✓      |        | Rejected when `vmm=krun`                                                                                                     |
| `sandbox.accel`                                                | ✓      |        | Rejected when `vmm=krun`; libkrun backend is implicit per OS                                                                 |
| `sandbox.cpu`                                                  | ✓      |        | Rejected when `vmm=krun`                                                                                                     |
| `sandbox.cpus`                                                 | ✓      | ✓      | Shared high-level CPU count option                                                                                           |
| `sandbox.memory`                                               | ✓      | ✓      | `krun` parses memory and passes MiB to `libkrun`                                                                             |
| `sandbox.rootDiskPath` / `rootDiskFormat` / `rootDiskReadOnly` | ✓      | ✓      | Supported on both backends                                                                                                   |
| `rootfs.mode = "memory"`                                       | ✓      | ✓      | QEMU uses backend snapshot mode unless `rootfs.size` is set; krun uses a temporary qcow2 overlay via `qemu-img` (ephemeral writes, not RAM-backed) |
| `rootfs.mode = "cow"`                                          | ✓      | ✓      | Writable qcow2 copy-on-write overlay on both backends; the overlay does not modify the original rootfs image                |
| `rootfs.size`                                                   | ✓      | ✓      | Ensures the effective writable root disk is at least the requested size before boot and runs `resize2fs` in the guest; requires `resize2fs` in the image |
| `vm.checkpoint()` / checkpoint resume                          | ✓      | ✓      | Resume enforces checkpoint compatibility metadata; `qemu` ↔ `krun` requires krun boot assets in the checkpoint build         |
| Exec/VFS/network mediation/SSH/ingress APIs                    | ✓      | ✓      | Same host-side control plane and policy stack                                                                                |
| VFS over virtio-fs                                             | ✓      |        | Native engine with a QEMU that has vhost-user (`vhost-user-fs-pci`/`-device`); otherwise, and always on krun, sandboxfs (FUSE over virtio-serial) |

## Architecture and Kernel Constraints

### QEMU

- Guest architecture must match the selected QEMU binary (`qemu-system-aarch64` vs `qemu-system-x86_64`)
- QEMU binary precedence: explicit `sandbox.qemuPath` → manifest-derived default when guest arch is known → host-arch default fallback
- CPU model precedence: explicit `sandbox.cpu` → `GONDOLIN_CPU` → backend-specific auto selection
- Kernel/initrd/rootfs come from selected guest assets

### krun

- Guest architecture must match the **host** architecture
- Requires a **libkrunfw-compatible kernel**
- Gondolin requires image manifest krun boot assets:
    - `assets.krunKernel`
    - `assets.krunInitrd` (optional; defaults to an empty initrd)
- Build/setup path: `gondolin build` (or published image assets)
- `make krun-runner` builds the runner binary; it does not provide kernel assets

Runner path resolution (when `sandbox.krunRunnerPath` is not set):

- `GONDOLIN_KRUN_RUNNER`
- Auto-detected from local `host/krun-runner/zig-out/bin/gondolin-krun-runner` when present
- Auto-detected from installed platform runner package when available (`@earendil-works/gondolin-krun-runner-darwin-arm64` or `@earendil-works/gondolin-krun-runner-linux-x64`, the only published platforms)
- `gondolin-krun-runner` on `PATH`

The static `gondolin` CLI checks `GONDOLIN_KRUN_RUNNER`,
`host/krun-runner/zig-out/bin` and `krun-runner/zig-out/bin` in the current
directory, the directory of the `gondolin` binary, then `PATH`. A remote native daemon uses
`sandbox.krunRunnerPath` as a path on its machine, else `gondolin-krun-runner`
from its `PATH`.

## Runtime Caveats

- `krun` has less runtime parity coverage than `qemu`
- Cross-backend checkpoint resume (`qemu` ↔ `krun`) requires assets that include `manifest.assets.krunKernel`
- Some krun networking edge cases are still under investigation
- Guest filesystem mounts always use sandboxfs on krun (libkrun has no pluggable virtio-fs backend), so they are slower than on QEMU with virtio-fs and `close()`/`fsync()` cannot report object-tier commit errors
- Host CA trust configuration can cause guest-visible HTTP `502` errors on both backends when upstream TLS validation fails

## Recommendation

Use the default unless you need something only one backend offers: `qemu` for
virtio-fs (faster guest mounts with a vhost-user QEMU, e.g. Linux distribution
builds), QEMU tuning knobs, or guests for another architecture. When the backend
matters, pin it explicitly (`sandbox.vmm`, `--vmm`, `GONDOLIN_VMM`) rather than
relying on detection. If you expose backend knobs in higher-level tooling, gate
them by backend and fail fast on unsupported combinations.

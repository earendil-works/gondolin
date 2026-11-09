# VM Backends: QEMU vs libkrun

Gondolin supports two VM backends:

- `krun` (default where it can run; uses `libkrun` via the `gondolin-krun-runner` helper)
- `qemu` (the fallback everywhere else, broader feature support and tuning knobs)

Both backends are started and driven by the Gondolin daemon (`gondolind`; see
[Architecture](./architecture.md)): the VMM process is a child of the daemon,
and the guest-facing devices, network stack and filesystem server are the
same on both.

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
box, and every other setup keeps working with `qemu`.  QEMU only has to be
installed when a VM ends up on the `qemu` backend: root disks and checkpoints
are prepared by the daemon on both backends.  Pin a backend with
`GONDOLIN_VMM=qemu` (or `sandbox.vmm`, `--vmm`) when you rely on QEMU-only
behavior such as the faster vhost-user virtio-fs on Linux.

Two cases keep `qemu` as the default:

- Resuming a checkpoint whose metadata does not list `krun` as compatible
  (built from an image without krun boot assets) without an explicit backend.
- A [daemon on another machine](./remote.md): the runner and `/dev/kvm` live
  on the daemon's machine, so your process cannot detect them; set
  `sandbox.vmm: "krun"` (or `GONDOLIN_VMM=krun`, and `sandbox.krunRunnerPath`
  if the runner is not on the daemon's `PATH`) to use krun there.

## Feature Parity Matrix

| Capability / setting                                           | `qemu` | `krun` | Notes                                                                                                                        |
| -------------------------------------------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.vmm`                                                  | ✓      | ✓      | Select backend (`"qemu"` or `"krun"`); default: see [above](#default-backend-selection)                                     |
| `sandbox.qemuPath`                                             | ✓      |        | Rejected when `vmm=krun`                                                                                                     |
| `sandbox.krunRunnerPath`                                       |        | ✓      | Used only with `vmm=krun`                                                                                                    |
| `sandbox.machineType`                                          | ✓      |        | Rejected when `vmm=krun`                                                                                                     |
| `sandbox.accel`                                                | ✓      |        | Rejected when `vmm=krun`; libkrun backend is implicit per OS                                                                 |
| `sandbox.cpu`                                                  | ✓      |        | Rejected when `vmm=krun`; `GONDOLIN_CPU` only applies to `qemu`                                                              |
| `sandbox.qemuIdlePauseMs`                                      | ✓      |        | Rejected when `vmm=krun`; see [QEMU: Idle Pause](./qemu.md#idle-pause)                                                       |
| `sandbox.cpus`                                                 | ✓      | ✓      | Shared high-level CPU count option                                                                                           |
| `sandbox.memory`                                               | ✓      | ✓      | `krun` parses memory and passes MiB to `libkrun`                                                                             |
| `sandbox.rootDiskPath` / `rootDiskFormat` / `rootDiskReadOnly` | ✓      | ✓      | Supported on both backends; not with a [remote daemon](./remote.md)                                                          |
| `rootfs.mode = "memory"`                                       | ✓      | ✓      | QEMU uses backend snapshot mode unless `rootfs.size` is set; krun uses a temporary qcow2 overlay the daemon creates (ephemeral writes, not RAM-backed) |
| `rootfs.mode = "cow"`                                          | ✓      | ✓      | Writable qcow2 copy-on-write overlay on both backends; the overlay does not modify the original rootfs image                |
| `rootfs.size`                                                   | ✓      | ✓      | Ensures the effective writable root disk is at least the requested size before boot and runs `resize2fs` in the guest; requires `resize2fs` in the image |
| `vm.checkpoint()` / checkpoint resume                          | ✓      | ✓      | Resume enforces checkpoint compatibility metadata; `qemu` ↔ `krun` requires krun boot assets in the checkpoint build         |
| Exec/VFS/network mediation/SSH/ingress APIs                    | ✓      | ✓      | Same host-side control plane and policy stack                                                                                |
| VFS over virtio-fs                                             | ✓      | ✓      | QEMU: a build with vhost-user (`vhost-user-fs-pci`/`-device`), see [QEMU](./qemu.md#virtio-fs-and-vhost-user). krun: a runner with the `virtiofs-socket` capability (the bundled runner; libkrun forwards FUSE requests to the daemon over a socket). Otherwise sandboxfs (FUSE over virtio-serial) |

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
- Published runner packages exist for macOS arm64 and Linux x86_64 only; on
  Linux arm64 build the runner with `make krun-runner` (or install
  `gondolin-krun-runner` on `PATH`)
- macOS: the runner must be signed with the Hypervisor entitlement
  (`com.apple.security.hypervisor`); the SDK checks this before booting and
  fails with a clear error instead of a VM that never starts

Runner path resolution (when `sandbox.krunRunnerPath` is not set):

- `GONDOLIN_KRUN_RUNNER`
- A development build: `krun-runner/zig-out/bin/gondolin-krun-runner` or
  `host/krun-runner/zig-out/bin/gondolin-krun-runner` in the current directory,
  its parents, or above the installed SDK
- Auto-detected from installed platform runner package when available (`@earendil-works/gondolin-krun-runner-darwin-arm64` or `@earendil-works/gondolin-krun-runner-linux-x64`, the only published platforms)
- `gondolin-krun-runner` on `PATH`

The static `gondolin` CLI checks `GONDOLIN_KRUN_RUNNER`,
`host/krun-runner/zig-out/bin` and `krun-runner/zig-out/bin` in the current
directory, the directory of the `gondolin` binary, then `PATH`. A remote daemon uses
`sandbox.krunRunnerPath` as a path on its machine, else `gondolin-krun-runner`
from its `PATH`.

## Runtime Caveats

- `krun` has less runtime parity coverage than `qemu`
- Cross-backend checkpoint resume (`qemu` ↔ `krun`) requires assets that include `manifest.assets.krunKernel`
- Some krun networking edge cases are still under investigation
- krun's virtio-fs forwards every request through the runner to the daemon over a socket, one at a time: faster than sandboxfs, but slower than QEMU's vhost-user (shared guest memory, several queues) for large I/O; older runners (no `virtiofs-socket` capability) fall back to sandboxfs
- Host CA trust configuration can cause guest-visible HTTP `502` errors on both backends when upstream TLS validation fails

## Recommendation

Use the default unless you need something only one backend offers: `qemu` for
the fastest guest mounts (vhost-user virtio-fs with a Linux distribution QEMU),
QEMU tuning knobs, or guests for another architecture. When the backend
matters, pin it explicitly (`sandbox.vmm`, `--vmm`, `GONDOLIN_VMM`) rather than
relying on detection. If you expose backend knobs in higher-level tooling, gate
them by backend and fail fast on unsupported combinations.

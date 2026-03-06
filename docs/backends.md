# VM Backends: QEMU vs libkrun

Gondolin supports two VM backends:

- `qemu` (default, broader feature support)
- `krun` (experimental, uses `libkrun` via `host/krun-runner`)

This page is the authoritative backend-parity reference for SDK/CLI behavior.

## Feature Parity Matrix

| Capability / setting                                           | `qemu` | `krun` | Notes                                                                                                                        |
| -------------------------------------------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.vmm`                                                  | ✓      | ✓      | Select backend (`"qemu"` or `"krun"`)                                                                                        |
| `sandbox.qemuPath`                                             | ✓      |        | Rejected when `vmm=krun`                                                                                                     |
| `sandbox.krunRunnerPath`                                       |        | ✓      | Used only with `vmm=krun`                                                                                                    |
| `sandbox.machineType`                                          | ✓      |        | Rejected when `vmm=krun`                                                                                                     |
| `sandbox.accel`                                                | ✓      |        | Rejected when `vmm=krun`; libkrun backend is implicit per OS                                                                 |
| `sandbox.cpu`                                                  | ✓      |        | Rejected when `vmm=krun`                                                                                                     |
| `sandbox.cpus`                                                 | ✓      | ✓      | Shared high-level CPU count option                                                                                           |
| `sandbox.memory`                                               | ✓      | ✓      | `krun` parses memory and passes MiB to `libkrun`                                                                             |
| `sandbox.rootDiskPath` / `rootDiskFormat` / `rootDiskReadOnly` | ✓      | ✓      | Supported on both backends                                                                                                   |
| `rootfs.mode = "memory"`                                       | ✓      | ✓      | QEMU uses backend snapshot mode; krun emulates this with a temporary qcow2 overlay via `qemu-img` (ephemeral writes, not RAM-backed) |
| `rootfs.mode = "cow"`                                          | ✓      | ✓      | Writable qcow2 copy-on-write overlay on both backends; the overlay does not modify the original rootfs image                |
| `vm.checkpoint()` / checkpoint resume                          | ✓      | ✓      | Resume enforces checkpoint compatibility metadata; `qemu` ↔ `krun` requires krun boot assets in the checkpoint build         |
| Exec/VFS/network mediation/SSH/ingress APIs                    | ✓      | ✓      | Same host-side control plane and policy stack                                                                                |

## Architecture and Kernel Constraints

### QEMU

- Guest architecture must match the selected QEMU binary (`qemu-system-aarch64` vs `qemu-system-x86_64`)
- QEMU binary precedence: explicit `sandbox.qemuPath` → manifest-derived default when guest arch is known → host-arch default fallback
- Kernel/initrd/rootfs come from selected guest assets

### krun

- Guest architecture must match the **host** architecture
- Requires a **libkrunfw-compatible kernel**
- Gondolin requires image manifest krun boot assets:
  - `assets.krunKernel`
  - `assets.krunInitrd` (optional; defaults to an empty initrd)
- Build/setup path: `gondolin build` (or published image assets)
- `make krun-runner` builds the runner binary; it does not provide kernel assets

Runner path resolution:

- Auto-detected from local `host/krun-runner/zig-out/bin/gondolin-krun-runner` when present
- Auto-detected from installed platform runner package when available (for example `@earendil-works/gondolin-krun-runner-darwin-arm64` or `@earendil-works/gondolin-krun-runner-linux-x64`)

## Runtime Caveats

- `krun` backend is still experimental and has less runtime parity coverage than `qemu`
- Cross-backend checkpoint resume (`qemu` ↔ `krun`) requires assets that include `manifest.assets.krunKernel`
- Some krun networking edge cases are still under investigation
- Host CA trust configuration can cause guest-visible HTTP `502` errors on both backends when upstream TLS validation fails

## Recommendation

Use `qemu` unless you specifically want to exercise the `krun` backend. If you expose backend knobs in higher-level tooling, gate them by backend and fail fast on unsupported combinations.

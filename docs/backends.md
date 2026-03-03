# VM Backends: QEMU vs libkrun

Gondolin supports two VM backends:

- `qemu` (default, broader feature support)
- `krun` (experimental, uses `libkrun` via `host/krun-runner`)

This page is the authoritative backend-parity reference for SDK/CLI behavior.

## Feature Parity Matrix

| Capability / setting | `qemu` | `krun` | Notes |
| --- | --- | --- | --- |
| `sandbox.vmm` | ✅ | ✅ | Select backend (`"qemu"` or `"krun"`) |
| `sandbox.qemuPath` | ✅ | ❌ | Rejected when `vmm=krun` |
| `sandbox.krunRunnerPath` | ➖ | ✅ | Used only with `vmm=krun` |
| `sandbox.machineType` | ✅ | ❌ | Rejected when `vmm=krun` |
| `sandbox.accel` | ✅ | ❌ | Rejected when `vmm=krun`; libkrun backend is implicit per OS |
| `sandbox.cpu` | ✅ | ❌ | Rejected when `vmm=krun` |
| `sandbox.cpus` | ✅ | ✅ | Shared high-level CPU count option |
| `sandbox.memory` | ✅ | ✅ | `krun` parses memory and passes MiB to `libkrun` |
| `sandbox.rootDiskPath` / `rootDiskFormat` / `rootDiskReadOnly` | ✅ | ✅ | Supported on both backends |
| `sandbox.rootDiskSnapshot` | ✅ | ❌ | Rejected when `vmm=krun` |
| `rootfs.mode = "memory"` | ✅ | ⚠️ | QEMU uses snapshot mode; krun uses a temporary qcow2 overlay (`qemu-img`) |
| `vm.checkpoint()` / checkpoint resume | ✅ | ❌ | Currently `vmm=qemu` only |
| Exec/VFS/network mediation/SSH/ingress APIs | ✅ | ✅ | Same host-side control plane and policy stack |

## Architecture and Kernel Constraints

### QEMU

- Guest architecture must match the selected QEMU binary (`qemu-system-aarch64` vs `qemu-system-x86_64`)
- Kernel/initrd/rootfs come from selected guest assets

### krun

- Guest architecture must match the **host** architecture
- Requires a **libkrunfw-compatible kernel**
- Gondolin auto-prefers cached libkrunfw kernel + empty initrd when:
  - `vmm=krun`, and
  - `sandbox.imagePath` is not an explicit object
- Build/setup path: `make krun-runner`

Override env vars:

- `GONDOLIN_KRUN_RUNNER`
- `GONDOLIN_KRUN_KERNEL`
- `GONDOLIN_KRUN_INITRD`

## Runtime Caveats

- `krun` backend is still experimental and has less runtime parity coverage than `qemu`
- Disk checkpoints are currently qemu-only
- Some krun networking edge cases are still under investigation
- Host CA trust configuration can cause guest-visible HTTP `502` errors on both backends when upstream TLS validation fails

## Recommendation

Use `qemu` unless you specifically want to exercise the `krun` backend. If you expose backend knobs in higher-level tooling, gate them by backend and fail fast on unsupported combinations.

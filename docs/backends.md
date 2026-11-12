# VM Backends: QEMU, libkrun and Firecracker

Gondolin supports three VM backends:

- `krun` (default where it can run; uses `libkrun` via the `gondolin-krun-runner` helper)
- `qemu` (the fallback everywhere else, broader feature support and tuning knobs)
- `firecracker` (never selected automatically): each VM runs in Firecracker,
  as an AWS Nitro Sandbox when the host supports them, otherwise as a microVM
  on Linux KVM; see [firecracker](#firecracker) and
  [AWS Nitro Sandboxes](./nitro.md)

All backends are started and driven by the Gondolin daemon (`gondolind`; see
[Architecture](./architecture.md)): the VMM process is a child of the daemon,
and the network stack, policy and filesystem server are the same on all of
them. QEMU and krun connect the guest helpers over virtio-serial;
Firecracker has no virtio-serial device, so its guests use vsock (`guest/ARCHITECTURE.md`
§3.1).

This page is the authoritative backend-parity reference for SDK/CLI behavior.

## Default Backend Selection

The backend is chosen in this order:

1. `sandbox.vmm` (SDK) or `--vmm qemu|krun|firecracker` (CLI)
2. `GONDOLIN_VMM=qemu|krun|firecracker`
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

| Capability / setting | `qemu` | `krun` | `firecracker` | Notes |
| --- | --- | --- | --- | --- |
| `sandbox.vmm` | ✓ | ✓ | ✓ | Select backend (`"qemu"`, `"krun"` or `"firecracker"`); default: see [above](#default-backend-selection) (never `firecracker`) |
| `sandbox.qemuPath` | ✓ |  |  | Rejected unless `vmm=qemu` |
| `sandbox.krunRunnerPath` |  | ✓ |  | Used only with `vmm=krun` |
| `sandbox.firecrackerPath` / `sandbox.nitro` |  |  | ✓ | Rejected unless `vmm=firecracker`; `sandbox.nitro` selects a Nitro Sandbox, see [AWS Nitro Sandboxes](./nitro.md) |
| `sandbox.machineType` | ✓ |  |  | Rejected unless `vmm=qemu` |
| `sandbox.accel` | ✓ |  |  | Rejected unless `vmm=qemu`; the other backends' accelerator is implicit |
| `sandbox.cpu` | ✓ |  |  | Rejected unless `vmm=qemu`; `GONDOLIN_CPU` only applies to `qemu` |
| `sandbox.qemuIdlePauseMs` | ✓ |  |  | Rejected unless `vmm=qemu`; see [QEMU: Idle Pause](./qemu.md#idle-pause) |
| `sandbox.cpus` | ✓ | ✓ | ✓ | Shared high-level CPU count option; Firecracker with dedicated cores (`nitro.cpuOvercommit: false`) needs an even count |
| `sandbox.memory` | ✓ | ✓ | ✓ | `krun` and `firecracker` parse memory and pass MiB (Firecracker: rounded up to 2 MiB, at least 64 MiB) |
| `sandbox.console` | ✓ | ✓ | ✓ | QEMU and Firecracker boot the kernel with `quiet` unless `"stdio"` or `protocol` debugging (see [Boot log](./debug.md#boot-log)); Firecracker on Nitro also turns the debug console off then |
| `sandbox.rootDiskPath` / `rootDiskFormat` / `rootDiskReadOnly` | ✓ | ✓ | ✓ | Supported on all backends; Firecracker needs a raw disk; not with a [remote daemon](./remote.md) |
| `rootfs.mode = "memory"` | ✓ | ✓ | ✓ | QEMU uses backend snapshot mode unless `rootfs.size` is set; krun uses a temporary qcow2 overlay the daemon creates; Firecracker attaches the image read-only and the guest keeps its writes in a tmpfs overlay (in guest memory; half of it at most), or with `rootfs.size` a raw copy in the session directory; writes are discarded on all |
| `rootfs.mode = "cow"` | ✓ | ✓ | ✓ | QEMU and krun: a writable qcow2 copy-on-write overlay; Firecracker (raw disks only): like `memory`, writes go to a guest tmpfs overlay and are discarded. The original rootfs image is never modified |
| `rootfs.size` | ✓ | ✓ | ✓ | Ensures the effective writable root disk is at least the requested size before boot and runs `resize2fs` in the guest; requires `resize2fs` in the image |
| `vm.checkpoint()` / checkpoint resume | ✓ | ✓ |  | Resume enforces checkpoint compatibility metadata; `qemu` ↔ `krun` requires krun boot assets in the checkpoint build; Firecracker sessions cannot be checkpointed (raw disks, no qcow2 overlay) |
| Exec/VFS/network mediation/SSH/ingress APIs | ✓ | ✓ | ✓ | Same host-side control plane and policy stack |
| VFS over virtio-fs | ✓ | ✓ |  | QEMU: a build with vhost-user (`vhost-user-fs-pci`/`-device`), see [QEMU](./qemu.md#virtio-fs-and-vhost-user). krun: a runner with the `virtiofs-socket` capability (the bundled runner; libkrun forwards FUSE requests to the daemon over a socket). Otherwise sandboxfs (FUSE over virtio-serial; Firecracker: over vsock, Nitro Sandboxes have no virtio-fs) |

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

### firecracker

- Where the VM runs:
    - as an AWS Nitro Sandbox (direct mode) when the host is set up for them:
      an x86_64 or Graviton EC2 instance with Nitro Enclaves enabled and a
      reserved memory pool (`/dev/nitro_enclaves`; setup in
      [AWS Nitro Sandboxes](./nitro.md)). The VM runs beside the instance on
      AWS's hypervisor, so no nested virtualization is needed
    - otherwise as a microVM on Linux KVM: read-write access to `/dev/kvm`
      (bare metal, or a VM with nested virtualization such as EC2
      `m8i`/`c8i`/`r8i` instances)
    - `sandbox.nitro: false` (or `GONDOLIN_NITRO_MODE=off`) asks for KVM;
      `sandbox.nitro` (or `GONDOLIN_NITRO_MODE` /
      `GONDOLIN_NITRO_CPU_OVERCOMMIT`) configures the Nitro Sandbox
- Linux daemon host only, with Firecracker 1.18 or newer
- Boots the image's regular kernel and initramfs; the kernel needs
  virtio-mmio, virtio-blk, virtio-net and the vsock transport (Alpine's
  `linux-virt` qualifies). On KVM Firecracker only boots an uncompressed kernel,
  so the daemon decompresses the image's `vmlinuz` (a gzip-compressed bzImage
  on x86_64 or EFI zboot image on aarch64) once into
  `~/.cache/gondolin/firecracker-kernels/`. Nitro Sandboxes boot the
  compressed kernel through UEFI firmware (x86_64: an EFI-stub `bzImage`);
  confidential mode also needs the DMB virtio patches
- The default kernel command line is Firecracker's own (`console=ttyS0`,
  `panic=1`, and on x86_64 `reboot=k` and the i8042 flags), so a guest panic
  ends the VM instead of hanging it
- Requires a guest image built with vsock support (this release or newer):
  the guest helpers connect over vsock when the kernel command line has
  `gondolin.vsock`
- The daemon needs root (more precisely `CAP_SYS_ADMIN`, `CAP_NET_ADMIN`,
  `CAP_NET_RAW` and access to `/dev/kvm` or `/dev/nitro_enclaves`): it
  creates a network namespace and a tap device per VM
- Binary resolution: `sandbox.firecrackerPath`, else `GONDOLIN_FIRECRACKER`,
  else `firecracker` on the daemon's `PATH` (a remote daemon only receives an
  explicit `sandbox.firecrackerPath`)

## Runtime Caveats

- `krun` has less runtime parity coverage than `qemu`
- Cross-backend checkpoint resume (`qemu` ↔ `krun`) requires assets that include `manifest.assets.krunKernel`
- Some krun networking edge cases are still under investigation
- krun's virtio-fs forwards every request through the runner to the daemon over a socket, one at a time: faster than sandboxfs, but slower than QEMU's vhost-user (shared guest memory, several queues) for large I/O; older runners (no `virtiofs-socket` capability) fall back to sandboxfs
- Firecracker has no snapshots or pause in Gondolin, and no virtio-fs: mounts use sandboxfs over vsock. On Nitro it boots through UEFI firmware (~0.4 s)
- Host CA trust configuration can cause guest-visible HTTP `502` errors on all backends when upstream TLS validation fails

## Recommendation

Use the default unless you need something only one backend offers: `qemu` for
the fastest guest mounts (vhost-user virtio-fs with a Linux distribution QEMU),
QEMU tuning knobs, or guests for another architecture; `firecracker` for
Firecracker's minimal device model on Linux KVM, or to run VMs as AWS Nitro
Sandboxes on EC2 instances without nested virtualization. When the backend
matters, pin it explicitly (`sandbox.vmm`, `--vmm`, `GONDOLIN_VMM`) rather than
relying on detection. If you expose backend knobs in higher-level tooling, gate
them by backend and fail fast on unsupported combinations.

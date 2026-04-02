# VM Backends: QEMU vs libkrun vs wasm-node

Gondolin currently supports three VM backends:

- `qemu` (default, broadest feature coverage)
- `krun` (experimental, uses `libkrun` via `host/krun-runner`)
- `wasm-node` (experimental Node-first WASM runner)

This page is the authoritative backend-parity reference for SDK/CLI behavior.

## Feature Parity Matrix

| Capability / setting | `qemu` | `krun` | `wasm-node` | Notes |
| --- | --- | --- | --- | --- |
| `sandbox.vmm` | ✓ | ✓ | ✓ | Select backend (`"qemu"`, `"krun"`, `"wasm-node"`) |
| `sandbox.qemuPath` | ✓ |  |  | Rejected for `krun` / `wasm-node` |
| `sandbox.krunRunnerPath` |  | ✓ |  | Used only with `vmm=krun` |
| `sandbox.wasmNodePath` / `wasmRunnerPath` / `wasmRunnerMode` / `wasmPath` |  |  | ✓ | Used only with `vmm=wasm-node` |
| `sandbox.machineType` / `sandbox.accel` / `sandbox.cpu` | ✓ |  |  | Rejected for `krun` / `wasm-node` |
| `sandbox.cpus` | ✓ | ✓ | ✓ | Shared high-level CPU count option |
| `sandbox.memory` | ✓ | ✓ | ✓ | `krun` parses MiB; `wasm-node` accepts the shared high-level option |
| `sandbox.rootDiskPath` / `rootDiskFormat` / `rootDiskReadOnly` | ✓ | ✓ | ⚠ | `wasm-node` intentionally keeps `VM` root disk semantics read-only |
| `rootfs.mode = "memory"` | ✓ | ✓ |  | Not currently supported by `wasm-node` |
| `rootfs.mode = "cow"` | ✓ | ✓ |  | Not currently supported by `wasm-node` |
| `vm.checkpoint()` / checkpoint resume | ✓ | ✓ |  | `wasm-node` currently cannot produce qcow2 checkpoints |
| Exec (`vm.exec`) | ✓ | ✓ | ✓ | Shared protocol path |
| Interactive PTY exec | ✓ | ✓ | ✓ | Shared control-plane protocol |
| Host→guest file read/write/delete RPC | ✓ | ✓ | ✓ | Control-plane file RPC works on `wasm-node` |
| VFS mount/bind wiring (`sandboxfs`) | ✓ | ✓ | ✓ | Full VFS mount parity is intended for `wasm-node`; parity tests cover memfs, hostfs, and custom providers |
| Network mediation (`httpHooks`, DNS policy, TLS MITM) | ✓ | ✓ | ⚠ | `wasm-node` now wires guest egress through the same host policy stack; tcp-forward channels remain gated |
| `openTcpStream` / `openIngressStream` | ✓ | ✓ |  | `wasm-node` currently capability-gated off |
| `vm.enableSsh()` / ingress gateway | ✓ | ✓ |  | Blocked by missing tcp-forward channels on `wasm-node` |

## Architecture and Kernel/Runtime Constraints

### QEMU

- Guest architecture must match selected QEMU binary (`qemu-system-aarch64` vs `qemu-system-x86_64`)
- QEMU binary precedence: explicit `sandbox.qemuPath` → manifest-derived default when guest arch is known → host-arch fallback
- Kernel/initrd/rootfs come from selected guest assets

### krun

- Guest architecture must match the **host** architecture
- Requires a **libkrunfw-compatible kernel**
- Gondolin requires image manifest krun boot assets:
  - `assets.krunKernel`
  - `assets.krunInitrd` (optional; defaults to an empty initrd)
- Build/setup path: `gondolin build` (or published image assets)
- `make krun-runner` builds runner binary; it does not provide kernel assets

Runner path resolution:

- auto-detected from local `host/krun-runner/zig-out/bin/gondolin-krun-runner` when present
- auto-detected from installed platform runner package when available (for example `@earendil-works/gondolin-krun-runner-darwin-arm64` or `@earendil-works/gondolin-krun-runner-linux-x64`)

### wasm-node

- Experimental backend using a Node-side WASM runner and function bridge
- WASM module path can come from:
  - `sandbox.wasmPath`
  - `GONDOLIN_WASM_PATH`
  - `manifest.assets.wasm`
- Current implementation uses channelized function-bridge transports (`control`, `fs`, `ssh`, `ingress`) over the same framed protocol
- VFS mounts are expected to work through the shared file-RPC path, including custom virtual providers
- `VM` intentionally treats the root disk as read-only for this backend

See also: [WASM Node function-bridge spike](./wasm-node-function-bridge-spike.md).

## Intentional Backend Differences

The following gaps are intentional today and should be treated as unsupported,
not as parity bugs:

- `krun` and `wasm-node` do **not** expose QEMU-specific tuning knobs:
  - `sandbox.qemuPath`
  - `sandbox.machineType`
  - `sandbox.accel`
  - `sandbox.cpu`
- `wasm-node` does **not** support guest loopback tcp-forward channels:
  - `openTcpStream`
  - `openIngressStream`
  - `vm.enableSsh()`
  - `vm.enableIngress()`
- `wasm-node` does **not** support disk checkpoints or checkpoint resume
- `wasm-node` does **not** support `rootfs.mode = "memory"` or `rootfs.mode = "cow"`

Backend parity tests should include `wasm-node` everywhere parity is intended,
and explicitly skip the capabilities above.

## Runtime Caveats

- `krun` and `wasm-node` are both experimental relative to `qemu`
- Cross-backend checkpoint resume (`qemu` ↔ `krun`) requires assets containing `manifest.assets.krunKernel`
- `wasm-node` intentionally leaves tcp-forward channels (`openTcpStream`, ingress/ssh forwarding) unsupported
- Host CA trust misconfiguration can still produce guest-visible HTTP `502` failures on backends that enable network mediation

## Recommendation

Use `qemu` unless you are actively validating backend parity or runtime-specific behavior.

If you expose backend knobs in higher-level tooling, gate by backend capability and fail fast on unsupported combinations.

# gondolin-krun-runner

Small host-side helper binary for running Gondolin guests with `libkrun`.

## Build

Preferred (repo root):

```bash
make krun-runner
```

This stages `libkrun` under `.cache/libkrun-install/<version>`, extracts a
libkrunfw-compatible kernel under `~/.cache/gondolin/krun/libkrunfw/`, and
builds the runner with bundled shared libraries under
`host/krun-runner/zig-out/lib/`.
On macOS, `make krun-runner` also ad-hoc signs the runner with
`com.apple.security.hypervisor` (via `gondolin-krun-runner.entitlements`).
If `libkrunfw-prebuilt-<arch>.tgz` is not available (for example `x86_64`),
`make krun-runner` falls back to `libkrunfw-<arch>.tgz` and extracts the kernel
via `libkrunfw.so`.

Linux prerequisites (Ubuntu/Debian):

```bash
sudo apt install \
  build-essential curl git make pkg-config clang lld xz-utils \
  libclang-dev llvm-dev libcap-ng-dev

# libkrun currently needs a modern Rust toolchain (edition2024)
curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"

# install Zig 0.15.1 for your Linux architecture
```

Manual build:

```bash
cd host/krun-runner
zig build -Doptimize=ReleaseSafe -Dlibkrun-prefix=/path/to/libkrun/prefix
```

Binary output:

- `zig-out/bin/gondolin-krun-runner`

## Usage

The host controller spawns this binary with:

```bash
gondolin-krun-runner --config /path/to/config.json
```

Use with Gondolin:

- `sandbox.vmm = "krun"`
- optionally set `sandbox.krunRunnerPath`
- or set `GONDOLIN_KRUN_RUNNER`

## Notes

- Runner is linked against `libkrun` and uses an rpath that prefers bundled libs
- The krun backend expects a libkrunfw-compatible kernel image (Gondolin auto-detects the cache populated by `make krun-runner`)
- Currently experimental

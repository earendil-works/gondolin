# gondolin-krun-runner

Small host-side helper binary used by Gondolin's experimental `krun` backend.

## Distribution status

- `@earendil-works/gondolin` declares platform-specific optional dependencies:
  - `@earendil-works/gondolin-krun-runner-darwin-arm64`
  - `@earendil-works/gondolin-krun-runner-linux-x64`
- In this repo, you can always build it locally with `make krun-runner`
- Gondolin auto-detects local runner output at:
  - `host/krun-runner/zig-out/bin/gondolin-krun-runner`
- If you manage your own runner location, set `sandbox.krunRunnerPath`

## Build (recommended)

From repo root:

```bash
make krun-runner
```

This will:

- build and stage `libkrun` under `.cache/libkrun-install/<version>`
- build `host/krun-runner`
- bundle `libkrun` shared libraries under `host/krun-runner/zig-out/lib/`
- on macOS, ad-hoc sign the runner with `com.apple.security.hypervisor`

Linux prerequisites (Ubuntu/Debian):

```bash
sudo apt install \
  build-essential curl git make pkg-config clang lld xz-utils \
  libclang-dev llvm-dev libcap-ng-dev

# libkrun needs a modern Rust toolchain (edition2024 crates)
curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"

# install Zig 0.15.2 for your Linux architecture
```

## Manual build (advanced)

```bash
cd host/krun-runner
zig build -Doptimize=ReleaseSafe -Dlibkrun-prefix=/path/to/libkrun/prefix
```

Binary output:

- `zig-out/bin/gondolin-krun-runner`

## Using it with Gondolin

CLI:

```bash
gondolin bash --vmm krun
```

SDK:

- `sandbox.vmm = "krun"`
- optionally set `sandbox.krunRunnerPath`

## Notes

- Runner is linked against `libkrun` and uses rpath to prefer bundled libs
- `vmm=krun` requires image manifest krun assets (`assets.krunKernel`, optional `assets.krunInitrd`)
- Backend is experimental and has lower parity than QEMU

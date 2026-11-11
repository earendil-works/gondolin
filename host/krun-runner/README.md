# gondolin-krun-runner

Small host-side helper binary used by Gondolin's `krun` backend (the default VM backend where it can run).

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

- clone `libkrun` (`LIBKRUN_VERSION` in the top-level `Makefile`), apply
  gondolin's patches from `patches/` and build and stage it under
  `.cache/libkrun-install/<version>`
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

# install Zig 0.17.0 for your Linux architecture
```

On Fedora, RHEL and Amazon Linux 2023:

```bash
sudo dnf install \
  gcc make git clang clang-devel llvm-devel lld libcap-ng-devel \
  glibc-static pkgconf xz patch
```

(`glibc-static` provides the static C library libkrun links its guest `init`
against; Debian and Ubuntu ship it in `libc6-dev`, part of `build-essential`.)
Then install Rust and Zig as above.

The Linux runner targets glibc 2.34 (Amazon Linux 2023, RHEL 9, Ubuntu 22.04
and newer) regardless of the build machine's glibc; set `KRUN_RUNNER_GLIBC`
to change it.

## Manual build (advanced)

```bash
cd host/krun-runner
zig build -Doptimize=ReleaseSafe -Dlibkrun-prefix=/path/to/libkrun/prefix
```

The libkrun under the prefix must carry the patches in `patches/` (the runner
calls `krun_add_virtiofs_socket`).

## libkrun patches

- `0001-virtio-fs-socket-backend.patch`: `krun_add_virtiofs_socket(ctx, tag,
  fd)` adds a virtio-fs device whose FUSE requests are forwarded over a
  connected stream socket instead of being served from a host directory
  (framing in the patch's `include/libkrun.h`). `gondolind` serves the guest
  VFS through it (`native/crates/gondolin-virtiofs/src/socket.rs`).

To change a patch: `make libkrun` applies the patches to
`.cache/libkrun-<version>`; edit there, then regenerate with
`git -C .cache/libkrun-<version> add -N . && git -C .cache/libkrun-<version> diff > host/krun-runner/patches/<name>.patch`
(and `git reset`). The checkout is reset and re-patched whenever the patch
files change.

## Interface

- `gondolin-krun-runner --config <path>`: boot a VM from a JSON config
  (`KrunRunnerConfig` in `native/crates/gondolind/src/krun.rs`); unknown fields
  are ignored.
- `--version`: `gondolin-krun-runner X.Y.Z`.
- `--capabilities`: optional features, one per line; hosts check them before
  using the matching config fields. `virtiofs-socket`:
  `virtioFsDeviceSocketPath` / `virtioFsDeviceTag`.

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
- Backend has lower parity coverage than QEMU (see `docs/backends.md`)

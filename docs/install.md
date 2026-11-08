# Installation

Gondolin runs on macOS and Linux, on arm64 and x86_64. A working setup has
three parts:

- the `@earendil-works/gondolin` npm package (SDK and `gondolin` CLI), which
  needs Node.js
- the Gondolin daemon (`gondolind`), a static binary that runs the VM; it is
  installed with the npm package as an optional platform package
- a VM backend: QEMU, and optionally the krun runner (libkrun), which is the
  default wherever it can run

Guest images are not part of the installation: the default image is
downloaded and cached on first use (see [Images](./images.md)).

## Requirements

| | macOS | Linux |
| --- | --- | --- |
| Node.js | 22.19 or newer | 22.19 or newer |
| QEMU (incl. `qemu-img`) | `brew install qemu` | `qemu-system-arm` (arm64) or `qemu-system-x86` (x86_64), plus `qemu-utils` |
| krun (optional) | Apple silicon; runner ships with the npm package | read/write access to `/dev/kvm`; runner ships with the npm package on x86_64, build it on arm64 |
| Gondolin daemon | npm platform package (arm64, x64) | npm platform package (arm64, x64; static binaries) |

QEMU is needed on both backends: it is the VM backend wherever krun is not
available, and its `qemu-img` creates the root disk overlays for krun VMs as
well. Node.js is not needed for the [static CLI](#static-cli).

## Install the Package

Run the CLI without installing anything globally:

```bash
npx @earendil-works/gondolin bash
```

Install the CLI globally:

```bash
npm install -g @earendil-works/gondolin
gondolin bash
```

Add the SDK to a project:

```bash
npm install @earendil-works/gondolin
```

The package declares platform packages as optional dependencies; the package
manager installs only the ones matching your machine:

| Package | Contents | Platforms |
| --- | --- | --- |
| `@earendil-works/gondolin-native-<platform>` | `bin/gondolin`: the Gondolin daemon and the static CLI | `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` |
| `@earendil-works/gondolin-krun-runner-<platform>` | `gondolin-krun-runner` with a bundled libkrun | `darwin-arm64`, `linux-x64` |

The Linux daemon builds are static (musl) binaries. Keep the platform packages
at the same version as `@earendil-works/gondolin`.

## Install QEMU

macOS (Homebrew):

```bash
brew install qemu node
```

Debian/Ubuntu, arm64:

```bash
sudo apt install qemu-system-arm qemu-utils nodejs npm
```

Debian/Ubuntu, x86_64:

```bash
sudo apt install qemu-system-x86 qemu-utils nodejs npm
```

Distribution Node.js packages are often older than 22.19; check
`node --version` and install a newer Node.js if needed.

`qemu-img` is looked up next to the QEMU binary, then on `PATH`. On Linux,
QEMU uses KVM when `/dev/kvm` is accessible and falls back to software
emulation (TCG, much slower) otherwise.

How fast guest file access is depends on the QEMU build: with vhost-user
support (`qemu-system-aarch64 -device help | grep vhost-user-fs` lists
`vhost-user-fs-pci`), the guest mounts its files over virtio-fs. Linux
distribution builds have it; Homebrew's QEMU does not, so QEMU on macOS uses
the slower sandboxfs transport (see
[QEMU Backend](./qemu.md#virtio-fs-and-vhost-user)). krun VMs use virtio-fs on
both systems.

## krun

The `krun` backend (libkrun through the `gondolin-krun-runner` helper) is used
by default when all of these hold, and QEMU otherwise:

- the host supports libkrun: macOS on Apple silicon, or Linux on arm64/x86_64
  with read/write access to `/dev/kvm` (libkrun has no software emulation)
- a krun runner is installed
- the image has krun boot assets for the host architecture (published images
  and `gondolin build` output have them)
- no QEMU-only option is set

The full selection rules, how to pin a backend and the feature differences are
in [VM Backends](./backends.md#default-backend-selection).

The runner is found, in this order: `sandbox.krunRunnerPath` (SDK),
`GONDOLIN_KRUN_RUNNER`, a local build at
`host/krun-runner/zig-out/bin/gondolin-krun-runner` (searched from the current
directory and the package location), the installed
`@earendil-works/gondolin-krun-runner-*` package, then `gondolin-krun-runner`
on `PATH`. The static CLI skips the npm package (see
[Static CLI](#static-cli)).

### krun on Linux

Give your user read/write access to `/dev/kvm`. On most distributions the
device belongs to the `kvm` group:

```bash
ls -l /dev/kvm
sudo usermod -aG kvm "$USER"   # then log out and back in
```

On Linux x86_64 the runner comes with the npm package. On Linux arm64 build it
from a checkout (see [Building the krun Runner](#building-the-krun-runner)) and
point Gondolin at it:

```bash
export GONDOLIN_KRUN_RUNNER=/path/to/gondolin/host/krun-runner/zig-out/bin/gondolin-krun-runner
```

Use the runner in place: it loads its bundled libkrun from `zig-out/lib/`.

### krun on macOS

krun needs Apple silicon; Intel Macs use QEMU. The runner must be signed with
the `com.apple.security.hypervisor` entitlement to use Hypervisor.framework.
The npm runner package and `make krun-runner` builds are; Gondolin checks the
signature before booting.

## The Gondolin Daemon Binary

Every VM is run by the Gondolin daemon, `gondolind`. The platform package ships
it as one multi-call binary, `bin/gondolin`: started as `gondolin daemon` (or
under the name `gondolind`, for example through a symlink or the package's npm
`bin` link) it is the daemon, otherwise it is the [static CLI](#static-cli).

The SDK and the Node CLI use the first binary they find:

1. `GONDOLIN_NATIVE_BIN`: path to a `gondolin` or `gondolind` binary
2. a source checkout containing the package: the newest of
   `native/target/{release,debug}/gondolin` and
   `native/target/{release,debug}/gondolind`
3. the installed platform package
   `@earendil-works/gondolin-native-<platform>-<arch>`

When none is found, starting a VM fails; there is no fallback.

Installs that skip optional dependencies (`npm install --omit=optional`,
`--no-optional`) do not get the platform package. Install it explicitly, at the same version:

```bash
npm install @earendil-works/gondolin-native-linux-x64@<version>
```

or point `GONDOLIN_NATIVE_BIN` at a binary:

```bash
export GONDOLIN_NATIVE_BIN=/opt/gondolin/bin/gondolin
```

The daemon can also run on another machine than your Node.js process; that
machine needs only the binary and QEMU (or the krun runner). See
[Remote Machines](./remote.md).

## Static CLI

The `gondolin` binary of the platform package is also a self-contained CLI that
needs no Node.js: `bash`, `exec`, `list`, `attach`, `snapshot` and `image`, with
the same options as the Node CLI. It runs the VM in-process, so QEMU (or the
krun runner) is its only runtime dependency. `build` and `tools` need the Node
CLI. Usage and differences: [CLI Reference](./cli.md#static-cli-no-nodejs).

To get the binary without installing the npm package, download the platform
package and extract `package/bin/gondolin`:

```bash
npm pack @earendil-works/gondolin-native-linux-x64
tar -xzf earendil-works-gondolin-native-linux-x64-*.tgz package/bin/gondolin
install -m 0755 package/bin/gondolin ~/.local/bin/gondolin
```

From a checkout, `make native-release` builds it for all four platforms into
`native/target/dist/<target>/gondolin`.

The static CLI finds the krun runner through `GONDOLIN_KRUN_RUNNER`,
`host/krun-runner/zig-out/bin` and `krun-runner/zig-out/bin` in the current
directory, the directory of the `gondolin` binary, then `PATH`. Without one of
these it uses QEMU.

## Verify the Installation

```bash
gondolin --version
```

The Node CLI prints its package version and the daemon command it would use:

```text
gondolin X.Y.Z
gondolind: /path/to/node_modules/@earendil-works/gondolin-native-darwin-arm64/bin/gondolin daemon
```

`gondolind: not available (...)` means no daemon binary was found (see
[Troubleshooting](#troubleshooting)). The static CLI prints
`gondolin X.Y.Z (static)`; `gondolin daemon --version` prints the daemon's
version.

Then boot a VM:

```bash
gondolin exec -- uname -a
```

The first run downloads the default image (about 200 MB). Continue with the
[Quick Start](./quickstart.md).

## Building from a Checkout

From a clone of the repository (Rust, Zig 0.17.0, pnpm and Node.js):

```bash
make native        # daemon + static CLI: native/target/debug/gondolin
make krun-runner   # libkrun + runner: host/krun-runner/zig-out/bin/gondolin-krun-runner
```

The SDK and the Node CLI pick up both builds automatically when they run from
the checkout (`node host/bin/gondolin.ts bash`). For an optimized daemon, run
`make -C native release` (`native/target/release/gondolin`); the newest build
wins.

Guest images are built with `make -C guest build` (output in
`guest/image/out`, which a checkout uses as its default image) or with
`gondolin build`; see [Building Custom Images](./custom-images.md). To include
locally modified guest helpers, set `GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE=1`.

### Building the krun Runner

`make krun-runner` clones libkrun, applies Gondolin's patches, stages it under
`.cache/` (no global install), builds the runner and, on macOS, ad-hoc signs it
with the hypervisor entitlement. Linux prerequisites (Debian/Ubuntu):

```bash
sudo apt install \
  build-essential curl git make pkg-config clang lld xz-utils \
  libclang-dev llvm-dev libcap-ng-dev

# libkrun needs current stable Rust (edition2024 crates)
curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"

# install Zig 0.17.0 for your Linux architecture
```

## Troubleshooting

### `gondolind binary not found`

No daemon binary was found. Install the platform package for your machine
(the error names it), build one in a checkout (`make native`), or set
`GONDOLIN_NATIVE_BIN`. On other platforms the error is
`gondolind is not available for <platform>-<arch>`: only macOS and Linux on
arm64 and x64 are supported.

### QEMU Binary Not Found

`Error: QEMU binary 'qemu-system-aarch64' not found.` QEMU is not installed or
not on `PATH`. Install it (see [Install QEMU](#install-qemu)); the binary must
match the guest architecture (`qemu-system-aarch64` or `qemu-system-x86_64`).
Errors about `qemu-img` mean the QEMU utilities are missing
(`qemu-utils` on Debian/Ubuntu).

### krun Runner Not Signed (macOS)

`krun runner is not signed with the macOS Hypervisor entitlement` means the
runner cannot use Hypervisor.framework, for example after copying or
re-linking it. Rebuild it with `make krun-runner`, or set
`GONDOLIN_KRUN_RUNNER` to a signed runner. Check a binary with:

```bash
codesign -d --entitlements :- /path/to/gondolin-krun-runner
```

### krun Runner Binary Not Found

`--vmm krun`, `sandbox.vmm: "krun"` or `GONDOLIN_VMM=krun` was set but no
runner was found. Install the runner package (macOS arm64, Linux x86_64),
build it with `make krun-runner`, or set `GONDOLIN_KRUN_RUNNER` /
`sandbox.krunRunnerPath`. Without an explicit backend Gondolin uses QEMU
instead.

### VMs Use QEMU Instead of krun on Linux

Gondolin only selects krun when your user can read and write `/dev/kvm`. Check
with `test -r /dev/kvm -a -w /dev/kvm && echo ok`, add yourself to the device's
group (usually `kvm`) and log in again. Inside VMs and containers, KVM also
needs nested virtualization or the device passed through. Without `/dev/kvm`,
QEMU runs guests with software emulation, which works but is slow.

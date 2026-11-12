# Current Limitations

This page tracks the current limitations of Gondolin. If you are evaluating
Gondolin for a production workflow, treat this as a "known gaps" checklist.

## No Full VM Save/Restore (Memory Snapshots)

Gondolin does not provide full VM save/restore (capturing in-VM process state +
RAM) today.

However, Gondolin _does_ support **disk-only checkpoints** (qcow2-backed) via
`vm.checkpoint(<absolute qcow2 path>)` and `checkpoint.resume()`, or
`gondolin snapshot` and `gondolin bash --resume` on the CLI. Resuming boots a
fresh VM from the captured disk.

See also: [Persistence and Snapshots](./snapshots.md).

Tracking issue: [#8](https://github.com/earendil-works/gondolin/issues/8).

**Note:** Some guest paths are tmpfs-backed by default (eg. `/root`, `/tmp`,
`/var/tmp`, `/var/cache`, `/var/log`). Writes under those paths are not part of
disk checkpoints unless the VM `tmpfs` option moves them to the root disk. VFS
mounts are not part of checkpoints either.

## Adding Extra Packages Requires Building a New Image

The default guest image is intentionally minimal. If you need additional
packages (for example: compilers, language runtimes, or extra system tools), you
currently need to build a custom guest image and point Gondolin at it. This is
in some ways a consequence of the lack of snapshotting.

See [Building Custom Images](./custom-images.md).

## Only Alpine

The image builder currently only supports Alpine Linux.

## No HTTP/2 or HTTP/3 Support

Gondolin's network mediation currently focuses on HTTP/1.x over plain TCP and
HTTPS via TLS interception (the interception offers only `http/1.1` in ALPN).

As a result, HTTP/2 and HTTP/3 are not supported today. WebSocket upgrades are
supported, but after the `101` response the connection is an opaque tunnel:
only the handshake request is mediated and visible to hooks.

## No QUIC or WebRTC Support

Related to the lack of HTTP/3 support, QUIC is not supported. Likewise WebRTC
is not supported.

This means software that relies on UDP-based application protocols (or generic
UDP connectivity) will not work in the default network model. UDP is limited
to DNS (port 53); see [Network Access](./network-access.md).

## No Upstream HTTP Proxy

Guest HTTP(S) egress is always sent directly by the Gondolin daemon. Upstream
proxies (`HTTP_PROXY`/`HTTPS_PROXY` on the host) are not used, and there is no
pluggable upstream client (`VMOptions.fetch` is ignored). To intercept or
replace upstream requests, use `httpHooks.onRequest`, which may return a
`Response` (see [HTTP Hooks and Policies](./hooks.md)).

In `trusted` DNS mode the upstream resolvers must be IPv4 addresses.

## Static CLI Does Not Read the macOS Keychain

The SDK and the Node CLI verify upstream TLS certificates against Node.js'
default CA store (including `NODE_EXTRA_CA_CERTS`). The static `gondolin` CLI
trusts the Mozilla CA list, the system's PEM roots (`SSL_CERT_FILE` /
`SSL_CERT_DIR`, the distribution bundle on Linux, `/etc/ssl/cert.pem` on
macOS) and `NODE_EXTRA_CA_CERTS`, but not the macOS keychain. Roots installed
only there (e.g. a corporate TLS proxy's CA) must be exported to a PEM file,
or guest requests fail with `502`; see
[Debugging and Troubleshooting](./debug.md).

## Custom JavaScript Providers and Hooks Cost Round Trips

The daemon serves native mounts (`RealFSProvider` for a local daemon,
`nativeMounts.memory()`, `nativeMounts.host()`) and evaluates the declarative
network policy and tier-2 hooks itself. Everything implemented in your
JavaScript is a round trip to your process:

- custom VFS providers (`MemoryProvider`, your own `VirtualProvider`s): one
  round trip per uncached operation, so metadata-heavy work (package installs,
  builds, `git status`) on such mounts is noticeably slower than on native
  mounts
- VFS `before` hooks: one round trip per hooked operation
- HTTP hooks (`isRequestAllowed`, `isIpAllowed`, `onRequest`, `onResponse`):
  one round trip per registered phase and request

Prefer native mounts for scratch space and work trees, `createObjectMount()`
for whole-file backends, and declarative or tier-2 policies over Node hooks;
see [Files and Mounts](./vfs.md), [HTTP Hooks and Policies](./hooks.md) and
[Architecture](./architecture.md#what-calls-back-into-your-process).

## Backend Parity Gaps (QEMU vs krun)

Gondolin supports both `krun` (the default where it can run) and `qemu` (the
fallback), but feature parity is not complete.

Notable gaps today:

- `krun` only runs on macOS arm64 and Linux arm64/x86_64 with KVM, for guests
  of the host architecture; published runner packages exist for macOS arm64
  and Linux x86_64 only (build the runner yourself on Linux arm64)
- Cross-backend checkpoint resume (`qemu` ↔ `krun`) requires asset builds that
  include `manifest.assets.krunKernel`
- qemu-specific backend knobs (`machineType`, `accel`, `cpu`, `qemuPath`,
  `qemuIdlePauseMs`) are rejected when `vmm=krun`; without an explicit backend
  they select `qemu`
- `rootfs.mode="memory"` is not truly RAM-backed on `krun` (or on `qemu` when
  combined with `rootfs.size`); it is implemented as a temporary qcow2 overlay
  file on disk (in the daemon's temporary directory) that is deleted on close
- `krun`'s virtio-fs is served through the runner process over a socket, one
  request at a time: large reads and writes are slower than with QEMU's
  vhost-user virtio-fs (pin `vmm: "qemu"` on Linux for the fastest mounts)

See [VM Backends](./backends.md) for the maintained matrix.

## No Fast Filesystem Transport on Stock macOS QEMU

With the QEMU backend, guest mounts use virtio-fs only with a QEMU that
supports vhost-user. Homebrew's QEMU does not, so on macOS QEMU VMs mount
through sandboxfs (FUSE over virtio-serial) unless you build QEMU yourself; see
[QEMU Backend](./qemu.md#virtio-fs-and-vhost-user). The default `krun`
backend on Apple silicon is not affected.

## Remote Daemons Have Restrictions

A [daemon on another machine](./remote.md) cannot see your files, so some
options are rejected or behave differently there: explicit asset paths
(`sandbox.imagePath` as an object, or any path on your machine),
`sandbox.rootDisk*` and socket path overrides are rejected, `ssh.agent` is not supported, the
backend defaults to `qemu`, and `vm.getHostPid()` returns `null`.

## No Resource Governance

There are buffer caps (HTTP header/body limits, queue limits) and budgets for
tier-2 hooks, but no complete denial-of-service isolation: the guest can burn
CPU, use its memory, and cause host work within those limits. See
[Security Design](./security.md#dos).

## No Windows Support

The host side of Gondolin is supported on macOS and Linux only: the Gondolin
daemon and the static CLI ship for macOS arm64/x64 and Linux arm64/x64, and
there are no Windows builds.

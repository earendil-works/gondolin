# Upgrading

This page lists what you may have to change when upgrading Gondolin. The full
list of changes is in the
[changelog](https://github.com/earendil-works/gondolin/blob/main/CHANGELOG.md).

## Upgrading from 0.14

This release replaces the in-process TypeScript engine with the Gondolin
daemon (`gondolind`, a static Rust binary), makes `krun` the default VM
backend where it can run and no longer needs `qemu-img`. Most programs keep
working unchanged; check the sections below if you select an engine, pass
`fetch`, rely on QEMU-specific behaviour, work with root disks or
checkpoints, ship your own images or runner, or use the removed exports.

### The Daemon Is Required

The in-process engine (`node`) is gone. Every VM runs in the Gondolin daemon,
which ships in the optional platform packages
`@earendil-works/gondolin-native-{darwin-arm64,darwin-x64,linux-arm64,linux-x64}`
(see [Installation](./install.md#the-gondolin-daemon-binary)).

- Without a usable daemon binary, starting a VM fails with
  `gondolind binary not found`; there is no fallback. Make sure the
  platform package is installed (installs with `--omit=optional` or
  `--no-optional` skip it), or set `GONDOLIN_NATIVE_BIN` to a `gondolin` or
  `gondolind` binary.
- Drop engine selection: `VMOptions.engine: "node"`, `GONDOLIN_ENGINE=node` and
  `gondolin --engine node` throw `the node engine has been removed`.
  `"native"` and `"auto"` are still accepted and select the daemon.
- `gondolin --version` prints the package version and the daemon command the
  CLI would use; use it to check which binary is picked up.

### Removed Exports and Options

- `SandboxServer`, `FsRpcService`, `FsRpcMetrics` and `MAX_RPC_DATA` are no
  longer exported. Use `VM`.
- `VMOptions.fetch` is ignored: it was the old engine's upstream HTTP client.
  To intercept or replace upstream requests, use `httpHooks.onRequest`, which
  may return a `Response` (see [HTTP Hooks and Policies](./hooks.md)).
- Explicit `sandbox.virtioSocketPath`, `virtioFsSocketPath`,
  `virtioSshSocketPath` and `virtioIngressSocketPath` are rejected
  (`not supported: ...`); the daemon owns its
  sockets.
- The debugging switches `GONDOLIN_NATIVE_NET` and `GONDOLIN_NATIVE_VFS` are
  gone.
- `ssh2` and `undici` are no longer dependencies of the package. If your code
  imported them without depending on them itself, add them to your own
  `package.json`.

### Network Behaviour

- There is no upstream HTTP proxy support: `HTTP_PROXY` and `HTTPS_PROXY` are
  not honoured, neither for guest egress nor for image downloads by the
  daemon.
- Compressed upstream responses (`Content-Encoding: gzip`, ...) reach the
  guest compressed, as the server sent them. Hooks still see decoded bodies
  (without `Content-Encoding`), like `fetch` responses.
- Hooks you register in Node.js cost one round trip to your process per
  registered phase, and bodies are transferred only when a hook reads them.
  Policy expressed with `createHttpHooks()` options (allowlists, internal
  ranges, secrets) is evaluated in the daemon. For custom logic that runs
  without round trips, see tier-2 policies (`createDjsHooks()`,
  `--hooks-script`) in [HTTP Hooks and Policies](./hooks.md).
- Upstream TLS certificates are still verified against your Node.js default
  CA store (including `NODE_EXTRA_CA_CERTS`).

### Filesystem Behaviour

The daemon serves the guest filesystem itself (see
[Files and Mounts](./vfs.md)):

- `RealFSProvider`, `ReadonlyProvider` and `ShadowProvider` with a path list
  (`createShadowPathPredicate()`) are served natively, without calls into
  your process.
- Other JavaScript providers (`MemoryProvider`, your own `VirtualProvider`s,
  `ShadowProvider` with a custom predicate) are reached through a cached
  object tier: each uncached operation is a round trip to your process, so
  metadata-heavy work on these mounts is slower than before. Prefer
  `RealFSProvider`, `nativeMounts.memory()` or `nativeMounts.host()` for
  scratch space and project directories, and `createObjectMount()` for
  providers that naturally work on whole files.
- VFS `after` hooks run asynchronously, after the guest got its reply, and
  their `result` is the error or the transferred byte count. `before` hooks
  cost a round trip per hooked operation.
- Native mounts follow POSIX more closely: hard links work on mounts with
  hidden paths, and renames on in-memory mounts follow POSIX rules (a file
  cannot replace a directory).
- `gondolin --mount-memfs` is now an in-memory mount in the daemon.

### Errors Reported at Start

Some configuration errors are now reported when the VM starts (its first
`exec()` or `vm.start()`) rather than when `VM.create()` returns, because the
daemon validates them: for example unreadable SSH credential files, a missing
QEMU binary, an unknown image, or a root disk that cannot be prepared or
grown (`rootfs.size`).

### Root Disks and Checkpoints

The daemon now prepares every root disk itself, with a built-in qcow2
implementation, for local and remote VMs alike:

- `qemu-img` is no longer needed. QEMU is only needed for VMs on the `qemu`
  backend; hosts that run krun (Apple silicon, Linux x86_64 with `/dev/kvm`)
  need neither (see [Installation](./install.md#requirements)). A missing
  QEMU binary fails with `QEMU binary '...' not found: install QEMU or use
  the krun backend`.
- Overlays are created when the VM starts, in the daemon's private session
  directory under the system temporary directory, instead of by
  `VM.create()`. Root disk errors, including `rootfs.size` on your own
  `sandbox.rootDiskPath` disk, surface from `vm.start()` (or the first call
  that boots the VM).
- A resumed checkpoint's backing file name and format are rewritten when the
  resumed VM starts rather than in `resume()`.
- `vm.checkpoint()` on a VM that never started boots it first (also with
  `autoStart: false`); a VM whose guest already stopped is exported as it is.
  A VM resumed from a standalone checkpoint (no backing file) can now be
  checkpointed again.
- Checkpoints written to an existing file replace it atomically, so writing
  a checkpoint onto the one the VM was resumed from (`gondolin bash --resume
  X`, then `gondolin snapshot ... --output X`) keeps the old file until the
  new one is complete.
- Checkpoints keep their format: files created by earlier releases resume as
  before.

Security fix: resuming a crafted checkpoint could expose host files to the
guest, because its qcow2 header was handed to the VMM with only the backing
file name rewritten. The daemon now validates every qcow2 disk it attaches
and did not create (checkpoints, `sandbox.rootDiskPath`, qcow2 image rootfs)
together with its backing chain (see
[Security Design](./security.md#root-disks-and-checkpoints)). This can refuse
disks that worked before:

- A qcow2 `sandbox.rootDiskPath` whose backing file has no recorded format
  fails with `backing file without a backing format`. Record the format with
  `qemu-img rebase -u -F raw -b BACKING DISK` (or `-F qcow2`); the backing
  path stays the same.
- Backing files must be named by plain paths in `raw` or `qcow2` format; a
  name like `json:{...}` or `nbd:...` is refused.
- qcow2 disks with external data files, encryption, extended L2 entries or
  repeated header extensions (`repeated header extension ...`) are refused.
- `sandbox.rootDiskPath` (and every file in its backing chain) must exist and
  be a regular file when the VM starts. A block device still works as
  `sandbox.rootDiskPath` when attached raw (`rootDiskFormat: "raw"`), as
  before, but never as qcow2 (`a block device can only be attached as a raw
  disk`), in a backing chain or as a checkpoint; `rootfs.size` on it fails
  unless the device is already large enough (devices are not resized). Other
  special files (character devices, FIFOs, directories) are refused.

### krun Is the Default Backend

Without `sandbox.vmm`, `--vmm` or `GONDOLIN_VMM`, Gondolin now uses `krun`
(libkrun) when the host supports it (macOS on Apple silicon, Linux arm64 or
x86_64 with read/write access to `/dev/kvm`), a krun runner is installed (the
npm runner packages ship it for macOS arm64 and Linux x86_64) and the image
has krun boot assets. QEMU stays the default everywhere else, and when you set
a QEMU-only option (`sandbox.qemuPath`, `machineType`, `accel`, `cpu`,
`qemuIdlePauseMs`), use explicit asset paths, resume a checkpoint that is not
krun-compatible, or use a [remote daemon](./remote.md). The rules are in
[VM Backends](./backends.md#default-backend-selection).

To keep the previous behaviour, pin QEMU:

```bash
export GONDOLIN_VMM=qemu        # SDK and both CLIs
gondolin bash --vmm qemu        # one CLI command
```

```ts
const vm = await VM.create({ sandbox: { vmm: "qemu" } });
```

Reasons to pin QEMU:

- fastest guest file access on Linux: a distribution QEMU serves virtio-fs
  over vhost-user (shared memory, several queues), while krun forwards each
  request through the runner
- QEMU tuning options (`machineType`, `accel`, `cpu`, `GONDOLIN_CPU`) and
  idle pause on macOS (`qemuIdlePauseMs`)
- guests of another architecture than the host (krun requires the host's)
- krun has less parity coverage than QEMU; pin the backend wherever it matters
  rather than relying on detection

### Guest Images and virtio-fs

Guest file access now uses virtio-fs where available: on krun with this
release's runner, and on QEMU builds with vhost-user (Linux distribution QEMU;
not Homebrew's). Otherwise the guest uses sandboxfs as before.
`GONDOLIN_VIRTIOFS=0` forces sandboxfs, `GONDOLIN_VIRTIOFS=1` asks for
virtio-fs.

virtio-fs needs a guest image built with this version: images whose
`sandboxfs` predates it keep using sandboxfs. Rebuild custom images with this
release's `gondolin build`. Until sandbox helpers for this version are
published, build the helpers from source in a checkout with
`GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE=1` (see
[Building Custom Images](./custom-images.md#sandbox-helper-binaries)).

Rebuilt images also stop running `rngd`, which kept two vCPUs busy for about
11 s after every boot; older images keep starting it. And only rebuilt images
can signal commands: aborting `vm.exec()` (or `proc.kill()`) kills the
command in the guest only when its `sandboxd` supports `exec_signal`.

### krun Runner

The runner bundles libkrun 1.19.8 (was 1.17.4) with a Gondolin patch that
provides virtio-fs on krun. If you point `GONDOLIN_KRUN_RUNNER` or
`sandbox.krunRunnerPath` at a runner you built yourself, rebuild it with
`make krun-runner`; older runners still work but use sandboxfs.
`gondolin-krun-runner --capabilities` lists `virtiofs-socket` when the runner
supports it.

### Other Changes

- Aborting `vm.exec()` now kills the command and its child processes in the
  guest (`SIGKILL`, configurable with `killSignal`) instead of leaving it
  running; `ExecProcess.kill(signal)` is new. Execs now run in their own
  session and process group in the guest (also without a pty), so a command
  no longer shares `sandboxd`'s process group.
- `ExecProcess.write()` returns `false` once more than 1 MiB of stdin is
  unacknowledged; wait for `ExecProcess.drain()` before writing more. Stdin
  passed to `vm.exec()` (buffers, strings, streams) is sent with this
  backpressure and no longer fails with `payload_too_large` above 8 MiB.
- `GONDOLIN_MITM_CERT_DIR` sets the MITM CA directory for the SDK and both
  CLIs (`sandbox.mitmCertDir` still wins). CAs created by the daemon (remote
  daemons, the static CLI) are ECDSA P-256; existing RSA CAs in the cache keep
  working.
- If you talk to the guest helpers' protocol directly: undecodable control
  frames are answered with `invalid_request` / `invalid message`, stdin
  credit is batched, the remaining frames of a failed upload are dropped
  silently, `sandboxssh`/`sandboxingress` wait for the host to reconnect
  instead of exiting, `vfs_ready`/`vfs_error` carry a `features` list, and
  `exec_signal` is new. The wire protocol is otherwise unchanged
  ([`guest/ARCHITECTURE.md`](https://github.com/earendil-works/gondolin/blob/main/guest/ARCHITECTURE.md)).

New in this release, nothing to migrate: [remote daemons](./remote.md), the
[static CLI](./install.md#static-cli), tier-2 hook policies, object mounts and
native mounts.

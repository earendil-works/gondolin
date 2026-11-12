# Changelog

All notable changes to Gondolin are documented here.

## Unreleased

- The Linux krun runner (`make krun-runner`, the `@earendil-works/gondolin-krun-runner-linux-x64` package) is built for glibc 2.34 instead of the build machine's glibc, so it runs on Amazon Linux 2023, RHEL 9 and Ubuntu 22.04 again; 0.14.0 needed glibc 2.36 (`arc4random_buf`). CI fails if the runner or its libkrun need a newer glibc. `KRUN_RUNNER_GLIBC` overrides the target.
- Fix the krun backend on x86_64 Linux: the image build copied libkrunfw's x86_64 kernel out of `libkrunfw.so` as a raw image, which libkrun maps at its default address, so every VM aborted at start ("failed to initiate panic, error 5"). The build now reads the kernel's load and entry addresses from `krunfw_get_kernel` and wraps it in an ELF that carries them (the runner already passes ELF kernels to libkrun as such). aarch64 kernels are unchanged. Requires a guest image built with this version.
- In a source checkout the SDK also finds the daemon for its own platform in `native/target/dist/<target>/` (the output of `native/scripts/build-release.sh`), not just in `target/release` and `target/debug`; the newest wins.
- Fix concurrent resolves of the same image failing on macOS with `refs/<name>/<tag>/<arch>: Invalid argument` or `image ref not found` (for example several VMs created at once from a freshly downloaded image). Every resolver re-pointed the ref by renaming a new symlink over it, and on APFS a symlink being renamed over can briefly fail to read. A ref that already points at the object is now left alone, and readers retry a ref that is present but momentarily unreadable.
- Fix `rootfs.mode: "readonly"`, which never booted: the guest's init created `/data` and other mount points on the read-only root and the kernel panicked (QEMU then rebooted in a loop). Images now ship the mount points the init uses and link `/etc/resolv.conf` to `/run/resolv.conf` (Alpine's udhcpc writes it there), the init redirects an image's own `/etc/resolv.conf` to `/run` on a read-only root, and a mount at a path the image lacks fails the VM start with an error naming the path instead of stopping the guest. Requires a guest image built with this version.
- sandboxfs answers RELEASE without waiting for the host (the kernel ignores its result; the host still handles it in order): one round trip less per opened file, ~7-20% faster when reading many small files.
- sandboxfs lists directories with READDIRPLUS when the host offers it (`readdirplus` in the `mounts` reply, a new `readdirplus` op that returns each entry's lookup and only what fits the guest's reply): `find`, `ls -l` and other tree walks need no LOOKUP round trip per entry.  A cold `find` over 5000 files is 6-9 times faster, on par with virtio-fs.  Requires a guest image built with this version.
- The daemon handles sandboxfs requests without copying their data: requests are taken apart by moving the payload out of the decoded message, and responses are encoded once into a buffer of the exact size (`gondolin_wire::frame_value`).  sandboxfs reads are ~19% and writes ~12% faster.
- sandboxfs moves up to 1 MiB per request instead of 60 KiB: the host advertises its limit (`max_data` in the `mounts` reply; older hosts keep the guest at 60 KiB), sandboxfs negotiates FUSE `max_pages` to match and raises the mount's readahead to the same size.  Sequential reads and writes over sandboxfs are about twice as fast (QEMU over virtio-serial: 246 MB/s read, 336 MB/s write).  Requires a guest image built with this version for the larger requests.
- Fix `vm.close()` taking 3 s (and the daemon outliving it when the SDK could not kill it, e.g. behind `sudo`) after an object mount's commit failed: at shutdown the daemon retried the commit through the SDK, which had stopped answering. Requests to the SDK now fail as soon as its connection ends.
- QEMU on x86_64 Linux falls back to the `q35` machine when the binary has no `microvm` (Amazon Linux 2023 and other distribution builds leave it out; QEMU failed with "Use -machine help to list supported machines").  The daemon probes `-machine help` once per binary along with its virtio-fs probe (cached in `<cache>/gondolin/qemu-probe.json`); an explicit `sandbox.machineType` is never changed.
- `GONDOLIN_DEBUG=timing` (SDK `debug: ["timing"]`) reports when each step of starting and stopping the VM finished: root disk, network, VMM spawn, each guest channel connecting, the first guest messages and shutdown, in milliseconds since the session was created and since the previous step.
- `qemu-img` is no longer needed: the daemon prepares every root disk (local and remote sessions, SDK and both CLIs) with a built-in qcow2 implementation (`native/crates/gondolin-qcow2`): `cow` overlays, `rootfs.size`, `memory` and `readonly` modes, checkpoint rebasing on resume and collapsing a resumed session's checkpoint chain.  QEMU is only needed for the `qemu` backend; a missing QEMU binary fails with "QEMU binary '…' not found: install QEMU or use the krun backend".  Checkpoints keep their format, and ones created by earlier releases resume as before.  Overlays now live in the daemon's session directory and are created when the VM starts, so a resumed checkpoint's backing file is updated at start rather than at `resume()`; `vm.checkpoint()` boots a VM that never started (one whose guest stopped is checkpointed as it is), and a VM resumed from a standalone checkpoint (no backing file) can be checkpointed again.  Checkpoints written to an existing file replace it atomically, so `gondolin bash --resume X` followed by `gondolin snapshot … --output X` keeps the old checkpoint until the new one is complete.
- Security: resuming a crafted checkpoint could expose host files to the guest: its qcow2 header was handed to the VMM after only rewriting the backing file name, so an external data file (or a backing file in an unchecked format) named in it was opened by QEMU or libkrun.  The daemon now validates every qcow2 it attaches that it did not create (checkpoints, `sandbox.rootDiskPath`, qcow2 rootfs images) and its backing chain: no external data files, encryption or unknown incompatible features, only `raw`/`qcow2` backing files named by plain paths, and an imported checkpoint must be backed by exactly the session's rootfs after the rebase.  This can refuse a `sandbox.rootDiskPath` that worked before: a qcow2 disk whose backing file has no recorded format (set one with `qemu-img rebase -u -F raw|qcow2`), a backing file named by a protocol or JSON (`nbd:`, `json:`), qcow2 disks with external data files, encryption, extended L2 entries or repeated header extensions, and a disk or backing file that is not a regular file.  A block device still works as `sandbox.rootDiskPath` when attached raw (`rootDiskFormat: "raw"`), as before; it is never accepted as qcow2, in a backing chain or as a checkpoint, and `rootfs.size` on it fails unless the device is already large enough (devices are not resized).
- Fix checkpoints of resumed remote sessions losing what the resumed checkpoint held: the daemon now collapses the overlay's chain onto its rootfs before exporting it.
- Fix `gondolin snapshot` of a `gondolin bash` session on a remote daemon failing with "session connection closed" when the export took a moment: `vm.close()` now waits for a checkpoint in progress.
- Aborting `vm.exec()` (`signal`) now kills the command and the processes it started in the guest (`SIGKILL` by default, `killSignal` to change it) instead of only rejecting the promise; an exec aborted before it started is never sent.  New `ExecProcess.kill(signal = "SIGTERM")` signals a running command (Linux signal names or numbers).  Each exec runs in its own session and process group in the guest; the daemon forwards the new `exec_signal` message only to guests whose `sandboxd` announces the `exec_signal` feature (images built with this release), and logs a warning otherwise.
- Fix `VM.create({ autoStart: false })` followed by `vm.start()` failing with "sandbox is stopped".  With `autoStart: false`, `exec`, `vm.fs`, `enableSsh` and `enableIngress` before `start()` now fail with "vm is not started (autoStart: false); call vm.start() first"; VMs still boot lazily on first use otherwise.
- The `krun` backend is now the default wherever it can run: without `sandbox.vmm`, `--vmm` or `GONDOLIN_VMM`, Gondolin uses krun when the host supports libkrun (macOS arm64, Linux arm64/x86_64 with read/write access to `/dev/kvm`), a krun runner is installed (the npm runner packages for macOS arm64 and Linux x86_64, a local `make krun-runner` build, `GONDOLIN_KRUN_RUNNER` or `PATH`) and the image has krun boot assets for the host architecture, and QEMU otherwise.  Explicit asset paths, qemu-only options (`sandbox.qemuPath`, `machineType`, `accel`, `cpu`, `qemuIdlePauseMs`), resuming checkpoints that are not krun-compatible and remote native daemons keep defaulting to QEMU.  Set `GONDOLIN_VMM=qemu` (or `sandbox.vmm: "qemu"`) to keep the previous behavior.  Both CLIs and the SDK share the selection; the static CLI does not look in the npm runner packages.
- The krun runner bundles libkrun 1.19.8 (was 1.17.4) with a gondolin patch (`host/krun-runner/patches`) that lets the daemon serve the guest filesystem over virtio-fs on krun: libkrun's virtio-fs device forwards FUSE requests to `gondolind` over a socket, so krun guests (macOS and Linux) mount the VFS with virtio-fs instead of sandboxfs, with the same mount rules and object-tier commit errors at `close()`/`fsync()`.  On an M5 Max metadata operations are about 2–3× and 256 MiB reads and writes about 3.5× faster than sandboxfs.  The runner reports the feature with `gondolin-krun-runner --capabilities` (`virtiofs-socket`); older runners keep using sandboxfs.  Requires a guest image built with this version, like virtio-fs on QEMU.
- New native host engine `gondolind` (Rust, `native/`), which replaces the in-process TypeScript engine.  The daemon runs the VM (QEMU and krun), exec, `vm.fs`, SSH/ingress access, checkpoints, the network stack and HTTP/TLS mediation, and calls back into the controller only for registered hooks (bodies only when read) and JS VFS providers.  The guest filesystem is served by the daemon: `RealFSProvider`, `ReadonlyProvider` and path-list `ShadowProvider` mounts become hardened native mounts, other providers are reached through a cached whole-file object tier, and the new `ObjectProvider`/`createObjectMount()` and `nativeMounts.memory()`/`nativeMounts.host()` mounts are served natively; `gondolin --mount-memfs` uses `nativeMounts.memory()`.  See `docs/native.md`.
- Remote native daemons: `VMOptions.native: { command | connect, remote, image }` (`GONDOLIN_NATIVE_COMMAND`, `GONDOLIN_NATIVE_REMOTE`, `GONDOLIN_NATIVE_IMAGE`, `gondolin --native-command CMD --remote`) run the daemon on another machine, e.g. over SSH.  It needs only QEMU and the binary there; images, root disks and its MITM CA are handled on its side, while policy, hooks, credentials and file providers stay in the local controller.  `spawnNativeConnection()` and the `NativeConnection` type describe the connection.
- The native engine ships as optional platform packages `@earendil-works/gondolin-native-{darwin-arm64,darwin-x64,linux-arm64,linux-x64}` (Linux builds are static musl binaries) with one multi-call binary, `bin/gondolin`: the static CLI, and the daemon when started as `gondolin daemon` or under the name `gondolind` (the packages' npm `bin` alias).  The SDK finds it through `GONDOLIN_NATIVE_BIN` (`gondolin` or `gondolind`), the newest build in a source checkout, or the installed package.  `getNativeBinaryPath({ platform, arch })` and `ensureNativeBinary({ platform, arch })` locate (or fetch from the npm registry) the binary for another platform and return `{ path, args }` with the arguments that start the daemon; `nativeDaemonArgs()`/`nativeDaemonCommand()` are exported too.
- Static `gondolin` CLI without Node.js (`native/crates/gondolin-cli`): `bash` (including `--listen`, `--ssh`, `--resume`), `exec`, `list`, `attach`, `snapshot` and `image` on the native engine in-process.  Sessions and checkpoints are interchangeable with the Node CLI.  Both CLIs gain `--print-configure` to print the native engine's session configuration.
- The native engine serves the guest filesystem over virtio-fs (vhost-user-fs) when QEMU supports it, with sandboxfs as the fallback: metadata operations are about 2–4× and large reads and writes 10–15× faster, and object-tier commit errors reach the guest's `close()`/`fsync()`.  Linux distribution QEMU builds support it; Homebrew's QEMU on macOS lacks vhost-user.  `GONDOLIN_VIRTIOFS=0|1` overrides the choice.  The guest's `sandboxfs` gains `--virtiofs TAG` (requires a guest image built with this version).
- Tier-2 network hooks: `createDjsHooks(source | { source, kind, filename, modules, limits })` creates `HttpHooks` from a self-contained JavaScript policy that the native engine runs inside the daemon on djs (no controller round trip per request; works with remote daemons and the static CLI).  Spread it into `createHttpHooks()` to combine it with allowlists and secrets; declarative policy runs first, then tier 2, then Node (tier-3) hooks.  Each call starts from the compiled policy's state with fuel, memory and time budgets, and any failure denies the request with 502.  `kind: "module"` and `kind: "typescript"` select ES module and TypeScript policies, and `.ts`/`.json` keys in `modules` TypeScript and JSON modules.  Both CLIs gain `--hooks-script FILE` (`.js` script, `.mjs` ES module, `.ts`/`.mts` TypeScript module; relative imports, including JSON modules, are read from next to the file, as `djsHooksOptionsFromFile()` does for SDK users).  See `docs/native.md`, "Tier-2 Hooks".
- Breaking: the in-process TypeScript engine (`node`) is removed.  Every VM runs on the native engine; without a usable `gondolind` binary (platform package, source checkout build or `GONDOLIN_NATIVE_BIN`) starting a VM fails instead of falling back.  `VMOptions.engine: "node"`, `GONDOLIN_ENGINE=node` and `gondolin --engine node` throw; `native` and `auto` are still accepted and both select the native engine.  `SandboxServer`, `FsRpcService`, `FsRpcMetrics` and `MAX_RPC_DATA` are no longer exported.  `VMOptions.fetch` is ignored (it was the node engine's upstream client; use `httpHooks.onRequest`, which may return a `Response`).  The internal debugging modes `GONDOLIN_NATIVE_VFS=controller` and `GONDOLIN_NATIVE_NET=external|relay` (and the daemon's `vfs: { mode: "controller" }` and `net: { mode: "external" | "relay" }`) are gone.  `ssh2` and `undici` are no longer runtime dependencies.  See "Migrating from the node engine" in `docs/native.md`.
- `GONDOLIN_MITM_CERT_DIR` sets the MITM CA directory for the SDK and both CLIs (`sandbox.mitmCertDir` still wins).
- `gondolin --version` (also `-V`, `version`) prints the package version and the native engine binary the CLI would use.
- MITM CAs created by the daemon (remote daemons, the static CLI) are ECDSA P-256; CAs of either kind (RSA ones from earlier releases) are accepted in the shared cache directory.  The daemon does not honour `HTTP_PROXY`/`HTTPS_PROXY` (image downloads and guest egress).
- Guest images no longer run `rngd` (and drop the `rng-tools` package): the kernel feeds virtio-rng entropy into the pool by itself, and `rngd`'s startup kept two vCPUs busy for about 11 s after every boot (about 21 s of host CPU per VM).  Requires a rebuilt guest image; older images keep starting `rngd`.
- `ExecProcess.write()` now returns `false` when more than 1 MiB of stdin is unacknowledged and `ExecProcess.drain()` waits until more can be written; `vm.exec` stdin inputs (buffers, strings, streams) are sent with this backpressure instead of failing with `payload_too_large` above 8 MiB.
- Fix `rm -rf` (and other delete-while-listing loops) on VFS mounts leaving entries behind with "Directory not empty": directory listings continued after entries were removed now keep their original offsets.
- Fix `MemoryProvider` reallocating and copying the whole file on every extending write (a 64 MiB file written in small chunks used gigabytes of memory).
- Rework the guest helpers (`sandboxd`, `sandboxfs`, `sandboxssh`, `sandboxingress`) as static, libc-free, single-threaded binaries.  `sandboxd` is now a single `poll(2)` event loop (virtio port, a `SIGCHLD` signalfd and every exec session's stdio) instead of a thread per exec session with a shared blocking writer; all output goes through one bounded queue, so a slow host backs up into the child's pipes instead of guest memory.  All helpers share one framing/CBOR/protocol layer and binaries are 75-85% smaller.  The wire protocol is unchanged; `guest/ARCHITECTURE.md` is the full specification.
- Fix zombie processes accumulating in the guest: `sandboxd` (PID 1) now reaps orphaned children.
- Fix `sandboxfs` exiting (breaking the VFS mount with `ENOTCONN`) when a directory listing with long file names overflowed the kernel's readdir buffer, when a request was interrupted, or when the host sent a malformed response.  Such failures now return `EIO` for the affected request.
- Fix `sandboxssh`/`sandboxingress` being killed by `SIGPIPE` when a guest service closed a connection, and never answering a `tcp_open` whose socket setup failed after connecting.
- Fix uploads (`vm.fs.writeFile`) failing when exec control messages (e.g. output window updates) were interleaved with the upload, and stop `sandboxd` from blocking all exec I/O while streaming a file to the host.
- Fix exec children inheriting `sandboxd`'s blocked `SIGCHLD` and ignored `SIGPIPE`, PTY drain deadlines being shifted by guest clock changes (`time_sync`), oversized frames desynchronizing the control channel, and stdin credit leaking when queueing stdin ran out of memory.
- Recursive guest deletes (`vm.fs.deleteFile(..., { recursive: true })`) use a new symlink-safe walker with constant file descriptor usage, so very deep trees no longer hit descriptor or `PATH_MAX` limits.
- Host-visible behavior changes of the guest helpers:
  - Undecodable control frames are answered with `error{code: "invalid_request", message: "invalid message"}` (previously the misleading `"invalid time_sync"`).
  - Returned stdin credit is batched into at most one `stdin_window` per exec per event loop iteration instead of one per written chunk.
  - After an upload fails, its remaining `file_write_data` frames are dropped silently instead of each producing an `invalid_request` error.
  - `sandboxssh`/`sandboxingress` wait for the host to reconnect their port instead of exiting.
  - Per-frame and per-exec logging on the serial console is now debug-level only.

## 0.14.0

- Fix `chmod` from the guest being silently ignored on VFS mounts (`MemoryProvider`, `RealFSProvider`, `ShadowProvider`, ...): sandboxfs now forwards mode changes to the host and providers gain an optional `chmod()` method.  `RealFSProvider` never applies setuid/setgid bits to host files.  Requires a guest image built with this version.  #115
- Fix a TOCTOU race in VFS path validation: fs-rpc requests are now processed strictly in order, so a guest pipelining requests can no longer swap a directory between `RealFSProvider`'s path check and the host syscall to reach files outside the mount root.  #143
- Drop the `node-forge` dependency (affected by GHSA-86w9-cpqp-85rv with no patched release).  MITM CA and leaf certificates are now built with `node:crypto` and a small DER encoder; existing certificates in the MITM cert dir keep working.  Key generation is native and off the event loop, and a persisted CA whose key does not match its certificate is now regenerated.
- Fix image builds silently reusing stale cached Alpine package indexes, which pinned new images to outdated (potentially vulnerable) packages until `gondolin build cache update` was run.  Builds now refresh indexes older than 24 hours and fall back to the cached copy when the mirror is unreachable.
- Bump the default Alpine version to 3.23.7 and install `ca-certificates-bundle` explicitly so `/etc/ssl/certs/ca-certificates.crt` always comes from the current package rather than the minirootfs.

## 0.13.0

- Add a `tmpfs` VM option to configure the scratch tmpfs mounts created by the guest `/init` (`/root`, `/tmp`, `/var/tmp`, `/var/cache`, `/var/log` by default), including per-mount `size` and `mode`.  `tmpfs: {}` keeps those paths on the root disk so cache-heavy workloads no longer consume guest RAM.  Requires a guest image built with this version.  #133
- The guest `/init` no longer exports `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `UV_CACHE_DIR` pointing into `/tmp`; tools now use their defaults under `$HOME`.  Set them via the VM `env` option if needed.  #133
- Fix many VFS mounts silently dropping the MITM CA (and other late bind mounts) because the bind list overflowed the 2048 byte kernel command line.  `sandboxfs` now fetches the bind list from the host over its RPC channel, which also makes mount paths with spaces or commas work.  The command line only carries as many binds as fit (gondolin's own first) for older guest images.  #150
- Block guest HTTP/TLS egress to loopback, private, link-local and other internal address ranges by default, even when no `httpHooks` (or no `httpHooks.isIpAllowed`) are configured.  Previously VMs created without hooks could reach host-local services and cloud metadata endpoints.  Provide a custom `isIpAllowed` to opt out.
- Close idle upstream UDP sockets in `trusted` and `open` DNS modes and cap the number of concurrently open ones, fixing a host file descriptor leak in long-running VMs.
- Lower the minimum supported Node.js version to 22.19.0 (previously 23.6.0).
- Drop the generated `dist/src/index.cjs` shim; CommonJS consumers now load the ESM entrypoint directly through Node's `require(esm)` support.
- Upgrade guest and krun runner builds to Zig 0.17.0.  The krun runner now uses hand-written libkrun bindings instead of `@cImport`.
- Fix cached sandbox helpers being rejected with a `gondolinVersion mismatch` after upgrading Gondolin when the new release reuses the same helper build.
- `VM.close()` is now terminal: `start()`, `exec()` and friends on a closed VM reject with `vm is closed` instead of silently restarting the sandbox server and leaking its sockets.
- `GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE=1` now always builds helpers from local Zig sources as documented, instead of only acting as a fallback when published helpers cannot be resolved.
- Fix unhandled promise rejections when `writeGuestFile()` or `deleteGuestFile()` fail before completion, for example when aborted.  #136
- Fix HTTP 502 responses for guest requests with buffered bodies (e.g. `POST`, `git clone` over HTTP) on Node.js >= 24.17 caused by a duplicated `Content-Length` header.  #135
- Add `e2fsprogs-extra` to the default `alpine-base` build config so `rootfs.size` / `--rootfs-size` can find `resize2fs` in the guest.  #140
- Take the guest kernel image from the kernel package installed during `gondolin build` instead of downloading it separately, so the kernel and its modules can no longer drift apart when build caches are stale.  #144
- Fix `gondolin exec --sock`, which still spoke the raw virtio protocol, to use the session IPC protocol with output flow control.  `--sock` now also accepts a session id.  #139
- Add a Browser Use example that drives Chromium running inside a micro-VM through the ingress gateway.  #145
- Add `gondolin image rm` (by ref, build id, `--untagged` or `--all`) and `gondolin build cache info|update|rm` for managing local images and the Alpine build cache.  `image ls` now lists untagged images.  #146
- Automatically refresh cached Alpine `APKINDEX` files during `gondolin build` when a package download returns 404 because the cached index is stale.
- Fix TCP sequence and acknowledgement numbers not wrapping at 2^32 in the QEMU network stack, which crashed the host process with `ERR_OUT_OF_RANGE` for connections with a high guest ISN or after ~4 GiB on one connection.  #119 #138
- Re-sync the guest wall clock from the host after QEMU resumes from an idle pause, fixing `certificate is not yet valid` errors for MITM TLS and other clock-dependent tooling in long-lived VMs.  #148
- Fix stale trailing bytes when guest processes shrink or `ftruncate()` files on `MemoryProvider` mounts: open `MemoryFileHandle`s now follow truncates done through the path or other handles.  sandboxfs also advertises `FUSE_ATOMIC_O_TRUNC` so `O_TRUNC` is applied on open.  #149
- Generated HTTP-hook secret placeholders now default to a shared random marker plus the secret name (`<marker>.<secret_name>`) so secrets can be resolved by identifier.  Set `secretPlaceholderMode: "unique"` to keep fully random per-secret placeholders.  #122 #123
- `--host-secret NAME` no longer requires explicit hosts: Gondolin uses a managed TruffleHog helper to suggest hosts for the secret and asks for confirmation.  Inspect the helper with `gondolin tools trufflehog`.  #120
- Fix HTTPS egress when the host runs on Bun: select MITM certificates by pre-parsing the guest ClientHello SNI (Bun does not call `SNICallback`), and end MITM TLS sessions only after the full response reached the guest flow. #147 #73
- Fix `gondolin build` producing rootfs images that are too small when the build directory is on a compressing filesystem (zfs, btrfs): the size estimate now uses apparent file sizes instead of `du`.  #142
- Fix `ShadowProvider` (`writeMode: "tmpfs"`) failing with `ENOENT` when creating a shadowed directory whose parent only exists in the backend.  #126
- Create the standard `/dev/fd`, `/dev/stdin`, `/dev/stdout` and `/dev/stderr` symlinks in the guest so bash process substitution works (requires rebuilding images).  #118
- Bind-mount `/dev` into the `postBuild.commands` chroot so commands can use `/dev/null` and friends.  #153
- Fix concurrent `vm.fs` operations (e.g. parallel `writeFile()` calls) interleaving on the guest protocol and hanging forever: file operations are now strictly serialized.  #137
- Fix krun boots failing with `InvalidGuestAddress` on x86_64 because of a 0-byte `krun-empty-initrd`: builds now emit a valid empty cpio archive and 0-byte initrds from older images are replaced at runtime.  #91
- The `pi-gondolin.ts` example now writes files through `vm.fs` (no more argv size limit for large files) and no longer forwards the host environment into the guest.  #130 #11

## 0.12.0

- Add `VM.getHostPid()` to allow callers to collect host-side process metrics of the VM runner. #114

## 0.11.0

- Add conservative QEMU auto-pause for idle macOS/HVF sandboxes, with guest activity tracking and configurable `qemuIdlePauseMs`. #112

## 0.10.0

- Added runtime rootfs sizing via `rootfs.size` / `--rootfs-size`, growing the writable disk and running `resize2fs` in the guest. #94

## 0.9.1

- Replace deprecated `UV_NATIVE_TLS` with `UV_SYSTEM_CERTS` in guest init environments #98
- Replace the workflow Zig setup action with a checked-in installer for more reliable CI/release builds #102
- Update the built-in sandbox helper registry with the `gondolin:0.9.0` helper bundles

## 0.9.0

- Add packaged sandbox helper bundles for `gondolin build`, allowing published installs to build images without a local Zig toolchain #99
- Add QEMU CPU model override support for architecture/host compatibility #96
- Fix HTTP hook secret scoping so secret host rules no longer implicitly depend on the global allowlist #93
- Upgrade guest and krun runner builds to Zig 0.16.0

## 0.8.1

- Fixed CommonJS consumers by restoring the `require` export entrypoint #97
- Updated the built-in image registry so `alpine-base:latest` points to `alpine-base:0.2.0`

## 0.8.0

- Fixed checkpoint resume to avoid overwriting the source checkpoint when resuming into the same path
- Fixed WebSocket proxying through `httpHooks` by re-injecting upgrade headers stripped by WHATWG `Request` handling #83
- Fixed ingress proxying for some HTTP backends (including Kestrel and Vite) and large responses by avoiding premature EOF handling and draining readable bytes on `POLLHUP` #84 #87
- Fixed `make krun-runner` builds on macOS

## 0.7.0

- Add experimental `krun` backend support (`--vmm krun` / `sandbox.vmm = "krun"`) with packaged runner binaries and krun boot assets in build manifests #70
- Add `postBuild.copy` for custom image builds, allowing host files/directories to be copied into the guest rootfs before `postBuild.commands`
- Improve custom image build reliability by preserving APK PAX long-path entries and zero-byte files during extraction
- Preserve OCI image UID/GID ownership metadata when assembling ext4 rootfs images from OCI sources
- Fix `postBuild.commands` shell detection for rootfs images where `/bin/sh` is an absolute symlink (for example Alpine minirootfs)
- Fix forced container builds (`container.force`) under rootless runtimes by moving Zig caches to writable in-container paths
- Improve guest source discovery for packaged installs so `gondolin build` works without requiring a separate local checkout in common cases
- Improve TCP/HTTP bridge stability under backpressure and disconnects to prevent stalled or poisoned pooled connections #71
- Normalize host filesystem RPC error propagation to canonical Linux errno values so guests receive consistent errors across macOS and Linux hosts

## 0.6.0

- Add support for OCI container images with customizable pull policies, layer caching, and rootfs safety checks. #53
- Add explicit host-mapped TCP egress rules (`tcp.hosts` / `--tcp-map`) for narrowly scoped non-HTTP workloads, using synthetic DNS per-host attribution
- Switched egress `httpHooks` to WHATWG `Request`/`Response` types and added support for returning synthetic responses from `onRequest` to short-circuit upstream fetches
- Added internal request/response conversion helpers and expanded HTTP hook/network test coverage (including undici compatibility and body-size guardrails)
- Updated networking/secrets docs to reflect the new hook API and short-circuit behavior
- Reworked host VFS loading to import vendored `node:vfs` directly from `src/vfs/node/vendored-node-vfs`, removing the custom loader and adding clearly tagged patch markers for upstream syncs
- Added `allowedInternalHosts` to `createHttpHooks()` for host-pattern-scoped internal-IP exceptions (without requiring duplicate `allowedHosts` entries), plus docs clarifying that `onRequest` short-circuit fetches run outside VM egress IP policy

## 0.5.0

- Add richer host-side `vm.fs` APIs (`access`, `mkdir`, `listDir`, `stat`, `rename`, streaming reads, and recursive deletes) for interacting with guest filesystems. #48
- Add configurable VM rootfs modes (`readonly`, `memory`, `cow`) and support asset-level default rootfs mode via `manifest.json`
- Add `gondolin snapshot` plus `gondolin bash --resume` to snapshot active sessions and restart from saved checkpoints

## 0.4.0

- Add bash fallback to `/bin/sh` for `gondolin bash` and `gondolin attach` when bash is unavailable
- Add VM registry and `gondolin attach`/`gondolin list` CLI commands to manage and connect to running VMs
- Fix `gondolin build` post-build `chroot` commands that require `/proc` by mounting procfs during hook execution
- Add `rmdir` support in `sandboxfs` fs-rpc so removing directories on VFS mounts no longer returns `ENOSYS`
- Improve `sandboxfs` FUSE compatibility with `RENAME2`, `FSYNCDIR`, `FALLOCATE`, and `COPY_FILE_RANGE` support via fs-rpc
- Improve FUSE fallback behavior by mapping `ioctl` to `ENOTTY`, mknod/xattr ops to `EOPNOTSUPP`, and logging unsupported opcodes only once
- Fix VFS metadata and permission checks by using `lstat` for symlink-sensitive paths and adding stat-based `access` fallback
- Update vendored `node:vfs` sources/docs to Node.js PR #61478 (including Windows path normalization fixes, mount lifecycle events, and expanded API limitations docs), while keeping Gondolin-specific provider patches (`RealFSProvider` hardening/extensions and `MemoryProvider` hard-link support)

## 0.3.0

- Added `httpHooks.onRequestHead` and streamed `Content-Length` request bodies to avoid buffering
- Add SSH authentication and an exec policy for controlled SSH access. #37
- Allow customizing `gondolin bash` (command, `cwd`, and environment variables). #38
- Add WebSocket proxying support in the network stack. #30
- Split HTTP policy hooks and add safer secret substitution options (incl. query params). #29
- Add snapshots and shadowing VFS providers. #15 #20
- Expand VFS/FUSE feature coverage (STATFS/`df`, links/symlinks, guest file I/O). #33
- Add configurable DNS modes and harden DNS parsing against compression-pointer attacks
- Improve sandbox UX (stdout/stderr backpressure, Ctrl+C handling, host HTTP gateway). #18 #22 #24
- Add tmpfs overlay root and additional custom image build hooks

## 0.2.1

- Run string exec commands via `/bin/sh -lc` for predictable shell behavior
- Add example Pi + Gondolin sandbox extension
- Documentation and CI improvements

## 0.2.0

- Add CLI startup feedback and QEMU dependency checks. #5
- Add component-scoped debug logging
- Rewrite the image builder in TypeScript and introduce a configurable asset build pipeline
- Improve VM startup and QEMU microvm compatibility (virtio-mmio + serial console). #3
- Harden HTTP bridge behavior (limits, header handling, buffering, caching)
- Improve VFS provider correctness and expand automated test coverage
- Documentation site + guides overhaul

## 0.1.3

- Inject the MITM CA into the guest via VFS to simplify certificate trust

## 0.1.2

- Fix release asset version resolution (derive from `package.json`)

## 0.1.1

- Fix arm64 release image builds
- Documentation + licensing updates (Apache-2.0)
- CI improvements for downloading guest assets in tests

## 0.1.0

- Initial release
- Host/guest virtio protocol with exec + PTY support
- Programmable network stack with HTTP(S) interception and policy enforcement
- Virtual filesystem (VFS) layer with FUSE-based `sandboxfs` and mount routing
- Alpine image build tooling and QEMU helpers
- NPM package publishing and CI workflow

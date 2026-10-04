# Changelog

All notable changes to Gondolin are documented here.

## Unreleased

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
- Fix TCP sequence and acknowledgement numbers not wrapping at 2^32 in the QEMU network stack, which crashed the host process with `ERR_OUT_OF_RANGE` for connections with a high guest ISN or after ~4 GiB on one connection.  #119
- Fix HTTPS egress when the host runs on Bun: select MITM certificates by pre-parsing the guest ClientHello SNI (Bun does not call `SNICallback`), and end MITM TLS sessions only after the full response reached the guest flow. #147 #73

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

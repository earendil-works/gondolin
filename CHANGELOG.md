# Changelog

All notable changes to Gondolin are documented here.

## Unreleased

- Switched egress `httpHooks` to WHATWG `Request`/`Response` types and added support for returning synthetic responses from `onRequestHead`/`onRequest` to short-circuit upstream fetches
- Added internal request/response conversion helpers and expanded HTTP hook/network test coverage (including undici compatibility and body-size guardrails)
- Updated networking/secrets docs to reflect the new hook API and short-circuit behavior

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

# Changelog

All notable changes to Gondolin are documented here.

## Unreleased

- Add bash fallback to `/bin/sh` for `gondolin bash` and `gondolin attach` when bash is unavailable
- Add VM registry and `gondolin attach`/`gondolin list` CLI commands to manage and connect to running VMs

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

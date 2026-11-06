# virtio-fs on macOS: getting a QEMU with vhost-user

**Recommendation: get the one-line QEMU fix upstream and a one-line Homebrew
formula change; don't ship our own QEMU.** Until those land, macOS users get
sandboxfs automatically, and anyone who wants virtio-fs now can build QEMU
themselves. Nothing has been sent upstream yet.

**Status (2026-11-06):** the native engine serves guest filesystems over
virtio-fs (`vhost-user-fs-pci`) whenever QEMU offers that device. Otherwise
it falls back to sandboxfs (see `native/docs/virtio-fs.md`). Linux
distribution QEMUs have the device; **Homebrew's QEMU on macOS does not**:

- QEMU's `meson.build` auto-disables vhost-user off Linux
  (`get_option('vhost_user').disable_auto_if(host_os != 'linux')`), and the
  Homebrew formula (`Formula/q/qemu.rb`, now 11.1.3) doesn't pass
  `--enable-vhost-user`.
- With `--enable-vhost-user`, the build fails in `hw/net/vhost_net.c`. That
  file includes `linux-headers/linux/vhost.h`, whose own includes only
  resolve on Linux. The bug is still there on QEMU master (11.1.50).

On macOS, virtio-fs is 2–4× faster for metadata and 10–15× faster for large
I/O than sandboxfs (`native/docs/virtio-fs.md`), so this decides whether
macOS users get the fast path.

## The QEMU fix

The ready-to-send patch is `native/docs/qemu-vhost-net-non-linux.patch`.
Fill in the sender and `Signed-off-by` (DCO) first.

- **Change.** Include the header only on Linux, and define
  `VHOST_FILE_UNBIND` (the one thing `vhost_net.c` uses from it, for the
  Linux-only tap backend) elsewhere.
- **Applies to:** 10.2.1 and master (`git apply --check` against master's
  file).
- **Verified (macOS 26 / arm64):**
  - Patched QEMU 10.2.1 builds with just
    `./configure --target-list=aarch64-softmmu --enable-vhost-user --disable-pvg`.
    vhost-net and vhost-user-crypto stay enabled; the earlier
    `--disable-vhost-net --disable-vhost-crypto` workaround is no longer
    needed.
  - It lists `vhost-user-fs-pci` and `memory-backend-shm`.
  - A gondolind VM with `GONDOLIN_VIRTIOFS=1` mounted `/data` and a
    `RealFSProvider` mount as `virtiofs`. Reads and writes went both ways.

To send it, use QEMU's normal process: `git send-email` to
qemu-devel@nongnu.org, Cc the vhost maintainers from `MAINTAINERS`
(`scripts/get_maintainer.pl`). It is a build fix and should be uncontroversial.

A possible follow-up upstream is to stop auto-disabling vhost-user on macOS
(`disable_auto_if(host_os != 'linux')` → `host_os not in ['linux', 'darwin']`).
Then every macOS build would get it without a configure flag. That needs more
discussion, since it changes defaults, so the formula change below doesn't
depend on it.

## Options

| | A: upstream fix + Homebrew formula | B: ship our own QEMU | C: status quo |
|---|---|---|---|
| What users do | `brew upgrade qemu` | `npm i` pulls `@earendil-works/gondolin-qemu-darwin-arm64` | nothing |
| virtio-fs on macOS | yes, once released | yes, immediately | no (sandboxfs) |
| Our cost | one patch and one formula line, then nothing | CI build per QEMU release; bundling glib/pixman/… dylibs with rewritten rpaths (as the krun runner does with libkrun); codesigning with the `com.apple.security.hypervisor` entitlement; tracking QEMU security fixes; GPL-2.0 source distribution for the binaries | none |
| Package size | none | ~40–80 MB per platform (qemu-system-aarch64 + firmware + dylibs) | none |
| Time to users | QEMU release (~4 months) or a Homebrew-carried patch (days to weeks after review) | next gondolin release | n/a |

**Homebrew formula change** (ready to propose, not sent). Homebrew prefers
patches that are already merged upstream. It accepts `patch do url … end`
pointing at the upstream commit once the fix is in a QEMU tree.

```ruby
    # vhost-user devices (vhost-user-fs-pci for virtio-fs, vhost-user-blk, …)
    # are auto-disabled on non-Linux hosts; they work on macOS with
    # memory-backend-shm.
    args << "--enable-vhost-user" if OS.mac?
```

### Why A over B

- **A costs almost nothing to maintain**, and every Homebrew user gets
  virtio-fs without trusting a second QEMU binary from us.
- **B makes us a QEMU distributor.** We would have to:
  - bundle dylibs and sign with the hypervisor entitlement;
  - ship security updates on QEMU's schedule;
  - meet GPL source obligations.

  That is worth it only if macOS filesystem performance becomes a top
  priority before A lands.
- **The fallback means A isn't urgent.** Until A lands, macOS users get
  sandboxfs (C) automatically.
- **Power users can self-build.**
  `native/crates/gondolin-virtiofs/examples/linux-guest/build-qemu-macos.sh`
  builds QEMU in about 5 minutes (apply the patch, or keep its
  `--disable-vhost-net` workaround). Point gondolin at it with
  `sandbox.qemuPath`.

If B becomes necessary, keep it minimal:
- `qemu-system-aarch64` only (aarch64-softmmu, no UI, no docs);
- built on `macos-15` in the Release workflow;
- packaged like `gondolin-krun-runner-darwin-arm64`, with the dylibs in
  `lib/` and `@loader_path` rpaths;
- an optional dependency that `sandbox.qemuPath` resolution prefers when it
  offers `vhost-user-fs-pci`.

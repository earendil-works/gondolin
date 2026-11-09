# Persistence and Snapshots

By default every VM starts from a clean copy of its image and its root disk
is thrown away on close. You can choose how the root disk behaves (read-only,
throwaway, copy-on-write), grow it, and capture it as a **disk checkpoint**
that new VMs resume from: install packages once, then start many VMs from that
state.

From the CLI:

```bash
# Snapshot a running session (stops the session)
gondolin snapshot <session-id>

# Resume a shell from the snapshot id it printed, or from a path
gondolin bash --resume <snapshot-id>
gondolin bash --resume /path/to/snapshot.qcow2
```

From the SDK:

```ts
import path from "node:path";
import { VM } from "@earendil-works/gondolin";

const base = await VM.create();
await base.exec("apk add git");

// stops and consumes `base`; the path must be absolute
const checkpoint = await base.checkpoint(path.resolve("./dev-base.qcow2"));

const task1 = await checkpoint.resume();
const task2 = await checkpoint.resume();
// both start from the same disk state and diverge independently
await task1.close();
await task2.close();
```

## What Persists

| Location | Backing | Survives VM close? | In disk checkpoints? |
|---|---|---|---|
| Most of `/` (root disk) | depends on [`rootfs.mode`](#root-disk-modes) | No | Yes (`cow`) |
| `/root`, `/tmp`, `/var/tmp`, `/var/cache`, `/var/log`, `/run` | [guest tmpfs](./vfs.md#guest-tmpfs-mounts) | No | No (unless moved to the root disk) |
| Your mounts (e.g. `/workspace`) | [your provider](./vfs.md) | Provider-dependent | No |

Data you want to keep should go to a mount backed by a host directory or your
own storage, or be copied out with [`vm.fs`](./vfs.md#accessing-files-from-the-host)
before closing. Checkpoints are for reusable environments (installed
packages, prepared toolchains), not for results; see
[Workloads and Lifecycle](./workloads.md) for how to structure workloads
around disposable VMs.

## Root Disk Modes

`rootfs.mode` controls how the root disk accepts writes:

| Mode | Behavior |
|---|---|
| `readonly` | the root disk is read-only (`EROFS` on writes) |
| `memory` | writable, thrown away on close; on `qemu` this uses QEMU's snapshot mode, on `krun` a temporary qcow2 overlay on disk (not RAM-backed), deleted on close |
| `cow` | writable qcow2 copy-on-write overlay (default); deleted on close and never written back into the image, but it can be [checkpointed](#disk-checkpoints) |

```ts
const vm = await VM.create({
  rootfs: { mode: "readonly" },
});
```

When `rootfs.mode` is not set, the image's `manifest.json` default
(`runtimeDefaults.rootfsMode`, set at [build time](./custom-images.md#runtime-defaults))
applies, else `cow`. The CLI always uses this default.

The Gondolin daemon prepares the root disk when the VM starts, with its own
qcow2 implementation (no `qemu-img` needed): it creates overlays in its
private session directory in the system temporary directory (`TMPDIR`, `/tmp`
on macOS) and deletes them when the VM closes. Make sure that directory has
room for what the guest writes. With a [remote daemon](./remote.md) the same
happens on the daemon's machine.

## Root Disk Size

The images' root disks have little free space. `rootfs.size` makes the root
disk at least that large without rebuilding the image (`bytes`, or a `K`, `M`,
`G` or `T` suffix):

```ts
const vm = await VM.create({
  rootfs: { size: "8G" },
});
```

```bash
gondolin bash --rootfs-size 8G
```

The daemon grows the writable disk before boot (it never shrinks it) and
Gondolin runs `resize2fs /dev/vda` in the guest before `VM.start()`
completes. The image itself is not modified. Combined with
`rootfs.mode: "memory"`, Gondolin uses a temporary qcow2 overlay instead of
QEMU's snapshot mode so the resize lasts for the VM's lifetime;
`rootfs.mode: "readonly"` cannot be resized.

The guest image must include `resize2fs` (Alpine package `e2fsprogs-extra`).
Current `alpine-base` images include it; custom images should add it to
`alpine.rootfsPackages` (see [Building Custom Images](./custom-images.md)).

## Disk Checkpoints

A checkpoint captures the VM's writable root disk in a single `.qcow2` file.
Resuming is cheap: each resumed VM gets its own temporary qcow2 overlay backed
by the checkpoint file, so one checkpoint can be resumed many times, in
parallel. Checkpoints work with both the `qemu` and `krun`
[backends](./backends.md).

The TypeScript API calls them **checkpoints** to avoid confusion with QEMU's
internal snapshot mode; the CLI calls them **snapshots**. They are the same
files: either side can resume what the other created, and so can the static
`gondolin` CLI.

### Creating a Checkpoint

`vm.checkpoint(path)` stops the VM and consumes it: the VM object cannot be
restarted afterwards (resume the checkpoint instead).

```ts
import path from "node:path";
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create();
await vm.exec("echo hello > /etc/snapshot-marker");

const checkpoint = await vm.checkpoint(path.resolve("./my-snapshot.qcow2"));
// `vm` is closed now and must not be used again
```

A VM that never started (for example with `autoStart: false`) is booted
first, since the daemon creates the root disk when the VM starts. A VM whose
guest has already stopped is not booted again: its disk is exported as it
is. Before stopping a running VM, Gondolin runs a best-effort `sync` in the
guest. A checkpoint needs a writable qcow2 root disk, so it fails for
`rootfs.mode: "readonly"`, for `rootfs.mode: "memory"` on `qemu` (unless
combined with `rootfs.size`) and for a raw or read-only
[own root disk](#using-your-own-root-disk); use `cow` (the default). It also
needs an image whose `manifest.json` has a `buildId` (see
[Images](./images.md#what-an-image-is)).

Checkpointing a VM that was itself resumed from a checkpoint writes a
standalone checkpoint backed directly by the image (the chain is collapsed),
so you can layer environments without accumulating dependencies between
checkpoint files. A VM resumed from a checkpoint without a backing file (a
standalone image) can be checkpointed again too; its disk is flattened into
a new standalone checkpoint.

The checkpoint file is replaced atomically: the disk is renamed into place,
or, across filesystems, copied to a temporary file next to the destination,
synced and then renamed. Writing a checkpoint onto the file the VM was
resumed from is therefore safe (for example `gondolin bash --resume X`
followed by `gondolin snapshot ... --output X`): the old checkpoint stays
intact until the new one is complete.

### Resuming a Checkpoint

`checkpoint.resume(options)` starts a new VM from the checkpoint and accepts
the usual `VM.create()` options. A checkpoint returned by `vm.checkpoint()`
reuses the options of the VM it was created from (mounts, hooks, ...), merged
with the ones you pass. `VmCheckpoint.load(path)` reads a checkpoint file from
disk; it starts with no options of its own:

```ts
import { VmCheckpoint, RealFSProvider } from "@earendil-works/gondolin";

const checkpoint = VmCheckpoint.load("/abs/path/my-snapshot.qcow2");

const vm = await checkpoint.resume({
  vfs: { mounts: { "/workspace": new RealFSProvider("/host/workspace") } },
});
await vm.exec("cat /etc/snapshot-marker");
await vm.close();

// delete the checkpoint file
checkpoint.delete();
```

A `VmCheckpoint` exposes `name`, `path`, `dir` and `guestAssetBuildId`, and
`toJSON()` returns its metadata.

### From the CLI

`gondolin snapshot SESSION_ID` checkpoints a running session (started with
`gondolin bash`, `gondolin exec` or any SDK VM, see `gondolin list`) and stops
it:

```bash
gondolin snapshot 9e3a2e2d                    # into the checkpoint directory
gondolin snapshot 9e3a2e2d --name dev-base    # ... as dev-base.qcow2
gondolin snapshot 9e3a2e2d --output ./my-snapshot.qcow2
```

Without `--output` the file goes to the checkpoint directory
(`~/.cache/gondolin/checkpoints`, or `GONDOLIN_CHECKPOINT_DIR`) under a random
id (or `--name`). The command prints the id and the matching resume command.
`gondolin bash --resume ID_OR_PATH` takes that id (an unambiguous prefix is
enough) or a path to any checkpoint file, plus the usual `bash` options
(mounts, network policy, ...). See the [CLI Reference](./cli.md#gondolin-snapshot).

### Checkpoint Format

The checkpoint is a qcow2 image with the metadata appended as a JSON trailer
(`[json][8-byte magic "GONDCPT1"][u64be json length]`; QEMU, `qemu-img` and
Gondolin's own qcow2 code ignore trailing bytes). The metadata records:

- `guestAssetBuildId`: the build id of the image the disk belongs to
- `createdWithVmm` and `compatibleVmm`: the backend that created it and the
  backends that may resume it
- `name`, `createdAt` and the schema `version`

### Backend Compatibility

Resume only uses a backend the checkpoint declares compatible. Checkpoints of
images with krun boot assets (`manifest.assets.krunKernel`, which every image
from `gondolin build` has) can be resumed on both `qemu` and `krun`; others
only on `qemu`. Without an explicit `sandbox.vmm` (or `GONDOLIN_VMM`), resume
picks QEMU when the checkpoint is not krun-compatible; an explicit
incompatible backend fails with an error naming the compatible ones.

## Portability and Guest Assets

A checkpoint is **not self-contained**: it is an overlay that needs the
_same image_ (kernel, initramfs, rootfs) to boot. Instead of absolute host
paths, it stores the image's build id, so checkpoints can be moved between
machines and directories.

On resume, Gondolin looks for an image with that build id, in order:

1. `GONDOLIN_GUEST_DIR` (if its manifest has the build id)
2. a development checkout's `guest/image/out`
3. the local image store (`~/.cache/gondolin/images/objects/<buildId>`)
4. the builtin image registry, when it lists that build id

If none matches, resume fails with the required build id and a hint (pull a
ref that points to that build id, e.g. with
`gondolin image inspect <build-id>`, or pass the image explicitly). To pass
it explicitly, set `sandbox.imagePath` to the image directory or another
[image selector](./images.md#selecting-an-image):

```ts
await checkpoint.resume({
  sandbox: { imagePath: "/path/to/guest/assets" },
});
```

If that image has a different build id, resume fails with an error showing
the required one.

### qcow2 Backing File Rebasing

qcow2 overlays embed the path of their backing file. When a checkpoint moves
to another machine (or the image moves), that path can become invalid. When a
resumed VM starts, the daemon compares the checkpoint's backing file name
and format with the resolved image's `rootfs.ext4` and, if either differs,
rewrites them in the checkpoint file (metadata only, like
`qemu-img rebase -u`). Moved checkpoints repair themselves the first time a
VM resumed from them starts; the VM then boots on a fresh overlay on top of
the checkpoint, so the checkpoint's contents are not modified.

Checkpoints created by earlier releases (with `qemu-img`) resume the same
way.

### Validation on Resume

A checkpoint's qcow2 header can name other files (a backing file, an
external data file) that the VM would open, so the daemon checks every
checkpoint before it boots from it and refuses it with
`cannot resume checkpoint ...` when:

- it uses an external data file, encryption, extended L2 entries, the
  corrupt flag, unknown qcow2 features or a repeated header extension
  (checked before anything is written, so a refused file is left unchanged)
- after the backing file is pointed at the image's rootfs, its backing chain
  is anything other than that rootfs (or nothing, for a standalone
  checkpoint)
- its backing file is itself (`checkpoint is corrupt`)

Checkpoints written by Gondolin always pass. See
[Security Design](./security.md#root-disks-and-checkpoints) for the full list
of checks, which also apply to your own root disks.

### Remote Daemons

With a [remote daemon](./remote.md), `vm.checkpoint(path)` still writes the
checkpoint on your machine, in the same format: the daemon stops the VM and
streams the disk overlay. `resume()` uploads the checkpoint to the daemon,
which resolves the image by build id on its own machine (or by
`native.image` / a string `sandbox.imagePath`). The backing path is rewritten
and validated in the uploaded copy, never in your file.

## Using Your Own Root Disk

For full control, `sandbox.rootDiskPath` attaches a disk image you manage as
the root disk (`/dev/vda`) instead of an overlay Gondolin creates;
`rootfs.mode` is then ignored:

| Option | Meaning |
|---|---|
| `sandbox.rootDiskPath` | disk image to attach |
| `sandbox.rootDiskFormat` | `"raw"` or `"qcow2"` (default: from the file extension) |
| `sandbox.rootDiskReadOnly` | attach read-only |
| `sandbox.rootDiskDeleteOnClose` | delete the file when the VM closes (default `false`) |

The disk must hold a root filesystem the image's kernel and init can boot,
typically a qcow2 overlay backed by the image's `rootfs.ext4`. Gondolin does
not delete it unless asked, so writes persist across runs. These options are
not supported with remote daemons.

The disk and every file in its backing chain must exist and be regular
files when the VM starts. The exception is a block device attached raw
(`rootDiskFormat: "raw"`): Gondolin never resizes it (`rootfs.size` fails
unless the device is already large enough) and it cannot be checkpointed. A
qcow2 disk is validated like a checkpoint (see
[Security Design](./security.md#root-disks-and-checkpoints)): no external
data files, encryption, extended L2 entries, corrupt flag, unknown features
or repeated header extensions, and every backing file must be named by a
plain path with a recorded `raw` or `qcow2` format. A disk whose backing file has no recorded
format is refused; set it with
`qemu-img rebase -u -F raw -b BACKING DISK` (or `-F qcow2`).

With `rootfs.size` the daemon grows this disk in place; it refuses to modify
images that are dirty, marked corrupt or contain internal snapshots.
Checkpointing a VM on its own qcow2 disk moves that disk into the checkpoint
file, collapsed onto the raw file at the bottom of its chain or flattened
into a standalone image; collapsing fails on compressed clusters. Disks
created with `qemu-img create` (qcow2 versions 2 and 3) are fine.

## Gotchas

- **Disk only.** No RAM or process state is captured; resuming boots fresh
  from the captured disk state (see [Limitations](./limitations.md)).
- **Root disk only.** Mounts and tmpfs paths (`/root`, `/tmp`, `/var/log`,
  ...) are not captured. Use the [`tmpfs` option](./vfs.md#guest-tmpfs-mounts)
  to keep those paths on the root disk when they matter.
- **The VM is stopped.** `vm.checkpoint()` closes the VM; the best-effort
  `sync` does not give the guarantees of a full VM save/restore.
- **The trailer is fragile.** Tools that rewrite the image (`qemu-img
  convert`, ...) drop the trailing metadata, after which
  `VmCheckpoint.load()` fails. Copy checkpoint files as plain files.
- **Resume can modify the file.** Rewriting the backing file name updates
  the checkpoint file's header in place when a resumed VM starts (a local
  daemon only); copy a checkpoint yourself first if you need it immutable.
- **Checkpoints go stale.** Updating your images does not update old
  checkpoints, and a checkpoint is useless once its image is gone (for
  example after `gondolin image rm`). Prefer rebuilding environments from
  scripts or [custom images](./custom-images.md) over long-lived
  checkpoints.

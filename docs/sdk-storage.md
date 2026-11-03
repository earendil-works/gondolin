# SDK: Storage Snapshots

See also: [SDK Overview](./sdk.md), [VFS Providers](./vfs.md), [Custom Images](./custom-images.md), [Snapshots](./snapshots.md)

## VFS Providers

Gondolin can mount host-backed paths into the guest via programmable VFS
providers.

See [VFS Providers](./vfs.md) for the full provider reference and common
recipes (blocking `/.env`, hiding `node_modules`, read-only mounts, hooks, and
more).

Minimal example:

```ts
import { VM, RealFSProvider, MemoryProvider } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: {
      "/workspace": new RealFSProvider("/host/workspace"),
      "/scratch": new MemoryProvider(),
    },
  },
});
```

## Extra Disks

`sandbox.extraDisks` attaches additional disk images after the root disk. They
appear in the guest as `/dev/vdb`, `/dev/vdc`, ... in the order given. A disk
with a `mountPath` is mounted there by the guest `/init` during boot, before
the first command runs. `createDiskImage()` builds an ext4 image from a host
directory:

```ts
import { VM, createDiskImage } from "@earendil-works/gondolin";

const disk = await createDiskImage({
  sourceDir: "./toolchain",
  outputPath: "/var/cache/toolchain.ext4",
});

const vm = await VM.create({
  sandbox: {
    extraDisks: [{ path: disk.path, mountPath: "/opt/toolchain" }],
  },
});
```

`createDiskImage()` (and `gondolin disk create <dir> <out>`) gives every file
in the image to root, whoever owns it on the host, sizes the image to the
contents with a little headroom unless `size` is given (e.g. `"2G"`), and
writes it atomically, replacing an existing file only once the new image is
complete. It needs e2fsprogs on the host (see
[Build Requirements](./custom-images.md#build-requirements)). The image has no
journal unless `allowWrite: true` is given: a read-only mount never uses one,
but a writable disk needs it to survive a VM stopped mid-write, so a raw ext
image without one is refused with `readOnly: false`. An `auto` size leaves
little free space, so give a writable disk a `size`.

Disks are attached read-only unless `readOnly: false` is set, and a read-only
disk is mounted read-only (ext4 with `noload`, so a dirty journal is never
replayed). Nothing writes a read-only disk, so one image can be attached by any
number of concurrently running VMs. This suits a large toolchain or dataset
built once on the host and mounted in every VM, which reads at block-device
speed rather than through the VFS.

A writable disk must only be attached to one running VM at a time, as two
writers corrupt the filesystem. qemu's image locking refuses a second writer on
Linux, but it relies on open file description locks, so on macOS nothing stops
one.

If a disk cannot be mounted (no filesystem the guest kernel recognises, or a
mount point that cannot be created), `vm.start()` fails with the reason. A
`mountPath` must be absolute, may not be `/` or under `/proc`, `/sys`, `/dev`
or `/run`, and may not overlap a VFS mount or sit on or above a tmpfs mount;
it may sit below a tmpfs mount. Mounting requires a guest image built with
this Gondolin version or newer; with an older image `vm.start()` fails
reporting the disk as not mounted.

| field       | default                                         | notes                                                       |
| ----------- | ----------------------------------------------- | ----------------------------------------------------------- |
| `path`      | required                                        | host disk image                                             |
| `format`    | `qcow2` for `.qcow2`/`.qcow` paths, else `raw`  |                                                             |
| `readOnly`  | `true`                                          |                                                             |
| `mountPath` | none                                            | absolute guest path the disk is mounted at during boot      |
| `serial`    | none, or `gondolin-disk<index>` with `mountPath` | 1-20 characters from `[A-Za-z0-9._-]`, unique               |

A disk without a `mountPath` is left for the guest to mount. Give it a `serial`
and find it in `/sys/block/vd*/serial` (the guest image has no udev, so there
is no `/dev/disk/by-id`):

```sh
for s in /sys/block/vd*/serial; do [ "$(cat $s)" = toolchain ] && dev=/dev/$(basename $(dirname $s)); done
mount -o ro "$dev" /opt/toolchain
```

The option is qemu only; `vmm=krun` rejects it.

## Image Management

Guest images (kernel, initramfs, rootfs, and optional krun boot artifacts) are
resolved automatically from local overrides/store first, then from
`builtin-image-registry.json` when needed.
The default cache location is `~/.cache/gondolin/images/`.

Override image selection / source:

```bash
# Use explicit local assets
export GONDOLIN_GUEST_DIR=/path/to/assets

# Change default image selector
export GONDOLIN_DEFAULT_IMAGE=alpine-base:1.0

# Override builtin registry URL
export GONDOLIN_IMAGE_REGISTRY_URL=https://example.invalid/my-registry.json
```

Build-id selectors (`uuid`) are resolved locally first and only downloaded from
the builtin registry when that registry has an explicit `builds[buildId]`
mapping.

Builtin registry entries are normalized: `refs[name:tag][arch]` stores a build
id, and `builds[buildId]` stores the downloadable source metadata (`url`,
optional `sha256`, optional `arch`).

Check asset status programmatically:

```ts
import {
  hasGuestAssets,
  ensureGuestAssets,
  getAssetDirectory,
} from "@earendil-works/gondolin";

console.log("Assets available:", hasGuestAssets());
console.log("Asset directory:", getAssetDirectory());

// Download if needed
const assets = await ensureGuestAssets();
console.log("Kernel:", assets.kernelPath);
```

To build custom images, see: [Building Custom Images](./custom-images.md).

Use custom assets programmatically by pointing `sandbox.imagePath` at the
asset directory:

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  sandbox: {
    imagePath: "./my-assets",
  },
});

const result = await vm.exec("uname -a");
console.log("exitCode:", result.exitCode);
console.log("stdout:\n", result.stdout);
console.log("stderr:\n", result.stderr);

await vm.close();
```

## Rootfs Modes

You can control rootfs write behavior per VM:

- `readonly`: rootfs is read-only (`EROFS` on writes)
- `memory`: writable throwaway rootfs
    - on `qemu`, this uses backend-native snapshot mode
    - on `krun`, this is **not RAM-backed**; Gondolin creates a temporary qcow2 overlay on disk and deletes it on close
- `cow`: writable qcow2 copy-on-write overlay (default)
    - this does **not** write back into the original rootfs image
    - by default it is a throwaway qcow2 overlay file that is deleted on close
    - because it is a real qcow2 layer, it can be checkpointed

```ts
const vm = await VM.create({
  rootfs: { mode: "readonly" },
});
```

If the guest asset `manifest.json` contains `runtimeDefaults.rootfsMode`, that
value is used as the default when `rootfs.mode` is not provided.

## Runtime Rootfs Size

Use `rootfs.size` to ensure the effective root disk has at least the requested
size without rebuilding the base image:

```ts
const vm = await VM.create({
  rootfs: { size: "2G" },
});
```

Gondolin grows the writable root disk image on the host with `qemu-img resize`
(no shrinking) and then runs `resize2fs /dev/vda` in the guest before
`VM.start()` completes.
The base rootfs image is not modified when using the default `cow` mode. When
combined with `rootfs.mode="memory"`, Gondolin uses a temporary qcow2 overlay so
the guest-side filesystem resize survives for the lifetime of that VM.

The guest image must include `resize2fs` (Alpine package: `e2fsprogs-extra`). Newer
`alpine-base` images include it; custom images should add it to
`alpine.rootfsPackages` when using `rootfs.size`.

## Scratch tmpfs Mounts

By default the guest `/init` mounts tmpfs over `/root` (mode `0700`), `/tmp`,
`/var/tmp`, `/var/cache` and `/var/log`.  Those paths live in guest RAM (each
capped by the kernel at half the VM memory) and are not part of disk
checkpoints.

Use the `tmpfs` option to replace that set.  Each key is a guest path; `size`
(bytes, `k`/`m`/`g` suffix or a percentage of guest memory) and `mode` (octal
string) are optional:

```ts
const vm = await VM.create({
  // only /tmp is RAM-backed and capped; everything else stays on the root disk
  tmpfs: { "/tmp": { size: "256m" } },
  rootfs: { size: "8G" },
});
```

Pass `tmpfs: {}` to disable all scratch tmpfs mounts.  The paths are then
backed by the root disk, which is useful for cache-heavy workloads with little
VM memory, and their contents become part of disk checkpoints.  Combine it with
`rootfs.size` since the default root disk has little free space.  With
`rootfs.mode="readonly"` the root disk is not writable, so keep tmpfs mounts for
every path the workload writes to.
`DEFAULT_GUEST_TMPFS` exports the built-in set for extending it.

The setting is passed to `/init` on the kernel command line and requires a
guest image built with this Gondolin version or newer; older images ignore it
and always mount the built-in set.

## Disk Checkpoints (qcow2)

Gondolin supports **disk-only checkpoints** of the VM root filesystem.

A checkpoint captures the VM's writable disk state and can be resumed cheaply
using qcow2 backing files.

> **Backend support:** checkpoints work with both `qemu` and `krun`.
> Resume enforces checkpoint backend-compatibility metadata.
> See [VM Backends (QEMU vs krun)](./backends.md).

See also: [Snapshots](./snapshots.md).

```ts
import path from "node:path";

import { VM } from "@earendil-works/gondolin";

const base = await VM.create();

// Install packages / write to the root filesystem...
await base.exec("apk add git");
await base.exec("echo hello > /etc/my-base-marker");

// Note: must be an absolute path
const checkpointPath = path.resolve("./dev-base.qcow2");
const checkpoint = await base.checkpoint(checkpointPath);

const task1 = await checkpoint.resume();
const task2 = await checkpoint.resume();

// Both VMs start from the same disk state and diverge independently
await task1.close();
await task2.close();

checkpoint.delete();
```

Notes:

- This is **disk-only** (no in-VM RAM/process restore)
- The checkpoint is a single `.qcow2` file; metadata is stored as a JSON trailer
  (reload with `VmCheckpoint.load(checkpointPath)`)
- Checkpoints require guest assets with a `manifest.json` that includes a
  deterministic `buildId` (older assets without `buildId` cannot be snapshotted)
- QEMU `rootfs.mode="memory"` uses backend snapshot mode and is not checkpointable
  unless combined with `rootfs.size`; use `rootfs.mode="cow"` when you need a
  writable qcow2 layer explicitly
- Cross-backend resume (`qemu` ↔ `krun`) requires guest assets with krun boot
  artifacts (`manifest.assets.krunKernel`)
- Some guest paths are tmpfs-backed by default (eg. `/root`, `/tmp`, `/var/log`); writes under those paths are not part of disk checkpoints (see [Scratch tmpfs Mounts](#scratch-tmpfs-mounts))

## Debug Logging

See [Debug Logging](./debug.md).

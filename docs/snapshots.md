# Snapshots

Gondolin supports **disk-only snapshots** of a VM's root disk.

In the TypeScript API these are called **checkpoints** to avoid confusion with
QEMU's internal snapshot mode.

A snapshot is stored as a single `.qcow2` file. The checkpoint metadata is
stored as a JSON trailer appended to the end of the qcow2 file.

## Creating a Snapshot

Creating a snapshot stops the VM and consumes it. After calling
`vm.checkpoint(...)` the VM cannot be restarted.

```ts
import path from "node:path";

import { VM } from "@earendil-works/gondolin";

const vm = await VM.create();

// Make changes to the root filesystem...
await vm.exec("echo hello > /etc/snapshot-marker");

const snapshotPath = path.resolve("./my-snapshot.qcow2");
const checkpoint = await vm.checkpoint(snapshotPath);

// The original VM is closed by checkpoint() and must not be used again.
```

## Resuming a Snapshot

A snapshot can be resumed into a new VM using `checkpoint.resume()` and it can
be loaded with `VmCheckpoint.load(...)`. It can be resumed multiple times.

Resuming is cheap: the new VM uses a temporary qcow2 overlay backed by the
snapshot qcow2 file.

```ts
import { VmCheckpoint } from "@earendil-works/gondolin";

const checkpoint = VmCheckpoint.load(snapshotPath);

const task1 = await checkpoint.resume();
const task2 = await checkpoint.resume();

await task1.exec("cat /etc/snapshot-marker");
await task1.close();
await task2.close();
```

To delete a snapshot file:

```ts
checkpoint.delete();
```

## Portability and Guest Assets

Snapshots are **not self-contained**: a checkpoint qcow2 file is an overlay that
still needs the *same guest assets* (kernel/initramfs/rootfs) to boot.

To make checkpoints portable across machines and filesystem layouts, checkpoint
metadata does not store absolute host paths to the guest assets. Instead,
checkpoints store a *build id* (`guestAssetBuildId`) from the guest asset
`manifest.json` (`buildId`, derived from checksums).

If your guest assets do not have a `manifest.json` with a `buildId`, Gondolin
does not support creating/resuming checkpoints with those assets.

On resume, Gondolin will try to locate matching guest assets by build id. If it
cannot find them automatically, you must provide the asset directory explicitly.

### Providing The Asset Directory Explicitly

Pass `sandbox.imagePath` to the guest asset directory (the directory containing
`vmlinuz-virt`, `initramfs.cpio.lz4`, `rootfs.ext4`, and `manifest.json`):

```ts
await checkpoint.resume({
  sandbox: {
    imagePath: "/path/to/guest/assets",
  },
});
```

If the provided assets do not match the checkpoint's build id, resume fails with
an error explaining the required build id.

### Automatic Resolution

If you do not pass `sandbox.imagePath`, resume will try (in order):

1. `GONDOLIN_GUEST_DIR` (if set)
2. Local development checkout (`guest/image/out`)
3. The default asset directory (download cache used by `VM.create()`)
4. A best-effort scan under `~/.cache/gondolin/**` for a matching `manifest.json`

If resolution still fails, the error includes the required build id and a
remediation: pass `sandbox.imagePath`.

## qcow2 Backing File Rebasing

qcow2 overlays embed the backing filename in the image metadata.  When you move
a checkpoint across machines (or even just move the rootfs), the backing path
can become invalid.

To fix this, checkpoint resume performs an **in-place rebase** when needed:

- It inspects the checkpoint qcow2 backing filename (`qemu-img info`)
- If it does not match the resolved `rootfs.ext4` path, it rebases the checkpoint
  (`qemu-img rebase -u ...`) so the checkpoint becomes usable in its new layout

This makes moved checkpoints "repair themselves" the first time you resume them.

## Shortcomings and Gotchas

This snapshot support is intentionally narrow and has a number of limitations:

- Disk-only snapshots

  - No RAM or process state is captured
  - Resuming starts a fresh boot from the captured disk state

- Root disk only

  - Only the VM root disk is captured
  - VFS mounts and tmpfs-backed paths are not part of the snapshot

- Some paths are tmpfs-backed by design

  - For example: `/root`, `/tmp`, `/var/log`
  - Writes under those paths are not included in disk snapshots

- The VM is stopped to create a snapshot

  - `vm.checkpoint(...)` closes the VM and the original VM object must not be
    used after it returns
  - The implementation uses a best-effort `sync` before shutdown, but does not
    provide the same guarantees as full VM save/restore

- Trailing metadata can be lost

  - The metadata lives in trailing bytes at the end of the `.qcow2` file
  - Tools like `qemu-img convert` typically rewrite the image and drop the
    trailer, which will prevent `VmCheckpoint.load(...)` from working

- Rebase is a mutation

  - Resume may modify the checkpoint file in-place to update its backing path
  - If you want immutable checkpoints, treat checkpoint files as read-write and
    copy them yourself before resuming

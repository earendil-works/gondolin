# Snapshots

Gondolin supports disk-only snapshots of a VM's root disk.

In the TypeScript API these are called "checkpoints" to avoid confusion with
QEMU's internal snapshot mode.

A snapshot is stored as a single `.qcow2` file.  The checkpoint metadata is
stored as a JSON trailer appended to the end of the qcow2 file.

## Creating a snapshot

Creating a snapshot stops the VM and consumes it.  After calling
`vm.checkpoint(...)` the VM cannot be restarted.  To snapshot the VM
you pass a filename to where the snapshot should be stored as a file:

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

## Resuming a snapshot

A snapshot can be resumed into a new VM using `checkpoint.resume()` and it can
be loaded with `VmCheckpoint.load(...)`.  It can be resume multiple times.

Resuming is cheap: the new VM uses a temporary qcow2 overlay backed by the
snapshot qcow2 file.

```ts
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

## Shortcomings And Gotchas

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
  - The implementation uses a best effort `sync` before shutdown, but does not
    provide the same guarantees as full VM save/restore

- Trailing metadata can be lost

  - The metadata lives in trailing bytes at the end of the `.qcow2` file
  - Tools like `qemu-img convert` typically rewrite the image and drop the
    trailer, which will prevent `VmCheckpoint.load(...)` from working

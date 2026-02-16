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

## Image Management

Guest images (kernel, initramfs, rootfs) are automatically downloaded from
GitHub releases on first use. The default cache location is `~/.cache/gondolin/`.

Override the cache location:

```bash
export GONDOLIN_GUEST_DIR=/path/to/assets
```

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

## Disk Checkpoints (qcow2)

Gondolin supports **disk-only checkpoints** of the VM root filesystem.

A checkpoint captures the VM's writable disk state and can be resumed cheaply
using qcow2 backing files.

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
- Some guest paths are tmpfs-backed by design (eg. `/root`, `/tmp`, `/var/log`); writes under those paths are not part of disk checkpoints

## Debug Logging

See [Debug Logging](./debug.md).

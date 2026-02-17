# SDK

This section documents the programmatic API in `@earendil-works/gondolin`.

To keep this easier to navigate, the SDK docs are split into focused guides:

- [VM Lifecycle & Command Execution](./sdk-vm.md)
- [Networking, Ingress, and SSH](./sdk-network.md)
- [Filesystem, Guest Assets, and Snapshots](./sdk-storage.md)

## Quick Start

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create();

// String form runs via `/bin/sh -lc "..."`
const result = await vm.exec("curl -sS -f https://example.com/");

console.log("exitCode:", result.exitCode);
console.log("stdout:\n", result.stdout);
console.log("stderr:\n", result.stderr);

await vm.close();
```

## Typical SDK Flow

1. Create a VM with `VM.create(...)`
2. Run commands via `vm.exec(...)` or open an interactive shell
3. Configure optional policy/hooks (network, ingress, SSH, VFS)
4. Close the VM with `vm.close()`

## Related Docs

- [CLI](./cli.md)
- [Secrets Handling](./secrets.md)
- [Ingress](./ingress.md)
- [SSH](./ssh.md)
- [VFS Providers](./vfs.md)
- [Snapshots](./snapshots.md)

## VM Lifecycle & Command Execution

Moved to [SDK: VM Lifecycle & Command Execution](./sdk-vm.md).

## Network Policy

Moved to [SDK: Networking, Ingress, and SSH](./sdk-network.md).

## VFS Providers

Moved to [SDK: Filesystem, Guest Assets, and Snapshots](./sdk-storage.md).

## Image Management

Moved to [SDK: Filesystem, Guest Assets, and Snapshots](./sdk-storage.md).

## Disk checkpoints (qcow2)

Moved to [SDK: Filesystem, Guest Assets, and Snapshots](./sdk-storage.md).

## Debug Logging

See [Debug Logging](./debug.md).

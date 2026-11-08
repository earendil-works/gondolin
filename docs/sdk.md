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

## Engine

VMs run on the [native engine](./native.md): the `gondolind` daemon, from the
installed `@earendil-works/gondolin-native-*` package, a source checkout's
build, or `GONDOLIN_NATIVE_BIN`. Without a binary, starting a VM fails. The
in-process node engine was removed; `engine: "node"` (or
`GONDOLIN_ENGINE=node`) throws, `engine: "native"` and `"auto"` are accepted
for compatibility. See
[Migrating from the node engine](./native.md#migrating-from-the-node-engine).

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
- [Native Engine](./native.md)



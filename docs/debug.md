# Debug Logging

Gondolin's host has several debug channels that can be enabled independently.
Debug output is routed through a callback so you can capture it in your own
code.

## Enabling Debug Modes

There are two ways to control debugging.

### Environment Variable

Set `GONDOLIN_DEBUG` to a comma-separated list of flags:

- `net`: networking stack / HTTP bridge
- `exec`: exec + stdin/pty control messages
- `vfs`: VFS (FUSE/RPC) operations
- `protocol`: virtio/control-protocol traffic and QEMU log forwarding
- `all`: turns on everything

Examples:

```bash
# Network + exec
export GONDOLIN_DEBUG=net,exec

# Everything
export GONDOLIN_DEBUG=all
```

### Programmatic (per-VM)

Debug flags are also available on `sandbox.debug`:

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  sandbox: {
    // Enable only selected components
    debug: ["net", "exec"],

    // Or:
    // debug: true,  // enable everything
    // debug: false, // disable everything
  },
});
```

## Intercepting Debug Output

When any debug mode is enabled, the VM will emit debug messages to a callback:

- By default it logs to `console.log` as `[component] message`
- You can override it with `debugLog`
- You can disable debug printing entirely by passing `debugLog: null`

```ts
import { VM, type DebugComponent } from "@earendil-works/gondolin";

const logs: Array<{ component: DebugComponent; message: string }> = [];

const vm = await VM.create({
  sandbox: { debug: ["net", "vfs"] },
  debugLog(component, message) {
    logs.push({ component, message });
  },
});

await vm.start();

const result = await vm.exec("echo hello");
console.log("exitCode:", result.exitCode);
console.log("stdout:\n", result.stdout);
console.log("stderr:\n", result.stderr);

await vm.close();
```

You can also change the callback after construction:

```ts
vm.setDebugLog((component, message) => {
  // route into your own logger
});
```

### Notes

- `exec` debug logs only include environment *keys* (not values) to reduce accidental secret leakage.
- Debug messages are best-effort: if your callback throws, Gondolin will ignore the error.

# TypeScript SDK

This section contains the more detailed, programmatic documentation for the
`@earendil-works/gondolin` TypeScript SDK (VM lifecycle, network policy, VFS,
asset management, and development notes).

The most basic example involves spawning a VM and executing commands:

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
## VM Lifecycle & Command Execution

When working with the SDK you always need to create a VM object and destroy it.  If
you don't, then the QEMU instance hangs around.

### Creating, Starting, and Closing

Most code should use the async factory, which also ensures guest assets are
available:

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  // set autoStart: false if you want to configure things before boot
  // autoStart: false,
});

// Optional: explicit start (VM.create defaults to autoStart: true)
await vm.start();

// ...use the VM...
await vm.close();
```

### `vm.exec()`

This is the most common of operations.  it returns an `ExecProcess` (a running
command handle) which is both:

- **Promise-like**: `await vm.exec(...)` yields an `ExecResult`
- **Stream-like**: when stdout/stderr are configured as `"pipe"`, it is an `AsyncIterable` for stdout and exposes `stdout`/`stderr` streams

There are two forms:

- `vm.exec("...")` (string): runs the command via a login shell, equivalent to:
  `vm.exec(["/bin/sh", "-lc", "..."])`
- `vm.exec([cmd, ...argv])` (array): executes an executable directly. **It does not search `$PATH`**, so `cmd` must be an **absolute path**.

If you want shell features (pipelines, `$VARS`, globbing, `$(...)`, etc.), use the string form (or call `/bin/sh` explicitly):

```ts
const result = await vm.exec("echo $HOME | wc -c");
console.log("exitCode:", result.exitCode);
console.log("stdout:\n", result.stdout);
console.log("stderr:\n", result.stderr);
```

Buffered usage (most common):

```ts
const result = await vm.exec("echo hello; echo err >&2; exit 7");

console.log("exitCode:", result.exitCode); // 7
console.log("ok:", result.ok);             // false
console.log("stdout:\n", result.stdout);  // "hello\n"
console.log("stderr:\n", result.stderr);  // "err\n"
```

#### What Is in `ExecResult`

An `ExecResult` is **always returned**, even on non-zero exit codes (non-zero
exit codes do *not* throw).  You typically check:

- `result.exitCode: number`: process exit code
- `result.signal?: number`: termination signal (if the guest reports one)
- `result.ok: boolean`: shorthand for `exitCode === 0`
- `result.stdout: string` / `result.stderr: string`: decoded using `options.encoding` (default: `utf-8`)
- `result.stdoutBuffer: Buffer` / `result.stderrBuffer: Buffer`: for binary output
- helpers: `result.json<T>()`, `result.lines()`

#### Streaming Output

You can stream output while the command runs:

```ts
const proc = vm.exec("for i in 1 2 3; do echo $i; sleep 1; done", { stdout: "pipe" });

for await (const chunk of proc) {
  // default async iteration yields stdout chunks as strings
  process.stdout.write(chunk);
}

const result = await proc;
console.log(result.exitCode);
```

Important detail: streaming output requires `stdout: "pipe"` (and `stderr: "pipe"` if you
want stderr).

When using `pipe`, Gondolin does **not** buffer stdout/stderr into the final
`ExecResult` (use the default buffered mode if you want captured output).

Backpressure: in streaming modes (`stdout: "pipe"` / `stderr: "pipe"` or a writable),
Gondolin uses a host↔guest credit window to keep buffered output bounded.
You can tune the window size with `windowBytes` (default: 256 KiB).

If you need both streaming *and* to keep a copy of output, capture it yourself
from the piped streams:

```ts
const proc = vm.exec(["/bin/echo", "hello"], { stdout: "pipe" });
let stdout = "";
proc.stdout!.on("data", (b) => (stdout += b.toString("utf-8")));

await proc;
console.log(stdout);
```

To stream both stdout and stderr with labels, use `proc.output()`:

```ts
for await (const { stream, text } of vm.exec("echo out; echo err >&2", { stdout: "pipe", stderr: "pipe" }).output()) {
  process.stdout.write(`[${stream}] ${text}`);
}
```

#### Avoiding Large Buffers

For commands that may produce a lot of output, set `buffer: false` (drops stdout/stderr):

```ts
const result = await vm.exec(["/bin/cat", "/some/huge/file"], { buffer: false });
console.log("exitCode:", result.exitCode);

// Or stream it with backpressure:
// const proc = vm.exec(["/bin/cat", "/some/huge/file"], { stdout: "pipe", buffer: false });
// for await (const chunk of proc) process.stdout.write(chunk);
```

You can still stream output by using `stdout: "pipe"` / `stderr: "pipe"`.
The resulting `ExecResult` will not include buffered stdout/stderr.

#### Cancellation

`ExecOptions.signal` can be used to stop waiting for a command:

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 1000);

try {
  const result = await vm.exec(["/bin/sleep", "10"], { signal: ac.signal });
  console.log("exitCode:", result.exitCode);
} catch (err) {
  // aborting rejects with "exec aborted"
  console.error(String(err));
}
```

Note: aborting currently rejects the local promise; it does not (yet) guarantee
that the guest process is terminated.

### `vm.shell()`

`vm.shell()` is a convenience wrapper around `vm.exec()` for interactive
sessions (PTY + stdin enabled), optionally attaching to the current terminal.

### `vm.enableSsh()`

For workflows that prefer SSH tooling (scp/rsync/ssh port forwards), you can
start an `sshd` inside the guest and expose it via a host-local TCP forwarder:

```ts
const access = await vm.enableSsh();
console.log(access.command); // ready-to-run ssh command

// ...
await access.close();
```

See also: [SSH access](./ssh.md).

## Network Policy

The network stack only allows HTTP and TLS traffic. TCP flows are classified and
non-HTTP traffic is dropped. Requests are intercepted and replayed via `fetch`
on the host side, enabling:

- Host allowlists with wildcard support
- Request/response hooks for logging and modification
- Secret injection without exposing credentials to the guest
- DNS rebinding protection

```ts
import { createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.example.com", "*.github.com"],
  secrets: {
    API_KEY: { hosts: ["api.example.com"], value: process.env.API_KEY! },
  },
  blockInternalRanges: true, // default: true
  onRequest: async (req) => {
    console.log(req.url);
    return req;
  },
  onResponse: async (req, res) => {
    console.log(res.status);
    return res;
  },
});
```

Notable consequences:

- ICMP echo requests in the guest "work", but are synthetic (you can ping any address).
- HTTP redirects are resolved on the host and hidden from the guest (the guest only
  sees the final response), so redirects cannot escape the allowlist.
- DNS is available in multiple modes:

    - `synthetic` (default): no upstream DNS, returns synthetic answers
    - `trusted`: forwards queries only to trusted host resolvers (prevents using
      UDP/53 as arbitrary UDP transport to arbitrary destination IPs)

      - Note: trusted upstream resolvers are currently **IPv4-only**; if none are configured/found, VM creation fails.

    - `open`: forwards UDP/53 to the destination IP the guest targeted

- Even though the guest does DNS resolutions, they're largely disregarded for
  policy; the host enforces policy against the HTTP `Host` header and does its own
  resolution to prevent DNS rebinding attacks.

For deeper conceptual background, see [Network stack](./network.md).

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

To build custom image see the documentation is here: [Building Custom Images](./custom-images.md).

## Disk checkpoints (qcow2)

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
- Some guest paths are tmpfs-backed by design (eg. `/root`, `/tmp`, `/var/log`);
  writes under those paths are not part of disk checkpoints

Use the custom assets programmatically by pointing `sandbox.imagePath` at the
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

## Debug Logging

See [Debug Logging](./debug.md).

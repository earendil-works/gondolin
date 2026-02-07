# JavaScript SDK

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

// …use the VM…
await vm.close();
```

### `vm.exec()`

This is the most common of operations.  it returns an `ExecProcess` (a running
command handle) which is both:

- **Promise-like**: `await vm.exec(...)` yields an `ExecResult`
- **Stream-like**: it is an `AsyncIterable` for stdout, and exposes `stdout`/`stderr` streams

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
const proc = vm.exec("for i in 1 2 3; do echo $i; sleep 1; done");

for await (const chunk of proc) {
  // default async iteration yields stdout chunks as strings
  process.stdout.write(chunk);
}

const result = await proc;
console.log(result.exitCode);
```

Important detail: when you start streaming via `for await (const … of proc)` (or
`proc.lines()` / `proc.output()`), Gondolin disables stdout/stderr buffering for
that exec session to avoid unbounded memory growth.  That means the final
`ExecResult.stdout` / `stderr` will typically be **empty** in streaming mode.

If you need both streaming *and* to keep a copy of output, capture it yourself
from the streams:

```ts
const proc = vm.exec(["/bin/echo", "hello"]);
let stdout = "";
proc.stdout.on("data", (b) => (stdout += b.toString("utf-8")));

await proc;
console.log(stdout);
```

To stream both stdout and stderr with labels, use `proc.output()`:

```ts
for await (const { stream, text } of vm.exec("echo out; echo err >&2").output()) {
  process.stdout.write(`[${stream}] ${text}`);
}
```

#### Avoiding Large Buffers

For commands that may produce a lot of output, set `buffer: false`:

```ts
const result = await vm.exec(["/bin/cat", "/some/huge/file"], { buffer: false });
console.log("exitCode:", result.exitCode);
```

You can still stream output, but the resulting `ExecResult` will not include
buffered stdout/stderr.

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
- Even though the guest does DNS resolutions, they're largely disregarded for
  policy; the host enforces policy against the HTTP `Host` header and does its own
  resolution to prevent DNS rebinding attacks.

For deeper conceptual background, see [Network stack](./network.md).

## VFS Providers

The VM exposes hookable VFS mounts:

```ts
import {
  VM,
  MemoryProvider,
  RealFSProvider,
  ReadonlyProvider,
} from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: {
      "/": new MemoryProvider(),
      "/data": new RealFSProvider("/host/data"),
      "/config": new ReadonlyProvider(new RealFSProvider("/host/config")),
    },
    hooks: {
      before: (ctx) => console.log("before", ctx.op, ctx.path),
      after: (ctx) => console.log("after", ctx.op, ctx.path),
    },
  },
});
```

> Note: Avoid mounting a `MemoryProvider` at `/` unless you also provide CA
> certificates; doing so hides `/etc/ssl/certs` and will cause TLS verification
> failures (e.g. `curl: (60)`).

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

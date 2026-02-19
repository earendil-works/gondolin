# SDK: VM Control

See also: [SDK Overview](./sdk.md), [Networking, Ingress, and SSH](./sdk-network.md)

When working with the SDK you create a `VM` object, use it, then close it.
If you do not close it, the QEMU instance keeps running.

## Creating, Starting, and Closing

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

## Session Identity and External Attaching

Each `VM` instance has a stable session UUID available as `vm.id`.

When a VM is started, gondolin registers a session entry under
`~/.cache/gondolin/sessions/` (`<uuid>.json` metadata + `<uuid>.sock` attach
socket). This powers CLI workflows like `gondolin list` and
`gondolin attach <uuid>`.

You can customize the session label shown by `gondolin list` with
`VM.create({ sessionLabel: "..." })`.

Advanced users can access the registry/attach helpers directly:

- `listSessions()`
- `findSession()`
- `gcSessions()`
- `connectToSession()`

## `vm.exec()`

This is the most common operation. It returns an `ExecProcess` (a running
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

### What Is in `ExecResult`

An `ExecResult` is **always returned**, even on non-zero exit codes (non-zero
exit codes do *not* throw). You typically check:

- `result.exitCode: number`: process exit code
- `result.signal?: number`: termination signal (if the guest reports one)
- `result.ok: boolean`: shorthand for `exitCode === 0`
- `result.stdout: string` / `result.stderr: string`: decoded using `options.encoding` (default: `utf-8`)
- `result.stdoutBuffer: Buffer` / `result.stderrBuffer: Buffer`: for binary output
- helpers: `result.json<T>()`, `result.lines()`

### Streaming Output

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
Gondolin uses a host<->guest credit window to keep buffered output bounded.
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

### `proc.attach()`

`vm.exec()` returns an `ExecProcess`, which can be **attached** to a terminal (or any Node streams):

```ts
const proc = vm.exec(["/bin/bash", "-i"], {
  stdin: true,
  pty: true,
  stdout: "pipe",
  stderr: "pipe",
});

proc.attach(
  process.stdin as NodeJS.ReadStream,
  process.stdout as NodeJS.WriteStream,
  process.stderr as NodeJS.WriteStream,
);

const result = await proc;
console.log("exitCode:", result.exitCode);
```

What `attach()` does:

- wires `stdin` -> guest process (requires `stdin: true`)
- forwards `stdout`/`stderr` to the provided writable streams when they are set to `"pipe"`
- if `stdout`/`stderr` are `"inherit"` (or a custom writable), output is already forwarded by the VM, and `attach()` only handles input/resize
- enables raw mode on TTY stdin, and forwards terminal resize events to the guest (only meaningful with `pty: true`)
- automatically cleans up listeners and restores raw mode when the process exits

Notes:

- `attach()` can only be called once per process.
- Don't simultaneously consume `proc.stdout` / async-iterate the process and call `attach()`; attaching will consume the pipe.

### Avoiding Large Buffers

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

### Cancellation

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

## `vm.shell()`

`vm.shell()` is a convenience wrapper around `vm.exec()` for interactive
sessions (PTY + stdin enabled), optionally attaching to the current terminal.

## `vm.fs`

Filesystem operations are exposed under `vm.fs`. This includes both the
existing file helpers and additional operations like `access()`, `mkdir()`,
`listDir()`, `stat()`, and `rename()`.

```ts
import { constants } from "node:fs";
import { Readable } from "node:stream";

// Check access
await vm.fs.access("/etc/os-release", { mode: constants.R_OK });

// Create directories
await vm.fs.mkdir("/tmp/workspace/nested", { recursive: true });

// List direct children
const entries = await vm.fs.listDir("/tmp/workspace");
console.log(entries);

// Stat (same object shape as node:fs Stats / VFS Stats)
const st = await vm.fs.stat("/tmp/workspace");
console.log(st.isDirectory(), st.mode, st.size);

// Rename / move
await vm.fs.rename("/tmp/old-name.txt", "/tmp/new-name.txt");

// Read text
const osRelease = await vm.fs.readFile("/etc/os-release", {
  encoding: "utf-8",
});

// Stream-read a large file
const stream = await vm.fs.readFileStream("/var/log/messages");
for await (const chunk of stream) {
  process.stdout.write(chunk);
}

// Write text (overwrites existing file)
await vm.fs.writeFile("/tmp/hello.txt", "hello from host\n");

// Stream-write from a Node readable
await vm.fs.writeFile(
  "/tmp/payload.bin",
  Readable.from([Buffer.from([0xde, 0xad]), Buffer.from([0xbe, 0xef])]),
);

// Delete file
await vm.fs.deleteFile("/tmp/hello.txt");

// Delete recursively / ignore missing path
await vm.fs.deleteFile("/tmp/some-dir", { recursive: true, force: true });
```

Notes:

- `vm.fs.listDir()` returns direct child names for a directory
- `vm.fs.stat()` returns a Node-compatible `fs.Stats` object (same shape used by VFS providers)
- `vm.fs.rename()` renames/moves a path
- `vm.fs.readFile()` reads any path visible in the **running guest filesystem** (including rootfs paths under `/`)
- `vm.fs.readFile()` returns a `Buffer` by default; pass `encoding` to get a `string`
- `vm.fs.readFileStream()` streams file bytes as a Node readable stream
- `vm.fs.writeFile()` truncates existing files before writing and accepts `string`, `Buffer`, `Uint8Array`, `Readable`, or `AsyncIterable`
- `vm.fs.deleteFile()` supports `force` and `recursive`

# Running Commands

Everything you do with a Gondolin VM goes through a `VM` object: create it,
run commands in it, close it. This page covers the VM lifecycle and command
execution from the SDK, with the matching CLI commands. For the full option
tables see the [SDK Reference](./sdk.md); for when to create and discard VMs
see [Workloads and Lifecycle](./workloads.md).

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create();

const result = await vm.exec("echo hello; uname -m");
console.log(result.exitCode, result.stdout);

await vm.close();
```

The same from the command line:

```bash
# Run one command in a fresh VM and exit with its exit code
gondolin exec -- sh -lc 'echo hello; uname -m'

# Interactive shell
gondolin bash
```

## Creating, Starting, and Closing

`VM.create()` is the async factory. It resolves the guest image (downloading
it on first use), prepares the root disk and returns a `VM`:

```ts
const vm = await VM.create({
  memory: "2G",          // qemu size syntax, default "1G"
  cpus: 4,               // default 2
  env: { CI: "1" },      // default environment for every command
  startTimeoutMs: 30000, // default 120000
});

// Optional: boot now instead of on first use
await vm.start();

// ...use the VM...
await vm.close();
```

- `VM.create()` never boots the VM. It boots lazily on first use: `vm.exec()`
  / `vm.shell()`, `vm.fs` operations on guest paths, `vm.enableSsh()`,
  `vm.enableIngress()`, `vm.checkpoint()` (which boots the VM even with
  `autoStart: false`, since the root disk is created at start), or an
  explicit `vm.start()`. Calling `start()`
  yourself moves the boot cost (well under a second on a warm machine) and
  any boot error to a point you control. `start()` is idempotent.
- With `autoStart: false` (default `true`) nothing boots implicitly: those
  operations throw `vm is not started (autoStart: false); call vm.start()
  first` until you call `start()`. Use it when booting at an unexpected point
  would be a bug, for example to make sure all configuration happens before
  the VM runs:

  ```ts
  const vm = await VM.create({ autoStart: false });
  // ...host-side setup that must finish before boot...
  await vm.start();
  ```
- `startTimeoutMs` bounds the wait for the guest to become ready (including
  [VFS mounts](./vfs.md)); `<= 0` disables it. When it fires, `start()` rejects
  with an error whose `code` is `"vm_start_timeout"`, the half-started VM is
  torn down and `start()` may be retried. `GONDOLIN_START_TIMEOUT_MS` changes
  the default.
- `env` accepts `{ KEY: "value" }` or `["KEY=value"]`. Per-command `env`
  entries are merged on top, key by key.
- **Close every VM.** `vm.close()` stops the VM, the Gondolin daemon
  (`gondolind`) process serving it, the SSH and ingress forwarders, and deletes
  the throwaway root disk overlay. A VM that is not closed keeps running.
- A closed VM cannot be started again (`vm is closed and cannot be
  restarted`); create a new one. The same holds after
  [`vm.checkpoint()`](./snapshots.md), which stops the VM.

`new VM(options)` also exists, but it requires the guest image to be present
locally already; prefer `VM.create()`.

Other options (network policy, mounts, root disk mode, backend selection) are
covered in their guides and listed in the [SDK Reference](./sdk.md#vmoptions).

## `vm.exec()`

`vm.exec()` runs a command and returns an `ExecProcess`, which is both:

- **Promise-like**: `await vm.exec(...)` yields an `ExecResult`
- **Stream-like**: with `stdout: "pipe"` it is an `AsyncIterable` of stdout
  chunks and exposes `stdout` / `stderr` Node streams

There are two forms:

- `vm.exec("...")` (string): runs the command through a login shell, the same
  as `vm.exec(["/bin/sh", "-lc", "..."])`. Use it for shell features
  (pipelines, `$VARS`, globbing, `$(...)`).
- `vm.exec([cmd, ...args])` (array): executes `cmd` directly, without a shell.
  A `cmd` without a `/` is looked up in the guest's `$PATH` (`/bin:/usr/bin`
  when `PATH` is unset).

```ts
// shell form
const r1 = await vm.exec("echo $HOME | wc -c");

// argv form: no quoting or injection issues with untrusted arguments
const r2 = await vm.exec(["grep", "-r", userPattern, "/workspace"]);

// string form with positional parameters ($1, $2, ...)
const r3 = await vm.exec('printf "%s\\n" "$@"', { argv: ["a", "b c"] });
```

Commands may run concurrently on one VM. The number of running plus queued
commands is capped by `sandbox.maxQueuedExecs` (default 64); beyond that,
`exec()` rejects with `too many concurrent exec requests`.

### Exec Options

| Option | Default | Meaning |
|---|---|---|
| `cwd` | guest default | Working directory |
| `env` | — | Extra environment (`Record` or `KEY=VALUE[]`), merged over `VMOptions.env` |
| `argv` | — | Extra positional parameters for the string form |
| `stdin` | disabled | `true` for manual `write()`/`end()`, or a `string`, `Buffer`, `Readable` or `AsyncIterable<Buffer>` to send (then EOF) |
| `pty` | `false` | Allocate a pseudo-terminal |
| `stdout` / `stderr` | `"buffer"` | `"buffer"`, `"pipe"`, `"inherit"`, `"ignore"` or a writable stream (see [Output Modes](#output-modes)) |
| `buffer` | `true` | Legacy switch: `false` makes unset `stdout`/`stderr` default to `"ignore"` |
| `encoding` | `"utf-8"` | Decoding of `result.stdout`/`stderr` and of streamed chunks |
| `windowBytes` | 256 KiB | Output flow-control window per stream in streaming modes (4 KiB–16 MiB) |
| `signal` | — | `AbortSignal` that stops the command (see [Cancellation](#cancellation)) |
| `killSignal` | `"SIGKILL"` | Signal sent to the command on abort (a Linux signal name or number) |

### What Is in `ExecResult`

An `ExecResult` is **always returned**, even for non-zero exit codes
(non-zero exit codes do *not* throw). `exec()` rejects only when the command
could not run or be waited for (VM failed to start, aborted, connection lost).

```ts
const result = await vm.exec("echo hello; echo err >&2; exit 7");

result.exitCode; // 7
result.ok;       // false (exitCode === 0)
result.stdout;   // "hello\n"
result.stderr;   // "err\n"
```

- `exitCode: number`: process exit code
- `signal?: number`: terminating signal, if the guest reports one
- `ok: boolean`: `exitCode === 0`
- `stdout` / `stderr: string`: output decoded with `encoding`
- `stdoutBuffer` / `stderrBuffer: Buffer`: raw output, for binary data
- `json<T>()`: parse stdout as JSON; `lines()`: non-empty stdout lines
- `id: number`: request id of the command

Only streams in `"buffer"` mode are captured; in every other mode the
corresponding fields are empty.

### Output Modes

| Mode | Behaviour |
|---|---|
| `"buffer"` (default) | Collected into the `ExecResult` |
| `"pipe"` | Exposed as `proc.stdout` / `proc.stderr` readable streams; not buffered |
| `"inherit"` | Written to the host's `process.stdout` / `process.stderr` |
| `"ignore"` | Dropped |
| a writable | Written to that stream (anything with a `write()` method), honouring its backpressure |

### Streaming Output

Set `stdout: "pipe"` (and `stderr: "pipe"` if you want stderr) to consume
output while the command runs:

```ts
const proc = vm.exec("for i in 1 2 3; do echo $i; sleep 1; done", {
  stdout: "pipe",
});

for await (const chunk of proc) {
  // async iteration yields stdout chunks as strings
  process.stdout.write(chunk);
}

const result = await proc;
console.log(result.exitCode);
```

`proc.lines()` yields stdout line by line instead of in chunks. To stream
both stdout and stderr with labels, use `proc.output()` (requires both to be
piped):

```ts
const proc = vm.exec("echo out; echo err >&2", {
  stdout: "pipe",
  stderr: "pipe",
});

for await (const { stream, text } of proc.output()) {
  process.stdout.write(`[${stream}] ${text}`);
}
```

Piped output is not buffered into the `ExecResult`. To stream *and* keep a
copy, capture it from the stream yourself:

```ts
const proc = vm.exec(["/bin/echo", "hello"], { stdout: "pipe" });
let stdout = "";
proc.stdout!.on("data", (b) => (stdout += b.toString("utf-8")));

await proc;
console.log(stdout);
```

Backpressure: in streaming modes (`"pipe"` or a writable) the host grants
the guest a credit window per stream (`windowBytes`, default 256 KiB). When
the window is used up because you are not reading the pipe (or the writable
is full), the guest process blocks on write until you consume more. Always
drain piped streams you enabled, or the command may never finish.

### Writing to stdin

Pass the input directly when you have it up front; Gondolin sends it in
chunks and closes stdin afterwards:

```ts
await vm.exec(["sha256sum"], { stdin: "some data" });
await vm.exec(["tar", "-x", "-C", "/tmp/out"], {
  stdin: fs.createReadStream("bundle.tar"),
});
```

With `stdin: true` you write yourself. `write()` returns `false` once more
than 1 MiB is unacknowledged by the guest; await `drain()` before writing
more to keep memory bounded, and call `end()` to send EOF:

```ts
const proc = vm.exec(["/bin/cat"], { stdin: true, stdout: "pipe" });

for (const chunk of chunks) {
  if (!proc.write(chunk)) await proc.drain();
}
proc.end();

for await (const out of proc) process.stdout.write(out);
```

`write()` and `end()` throw when the process was started without `stdin`.

### `proc.attach()`

An `ExecProcess` can be attached to a terminal (or any Node streams):

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

- wires `stdin` to the guest process (requires `stdin: true`)
- forwards `stdout` / `stderr` to the given writables when they are
  `"pipe"`; with `"inherit"` or a custom writable, output already flows there
  and `attach()` only handles input and resizing (it throws if neither stream
  is piped, inherited or a writable)
- enables raw mode on a TTY stdin and forwards terminal resize events to the
  guest (meaningful with `pty: true`; `proc.resize(rows, cols)` does the same
  by hand)
- removes its listeners and restores the terminal mode when the process exits

Notes:

- `attach()` can only be called once per process.
- Don't consume `proc.stdout` or async-iterate the process while attached;
  attaching consumes the pipes.

### Avoiding Large Buffers

Buffered output is kept in memory until the command ends. For commands that
may produce a lot of output, either drop it or stream it:

```ts
// Only the exit code matters
const result = await vm.exec(["/bin/cat", "/some/huge/file"], {
  buffer: false, // stdout/stderr default to "ignore"
});

// Stream with backpressure instead of buffering
const proc = vm.exec(["/bin/cat", "/some/huge/file"], { stdout: "pipe" });
for await (const chunk of proc) process.stdout.write(chunk);

// Or straight into a file
await vm.exec(["/bin/cat", "/some/huge/file"], {
  stdout: fs.createWriteStream("out.bin"),
});
```

For moving files in and out of the guest, `vm.fs.readFileStream()` and
`vm.fs.writeFile()` avoid the shell entirely; see
[Files and Mounts](./vfs.md).

### Cancellation

`signal` stops a command:

```ts
try {
  const result = await vm.exec(["/bin/sleep", "10"], {
    signal: AbortSignal.timeout(1000),
  });
  console.log("exitCode:", result.exitCode);
} catch (err) {
  // aborting rejects with "exec aborted"
  console.error(String(err));
}
```

Aborting sends `killSignal` (default `SIGKILL`) to the command and every
process it started (each exec runs in its own session and process group in
the guest), then rejects the promise with "exec aborted" and stops delivering
output. An exec that has not started yet is never started.

To signal a command without aborting, use `proc.kill(signal)` (default
`SIGTERM`). The exec then finishes as usual: `result.signal` is set and
`result.exitCode` is `128 + signal` when the command died from it. `kill()`
returns `false` when the exec already finished.

```ts
const proc = vm.exec(["python3", "server.py"]);
// ...
proc.kill("SIGINT");
const result = await proc; // result.signal === 2
```

Signal names and numbers are Linux ones (`SIGUSR1` is 10, also on macOS
hosts). Signalling needs a guest image whose `sandboxd` supports it (images
built with this release); with older images the daemon logs a warning and the
command keeps running until it exits or the VM is closed.

## `vm.shell()`

`vm.shell()` is a convenience wrapper around `vm.exec()` for interactive
sessions. It runs `/bin/bash -i` (or `command`) with `stdin: true` and
`pty: true`, sets `TERM` from the host terminal (default `xterm-256color`)
unless `env` sets it, and attaches to `process.stdin` / `stdout` / `stderr`
when stdin is a TTY:

```ts
// Hand the terminal to the VM until the shell exits
const result = await vm.shell();
process.exitCode = result.exitCode;

// Another command, without attaching (output is piped)
const proc = vm.shell({ command: ["/bin/sh"], attach: false, cwd: "/tmp" });
proc.write("ls\n");
proc.end();
for await (const chunk of proc) process.stdout.write(chunk);
```

Options: `command` (string or argv, default `["/bin/bash", "-i"]`), `env`,
`cwd`, `signal`, `attach` (default: `process.stdin.isTTY`).

The CLI equivalent is [`gondolin bash`](./cli.md#gondolin-bash), which falls
back to `/bin/sh` when the image has no bash and detaches on `Ctrl-]`.

## Sessions and Attaching From Outside

Each `VM` has a stable session UUID, `vm.id`. When the VM starts, Gondolin
registers it under `~/.cache/gondolin/sessions/` (`<uuid>.json` metadata plus
a `<uuid>.sock` attach socket) and removes the entry on `close()`. This lets
other processes find and use the running VM:

```bash
# List running sessions (ID, PID, AGE, ALIVE, LABEL)
gondolin list

# Open another shell in a running VM by UUID prefix
gondolin attach 9e3a2e2d

# Run a non-interactive command in it
gondolin exec --sock 9e3a2e2d -- ps aux
```

The label shown by `gondolin list` defaults to the command line of the
process that created the VM; set it with `sessionLabel`:

```ts
const vm = await VM.create({ sessionLabel: "agent task 42" });
```

The registry helpers are exported for programmatic use: `listSessions()`,
`findSession(idOrPrefix)`, `gcSessions()` and `connectToSession()`; see
[SDK Reference](./sdk.md#sessions). See
[`gondolin list`](./cli.md#gondolin-list),
[`gondolin attach`](./cli.md#gondolin-attach) and
[`gondolin exec`](./cli.md#gondolin-exec) for the CLI side.

## Host Process ID

`vm.getHostPid()` returns the host PID of the process running the VM: the
QEMU process, or the krun runner with the libkrun backend (see
[VM Backends](./backends.md)), not the Gondolin daemon. Use it to sample
host-side metrics such as memory or CPU usage with your own tooling.

It returns `null` when there is no runner process to report:

- before the VM has started (`VM.create()` does not boot it)
- after the VM has been closed or the runner process has exited
- while `vm.close()` is in progress, after Gondolin released its runner handle
- if the backend failed before spawning its runner
- when the VM runs on a [remote machine](./remote.md) (the PID would belong
  to another host)

## Running Commands From the CLI

`gondolin exec` creates a VM, runs one or more commands, prints their output
and exits with the command's exit code; `gondolin bash` opens an interactive
shell. Both accept the same mount, network and image options as the SDK
(`--mount-hostfs`, `--allow-host`, `--image`, ...):

```bash
# Run npm in a VM with the project mounted
gondolin exec --mount-hostfs "$PWD:/workspace" -- sh -lc 'cd /workspace && npm test'

# Several commands in one VM, each with its own args
gondolin exec \
  --cmd sh --arg -lc --arg 'echo hello' \
  --cmd sh --arg -lc --arg 'echo world'

# Shell with a working directory and environment
gondolin bash --cwd /tmp --env FOO=bar
```

See the [CLI Reference](./cli.md#gondolin-exec) for all options.

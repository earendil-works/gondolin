# Files and Mounts

The guest only sees host files you mount into it explicitly. You can share a
host directory (read-write or read-only), hide secret files inside it, give
the guest fast scratch space, or serve files from your own code (an API, an
object store, generated content). The host can also read and write guest
files directly with `vm.fs`.

From the CLI:

```bash
# Share the current directory at /workspace
gondolin bash --mount-hostfs "$PWD:/workspace"

# A read-only dataset plus in-memory scratch space
gondolin exec --mount-hostfs /data/set:/dataset:ro --mount-memfs /scratch -- ls /dataset
```

From the SDK:

```ts
import path from "node:path";
import { VM, RealFSProvider, nativeMounts } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: {
      "/workspace": new RealFSProvider(path.resolve(".")),
      "/scratch": nativeMounts.memory(),
    },
  },
});

await vm.exec("cd /workspace && ls");
await vm.close();
```

Everything outside your mounts (the root filesystem and the scratch tmpfs
paths) lives in the VM; see [Persistence and Snapshots](./snapshots.md) for
how long that survives.

## How the Guest Sees Mounts

### Mount Map

`vfs.mounts` maps absolute guest paths to providers:

- Keys must be absolute POSIX paths (for example `/workspace`, `/cache`)
- Mounts other than `/` appear at their path in the guest (as bind mounts)
- The special mount `/` is the root of the mounted tree itself (see below),
  not the guest's root filesystem
- Providers see absolute POSIX paths rooted at `/` within their mount
- With more than one mount, an operation goes to the mount with the longest
  matching prefix

### The `/data` Mount

The guest mounts the whole tree once (default mount point: `/data`) and then
bind-mounts each entry to its configured path. So every mount is also
reachable under the tree: `/workspace` is visible at both `/workspace` and
`/data/workspace`. The tree also holds Gondolin's own mounts at
`/etc/gondolin` (ingress configuration and the MITM CA certificate).

You can move the tree with `fuseMount`:

```ts
import { VM, MemoryProvider } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    fuseMount: "/vfs",
    mounts: {
      "/workspace": new MemoryProvider(),
    },
  },
});
// /workspace is also at /vfs/workspace
```

`vfs: null` disables the VFS entirely: no `/data`, no `/etc/gondolin`, so
the guest gets neither the MITM CA certificate nor [ingress](./ingress.md).

## Choosing a Mount Type

The Gondolin daemon (`gondolind`) serves the guest filesystem from its own
mount table. Some mounts it serves itself; the others call back into your
Node.js process for every operation the daemon cannot answer from its cache.

| Mount | What it is | Served by |
|---|---|---|
| `RealFSProvider(dir)` | a host directory | the daemon, as a hardened host directory |
| `ReadonlyProvider(x)` | `x` without writes | the daemon when `x` is served by the daemon |
| `ShadowProvider(x, { shouldShadow: createShadowPathPredicate(paths) })` | `x` with hidden paths | the daemon when `x` is served by the daemon |
| `nativeMounts.memory()` | an in-memory filesystem | the daemon |
| `nativeMounts.host(dir, { readonly, hide })` | a directory on the daemon's machine | the daemon (also for [remote daemons](./remote.md)) |
| `createObjectMount(provider, options)` | your whole-file `ObjectProvider` | the daemon's cache, calling your provider for misses and writes |
| `MemoryProvider` | an in-memory filesystem in your process | your process, one round trip per uncached operation |
| `ShadowProvider` with a custom `shouldShadow` function, custom providers | your JS code | your process, one round trip per uncached operation |

Mounts served by the daemon cost no round trips to your process. For JS
providers (the last two rows) your provider stays the source of truth: every
guest write is forwarded before the write returns, metadata is cached for 1 s
(as the guest kernel does anyway) and contents are revalidated on every open,
so changes you make on the host side are seen by the guest. Each uncached
operation is one round trip, so metadata-heavy work (`npm install`, `git
status`, builds) is noticeably slower on such mounts.

Rules of thumb:

- Share host directories with `RealFSProvider` (wrapped in `ReadonlyProvider`
  or a path-list `ShadowProvider` as needed); this stays on the fast path.
- Use `nativeMounts.memory()` for scratch space you reach from the host, and
  the guest's [tmpfs mounts](#guest-tmpfs-mounts) (or the root disk) for
  scratch space only the guest needs: neither involves your process.
- Use `MemoryProvider` only when your own code needs to read or write the same
  files directly (for example, to seed inputs or inspect outputs without
  `vm.fs`).
- For data that lives behind an API, implement an
  [`ObjectProvider`](#object-mounts) rather than a full `VirtualProvider`.
- Check which [transport](#transport-virtio-fs-and-sandboxfs) the guest uses:
  virtio-fs is several times faster than the sandboxfs fallback.

## Host Directories

`RealFSProvider(hostPath)` exposes a host directory. Reads and writes affect
the host directory, so use it for persistence (outputs, caches) and for
sharing a source tree.

```ts
import path from "node:path";
import { VM, RealFSProvider } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: {
      "/workspace": new RealFSProvider(path.resolve(".")),
    },
  },
});
```

Host directory mounts are hardened:

- Nothing resolves outside the directory: the daemon resolves paths with
  `openat2(RESOLVE_BENEATH)` on Linux and a component-wise `O_NOFOLLOW` walk
  elsewhere
- Symlinks that escape the directory, and dangling symlinks, behave as missing
  for operations that follow symlinks (`open`, `stat`, `readdir`, ...)
- Operations on the symlink entry itself (`lstat`, `readlink`, `unlink`) work
- Guest `chmod` updates the host file's permission bits, but setuid/setgid
  bits are always dropped so the guest cannot plant set-id binaries on the
  host

`nativeMounts.host(dir, options)` mounts a directory on the machine the daemon
runs on, with the same hardening. Locally it is equivalent to
`RealFSProvider`; with a [remote daemon](./remote.md) it is the way to mount a
directory on the remote machine (a `RealFSProvider` there refers to a
directory on your machine and is served through your process instead). Its
options:

| Option | Meaning |
|---|---|
| `readonly` | reject writes |
| `hide` | paths hidden from the guest (as with [`ShadowProvider`](#hiding-paths)) |
| `hideWriteMode` | writes to hidden paths: `"deny"` (default) or `"tmpfs"` (kept in memory) |

```ts
import { VM, nativeMounts } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: {
      "/srv": nativeMounts.host("/srv/project", { readonly: true, hide: ["/.env"] }),
    },
  },
});
```

## Read-Only Mounts

`ReadonlyProvider(backend)` wraps another provider and rejects mutations
(`EROFS`). Use it for configuration, templates or fixtures the guest must not
modify:

```ts
import path from "node:path";
import { VM, RealFSProvider, ReadonlyProvider } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: {
      "/config": new ReadonlyProvider(new RealFSProvider(path.resolve("./config"))),
    },
  },
});
```

## Hiding Paths

`ShadowProvider(backend, options)` wraps another provider and hides selected
paths:

- Read operations behave as if the entry does not exist (`ENOENT`)
- Hidden entries are omitted from `readdir` results
- Writes are either denied or redirected to an in-memory upper layer

```ts
import { ShadowProvider, createShadowPathPredicate } from "@earendil-works/gondolin";

const provider = new ShadowProvider(backend, {
  shouldShadow: createShadowPathPredicate(["/.env", "/secrets"]),
});
```

`createShadowPathPredicate([...])` hides exact paths and everything below
them (prefix matching, no globs). Paths are absolute within the mount;
`createShadowPathPredicate([".env"])` normalizes to `"/.env"`. Pass the
predicate it returns directly as `shouldShadow`: the daemon recognizes it and
serves the mount itself. Any other function works too, but moves the whole
mount to your process (see [Choosing a Mount Type](#choosing-a-mount-type)):

```ts
const provider = new ShadowProvider(backend, {
  // custom predicate: evaluated in your process for every operation
  shouldShadow: ({ path }) => path.endsWith(".pem"),
});
```

### Shadow Provider Options

- `shouldShadow`: policy callback that returns `true` for hidden paths
- `writeMode`: `"deny"` (default) or `"tmpfs"`
- `tmpfs`: provider used as the upper layer when `writeMode` is `"tmpfs"`
  (default: a new `MemoryProvider`; a custom one moves the mount to your
  process)
- `denySymlinkBypass`: also consult `realpath()` to block trivial symlink
  bypasses (default: `true`)
- `denyWriteErrno`: errno for denied writes (default: `EACCES`)

### Blocking Access to `.env`

When you mount a host working tree, make sure local secret files are not
readable. Mount the repository at `/workspace` but hide `/.env` and
`/.npmrc`:

```ts
import path from "node:path";
import {
  VM,
  RealFSProvider,
  ShadowProvider,
  createShadowPathPredicate,
} from "@earendil-works/gondolin";

const workspace = new ShadowProvider(new RealFSProvider(path.resolve(".")), {
  shouldShadow: createShadowPathPredicate(["/.env", "/.npmrc"]),
  // default writeMode is "deny"
});

const vm = await VM.create({
  vfs: { mounts: { "/workspace": workspace } },
});
```

### Hiding `node_modules` but Allowing Installs

To run `npm install` (or `pnpm install`) inside the VM from scratch instead of
using the host's `node_modules` (likely built for another OS or architecture),
hide `/node_modules` with `writeMode: "tmpfs"` so the guest can create its own
in memory:

```ts
import path from "node:path";
import {
  VM,
  RealFSProvider,
  ShadowProvider,
  createShadowPathPredicate,
} from "@earendil-works/gondolin";

const base = new RealFSProvider(path.resolve("."));

// first: deny reads and writes of host secret files
const secrets = new ShadowProvider(base, {
  shouldShadow: createShadowPathPredicate(["/.env", "/.npmrc"]),
  writeMode: "deny",
});

// then: hide the host node_modules, but let the guest write its own
const noHostNodeModules = new ShadowProvider(secrets, {
  shouldShadow: createShadowPathPredicate(["/node_modules"]),
  writeMode: "tmpfs",
});

const vm = await VM.create({
  vfs: { mounts: { "/workspace": noHostNodeModules } },
});

await vm.exec("cd /workspace && npm install");
```

With `writeMode: "tmpfs"`, `/workspace/node_modules` looks empty until the
guest creates files there, and those writes stay in memory without touching
the host directory. The same works for other host directories of the wrong
architecture or that you do not want to share (`.git`, `.venv`, `dist`).

## In-Memory Mounts

There are two in-memory filesystems:

- `nativeMounts.memory()` lives in the daemon: fast, no round trips. Reach its
  contents from the host with [`vm.fs`](#accessing-files-from-the-host); the
  returned object is only a placeholder carrying the mount, so reading it
  directly does not show the guest's files. `--mount-memfs` uses it.
- `MemoryProvider` lives in your process. Your code can read and write the
  same instance while the guest uses it, at the cost of a round trip per
  uncached guest operation.

Both are lost when the VM closes and are not part of
[checkpoints](./snapshots.md#disk-checkpoints).

## Object Mounts

For providers that naturally work on whole files (APIs, object stores,
databases), implement `ObjectProvider` and mount it with
`createObjectMount()` (also available as `nativeMounts.object()`). The daemon
handles everything per-operation (file handles, offsets, attributes) from its
cache and only calls your provider with whole-file operations:

```ts
import { VM, createObjectMount, type ObjectProvider } from "@earendil-works/gondolin";

const notes: ObjectProvider = {
  async stat(path) { /* { kind: "file" | "dir" | "symlink", size, mode?, mtimeMs? } */ },
  async readDir(path) { /* [{ name, kind }] */ },
  async readFile(path, range) { /* bytes (the range or the whole file) */ },
  async writeFile(path, data, options) { /* replace the whole file (options?.mode) */ },
  // optional: unlink, rename, mkdir, rmdir, truncate, chmod, symlink, readlink, link, write
};

const vm = await VM.create({
  vfs: {
    mounts: {
      "/notes": createObjectMount(notes, { cacheTtlMs: 5000, commit: "close" }),
    },
  },
});
```

### The `ObjectProvider` Interface

Paths are absolute within the mount. Failures are errors with an errno `code`
(`ENOENT`, `EACCES`, ...). Missing optional methods behave as `ENOSYS`, or
`EROFS` for writes on a read-only mount.

| Method | Meaning |
|---|---|
| `stat(path)` | metadata without following a final symlink: `{ kind, size, mode?, mtimeMs?, ctimeMs?, atimeMs?, nlink?, uid?, gid? }` (times in `ms` since the epoch) |
| `readDir(path)` | directory entries: `[{ name, kind }]` |
| `readFile(path, range?)` | file contents, or `range.length` bytes from `range.offset` |
| `writeFile(path, data, options?)` | replace a whole file, creating it with `options.mode` when missing |
| `write(path, offset, data)` | positional write into an existing file (used with `commit: "write"`) |
| `truncate`, `unlink`, `rename`, `mkdir`, `rmdir`, `chmod`, `symlink`, `readlink`, `link` | the usual operations |

### Object Mount Options

| Option | Default | Meaning |
|---|---|---|
| `writable` | when `writeFile` exists | allow mutations |
| `enumeration` | `"list"` | directory listings: forwarded (`"list"`), only entries the guest has seen (`"materialized"`), or empty (`"none"`) |
| `commit` | `"close"` | `"close"`: the whole file is written when the guest closes it; `"write"`: every write is forwarded |
| `cacheTtlMs` | `1000` | validity of cached metadata and contents in `ms` (`0` revalidates on every access) |
| `revalidateOnOpen` | `false` | re-stat on every open and refetch contents whose size or mtime changed |
| `maxCacheBytes` | 256 MiB | budget for cached clean contents in `bytes` |
| `maxFileBytes` | none | largest file the guest may create or grow in `bytes` |
| `inlineMaxBytes` | `0` (off) | files up to this size in `bytes` are fetched together with their `stat` (one round trip instead of two per small file, at the cost of a `readFile` per stat) |

Large files are read lazily in 1 MiB ranges and written back in 1 MiB chunks
of one `writeFile`. On the host side (`vm.fs`, or using the returned provider
directly) the mount is an `ObjectVirtualProvider`: files are read on open and
written back on close. For a read-only object mount, set `writable: false`
rather than wrapping it in `ReadonlyProvider` (which would move it to the
slower JS path).

### Write-Back and Close Errors

With `commit: "close"`, a failing `writeFile` surfaces as the error of the
guest's `close()` or `fsync()`, over both
[transports](#transport-virtio-fs-and-sandboxfs). Over sandboxfs this needs
guest helpers and a daemon newer than Gondolin 0.14.0; with older ones the
`close()` succeeds. Only handles that commit on close pay for this: other
files are opened so that the kernel skips the flush on `close()`.

When the commit fails, the data stays cached and is written again when the
next writer closes the file. The failure of the final `release` is reported in
`vfs` debug output and to [`after` hooks](#vfs-hooks).

## Provider Composition

Providers stack:

- `new ReadonlyProvider(new RealFSProvider(dir))`
- `new ShadowProvider(new RealFSProvider(dir), { ... })`
- several `ShadowProvider` layers with different policies (deny secrets,
  tmpfs for build outputs)

Put the most security-sensitive policy (for example blocking secrets) closest
to the real host filesystem provider. Stacks of `ReadonlyProvider` and
path-list `ShadowProvider` layers around a `RealFSProvider` or
`nativeMounts.host()` stay on the daemon's fast path; any other layer in the
stack moves the whole mount to your process.

## Custom Providers

For behavior beyond the built-ins (filtering, synthetic files, virtual
directories, generated content) you can implement a custom provider:

- Extend `VirtualProviderClass` for a full read/write provider
- Extend `ReadonlyVirtualProvider` for a synchronous, read-only provider (it
  implements the async methods on top of the sync ones and rejects writes
  with `EROFS`)
- Implement [`ObjectProvider`](#object-mounts) instead when your data maps to
  whole files; it is simpler and faster

Optional methods such as `link`, `symlink`, `chmod` and `statfs` can be left
out; the guest then sees `ENOSYS` for the operation (for `chmod`, mode changes
are silently ignored to keep tools like `cp -p` working).
[`host/examples/magic-git-bash.ts`](https://github.com/earendil-works/gondolin/blob/main/host/examples/magic-git-bash.ts)
shows a custom read-only provider.

Custom providers are served through your process (see
[Choosing a Mount Type](#choosing-a-mount-type)).

> **Implementation note:** the provider interface comes from a vendored
> snapshot of Node's VFS with local patches for real-Linux behavior (hard
> links, stat semantics, `RealFSProvider` hardening), marked with
> `XXX(patch)` under `host/src/vfs/node/vendored-node-vfs`; see the
> upstreaming discussion in
> [node#61478](https://github.com/nodejs/node/pull/61478).

## VFS Hooks

`vfs.hooks` observes (and can veto) guest file operations on every mount:

```ts
import { VM, nativeMounts } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: { "/workspace": nativeMounts.memory() },
    hooks: {
      before: (ctx) => {
        if (ctx.path?.endsWith(".pem")) {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
      },
      after: (ctx) => console.log("vfs", ctx.op, ctx.path, ctx.result),
    },
  },
});
```

- `before` runs before the operation and blocks it until it returns; throwing
  denies the operation with the error's errno `code` (`EIO` when it has
  none). Each hooked operation costs one round trip to your process, also on
  mounts the daemon serves itself, so register it only when you need it.
- `after` runs asynchronously after the guest got its reply; `ctx.result` is
  the error of a failed operation or the transferred byte count of a `read` or
  `write`. Errors thrown by `after` hooks are reported but do not affect the
  guest.

The context carries `op` (`open`, `read`, `write`, `release`, `lstat`,
`mkdir`, `rename`, ...) and, where they apply, `path`, `oldPath`/`newPath`
(`rename`, `link`), `flags`, `mode`, `offset`, `length` and `size`. Hooks are
useful for auditing what the guest accessed, collecting metrics and debugging
unexpected file reads. `vm.fs` calls on mounts served by your process run the
hooks in-process too.

## Guest tmpfs Mounts

Besides your mounts, the guest's `/init` mounts tmpfs over `/root` (mode
`0700`), `/tmp`, `/var/tmp`, `/var/cache` and `/var/log` (and always `/run`).
Those paths live in guest RAM (each capped by the kernel at half the VM
memory), are the fastest scratch space, and are not part of
[disk checkpoints](./snapshots.md#disk-checkpoints).

The `tmpfs` option replaces that set. Each key is a guest path; `size`
(`bytes`, a `k`/`m`/`g` suffix, or a percentage of guest memory; default half
the guest memory) and `mode` (octal string, default `"1777"`) are optional:

```ts
import { VM, DEFAULT_GUEST_TMPFS } from "@earendil-works/gondolin";

// only /tmp is RAM-backed and capped; everything else stays on the root disk
const vm = await VM.create({
  tmpfs: { "/tmp": { size: "256m" } },
  rootfs: { size: "8G" },
});

// the built-in set plus a large build directory
const vm2 = await VM.create({
  tmpfs: { ...DEFAULT_GUEST_TMPFS, "/build": { size: "50%" } },
});
```

`tmpfs: {}` disables all scratch tmpfs mounts. The paths are then backed by
the root disk, which helps cache-heavy workloads with little VM memory, and
their contents become part of disk checkpoints. Combine it with
[`rootfs.size`](./snapshots.md#root-disk-size) since the default root disk has
little free space. With `rootfs.mode: "readonly"` the root disk is not
writable, so keep tmpfs mounts for every path the workload writes to.

Paths must be absolute, cannot be `/` or under `/proc`, `/sys`, `/dev` or
`/run`, and cannot contain whitespace, `,`, `:`, quotes, `\` or glob
characters. The setting is passed to `/init` on the kernel command line and
needs a guest image built with a Gondolin release that supports it; older
images ignore it and always mount the built-in set.

## Accessing Files From the Host

`vm.fs` reads and writes guest files from your process, on your mounts and on
the guest's own filesystem:

```ts
import { constants } from "node:fs";
import { Readable } from "node:stream";

// check access
await vm.fs.access("/etc/os-release", { mode: constants.R_OK });

// create directories
await vm.fs.mkdir("/tmp/workspace/nested", { recursive: true });

// list direct children
const entries = await vm.fs.listDir("/tmp/workspace");

// stat (a node:fs Stats object)
const st = await vm.fs.stat("/tmp/workspace");
console.log(st.isDirectory(), st.mode, st.size);

// rename / move
await vm.fs.rename("/tmp/old-name.txt", "/tmp/new-name.txt");

// read text
const osRelease = await vm.fs.readFile("/etc/os-release", { encoding: "utf-8" });

// stream-read a large file
const stream = await vm.fs.readFileStream("/var/log/messages");
for await (const chunk of stream) process.stdout.write(chunk);

// write text (truncates an existing file)
await vm.fs.writeFile("/tmp/hello.txt", "hello from host\n");

// stream-write from a Node readable
await vm.fs.writeFile(
  "/tmp/payload.bin",
  Readable.from([Buffer.from([0xde, 0xad]), Buffer.from([0xbe, 0xef])]),
);

// delete a file, or a tree, ignoring a missing path
await vm.fs.deleteFile("/tmp/hello.txt");
await vm.fs.deleteFile("/tmp/some-dir", { recursive: true, force: true });
```

| Method | Notes |
|---|---|
| `access(path, { mode })` | `mode` from `fs.constants` (`R_OK`, `W_OK`, `X_OK`; default: exists) |
| `mkdir(path, { recursive, mode })` | |
| `listDir(path)` | direct child names |
| `stat(path)` | a Node `fs.Stats`; follows symlinks |
| `rename(oldPath, newPath)` | rename or move |
| `readFile(path, { encoding, chunkSize })` | a `Buffer`, or a `string` with `encoding` |
| `readFileStream(path, { chunkSize, highWaterMark })` | a Node readable stream |
| `writeFile(path, data, { encoding })` | `data`: `string`, `Buffer`, `Uint8Array`, `Readable` or `AsyncIterable`; truncates existing files |
| `deleteFile(path, { force, recursive })` | `force` ignores a missing path |

Every method also takes `cwd` (base for relative paths) and `signal` (an
`AbortSignal`).

### Which Paths Go Where

- **Your mounts** (paths under a mount or under the `/data` tree) are handled
  on the host, without the guest:
    - mounts only the daemon holds (`nativeMounts.memory()`, object mounts,
      and host directories of a [remote daemon](./remote.md)) go through the
      daemon's mount table; this starts the VM if it is not running
    - all other mounts use your providers directly; this works before the VM
      starts
- **Everything else** (the root filesystem, tmpfs paths) is accessed inside
  the running guest and starts the VM if needed. `readFile`,
  `readFileStream`, `writeFile` and `deleteFile` use the guest daemon's file
  transfer; `access`, `mkdir`, `listDir`, `stat` and `rename` run small shell
  commands (`sh`, `ls`, `stat`, `mv`), so `stat` timestamps have one-second
  resolution there.

## CLI Mount Flags

`gondolin bash` and `gondolin exec` take the same mount flags (see the
[CLI Reference](./cli.md)):

- `--mount-hostfs HOST_DIR:GUEST_PATH[:ro]` mounts a host directory (a
  `RealFSProvider`, wrapped in a `ReadonlyProvider` with `:ro`). The host path
  must exist and be a directory.
- `--mount-memfs GUEST_PATH` creates an in-memory mount
  (`nativeMounts.memory()`), lost when the VM exits.

Both flags can be repeated.

## Transport: virtio-fs and sandboxfs

The guest reaches the mounted tree in one of two ways:

- **virtio-fs**: the guest kernel sends FUSE requests to the daemon directly.
  With QEMU this needs a build that supports vhost-user (`qemu-system-* -device
  help` lists `vhost-user-fs-pci`) and shares guest memory with the daemon:
  metadata operations are about 2–4× and large reads and writes 10–15× faster
  than sandboxfs. Linux distribution QEMU builds support it; Homebrew's QEMU on
  macOS does not (see [QEMU Backend](./qemu.md#virtio-fs-and-vhost-user)). With
  krun, the runner (runner capability `virtiofs-socket`, reported by
  `gondolin-krun-runner --capabilities`) forwards each FUSE request to the
  daemon over a socket. That needs no shared memory, so it works on macOS too;
  large I/O is slower than vhost-user (one request at a time) but several times
  faster than sandboxfs.
- **sandboxfs**: a FUSE helper in the guest forwards each operation over a
  virtio-serial port. It is the fallback when neither of the above is
  available.

`GONDOLIN_VIRTIOFS=0` forces sandboxfs, `GONDOLIN_VIRTIOFS=1` asks for
virtio-fs and logs a warning when it is unavailable. virtio-fs also needs a
guest image whose `sandboxfs` supports `--virtiofs`; older images always use
sandboxfs (rebuild or update the image, see [Images](./images.md)). To see
which one a VM uses, check the mount type in the guest:

```bash
gondolin exec -- sh -c 'grep " /data " /proc/mounts'   # virtiofs or fuse.sandboxfs
```

## Gotchas

### Do Not Hide CA Certificates by Accident

Gondolin injects its MITM CA certificate at `/etc/gondolin/mitm/ca.crt`
unless you mount your own provider at `/etc/gondolin` or
`/etc/gondolin/mitm` (or disable the network or the VFS). Guest init scripts
use it to build a merged runtime trust bundle at
`/run/gondolin/ca-certificates.crt`. If your mounts hide the distribution's
CA bundles, public TLS verification may still fail unless you provide your
own trust store. Mounting over `/etc/gondolin` also disables
[ingress](./ingress.md).

### Disk Checkpoints Do Not Include VFS Data

[Disk checkpoints](./snapshots.md#disk-checkpoints) capture the VM's root
disk. Data written to mounts lives in the provider (host directory, memory,
your object store) and is not part of checkpoints; neither are tmpfs paths.

### A Single Custom Layer Slows the Whole Mount

A `ShadowProvider` with a custom predicate or a custom `tmpfs`, a
`ReadonlyProvider` around an object mount, or any custom provider in a stack
moves the whole mount to your process. Prefer
`createShadowPathPredicate()`, `nativeMounts.host(dir, { readonly, hide })`
and `ObjectProvider` options (`writable: false`) for policies.

### Mount Semantics Are Strict POSIX

Mounts served by the daemon follow Linux semantics closely: renames follow
POSIX rules (a file cannot replace a directory and so on) and hard links work
on mounts with hidden paths. Code that relied on looser behavior of a JS
provider may see errors such as `EISDIR` or `ENOTEMPTY`.

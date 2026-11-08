# Native Engine

Gondolin has two host engines that run the same guests with the same SDK and
CLI:

- **`native`** (the default when a `gondolind` binary is available): the VM
  is driven by `gondolind`, a small static Rust daemon.
  Your Node.js process (the *controller*) spawns it and talks to it over its
  stdin/stdout. The daemon starts QEMU (or the krun runner), speaks the guest
  protocols, runs the network stack and the HTTP/TLS mediation natively, and
  serves the guest filesystem from its own mount table, and calls back into
  the controller only for the things that must stay in JavaScript (your hooks,
  custom VFS providers).
- **`node`** (deprecated): the VM is driven from inside your Node.js process
  (QEMU child process, guest protocols, network stack, VFS). Used when no
  usable `gondolind` is available, or when selected with
  `GONDOLIN_ENGINE=node`. Selecting it explicitly prints a one-time
  `DeprecationWarning` (code `GONDOLIN_NODE_ENGINE`; `node --no-deprecation`
  silences it). It keeps working for now and will be removed in a later
  release.

The native engine exists for two reasons:

- **Remote machines.** `gondolind` needs neither Node.js nor any other
  runtime, so it can run on another machine (for example over SSH) while your
  policy, credentials, hooks and file providers stay in the local controller.
- **Speed.** Packets, TLS and protocol handling move out of JavaScript.

> The default engine is `auto`: `native` when a working `gondolind` binary is
> available for this machine, else `node`. `GONDOLIN_ENGINE=node` (or
> `--engine node`, `VMOptions.engine: "node"`) still selects the node engine,
> but it is deprecated.
> The differences that remain are listed
> [below](#differences-from-the-node-engine).

## Selecting the Engine

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({ engine: "native" });
```

| Setting | Effect |
| --- | --- |
| `VMOptions.engine: "node" \| "native" \| "auto"` | engine for this VM (`node` is deprecated) |
| `GONDOLIN_ENGINE=node\|native\|auto` | default when `engine` is not given (unset: `auto`; `node` is deprecated) |
| `auto` | `native` when a native engine binary is available for this machine and runs (`gondolin daemon --version`), else `node` (with `GONDOLIN_DEBUG` set, the reason is logged) |
| `VMOptions.native` with `command`, `connect` or `remote` | implies `native` |

The native engine ships as one multi-call binary, `gondolin`: the
[static CLI](./cli.md#static-cli-no-nodejs), and the daemon when started as
`gondolin daemon` (or under the name `gondolind`, e.g. through a symlink). The
SDK starts the daemon from whichever binary it finds, in this order:

1. `GONDOLIN_NATIVE_BIN` (path to `gondolin` or `gondolind`)
2. a development checkout: the newest of `native/target/{release,debug}/gondolin`
   and `native/target/{release,debug}/gondolind`
3. the optional dependency for the platform:
   `@earendil-works/gondolin-native-darwin-arm64`, `-darwin-x64`,
   `-linux-arm64` or `-linux-x64` (Linux builds are static musl binaries),
   installed automatically with `@earendil-works/gondolin` where supported;
   its npm `bin` links the binary as `gondolind`

QEMU (or the krun runner for `vmm: "krun"`) is still needed on the machine the
daemon runs on, exactly as for the node engine.

### CLI

The engine options go before the command and apply to everything the command
starts (including `bash --resume`, `--listen` and `--ssh`):

```bash
gondolin --engine native bash
gondolin --engine auto exec -- uname -a
gondolin --native-command "ssh build-box gondolind" --remote bash
```

| Flag | Meaning |
| --- | --- |
| `--engine node\|native\|auto` | host engine (default: `$GONDOLIN_ENGINE`, else `auto`; `node` is deprecated) |
| `--native-command CMD` | start `gondolind` with `CMD` (words, or a JSON array); implies `native` |
| `--remote` | the daemon runs on another machine (see below); implies `native` |

`gondolin list`, `attach` and `exec --sock` work for sessions of either engine:
the session registry lives in the controller.

## Remote Daemons

`VMOptions.native` says how to reach the daemon:

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  native: {
    command: ["ssh", "build-box", "gondolind"],
    remote: true,
    image: "alpine-base:latest",
  },
});
```

| Option | Meaning |
| --- | --- |
| `command` | command that starts `gondolind` with the controller protocol on its stdin/stdout |
| `connect()` | returns a [connection](#connections) (wins over `command`) |
| `remote` | the daemon runs on another machine: no shared filesystem |
| `image` | image selector for the daemon (`name:tag`, build id, or a directory on the daemon's machine); default: the daemon's default image |

The same settings are available as environment variables:
`GONDOLIN_NATIVE_COMMAND` (words or a JSON array), `GONDOLIN_NATIVE_REMOTE=1`
and `GONDOLIN_NATIVE_IMAGE`.

### What `remote` changes

With `remote: true` the controller never sends paths of its own machine to the
daemon (it refuses to, so mistakes fail loudly instead of pointing at the wrong
files):

- **Images** are resolved and downloaded by the daemon from its own image
  cache (the same layout as on a local machine, `~/.cache/gondolin/images`).
  `sandbox.imagePath` must be a selector string; explicit asset paths are
  rejected.
- **Root disks** are prepared by the daemon: the `rootfs.mode` (`cow`,
  `memory`, `readonly`, or the image manifest's default) and `rootfs.size`
  work as usual, the copy-on-write overlay lives in the daemon's session
  directory.
- **Checkpoints** (`vm.checkpoint()`, `gondolin snapshot`) are written on the
  controller in the usual single-file format: the daemon stops the VM and
  streams its disk overlay. Resuming uploads the checkpoint to the daemon,
  which finds the matching image by build id.
- **TLS interception** uses the daemon's own MITM CA (created and cached on
  the daemon's machine); the guest trusts that one.
- **VFS mounts** of controller-side directories (`RealFSProvider`, also
  wrapped in `ReadonlyProvider`/`ShadowProvider`) are served from the
  controller through the object tier (see [Filesystem](#filesystem)), since
  the daemon cannot see those files. To mount a directory on the daemon's
  machine, use `nativeMounts.host("/path/on/daemon")`.
- **SSH egress** credentials (`ssh.credentials`) are sent to the daemon;
  `ssh.agent` is not supported remotely (the agent socket is on the
  controller). `known_hosts` files are read by the controller and sent as
  content.
- **DNS**: the controller's resolvers are not used; the daemon uses explicitly
  configured servers or its own `/etc/resolv.conf`.
- **SSH and ingress access** (`vm.enableSsh()`, `vm.enableIngress()`,
  `--listen`) listen on the controller's machine; the streams are tunneled
  through the daemon connection.
- `vm.getHostPid()` returns `null` (the VMM runs on another machine).
- Not supported remotely (clear errors): `sandbox.rootDisk*` options and the
  `sandbox.virtio*SocketPath` overrides.

### Connections

`connect()` returns an object with this shape (`NativeConnection`); pi-env's
`openProcess` returns a compatible object, and `spawnNativeConnection(command)`
builds one from a local command:

```ts
type NativeConnection = {
  /** write to the daemon's stdin; `false` or a pending promise means "buffer full" */
  write(data: Buffer): boolean | void | Promise<unknown>;
  /** daemon stdout */
  onStdout(listener: (data: Buffer) => void): void;
  /** daemon stderr (diagnostics, optional) */
  onStderr?(listener: (data: Buffer | string) => void): void;
  /** close the daemon's stdin: it stops the VM and exits */
  close(): void | Promise<unknown>;
  /** resolves once the daemon exited */
  exited: Promise<{ code: number | null; signal?: string | null }>;
  /** optional: forcefully terminate, wait for write buffer drain, local pid */
  kill?(): void;
  waitDrain?(): Promise<void>;
  pid?: number | null;
};
```

```ts
const vm = await VM.create({
  native: {
    remote: true,
    connect: async () => env.openProcess("gondolind", []),
  },
});
```

The daemon exits (and kills its VM) when its stdin closes, so a crashed or
killed controller never leaves VMs running behind. On Linux QEMU is also tied
to the daemon's lifetime; on macOS a small watchdog process does the same.

### Getting the binary onto another machine

`getNativeBinaryPath({ platform, arch })` finds a binary for any supported
platform without network access (development checkout, installed platform
package, download cache). `ensureNativeBinary({ platform, arch })` also
downloads the matching platform package from the npm registry (checking its
integrity) into `~/.cache/gondolin/native/<version>/<platform>-<arch>/`. Both
return `{ path, args }`: the binary and the arguments that start the daemon
(`["daemon"]` for the multi-call `gondolin`), so one file is all a remote
machine needs:

```ts
import { ensureNativeBinary } from "@earendil-works/gondolin";

const { path, args } = await ensureNativeBinary({ platform: "linux", arch: "x64" });
// copy `path` to the remote machine (e.g. as ~/bin/gondolin), then
// native: { command: ["ssh", host, "~/bin/gondolin", ...args], remote: true }
```

The daemon also brings its own image tooling, which is handy on machines
without Node.js:

```bash
gondolind --version
gondolind assets list
gondolind assets pull alpine-base:latest
gondolind assets resolve --json
```

## Differences from the Node Engine

Behaviour visible to guests and SDK users is the same unless listed here.

**Network**

- Compressed upstream responses (`Content-Encoding: gzip`, ...) are forwarded
  to the guest unchanged. The node engine decodes them (it uses `fetch`) and
  sends the decoded body without `Content-Encoding`. Hooks see decoded bodies
  on both engines.
- The `Host` header is kept consistent with the request URL: for absolute-form
  request targets the URL wins over the guest's `Host` header, and redirects
  re-target `Host`.
- Hooks (`onRequest`, `onResponse`, `isRequestAllowed`, `isIpAllowed`) run in
  the controller and cost one round trip per registered phase. Request and
  response bodies are transferred only when a hook reads them; `clone()` reads
  independently instead of buffering a second copy. Hooks that are not
  registered cost nothing; policy from `createHttpHooks()` options
  (allowlists, internal ranges, secrets) is evaluated in the daemon.
- `VMOptions.fetch` is for asset downloads, as documented. The native engine
  never uses it for guest HTTP traffic (egress is always handled by the
  daemon); the node engine used it as its upstream client. Earlier versions
  switched the native engine to the node network stack when a custom `fetch`
  was given; they no longer do (behaviour change). To intercept or replace
  upstream requests, use `httpHooks` (`onRequest` may return a `Response`).
- `GONDOLIN_NATIVE_NET=external|relay` (internal, deprecated): runs the node
  network stack in the controller instead of the daemon's. For debugging
  only; it will be removed with the node engine.
- Upstream TLS certificates are verified against the controller's Node.js
  default CA store (including `NODE_EXTRA_CA_CERTS`), like the node engine's
  `fetch`; this also holds for remote daemons. The static `gondolin` CLI
  trusts the Mozilla CA list plus the system's PEM roots (`SSL_CERT_FILE` /
  `SSL_CERT_DIR`, the distribution bundle on Linux, `/etc/ssl/cert.pem` on
  macOS) and `NODE_EXTRA_CA_CERTS`. It does not read the macOS keychain: roots
  installed only there (e.g. a corporate TLS proxy's CA) need to be exported,
  e.g. `security find-certificate -a -p -c "My Corp CA" > ca.pem` and
  `NODE_EXTRA_CA_CERTS=ca.pem`.

**Filesystem**

The daemon serves the guest filesystem (`/data` and the bind mounts) from its
own mount table. `VMOptions.vfs.mounts` is translated per mount:

| Provider | Served by |
|---|---|
| `RealFSProvider(dir)` | the daemon, as a hardened host directory (local daemons) |
| `ReadonlyProvider(x)`, `ShadowProvider(x, { shouldShadow: createShadowPathPredicate(paths) })` | the daemon, as read-only / hidden-path rules around `x` |
| `nativeMounts.memory()` | the daemon, as an in-memory filesystem |
| `nativeMounts.host(dir, { readonly, hide })` | the daemon, a directory on the daemon's machine (also remote) |
| `createObjectMount(provider, options)` / `nativeMounts.object(...)` | the controller's `ObjectProvider`, cached by the daemon |
| anything else (`MemoryProvider`, custom providers, `ShadowProvider` with a custom predicate) | the controller's JS provider, through the object tier |

**Transport.** With a QEMU that supports vhost-user (`-device help` lists
`vhost-user-fs-pci`), the guest mounts the tree over **virtio-fs**: the guest
kernel talks to the daemon directly through shared memory, which makes
metadata operations about 2–4× and large reads and writes 10–15× faster than
sandboxfs (FUSE in the guest, forwarded over a virtio-serial port). Linux
distribution QEMU builds support it; Homebrew's QEMU on macOS does not
(`native/crates/gondolin-virtiofs/examples/linux-guest/build-qemu-macos.sh`
builds one). Without it, and with krun, the guest uses sandboxfs as before.
`GONDOLIN_VIRTIOFS=0` forces sandboxfs, `GONDOLIN_VIRTIOFS=1` asks for
virtio-fs and logs a warning when it is unavailable. Guest images older than
this version always use sandboxfs.

Native mounts cost no controller round trips. Host directories keep the
`RealFSProvider` hardening: nothing resolves outside the directory (with
`openat2(RESOLVE_BENEATH)` on Linux and a component-wise `O_NOFOLLOW` walk
elsewhere), escaping or dangling symlinks behave as missing, and setuid/setgid
bits are dropped on `chmod`.

The **object tier** keeps your JS provider the source of truth: the daemon
serves file handles, offsets and attributes from a cache and calls the
provider with whole-file operations (`stat`, `readDir`, `readFile` ranges,
`writeFile`, `unlink`, `rename`, `mkdir`, ...). For ordinary `VirtualProvider`s
(a `MemoryProvider` you also use from the host, custom providers) every guest
write is forwarded before the write returns, metadata is cached for 1 s (as
the guest kernel does anyway) and contents are revalidated on every open, so
changes made on the host are seen like on the node engine. Each uncached
operation is one round trip to the controller, so metadata-heavy work on such
mounts is slower than on the node engine; prefer native mounts for scratch
space.

For providers that naturally work on whole files (APIs, object stores),
implement `ObjectProvider` and mount it with `createObjectMount()`:

```ts
import { VM, createObjectMount, nativeMounts, type ObjectProvider } from "@earendil-works/gondolin";

const notes: ObjectProvider = {
  async stat(path) { /* { kind: "file" | "dir" | "symlink", size, mode?, mtimeMs? } */ },
  async readDir(path) { /* [{ name, kind }] */ },
  async readFile(path, range) { /* bytes (the range or the whole file) */ },
  async writeFile(path, data, { mode }) { /* replace the whole file */ },
  // optional: unlink, rename, mkdir, rmdir, truncate, chmod, symlink, readlink, link, write
};

const vm = await VM.create({
  engine: "native",
  vfs: {
    mounts: {
      "/notes": createObjectMount(notes, { cacheTtlMs: 5000, commit: "close" }),
      "/scratch": nativeMounts.memory(),
      "/srv": nativeMounts.host("/srv/project", { readonly: true, hide: ["/.env"] }),
    },
  },
});
```

Options: `writable` (default: when `writeFile` exists), `enumeration`
(`"list"`, `"materialized"`: only entries the guest has seen, `"none"`),
`commit` (`"close"`: the whole file is written when the guest closes it, the
default; `"write"`: every write is forwarded), `cacheTtlMs`,
`revalidateOnOpen`, `maxCacheBytes` and `maxFileBytes`. Large files are read
lazily in 1 MiB ranges and written back in 1 MiB chunks of one `writeFile`. On
the node engine the same mount works through `ObjectVirtualProvider` (files
are read on open and written back on close).

`vm.fs` reads and writes daemon-only mounts (`nativeMounts.memory()`,
daemon-side host directories, object mounts) through the daemon; this starts
the VM if it is not running. Other paths use your JS providers directly, as on
the node engine.

Differences from the node engine:

- **VFS hooks** (`vfs.hooks`): `before` hooks run as on the node engine but
  cost a round trip per hooked operation (only when you register one); `after`
  hooks are called asynchronously, after the guest got its reply, and their
  `result` is the error or the transferred byte count instead of the node
  objects.
- **Close errors**: with `commit: "close"` over virtio-fs, a failing
  `writeFile` is the error of the guest's `close()` or `fsync()`. Over
  sandboxfs (no vhost-user QEMU, krun) it cannot be: the guest's FUSE helper
  does not forward those calls. The data then stays cached and is written
  again when the next writer closes the file; the failure is reported as an
  error of the `release` operation (debug output and `after` hooks).
- **Stricter native mounts**: hard links work on mounts with hidden paths,
  a read-only `MemoryProvider` translated to a static mount rejects every
  write, and in-memory renames follow POSIX rules (a file cannot replace a
  directory and so on).
- `GONDOLIN_NATIVE_VFS=controller` (internal, deprecated) forwards every
  guest filesystem operation to the controller's JS providers as the node
  engine serves them. For debugging only; it will be removed with the node
  engine.

**Errors and diagnostics**

- Some configuration errors are reported when the VM starts rather than when
  `VM.create()` returns, because the daemon validates them on its machine (for
  example SSH credential files, a missing QEMU binary, an unknown image).
- Explicit `sandbox.virtio*SocketPath` options are rejected (the daemon owns
  its private socket directory).
- Error messages surfaced to callers are the same; debug output is equivalent
  but not byte-identical.

**Process model**

- The VMM runs under the daemon (controller → `gondolind` → QEMU). Starting a
  VM costs one extra process spawn and handshake (a few milliseconds).
- `SandboxServer`, if you construct it directly, is always the node engine.

## Troubleshooting

**`native engine binary not found`**: build it (`make -C native release` or
`cargo build -p gondolin-cli` in a checkout), install the platform package, or
set `GONDOLIN_NATIVE_BIN`. The
default (`auto`) falls back to the node engine on machines without a usable
binary; this error only appears when `native` is selected explicitly.

**`not supported by the native engine yet: ...`** or **`not supported with a
remote native daemon: ...`**: the option cannot be honoured; the message names
it.

**`remote native session must not send a controller-local path`**: in remote
mode something resolved to a path on the controller (typically
`sandbox.imagePath` pointing at a local directory). Use an image selector the
daemon can resolve, or the daemon's own default image.

**Debug output**: `GONDOLIN_DEBUG` (or `VMOptions.sandbox.debug`) works as for
the node engine (`net`, `exec`, `vfs`, `protocol`, `all`, see
[Debug Logging](./debug.md)). The flags are passed to the daemon, which
forwards its events (QEMU output with `protocol`, network tracing with `net`)
to your debug callback. Lines the daemon writes to its stderr arrive as the
`error` component prefixed with `gondolind:`.

**Inspecting the daemon**:

```bash
# QEMU command line the daemon would use for a configuration (JSON on stdin)
echo '{"vm": {"qemu_path": "qemu-system-aarch64", "kernel_path": "/k", "initrd_path": "/i", "memory": "1G", "cpus": 2}}' \
  | gondolind --qemu-args

# load or create the MITM CA in a directory and print its certificate
gondolind --mitm-ca ~/.cache/gondolin/ssl
```

For the protocol between controller and daemon and the internals, see
[`native/DESIGN.md`](https://github.com/earendil-works/gondolin/blob/main/native/DESIGN.md).

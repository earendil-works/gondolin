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
| `--native-command CMD` | start the daemon with `CMD` (words, or a JSON array); implies `native` |
| `--remote` | the daemon runs on another machine (see below); implies `native` |

`gondolind` is the npm `bin` name the platform package installs; where only
the binary was copied, start it as `gondolin daemon` (for example
`--native-command "ssh build-box ~/bin/gondolin daemon"`).

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
    // `env`: a pi-env environment (or anything returning a NativeConnection)
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
without Node.js (`gondolind ARGS` is the same as `gondolin daemon ARGS`; the
static CLI's `gondolin image` manages the same cache):

```bash
gondolin daemon --version
gondolin daemon assets list
gondolin daemon assets pull alpine-base:latest
gondolin daemon assets resolve --json
```

## Differences from the Node Engine

Behaviour visible to guests and SDK users is the same unless listed here.

### Network

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
  (allowlists, internal ranges, secrets) is evaluated in the daemon, and
  `createDjsHooks()` policies run in the daemon too (see
  [Tier-2 Hooks](#tier-2-hooks)).
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

### Filesystem

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
virtio-fs and logs a warning when it is unavailable. Guest images whose
`sandboxfs` has no `--virtiofs` option (built before this release) always use
sandboxfs.

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
  async writeFile(path, data, options) { /* replace the whole file (options?.mode) */ },
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

### Errors and diagnostics

- Some configuration errors are reported when the VM starts rather than when
  `VM.create()` returns, because the daemon validates them on its machine (for
  example SSH credential files, a missing QEMU binary, an unknown image).
- Explicit `sandbox.virtio*SocketPath` options are rejected (the daemon owns
  its private socket directory).
- Error messages surfaced to callers are the same; debug output is equivalent
  but not byte-identical.

### Process model

- The VMM runs under the daemon (controller → `gondolind` → QEMU). Starting a
  VM costs one extra process spawn and handshake (a few milliseconds).
- `SandboxServer`, if you construct it directly, is always the node engine.

## Tier-2 Hooks

Hooks normally run in your Node process: the daemon sends each registered
phase to the controller and waits for the answer (tier 3). A **tier-2 policy**
is self-contained JavaScript that the daemon runs itself, on djs (Earendil's
embeddable JavaScript engine, compiled into `gondolind`). It needs no
controller round trip, so it also works with the static `gondolin` CLI and
with remote daemons, and costs far less per request. The declarative
`createHttpHooks()` options (tier 1) remain the cheapest and should be
preferred for anything they can express.

```ts
import { VM, createDjsHooks, createHttpHooks } from "@earendil-works/gondolin";

const policy = `
const DENY = ["/admin", "/internal"];

async function onRequest(request) {
  const url = new URL(request.url);
  if (DENY.some((p) => url.pathname.startsWith(p))) {
    throw new HttpRequestBlockedError("path not allowed", 403);
  }
  if (request.method === "POST") {
    const body = await request.clone().text();
    if (body.includes("DROP TABLE")) return new Response("no", { status: 400 });
  }
  request.headers.set("x-sandbox", "gondolin");
}

function onResponse(response) {
  const r = new Response(response.body, response);
  r.headers.delete("server");
  return r;
}
`;

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.example.com"],
  secrets: { API_KEY: { hosts: ["api.example.com"], value: process.env.API_KEY! } },
  ...createDjsHooks(policy),
});
const vm = await VM.create({ httpHooks, env });
```

The static and Node CLIs take a policy file with `--hooks-script FILE`
(`.js` a script, `.mjs` an ES module, `.ts`/`.mts` a TypeScript module). For
modules, the CLI reads the files the policy imports with relative specifiers
(`./lib/hosts.ts`, `./deny.json`), transitively from next to the script, and
sends them along; the daemon itself never reads files. Bare specifiers and
imports above the script's directory are not resolved
(`djsHooksOptionsFromFile(file)` does the same for SDK users):

```bash
gondolin bash --allow-host api.example.com --hooks-script policy.js
```

**The contract.** A policy defines (script) or exports (module, `kind:
"module"` or `"typescript"`) any of `isRequestAllowed(request)`, `isIpAllowed(info)`,
`onRequest(request)` and `onResponse(response, request)`, with the same
meaning and return values as `HttpHooks` (see
[SDK: Network Access](./sdk-network.md)). Only the phases it defines are
registered, so a policy with only `onResponse` keeps the request fast path.
The environment offers `Request`, `Response`, `Headers`, `URL`,
`URLSearchParams`, `HttpRequestBlockedError`, `TextEncoder`/`TextDecoder`,
`atob`/`btoa`, `console` (written to the daemon log, visible with the `net`
debug flag) and the standard JavaScript built-ins. Bodies stay in the daemon
until the policy reads them (`text()`, `json()`, `bytes()`, `arrayBuffer()`);
an unread body costs nothing and is streamed through. As on the node engine,
forwarding a request whose body the hook consumed is refused (`400`): read
from `request.clone()`. Compressed responses (`gzip`, `deflate`) are decoded
for `onResponse`, as on tier 3.

`createDjsHooks()` options:

| option | meaning |
|---|---|
| `source` | the policy (or pass the source string directly) |
| `kind` | `"script"` (default), `"module"` or `"typescript"` (an ES module whose types are erased, not checked); modules need the native engine |
| `filename` | name in stack traces, the module's key (default `policy.js` / `policy.mjs` / `policy.ts`) |
| `modules` | `{ key: source }` a module policy can import (`./lib.js` resolves against `filename`); the key's extension picks the language: `.ts`/`.mts`/`.cts` TypeScript, `.json` a JSON module (`import deny from "./deny.json" with { type: "json" }`), else JavaScript. There is no file or network access: anything else must be bundled into the policy |
| `limits` | `{ fuel, memoryBytes, timeoutMs }` per call (defaults 50M fuel ≈ 0.2 s of interpretation, 64 MiB heap, 30 s wall clock including body reads) |

**Evaluation.** The daemon compiles the policy once, when the VM is
configured; a syntax error, a missing import or an exception at the top level
fails `VM.create()`/the CLI before boot. Every call then starts from that
compiled state: globals a call changes are gone in the next call, nothing is
shared between requests or VMs. Builtins are frozen. `Date.now()` is the
daemon's clock at the start of the call.

**Fail closed.** An exception, a rejected or never-settling promise,
exhausting fuel, memory or time, a malformed return value (an invalid header,
a non-HTTP URL, a bad status) or an engine error deny the request with
`502 Bad Gateway`, like a throwing tier-3 hook. `HttpRequestBlockedError`
answers with its own status. The budgets cannot be caught by the policy.

**Order of tiers.** Declarative policy first (head validation, and for
policies without `onRequest` the early allowlist/internal-range check), then
tier 2, then tier 3, in every phase: `isRequestAllowed`/`isIpAllowed` must
allow in both (the first denial wins), `onRequest` of tier 3 sees the request
as tier 2 left it (including a replaced body), and a tier-2 `Response` or
block ends the phase. Secrets are substituted after all `onRequest` hooks, so
hooks see placeholders, not secret values, and placeholders a hook adds are
substituted too. The allowlist and internal-range checks run again on the
rewritten request.

**Restrictions** compared with Node hooks:

- No closures over your program's state, no Node or npm APIs (`fs`,
  `process`, `Buffer`, `require`): state comes from the source (generate it
  with your configuration) or from `modules`.
- No outbound I/O: no `fetch()`, timers (`setTimeout`), `AbortSignal`,
  `crypto.subtle` or `crypto.randomUUID`.
- No streams: bodies are whole values within the body limits and the policy's
  heap; `request.body`/`response.body` is an opaque handle that can only be
  passed on (`new Response(response.body, response)` keeps the original body),
  and `formData()`, `blob()` and `ReadableStream` are missing. Fetch-only
  `Request` fields (`signal`, `cache`, `mode`, `credentials`, ...) are absent.
- `instanceof` checks against Node's own classes do not apply; `URL`,
  `Headers` and friends are the daemon's implementations (URLs parse exactly
  as egress parses them).
- On the node engine a script policy runs in a `node:vm` context with Node's
  own fetch classes (the same contract; globals persist between calls there);
  module policies need the native engine. A daemon without tier-2 support
  (older releases, or built without the `djs-hooks` feature) refuses such a
  configuration instead of ignoring it.

Typical cost on an Apple M5 Max (shared machine; `host/bench`, guest-measured
per request): a no-op `onRequest`/`onResponse` pair adds about 0.23 ms per
request as tier 2 against 0.29 ms as tier 3 (0.58 ms on the node engine), a
policy reading 32 MiB bodies keeps ~415 MB/s downloads (tier 3: ~325 MB/s).
In process, an empty call is ~8 µs and a header allowlist policy ~38 µs
(`cargo run --release -p gondolin-hooks-djs --example bench`); research notes
and engine details are in `native/docs/djs-hooks.md`.

## Troubleshooting

**`native engine binary not found`**: build it in a checkout (`make native`,
or `cargo build --release -p gondolin-cli` in `native/`), install the platform
package, or set `GONDOLIN_NATIVE_BIN`. The
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

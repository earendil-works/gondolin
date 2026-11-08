# gondolind: native host engine

Status: design for the native host engine (September 2026). `PLAN.md` tracks the
milestones and their state. This document is normative for the interfaces between
the pieces; change it together with the code.

## Why

Gondolin's host side (VM lifecycle, guest protocols, userspace network stack,
HTTP/TLS mediation, VFS) is ~42k lines of TypeScript that need Node. We want to
run Gondolin on machines without Node, most importantly remote machines bootstrapped
by pi-env (`pi-mono/packages/env`) over SSH, where the agent's controller,
credentials and storage stay local. We also want the hot paths (packets, TLS,
file operations) out of JavaScript.

## Shape

```
 controller (Node, TS SDK)                     gondolind (static Rust binary)
 ┌─────────────────────────┐   stdio pipe    ┌───────────────────────────────────┐
 │ VM API, exec, vm.fs     │ ─────────────── │ session: QEMU lifecycle, sockets  │
 │ NativeSandboxServer     │  (local, or     │ guest control (sandboxd protocol) │
 │ policy compiler         │   over SSH via  │ VFS: native tier + object cache   │
 │ tier-3 hook callbacks   │   pi-env        │ net: L2-L4 stack, DNS, DHCP       │
 │ object-tier providers   │   openProcess)  │ egress: HTTP/TLS MITM, policy,    │
 └─────────────────────────┘                 │   secrets, (later djs hooks)      │
                                             └──────────┬────────────────────────┘
                                                        │ unix sockets / chardevs
                                                   QEMU + unchanged guest
```

- **One binary for local and remote.** The Node SDK spawns `gondolind` as a child
  process (esbuild-style; shipped later through per-platform optional
  dependencies like the krun runner packages). pi-env starts the same binary on
  the remote machine with `openProcess` and the SDK talks to it over that pipe.
- **The guest does not change.** `gondolind` implements the host side of the
  existing guest protocols exactly as specified in `guest/ARCHITECTURE.md`
  (sandboxd control port, sandboxfs RPC, TCP forwarders) and of QEMU's stream
  netdev.
- **The TypeScript in-process engine stays** as `engine: "node"` until the native
  engine reaches parity; then the default flips. Both engines run the same test
  suite (`GONDOLIN_ENGINE=native`).
- **Configure once, little code per byte.** Network policy and VFS mounts are
  declarative data compiled by the controller and evaluated natively. Programmable
  JS hooks remain available but are called only when registered, only for the
  phases they declare, and never on a per-packet or per-FUSE-op basis.

## Engine selection (TypeScript side)

- `VMOptions.engine?: "node" | "native"`; default from `GONDOLIN_ENGINE`, else
  `"node"`.
- Binary resolution (`host/src/native/binary.ts`): the packages ship one
  multi-call binary, `gondolin` (static CLI; `gondolin daemon` or argv[0]
  `gondolind*` is the daemon); `nativeDaemonArgs(path)` gives the arguments
  for a path (`["daemon"]` unless it is named `gondolind`). Order:
  `GONDOLIN_NATIVE_BIN` (either name), else in a dev checkout the newest of
  `native/target/{release,debug}/{gondolin,gondolind}` (by mtime, so a stale
  build never shadows a fresh one), else the optional dependency
  `@earendil-works/gondolin-native-<platform>-<arch>` (`bin/gondolin`;
  darwin-arm64, darwin-x64, linux-arm64, linux-x64; Linux builds are static
  musl). Packages are built by `make native-release` and staged with
  `scripts/prepare-native-package.mjs`; release builds use fat LTO (12%
  smaller than thin at the same throughput; `opt-level = "s"` would save
  another 25% but costs ~20% HTTPS throughput).
- Remote hosts (pi-env): `getNativeBinaryPath({ platform, arch })` finds a
  binary for another platform without network (checkout
  `native/target/dist/<rust-target>/`, installed package, download cache);
  `ensureNativeBinary({ platform, arch })` additionally fetches the platform
  package from the npm registry (integrity-checked) into
  `~/.cache/gondolin/native/<version>/<platform>-<arch>/`, since package
  managers only install the host's optional dependency. Both return
  `{ path, args }` (the daemon command), so a remote machine needs one file.
- `host/src/native/` contains the native engine client:
  - `server.ts`: `NativeSandboxServer`, implementing the surface `VM` uses from
    `SandboxServer` (`start`, `close`, `connect`, `getState`, `openTcpStream`,
    events `debug`/`log`/`state`/`exit`/`error`, `getVmmBackend`, `getVmmPath`,
    `getHostPid`). `vm/core.ts` picks the class by engine.
  - `transport.ts`: process spawning, framing, request/response correlation,
    a handler registry keyed by message type.
  - `config.ts`: turns resolved options into the `configure` message.
  - `vfs.ts`: mount translation, object-tier provider service, controller fs API.
  - `net.ts`: policy compilation, tier-3 hook service.
- Options the native engine cannot honour fail at `VM` construction with
  `not supported by the native engine yet: <option>` (explicit
  `sandbox.virtio*SocketPath`: the daemon owns its private socket directory).
  Both VM backends (`qemu`, `krun`) are supported.
- `host/scripts/test-native.sh` (`pnpm test:native`) builds `gondolind` and runs
  the host tests on the native engine (`all` runs the whole suite).

### Remote sessions

`VMOptions.native: { command?, connect?, remote?, image? }` says how to reach
the daemon: the local binary by default, `command` (e.g. `["ssh", host,
"gondolind"]`), or `connect()` returning a `NativeConnection` (`write`,
`onStdout`, `onStderr?`, `close`, `exited`, optionally `kill`/`waitDrain`;
pi-env's `openProcess` has this shape). Giving any of them selects the native
engine. Environment: `GONDOLIN_NATIVE_COMMAND` (JSON array or words),
`GONDOLIN_NATIVE_REMOTE=1`, `GONDOLIN_NATIVE_IMAGE`.

With `remote: true` the controller never sends paths of its own machine
(`assertRemoteConfigure` checks the whole `configure` payload against the
controller's temp, cache, home and working directories):

- the image is a selector (`native.image`, else a string `sandbox.imagePath`,
  else the daemon's default image) resolved by the daemon (`vm.image`);
- the root disk is prepared by the daemon (`root_disk.mode` cow/memory/
  readonly/auto and `size`, qcow2 overlay in the session directory via
  `qemu-img`); `rootfs.size` still grows the filesystem in the guest;
- the VMM binary is checked by the daemon at `start`; `getHostPid()` is `null`
  (`getVmmPid()` has the daemon-side pid);
- the network uses `net: { mode: "relay" }`: the netdev stream is relayed over
  the connection to the node network stack in the controller (credit window
  1 MiB towards QEMU), until native networking replaces it;
- VFS goes through the controller (`vfs_rpc` now, the object tier later):
  controller-local providers (`RealFSProvider`, ...) can never become native
  `host` mounts when remote;
- SSH and ingress keys and listeners stay in the controller (they serve the
  controller's user), streams use `fwd_*`;
- checkpoints stay controller-side files in node's format (qcow2 + JSON
  trailer): `vm.checkpoint()` asks the daemon to stop the VM and stream its
  overlay (`checkpoint_export`) and appends the trailer locally (build id from
  `configure_result.image`); `VmCheckpoint.resume()` on a remote engine uploads
  the file before boot (`checkpoint_import`, `root_disk.mode = "checkpoint"`),
  the daemon rebases it onto its copy of the image (resolved by build id; the
  daemon's local default image counts when its build id matches) and boots it
  below a fresh overlay. The CLI's `snapshot`/`bash --resume` work the same
  way;
- not supported remotely (clear errors): `sandbox.rootDisk*`, socket path
  overrides, `imagePath` with explicit asset paths.

`host/scripts/test-native-remote.sh` proves this on one machine: the daemon
runs through `scripts/gondolind-remote-sim.sh` (empty environment, its own
`HOME`, `XDG_CACHE_HOME`, `TMPDIR` and working directory, the guest image
"installed" via `GONDOLIN_GUEST_DIR` on that side) and the exec, VFS, network,
SSH, ingress, clock-sync and backend-parity (qemu + krun) tests run against it.

### CLI

`gondolin [--engine node|native] [--native-command CMD] [--remote] <command>`:
the global flags set `GONDOLIN_ENGINE`, `GONDOLIN_NATIVE_COMMAND` and
`GONDOLIN_NATIVE_REMOTE` for the process, so every command (`exec`, `bash`
incl. `--listen`/`--ssh`/`--resume`, `snapshot`, and `list`/`attach`/
`exec --sock` through the session registry) uses the selected engine;
`--native-command`/`--remote` imply `native`. `test/cli-vm.test.ts` runs the
CLI against real VMs on whichever engine is selected (part of
`test-native.sh` and `test-native-remote.sh`).

### Flipping the default engine

The default is `DEFAULT_SANDBOX_ENGINE` in `host/src/native/config.ts`
(`GONDOLIN_ENGINE`/`VMOptions.engine` override it). It is now `"auto"`:
native when `resolveNativeBinary()` finds a binary and `gondolind --version`
runs, else node (a broken binary falls back with a `GONDOLIN_DEBUG` log line);
`GONDOLIN_ENGINE=node` restores the old default. The notes below were written
before the flip. `pnpm test:both`
(`scripts/test-both.sh`) runs the whole host suite on both engines; at the
time of writing both pass 701/712 with the same 11 skips. What still differs
or needs a decision before the flip:

1. VFS: the native engine forwards every sandboxfs op to the controller
   (`vfs_rpc`, one pipe round trip per FUSE op) until the native VFS modes
   land; functionally identical (same `FsRpcService`), slower for metadata-
   heavy workloads.
2. Network: served by the node network stack in the controller (`external`
   socket locally, `relay` remotely) until native egress lands; identical
   behaviour, one more process hop.
3. Binary availability: the native engine needs a `gondolind` for the
   platform (dev build or `@earendil-works/gondolin-native-*`). Engine
   `auto` (`GONDOLIN_ENGINE=auto`, `--engine auto`) already means "native
   when `resolveNativeBinary()` succeeds, else node"; the flip is setting
   `DEFAULT_SANDBOX_ENGINE = "auto"`, so platforms without a package keep
   working.
4. `SandboxServer` stays the node engine for users who construct it directly;
   `NativeSandboxServer` is not exported yet (export it, or keep the server
   classes internal, with the flip).
5. Explicit `sandbox.virtio*SocketPath` options are rejected by the native
   engine (the daemon owns its private socket directory); they are internal
   knobs, deprecate them with the flip.
6. Diagnostics: debug output is equivalent but not byte-identical (daemon
   stderr lines arrive as `error` debug events; `log` events of QEMU and the
   protocol are ported); error messages surfaced to callers are identical.
7. Process model: the VMM is a grandchild (controller → gondolind → QEMU). The
   daemon kills QEMU when its stdin closes (controller exit or crash), via
   `PR_SET_PDEATHSIG` on Linux and the watchdog on macOS if the daemon dies;
   startup costs one process spawn and handshake (a few ms).
8. The krun Hypervisor entitlement check and `qemu-img` overlays still run in
   the controller for local sessions (remote sessions do both daemon-side).
9. Benchmarks for both engines live in `host/bench/results/`; the flip should
   wait for the native VFS/egress numbers.

## Rust workspace (`native/`)

| crate | role | owns |
|---|---|---|
| `gondolin-wire` | `u32` BE length + CBOR framing, own data model (`Value`), CBOR and JSON codecs, `ToValue`/`FromValue` with declarative macros, async frame reader/writer | shared by everything |
| `gondolin-log` | logging facade (`error!`/`warn!`/`debug!`/`trace!`, one process sink) | shared by everything |
| `gondolin-proto` | controller ⇄ daemon message types (`session`, `exec`, `vfs`, `net` modules) | protocol |
| `gondolin-vfs` | host side of the sandboxfs RPC, mount table, native providers, object-tier cache | filesystem |
| `gondolin-netstack` | Ethernet/ARP/DHCP/IPv4/ICMP/UDP-DNS/TCP; yields guest TCP flows as byte streams | packets |
| `gondolin-http` | HTTP/1.1: sans-io heads/framing/chunked codec, tokio server and pooled client (100-continue, upgrades), rustls stream adapter; used by egress, assets and the CLI's ingress gateway | HTTP |
| `gondolin-egress` | stream classification, HTTP/1.1 bridging, TLS MITM, WebSockets, policy, secrets, hook dispatch (`ChainedHooks`: tier 2 before tier 3); later SSH egress and mapped TCP | upstream |
| `gondolin-hooks-djs` | tier-2 hooks: a JavaScript policy (`configure.net.djs_hooks`) as a `HookBackend` on djs-embed (shim, adapter, decision validation) | hooks |
| `gondolin-assets` | guest image resolution: refs/build ids/paths, builtin registry, shared image store, HTTPS downloads | images |
| `gondolin-sshproxy` | exec-only SSH egress: guest-facing SSH server per flow, upstream SSH client (known_hosts, agent/key auth, caps, timeouts) | upstream SSH |
| `gondolind` | binary: controller protocol, session, QEMU, guest control channel, wiring | glue |

Runtime: tokio (multi-thread). TLS: rustls with the `ring` provider (simple
static musl builds); MITM leaves and the daemon's CA are written by a small DER
encoder over ring (`gondolin_egress::x509`, mirrors `host/src/x509.ts`); URLs
are parsed by `gondolin_http::url` (WHATWG, special schemes). HTTP/1.1 (guest-facing server,
upstream client, asset downloads, ingress gateway): `gondolin-http`, our own
sans-io codec with thin tokio adapters (replaced hyper/reqwest, M8).
Static builds: `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`,
`aarch64-apple-darwin`, `x86_64-apple-darwin`, all from one machine with
`make native-release` (`native/scripts/build-release.sh`). The Linux targets
use `zig cc` (zig 0.17) as C compiler and linker via the wrappers in
`native/scripts/` and are checked to be fully static. `make native-test-linux`
(`native/scripts/test-linux.sh`) cross-compiles the workspace tests for the
host architecture's musl target and runs them inside a Gondolin VM (node
engine, repository mounted read-only at its host path), so Linux-only code
paths are tested on macOS; `native/scripts/test-linux.skip` lists tests that
cannot run there.

### Dependency diet conventions (PLAN.md M8)

The `gondolin` binary's third-party runtime crates are counted per release
target by `native/scripts/count-deps.sh` (`make -C native deps`, part of
`make check` and CI) against the budget in `native/deps-budget`, which is
lowered whenever the count drops. Conventions for new code:

- **Data:** `gondolin_wire::Value` (CBOR/JSON data model) and the `cbor` /
  `json` modules instead of serde/ciborium/serde_json. Typed messages use
  `wire_struct!` (records; per field `as "name"`, `= default`,
  `=> skip_if path`, `=> flatten`), `wire_enum!` (unit enums as strings),
  `wire_tagged!` (internally tagged enums) and `wire_encode!` (encode-only,
  borrowing); `value!({...})` builds values like `json!`. `Option` fields are
  omitted when `None`, `Vec<u8>` is a byte string. Guest channels decode with
  `decode_guest` (the §3.3 subset: `i64` integers, no floats/tags);
  `json::to_string_pretty` is byte-identical to `JSON.stringify(v, null, 2)`
  (tested against node). No serde, no proc-macro crates in the binary.
- **Logging:** `gondolin_log::{error, warn, debug, trace}!` (format syntax,
  optional `target:`); gondolind installs the sink with the `net` debug flag
  and forwards `gondolin*` targets as `log` messages.
- **Async traits:** object-safe traits return `BoxFuture<'a, T>`
  (`gondolind::BoxFuture`) instead of `#[async_trait]`; errors implement
  `Display`/`Error` by hand (no thiserror).
- **First-party engines:** djs (Earendil's JavaScript engine, git dependency
  pinned by revision: djs-embed, djs-core, djs-prelude, djs-libm) is reported
  separately by `count-deps.sh` (matched by its git source) and not counted
  against the budget; it has no third-party dependencies of its own.
- **Runtime:** tokio with `rt`, `rt-multi-thread`, `net`, `time`, `sync`,
  `io-util` (workspace); `macros` only in dev-dependencies (use
  `gondolind::util::{select2, join2}` or `poll_fn` instead of `select!`).
  Child processes are watched by std threads (`vmm.rs`), CLI signals go
  through a self-pipe (`gondolin-cli/src/signals.rs`).

### gondolind internals and subsystem seams

`gondolind` is a library plus a thin binary. One session actor task
(`session.rs`, with `exec.rs`, `files.rs`, `idle.rs`) owns all session state and
is a port of `SandboxServer` + `SandboxController`; helper tasks (guest channel
readers/writers, the QEMU process, QMP commands, timers) only post events to it,
which preserves the node engine's ordering. Guest channels (`guest.rs`) have
`VirtioBridge` semantics: whole-frame outbox with a size limit, "writable"
notifications, a new connection replaces the old one, oversized/undecodable
frames disconnect. Producers towards the controller wait for the controller
queue to drain below 8 MiB before reading more guest input (no unbounded
buffers between guest and controller).

Integration points for the VFS and network subsystems (`subsystem.rs`):

- `configure.vfs` / `configure.net` are opaque CBOR values; `build_vfs()` /
  `build_net()` turn them into backends, dispatching on `mode`. Subsystems add
  their native modes there.
- `trait VfsBackend { async fn handle(&self, op: &str, req: Value) -> FsReply;
  async fn close(&self) }`: the core owns the `virtio-fs` channel and the
  framing, answers the boot-configuration op `mounts` itself, resumes an
  idle-paused VM and accounts the request as guest activity; every other
  sandboxfs op goes to the backend (one request at a time per connection).
  No backend: `ENOSYS` (node engine with `vfs: null`).
- `trait NetBackend { async fn serve(&self, stream: UnixStream); async fn close(&self) }`
  (`NetSetup::Native`): the core listens on `net.sock` in the private socket
  directory, QEMU's stream netdev connects there and each connection is served
  by `serve` (a reconnect aborts the previous call).
- `SubsystemContext { ctl, dispatcher, activity, debug }`: `ctl.request(t, p)`
  sends a daemon→controller request and awaits `<t>_result`;
  `dispatcher.register(t, Arc<dyn ControllerHandler>)` routes controller
  messages of new types to the subsystem (handlers run on the reader task and
  must not block); `activity.set(source, active)` keeps the VM from being
  idle-paused.

TS side: `NativeTransport.handleRequest(t, handler)` serves daemon→controller
requests (`<t>_result` is sent from the handler's result or exception),
`onMessage(t, handler)` receives unsolicited daemon messages, and
`request(t, p, { onEvent })` correlates controller requests including events
sent with the same id before the result.

Interim modes (until the native subsystems land; local sessions only):

- `vfs: { mode: "controller" }`: sandboxfs requests are forwarded as
  `vfs_rpc { op, req }` → `vfs_rpc_result { ok, err, res?, message? }` and
  served by the node engine's `FsRpcService` over the JS providers, so all
  VFS features keep working (one pipe round trip per FUSE op).
- `net: { mode: "external", socket_path }`: QEMU's netdev connects to a socket
  served by the node engine's `QemuNetworkBackend` in the controller; the
  controller reports its flows as `activity { source: "net", active }`.
  Fallback only (`GONDOLIN_NATIVE_NET=external`, or a custom `fetch` option):
  the default is `net: { mode: "native", ... }` (see "Network").

### Panics

Release builds unwind (`panic = "unwind"`); `gondolind/src/panics.rs` decides
what a panic costs:

- **contained, per flow:** a panicking guest TCP flow handler (egress, SSH
  proxy, mapped TCP) resets that connection (`NetTcpStream`'s drop aborts the
  socket while unwinding, `spawn_flows` also aborts via `FlowControl`); the
  flow table entry and the activity counters are released by the normal drop
  path, other flows are unaffected;
- **contained, per request, with an error reply:** guest channel frame
  handlers (the channel is reset), sandboxfs requests (`EIO`), controller
  message handlers (`<t>_result` with `internal_error`), body pulls, forwarder
  streams (`fwd_close`), image resolution, checkpoint export;
- **fail closed:** the session task (single owner of exec/file/VM state) and
  the network stack driver: kill the VMM, send `exit { error }` and an
  `error`, exit the daemon (status 70).

The panic hook logs every panic to stderr and as `log { component: "error" }`.
Debug builds with `GONDOLIND_TEST_PANICS=1` inject panics for tests (a guest
flow to port 9, a sandboxfs lookup of `gondolind-test-panic`, an exec of
`gondolind-test-panic`; `hello.features` then lists `test_panics`). Unwinding
costs about 1.6 MB of binary size (7.5 → 9.1 MB on aarch64-apple-darwin).

### Seams between crates

These traits are the integration points; they live in each crate's `lib.rs`.
Changing them requires updating every implementor (coordinate through PLAN.md).

- `gondolin-vfs`:
  - `VfsService::new(config: &VfsConfig, backend: Arc<dyn ObjectBackend>, events: EventSink)`
    builds the mount table of `configure.vfs`; `VfsService::request(op, req)`
    answers one sandboxfs request (gondolind's `VfsBackend` seam: core owns the
    port, framing and the `mounts` op); `VfsService::serve(stream)` serves a
    whole stream (tests, embedders).
  - `ObjectBackend { call(VfsCall) -> VfsCallResult; before_hook(HookContext) }`:
    object-tier operations and blocking `before` hooks, implemented by
    `gondolind` by forwarding to the controller (`vfs_call`, `vfs_hook`).
  - `EventSink`: bounded, non-blocking `vfs_event` queue (full → dropped and
    counted).
  - `VfsService::controller_call(FsCall)` (`fs_call`) and
    `VfsService::invalidate(mount_id, path)` (`vfs_invalidate`).
  - Internally every mount is a path-based `Provider` (`provider.rs`) routed by
    `MountRouter`; the RPC layer (`rpc.rs`) owns inodes and handles. That
    split is also what a virtio-fs backend (`gondolin-virtiofs`'s inode-level
    `FileSystem` trait) would sit on.
- `gondolin-netstack`:
  - `NetStack::new(config: NetConfig, flows: Arc<dyn FlowHandler>) -> Result`
    (fails fast in `trusted` DNS mode without IPv4 resolvers) and
    `serve(netdev_stream).await` (one QEMU connection at a time; see "Network
    stack" below).
  - `FlowHandler::handle_tcp(flow: TcpFlow)`, one tokio task per flow, called
    after the guest's handshake completes. `TcpFlow { meta: FlowMeta, stream,
    control: FlowControl }`: `stream` is `AsyncRead + AsyncWrite`, `meta` has
    `id`, guest `src`, `dst` and `synthetic_hostname` (per-host mapping),
    `control.abort()` resets the guest connection (node `abortTcpSession`).
    Backpressure flows through the TCP window; nothing to pause or resume.
  - DNS modes are implemented here (`synthetic`, `trusted`, `open`), including the
    synthetic-IP ⇄ hostname table (`NetStack::synthetic_hosts()`,
    `SyntheticHostLookup`).
- `gondolin-egress`:
  - `Egress::new(config: NetConfig, hooks: Arc<dyn HookBackend>)` implements
    `FlowHandler`; `update_policy(NetPolicy)` applies runtime changes (secrets).
  - `HookBackend`: async calls into tier-2/tier-3 hooks (`is_request_allowed`,
    `is_ip_allowed`, `on_request`, `on_response`), with lazy body streams.
- `gondolin-sshproxy`:
  - `SshProxy::new(&SshEgressConfig, Arc<dyn SshHooks>) -> Result` (config is
    `configure.net.ssh`, validated with the node engine's error messages;
    `check_dns(&netstack DnsConfig)` enforces synthetic + per-host DNS).
  - Egress: `proxy.sniff_ports()` for banner sniffing; on an SSH banner
    `proxy.target_for(&meta)` (allowlisted synthetic hostname + port with a
    credential or agent, else deny) and `proxy.handle(flow, target).await` with
    the sniffed bytes replayed.
  - `SshHooks::ssh_hook_call(SshHookCall) -> SshHookResult`: controller
    `execPolicy` / `hostVerifier`, only for hooks the config declares
    (`exec_policy_hook`, `host_verifier_hook`); gondolind forwards them as
    `ssh_hook_call` → `ssh_hook_call_result`.
  - SSH implementation: own, in `gondolin-sshproxy/src/ssh/` (replaced russh,
    ~100 crates). Sans-io core: `transport` (version exchange, binary packet
    protocol, `curve25519-sha256` and `ecdh-sha2-nistp256/384`, host keys
    `ssh-ed25519`/`ecdsa-sha2-nistp256/384`/`rsa-sha2-256/512`, ciphers
    `chacha20-poly1305@openssh.com` and `aes128/256-gcm@openssh.com` via ring,
    strict kex (Terrapin), rekeying after 1 GiB, ext-info `server-sig-algs`,
    no compression) and `connection` (userauth none/password/publickey/
    keyboard-interactive, session channels, requests answered in order).
    `session` is the tokio adapter (`Client`, `Server`, `Channel`), `agent`
    the ssh-agent client, `keyfile` reads OpenSSH keys (bcrypt + AES-CTR/CBC/
    GCM when passphrase protected), PEM PKCS#1/SEC1 (with OpenSSL's legacy
    AES-CBC encryption) and PKCS#8 — the formats ssh2 reads, minus DSA/PuTTY.
    Interop is tested against OpenSSH's `ssh` and `sshd` (`tests/openssh.rs`)
    and node's ssh2 upstream (host `ssh-egress` test); `ssh_transport` and
    `ssh_keys` fuzz the parsers.
  - Flow control: each exec bridges a guest-facing server channel to an
    upstream client channel. Both sessions advertise SSH window only as the
    application consumes data (`Connection::consumed`), so a direction blocked
    on its far end stops its sender through the SSH window while both
    connections keep being read (granting window on receipt and backpressuring
    by not reading the connection, as russh did, deadlocks a channel saturated
    in both directions). Each connection has a reader and a writer task, so
    reading never waits for writes to drain; unflushed output is bounded by
    the peer's windows.

## Guest images (`gondolin-assets`)

So the daemon can boot images on machines without Node, it resolves image
selectors itself, with the node engine's semantics and on-disk layout (both
engines share `~/.cache/gondolin/images`):

- `Assets::from_env()` reads `GONDOLIN_IMAGE_STORE` / `XDG_CACHE_HOME`,
  `GONDOLIN_IMAGE_REGISTRY_URL`, `GONDOLIN_DEFAULT_IMAGE`
  (`alpine-base:latest`), `GONDOLIN_GUEST_DIR`.
- `resolve(selector, arch, progress)` = `ensureImageSelector`: an existing
  directory, a build id or a `name[:tag]` ref; local objects/refs first (a ref
  with one target satisfies any arch), else the builtin registry (cached in
  `builtin-image-registry-cache.json` with ETag revalidation, cache used when
  offline). `resolve_local` never downloads; `resolve_default` =
  `ensureGuestAssets` (guest dir, checkout `guest/image/out`, default selector);
  `pull` re-reads the registry for a ref and repoints the local ref.
- `ResolvedImage { source, selector, asset_dir, build_id, arch, kernel, initrd,
  rootfs, rootfs_format, krun_kernel, krun_initrd, rootfs_mode, manifest }`;
  `rootfs_mode` is `manifest.runtimeDefaults.rootfsMode`.
- Downloads: rustls (ring) trusting what the node engine's `fetch` trusts:
  the Mozilla CA list (`webpki-roots`, the list Node bundles) plus
  `$NODE_EXTRA_CA_CERTS`; the OS trust store is not used (Node only does with
  `--use-system-ca`), which also keeps `rustls-native-certs` out of assets.
  Archive `sha256` from the
  registry, extraction into scratch space inside the store, every asset checked
  against the manifest checksums, import by rename into `objects/<build-id>`
  (temp dir + rename, as the node engine), ref symlinks replaced atomically.
  Concurrent installs of one build are serialized with a lock file
  (`.locks/<build-id>.lock`); the node engine does not lock but its atomic
  renames stay compatible.
- Sandbox helper binaries (`builtin-sandbox-helper-registry.json`) are only used
  by `gondolin build`; published images contain them, so the daemon does not
  need that registry to boot.
- `gondolind assets resolve|pull|list` (module `gondolin_assets::cli`) for
  bootstrap scripts.

## Network stack (`gondolin-netstack`)

QEMU's stream netdev (`-netdev stream,server=off,addr.type=unix,...`) connects
to a unix socket of the daemon and exchanges Ethernet frames, each prefixed with
its length as a `u32` big endian. `NetStack::serve(stream)` owns that stream:

- **L2/L3**: ARP replies for the gateway; IPv4 with header checksums verified,
  fragments dropped, TTL 64 on everything we emit; ICMP echo answered for any
  destination; DHCP (DISCOVER→OFFER, REQUEST→ACK, one-day lease, same options as
  the node engine; DNS server = gateway in `synthetic`/`trusted`, the host's
  guest-reachable IPv4 resolvers or `8.8.8.8` in `open`). TCP, ICMP and DNS are
  only accepted from the configured guest IP. UDP other than DHCP and port 53 is
  dropped.
- **DNS**: `synthetic` answers locally (A/AAAA for class IN, empty NOERROR for
  other types, `localhost` → loopback, `per-host` hands out `198.19.x.y`);
  `trusted` forwards only well-formed queries, round-robin over the trusted
  resolvers, replying as the address the guest targeted; `open` forwards UDP/53
  to the targeted IP. Upstream sockets are connected tokio UDP sockets, capped
  (LRU) and closed when idle.
- **TCP**: smoltcp 0.14 (`Medium::Ip`, AnyIP). For every guest SYN without a
  socket the stack creates a listening socket for exactly that destination
  before smoltcp sees the packet, so every connection to any IP/port is
  terminated locally; the 3-way handshake, retransmission, window scaling, MSS,
  zero-window probing, FIN/RST and half-close are smoltcp's. Ethernet framing is
  ours (smoltcp sees IP packets). Each flow has a fixed receive and send buffer
  (`limits.tcp_rx_buffer_bytes`/`tcp_tx_buffer_bytes`, 256 KiB by default, pages
  touched lazily), which are the only TCP buffering in the stack.
- **Why smoltcp, not a port of `network-stack.ts`**: the node engine's TCP is a
  minimal relay (fixed 65535 window, no window scaling, no retransmission — a
  dropped segment tears the flow down —, a 48 KiB in-flight cap with 16 KiB
  bursts per tick, unbounded acceptance of guest data with QEMU-rx pausing as
  backpressure). Porting it would mean building a real TCP anyway to get
  bounded memory plus throughput. smoltcp is a mature, allocation-controlled,
  sans-IO TCP with the features we need, and the same approach is used by other
  VM sandboxes. smoltcp walks all sockets of a `SocketSet` per packet and per
  poll, so each connection sits alone in its own set: guest packets are routed
  by 4-tuple and a poll only touches connections with packets, stream activity
  or a due timer (with 900 idle connections the shared-set version spent half
  its CPU scanning sockets). We don't get SACK-based recovery (irrelevant on a
  lossless virtual link). Measured with a smoltcp guest over an in-memory pipe
  (release, one flow, both stacks in one process): ~1.4 GB/s guest→host,
  ~1 GB/s host→guest (`cargo test --release -p gondolin-netstack --test tcp --
  --ignored --nocapture throughput`). Against a real Alpine guest under QEMU/HVF
  (`crates/gondolin-netstack/examples/linux-guest/run.sh`, raw stack without
  egress, M-series Mac): 230–300 MB/s upload (dd | nc), 310–530 MB/s download
  (curl), 0 guest retransmissions, ~10 MiB RSS; the same harness on the node
  engine's `NetworkStack` gave 169 MB/s upload, 349 MB/s download. Both are
  QEMU-bound at that point; the native stack uses a fraction of a core.
- **Read coalescing**: guest data reaches the flow's stream at a PSH (Linux sets
  it at the end of every write and every half window), FIN or RST, or once 64
  KiB are buffered; without any, after `READ_HOLD` (1 ms). This turns the
  per-QEMU-read (a few segments) wakeups and upstream writes of an upload into
  per-write ones; request/response traffic is pushed and never waits.
- **Backpressure**: guest→host data waits in the flow's receive buffer until the
  `FlowHandler` reads it; a full buffer closes the advertised window, so the
  guest stops. Host→guest writes return `Pending` while the flow's send buffer
  is full (drained as the guest ACKs). Frames to QEMU go through one queue: TCP
  connections are not polled for sending above `limits.tx_queue_soft_bytes`
  (the device never refuses a frame: smoltcp forgets a fast retransmit whose
  emission fails), other frames are
  dropped above `limits.tx_queue_max_bytes`, and the stack stops reading from
  QEMU while the queue is above the hard cap (a guest that floods without
  receiving throttles itself). There is no separate "pause QEMU rx" knob for the
  daemon to manage.
- **Flow lifecycle**: read EOF = guest FIN (writing still works), shutdown =
  FIN after queued data, `abort()` = RST. Dropping the stream closes gracefully
  (RST if unread guest data remains); the socket lingers until the close
  completes or `limits.tcp_linger_timeout_ms` passes. Handshakes time out after
  `limits.tcp_handshake_timeout_ms`; `limits.max_tcp_flows` caps sockets (extra
  SYNs get RST). Classification (HTTP/TLS/SSH/mapped), CONNECT denial, policy and
  the gateway-IP → loopback mapping are egress's job.
- **Configuration**: `NetConfig` (serde, part of `configure.net`): `gateway_ip`,
  `guest_ip`, `prefix_len`, `gateway_mac`, `guest_mac`, `mtu`, `dns { mode,
  trusted_servers, synthetic_ipv4, synthetic_ipv6, synthetic_ttl_seconds,
  synthetic_host_mapping }`, `limits { ... }`. Addresses are strings; every field
  has the node engine's default. The controller resolves the node engine's
  automatic `per-host` mapping (SSH or mapped TCP enabled) before sending.

gondolind wiring: bind the unix socket before starting QEMU, accept the
connection, `stack.serve(conn).await` (returns when QEMU closes it; all flows of
that connection are aborted); accept again if QEMU reconnects.

## Controller ⇄ daemon protocol

Transport: the daemon's stdin/stdout (or later a unix socket in daemon mode).
stderr is free-form diagnostics. Frames are `u32` big-endian length followed by
one CBOR map, the same framing as the guest protocols (`guest/ARCHITECTURE.md`
§3.2). Maximum frame: 4 MiB; larger payloads are chunked. When stdin/stdout
are sockets or pipes (always, when spawned by the SDK or over SSH) the daemon
drives them non-blocking on its reactor rather than through tokio's blocking
stdio threads, and the writer sends queued frames in batches of up to 256 KiB
per write.

Envelope: `{ v: 1, t: <type>, id?: <u64>, p: <payload map> }`.
- Requests carry `id`; the response uses the same `id` and type `<type>_result`
  with `p: { ok: true, ... }` or `p: { ok: false, code, message }`.
- Ids from the controller and from the daemon are separate number spaces (the
  direction disambiguates).
- Bytes are CBOR byte strings, never base64.
- Unknown message types are answered with `error { code: "unsupported" }` and
  otherwise ignored, so features can be negotiated.

### Session

| dir | type | meaning |
|---|---|---|
| d→c | `hello` | `{ protocol: 1, version, features: [..], pid }` first frame |
| c→d | `configure` | full session configuration (below); answered by `configure_result` |
| c→d | `start` | create the private socket directory (0700), listen on the four guest channels (and the netdev socket for native networking); `start_result { socket_dir }`. The VM itself is booted by a client `boot` (as with `SandboxServer.start()` + `boot`) |
| d→c | `status` | `{ state: "starting"\|"running"\|"stopped", vmm_pid? }`; `running` once QEMU was spawned (guest readiness is checked by the SDK with an exec, like the node engine) |
| d→c | `log` | `{ component, message }` (the `debug` events of `SandboxServer`) |
| d→c | `exit` | `{ code?, signal?, error? }` QEMU exited (`signal` as a name, `error` when it could not be spawned); the exit diagnostics with the QEMU log hint go to inflight execs/file operations |
| d→c | `error` | `{ code, message, type? }`: asynchronous errors (`SandboxServer` `error` events) and answers to unknown unsolicited messages (`code: "unsupported"`) |
| c→d | `activity` | `{ source, active }`: guest activity observed by the controller (idle pause) |
| c→d | `shutdown` | stop the VM, answer `shutdown_result`, exit |

The daemon exits when stdin closes (SIGKILLing the VMM). If the daemon itself
dies, the VMM follows: on Linux via `PR_SET_PDEATHSIG`, on macOS via a tiny
watchdog (`gondolind --vmm-watchdog <pid>`, kqueue `NOTE_EXIT` on the VMM and
EOF on a pipe from the daemon). `configure` carries:

- `vm`: `vmm?: qemu|krun`, `qemu_path`, `krun_runner_path?`, `image?`,
  `arch?`, `kernel_path`, `initrd_path`, `root_disk?: { path, format:
  raw|qcow2, read_only, snapshot }`, `memory`, `cpus`, `machine_type?`, `accel?`,
  `cpu?`, `console?: stdio|none`, `append?` (replaces the default cmdline),
  `append_extra: [..]` (e.g. `gondolin.tmpfs=`), `mac?`, `auto_restart`,
  `idle_pause_ms?` (qemu only). QEMU arguments, accelerator/machine/cpu
  selection and the default console are computed by the daemon for its own
  host (`gondolind --qemu-args` prints them for a JSON config; a host test
  compares them with `buildQemuArgs`). `krun` writes the
  `gondolin-krun-runner` JSON config into the socket directory (empty initrd
  generated when needed).
- Paths or selector: `vm.image` (`name:tag`, build id, directory; empty string
  = default image) is resolved by the daemon with `gondolin-assets` (shared
  cache with the node engine, downloads from the builtin registry; progress as
  `log { component: "assets", message: <ProgressEvent JSON> }`) and fills
  empty `qemu_path`/`kernel_path`/`initrd_path`/`root_disk.path`/`format`
  (krun: the image's krun kernel/initrd). `configure_result.image` describes
  the resolved image (build id, arch, paths, rootfs mode) so the controller can
  apply manifest defaults. Explicit paths always win.
- `limits`: `max_stdin_bytes`, `max_queued_stdin_bytes`,
  `max_total_queued_stdin_bytes`, `max_queued_execs` (node defaults when absent).
- `debug`: enabled debug components.
- `vfs`, `net`: subsystem configuration (see above), absent = disabled.

Paths are paths on the daemon's machine.

### Clients and exec (mirrors `sandbox/control-protocol.ts`)

The SDK multiplexes its sandbox connections (the VM, `gondolin attach`
sessions) as numbered clients: `client_open { client }`, `client_close {
client }`. Client messages keep the types and fields of `control-protocol.ts`
plus `client`: `boot { fuseMount?, fuseBinds? }`, `exec`, `stdin` (data as a
byte string), `pty_resize`, `exec_window`, `lifecycle`; other client message
types are sent as `client_unknown { client, type }`. The daemon validates them
exactly like `SandboxServer` (uint32 exec ids, global across clients) and
implements its queueing and credit rules: exec admission limit, execs queued
while a file operation runs, stdin queued against guest-granted credit with
per-exec/total caps, pty resizes and output windows retried when the guest
channel is full, disconnect semantics (a disconnected client's guest execs keep
their ids until they finish). Daemon → controller: `client_status { client,
state }`, `client_error { client, id?, code, message }`, `client_closed {
client }`, `exec_output { client, id, stream, data }`, `exec_response { client,
id, exit_code, signal? }`; global `status` is broadcast to all clients by the
SDK. Guest output frames (at most 8 KiB each) that arrive back to back for the
same exec and stream are coalesced into one `exec_output` of up to 64 KiB; the
batch is sent at the end of the event round or before any other message is
handled, so ordering against `exec_response`, errors and window updates is
unchanged.

### MITM CA

`mitm_ca { dir? }` → `mitm_ca_result { cert_pem, dir }` loads or creates the
MITM CA in the daemon (default `<cache>/gondolin/ssl`, same layout and
certificate profile as `host/src/mitm.ts`: RSA 2048 PKCS#1 `ca.key`, `ca.crt`,
so either engine accepts the other's CA; `gondolind --mitm-ca [dir]` prints
it). The key never leaves the daemon; `gondolind::mitm_ca::load_or_create` is
what native egress uses when the controller passes no CA.

### Guest TCP streams (`vm.enableSsh()`, ingress)

The daemon relays the guest's `virtio-ssh` and `virtio-ingress` TCP
forwarders (`guest/ARCHITECTURE.md` §7); the streams live in the controller
(`NativeSandboxServer.openTcpStream`/`openIngressStream`, the ingress gateway
and its hooks). Messages carry `channel: ssh|ingress` and the
controller-chosen `stream` id: `fwd_open { host, port }` → `fwd_opened { ok,
message? }`, `fwd_data { data }` both ways, `fwd_eof`, `fwd_close { message?
}` both ways, `fwd_window { bytes }`. Guest→controller data is credit based
(256 KiB unacknowledged per stream, returned by the controller as its readable
side drains; above 1 MiB queued per channel the daemon stops reading the
guest channel); controller→guest data honours the pipe's backpressure and the
64 MiB channel queue (a stream that does not fit is closed, like the node
engine).

### Guest file operations

`file_read { path, cwd?, chunk_size? }`, `file_write { path, cwd? }`,
`file_delete { path, cwd?, force?, recursive? }` are requests (guest
`file_*_request` of `guest/ARCHITECTURE.md` §4.5); all their messages use the
controller request id. They wait for the exec/file slot like `acquireFileOp`;
`file_started` reports that the guest request was sent, then reads stream
`file_read_data { data }` and uploads send `file_write_data { data, eof? }`;
`file_cancel { message? }` aborts. Errors are `{ ok: false, code, message }`
with `message` being the SDK-visible error (`file_read_failed: FileNotFound`).
While the guest channel is full, the daemon stops reading controller messages
(the upload's backpressure reaches the controller through the pipe).

### VFS

Schema: `gondolin-proto/src/vfs.rs`. `configure.vfs` is dispatched on `mode`:
`controller` (interim: every sandboxfs request is forwarded as `vfs_rpc` to the
node engine's `FsRpcService`; `GONDOLIN_NATIVE_VFS=controller` selects it) or
`native` (`VfsConfig`, the default for the native engine):
`{ mode: "native", fuse_mount, binds, mounts: [...], hooks: { before?, events? } }`.

Mounts are `{ path, kind, ..., layers?, readonly? }` routed by longest prefix
(paths above mount points are synthetic read-only directories, cross-mount
rename/link is `EXDEV`). Kinds:
- `host { root }`: passthrough to a directory on the daemon's machine.
  Hardened: every path is resolved from a directory fd of the root, never
  outside it (Linux `openat2(RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS)` for the
  parent, falling back to the walk; elsewhere a component-wise walk opening each
  directory `O_NOFOLLOW` and resolving symlinks itself, mapping absolute targets
  inside the root back into it); the final component is operated on with `*at`
  calls relative to the parent fd. Directory fds of symlink-free paths are
  cached (1 s TTL, 256 per mount, LRU, dropped on rename/rmdir through the
  provider), so most operations start below the root. Symlink policy of
  `RealFSProvider`
  (follow-style ops fail `ENOENT` for escaping or dangling links;
  lstat/readlink/unlink/rmdir/rename act on the link); setuid/setgid dropped
  on chmod.
- `memory {}`: in-daemon memory filesystem (`MemoryProvider` semantics).
- `static { files: { path: bytes } }`: read-only synthetic files (MITM CA).
- `object { mount_id, writable, enumeration: list|materialized|none,
  commit: close|write, cache: { ttl_ms, max_bytes }, max_file_bytes? }`:
  provider in the controller.

`layers` wrap the source, innermost first: `{ kind: "readonly" }` and
`{ kind: "hide", paths, write_mode: deny|tmpfs, deny_write_errno?,
deny_symlink_bypass }` (`ShadowProvider` with `createShadowPathPredicate`
semantics: a path hides itself and everything below; reads `ENOENT`, listings
omit, writes denied or kept in a memory upper layer). `readonly: true` adds an
outermost read-only layer.

Object tier (d→c requests): `vfs_call { mount_id, op, ... }` with ops `stat`,
`readdir`, `read_file { offset, length }`, `write_file { data, offset, last,
mode? }` (whole file in ≤ 1 MiB chunks, committed by the chunk with `last`),
`write { offset, data }`, `truncate`, `unlink`, `rename`, `mkdir`, `rmdir`,
`chmod`, `symlink`, `readlink`, `link`; results `{ ok: true, stat?, entries?,
data?, target? }` or `{ ok: false, code: <errno name>, message }`. The daemon
serves all per-op FUSE semantics (inodes, handles, offsets, partial I/O,
attributes) from its cache: stats, negative lookups and listings live for
`ttl_ms` (0 = revalidate on every lookup/open), contents are fetched lazily in
1 MiB `read_file` chunks and kept while open (clean contents of closed files up
to `max_bytes`). `commit: write` forwards every write/truncate before the guest
gets its reply; `commit: close` keeps writes local and commits the whole file
when a dirty handle is released (also on `fs_call` close and at shutdown).
**Limitation (sandboxfs only):** sandboxfs does not forward `FLUSH`/`FSYNC`
and the kernel does not wait for `RELEASE`, so a commit failure cannot reach
the guest's `close()`/`fsync()`; it is the result of the release (logged,
emitted as the `release` event's error) and the data stays dirty for the next
writer's release. Over virtio-fs FLUSH and FSYNC commit and return the error. Controller
pushes `vfs_invalidate { mount_id, path? }` (answered by
`vfs_invalidate_result`).

Hooks: when `hooks.before` is set the daemon sends a blocking
`vfs_hook { op, path?, old_path?, new_path?, flags?, mode?, offset?, length?,
size? }` before each hooked operation (the ops and contexts of the node
engine's `SandboxVfsProvider`; `flags` as node strings) and fails the operation
with the returned errno. With `hooks.events` it sends `vfs_event` (same fields
plus `error?`, `bytes?`) after it, asynchronously through a bounded queue.
Neither is sent when the controller registered no hooks.

Readdir offsets are indices into a listing snapshot; continuations keep their
snapshot across mutations and skip removed names, so `rm -rf` works while
deleting (the node engine had the same bug and the same fix).

Controller fs API (c→d): `fs_call { op, ... }` (`stat { follow }`, `readdir`,
`access`, `mkdir`, `rmdir`, `unlink`, `rename`, `chmod`, `truncate`,
`readlink`, `symlink`, `realpath`, `open { flags }` → `fh`, `read`, `write`,
`close`) against the daemon's mount table, with the same hooks; `vm.fs` uses it
for mounts only the daemon has (native memory, remote host paths, object
providers with a cache) and the JS providers directly otherwise.

### Network

`configure.net` with `mode: "native"` (the default for the native engine) is
served in the daemon by `gondolind/src/net.rs`: `gondolin-netstack` on the
netdev socket, `gondolin-egress` for flows, `gondolin-sshproxy` for SSH egress.
Open guest flows are reported as session activity (no idle pause while
connected). With the `net` debug flag, `gondolin-log` records of the network crates
are forwarded as `log { component: "net" }`. The controller side lives in
`host/src/native/net.ts` (`NativeNetwork`: option compilation and the
`hook_call`/`body_pull`/`body_release`/`ssh_hook_call` handlers,
`policy_update` on `SecretManager` changes).

Schema: `gondolin-proto/src/net.rs` (all fields `snake_case`, optional fields
omitted). `configure.net` (`NetConfig`) carries:
- `policy` (`NetPolicy`): `rules?` (`HttpRules`, the evaluated
  `createHttpHooks()` options, attached via a hidden symbol on the returned
  hooks object: merged `allowed_hosts`, `allowed_internal_hosts`,
  `block_internal_ranges`, `secrets: [{ name, identifier, placeholder, value,
  revoked_values, hosts, deleted }]`, `replace_secrets_in_query`,
  `placeholder_mode`, `marker`) and `allow_websockets`. Without `rules` only the
  built-in internal-range policy applies (unless an `is_ip_allowed` hook is
  registered, which then fully replaces it, as in the node engine).
- `hooks` (`HookRegistrations`): `is_request_allowed`, `is_ip_allowed`,
  `on_request?: { body }`, `on_response?: { body }`.
- `djs_hooks?` (`DjsHooksConfig`, tier 2): `source`, `filename?`, `kind`
  (`script` | `module` | `typescript`), `modules?: { key: source }` (language
  by the key's extension: `.ts`/`.mts`/`.cts`, `.json`, else JS; the CLIs
  fill it from the relative imports next to `--hooks-script`, so the daemon
  does no I/O), `limits: { fuel?,
  memory_bytes?, timeout_ms? }`. Compiled by `gondolin-hooks-djs` in
  `build_native` (errors fail `configure`); gondolind advertises
  `hello.features: ["djs_hooks"]` and the TS controller refuses to send a
  policy to a daemon without it (an older daemon would ignore the field).
- `limits`: body limits, max concurrent requests (128), WebSocket connect/header
  timeouts, MITM leaf cache size/ttl, `guest_keep_alive` (default false: one
  request per guest connection with `connection: close`, as the node engine).
- `mitm?: { cert_pem, key_pem }`: the controller's cached CA (`host/src/mitm.ts`,
  PKCS#1 RSA keys accepted), sent by local controllers only. Without it the
  daemon uses its own cache (`mitm_ca::load_or_create`, optional `mitm_dir`),
  which is what remote controllers install in the guest (`mitm_ca` request).
- `tcp_hosts` (mapped TCP), `ssh?` (`SshEgressConfig`: allowlist, credentials,
  agent, known_hosts files, hook flags, caps; egress hands flows with an `SSH-`
  banner on the allowlist's ports to `gondolin-sshproxy`; the controller maps
  `VMOptions.ssh` in `host/src/native/net.ts` and leaves credential/known_hosts
  validation to the daemon, whose filesystem the paths refer to),
  `upstream_ca_pems`, `use_system_roots`, `use_webpki_roots`.
- `stack`: the netstack's `NetConfig` (addresses, guest MAC, MTU, `dns`,
  stack limits, `checksum_offload` for krun's virtio-net whose guest packets
  carry partial TCP/UDP checksums; `gondolin-netstack/src/config.rs`). gondolind composes both
  halves (`gondolind/src/net.rs`, `ConfigureNet`: egress fields flattened at the
  top level, `stack`, `system_resolvers`).
- DNS options are resolved by the controller exactly like the node engine
  (`host/src/native/net.ts`, `compileNetworkOptions`): validation of
  SSH/mapped TCP vs DNS mode, the automatic `per-host` synthetic mapping when
  SSH egress or `tcp.hosts` are enabled, and trusted resolvers. When the daemon
  runs locally the controller sends `dns.getServers()` (IPv4) as
  `system_resolvers` (and as the `trusted` default, failing fast like node when
  empty); a remote daemon gets only explicitly configured servers and falls back
  to its own `/etc/resolv.conf`, since the controller's resolvers may not be
  reachable from there.
- Upstream trust: the controller sends `tls.getCACertificates("default")` as
  `upstream_ca_pems` with the built-in root sets disabled, so the native engine
  trusts exactly what node's fetch would (incl. `NODE_EXTRA_CA_CERTS` and
  `tls.setDefaultCACertificates`). The static CLI has no Node.js CA store and
  sets `use_webpki_roots` + `use_system_roots`: system roots are PEM files
  (`gondolin_egress::system_roots`, no `rustls-native-certs`):
  `SSL_CERT_FILE`/`SSL_CERT_DIR` when set, else the first distribution bundle
  (the `openssl-probe` list) or the certificate directories on Linux and
  `/etc/ssl/cert.pem` on macOS, plus `NODE_EXTRA_CA_CERTS`. The macOS keychain
  is not read (node's default store doesn't either, and `security
  find-certificate` output lacks the trust settings); keychain-only roots must
  be exported to `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE`.

`policy_update { policy }` (c→d) replaces the whole `NetPolicy` (secret
rotation/deletion, host changes); it applies to requests evaluated afterwards.

Tier-3 hooks: for each registered phase the daemon sends `hook_call { phase,
request?, response?, ip? }` (heads as `{ method, url, headers: [[k, v]], body?:
<stream id> }` / `{ status, status_text, headers, body? }`) and waits for
`hook_call_result` with a decision (`HookDecision`, tagged by `action`):
`allowed { allowed }`, `continue`, `request { request, body }`,
`response { response, body }`, `block { status, status_text, message }`.
`body` is `original` | `none` | `bytes { data }` | `stream { stream }`.
Bodies are pulled lazily in both directions with `body_pull { stream, max,
offset? }` → `body_pull_result { stream, data, eof }`; `body_release { stream }`
ends a stream early (for daemon streams only a hint: they live until the hook
call returns). Daemon streams accept `offset`, so `clone()`d WHATWG objects on
the controller read independently instead of teeing (no second buffered copy).
To save round trips, `hook_call` heads carry up to 64 KiB of the body inline
(`body_prefix`, `body_complete`: read ahead when Content-Length says it fits,
otherwise what already arrived), `body_pull_result` reports `eof` with the last
chunk, and the controller sends no `body_release` for daemon streams. While the
`on_request` round trip runs, the daemon already resolves the request host if
the declarative allowlist admits it (used only if the hook keeps the host). The daemon retains the chunks a hook pulled (bounded by the body
limit), so a decision that keeps the `original` body replays them and forwards
the rest natively; a body that is never pulled is never buffered or sent.

Evaluation order matches the node engine (`host/src/http/hooks.ts`,
`host/src/qemu/http.ts`): head validation → request + ip policy precheck
(only when no `on_request` hook is registered, i.e. `ON_REQUEST_EARLY_POLICY_SAFE`)
→ per hop: `on_request` → secrets substitution → request/ip policy again unless
prechecked and the head is unchanged → upstream connect with a connect-time ip
check on new pooled connections → redirects (re-validated, max 10) →
`on_response`. The daemon enforces built-in defaults (internal ranges blocked,
CONNECT denied, HTTP/1.x only) without any hooks.

Rust seam: `Egress::new(NetConfig, Arc<dyn HookBackend>)` (or `with_resolver`
for tests) implements `FlowHandler`; `Egress::update_policy(NetPolicy)`.
`HookBackend` methods take plain heads and `BodyHandle`s and return
`RequestDecision`/`ResponseDecision`; `registrations()` is read per request.

## Static CLI (`gondolin-cli`)

`crates/gondolin-cli` builds `gondolin`, the CLI without Node.js (user docs:
`docs/cli.md`, "Static CLI"). It is an in-process controller:
`gondolind::embed::Embedded` runs the session task in the CLI's runtime;
controller messages are `RawEnvelope`s handed to `Dispatcher::dispatch` and
daemon messages are taken with `Controller::next_frame` (no process, no pipe,
the same protocol as the TypeScript controller). Modules:

- `args`: the flag parsers of `host/bin/gondolin.ts` (same errors).
- `configure`: the `configure` payload for the CLI options, the counterpart
  of `VM.create()` + `NativeSandboxServer.buildConfigure()` (image resolution
  with `gondolin-assets`, root disk via `rootdisk::prepare`, mount table
  incl. the MITM CA `static` mount and the `/etc/gondolin` object mount,
  network via `gondolin_egress::cli_policy`). Both CLIs print it with
  `--print-configure`; `host/test/cli-configure-parity.test.ts` compares them.
- `engine`: request correlation, client/exec event routing, `fwd_*` streams,
  daemon→controller requests (`vfs_call` for `/etc/gondolin`, served by
  `etc_mount` from memory).
- `vm`, `session`: boot and readiness (`ensureRunning`, rootfs resize, mount
  checks), clients and execs with output windows and stdin acks, checkpoints
  (`checkpoint`, node's qcow2 + trailer format), registry entry and IPC
  socket (`registry`, the `SessionIpcServer` protocol with id remapping).
- `ssh`, `ingress`, `fwd`: `--ssh` and `--listen` over the `ssh`/`ingress`
  forwarder channels (`gondolin-http` for the gateway, WebSocket upgrades tunneled).
- `commands`: `bash`, `exec`, `list`, `attach`, `snapshot`, `image`.

The binary is multi-call: as `gondolind*`, `gondolin daemon` or
`gondolin --vmm-watchdog` it runs `gondolind::main_with_args`.

## Hook tiers

1. **Declarative** (native): everything `createHttpHooks()` options express,
   DNS, limits. Zero round trips.
2. **djs** (native, `gondolin-hooks-djs`, cargo feature `djs-hooks` of
   gondolind/gondolin-cli, on by default): a self-contained JavaScript policy
   (`createDjsHooks()`, `--hooks-script`) run inside `gondolind` on djs-embed.
   - Compile once at `configure.net`: the shim (`src/shim.js`: restricted
     `Request`/`Response`/`Headers`/`URL`/`URLSearchParams`,
     `HttpRequestBlockedError`, `console`) plus the policy (a script, or an ES
     module with in-memory imports bound by a generated module) into a
     snapshot; the phases are the functions the policy defines, and only
     those are registered (egress keeps its early-policy fast path).
   - Per call: an instance from a pool, reset to the snapshot afterwards
     (`Instance::reset`, same isolation as a fresh VM; measured equal for
     header-only calls and 30% cheaper with bodies). At most 16 idle
     instances; a reset keeps the heap allocation a call grew, so an idle
     instance above 1 MiB is shrunk to that (`Instance::shrink_heap`;
     header-only calls need ~320 KiB, a 256 KiB body ~640 KiB). Measured
     (`examples/bench.rs ... caps`): shrinking, even to the snapshot's size,
     costs nothing measurable on the next call at any body size (64 KiB: 20 µs
     pooled with or without shrinking vs 34 µs fresh), so the cap only bounds
     idle memory (≤ 16 MiB per policy). Heads go in as borrowed
     djs values, the decision comes back as plain data and is validated on
     the host (header names/values, method, http(s) URL, status). Bodies are
     an async host function over egress's `BodyHandle` (read once per call,
     clones share; gzip/deflate decoded for `onResponse`, bounded by the
     response limit). URL parsing is a sync host function into
     `gondolin_http::url`.
   - Runs on the egress task, in fuel slices of 200k (~1 ms) with a
     `yield_now` between slices; budgets per call: fuel (50M), heap (64 MiB,
     uncatchable), wall clock (30 s, djs deadline between slices plus a tokio
     timeout around body reads and the call).
   - Fail closed: every engine error, panic (djs-embed `catch_unwind`, the
     instance is dropped), budget, unsettled promise or invalid decision is
     `HookError::Failed` (502); `HttpRequestBlockedError` is `Blocked`.
   - djs API use is confined to `src/engine.rs` (the adapter).
   - Research, the djs requirements and the prototype measurements:
     `docs/djs-hooks.md`.
3. **Controller callbacks**: arbitrary JS hooks in the Node SDK over the pipe.
   Full API, costs a round trip per registered phase.

Order: `ChainedHooks` (egress) runs tier 2 before tier 3 in every phase:
`is_request_allowed`/`is_ip_allowed` AND (first deny or error wins), each
`on_request`/`on_response` sees the previous tier's replacement (a replaced
body is offered to the next tier as a new `PullableBody`), `Respond`/errors
end the phase. Declarative policy runs around both, as before (secrets after
all `on_request` hooks, policy re-checked on the rewritten head).

## Filesystem tiers

1. **Native**: `host`, `memory`, `static`, with hide/read-only rules.
2. **Object**: whole-file providers in the controller with a native cache.

Translation of existing providers (`host/src/native/vfs.ts`):
- `RealFSProvider(dir)` → `host` (object tier when the daemon is remote);
  `ReadonlyProvider(x)` → `x` + readonly layer;
  `ShadowProvider(x, { shouldShadow: createShadowPathPredicate(paths) })` →
  `x` + hide layer (the predicate carries its paths via a hidden symbol; custom
  predicates or a custom `tmpfs` make the whole provider an object mount);
  the MITM CA provider → `static` (remote: the daemon's CA via `mitm_ca`).
- User-visible `MemoryProvider` instances and every other provider → `object`
  (`commit: write`, `ttl_ms: 0`) through an adapter onto the `VirtualProvider`,
  so the JS object stays the source of truth with node-engine consistency.
  `/etc/gondolin` is an object mount with a 64 KiB file limit that reloads the
  ingress listeners when `/listeners` changes.
- New exports: `ObjectProvider` (whole-file interface; elwing's
  `nativeProvider.ts` shape) with `createObjectMount(provider, options)` /
  `nativeMounts.object(...)` (`ObjectVirtualProvider` serves it on the node
  engine), `nativeMounts.memory()` and `nativeMounts.host(dir, { readonly,
  hide })` (a daemon-side path, also for remote daemons).

Guest transports (`configure.vfs.transport`: `auto`, `sandboxfs`, `virtiofs`;
`GONDOLIN_VIRTIOFS=0|1` on the controller):
- **virtio-fs** (QEMU only, chosen when the binary offers `vhost-user-fs-pci`
  / `vhost-user-fs-device` and a shared RAM backend; probed once per binary
  with `-device help`/`-object help`, cached in memory and in
  `<cache>/gondolin/qemu-virtiofs.json`): guest RAM moves to
  `memory-backend-memfd` (Linux) or `memory-backend-shm` (macOS),
  `gondolind` serves the vhost-user socket (`gondolin-virtiofs`: vhost-user,
  split virtqueues, FUSE dispatch; one thread per queue, one high-priority and
  up to four request queues) with `gondolin-vfs`'s `FsCore` behind the
  `FileSystem` trait (`virtiofs.rs`; operations are driven on the tokio
  runtime with `block_on`, host reads go straight into guest memory with
  `preadv`). The kernel command line gets `sandboxfs.virtiofs=gondolin`; the
  guest's `sandboxfs --virtiofs` fetches the bind list over the RPC port, mounts
  the tag and exits. FLUSH and FSYNC reach the backend, so object-tier commit
  errors become the guest's `close()`/`fsync()` errors. Directory handles
  keep a listing snapshot; FORGET drops inodes.
- **sandboxfs RPC** (fallback, krun, old images): unchanged.

## Benchmarks

`host/bench/` runs the same workloads against both engines
(`GONDOLIN_ENGINE=node|native`) and writes JSON results plus a markdown summary
to `host/bench/results/`. Workloads: boot to first exec, exec round trip,
exec stdout throughput, VFS small-file metadata and I/O, VFS large-file
throughput per mount kind, HTTP/HTTPS request latency and throughput through the
MITM (local upstream allowed via `allowedInternalHosts`), hook round-trip cost,
host process RSS/CPU.

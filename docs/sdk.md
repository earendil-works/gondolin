# SDK Reference

This page lists the programmatic API of `@earendil-works/gondolin`: every
`VM` option, the members of a `VM` and the other exports. The guides explain
how to use them; each entry links to the relevant one.

```bash
npm install @earendil-works/gondolin
```

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({ memory: "2G" });
const result = await vm.exec("uname -a");
console.log(result.stdout);
await vm.close();
```

The package is ESM and requires Node.js; VMs are run by the Gondolin daemon
(`gondolind`) from the platform package installed alongside it. See
[Installation](./install.md) for requirements.

## VMOptions

Options of `VM.create(options)` (and `new VM(options)`). All fields are
optional.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `memory` | `string` | `"1G"` | Guest memory, QEMU size syntax ([Running Commands](./exec.md#creating-starting-and-closing)) |
| `cpus` | `number` | `2` | Guest vCPU count |
| `env` | `Record<string, string> \| string[]` | — | Default environment of every command; per-exec `env` is merged on top ([Running Commands](./exec.md#creating-starting-and-closing)) |
| `autoStart` | `boolean` | `true` | Boot the VM on demand on first use (`exec`, `vm.fs`, `enableSsh`, `enableIngress`); with `false` those throw until `start()` was called ([Running Commands](./exec.md#creating-starting-and-closing)) |
| `startTimeoutMs` | `number` | `120000` (`GONDOLIN_START_TIMEOUT_MS`) | Timeout for guest readiness in `ms`; `<= 0` disables |
| `sessionLabel` | `string` | the process command line | Label shown by `gondolin list` ([Sessions](./exec.md#sessions-and-attaching-from-outside)) |
| `httpHooks` | `HttpHooks` | — | HTTP egress policy and request/response hooks, usually from `createHttpHooks()` ([HTTP Hooks and Policies](./hooks.md)) |
| `dns` | `DnsOptions` | synthetic DNS | Guest DNS mode and host mappings ([Network Access](./network-access.md)) |
| `tcp` | `TcpOptions` | — | Explicit host-mapped TCP egress ([Network Access](./network-access.md)) |
| `ssh` | `SshOptions` | — | Outbound SSH egress proxy ([SSH](./ssh.md)) |
| `maxHttpBodyBytes` | `number` | 64 MiB | Max intercepted HTTP request body in `bytes` ([HTTP Hooks and Policies](./hooks.md)) |
| `maxHttpResponseBodyBytes` | `number` | 64 MiB | Max buffered upstream HTTP response body in `bytes` |
| `allowWebSockets` | `boolean` | `true` | Allow WebSocket upgrades for guest egress |
| `vfs` | `VmVfsOptions \| null` | `/etc/gondolin` and CA mounts only | Mounts and VFS hooks; `null` disables VFS integration (see below) ([Files and Mounts](./vfs.md)) |
| `tmpfs` | `GuestTmpfsMounts` | `DEFAULT_GUEST_TMPFS` | Guest tmpfs mounts replacing the built-in set; `{}` keeps scratch paths on the root disk ([Files and Mounts](./vfs.md)) |
| `rootfs` | `VmRootfsOptions` | mode from the image, else `"cow"` | Root disk mode and minimum size ([Persistence and Snapshots](./snapshots.md)) |
| `sandbox` | `SandboxServerOptions` | — | Image, backend and low-level VM settings ([Sandbox Options](#sandbox-options)) |
| `native` | `NativeEngineOptions` | local daemon | How to reach `gondolind` ([Daemon Connection Options](#daemon-connection-options)) |
| `debugLog` | `DebugLogFn \| null` | `console.log` when debugging is on | Debug log sink; `null` silences ([Debugging](./debug.md)) |
| `engine` | `"native" \| "auto"` | — | Accepted for compatibility, both mean the same; anything else throws |
| `fetch` | `HttpFetch` | — | Deprecated and ignored; use `httpHooks.onRequest` |

`memory`, `cpus`, `tmpfs`, `httpHooks`, `dns`, `tcp`, `ssh`,
`maxHttpBodyBytes`, `maxHttpResponseBodyBytes` and `allowWebSockets` also
exist under `sandbox`; when both are set, the `sandbox` value wins.

`VmVfsOptions`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mounts` | `Record<string, VirtualProvider>` | — | Guest path to provider |
| `hooks` | `VfsHooks` | — | `before` / `after` callbacks around VFS operations |
| `fuseMount` | `string` | `"/data"` | Guest path of the FUSE mount that bind mounts are served from |

Even without `vfs`, Gondolin mounts `/etc/gondolin` (ingress routing) and the
MITM CA certificate into the guest. `vfs: null` removes both, so
[ingress](./ingress.md) is unavailable and the guest does not get the CA
injected for HTTPS interception.

`VmRootfsOptions`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `"readonly" \| "memory" \| "cow"` | image `runtimeDefaults.rootfsMode`, else `"cow"` | Root disk write mode |
| `size` | `string \| number` | image size | Minimum virtual disk size (`bytes`, or `K`/`M`/`G`/`T` suffix); needs a writable mode and `resize2fs` in the image |

## Sandbox Options

`VMOptions.sandbox` (`SandboxServerOptions`) holds image selection, backend
selection and low-level VM settings. Options marked *qemu* only apply to the
QEMU backend: setting one makes the default backend selection pick QEMU, and
combining one with `vmm: "krun"` throws. Options marked *local* are rejected
when the daemon runs on a [remote machine](./remote.md).

| Option | Type | Default | Meaning |
|---|---|---|---|
| `imagePath` | `string \| GuestAssets` | `GONDOLIN_GUEST_DIR`, else the default image | Image: an asset directory, `name:tag`, build id, or `{ kernelPath, initrdPath, rootfsPath }` (*local* for the object form) ([Images](./images.md)) |
| `vmm` | `"qemu" \| "krun"` | `GONDOLIN_VMM`, else krun where it can run, else qemu | VM backend ([VM Backends](./backends.md#default-backend-selection)) |
| `qemuPath` | `string` | `qemu-system-aarch64` / `qemu-system-x86_64` matching the image | QEMU binary (*qemu*) |
| `krunRunnerPath` | `string` | `GONDOLIN_KRUN_RUNNER`, checkout build, installed runner package | krun runner binary |
| `machineType` | `string` | backend default | QEMU machine type (*qemu*) |
| `accel` | `string` | `hvf` on macOS, `kvm` on Linux with `/dev/kvm`, else `tcg` | QEMU accelerator (*qemu*) |
| `cpu` | `string` | `GONDOLIN_CPU`, else backend default | QEMU CPU model (*qemu*) |
| `qemuIdlePauseMs` | `number` | `30000` on macOS with HVF, else off | Pause an idle QEMU VM after this many `ms`; `0` disables (*qemu*) |
| `memory` | `string` | `"1G"` | Same as `VMOptions.memory` |
| `cpus` | `number` | `2` | Same as `VMOptions.cpus` |
| `append` | `string` | — | Extra kernel command line |
| `console` | `"stdio" \| "none"` | console forwarded, boot log quiet (QEMU, Firecracker) | Guest console output; `"none"` discards it, `"stdio"` also keeps the full boot log (see [Boot log](./debug.md#boot-log)) |
| `autoRestart` | `boolean` | `false` | Restart the VM when it exits unexpectedly |
| `tmpfs` | `GuestTmpfsMounts` | built-in set | Same as `VMOptions.tmpfs` |
| `rootDiskPath` | `string` | throwaway overlay | Use this disk image as `/dev/vda`; overrides `rootfs.mode` (*local*) ([Persistence and Snapshots](./snapshots.md)) |
| `rootDiskFormat` | `"raw" \| "qcow2"` | `qcow2` with `rootDiskPath`, else `raw` | Root disk format (*local*) |
| `rootDiskReadOnly` | `boolean` | `false` | Attach the root disk read-only (*local*) |
| `rootDiskDeleteOnClose` | `boolean` | `false` | Delete `rootDiskPath` on `vm.close()` (*local*) |
| `netEnabled` | `boolean` | `true` | Guest networking; `false` gives the guest no network (and no injected MITM CA) |
| `netMac` | `string` | `02:00:00:00:00:01` | Guest MAC address |
| `allowWebSockets` | `boolean` | `true` | Same as `VMOptions.allowWebSockets` |
| `httpHooks`, `dns`, `tcp`, `ssh` | | — | Same as the `VMOptions` fields |
| `maxHttpBodyBytes`, `maxHttpResponseBodyBytes` | `number` | 64 MiB | Same as the `VMOptions` fields |
| `mitmCertDir` | `string` | `GONDOLIN_MITM_CERT_DIR`, else `~/.cache/gondolin/ssl` | Directory of the MITM CA key and certificate ([HTTP Hooks and Policies](./hooks.md)) |
| `vfsProvider` | `VirtualProvider` | — | A single provider served at the FUSE mount root; cannot be combined with `vfs` |
| `debug` | `boolean \| DebugFlag[]` | `GONDOLIN_DEBUG` | Debug components to enable ([Debugging](./debug.md)) |
| `maxStdinBytes` | `number` | 64 KiB | Stdin buffered per running process in `bytes` |
| `maxQueuedStdinBytes` | `number` | 8 MiB | Stdin buffered for one not yet started exec in `bytes` (at least `maxStdinBytes`) |
| `maxTotalQueuedStdinBytes` | `number` | 32 MiB | Stdin buffered across all not yet started execs in `bytes` |
| `maxQueuedExecs` | `number` | `64` | Max running plus queued commands ([Running Commands](./exec.md#vmexec)) |
| `netSocketPath` | `string` | — | Ignored |
| `virtioSocketPath`, `virtioFsSocketPath`, `virtioSshSocketPath`, `virtioIngressSocketPath` | `string` | — | Not supported; setting any of them throws |

## Daemon Connection Options

`VMOptions.native` (`NativeEngineOptions`) tells Gondolin how to reach the
daemon. By default it starts the local `gondolind` binary; see
[Remote Machines](./remote.md) for running VMs elsewhere.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command` | `string[]` | `GONDOLIN_NATIVE_COMMAND` | Command that starts `gondolind` speaking the controller protocol on stdio, e.g. `["ssh", host, "gondolind"]` |
| `connect` | `() => NativeConnection \| Promise<NativeConnection>` | — | Connection factory; wins over `command` |
| `remote` | `boolean` | `GONDOLIN_NATIVE_REMOTE=1` | The daemon runs on another machine: it resolves the image and creates the root disk itself, and *local* sandbox options are rejected |
| `image` | `string` | `GONDOLIN_NATIVE_IMAGE`, else a string `sandbox.imagePath`, else the daemon's default | Image selector for a remote daemon (`name:tag`, build id, or a directory on the daemon's machine) |
| `checkpoint` | `string` | — | Local checkpoint file to boot from on a remote daemon (uploaded); set by `VmCheckpoint.resume()` |

## VM

| Member | Description |
|---|---|
| `VM.create(options?)` | Resolve the image (downloading it if needed) and return a `VM`; does not boot it ([Running Commands](./exec.md#creating-starting-and-closing)) |
| `new VM(options?)` | Synchronous constructor; the image must already be available locally |
| `vm.id` | Session UUID, also used by `gondolin list` / `attach` |
| `vm.fs` | Guest filesystem operations, see [`vm.fs`](#vmfs) |
| `vm.remote` | `true` when the daemon runs on another machine |
| `vm.engine` | Always `"native"` |
| `vm.start()` | Boot the VM and wait for guest readiness; idempotent |
| `vm.close()` | Stop the VM and release all resources; a closed VM cannot be restarted |
| `vm.exec(command, options?)` | Run a command; returns an `ExecProcess` ([Running Commands](./exec.md#vmexec)) |
| `vm.shell(options?)` | Interactive shell (PTY + stdin), attached to the terminal by default ([Running Commands](./exec.md#vmshell)) |
| `vm.enableSsh(options?)` | Start `sshd` in the guest and a local forwarder; returns `SshAccess` ([SSH](./ssh.md)) |
| `vm.enableIngress(options?)` | Start the host ingress gateway; returns `IngressAccess` ([Ingress](./ingress.md)) |
| `vm.getIngressRoutes()` | Current ingress routes (from `/etc/gondolin/listeners`) |
| `vm.setIngressRoutes(routes)` | Replace the ingress routes |
| `vm.checkpoint(path)` | Stop the VM and write a disk checkpoint to the absolute `path`; returns a `VmCheckpoint` ([Persistence and Snapshots](./snapshots.md)) |
| `vm.getHostPid()` | Host PID of the QEMU / krun runner process, or `null` ([Running Commands](./exec.md#host-process-id)) |
| `vm.setDebugLog(callback)` | Replace the debug log sink (`null` disables); only has an effect when debugging was enabled at creation ([Debugging](./debug.md)) |

Option types: `ShellOptions` (`command`, `env`, `cwd`, `signal`, `attach`),
`EnableSshOptions` (`user`, `listenHost`, `listenPort`), `EnableIngressOptions`
(`listenHost`, `listenPort`, `allowWebSockets`, `hooks`, `bufferResponseBody`,
`maxBufferedResponseBodyBytes`, `upstreamHeaderTimeoutMs`,
`upstreamResponseTimeoutMs`).

### ExecProcess and ExecResult

`vm.exec()` returns an `ExecProcess`; awaiting it yields an `ExecResult`.
Options (`ExecOptions`) are listed in
[Running Commands](./exec.md#exec-options).

| `ExecProcess` member | Description |
|---|---|
| `then` / `catch` / `finally`, `result` | Promise of the `ExecResult` |
| `id` | Request id |
| `write(data)` | Write to stdin (needs `stdin: true`); `false` means wait for `drain()` |
| `drain()` | Resolves when stdin accepts more data |
| `end()` | Close stdin |
| `resize(rows, cols)` | Resize the PTY |
| `kill(signal?)` | Signal the command and its child processes in the guest (default `"SIGTERM"`); `false` when it already finished ([Cancellation](./exec.md#cancellation)) |
| `stdout`, `stderr` | Readable streams in `"pipe"` mode, else `null` |
| `[Symbol.asyncIterator]()` | Stdout chunks as strings (`"pipe"` mode) |
| `lines()` | Stdout lines (`"pipe"` mode) |
| `output()` | Labelled `{ stream, data, text }` chunks of both streams (both piped) |
| `attach(stdin, stdout, stderr?)` | Wire the process to a terminal or streams ([Running Commands](./exec.md#procattach)) |

`ExecResult`: `exitCode`, `signal`, `ok`, `stdout`, `stderr`, `stdoutBuffer`,
`stderrBuffer`, `json()`, `lines()`, `id`; see
[What Is in `ExecResult`](./exec.md#what-is-in-execresult).

### `vm.fs`

`VmFs` operates on paths of the running guest (booting it on first use):
`access()`, `mkdir()`, `listDir()`, `stat()`, `rename()`, `readFile()`,
`readFileStream()`, `writeFile()` and `deleteFile()`. See
[Files and Mounts](./vfs.md) for semantics and examples.

### VmCheckpoint

A disk checkpoint (a `.qcow2` file with a JSON metadata trailer); see
[Persistence and Snapshots](./snapshots.md).

| Member | Description |
|---|---|
| `VmCheckpoint.load(path)` | Load a checkpoint file |
| `checkpoint.resume(options?)` | Create a new VM from the checkpoint (`Promise<VM>`); `options` are merged over those of the VM that created it |
| `checkpoint.delete()` | Delete the checkpoint file |
| `name`, `path`, `dir`, `diskPath` | Name and absolute paths |
| `guestAssetBuildId` | Build id of the image the checkpoint needs |
| `toJSON()` | Metadata (`VmCheckpointData`) |
| `VmCheckpoint.writeTrailer(diskPath, data)` | Append a metadata trailer to a qcow2 file (low level) |
| `checkpoint.clone(options?)` | Deprecated alias of `resume()` |

## Other Exports

### VFS Providers

See [Files and Mounts](./vfs.md).

- `MemoryProvider`: in-memory filesystem
- `RealFSProvider`: a host directory
- `ReadonlyProvider`: wraps a provider and rejects writes with `EROFS`
- `ShadowProvider`, `createShadowPathPredicate()`: hide paths of a wrapped
  provider (deny or redirect writes)
- `ReadonlyVirtualProvider`: base class for read-only, sync-first custom
  providers
- `VirtualProvider`, `VirtualProviderClass`: provider base classes for custom
  providers
- `VirtualFileSystem`: mount-routing file system over providers
- `SandboxVfsProvider`: wrapper that applies `VfsHooks` to a provider
- Helpers for custom providers: `ERRNO`, `isWriteFlag()`, `normalizeVfsPath()`,
  `VirtualDirent`, `createVirtualDirStats()`, `formatVirtualEntries()`
- `DEFAULT_GUEST_TMPFS`: the built-in tmpfs set, for extending `tmpfs`

### Daemon-Served Mounts

Mounts the Gondolin daemon serves itself (also on remote machines); see
[Files and Mounts](./vfs.md).

- `nativeMounts.memory()`: an in-memory filesystem kept in the daemon
- `nativeMounts.host(dir, { readonly, hide, hideWriteMode })`: a directory on
  the daemon's machine
- `createObjectMount(provider, options)` / `nativeMounts.object(...)`: mount
  an `ObjectProvider` (whole-file get/put store) cached by the daemon;
  `ObjectVirtualProvider` is its host-side `VirtualProvider` view

### HTTP Hooks and Secrets

See [HTTP Hooks and Policies](./hooks.md) and [Secrets](./secrets.md).

- `createHttpHooks(options)`: build `httpHooks` from an allowlist, secrets and
  callbacks; returns `{ httpHooks, env, allowedHosts, secretManager }`
- `createDjsHooks(sourceOrOptions)`: a JavaScript / TypeScript policy run
  inside the daemon (tier-2 hooks)
- `djsHooksOptionsFromFile(file)`: load a tier-2 policy file into
  `DjsHooksOptions`
- `makePlaceholderFunc(options)`: custom secret placeholder generator;
  alphabets `HEX_ALPHABET`, `LOWERCASE_ALPHABET`, `UPPERCASE_ALPHABET`,
  `BASE32_ALPHABET`, `BASE32_HEX_ALPHABET`, `BASE62_ALPHABET`,
  `BASE64URL_ALPHABET`
- `HttpRequestBlockedError`: throw from a hook to block a request
- `suggestHostsForSecret(options)`: suggest upstream hosts for a secret value
  (what `--host-secret NAME` without hosts uses)

### Network and SSH

See [Network Access](./network-access.md) and [SSH](./ssh.md).

- Types: `DnsOptions`, `DnsMode`, `SyntheticDnsHostMappingMode`, `TcpOptions`,
  `HttpHooks`, `HttpIpAllowInfo`, `SshOptions`, `SshCredential`,
  `SshExecRequest`, `SshExecDecision`, `SshExecPolicy`
- `getInfoFromSshExecRequest(request)`: parse a git-over-SSH exec request
  (service and repository) for SSH exec policies

### Ingress

See [Ingress](./ingress.md).

- `IngressGateway`, `GondolinListeners`: the gateway behind
  `vm.enableIngress()` and the routing table it reads
- `parseListenersFile()`, `serializeListenersFile()`: the
  `/etc/gondolin/listeners` format
- `IngressRequestBlockedError`: throw from an ingress hook to reject a request
- Types: `IngressRoute`, `EnableIngressOptions`, `IngressAccess`,
  `IngressGatewayHooks` and the hook request/response types

### Sessions

The session registry behind `gondolin list` / `attach`; see
[Running Commands](./exec.md#sessions-and-attaching-from-outside).

- `listSessions()`: registered sessions with liveness
- `findSession(query)`: a session by UUID or unique prefix
- `gcSessions()`: remove stale entries and orphan sockets
- `connectToSession(socketPath, callbacks)`: connect to a session's IPC socket
- `registerSession()`, `unregisterSession()`, `SessionIpcServer`: what a `VM`
  uses to register itself

### Guest Assets and Images

See [Images](./images.md).

- `ensureGuestAssets()`: download the default image if needed and return its
  `GuestAssets` paths
- `hasGuestAssets()`, `getAssetDirectory()`, `getAssetVersion()`: check the
  default image without downloading
- `loadGuestAssets(dir)`, `loadAssetManifest(dir)`: read an asset directory
- `resolveImageSelector(selector)`, `ensureImageSelector(selector)`: resolve
  a path, `name:tag` or build id locally, or also pull it from the registry
- `listImageRefs()`, `setImageRef()`, `tagImage()`, `removeImage()`,
  `importImageFromDirectory()`: manage the local image store
- `getImageStoreDirectory()`, `getImageObjectDirectory(buildId)`: store paths

### Daemon Binaries

For deploying `gondolind` to other machines; see
[Remote Machines](./remote.md).

- `ensureNativeBinary({ platform, arch })`: the multi-call `gondolin` binary
  for a platform, downloaded from npm if needed; returns `{ path, args }`
- `getNativeBinaryPath(target)`: the same without downloading, or `null`
- `nativeDaemonCommand(binary)`, `nativeDaemonArgs(binary)`: the command line
  that starts the daemon from a binary
- `nativePackageName(target)`, `nativeRustTarget(target)`: npm package and
  Rust target of a platform
- `spawnNativeConnection(command)`: spawn a daemon command as a
  `NativeConnection` for `native.connect`

### Image Build API

See [Building Custom Images](./custom-images.md).

- `buildAssets(config, options)`: build guest assets from a `BuildConfig`
- `verifyAssets(dir)`: verify asset checksums against the manifest
- `getDefaultBuildConfig()`, `getDefaultArch()`, `validateBuildConfig()`,
  `parseBuildConfig()`, `serializeBuildConfig()`: build configuration helpers
- Types: `BuildConfig`, `AlpineConfig`, `NixOSConfig`, `ContainerConfig`,
  `OciRootfsConfig`, `RootfsConfig`, `InitConfig`, `RuntimeDefaultsConfig`,
  `RootfsMode`, `Architecture`, `Distro`, `ContainerRuntime`, `OciPullPolicy`

### Debugging

Types `DebugFlag`, `DebugConfig`, `DebugComponent` and `DebugLogFn`; see
[Debugging and Troubleshooting](./debug.md).

## Environment Variables

Several defaults above come from environment variables (`GONDOLIN_VMM`,
`GONDOLIN_GUEST_DIR`, `GONDOLIN_DEBUG`, `GONDOLIN_START_TIMEOUT_MS`,
`GONDOLIN_NATIVE_COMMAND`, ...). See [Environment Variables](./environment.md)
for the full list.

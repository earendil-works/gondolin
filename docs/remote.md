# Remote Machines

The VM does not have to run on the machine your program runs on. The Gondolin
daemon (`gondolind`) needs neither Node.js nor any other runtime, so you can
start it on another machine (for example over SSH) while your policy,
credentials, hooks and file providers stay in your local Node.js process (the
*controller*).

```bash
gondolin --native-command "ssh build-box gondolind" --remote bash
```

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

The remote machine needs the `gondolin` binary (see
[Getting the Binary onto Another Machine](#getting-the-binary-onto-another-machine))
and QEMU (the default backend for remote daemons, see [Backend](#configuration)
below) or the krun runner; no `qemu-img`. Node.js is only needed where the
controller runs.

## How It Works

The controller talks to the daemon over the daemon's stdin/stdout. Anything
that gives you such a byte stream works: `ssh host gondolind`, a container
exec, or your own transport. The daemon starts the VMM, runs the network
stack and serves the guest filesystem on its machine, and calls back into the
controller for the things that live in your process (JavaScript hooks, custom
VFS providers, files of your machine).

The daemon exits (and kills its VM) when its stdin closes, so a crashed or
killed controller never leaves VMs running behind. On Linux QEMU is also tied
to the daemon's lifetime; on macOS a small watchdog process does the same.

For the process model and protocol, see [Architecture](./architecture.md).

## Configuration

### SDK

`VMOptions.native` says how to reach the daemon:

| Option | Meaning |
| --- | --- |
| `command` | argv that starts `gondolind` with the controller protocol on its stdin/stdout (e.g. `["ssh", host, "gondolind"]`) |
| `connect()` | returns a [connection](#connections) (wins over `command`) |
| `remote` | the daemon runs on another machine: no shared filesystem |
| `image` | image selector for the daemon (`name:tag`, build id, or a directory on the daemon's machine); default: the daemon's default image |
| `checkpoint` | local checkpoint file to boot from; set by `VmCheckpoint.resume()` for remote daemons, you rarely set it yourself |

Without `command` or `connect`, the SDK starts the local `gondolind` binary
(see [Installation](./install.md#the-gondolin-daemon-binary)). `command` without `remote` is for daemons
that share your filesystem (a wrapper script, a different binary); set
`remote: true` whenever the daemon cannot see your files.

### Environment Variables

The same settings are available as environment variables (explicit
`VMOptions.native` fields win):

- `GONDOLIN_NATIVE_COMMAND`: the daemon command, as whitespace-separated
  words or a JSON array (`'["ssh", "build-box", "gondolind"]'`)
- `GONDOLIN_NATIVE_REMOTE=1` (or `true`): the daemon is remote
- `GONDOLIN_NATIVE_IMAGE`: image selector for the daemon

See [Environment Variables](./environment.md#daemon-and-remote-machines) for
the full list.

### CLI

The Node CLI takes the same settings as global options, before the command;
they apply to every VM the command starts (including `bash --resume`,
`--listen` and `--ssh`):

```bash
gondolin --native-command "ssh build-box gondolind" --remote bash
gondolin --native-command='["ssh", "build-box", "~/bin/gondolin", "daemon"]' --remote exec -- uname -a
```

| Flag | Meaning |
| --- | --- |
| `--native-command CMD` | start the daemon with `CMD` (words, or a JSON array); same as `GONDOLIN_NATIVE_COMMAND` |
| `--remote` | the daemon runs on another machine; same as `GONDOLIN_NATIVE_REMOTE=1` |

`gondolind` is the name the npm platform package installs; where only the
binary was copied, start it as `gondolin daemon` (for example
`--native-command "ssh build-box ~/bin/gondolin daemon"`).

The [static CLI](./cli.md#static-cli-no-nodejs) runs the VM in-process and
does not support these flags; use the Node CLI for remote machines.

`gondolin list`, `attach` and `exec --sock` work for remote VMs as for local
ones: the session registry lives on the controller's machine.

## What Remote Changes

With `remote: true` the controller never sends paths of its own machine to the
daemon (it refuses to, so mistakes fail loudly instead of pointing at the wrong
files):

- **Images** are resolved and downloaded by the daemon from its own image
  cache (the same layout as on a local machine, `~/.cache/gondolin/images`).
  `native.image` wins over `sandbox.imagePath`, which must be a selector
  string; explicit asset paths are rejected. Without either, the daemon uses
  its default image, so `GONDOLIN_DEFAULT_IMAGE`, `GONDOLIN_GUEST_DIR` and
  `GONDOLIN_IMAGE_STORE` apply in the daemon's environment, not yours.
- **Root disks** are prepared by the daemon: the `rootfs.mode` (`cow`,
  `memory`, `readonly`, or the image manifest's default) and `rootfs.size`
  work as usual, and the copy-on-write overlay lives in the daemon's session
  directory, as it does locally.
- **Checkpoints** (`vm.checkpoint()`, `gondolin snapshot`) are written on the
  controller in the usual single-file format: the daemon stops the VM and
  streams its disk overlay. Resuming (`VmCheckpoint.resume()`,
  `gondolin bash --resume`) uploads the checkpoint to the daemon, which finds
  the matching image by build id. See
  [Persistence and Snapshots](./snapshots.md).
- **TLS interception** uses the daemon's own MITM CA (created and cached on
  the daemon's machine); the guest trusts that one. Upstream certificates are
  still verified against the controller's Node.js CA store (including
  `NODE_EXTRA_CA_CERTS`).
- **VFS mounts** of controller-side directories (`RealFSProvider`, also
  wrapped in `ReadonlyProvider`/`ShadowProvider`, and `--mount-hostfs`) are
  served from the controller through the object tier, since the daemon cannot
  see those files; every uncached operation is a round trip over the
  connection. To mount a directory on the daemon's machine, use
  `nativeMounts.host("/path/on/daemon")`. See
  [Files and Mounts](./vfs.md).
- **HTTP hooks** written in JavaScript (`onRequest`, `onResponse`, ...) run in
  the controller, so each hooked request crosses the connection. Declarative
  policy and `createDjsHooks()` policies run in the daemon (see
  [HTTP Hooks and Policies](./hooks.md)).
- **SSH egress** credentials (`ssh.credentials`) are sent to the daemon;
  `ssh.agent` is not supported remotely (the agent socket is on the
  controller). `known_hosts` files are read by the controller and sent as
  content. See [SSH](./ssh.md#ssh-egress).
- **DNS**: the controller's resolvers are not used; the daemon uses explicitly
  configured servers (`dns.trustedServers`) or its own `/etc/resolv.conf`.
- **SSH and ingress access** (`vm.enableSsh()`, `vm.enableIngress()`,
  `--ssh`, `--listen`) listen on the controller's machine; the streams are
  tunneled through the daemon connection.
- **Backend**: the default is `qemu`, as the controller cannot see whether the
  daemon's machine has a krun runner and `/dev/kvm`. Set `sandbox.vmm: "krun"`
  (or `GONDOLIN_VMM=krun`, `--vmm krun`) to use krun; the runner is
  `sandbox.krunRunnerPath` on the daemon's machine, else
  `gondolin-krun-runner` from its `PATH`. `sandbox.qemuPath`, if set, is a
  path on the daemon's machine too. See [VM Backends](./backends.md).
- `vm.getHostPid()` returns `null` (the VMM runs on another machine).
- Not supported remotely (they name files on the controller's machine):
  `sandbox.rootDiskPath`, `rootDiskFormat`, `rootDiskReadOnly`,
  `rootDiskDeleteOnClose`, the `sandbox.virtio*SocketPath` overrides, and
  `sandbox.imagePath` as an object of asset paths.

Some configuration errors are reported when the VM starts rather than when
`VM.create()` returns, because the daemon validates them on its machine (for
example SSH credential files, a missing QEMU binary, an unknown image).

## Connections

`native.connect()` returns an object with this shape (`NativeConnection`);
pi-env's `openProcess` returns a compatible object, and
`spawnNativeConnection(command, { env?, cwd? })` builds one from a local
command:

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
  /** optional: forcefully terminate the daemon */
  kill?(): void;
  /** optional: resolves once `write()` accepts more data */
  waitDrain?(): Promise<void>;
  /** optional: local process id (local children only) */
  pid?: number | null;
};
```

```ts
import { VM, spawnNativeConnection } from "@earendil-works/gondolin";

const vm = await VM.create({
  native: {
    remote: true,
    // `env`: a pi-env environment (or anything returning a NativeConnection)
    connect: async () => env.openProcess("gondolind", []),
  },
});

// equivalent to native.command, with a custom environment for ssh
const vm2 = await VM.create({
  native: {
    remote: true,
    connect: () =>
      spawnNativeConnection(["ssh", "build-box", "gondolind"], {
        env: { ...process.env, SSH_AUTH_SOCK: "/path/to/agent.sock" },
      }),
  },
});
```

Lines the daemon writes to stderr arrive in your
[debug log](./debug.md#daemon-diagnostics) as the `error` component.

## Getting the Binary onto Another Machine

The daemon ships as one multi-call binary, `gondolin`: the static CLI, and
the daemon when started as `gondolin daemon` (or under the name `gondolind`,
e.g. through a symlink). One file is all a remote machine needs; Linux builds
are static musl binaries.

`getNativeBinaryPath({ platform, arch })` finds a binary for any supported
platform (`darwin` or `linux`, `arm64` or `x64`) without network access: a
development checkout (`native/target/dist/<target>/` from `make
native-release` for other platforms), an installed platform package, or the
download cache. `ensureNativeBinary({ platform, arch })` also downloads the
matching platform package from the npm registry (checking its integrity) into
`~/.cache/gondolin/native/<version>/<platform>-<arch>/`. Package managers only
install the platform package matching your machine, so this is how a macOS
controller gets the Linux binary.

Both return `{ path, args }`: the binary and the arguments that start the
daemon (`["daemon"]` for the multi-call `gondolin`, none for a file named
`gondolind`):

```ts
import { ensureNativeBinary } from "@earendil-works/gondolin";

const { path, args } = await ensureNativeBinary({ platform: "linux", arch: "x64" });
// copy `path` to the remote machine (e.g. as ~/bin/gondolin), then
// native: { command: ["ssh", host, "~/bin/gondolin", ...args], remote: true }
```

Related helpers:

- `nativeDaemonArgs(binary)`: the daemon arguments for a binary path
- `nativeDaemonCommand(binary)`: `[binary, ...nativeDaemonArgs(binary)]`
- `nativePackageName({ platform, arch })`: the npm package carrying the
  binary (`@earendil-works/gondolin-native-linux-x64`, ...)
- `nativeRustTarget({ platform, arch })`: its Rust target triple

`ensureNativeBinary()` accepts `version` (default: the SDK's version, which
should match the daemon) and `registry` (default: `$npm_config_registry` or
`https://registry.npmjs.org`).

The daemon also brings its own image tooling, which is handy on machines
without Node.js, for example to pre-pull images (`gondolind ARGS` is the same
as `gondolin daemon ARGS`; the static CLI's `gondolin image` manages the same
cache):

```bash
gondolin daemon --version
gondolin daemon assets list [--json]
gondolin daemon assets pull alpine-base:latest [--arch ARCH] [--json]
gondolin daemon assets resolve [SELECTOR] [--arch ARCH] [--offline] [--json]
```

`assets resolve` without a selector resolves the default image. See
[Images](./images.md).

## Troubleshooting

**`not supported with a remote daemon: ...`**: the named option names
files on the controller's machine (see
[What Remote Changes](#what-remote-changes)). Drop it, or use the remote
equivalent (`native.image`, `nativeMounts.host()`).

**`remote session must not send a controller-local path: ...`**:
something resolved to a path on the controller (typically `sandbox.imagePath`
or `native.image` pointing at a local directory). Use an image selector
the daemon can resolve, or the daemon's own default image.

**`ssh.agent is not supported with a remote gondolind`**: use
`ssh.credentials` (`--ssh-credential`) instead of `ssh.agent`
(`--ssh-agent`).

**`gondolind exited (code=...) (...)`** or **`gondolind failed to start`**:
the daemon command failed; the message ends with the last line the command
wrote to stderr (for example `gondolind: command not found`, exit code
`127`). Run the command by hand (`ssh build-box gondolind --version`) to check that
the binary is on the remote `PATH` (non-interactive SSH sessions often have a
shorter `PATH`; use an absolute path) and executable for that platform.

**The VM uses `qemu` although the machine has krun**: remote daemons default
to `qemu`; set `sandbox.vmm: "krun"` or `--vmm krun`.

For daemon stderr and other diagnostics, see
[Debugging and Troubleshooting](./debug.md).

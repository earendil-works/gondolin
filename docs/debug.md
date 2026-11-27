# Debugging and Troubleshooting

When something does not work, three tools usually find the cause quickly:

```bash
# Debug logging for all components
GONDOLIN_DEBUG=all gondolin bash

# The session configuration the CLI would send, without starting a VM
gondolin bash --allow-host api.github.com --print-configure

# The Gondolin version and the gondolind binary it would use
gondolin version
```

```ts
const vm = await VM.create({ sandbox: { debug: true } });
```

This page covers [debug logging](#debug-logging),
[daemon diagnostics](#daemon-diagnostics) and
[common errors](#troubleshooting).

## Debug Logging

Gondolin has several debug channels that can be enabled independently. Debug
output is routed through a callback so you can capture it in your own code.

### Environment Variable

Set `GONDOLIN_DEBUG` to a comma-separated list of flags:

- `net`: networking stack / HTTP bridge
- `exec`: exec + stdin/pty control messages
- `vfs`: VFS operations and the guest filesystem transport (`fs` is accepted
  as an alias)
- `protocol`: virtio/control-protocol traffic and QEMU log forwarding,
  including the guest's full boot log (see [Boot log](#boot-log))
- `timing`: when each step of starting and stopping the VM finished (root
  disk, network, VMM spawn, guest channels, first guest messages, shutdown),
  in milliseconds since the session was created and since the previous step;
  at shutdown also the host time of each sandboxfs operation (count, mean,
  max)
- `all` (or `*`, `1`, `true`): turns on everything

Unknown flags are ignored. The [static CLI](./cli.md#static-cli-no-nodejs)
reads `GONDOLIN_DEBUG` the same way and prints the messages to stderr.

Examples:

```bash
# Network + exec
export GONDOLIN_DEBUG=net,exec

# Everything
export GONDOLIN_DEBUG=all
```

### Programmatic (per-VM)

Debug flags are also available on `sandbox.debug`; when set, it replaces
`GONDOLIN_DEBUG` for that VM:

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  sandbox: {
    // Enable only selected components
    debug: ["net", "exec"],

    // Or:
    // debug: true,  // enable everything
    // debug: false, // disable everything
  },
});
```

### Intercepting Debug Output

When any debug mode is enabled, the VM emits debug messages to a callback:

- By default it logs to `console.log` as `[component] message`
- The component is one of the flags above, `qemu` (VMM output, forwarded
  with `protocol`) or `error` (errors and
  [daemon stderr](#daemon-diagnostics))
- You can override it with `debugLog`
- You can disable debug printing entirely by passing `debugLog: null`

```ts
import { VM, type DebugComponent } from "@earendil-works/gondolin";

const logs: Array<{ component: DebugComponent; message: string }> = [];

const vm = await VM.create({
  sandbox: { debug: ["net", "vfs"] },
  debugLog(component, message) {
    logs.push({ component, message });
  },
});

await vm.start();

const result = await vm.exec("echo hello");
console.log("exitCode:", result.exitCode);
console.log("stdout:\n", result.stdout);
console.log("stderr:\n", result.stderr);

await vm.close();
```

You can also change the callback after construction (debug flags must have
been enabled when the VM was created):

```ts
vm.setDebugLog((component, message) => {
  // route into your own logger
});
```

### Notes

- `exec` debug logs only include environment *keys* (not values) to reduce
  accidental secret leakage.
- Debug messages are best-effort: if your callback throws, Gondolin ignores
  the error.
- The flags are passed to `gondolind`, which forwards its events to the same
  callback (VMM output as `qemu` with `protocol`, network stack tracing with
  `net`, the filesystem transport choice with `vfs`).
- Ingress `502` errors are printed to stderr (`ingress bad gateway: ...`) when
  `GONDOLIN_DEBUG` is set to anything (see [Ingress](./ingress.md#debugging)).

## Daemon Diagnostics

The VM is driven by the Gondolin daemon (`gondolind`), which your process
starts (see [Architecture](./architecture.md)). Besides the debug events, it
offers a few diagnostics of its own.

**Daemon stderr.** Lines the daemon writes to its stderr arrive in the debug
callback as the `error` component, prefixed with `gondolind:` (with debug
enabled). When the daemon exits unexpectedly, the error names its exit status
and the last stderr line: `gondolind exited (code=1) (...)`. An internal
failure stops the VM with `gondolind internal error, VM stopped: ...`.

**Session configuration.** `--print-configure` (on `gondolin bash` and on
`gondolin exec` in VM mode, in both CLIs) prints the configuration the CLI
would send to the daemon as JSON and exits without starting a VM. Byte strings
appear as `{ "$base64": ... }`; the MITM CA key and secret values are
redacted. Use it to check what your flags turn into (allowlists, mounts, DNS,
image, backend):

```bash
gondolin exec --mount-hostfs "$PWD:/workspace" --print-configure
gondolin bash --resume 4a8f2b0c --print-configure
```

**Daemon tools.** The daemon binary has a few subcommands of its own
(`gondolind ARGS` is the same as `gondolin daemon ARGS` with the static CLI's
binary):

```bash
# version of the daemon
gondolind --version

# QEMU command line the daemon would use for a configuration (JSON on stdin)
echo '{"vm": {"qemu_path": "qemu-system-aarch64", "kernel_path": "/k", "initrd_path": "/i", "memory": "1G", "cpus": 2}}' \
  | gondolind --qemu-args

# format, virtual size and backing file of a disk image or checkpoint (JSON),
# what `qemu-img info` would report
gondolind --disk-info ~/.cache/gondolin/checkpoints/dev-base.qcow2

# load or create the MITM CA in a directory and print its certificate
# (default directory: ~/.cache/gondolin/ssl)
gondolind --mitm-ca ~/.cache/gondolin/ssl

# images the daemon can see, and what a selector resolves to
gondolind assets list
gondolind assets resolve alpine-base:latest --offline --json
```

`gondolin version` (Node CLI) prints the package version and the `gondolind`
command it would start, or why none was found. The static CLI prints
`gondolin X.Y.Z (static)`.

## Boot log

On QEMU and Firecracker, guests boot with `quiet` on the kernel command line,
so the kernel and the guest's init print only warnings and errors (panics
included). Their consoles are emulated serial ports (`ttyS0`, `ttyAMA0`),
where the full boot log costs about 0.9 s per boot whether or not anyone reads
it. krun's virtio console is cheap, so krun guests keep the full log. You get
it back on QEMU and Firecracker with:

- `GONDOLIN_DEBUG=protocol` (or `sandbox.debug: ["protocol"]`), which also
  forwards it, or
- `sandbox.console: "stdio"`, or
- a `sandbox.append` that sets the log level itself (`loglevel=7`, `debug`).

## Troubleshooting

### Installation and Startup

**`gondolind binary not found (install @earendil-works/gondolin-native-..., build it with make native, or set GONDOLIN_NATIVE_BIN)`**:
the platform package with the `gondolind` binary is missing, typically
because optional dependencies were skipped (`npm install --omit=optional`).
Install the platform package, set `GONDOLIN_NATIVE_BIN` to a `gondolin` or
`gondolind` binary, or in a checkout build it (`make native`). See
[Installation](./install.md#the-gondolin-daemon-binary).

**`gondolind is not available for <platform>-<arch>`**: there is no
published binary for this platform; set `GONDOLIN_NATIVE_BIN` to one you
built.

**`the node engine has been removed; ...`**: drop `engine: "node"`,
`GONDOLIN_ENGINE=node` or `--engine node`. See [Upgrading](./upgrading.md).

**`Error: QEMU binary 'qemu-system-aarch64' not found.`** (Node CLI, followed
by the install command for your platform),
**`QEMU binary '...' not found: install QEMU or use the krun backend (sandbox.vmm: "krun")`**
(SDK) or **`qemu-system-aarch64 not found: install QEMU (macOS: brew install
qemu; Debian/Ubuntu: apt install qemu-system-arm) or use --vmm krun`** (static
CLI): the VM uses the `qemu` backend and QEMU is missing. Install it on the
machine the daemon runs on (`brew install qemu`; on Debian/Ubuntu
`qemu-system-arm` for `qemu-system-aarch64`, `qemu-system-x86` for
`qemu-system-x86_64`), point `sandbox.qemuPath` at it, or use krun where the
host supports it (see [VM Backends](./backends.md#default-backend-selection)).
A remote daemon reports `cannot run qemu-system-...` when the VM starts.
`qemu-img` is not needed.

**`vm startup timed out after 120000ms while waiting for guest readiness`**:
the guest did not boot, connect, or mount its filesystems in time. Check the
debug output (`GONDOLIN_DEBUG=protocol` forwards the VMM's output) first. On
slow hosts (nested virtualization, software emulation without KVM/HVF) raise
the limit:

- `VMOptions.startTimeoutMs` or `GONDOLIN_START_TIMEOUT_MS` (in `ms`;
  default `120000` in the SDK and Node CLI, `60000` in the static CLI;
  `startTimeoutMs <= 0` disables the timeout)
- `GONDOLIN_VFS_READY_TIMEOUT_MS` (default `30000`) for
  `vfs mount <path> not ready` errors

**`Guest assets not found`** or an unknown image: check the selector with
`gondolin image inspect <selector>`; see [Images](./images.md).

### Options

**`not supported: ...`**: the named option (for
example `sandbox.virtioSocketPath`) cannot be honoured; remove it. The daemon
owns its private socket directory.

**`not supported with a remote daemon: ...`** and
**`remote session must not send a controller-local path: ...`**: an
option names files on your machine while the daemon is remote. See
[Remote Machines](./remote.md#troubleshooting).

**`Unsupported sandbox options for vmm=krun: ...`**: `qemuPath`,
`machineType`, `accel` and `cpu` only work with QEMU. Drop them or select
`vmm: "qemu"`. See [VM Backends](./backends.md).

### Images and Backends

**`Guest image architecture mismatch`**: the image's architecture does not
match the QEMU binary (`qemu-system-aarch64` vs `qemu-system-x86_64`), or,
with krun, the host. Use a matching `sandbox.qemuPath`, or pull or build the
image for the right architecture (`gondolin image pull <ref> --arch
x86_64`, `gondolin build --arch ...`).

**`Selected image does not provide krun boot assets.`**: `vmm: "krun"` was
requested but the image's manifest has no `krunKernel`. Use an image built
with `gondolin build` or a published image with krun assets, or use QEMU. The
default backend selection never picks krun for such images.

**`krun runner binary '...' not found`**: install the runner package (macOS
arm64, Linux x64), build it (`make krun-runner`), or set
`sandbox.krunRunnerPath` / `GONDOLIN_KRUN_RUNNER`.

**`krun runner is not signed with the macOS Hypervisor entitlement`**: the
runner on macOS must be signed with `com.apple.security.hypervisor`. Rebuild
it with `make krun-runner` or set `GONDOLIN_KRUN_RUNNER` to a signed runner.

**The guest uses sandboxfs instead of virtio-fs** (slow mounts; the `vfs`
debug flag shows `virtio-fs unavailable (...); using sandboxfs`): the VMM
cannot serve virtio-fs. QEMU needs vhost-user support (`qemu-system-... -device
help` lists `vhost-user-fs-pci`; Linux distribution builds have it,
Homebrew's QEMU does not), krun needs a runner with the `virtiofs-socket`
capability, and images whose `sandboxfs` predates virtio-fs always use
sandboxfs. `GONDOLIN_VIRTIOFS=1` turns the message into a warning;
`GONDOLIN_VIRTIOFS=0` forces sandboxfs. See [Files and Mounts](./vfs.md).

### Root Disks and Checkpoints

**`cannot resume checkpoint ...`**: the daemon refused the checkpoint's qcow2
header (external data file, encryption, extended L2 entries, corrupt flag,
unknown features or `repeated header extension ...`) or its backing chain does not end in the image's rootfs
after the rebase. Checkpoints written by Gondolin pass; see
[Persistence and Snapshots](./snapshots.md#validation-on-resume).

**`backing file without a backing format (set it with qemu-img rebase -u -F raw|qcow2)`**:
a qcow2 `sandbox.rootDiskPath` (or a file in its chain) names its backing
file without recording its format. Run
`qemu-img rebase -u -F raw -b BACKING DISK` (or `-F qcow2`). Related
refusals: `backing file name "..." is not a file path` (a protocol or JSON
name such as `json:` or `nbd:`), `unsupported backing format "..."`,
`repeated header extension ...`, `not a regular file`, `backing chain loop
at ...` and `backing chain too long`. A block device as `rootDiskPath` must
be attached raw (`a block device can only be attached as a raw disk
(sandbox.rootDiskFormat "raw"), not qcow2`), and `rootfs.size` on it fails
with `block device ... has N bytes, less than M (block devices are not
resized)` when it is too small. See
[Security Design](./security.md#root-disks-and-checkpoints).

**`cannot checkpoint: ...`**: the root disk cannot be exported: `root disk
is running in ephemeral snapshot mode` (`rootfs.mode: "memory"` on QEMU),
`root disk must be qcow2 (got ...)` (`readonly` mode or a raw own disk),
`root disk is read-only` (`sandbox.rootDiskReadOnly`), or the image has no
`buildId`. See [Persistence and Snapshots](./snapshots.md#creating-a-checkpoint).

### Network

**HTTPS requests from the guest fail with `502`**: the host could not verify
the upstream certificate (or the host is not allowed). The Node.js SDK and
CLI trust Node's CA store plus `NODE_EXTRA_CA_CERTS`; the static CLI trusts
the system roots (`SSL_CERT_FILE`/`SSL_CERT_DIR`) and `NODE_EXTRA_CA_CERTS`
but not the macOS keychain. A corporate TLS proxy's CA must be exported (e.g.
`security find-certificate -a -p -c "My Corp CA" > ca.pem`) and passed with
`NODE_EXTRA_CA_CERTS=ca.pem`. `GONDOLIN_DEBUG=net` traces the upstream
connection. See
[Network Access](./network-access.md).

**`dns mode 'trusted' requires at least one IPv4 resolver`**: pass one with
`--dns-trusted-server` / `dns.trustedServers`.

**SSH egress or ingress problems**: see [SSH](./ssh.md) and
[Ingress](./ingress.md#debugging).

### Errors Reported at Start

Some configuration errors are reported when the VM starts rather than when
`VM.create()` returns, because the daemon validates them on its machine (for
example SSH credential files, a missing QEMU binary, an unknown image). With
`autoStart: false`, they surface from `vm.start()` (or the first call that
starts the VM).

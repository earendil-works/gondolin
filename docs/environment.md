# Environment Variables

Gondolin reads the environment variables below. The "Read by" column says
which component honours each one:

- **SDK**: the `@earendil-works/gondolin` package, and so also the Node CLI
  (`gondolin` from npm), which is built on it
- **Node CLI**: only the npm `gondolin` command
- **static CLI**: the self-contained `gondolin` binary (see
  [Installation](./install.md#static-cli))
- **daemon**: `gondolind` itself, which matters for
  [remote daemons](./remote.md): there it reads its own machine's environment

Explicit options (`VMOptions`, CLI flags) win over environment variables.
Paths under `~/.cache/gondolin` move to `$XDG_CACHE_HOME/gondolin` when
`XDG_CACHE_HOME` is set.

## Images and Assets

| Variable | Read by | Meaning |
| --- | --- | --- |
| `GONDOLIN_DEFAULT_IMAGE` | SDK, static CLI, daemon | Image selector used when none is given (`name:tag`, build id or directory). Default: `alpine-base:latest` |
| `GONDOLIN_GUEST_DIR` | SDK, static CLI, daemon | Asset directory (`manifest.json`, kernel, initramfs, rootfs, optional krun boot assets) used instead of the default image; also searched for the assets of a checkpoint on resume |
| `GONDOLIN_GUEST_DHCP` | daemon | `1`: configure the guest network with DHCP instead of passing `gondolin.net=` on the kernel command line (for images whose init cannot apply it). Default: off |
| `GONDOLIN_IMAGE_STORE` | SDK, static CLI, daemon | Local image store (refs and objects). Default: `~/.cache/gondolin/images` |
| `GONDOLIN_IMAGE_REGISTRY_URL` | SDK, static CLI, daemon | URL of the builtin image registry JSON. Default: `https://raw.githubusercontent.com/earendil-works/gondolin/main/builtin-image-registry.json` |
| `XDG_CACHE_HOME` | SDK, static CLI, daemon | Base of the Gondolin cache (`$XDG_CACHE_HOME/gondolin`). Default: `~/.cache` |

The daemon reads the image variables when it resolves an image itself: for
remote sessions and for `gondolin daemon assets ...`. See
[Images](./images.md).

### Image Builds

These affect `gondolin build` and the SDK's image build API (Node only; see
[Building Custom Images](./custom-images.md#sandbox-helper-binaries)):

| Variable | Read by | Meaning |
| --- | --- | --- |
| `GONDOLIN_SANDBOX_HELPERS_DIR` | SDK | Directory with prebuilt guest helpers (`bin/sandboxd`, `bin/sandboxfs`, `bin/sandboxssh`, `bin/sandboxingress`) used instead of the published bundle |
| `GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE` | SDK | `1` (or `true`, `yes`, `on`): build the guest helpers from the local Zig sources instead of downloading them |
| `GONDOLIN_GUEST_SRC` | SDK | Guest source directory (the one with `build.zig`) for source builds outside a checkout. Default: found from the current directory and the package location |
| `GONDOLIN_SANDBOX_HELPER_STORE` | SDK | Cache of downloaded helper bundles. Default: `~/.cache/gondolin/sandbox-helpers` |
| `GONDOLIN_SANDBOX_HELPER_REGISTRY_URL` | SDK | URL of the sandbox helper registry JSON. Default: `https://raw.githubusercontent.com/earendil-works/gondolin/main/builtin-sandbox-helper-registry.json` |

## VM Backend

| Variable | Read by | Meaning |
| --- | --- | --- |
| `GONDOLIN_VMM` | SDK, static CLI | Backend when `sandbox.vmm` / `--vmm` is not set: `qemu`, `krun` or `firecracker`. Default: `krun` where it can run, else `qemu` (see [VM Backends](./backends.md#default-backend-selection)) |
| `GONDOLIN_FIRECRACKER` | SDK, static CLI | Path of the `firecracker` binary for `vmm=firecracker` when `sandbox.firecrackerPath` is not set. Default: `firecracker` on `PATH` (see [AWS Nitro Sandboxes](./nitro.md)) |
| `GONDOLIN_NITRO_MODE` | SDK, static CLI | Nitro Sandbox mode for `vmm=firecracker` when `sandbox.nitro.mode` is not set: `direct` or `confidential`. Setting it (or `GONDOLIN_NITRO_CPU_OVERCOMMIT`) runs a Nitro Sandbox even where KVM is available. Default: `direct` |
| `GONDOLIN_NITRO_CPU_OVERCOMMIT` | SDK, static CLI | `0`: give Nitro Sandboxes dedicated cores instead of time-shared vCPUs (`sandbox.nitro.cpuOvercommit`). Default: time-shared |
| `GONDOLIN_KRUN_RUNNER` | SDK, static CLI | Path of the krun runner binary; checked before the other runner locations and counts as an installed runner for the default backend selection |
| `GONDOLIN_CPU` | SDK, static CLI | QEMU CPU model when `sandbox.cpu` is not set, for example `cortex-a72`. Applies only when QEMU is the backend; it does not select QEMU |
| `GONDOLIN_VIRTIOFS` | SDK, static CLI | Guest filesystem transport: `1` (`true`, `on`) asks for virtio-fs and warns when it is unavailable, `0` (`false`, `off`) forces sandboxfs. Default: virtio-fs when the backend and image support it, else sandboxfs (see [Files and Mounts](./vfs.md)) |
| `PATH` | SDK, static CLI, daemon | Where `qemu-system-*` and `gondolin-krun-runner` are found when no explicit path is set |

## Daemon and Remote Machines

| Variable | Read by | Meaning |
| --- | --- | --- |
| `GONDOLIN_NATIVE_BIN` | SDK | Daemon binary to start (`gondolin` or `gondolind`) instead of the newest checkout build or the installed platform package (see [Installation](./install.md#the-gondolin-daemon-binary)) |
| `GONDOLIN_NATIVE_COMMAND` | SDK | Command that starts the daemon, as words or a JSON array, for example `ssh build-box gondolind`; same as `VMOptions.native.command` and `gondolin --native-command` |
| `GONDOLIN_NATIVE_REMOTE` | SDK | `1` or `true`: the daemon runs on another machine; same as `VMOptions.native.remote` and `gondolin --remote` |
| `GONDOLIN_NATIVE_IMAGE` | SDK | Image selector the remote daemon resolves; same as `VMOptions.native.image`. Default: the daemon's default image |
| `GONDOLIN_ENGINE` | SDK | Accepted for compatibility: `native` or `auto`, both the default; any other value is an error (see [Upgrading](./upgrading.md#the-daemon-is-required)) |
| `npm_config_registry` | SDK | npm registry `ensureNativeBinary()` downloads platform packages from. Default: `https://registry.npmjs.org` |

See [Remote Machines](./remote.md).

## Network and TLS

| Variable | Read by | Meaning |
| --- | --- | --- |
| `GONDOLIN_MITM_CERT_DIR` | SDK, static CLI | Directory of the MITM CA used for TLS interception (`ca.crt`, `ca.key`; created when missing). Default: `~/.cache/gondolin/ssl`; `sandbox.mitmCertDir` wins. A remote daemon uses `~/.cache/gondolin/ssl` on its machine |
| `NODE_EXTRA_CA_CERTS` | SDK, static CLI, daemon | Extra trusted CA certificates (PEM file). The SDK verifies upstream TLS against Node's default CA store, which includes them; the static CLI adds them to its roots; the daemon and the static CLI also trust them for image downloads |
| `SSL_CERT_FILE`, `SSL_CERT_DIR` | static CLI | Replace the system CA bundle the static CLI trusts for upstream TLS (`SSL_CERT_DIR` may list several directories separated by `:`) |
| `SSH_AUTH_SOCK` | Node CLI, static CLI | Default ssh-agent socket for `--ssh-agent` without a path |
| `HOME` | SDK, static CLI, daemon | Default OpenSSH `known_hosts` (`~/.ssh/known_hosts`, plus `/etc/ssh/ssh_known_hosts`) for SSH egress, and the cache location |

`HTTP_PROXY` and `HTTPS_PROXY` are not used: guest egress and image downloads
by the daemon connect directly.

Some CLI options read variables you name: `--host-secret NAME` takes the
secret's value from `$NAME` when no `=VALUE` is given, and `--ssh-credential
...,passphrase-env=ENV` the key passphrase from `$ENV` (see
[CLI Reference](./cli.md)).

## Debugging and Timeouts

| Variable | Read by | Meaning |
| --- | --- | --- |
| `GONDOLIN_DEBUG` | SDK, static CLI | Comma-separated debug flags: `net`, `exec`, `vfs` (alias `fs`), `protocol`, or `all` (also `*`, `1`, `true`); `sandbox.debug` wins (see [Debugging and Troubleshooting](./debug.md)) |
| `GONDOLIN_START_TIMEOUT_MS` | SDK, static CLI | How long to wait for the VM to boot, in `ms`, when `startTimeoutMs` is not set. Default: `120000` (SDK), `60000` (static CLI) |
| `GONDOLIN_VFS_READY_TIMEOUT_MS` | SDK | How long to wait for the guest filesystem mounts after boot, in `ms`. Default: `30000` |
| `GONDOLIN_VFS_READY_SLEEP_SECONDS` | SDK | Polling interval of that wait, in seconds. Default: `0.01` |
| `CI` | SDK | `true` turns off the image download progress display |

Raise the timeouts on slow hosts (for example nested virtualization or
software emulation).

## CLI Sessions and Checkpoints

| Variable | Read by | Meaning |
| --- | --- | --- |
| `GONDOLIN_SESSIONS_DIR` | SDK, static CLI | Session registry (`<uuid>.json` and `<uuid>.sock` per running VM) used by `gondolin list`, `attach`, `exec --sock` and `snapshot`; VMs created with the SDK register here too. Default: `~/.cache/gondolin/sessions` |
| `GONDOLIN_CHECKPOINT_DIR` | Node CLI, static CLI | Where `gondolin snapshot` writes checkpoints and `gondolin bash --resume ID` looks them up. Default: `~/.cache/gondolin/checkpoints` |
| `TERM` | SDK, static CLI | Passed to interactive shells (`vm.shell()`, `gondolin bash`) unless their environment sets it; `xterm-ghostty` and an unset value become `xterm-256color` |
| `TMPDIR` | daemon, static CLI, Node CLI | Where the daemon creates each VM's private session directory (VMM sockets and the root disk overlay; on macOS, or when `TMPDIR` is longer than 60 bytes, `/tmp` is used instead), and the Node CLI's scratch directory for the `trufflehog` host suggestions of `--host-secret NAME` |

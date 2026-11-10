# CLI Reference

The `gondolin` command line interface lets you:

- start an interactive shell inside a micro-VM (`bash`)
- run one or more commands non-interactively (`exec`)
- list running VM sessions (`list`)
- attach a new interactive command to an existing VM (`attach`)
- snapshot a running VM session (`snapshot`)
- manage local image refs and objects (`image`)
- build and verify custom guest assets (`build`)
- inspect managed helper tools (`tools`)

Run it without installing anything with `npx @earendil-works/gondolin bash`,
or install the package to get the `gondolin` command. For installation and
requirements, see [Installation](./install.md). Gondolin also ships a
[static CLI](#static-cli-no-nodejs) that needs no Node.js.

```bash
gondolin [global options] <command> [options]
```

## Global Options

These go before the command and apply to every VM the command starts
(including `bash --resume`, `--listen` and `--ssh`):

- `--native-command CMD`: start the Gondolin daemon (`gondolind`) with `CMD`,
  as words or a JSON array, e.g. `"ssh build-box gondolind"`
- `--remote`: the daemon runs on another machine; images, disks and the MITM
  CA are handled on its side

Both are for running VMs on [remote machines](./remote.md) and also accept
the `--flag=VALUE` form. They are not supported by the static CLI.

`--engine native|auto` is still accepted for compatibility and has no effect
(`--engine node` is an error; see [Upgrading](./upgrading.md)).

## Images and Sessions

Guest assets (kernel, initramfs, rootfs, ~200MB) are resolved automatically
on first use from local overrides and the local image store first, then via
the builtin image registry, and cached in `~/.cache/gondolin/images/`. When
you do not pass `--image`, Gondolin uses `GONDOLIN_DEFAULT_IMAGE` (default:
`alpine-base:latest`). See [Images](./images.md), and
[Building Custom Images](./custom-images.md) to build and ship your own.

Running VMs are registered under `~/.cache/gondolin/sessions/` as
`<uuid>.json` + `<uuid>.sock` pairs so other CLI processes can discover and
attach to them. (All `~/.cache/gondolin` paths move to
`$XDG_CACHE_HOME/gondolin` when `XDG_CACHE_HOME` is set.)

For the environment variables the CLI reads, see
[Environment Variables](./environment.md).

## Common Options (VFS + Network)

Both `gondolin bash` and `gondolin exec` (VM mode) support the same set of
options for selecting the VM, configuring filesystem mounts and mediated
network egress policy.

### VFS (Filesystem) Options

- `--mount-hostfs HOST_DIR:GUEST_PATH[:ro]`
    - Mount a host directory into the guest at `GUEST_PATH`
    - Add `:ro` to force read-only access
    - Note: the host path must exist and must be a directory

- `--mount-memfs GUEST_PATH`
    - Create an in-memory mount at `GUEST_PATH` (ephemeral)

See [Files and Mounts](./vfs.md).

### VM Options

- `--image IMAGE`
    - Select guest assets by path, build id, or local image ref (`name:tag`)

- `--vmm BACKEND` (also `--vmm=BACKEND`)
    - Select the backend: `qemu`, `krun` or `firecracker` (AWS Nitro
      Sandboxes, see [AWS Nitro Sandboxes](./nitro.md))
    - Default: `GONDOLIN_VMM`, else `krun` where it can run (supported host,
      installed runner, image with krun boot assets), else `qemu`; see
      [VM Backends](./backends.md#default-backend-selection)

- `--rootfs-size SIZE` (also `--rootfs-size=SIZE`)
    - Ensure the rootfs virtual disk is at least `SIZE` before boot (for
      example `2G`)
    - Requires `resize2fs` in the guest image (`e2fsprogs-extra` on Alpine)

- `--print-configure`
    - Print the session configuration the CLI would send to the daemon (JSON)
      and exit without starting a VM; see
      [Debugging](./debug.md#daemon-diagnostics)

Examples:

```bash
# Mount a project directory into /workspace
gondolin bash --mount-hostfs "$PWD:/workspace"

# Mount a read-only dataset and a scratch tmpfs
gondolin exec --mount-hostfs /data:/data:ro --mount-memfs /tmp -- ls -la /data
```

### Network Options (HTTP Allowlist + Secret Injection)

Gondolin's network bridge mediates HTTP/HTTPS traffic and can optionally proxy
allowlisted outbound SSH or explicit mapped TCP flows. Requests are intercepted
on the host side, which allows enforcing host allowlists and injecting secrets
without exposing them inside the VM (for HTTP/TLS-mediated flows). See
[Network Access](./network-access.md) and [Secrets](./secrets.md).

- `--allow-host HOST_PATTERN`
    - Allow outbound HTTP/HTTPS requests to this host
    - May be repeated
    - `HOST_PATTERN` supports `*` wildcards (for example `*.github.com`)
    - Without any `--allow-host`, HTTP/HTTPS egress to every public host is
      allowed (internal ranges stay blocked); the first `--allow-host` turns
      this into an allowlist

- `--host-secret NAME[=VALUE]`
    - Make a secret available inside the VM as an environment variable named
      `NAME`
    - Gondolin resolves a managed `trufflehog` helper on first use, then scans
      for suggested hostnames and asks you to confirm them
    - If no suggestions are found, the command fails and asks you to re-run
      with explicit hosts
    - If `=VALUE` is omitted, the value is read from the host environment
      variable `$NAME`
    - Node CLI only

- `--host-secret NAME@HOST[,HOST...][=VALUE]`
    - Make a secret available inside the VM as an environment variable named
      `NAME`
    - The VM only sees a random placeholder value; the host replaces that
      placeholder with the real secret **when it appears in an outgoing HTTP
      header** (including `Authorization: Basic …`, where the base64 token is
      decoded and placeholders inside `username:password` are substituted)
    - The secret is only permitted for the listed host(s)
    - If `=VALUE` is omitted, the value is read from the host environment
      variable `$NAME`
    - This does **not** restrict egress: the listed hosts only say where the
      secret may be substituted. Without `--allow-host` the guest can still
      reach any public host (with the placeholder, not the secret); with
      `--allow-host`, list the secret's hosts there too

- `--hooks-script FILE`
    - Run a tier-2 hook policy (JavaScript defining `onRequest`,
      `onResponse`, `isRequestAllowed` and/or `isIpAllowed`) for every HTTP
      request; a `.mjs` file is an ES module exporting them, a `.ts`/`.mts`
      file a TypeScript module
    - Any other extension (for example `.js`) is a script defining them as
      global functions
    - Files a module imports with relative specifiers (`./lib/x.ts`,
      `./data.json`) are read from next to it and sent along
    - It runs inside the daemon (also in the static CLI); see
      [HTTP Hooks and Policies](./hooks.md)
    - Combines with `--allow-host`/`--host-secret` (declarative policy runs
      first, secrets are substituted after the hook)

- `--disable-websockets`
    - Disable WebSocket upgrades through the bridge
    - Affects both:
        - egress (guest -> upstream)
        - ingress (host -> guest) when using `gondolin bash --listen`

### DNS Options

- `--dns MODE`
    - DNS resolution mode: `synthetic` (default), `trusted`, or `open`
    - `synthetic`: the host intercepts DNS lookups and maps hostnames to
      synthetic IP addresses (required for SSH egress and mapped TCP)
    - `trusted`: forward DNS queries to one or more trusted resolvers
    - `open`: unrestricted DNS

- `--dns-trusted-server IP`
    - Trusted resolver IPv4 address (repeatable; requires `--dns trusted`)

- `--dns-synthetic-host-mapping MODE`
    - Hostname-to-IP mapping strategy when using synthetic DNS: `single` or
      `per-host` (requires `--dns synthetic` if a mode is given)

- `--tcp-map GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT`
    - Add an explicit mapped TCP rule (repeatable)
    - `GUEST_HOST` (or `GUEST_HOST:PORT`) is matched using synthetic DNS host
      attribution
    - Traffic is forwarded as raw TCP to the explicit `UPSTREAM_HOST:PORT`
    - If both `GUEST_HOST` and `GUEST_HOST:PORT` are configured, the
      port-specific mapping wins

Examples:

```bash
# Allow GitHub API calls
gondolin exec --allow-host api.github.com -- curl -sS https://api.github.com/rate_limit

# Secret injection (reads the real value from $GITHUB_TOKEN on the host)
# Inside the VM, $GITHUB_TOKEN is a placeholder that only works for api.github.com.
# exec runs argv without a shell, so expand the variable with `sh -c` in the
# guest (single quotes keep the host shell from expanding it)
gondolin exec \
  --allow-host api.github.com \
  --host-secret GITHUB_TOKEN@api.github.com \
  -- sh -c 'curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user'

# Basic auth secret injection (username/password placeholders are base64 encoded)
gondolin exec \
  --allow-host example.com \
  --host-secret BASIC_USER@example.com \
  --host-secret BASIC_PASS@example.com \
  -- sh -c 'curl -sS -u "$BASIC_USER:$BASIC_PASS" https://example.com/private'

# Allow multiple hosts / wildcards
gondolin bash --allow-host "*.github.com" --allow-host api.openai.com

# Map guest postgres hostname to a local dev database
gondolin bash --tcp-map pg.internal=127.0.0.1:5432
```

### Network Options (Mapped TCP Egress)

Mapped TCP egress is an explicit exception path for non-HTTP protocols.

- Rules are added with `--tcp-map GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT`
- `--tcp-map` requires synthetic DNS with per-host mapping
    - the CLI auto-selects `--dns synthetic` and
      `--dns-synthetic-host-mapping per-host` when needed
- Mapped TCP is raw forwarding to the explicit upstream target
    - HTTP hooks and HTTP secret substitution do not apply on mapped flows

Use this for narrow, explicit development targets (for example local
Postgres), not as a general network mode.

### Network Options (SSH Egress Proxy)

Gondolin can optionally allow outbound SSH from the guest to specific
allowlisted hosts. SSH egress is **proxied by the host**: the guest connects to
a host-side SSH server, and the host opens the real upstream SSH connection
(using either an ssh-agent or a configured private key). See
[SSH](./ssh.md#ssh-egress) for how it works and its limitations.

- `--ssh-allow-host HOST_PATTERN[:PORT]`
    - Allow outbound SSH to the given host+port (repeatable, default port:
      `22`)
    - Selects synthetic DNS with per-host mapping (other DNS modes are
      rejected)
- `--ssh-agent [SOCK]`
    - Use a host ssh-agent socket (defaults to `$SSH_AUTH_SOCK`)
    - Requires at least one `--ssh-allow-host` or `--ssh-credential`
- `--ssh-known-hosts PATH`
    - OpenSSH `known_hosts` file for upstream verification (repeatable;
      default: `~/.ssh/known_hosts` and `/etc/ssh/ssh_known_hosts`)
- `--ssh-credential SPEC`
    - Host-side SSH private key for upstream authentication; its host is
      allowlisted automatically
    - Format:
        - `HOST[:PORT]=KEY_PATH[,passphrase-env=ENV][,passphrase=...]`
        - `USER@HOST[:PORT]=KEY_PATH[,passphrase-env=ENV][,passphrase=...]`
    - Interactive passphrase prompting is not supported; prefer
      `passphrase-env`

In shells, `~/.ssh/known_hosts` is only expanded when unquoted (otherwise use
`$HOME/.ssh/known_hosts`).

Example (git over ssh using your host ssh-agent):

```bash
gondolin bash \
  --ssh-allow-host github.com \
  --ssh-agent \
  --ssh-known-hosts ~/.ssh/known_hosts
```

Example (git over ssh using a dedicated key + passphrase from env):

```bash
export GIT_KEY_PASSPHRASE='...'

gondolin bash \
  --ssh-credential git@github.com=~/.ssh/id_ed25519,passphrase-env=GIT_KEY_PASSPHRASE \
  --ssh-known-hosts ~/.ssh/known_hosts
```

For the host key prompts and post-quantum warnings the guest's OpenSSH client
may print, see
[SSH: Guest SSH Client Options](./ssh.md#guest-ssh-client-options-git).

## Commands

### `gondolin bash`

Start an interactive `bash` session in the VM (falls back to `sh` when the
image has no bash):

```bash
gondolin bash [options] [-- COMMAND [ARGS...]]
```

If `-- COMMAND` is provided, the given command is run instead of the default
shell. `Ctrl-]` detaches and force-closes the session locally (exit code
`130`). Besides the [common options](#common-options-vfs-network):

#### Bash-specific Options

- `--cwd PATH` -- set the working directory for the shell / command
- `--env KEY=VALUE` -- set an environment variable (repeatable)
- `--resume ID_OR_PATH` -- resume from a snapshot id (from the checkpoint
  cache) or a `.qcow2` path; see [Persistence and Snapshots](./snapshots.md)
- `--listen [HOST:PORT]` -- start a host ingress gateway (default:
  `127.0.0.1:0`; accepts `HOST:PORT`, `:PORT`, `PORT` and `[IPv6]:PORT`); see
  [Ingress](./ingress.md)

#### Debugging Options (bash only)

- `--ssh` -- enable SSH access to the VM via a localhost port forward; see
  [SSH](./ssh.md#ssh-access-to-the-vm)
- `--ssh-user USER` -- SSH username (default: `root`)
- `--ssh-port PORT` -- local listen port (default: `0` = ephemeral)
- `--ssh-listen HOST` -- local listen host (default: `127.0.0.1`)

Typical workflows:

```bash
# Get a shell with a mounted working directory
gondolin bash --mount-hostfs "$PWD:/workspace"

# Get a shell with HTTP egress restricted to api.github.com and a usable
# API token (the token only works for that host)
gondolin bash \
  --mount-hostfs "$PWD:/workspace" \
  --allow-host api.github.com \
  --host-secret GITHUB_TOKEN@api.github.com

# Run a specific command instead of bash
gondolin bash --cwd /workspace -- claude

# Start an ingress gateway to forward traffic into the VM
gondolin bash --listen 127.0.0.1:3000

# Resume from a snapshot id created by `gondolin snapshot`
gondolin bash --resume 4a8f2b0c

# Force the QEMU backend (krun is the default where it can run)
gondolin bash --vmm qemu
```

### `gondolin exec`

Run one or more commands and exit.

#### VM Mode (Default)

Without `--sock`, `gondolin exec` creates a VM, runs the command(s), prints
stdout/stderr, and exits with the command's exit code. It takes the
[common options](#common-options-vfs-network):

```bash
gondolin exec [options] -- COMMAND [ARGS...]
```

`--env KEY=VALUE`, `--cwd PATH` and `--id N` before `--` apply to that
command.

Examples:

```bash
# Run a command
gondolin exec -- uname -a

# Run npm in an isolated VM but with your project mounted
gondolin exec --mount-hostfs "$PWD:/workspace" -- sh -lc 'cd /workspace && npm test'
```

#### Multi-Command Form

You can provide multiple commands using `--cmd` (each command can have its own
args/env/cwd):

```bash
gondolin exec [common options] \
  --cmd sh --arg -lc --arg 'echo hello' \
  --cmd sh --arg -lc --arg 'echo world'
```

Per-command flags apply to the most recent `--cmd`:

- `--arg ARG` -- add an argument
- `--env KEY=VALUE` -- add an environment variable
- `--cwd PATH` -- set working directory
- `--id N` -- set a request id (mainly useful with `--sock`)

#### Socket Mode (Advanced)

To run non-interactive commands in an already running Gondolin session (for
example one started with `gondolin bash`), pass its session id (or a unique
prefix, as shown by `gondolin list`) or the path to its session IPC socket:

```bash
gondolin exec --sock SESSION_ID -- COMMAND [ARGS...]
gondolin exec --sock /path/to/session.sock -- COMMAND [ARGS...]
```

No VM is created; command output is written to stdout/stderr and the process
exits with the command's exit code. Use `gondolin attach` for interactive
shells.

### `gondolin list`

List registered VM sessions:

```bash
gondolin list [--all]
```

By default, only live sessions are shown. `--all` includes non-live entries
that still remain after cleanup. `gondolin list` runs a best-effort garbage
collection pass first, removing entries whose owning PID is gone or whose
socket is no longer connectable.

Output columns:

- `ID` - session UUID
- `PID` - host process id that owns the VM
- `AGE` - time since registration
- `ALIVE` - whether the session is reachable
- `LABEL` - session label (typically the launching command line)

### `gondolin attach`

Attach to an already running VM session and spawn an interactive command:

```bash
gondolin attach <SESSION_ID> [options] [-- COMMAND [ARGS...]]
```

- Default command is `bash -i` (falls back to `/bin/sh -i` if bash is
  unavailable)
- `SESSION_ID` may be a full UUID or an unambiguous UUID prefix
- `Ctrl-]` detaches locally (the VM keeps running)
- `--cwd PATH` sets working directory
- `--env KEY=VALUE` sets environment variables (repeatable)

Examples:

```bash
# Find sessions
gondolin list

# Attach another bash to a running VM by UUID prefix
gondolin attach 9e3a2e2d

# Attach and run a custom command
gondolin attach 9e3a2e2d -- /bin/sh -lc 'id && pwd'
```

Each attached client gets an independent command channel; concurrent attaches
do not share request IDs or cross-talk between exec streams.

### `gondolin snapshot`

Create a disk snapshot from a running VM session and stop that session:

```bash
gondolin snapshot <SESSION_ID> [--output PATH] [--name NAME]
```

- `SESSION_ID` may be a full UUID or an unambiguous UUID prefix
- default output path is `~/.cache/gondolin/checkpoints/<uuid>.qcow2`
- `--name` customizes the default filename stem
- `--output` sets an explicit output path (`.qcow2` recommended); it cannot be
  combined with `--name`

On success, Gondolin prints the snapshot id/path and a matching resume
command. See [Persistence and Snapshots](./snapshots.md).

Examples:

```bash
# Snapshot a running session into the default checkpoint cache
# (session is stopped as part of snapshot creation)
gondolin snapshot 9e3a2e2d

# Snapshot to an explicit path
gondolin snapshot 9e3a2e2d --output ./my-snapshot.qcow2
```

### `gondolin image`

Manage the local image object store and refs:

```bash
gondolin image ls
gondolin image import ./my-assets --tag default:latest
gondolin image inspect default:latest
gondolin image pull alpine-base:latest
gondolin image tag default:latest tooling:dev
gondolin image rm tooling:dev
gondolin image rm 3cd7a864-f023-5a35-9db1-39a1be5bdcca --force
gondolin image rm --untagged
gondolin image rm --all
```

| Command | Meaning |
| --- | --- |
| `ls` | list local refs and their per-architecture build ids |
| `import ASSET_DIR [--tag REF]` | import built guest assets into the object store |
| `tag SOURCE TARGET [--arch ARCH]` | create or update a ref to point at an image |
| `rm BUILD_ID\|REF [--force] [--yes]` | remove a tag or an image object |
| `rm --untagged [--yes]`, `rm --all [--yes]` | remove every untagged object, or all refs and objects |
| `inspect SELECTOR [--arch ARCH]` | show details for a path, build id or ref (pulls from the registry if needed) |
| `pull SELECTOR [--arch ARCH]` | make a selector available locally via the builtin registry |

`ARCH` is `aarch64` or `x86_64` (default: the host's).

`image ls` includes objects without tags as `<untagged>`. Removing a tag
deletes the image object when no other local tags reference it. Removing a
build id requires `--force` when local tags still reference it; `--force`
removes those tags as well. Every removal prompts for confirmation unless
`--yes` or `-y` is passed.

Image selectors accepted by `--image` and `sandbox.imagePath` strings:

- asset directory path
- image build id (`uuid`)
- image ref (`name:tag`)

See [Images](./images.md).

### `gondolin build` (Node CLI only)

Build and verify custom guest assets (kernel + initramfs + rootfs):

```bash
gondolin build [options]
```

Options:

- `--init-config` -- print a default build configuration JSON to stdout
- `--config FILE` -- use a build configuration file
- `--output DIR` -- output directory for built assets (optional)
- `--arch aarch64|x86_64` -- target architecture
- `--verify DIR` -- verify an asset directory against its `manifest.json`
- `--tag REF` -- tag the built assets in the local image store
- `--quiet` / `-q` -- reduce output verbosity

Without options, `gondolin build` builds the default configuration and imports
it into the local image store.

Examples:

```bash
# Generate a default config
gondolin build --init-config > build-config.json

# Build and import to the local image store (no explicit output dir)
gondolin build --config build-config.json --tag default:latest

# Use the tagged image
gondolin bash --image default:latest

# Optionally keep an explicit output directory too
gondolin build --config build-config.json --output ./my-assets --tag default:latest

# Use the custom assets directly
GONDOLIN_GUEST_DIR=./my-assets gondolin bash

# Verify an asset directory
gondolin build --verify ./my-assets
```

For a full configuration reference and build requirements, see
[Building Custom Images](./custom-images.md).

Manage the Alpine package cache used by image builds:

```bash
gondolin build cache info
gondolin build cache update
gondolin build cache update --config Gondolinfile --arch aarch64
gondolin build cache rm
gondolin build cache rm --yes
```

`info` reports the cache size and the cached Alpine minirootfs and kernel
package versions. `update` refreshes the `main` and `community` package
indexes for the selected build configuration (builds also refresh them
automatically when a cached index is older than 24 hours, so package security
updates are picked up, or references packages that are no longer on the
mirror; if the mirror is unreachable, builds fall back to the cached index).
`rm` prompts before deleting Alpine minirootfs, package-index, and APK files
while preserving unrelated build cache data.

### `gondolin tools` (Node CLI only)

You can inspect the managed `trufflehog` helper (used by `--host-secret NAME`
without hosts) with:

```bash
gondolin tools trufflehog
gondolin tools trufflehog --install
gondolin tools trufflehog --json
```

`--install` downloads it if missing.

### `gondolin daemon` (static CLI only)

Run the binary as the Gondolin daemon (`gondolind`), speaking its protocol on
stdin/stdout; `gondolin daemon ARGS` is the same as `gondolind
ARGS` (for example `gondolin daemon --version` or `gondolin daemon assets
list`). You normally do not run it yourself: the SDK starts it, or you name
it in `--native-command` for a [remote machine](./remote.md). See
[Daemon Diagnostics](./debug.md#daemon-diagnostics) for its subcommands.

### Help and Version

- `gondolin help` (also `--help`, `-h`)
- `gondolin <command> --help`
- `gondolin version` (also `--version`, `-V`): the package version and the
  `gondolind` command the Node CLI would use; the static CLI prints
  `gondolin X.Y.Z (static)`

## Static CLI (no Node.js)

`gondolin` is also available as a single static executable that needs no
Node.js: the commands `bash`, `exec`, `list`, `attach`, `snapshot` and `image`
with the same options and output as the Node CLI. It runs the VM in-process
(on top of the daemon's session library: no daemon process, no pipe), so QEMU (or the krun runner) is the only runtime dependency. See
[Installation](./install.md#static-cli) for how to get it.

The binary is multi-call: invoked as `gondolind` (for example through a
symlink), or as `gondolin daemon`, it is the Gondolin daemon speaking its
protocol on stdio; the SDK starts it that way. One file covers the
CLI, the SDK's daemon and [remote machines](./remote.md).

What is shared with the Node CLI:

- the session registry (`~/.cache/gondolin/sessions/<uuid>.json` + `.sock`)
  and its IPC protocol: either CLI can `list`, `attach`, `exec --sock` and
  `snapshot` sessions started by the other;
- checkpoints (`.qcow2` with the same metadata trailer): `bash --resume` works
  across both CLIs;
- the image store, the builtin image registry and the MITM CA cache;
- the session configuration: both CLIs print the configuration they would
  send with `--print-configure` (`bash` and `exec` VM mode), and a parity test
  compares them for a matrix of options.

Differences:

- `build`, `build cache` and `tools` need the Node CLI
  (`npx @earendil-works/gondolin build`); `image build` says so;
- `--host-secret NAME` without `@HOST` (host suggestions via trufflehog) is not
  supported: list the hosts (`--host-secret NAME@HOST[,HOST...]`);
- `--native-command` and `--remote` are not supported (the VM runs
  in-process); `--engine native|auto` is accepted;
- upstream TLS for mediated HTTPS trusts the system and webpki root stores
  (`SSL_CERT_FILE`/`SSL_CERT_DIR` replace the system bundle,
  `NODE_EXTRA_CA_CERTS` is added; the Node CLI uses Node's CA store), and DNS
  resolvers are read from `/etc/resolv.conf` by the network stack;
- `gondolin exec` (VM mode) streams output as it arrives instead of printing
  it when each command finished;
- the default startup timeout is 60 s instead of 120 s
  (`GONDOLIN_START_TIMEOUT_MS` raises it);
- the krun runner is looked up without the npm runner packages
  (`GONDOLIN_KRUN_RUNNER`, `host/krun-runner/zig-out/bin` and
  `krun-runner/zig-out/bin` in the current directory, next to the binary, then
  `PATH`), so without one of those the default backend is `qemu`;
- `daemon` runs the Gondolin daemon (the Node CLI has no such command).

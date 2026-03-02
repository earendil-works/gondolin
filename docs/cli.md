# Gondolin CLI

Gondolin ships with a small command line interface (CLI) that lets you:

- start an interactive shell inside a micro-VM (`bash`)
- list running VM sessions (`list`)
- attach a new interactive command to an existing VM (`attach`)
- snapshot a running VM session (`snapshot`)
- run one or more commands non-interactively (`exec`)
- build and verify custom guest assets (`build`)
- manage local image refs/objects (`image`)

## Installation / Running

If you don't want to install anything globally, use `npx`:

```bash
npx @earendil-works/gondolin bash
```

If you install the package, the `gondolin` binary becomes available:

```bash
npm install -g @earendil-works/gondolin
gondolin bash
```

### Requirements

- QEMU installed (`brew install qemu` on macOS, `apt install qemu-system-*` on Linux)
- Node.js >= 23.6.0

Guest assets (kernel/initramfs/rootfs, ~200MB) are resolved automatically on
first use from local overrides/store first, then via `builtin-image-registry.json`,
and cached in `~/.cache/gondolin/images/`.

When you do not pass `--image`, Gondolin uses `GONDOLIN_DEFAULT_IMAGE` (default:
`alpine-base:latest`). Alternatively you can [build and ship your own](./custom-images.md).

Running VMs are also registered in the cache under
`~/.cache/gondolin/sessions/` as `<uuid>.json` + `<uuid>.sock` pairs so other
CLI processes can discover and attach to them.

## Common Options (VFS + Network)

Both `gondolin bash` and `gondolin exec` (VM mode) support the same set of
options for configuring filesystem mounts and mediated network egress policy.

### VFS (Filesystem) Options

- `--mount-hostfs HOST_DIR:GUEST_PATH[:ro]`
  - Mount a host directory into the guest at `GUEST_PATH`
  - Add `:ro` to force read-only access
  - Note: the host path must exist and must be a directory

- `--mount-memfs GUEST_PATH`
  - Create an in-memory mount at `GUEST_PATH` (ephemeral)

- `--image IMAGE`
  - Select guest assets by path, build id, or local image ref (`name:tag`)

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
without exposing them inside the VM (for HTTP/TLS-mediated flows).

- `--allow-host HOST_PATTERN`
  - Allow outbound HTTP/HTTPS requests to this host
  - May be repeated
  - `HOST_PATTERN` supports `*` wildcards (for example `*.github.com`)

- `--host-secret NAME@HOST[,HOST...][=VALUE]`
  - Make a secret available inside the VM as an environment variable named `NAME`
  - The VM only sees a random placeholder value; the host replaces that
    placeholder with the real secret **when it appears in an outgoing HTTP
    header** (including `Authorization: Basic …`, where the base64 token is
    decoded and placeholders inside `username:password` are substituted)
  - The secret is only permitted for the listed host(s)
  - If `=VALUE` is omitted, the value is read from the host environment variable `$NAME`

- `--disable-websockets`
  - Disable WebSocket upgrades through the bridge
  - Affects both:
    - egress (guest -> upstream)
    - ingress (host -> guest) when using `gondolin bash --listen`

### DNS Options

- `--dns MODE`
  - DNS resolution mode: `synthetic` (default), `trusted`, or `open`
  - `synthetic`: the host intercepts DNS lookups and maps hostnames to
    synthetic IP addresses (required for SSH egress proxy)
  - `trusted`: forward DNS queries to one or more trusted resolvers
  - `open`: unrestricted DNS

- `--dns-trusted-server IP`
  - Trusted resolver IPv4 address (repeatable; requires `--dns trusted`)

- `--dns-synthetic-host-mapping MODE`
  - Hostname-to-IP mapping strategy when using synthetic DNS: `single` or `per-host`

- `--tcp-map GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT`
  - Add an explicit mapped TCP rule (repeatable)
  - `GUEST_HOST` (or `GUEST_HOST:PORT`) is matched using synthetic DNS host attribution
  - Traffic is forwarded as raw TCP to the explicit `UPSTREAM_HOST:PORT`
  - If both `GUEST_HOST` and `GUEST_HOST:PORT` are configured, the port-specific mapping wins

Examples:

```bash
# Allow GitHub API calls
gondolin exec --allow-host api.github.com -- curl -sS https://api.github.com/rate_limit

# Secret injection (reads the real value from $GITHUB_TOKEN on the host)
# Inside the VM, $GITHUB_TOKEN is a placeholder that only works for api.github.com
gondolin exec \
  --host-secret GITHUB_TOKEN@api.github.com \
  -- curl -sS -H 'Authorization: Bearer $GITHUB_TOKEN' https://api.github.com/user

# Basic auth secret injection (username/password placeholders are base64 encoded)
gondolin exec \
  --host-secret BASIC_USER@example.com \
  --host-secret BASIC_PASS@example.com \
  -- curl -sS -u "$BASIC_USER:$BASIC_PASS" https://example.com/private

# Allow multiple hosts / wildcards
gondolin bash --allow-host "*.github.com" --allow-host api.openai.com

# Map guest postgres hostname to a local dev database
gondolin bash --tcp-map pg.internal=127.0.0.1:5432
```

### Network Options (Mapped TCP Egress)

Mapped TCP egress is an explicit exception path for non-HTTP protocols.

- Rules are added with `--tcp-map GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT`
- `--tcp-map` requires synthetic DNS with per-host mapping
  - the CLI auto-selects `--dns synthetic` and `--dns-synthetic-host-mapping per-host` when needed
- Mapped TCP is raw forwarding to the explicit upstream target
  - HTTP hooks and HTTP secret substitution do not apply on mapped flows

Use this for narrow, explicit development targets (for example local Postgres),
not as a general network mode.

### Network Options (SSH Egress Proxy)

Gondolin can optionally allow outbound SSH from the guest to specific
allowlisted hosts. SSH egress is **proxied by the host**: the guest connects to
an in-process SSH server, and the host opens the real upstream SSH connection
(using either an ssh-agent or a configured private key).

Restrictions and properties:

- Non-standard ports are supported by suffixing `:PORT` in `--ssh-allow-host` (default: `22`)
- Only non-interactive `exec` channels are supported
  - interactive shells are denied
  - SSH subsystems (such as `sftp`) are denied
- Upstream host keys are verified on the host (via OpenSSH `known_hosts`)
- Interactive passphrase prompting is not supported; prefer `passphrase-env`
- Note: in shells, `~/.ssh/known_hosts` is only expanded when unquoted (otherwise use `$HOME/.ssh/known_hosts`)

CLI flags:

- `--ssh-allow-host HOST_PATTERN[:PORT]`
  - Allow outbound SSH to the given host+port (repeatable, default port: 22)
- `--ssh-agent [SOCK]`
  - Use a host ssh-agent socket (defaults to `$SSH_AUTH_SOCK`)
- `--ssh-known-hosts PATH`
  - OpenSSH `known_hosts` file for upstream verification (repeatable)
- `--ssh-credential SPEC`
  - Host-side SSH private key for upstream authentication
  - Format:
    - `HOST[:PORT]=KEY_PATH[,passphrase-env=ENV][,passphrase=...]`
    - `USER@HOST[:PORT]=KEY_PATH[,passphrase-env=ENV][,passphrase=...]`

Example (git over ssh using your host ssh-agent):

```bash
gondolin bash \
  --ssh-allow-host github.com \
  --ssh-agent \
  --ssh-known-hosts ~/.ssh/known_hosts
```

Example (git over ssh on a non-standard port):

```bash
gondolin bash \
  --ssh-allow-host ssh.github.com:443 \
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

Inside the guest, OpenSSH is talking to the **host-side SSH proxy**, so you may see:

- a host key prompt / `Permanently added ...` message (the proxy host key is ephemeral)
- the OpenSSH post-quantum key exchange warning

For non-interactive tools like `git`, you can suppress prompts and these warnings:

```sh
export GIT_SSH_COMMAND='ssh \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o GlobalKnownHostsFile=/dev/null \
  -o LogLevel=ERROR'
```

## Commands

### `gondolin bash`

Start an interactive `bash` session in the VM:

```bash
gondolin bash [options] [-- COMMAND [ARGS...]]
```

If `-- COMMAND` is provided, the given command is run instead of the default
`bash` shell.

#### Bash-specific Options

- `--cwd PATH` -- set the working directory for the shell / command
- `--env KEY=VALUE` -- set an environment variable (repeatable)
- `--resume ID_OR_PATH` -- resume from a snapshot id (from cache) or `.qcow2` path
- `--listen [HOST:PORT]` -- start a host ingress gateway (default: `127.0.0.1:0`)

#### Debugging Options (bash only)

- `--ssh` -- enable SSH access to the VM via a localhost port forward
- `--ssh-user USER` -- SSH username (default: `root`)
- `--ssh-port PORT` -- local listen port (default: `0` = ephemeral)
- `--ssh-listen HOST` -- local listen host (default: `127.0.0.1`)

Typical workflows:

```bash
# Get a shell with a mounted working directory
gondolin bash --mount-hostfs "$PWD:/workspace"

# Get a shell with restricted HTTP egress and a usable API token
gondolin bash \
  --mount-hostfs "$PWD:/workspace" \
  --host-secret GITHUB_TOKEN@api.github.com

# Run a specific command instead of bash
gondolin bash -- claude --cwd /workspace

# Start an ingress gateway to forward traffic into the VM
gondolin bash --listen 127.0.0.1:3000

# Resume from a snapshot id created by `gondolin snapshot`
gondolin bash --resume 4a8f2b0c
```

### `gondolin list`

List registered VM sessions:

```bash
gondolin list [--all]
```

By default, only live sessions are shown. `--all` includes non-live entries
that still remain after cleanup.
`gondolin list` runs a best-effort garbage collection pass first, removing
entries whose owning PID is gone or whose socket is no longer connectable.

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

- Default command is `bash -i` (falls back to `/bin/sh -i` if bash is unavailable)
- `SESSION_ID` may be a full UUID or an unambiguous UUID prefix
- `Ctrl-]` detaches locally (same behavior as `gondolin bash`)
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

Each attached client gets an independent command channel; concurrent attaches do
not share request IDs or cross-talk between exec streams.

### `gondolin snapshot`

Create a disk snapshot from a running VM session and stop that session:

```bash
gondolin snapshot <SESSION_ID> [--output PATH] [--name NAME]
```

- `SESSION_ID` may be a full UUID or an unambiguous UUID prefix
- default output path is `~/.cache/gondolin/checkpoints/<uuid>.qcow2`
- `--name` customizes the default filename stem
- `--output` sets an explicit output path (`.qcow2` recommended)

On success, Gondolin prints the snapshot id/path and a matching resume command.

Examples:

```bash
# Snapshot a running session into the default checkpoint cache
# (session is stopped as part of snapshot creation)
gondolin snapshot 9e3a2e2d

# Snapshot to an explicit path
gondolin snapshot 9e3a2e2d --output ./my-snapshot.qcow2
```

### `gondolin exec`

Run one or more commands and exit.

### VM Mode (Default)

Without `--sock`, `gondolin exec` creates a VM, runs the command(s), prints
stdout/stderr, and exits with the command's exit code:

```bash
gondolin exec [options] -- COMMAND [ARGS...]
```

Examples:

```bash
# Run a command
gondolin exec -- uname -a

# Run npm in an isolated VM but with your project mounted
gondolin exec --mount-hostfs "$PWD:/workspace" -- sh -lc 'cd /workspace && npm test'
```

### Multi-Command Form

You can provide multiple commands using `--cmd` (each command can have its own args/env/cwd):

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

### Socket Mode (Advanced)

If you already have a running sandbox server and a virtio control socket path,
you can send exec requests without creating a VM:

```bash
gondolin exec --sock /path/to/virtio.sock -- COMMAND [ARGS...]
```

This is primarily useful when you manage the VM lifecycle yourself (for example
via the programmatic `SandboxServer`/`VM` APIs) and want a separate process to
issue exec requests.

### `gondolin build`

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

For a full configuration reference and build requirements, see:
[Building Custom Images](./custom-images.md).

### `gondolin image`

Manage the local image object store and refs:

```bash
gondolin image ls
gondolin image import ./my-assets --tag default:latest
gondolin image inspect default:latest
gondolin image pull alpine-base:latest
gondolin image tag default:latest tooling:dev
```

Image selectors accepted by `--image` and `sandbox.imagePath` strings:

- asset directory path
- image build id (`uuid`)
- image ref (`name:tag`)

## Environment Variables

- `GONDOLIN_GUEST_DIR`
  - Directory containing guest assets (`manifest.json`, kernel, initramfs, rootfs)
  - If set, Gondolin uses this directory instead of downloading cached assets

- `GONDOLIN_IMAGE_STORE`
  - Override local image store location (default: `~/.cache/gondolin/images`)

- `GONDOLIN_DEFAULT_IMAGE`
  - Default image selector used by `VM.create()` / `gondolin bash` when no explicit image is set
  - Default: `alpine-base:latest`

- `GONDOLIN_IMAGE_REGISTRY_URL`
  - Override builtin image registry JSON URL
  - Default: `https://raw.githubusercontent.com/earendil-works/gondolin/main/builtin-image-registry.json`

- `GONDOLIN_CHECKPOINT_DIR`
  - Override checkpoint directory used by `gondolin snapshot` / `gondolin bash --resume`
  - Default: `~/.cache/gondolin/checkpoints`

- `GONDOLIN_SESSIONS_DIR`
  - Override session registry directory used by `gondolin list` / `gondolin attach`
  - Default: `~/.cache/gondolin/sessions`

- `GONDOLIN_DEBUG`
  - Enable debug logging (see [Debug Logging](./debug.md))


## Help

- `gondolin help`
- `gondolin <command> --help`

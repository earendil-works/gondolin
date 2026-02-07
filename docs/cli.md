# Gondolin CLI

Gondolin ships with a small command line interface (CLI) that lets you:

- start an interactive shell inside a micro-VM (`bash`)
- run one or more commands non-interactively (`exec`)
- build and verify custom guest assets (`build`)

## Installation / running

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
- Node.js >= 22

Guest assets (kernel/initramfs/rootfs, ~200MB) are downloaded automatically on
first use and cached in `~/.cache/gondolin/`.  Alternative you can [build and
ship your own](./custom-images.md).

## Common options (VFS + network)

Both `gondolin bash` and `gondolin exec` (VM mode) support the same set of
options for configuring filesystem mounts and HTTP egress policy.

### VFS (filesystem) options

- `--mount-hostfs HOST_DIR:GUEST_PATH[:ro]`
  - Mount a host directory into the guest at `GUEST_PATH`
  - Add `:ro` to force read-only access
  - Note: the host path must exist and must be a directory

- `--mount-memfs GUEST_PATH`
  - Create an in-memory mount at `GUEST_PATH` (ephemeral)

Examples:

```bash
# Mount a project directory into /workspace
gondolin bash --mount-hostfs "$PWD:/workspace"

# Mount a read-only dataset and a scratch tmpfs
gondolin exec --mount-hostfs /data:/data:ro --mount-memfs /tmp -- ls -la /data
```

### Network options (HTTP allowlist + secret injection)

Gondolin's network bridge only forwards HTTP/HTTPS traffic.  Requests are
intercepted on the host side, which allows enforcing host allowlists and
injecting secrets without exposing them inside the VM.

- `--allow-host HOST_PATTERN`
  - Allow outbound HTTP/HTTPS requests to this host
  - May be repeated
  - `HOST_PATTERN` supports `*` wildcards (for example `*.github.com`)

- `--host-secret NAME@HOST[,HOST...][=VALUE]`
  - Make a secret available inside the VM as an environment variable named `NAME`
  - The VM only sees a random placeholder value; the host replaces that
    placeholder with the real secret **when it appears in an outgoing HTTP
    header**
  - The secret is only permitted for the listed host(s)
  - If `=VALUE` is omitted, the value is read from the host environment variable `$NAME`

Examples:

```bash
# Allow GitHub API calls
gondolin exec --allow-host api.github.com -- curl -sS https://api.github.com/rate_limit

# Secret injection (reads the real value from $GITHUB_TOKEN on the host)
# Inside the VM, $GITHUB_TOKEN is a placeholder that only works for api.github.com
gondolin exec \
  --host-secret GITHUB_TOKEN@api.github.com \
  -- curl -sS -H 'Authorization: Bearer $GITHUB_TOKEN' https://api.github.com/user

# Allow multiple hosts / wildcards
gondolin bash --allow-host "*.github.com" --allow-host api.openai.com
```

## Commands

### `gondolin bash`

Start an interactive `bash` session in the VM:

```bash
gondolin bash [options]
```

Typical workflows:

```bash
# Get a shell with a mounted working directory
gondolin bash --mount-hostfs "$PWD:/workspace"

# Get a shell with restricted HTTP egress and a usable API token
gondolin bash \
  --mount-hostfs "$PWD:/workspace" \
  --host-secret GITHUB_TOKEN@api.github.com
```

### `gondolin exec`

Run one or more commands and exit.

### VM mode (default)

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

### Multi-command form

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

### Socket mode (advanced)

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
- `--output DIR` -- output directory for built assets (required when building)
- `--arch aarch64|x86_64` -- target architecture
- `--verify DIR` -- verify an asset directory against its `manifest.json`
- `--quiet` / `-q` -- reduce output verbosity

Examples:

```bash
# Generate a default config
gondolin build --init-config > build-config.json

# Build assets into ./my-assets
gondolin build --config build-config.json --output ./my-assets

# Use the custom assets
GONDOLIN_GUEST_DIR=./my-assets gondolin bash

# Verify an asset directory
gondolin build --verify ./my-assets
```

For a full configuration reference and build requirements, see:
[Building Custom Images](./custom-images.md).

## Environment variables

- `GONDOLIN_GUEST_DIR`
  - Directory containing guest assets (`manifest.json`, kernel, initramfs, rootfs)
  - If set, Gondolin uses this directory instead of downloading cached assets

- `GONDOLIN_DEBUG`
  - Enable debug logging (see [Debug Logging](./debug.md))

## Help

- `gondolin help`
- `gondolin <command> --help`

//! Usage texts (kept in sync with `host/bin/gondolin.ts`).

pub const MAIN: &str = "Usage: gondolin [engine options] <command> [options]
Commands:
  exec         Run a command via a session IPC socket or in-process VM
  bash         Start an interactive shell session in the VM (bash -> sh fallback)
  list         List running VM sessions
  attach       Attach to a running VM session
  snapshot     Snapshot a running VM session
  image        Manage local image refs and objects
  daemon       Run as gondolind (the controller protocol on stdio)
  help         Show this help
  version      Print the version (also --version, -V)

Engine options (before the command):
  --engine native|auto  Accepted for compatibility; there is only the native
                        engine (--native-command and --remote need the Node
                        CLI)

This is the static gondolin CLI (native engine, no Node.js). `build` and
`tools` need the Node CLI: npx @earendil-works/gondolin.

Run gondolin <command> --help for command-specific flags.";

pub const COMMON: &str = "VFS Options:
  --mount-hostfs HOST:GUEST[:ro]  Mount host directory at guest path
                                  Append :ro for read-only mount
  --mount-memfs PATH              Create memory-backed mount at path

Network Options:
  --allow-host HOST               Allow HTTP requests to host (can repeat)
  --hooks-script FILE             Tier-2 hook policy (.js script, .mjs module, .ts TypeScript)
  --host-secret NAME@HOST[,HOST...][=VALUE]
                                  Add secret for explicit hosts
                                  If =VALUE is omitted, reads from $NAME
  --dns MODE                      DNS mode: synthetic|trusted|open (default: synthetic)
  --dns-trusted-server IP         Trusted resolver IPv4 (repeatable; trusted mode)
  --dns-synthetic-host-mapping M  Synthetic DNS mapping: single|per-host
  --tcp-map SPEC                  Map guest HOST[:PORT] to upstream HOST:PORT
                                  Format: GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT
  --ssh-allow-host HOST[:PORT]     Allow outbound SSH to host (repeatable; default port: 22)
  --ssh-agent [SOCK]              Use ssh-agent for host-side SSH auth (defaults to $SSH_AUTH_SOCK)
  --ssh-known-hosts PATH          OpenSSH known_hosts file for upstream verification (repeatable)
  --ssh-credential SPEC           Host-side SSH key (HOST[:PORT]=PATH or USER@HOST[:PORT]=PATH)
                                  Optional: append ,passphrase-env=ENV or ,passphrase=...
  --disable-websockets            Disable WebSocket upgrades (egress + ingress)

Diagnostics:
  --print-configure               Print the session configuration (JSON) and exit";

pub fn bash() -> String {
    format!(
        "Usage: gondolin bash [options] [-- COMMAND [ARGS...]]

Start an interactive shell session in the sandbox (bash -> sh fallback).
Press Ctrl-] to detach and force-close the session locally.

Command Options:
  --                              Everything after -- is treated as command + args
  --cwd PATH                      Working directory for the command
  --env KEY=VALUE                 Set environment variable (can repeat)
  --resume ID_OR_PATH             Resume from a snapshot ID or .qcow2 path
  --image IMAGE                   Guest image selector (asset dir, build id, or name:tag)
  --vmm BACKEND                   VM backend: qemu|krun|firecracker (default: krun when usable, else qemu)
  --rootfs-size SIZE              Ensure rootfs virtual disk is at least SIZE

{COMMON}

Ingress:
  --listen [HOST:PORT]            Start host ingress gateway (default: 127.0.0.1:0)

Debugging:
  --ssh                           Enable SSH access via a localhost port forward
  --ssh-user USER                 SSH username (default: root)
  --ssh-port PORT                 Local listen port (default: 0 = ephemeral)
  --ssh-listen HOST               Local listen host (default: 127.0.0.1)

Examples:
  gondolin bash --mount-hostfs /home/user/project:/workspace
  gondolin bash --mount-hostfs /data:/data:ro --mount-memfs /tmp
  gondolin bash --allow-host api.github.com
  gondolin bash --host-secret GITHUB_TOKEN@api.github.com
  gondolin bash --listen 127.0.0.1:3000
  gondolin bash --resume 4a8f2b0c
  gondolin bash --vmm krun"
    )
}

pub fn exec() -> String {
    format!(
        "Usage:
  gondolin exec --sock PATH|ID -- CMD [ARGS...]
  gondolin exec --sock PATH|ID --cmd CMD [--arg ARG] [--env KEY=VALUE] [--cwd PATH] [--cmd CMD ...]
  gondolin exec [options] -- CMD [ARGS...]  (in-process VM mode, no --sock)

  --sock PATH|ID uses a Gondolin session IPC socket path or session id.
Use -- to pass a command and its arguments directly.
Arguments apply to the most recent --cmd.

  --image IMAGE                   Guest image selector (asset dir, build id, or name:tag)
  --vmm BACKEND                   VM backend: qemu|krun|firecracker (default: krun when usable, else qemu)
  --rootfs-size SIZE              Ensure rootfs virtual disk is at least SIZE

{COMMON}"
    )
}

pub const LIST: &str = "Usage: gondolin list [options]

List active VM sessions registered in the local cache.

Options:
  --all        Show stale/dead sessions too
  --help, -h   Show this help";

pub const ATTACH: &str = "Usage: gondolin attach <SESSION_ID> [options] [-- COMMAND [ARGS...]]

Attach to an already-running VM and run an interactive command.
Press Ctrl-] to detach locally.

Options:
  --cwd PATH      Working directory for the command
  --env KEY=VALUE Set environment variable (repeatable)
  --help, -h      Show this help

Default command: bash -i (fallback: /bin/sh -i)";

pub const SNAPSHOT: &str = "Usage: gondolin snapshot <SESSION_ID> [options]

Create a disk snapshot of a running VM session and stop it.

Options:
  --output PATH   Absolute or relative path for the snapshot .qcow2 file
  --name NAME     Snapshot name (default output path only)
  --help, -h      Show this help";

pub const IMAGE: &str = "Usage: gondolin image <command> [options]

Manage local Gondolin image objects and refs.

Commands:
  ls
      List local image refs

  import <ASSET_DIR> [--tag REF]
      Import built guest assets into the local image object store

  tag <SOURCE> <TARGET> [--arch aarch64|x86_64]
      Create or update a ref to point at an image

  rm <BUILD_ID|REF> [--force] [--yes] | rm --untagged [--yes] | rm --all [--yes]
      Remove local image tags or objects after confirmation

  inspect <SELECTOR> [--arch aarch64|x86_64]
      Show details for a path, build id, or ref (pulls from registry if needed)

  pull <SELECTOR> [--arch aarch64|x86_64]
      Ensure a selector is available locally via the builtin registry

Building images (`gondolin build`) needs the Node CLI: npx @earendil-works/gondolin build";

# SSH

Gondolin supports SSH in two directions:

- **SSH access to the VM** (host -> guest): an `sshd` inside the VM, reachable
  through a host-local port, for your regular `ssh` client and tools that
  expect SSH. Mainly intended for interactive debugging and ad-hoc
  inspection.
- **SSH egress** (guest -> upstream): outbound SSH from the VM to allowlisted
  hosts, proxied by the host. Primarily intended for git over SSH.

```bash
# SSH into the VM
gondolin bash --ssh

# Let the VM use git over SSH with github.com via your ssh-agent
gondolin bash --ssh-allow-host github.com --ssh-agent
```

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  ssh: { allowedHosts: ["github.com"], agent: process.env.SSH_AUTH_SOCK },
});
const access = await vm.enableSsh();
console.error(access.command); // ready-to-run ssh command
```

You do not need SSH just to get another shell in a running VM: `gondolin
attach` does that (see [CLI](./cli.md#gondolin-attach)).

## SSH Access to the VM

### CLI Usage

```bash
gondolin bash --ssh
```

The CLI prints the ready-to-run command on stderr (`SSH enabled: ssh -p ...`)
and keeps the forwarder open while the shell runs. The other flags:

- `--ssh-user USER`: SSH username (default: `root`)
- `--ssh-port PORT`: local listen port (default: `0` = ephemeral)
- `--ssh-listen HOST`: local listen host (default: `127.0.0.1`)

`--ssh` works the same way in the
[static CLI](./cli.md#static-cli-no-nodejs).

### SDK Usage

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create();

const access = await vm.enableSsh({
  user: "root",       // default
  listenHost: "127.0.0.1",
  listenPort: 0,       // 0 picks an ephemeral port
});

console.error("SSH:", access.command);

// ... use SSH ...

await access.close();
await vm.close();
```

`enableSsh()` starts the VM if it is not running yet. Calling it again while
the forwarder is open returns the same `SshAccess`, which includes:

- `host`, `port`: where to connect on the host
- `user`: the SSH username
- `identityFile`: path to a temporary private key file
- `command`: a ready-to-run `ssh` command string
- `close()`: shuts down the local forwarder and removes the temporary key
  material

If you want a non-root user, the user must exist in the guest image:

```ts
const access = await vm.enableSsh({ user: "sandbox" });
```

Gondolin installs `authorized_keys` into that user's home directory (from
`getent passwd` or `/etc/passwd`).

### How It Works

When you call `vm.enableSsh()` (or pass `--ssh`):

1. The guest starts `sshd` bound to guest loopback only (`127.0.0.1:22`).
2. The guest starts `sandboxssh`, a small helper that allows the host to open
   TCP streams to guest loopback.
3. The host creates a local TCP listener (default `127.0.0.1:<ephemeral>`),
   and forwards each incoming connection to the guest's `127.0.0.1:22` via
   `sandboxssh`.
4. The host generates an ephemeral Ed25519 keypair (with the host's
   `ssh-keygen`, which must be installed) and installs the public key into the
   target user's `authorized_keys`.

With a [remote daemon](./remote.md) the listener is still on your machine; the
streams are tunneled through the daemon connection.

### Client Command Hardening

The `access.command` string explicitly disables features that can create host
backchannels or leak credentials if your local SSH config enables them:

- `ForwardAgent=no` (do not forward your host SSH agent)
- `ClearAllForwardings=yes` (disable local, remote, and dynamic forwarding)
- `IdentitiesOnly=yes` (use only the provided key)

It also disables host key persistence to avoid prompting:

- `StrictHostKeyChecking=no`
- `UserKnownHostsFile=/dev/null`

For fully non-interactive use, you may also want:

- `-o BatchMode=yes`
- `-o LogLevel=ERROR`

### Server Side Hardening

The guest `sshd` is started with additional restrictions:

- public key auth only (no password, no keyboard-interactive)
- `AllowAgentForwarding=no`
- `AllowTcpForwarding=no`
- `X11Forwarding=no`
- `PermitTunnel=no`
- `AllowUsers=<user>`

This is defense in depth so it stays safe even if a user runs their own `ssh`
command without the recommended options.

### Notes and Limitations

- The guest image must include `sshd` (OpenSSH) and `sandboxssh`. Default
  images include them; `enableSsh()` fails with `sshd not found in guest
  image` or `sandboxssh not found in guest image` otherwise.
- The SSH server is only reachable through the host-local forwarder. It is not
  exposed on the guest network.
- Port forwarding is intentionally disabled. If you need host <-> guest
  connectivity for a specific HTTP service, use [ingress](./ingress.md)
  instead of SSH tunnels.

## SSH Egress

SSH egress lets the guest open SSH connections to specific allowlisted
upstream hosts without granting it arbitrary TCP access.

How it works:

- The guest connects to `HOST:PORT` as usual (default `22`; non-standard
  ports are enabled by allowlisting `HOST:PORT`).
- The host intercepts that TCP flow (SSH is only allowed when explicitly
  configured) and terminates it in a host-side SSH server (in `gondolind`).
- For each guest `exec` request, the host opens an upstream SSH connection to
  the real destination using either:
    - a host ssh-agent, or
    - a configured private key
- Upstream host keys are verified on the host via OpenSSH `known_hosts` or a
  custom `hostVerifier` callback.
- SSH egress needs synthetic DNS (the default) with per-host mapping; the
  mapping defaults to `per-host` when SSH egress is configured, and other DNS
  settings are rejected (see [Network Access](./network-access.md)).

The guest never sees your keys or agent: it authenticates to the host-side
proxy, and the host authenticates upstream.

### CLI Usage

Git over SSH using your host ssh-agent:

```bash
gondolin bash \
  --ssh-allow-host github.com \
  --ssh-agent \
  --ssh-known-hosts ~/.ssh/known_hosts
```

On a non-standard port:

```bash
gondolin bash \
  --ssh-allow-host ssh.github.com:443 \
  --ssh-agent \
  --ssh-known-hosts ~/.ssh/known_hosts
```

With a dedicated key and its passphrase from the environment (the host of an
`--ssh-credential` is allowlisted automatically):

```bash
export GIT_KEY_PASSPHRASE='...'

gondolin bash \
  --ssh-credential git@github.com=~/.ssh/id_ed25519,passphrase-env=GIT_KEY_PASSPHRASE \
  --ssh-known-hosts ~/.ssh/known_hosts
```

Interactive passphrase prompting is not supported; prefer `passphrase-env`.
In shells, `~/.ssh/known_hosts` is only expanded when unquoted (otherwise use
`$HOME/.ssh/known_hosts`). The full flag reference is in the
[CLI reference](./cli.md#network-options-ssh-egress-proxy).

### SDK Usage

```ts
import os from "node:os";
import path from "node:path";

import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  dns: {
    mode: "synthetic",
    syntheticHostMapping: "per-host",
  },
  ssh: {
    allowedHosts: ["github.com"],

    // Non-standard ports can be allowlisted as "HOST:PORT" (e.g. "ssh.github.com:443")

    // Authenticate upstream using host ssh-agent OR a configured private key
    agent: process.env.SSH_AUTH_SOCK,
    // credentials: { "github.com": { username: "git", privateKey: "..." } },

    // Verify upstream host keys (recommended)
    knownHostsFile: path.join(os.homedir(), ".ssh", "known_hosts"),

    // Optional: allow/deny individual ssh exec requests (useful for git repo filtering)
    // execPolicy: (req) => ({ allow: true }),

    // Optional safety/perf knobs:
    // maxUpstreamConnectionsPerTcpSession: 4,
    // maxUpstreamConnectionsTotal: 64,
    // upstreamReadyTimeoutMs: 15_000,
    // upstreamKeepaliveIntervalMs: 10_000,
    // upstreamKeepaliveCountMax: 3,
  },
});

// Now commands like `git clone git@github.com:org/repo.git` can work inside the guest
```

The `dns` block is optional (those are the defaults when `ssh.allowedHosts`
is set).

### Options

`VMOptions.ssh` (`SshOptions`):

| Option | Meaning |
| --- | --- |
| `allowedHosts` | host patterns the guest may reach over SSH (`*` wildcards; `HOST:PORT` for non-standard ports, default port `22`) |
| `agent` | host ssh-agent socket path (e.g. `$SSH_AUTH_SOCK`) |
| `credentials` | host pattern -> `{ username?, privateKey, passphrase? }` (OpenSSH/PEM key as string or `Buffer`) |
| `knownHostsFile` | OpenSSH `known_hosts` file(s) for host key verification (default: `~/.ssh/known_hosts` and `/etc/ssh/ssh_known_hosts`) |
| `hostVerifier` | `(hostname, key, port) => boolean` callback instead of `known_hosts` |
| `execPolicy` | allow/deny callback for each guest `exec` request (see [below](#exec-policy)) |
| `hostKey` | host key the proxy presents to the guest (default: ephemeral) |
| `maxUpstreamConnectionsPerTcpSession` | max concurrent upstream connections per guest TCP flow |
| `maxUpstreamConnectionsTotal` | max concurrent upstream connections across all guest flows |
| `upstreamReadyTimeoutMs` | upstream connect and handshake timeout in `ms` |
| `upstreamKeepaliveIntervalMs` | upstream keepalive interval in `ms` |
| `upstreamKeepaliveCountMax` | upstream keepalive probes before disconnect |

Unlike `--ssh-credential`, `ssh.credentials` does not add hosts to
`allowedHosts`: list them there too.

### Exec Policy

`execPolicy` lets the host allow or deny each SSH `exec` request before it is
proxied upstream. It receives an `SshExecRequest`:

- `hostname`, `port`: the upstream target (from synthetic DNS attribution)
- `guestUsername`: the username the guest authenticated as
- `command`: the raw `exec` command
- `src`: `{ ip, port }` of the guest flow

It returns (or resolves to) `{ allow: true }` or `{ allow: false, exitCode?,
message? }`: the guest channel gets `message` on stderr and exits with
`exitCode` (default `1`).

For git over SSH, `getInfoFromSshExecRequest(req)` parses the canonical git
commands into `{ service, repo }` (for example `git-upload-pack` and
`org/repo.git`), and returns `null` for anything else (fail closed). Restrict
access to a set of repos:

```ts
import { VM, getInfoFromSshExecRequest } from "@earendil-works/gondolin";

const allowedRepos = new Set(["my-org/repo-a.git", "my-org/repo-b.git"]);

const vm = await VM.create({
  ssh: {
    allowedHosts: ["github.com"],
    agent: process.env.SSH_AUTH_SOCK,
    execPolicy: (req) => {
      const git = getInfoFromSshExecRequest(req);
      if (!git) return { allow: false, message: "non-git ssh denied" };
      if (!allowedRepos.has(git.repo)) return { allow: false, message: "repo not allowed" };
      if (git.service === "git-receive-pack") return { allow: false, message: "push disabled" };
      return { allow: true };
    },
  },
});
```

`execPolicy` and `hostVerifier` run in your Node.js process; the daemon asks
for each decision.

### Guest SSH Client Options (git)

The guest's OpenSSH client is connecting to Gondolin's **host-side SSH
proxy**. That proxy uses an ephemeral host key and does not currently support
post-quantum key exchange, so OpenSSH may show:

- `Permanently added ...` / host key prompts
- `** WARNING: connection is not using a post-quantum key exchange algorithm.`

For non-interactive tools like `git`, you can suppress prompts and these
warnings:

```sh
export GIT_SSH_COMMAND='ssh \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o GlobalKnownHostsFile=/dev/null \
  -o LogLevel=ERROR'
```

This only affects the guest-to-proxy SSH client UX. Upstream host key
verification still happens on the host (via `known_hosts` /
`--ssh-known-hosts`).

### Limitations

- Only non-interactive `exec` channels are supported
    - interactive shells are denied
    - subsystems (such as `sftp`) are denied
- Upstream connections are resource-capped and time-bounded to avoid
  guest-triggerable host DoS.
- SSH egress flows bypass HTTP hooks and secret placeholders; the `exec`
  policy is the hook point.
- With a [remote daemon](./remote.md), `ssh.agent` (`--ssh-agent`) is not
  supported (the agent socket is on your machine; use `credentials`), and
  `known_hosts` files are read on your machine and sent to the daemon as
  content.

For the protocol-level details, see [Network Stack](./network.md).

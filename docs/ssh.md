# SSH

Gondolin can expose an SSH server inside the guest VM and provide a host-local
port you can connect to with your regular `ssh` client.

This is mainly intended for interactive debugging, ad-hoc inspection, and
tooling that expects SSH.

## What `enableSsh()` Does

When you call `vm.enableSsh()`:

1. The guest starts `sshd` bound to guest loopback only (`127.0.0.1:22`).
2. The guest starts `sandboxssh`, a small helper that allows the host to open
   TCP streams to guest loopback.
3. The host creates a local TCP listener (default `127.0.0.1:<ephemeral>`), and
   forwards each incoming connection to the guest's `127.0.0.1:22` via `sandboxssh`.
4. The host generates an ephemeral Ed25519 keypair and installs the public key
   into the target user's `authorized_keys`.

The returned `SshAccess` includes:

- `host`, `port`: where to connect on the host
- `user`: the SSH username
- `identityFile`: path to a temporary private key file
- `command`: a ready-to-run `ssh` command string
- `close()`: shuts down the local forwarder and removes the temporary key material

## SDK Usage

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create();
await vm.start();

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

If you want a non-root user, the user must exist in the guest image:

```ts
const access = await vm.enableSsh({ user: "sandbox" });
```

Gondolin will install `authorized_keys` into that user's home directory (from
`getent passwd` or `/etc/passwd`).

## Client Command Hardening

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

## Server Side Hardening

The guest `sshd` is started with additional restrictions:

- public key auth only (no password, no keyboard-interactive)
- `AllowAgentForwarding=no`
- `AllowTcpForwarding=no`
- `X11Forwarding=no`
- `PermitTunnel=no`
- `AllowUsers=<user>`

This is defense in depth so it stays safe even if a user runs their own `ssh`
command without the recommended options.

## Notes and Limitations

- The guest image must include `sshd` (OpenSSH) and `sandboxssh`. Default images
  are expected to include them.
- The SSH server is only reachable through the host-local forwarder. It is not
  exposed on the guest network.
- Port forwarding is intentionally disabled. If you need host <-> guest
  connectivity for a specific service, prefer purpose-built host APIs instead of
  SSH tunnels.

## Outbound SSH (Guest -> Upstream)

Separate from `vm.enableSsh()` (host -> guest SSH access), Gondolin can also
allow **outbound** SSH from the guest to specific allowlisted upstream hosts.
This is primarily intended for workflows like **git over SSH**.

How it works:

- The guest connects to `HOST:22` as usual.
- The host intercepts that TCP flow (SSH is only allowed when explicitly
  configured) and terminates it in an in-process SSH server.
- For each guest `exec` request, the host opens an upstream SSH connection to
  the real destination using either:
    - a host ssh-agent, or
    - a configured private key
- Upstream host keys are verified on the host via OpenSSH `known_hosts` (or a
  custom verifier).

Limitations:

- Only non-interactive `exec` channels are supported
    - interactive shells are denied
    - subsystems (such as `sftp`) are denied
- Upstream connections are resource-capped and time-bounded to avoid
  guest-triggerable host DoS

### CLI

See the SSH egress flags in the CLI reference: [CLI](./cli.md).

### SDK

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  dns: {
    mode: "synthetic",
    syntheticHostMapping: "per-host",
  },
  ssh: {
    allowedHosts: ["github.com"],
    agent: process.env.SSH_AUTH_SOCK,
    knownHostsFile: "~/.ssh/known_hosts",

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

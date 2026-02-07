# Gondolin Security Design

This document describes Gondolin's security model: what the system is trying to
protect, what it assumes, what it *guarantees*, and how to operate it so you
remain inside the intended "safe envelope".

Gondolin's core idea is that *"untrusted code runs in a real Linux VM, but the
VM's *I/O surface area* (network + persistence) is mediated by host code you
control."*

## Scope and goals

Gondolin exists to provide a playground for an agent to work with.  Agents are
tricky because they are great reverse engineers and given the right prompts, they
can be quite inventive in trying to escape their sandboxes.

### Primary goal
Run potentially untrusted / prompt-injected code (typically agent-generated) while:

1. **Preventing credential theft** (secrets should not be readable from inside the guest)
2. **Confining network egress** (only the intended remote services are reachable)
3. **Confining persistence and host file access** (the guest's view of storage
  is explicit and programmable)

In particular *all* of the injected file system is controllable.  This means the host can
fully change how folders behave, not just bind it to different folders on the real file system.

### Non-goals

Gondolin is not trying to defend against:

- **A malicious host**: the Node.js process and the machine it runs on are trusted.
- **A malicious local user** on the same host account: they can usually access
  the Unix sockets and cached files.
- **VM escape / hypervisor bugs**: Gondolin uses QEMU; a QEMU escape is a host compromise.
- **Side channels** (timing/cache/etc.) between host and guest.
- **Denial of service**: the guest can still burn CPU, allocate memory inside
  the VM, or cause large amounts of host work (there are some buffer caps, but no
  complete DoS isolation).

## Threat model

These are the primary threats this design attempts to protect against.

### Attacker
- Code executing inside the guest VM (shell scripts, binaries, interpreted code, etc.)
- Remote servers the guest connects to (including malicious redirects)

We generally assume that the users of Gondolin will try to give more trust to
the actual end user and less trust to third-party files retrieved from the
internet. For instance, because they want to implement something like the CaMeL
approach.  However, we make little assumption in the system about how exactly
the trust is divided.

### Assets we want to protect
- **Host secrets** (API keys, tokens) supplied to the host application
- **Host network** (localhost services, cloud metadata endpoints, internal RFC1918 ranges)
- **Host filesystem** (unless explicitly mounted)

### Trust assumptions
- The host process (your Node runtime + Gondolin library) is trusted.
- The guest image is trusted *to the extent you trust its supply chain*.
- The VM boundary provided by QEMU is trusted.

## System architecture and trust boundaries

This is a rough overview of the system today.

### High-level components

- **Host (TypeScript)**
  - `SandboxController` spawns and manages QEMU
  - `SandboxServer` implements the virtio-serial control plane, VFS RPC service, and network backend
  - `QemuNetworkBackend` implements an Ethernet/IP/TCP stack and HTTP/TLS bridging
  - VFS providers implement programmable filesystem behavior (based on NodeJS's upcoming VFS)

- **Guest (Zig + init scripts)**
  - `sandboxd` executes commands requested by the host over virtio-serial
  - `sandboxfs` is a FUSE filesystem that proxies filesystem operations to the host over RPC
  - `sandboxssh` is a dedicated virtio-serial TCP forwarder for *loopback-only* connections inside the guest
  - `/init` sets up tmpfs mounts, networking, starts `sandboxfs`, then starts `sandboxd`

### Trust boundaries

```
+----------------------------- Host machine ------------------------------+
|                                                                         |
|   Node.js process using gondolin's VM (trusted)                         |
|   - policy (allowed hosts)                                              |
|   - secrets (real values)                                               |
|   - VFS providers (host/virtual FS access)                              |
|                                                                         |
|   +---------------------- QEMU process boundary ---------------------+  |
|   |  Guest Linux VM (untrusted code)                                 |  |
|   |  - sees eth0, but traffic is intercepted by host                 |  |
|   |  - sees /data (FUSE), but ops are served by host providers       |  |
|   |  - runs arbitrary processes via sandboxd                         |  |
|   +------------------------------------------------------------------+  |
|                                                                         |
+-------------------------------------------------------------------------+
```

The **guest is treated as adversarial**. The host is the policy enforcement point.

## Security guarantees

This is what Gondolin actually enforces.

### Compute isolation

> "guest code does not directly run on the host OS"

- Guest code runs inside a QEMU VM.
- The QEMU invocation is intentionally minimal (see `host/src/sandbox-controller.ts`):
  - `-nodefaults` (avoid unexpected devices)
  - `-no-reboot`, `-nographic`
  - virtio devices only (virtio-serial, virtio-net, virtio-blk, virtio-rng)
  - the rootfs block device is attached as `snapshot=on` so writes do not persist to the base image

**Guarantee:** absent a QEMU escape, guest processes cannot directly access the
*host kernel, host memory, or host filesystem.

### Network egress confinement

> "only HTTP + TLS is permitted, and only to allowed destinations"

Gondolin does *not* provide the guest with a raw NAT to the host network.

Instead, the host implements its own network stack (`host/src/network-stack.ts`)
and a backend that attaches to QEMU's `-netdev stream` Unix socket
(`host/src/qemu-net.ts`).

Key enforcement points:

1. **Protocol allowlist (TCP flow sniffing)**
  - For each outgoing TCP flow, the host sniffs the first bytes and classifies it as:
    - `http` (HTTP/1.x request line)
    - `tls` (TLS ClientHello record)
    - otherwise **denied** (`unknown-protocol`)
  - HTTP `CONNECT` is explicitly denied (`connect-not-allowed`).

    This prevents the guest from tunneling arbitrary TCP protocols.

2. **UDP is blocked except for DNS**
  - Only UDP destination port `53` is forwarded; other UDP is blocked.  See note on DNS
    below.

3. **HTTP/HTTPS is bridged by the host**
  - For `http` flows, the host parses the request and replays it using `fetch` (undici).
  - For `tls` flows, the host performs a **TLS MITM** (see below) to recover
    the HTTP request, then replays via `fetch`.

4. **Host allowlist and internal-range blocking**
  - `createHttpHooks()` (see `host/src/http-hooks.ts`) produces an `httpHooks.isAllowed()` implementation.
  - By default, it blocks internal ranges (`blockInternalRanges: true`), including:
    - IPv4: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 0.0.0.0/8, broadcast
    - IPv6: loopback, link-local, ULA, and IPv4-mapped variants
  - It can also require that the request hostname matches a configured allowlist (with `*` wildcards).

5. **DNS rebinding protection**
  Gondolin checks policy in *two* places:
  - `ensureRequestAllowed()` resolves the hostname and checks `isAllowed({ hostname, ip, ... })`.
  - When using the default `fetch`, Gondolin installs a custom undici
    dispatcher with a guarded `lookup()` (`createLookupGuard()`), which re-checks
    `isAllowed()` against the *actual resolved IPs used by the connection*.

6. **Redirect policy is enforced by the host**
  - The host follows redirects itself (`redirect: "manual"` + explicit handling).
  - Each redirect target is revalidated against policy before fetching.

**Guarantee:** the guest cannot open raw TCP tunnels, cannot use UDP (except DNS), and cannot
reach blocked networks (e.g. localhost/metadata) *through DNS tricks or redirects*, as long
as `httpHooks.isAllowed` enforces those rules.

DNS within the system is supported because there is utility in it, but DNS resolutions are
fully disregarded by the HTTP stack as the host will resolve it from scratch.

ICMP ECHOs are supported by made up.  Any IP can be pinged.

### Secret non-exposure

> "real secret values never appear inside the guest"

Gondolin's secret strategy is:

- The guest receives **random placeholders** as environment variables (e.g.
  `GONDOLIN_SECRET_<random>`).
- When the guest makes an HTTP request, the host's request hook
  (`createHttpHooks().httpHooks.onRequest`) scans outbound headers and **replaces
  placeholders with real secret values** *only* if the destination hostname
  matches the secret's host allowlist.
- If a placeholder is found but the destination host is not allowed, the request
  is blocked.

**Guarantee:** if you only pass secrets via this mechanism, the guest cannot
read the real secret values from its process environment, disk, or memory
because they never enter the VM.  However that does not fully protect the system
if there are ways to utilize the target server to echo the secrets back!

### Filesystem confinement

> "host filesystem access is explicit and programmable"

By default the VM gets:

- The base root filesystem from the image
- A number of tmpfs mounts (`/tmp`, `/root`, `/var/log`, etc.) created by
  `/init` (see `guest/image/init`)
- An optional FUSE mount (default `/data`) backed by host-controlled providers

The programmable filesystem path is:

- Guest `sandboxfs` (FUSE) translates Linux VFS operations into RPC requests
  (`fs_request`) over a virtio-serial port.
- Host `FsRpcService` (`host/src/vfs/rpc-service.ts`) validates and dispatches
  operations to a `VirtualProvider`.
- Providers can be:
  - in-memory (`MemoryProvider`)
  - real host filesystem (`RealFSProvider`)
  - wrappers (`ReadonlyProvider`, mount routers, custom policy providers)

`FsRpcService` enforces basic protocol invariants:

- File names are single components (no `/` or NUL)
- Paths are normalized to absolute POSIX paths
- Read/write payloads are capped (`MAX_RPC_DATA = 60 KiB`) to keep framing bounded

**Guarantee:** the guest cannot access host files unless you mount them through
a provider.

### Controlled "backchannels"

`SandboxServer.openTcpStream()` opens a TCP stream to a service inside the guest
using a dedicated virtio-serial port (`virtio-ssh`).

On the guest, `sandboxssh` enforces:
- **Only loopback targets are allowed** (`127.0.0.1` / `localhost`)

This is intentionally outside the guest's network policy because it is a
host <-> guest control feature.

**Guarantee:** this API cannot be used to reach arbitrary guest network
destinations; it only reaches services bound to guest loopback.

## Why the design is secure

Secure here means secure within our design goals.

### Minimize the attack surface

Instead of trying to safely pass through a full network stack and hope that
firewalling is correct, Gondolin narrows egress to a small set of patterns:

- DNS queries (UDP/53)
- HTTP/1.x requests
- TLS handshakes that can be terminated locally

Everything else is dropped before it becomes a real host socket.

This means:
- No arbitrary TCP tunnels
- No SSH/SOCKS/VPN/proxy protocols
- No custom binary protocols

### Make the host the policy enforcement point
Because the host replays HTTP requests via `fetch`, the host can:

- Enforce allowlists by hostname
- Enforce IP-based rules after DNS resolution (including internal-range blocks)
- Inspect/transform requests and responses
- Insert secrets at the last possible moment

The guest can ask for things, but it does not get to choose how packets are emitted.

### Secrets are never placed in the guest's possession

From a secrets perspective, the strongest way to prevent exfiltration is: **do
not deliver the secret to the untrusted environment**.

Gondolin's placeholder substitution ensures the guest can *reference* a secret
(to make legitimate calls) without being able to *read* it.

## Operating within the "safe envelope"

These are rules to not compromise the security guarantees of the system:

### Network policy

1. **Use an allowlist; avoid `*`**
  - Prefer exact hosts (`api.github.com`) over wildcards (`*.github.com`).
  - Treat redirects as part of the policy design (the host will follow them and enforce policy on each hop).

2. **Keep `blockInternalRanges: true`**
  - This is on by default in `createHttpHooks()`.
  - Disabling it reintroduces localhost/metadata risks.

3. **Assume allowed hosts can receive any data the guest can read**
  - Gondolin prevents network egress to *other* hosts, but does not stop the
    guest from uploading arbitrary data to an allowed host.
   - If you mount sensitive host data read-write/read-only, consider it exfiltratable to allowed hosts.

4. **If you allow more than one host, add auditing**
   - Use `httpHooks.onRequest` / `onResponse` to log and/or block unexpected paths or methods.

### Secrets

1. **Only provide secrets via `createHttpHooks({ secrets: ... })`**
  - Do not mount `~/.aws`, `~/.config`, `.env`, etc. into the guest.
  - Do not pass real secrets in `VM.env`.

2. **Secrets are only substituted in HTTP headers**
  - If you put placeholders in a request body or URL, they will *not* be replaced.
  - Design your client code to pass credentials in headers.

3. **Don't rely on placeholders being "unguessable"**
  - Placeholders are random and not the secret, but the guest can still transmit them.
  - Your security relies on the fact that placeholders are useless without host substitution.

### Filesystem mounts

1. **Default to `MemoryProvider` for `/workspace`-style scratch space**
2. **Use `ReadonlyProvider(RealFSProvider(...))` for host directories you must expose**
3. **Avoid mounting your whole home directory**
4. **Be careful with mounting `/`**
  - If you mount a custom provider at `/`, you might hide `/etc/ssl/certs`.
  - Gondolin automatically injects a read-only CA cert mount at `/etc/ssl/certs`
    unless you already mounted that path.

### TLS MITM CA handling

- Gondolin generates a local CA under `~/.cache/gondolin/ssl` (or `XDG_CACHE_HOME`).
- The CA cert is injected into the guest at `/etc/ssl/certs/ca-certificates.crt`
  unless you override that mount.

Operational guidance:
- Treat the CA private key as sensitive (it can sign certs trusted by the guest).
- If you want per-run isolation, point `mitmCertDir` at a temporary directory.

### Guest images and supply chain

- Default assets are downloaded from GitHub releases over HTTPS
(`host/src/assets.ts`).
- Custom builds can emit a `manifest.json` with SHA-256 checksums, and the CLI
  supports `gondolin build --verify`.

Guidance:
- For high assurance, build images yourself and verify checksums.
- Keep QEMU up to date; the VM boundary is fundamental.

## Known limitations and sharp edges

### "Only HTTP/TLS" is not the same as "safe networking"
- If you allow `api.example.com`, malicious guest code can still send *any* data
  it can read to that host.
- Servers that can echo headers back (eg: httpbin) can be used to exfiltrate secrets.
- Gondolin's network layer is meant to prevent **unexpected** exfiltration
  destinations and limit protocol abuse, not to prevent exfiltration to an allowed
  destination.

### VM escape risk
- The strongest guarantee depends on QEMU isolation.

### Local host attacker
- Virtio Unix sockets are created in a temp directory.  A local attacker with the
  same user privileges can typically interfere.

### DoS
- There are explicit buffer caps (e.g. HTTP header/body limits, virtio pending
  queues), but no full resource governance.
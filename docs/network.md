# Network Stack

This document explains Gondolin's network design: what the guest VM sees, what
the host actually does with that traffic, and which security and policy
guarantees fall out of that design. For how to configure network access, see
[Network Access](./network-access.md) and
[HTTP Hooks and Policies](./hooks.md).

The main idea is:

- The guest gets a normal `eth0` interface.
- The host does **not** provide a generic NAT.
- Instead, the host terminates and mediates traffic in a **userspace network
  stack**, and only allows a narrow set of egress patterns (primarily HTTP and
  TLS that can be intercepted, plus optional explicit SSH and host-mapped TCP
  egress).

The guest should be treated as adversarial: the host is the enforcement point.

## Network Design Goals

- Constrain egress to intended destinations (host allowlist + internal-range
  blocking)
- Prevent arbitrary TCP tunneling (no generic "open socket to the internet")
- Make requests observable and programmable (hooks)
- Enable secret injection without delivering secret values into the guest

## High-Level Architecture

At a high level, the data path looks like this:

1. **Guest app** writes bytes to a socket.
2. Bytes become **Ethernet frames** emitted by the guest kernel via
   virtio-net.
3. The VMM (QEMU or krun) forwards those frames to the Gondolin daemon
   (`gondolind`) through a private Unix socket.
4. The daemon parses frames into L2/L3/L4 and either:
    - services the traffic locally (e.g. DHCP replies, synthetic DNS),
    - relays it in a restricted way (DNS in `trusted`/`open` mode, mapped
      TCP, proxied SSH), or
    - bridges it into **host-side HTTP(S)** using an HTTP parser + TLS MITM.

Conceptually:

- The guest speaks "real networking" (Ethernet/IP/TCP/UDP).
- The host speaks "real networking" only for a narrow subset, and otherwise
  drops packets.

All of this runs in `gondolind`: `gondolin-netstack` (a userspace stack built
on smoltcp) terminates the guest's traffic, `gondolin-egress` classifies flows
and mediates HTTP/TLS, `gondolin-http` is the upstream HTTP/1.1 client (over
rustls) and `gondolin-sshproxy` handles SSH egress. Only hooks registered in
your program call back into your Node.js process (see
[Architecture](./architecture.md)).

## Addressing and "LAN" Model

The guest is placed into a small private IPv4 subnet with a host-side
"gateway":

- Gateway IP: `192.168.127.1`
- Guest IP: `192.168.127.3`
- Subnet: `/24` (`255.255.255.0`)

The host implements enough LAN behavior for a typical Linux userspace to work:

- ARP resolution for the gateway
- DHCP (so the guest can use standard `udhcpc`/dhclient flows)

The daemon also passes the same settings on the kernel command line
(`gondolin.net=192.168.127.3/24,192.168.127.1,DNS[+DNS...]`), and the guest's
init applies them with `ip` instead of running DHCP, which saves ~40 ms per
boot. Images without that support ignore the argument and use DHCP, and
`GONDOLIN_GUEST_DHCP=1` in the daemon's environment leaves it out (CI keeps
the DHCP path working that way).

This is a **virtual** LAN: it is not bridged to the real host network!

## Protocol Layers Implemented by the Host

The host implements a userspace network stack so it can inspect and control all
traffic:

- Ethernet framing and dispatch
- ARP (so the guest can discover the "gateway" MAC)
- IPv4 parsing and emission
- ICMP echo handling (synthetic replies for any destination)
- DHCP server (address assignment)
- TCP state machine (connection tracking and stream reassembly)
- UDP handling, but *restricted* (see DNS)

Important implication: Gondolin does not rely on "host firewall rules" for
correctness. The enforcement happens *before* any real host sockets are
created.

## DNS Handling

DNS exists because it is useful for HTTP clients, but it is intentionally
constrained. The modes and their options are described in
[Network Access](./network-access.md#dns); this section covers how they work.

- Only UDP destination port **53** is handled; all other UDP is dropped.
- The guest learns a DNS server via DHCP (or the same list in
  `gondolin.net`):
    - In `synthetic` / `trusted` mode, the DHCP server advertises the
      **gateway** (`192.168.127.1`) as the resolver (so the host can intercept
      DNS)
    - In `open` mode, the DHCP server advertises the host's non-loopback IPv4
      resolvers (falling back to `8.8.8.8` if none are suitable)
- `synthetic` mode: the host replies directly. Responses are only generated
  for normal-looking queries, and only for `A` / `AAAA` questions.
    - `single` host mapping answers every name with the same address
      (`192.0.2.1` / `2001:db8::1` by default)
    - `per-host` mapping gives every name its own IPv4 address from
      `198.19.0.0/16` and keeps a table from address back to name, which is
      how SSH egress and mapped TCP attribute a TCP connection to a host name
- `trusted` mode: queries must parse as standard DNS queries; they are sent
  to the trusted resolvers (IPv4 only) regardless of the destination the guest
  chose, and the reply is returned as if it came from that destination.
- `open` mode: UDP/53 is forwarded to the destination IP the guest targeted
  without validation.

There is no goal of being a full-featured recursive resolver (for example,
caching is not required for correctness).

### DNS and Policy

Even though DNS is available, policy decisions are **not** based on "what the
guest resolved." Instead, HTTP policy is enforced by the host using host-side
resolution at the point a real upstream connection is made.

This matters for security because it prevents a class of attacks where the
guest tries to confuse policy via DNS tricks (e.g. DNS rebinding).

## TCP Stream Classification

For each outbound TCP flow, Gondolin either applies an explicit host mapping
first (if configured) or inspects the beginning of the byte stream (up to
8 KiB) and classifies it:

- **TCP (mapped)**: explicit `tcp.hosts` mapping matched by synthetic hostname
  (+ optional port)
- **HTTP**: looks like an HTTP/1.x request line
- **TLS**: looks like a TLS ClientHello
- **SSH**: looks like an SSH client banner (`SSH-2.0-...`) on a configured SSH
  port, and is only allowed when SSH egress is explicitly enabled +
  allowlisted
- Anything else: **blocked** (the flow is reset)

This is the core mechanism that prevents arbitrary TCP tunneling. The guest can
open TCP sockets, but only connections that are explicitly mapped or quickly
turn into HTTP, TLS, or configured SSH will be forwarded.

Design notes:

- HTTP `CONNECT` is explicitly denied. This prevents using HTTP as a generic
  tunnel.
- SSH egress (when enabled) is proxied by the host and intentionally limited to
  non-interactive `exec` usage.
- Protocol classification is deliberately conservative.

## Outbound SSH Egress

When SSH egress is enabled (see [SSH](./ssh.md)), flows classified as SSH are
terminated by an SSH server in the daemon:

- The destination host name is derived from the synthetic destination IP
  (`per-host` mapping), and must match an allowlisted `HOST[:PORT]` target.
- For each guest `exec` request, the daemon opens an upstream SSH connection,
  verifies the upstream host key (OpenSSH `known_hosts` or a host verifier
  hook) and authenticates with ssh-agent or a configured key. The guest never
  receives private key material.
- Only `exec` channels are supported; shells and subsystems such as `sftp`
  are denied.
- Connection caps per guest flow and in total, a bounded handshake
  (`readyTimeout`) and keepalives bound resource usage.

## Host-Mapped TCP Egress

For `tcp.hosts` rules (see
[Network Access](./network-access.md#host-mapped-tcp)):

- The guest resolves `HOST` in synthetic DNS mode with `per-host` mapping.
- When it connects, the daemon maps the synthetic destination IP back to the
  host name; if a rule matches (`HOST:PORT` first, then `HOST`), the flow is
  marked as mapped TCP.
- The daemon opens a TCP socket to the configured upstream target and copies
  bytes in both directions.

There is no HTTP parsing, hook pipeline, secret substitution or IP policy on
mapped flows. This keeps the exception explicit and narrow while still avoiding
generic NAT.

## HTTP Bridging

For connections classified as HTTP:

1. The host parses the request line and headers. Hop-by-hop headers are
   removed, and for absolute-form request targets the URL wins over the
   guest's `Host` header (the two are kept consistent so the upstream cannot be
   steered to another virtual host).
2. The host applies the configured request hooks and policy checks.
3. The host performs the actual upstream request with its own HTTP/1.1 client
   (`gondolin-http`), using keep-alive connection pooling.
4. The host streams (or buffers, depending on hooks) the response back to the
   guest as an HTTP/1.x response. Compressed responses are forwarded as
   received; hooks get a decoded view.

The guest experiences this as "it made an HTTP request over TCP", but in
reality the guest never gets a raw upstream TCP tunnel.

WebSocket upgrades are bridged the same way up to the `101` response; after
that the daemon copies bytes between the guest and the upstream connection.

## HTTPS via TLS MITM

For connections classified as TLS, Gondolin performs a controlled MITM:

1. The host reads the TLS ClientHello and extracts the intended server name
   (SNI; the destination IP when there is none).
2. The host presents a dynamically generated certificate for that name, signed
   by a local CA (ECDSA P-256 leaf certificates, cached per name). Only
   HTTP/1.1 is offered via ALPN.
3. The guest establishes TLS to the host (believing it is the origin).
4. The host decrypts the HTTP request inside TLS and then repeats the same HTTP
   bridging pipeline as for plain HTTP, connecting upstream with its own TLS
   client.

### CA and Guest Trust

To make this work, the guest must trust the host-generated CA:

- Gondolin creates (and caches) a CA keypair on the host (in
  `~/.cache/gondolin/ssl`; a remote `gondolind` keeps its own on its machine).
- The CA certificate is mounted into the guest at `/etc/gondolin/mitm/ca.crt`,
  and the guest's init adds it to the trust stores so common TLS clients
  (curl, node, python, etc.) accept the MITM certificates.

See [Network Access](./network-access.md#the-mitm-ca) for the configuration and
[Security Design](./security.md#tls-mitm-ca-handling) for handling the CA key.

## Policy Enforcement

Policy enforcement happens on the host and is designed to be robust against
common evasion tricks.

### Allowlist by Hostname

A typical setup uses an allowlist of hostnames (often with `*` wildcards).
Requests to hosts not on the allowlist are denied. The declarative options of
`createHttpHooks()` are sent to the daemon as rules and evaluated there, so
they cost no round trip to your process.

### Blocking Internal Ranges

By default, Gondolin blocks connections to internal / local ranges:

- IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`,
  `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `255.0.0.0/8`
- IPv6: `::`, `::1`, `fc00::/7`, `fe80::/10`, and IPv4 addresses embedded in
  IPv4-mapped/-compatible, NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 and
  Teredo addresses

This prevents the guest from reaching sensitive services on the host's LAN or
cloud metadata endpoints.

This applies even when no `httpHooks` are configured: without declarative
rules and without an `isIpAllowed` hook, the daemon applies a default policy
that rejects internal addresses. To reach internal services, use
`allowedInternalHosts` / `blockInternalRanges: false` with `createHttpHooks()`,
or supply your own `isIpAllowed` without `createHttpHooks()` (which fully
replaces the default).

### DNS Rebinding Protection

Policy is checked using host-side DNS resolution and is validated more than
once:

- Once when evaluating the request target
- Again at the point where the upstream connection is opened

This closes the common "resolve to public IP at check-time, then to private IP
at connect-time" rebinding pattern. Successful lookups are reused for about two
seconds, which also keeps the check and the connect on the same addresses.

When upstream keep-alive pooling is in use, the connect-time check runs when a
new upstream connection is opened; requests sent over a reused pooled
connection do not trigger a fresh connect-time IP check.

### Redirect Handling

Redirects are handled by the host (not blindly followed by the guest's TCP
stack), and each redirect target is re-validated against policy and passes
through the request hooks again. The guest only sees the final response.

## Hooks and Programmability

Hooks run on the host **after** the traffic has been parsed into structured
HTTP requests, not on raw packets. Policy is evaluated in tiers, in every
phase:

1. Declarative rules (allowlists, internal ranges, secrets), evaluated by
   `gondolin-egress` itself
2. A tier-2 policy (`createDjsHooks()`, `--hooks-script`), run by the daemon in
   an embedded JavaScript engine (`gondolin-hooks-djs`)
3. Hooks in your process, which the daemon calls over its connection to your
   Node.js process; bodies are transferred only when a hook reads them

Only registered phases are called. See
[HTTP Hooks and Policies](./hooks.md) for the hook API and the exact
[order of evaluation](./hooks.md#order-of-evaluation).

## Secret Injection

Secrets are handled as part of the HTTP mediation pipeline:

- The guest receives **placeholders** in its environment.
- When the guest sends an HTTP request, the host scans headers (and optionally
  the query string) for placeholders after the request hooks ran.
- If the destination host is allowed for that secret, the host substitutes the
  real secret value into the outbound request.
- If not allowed, the request is blocked. Requests that carry a real secret
  value to a host it is not allowed for are blocked too.

This design ensures real secret values never need to exist in the guest's
memory, environment, or filesystem. See [Secrets](./secrets.md).

## Buffering and Limits

To keep the system predictable and bound resource usage, the network layer
enforces size limits such as:

- Maximum request body size (`maxHttpBodyBytes`, default 64 MiB)
- Maximum buffered response body size (`maxHttpResponseBodyBytes`, default
  64 MiB), when response hooks read bodies
- Request bodies replayed on `307`/`308` redirects (1 MiB for streamed bodies)
- At most 10 redirects per request
- Limits for header parsing, protocol sniffing (8 KiB) and internal queues

Bodies are streamed wherever no hook needs them. If you plan to transfer large
payloads, design around these limits (e.g. avoid reading large downloads in
response hooks).

## Known Limitations

The network stack is intentionally *not* a general-purpose internet connection.
Common limitations include:

- No HTTP/3 or HTTP/2 (HTTP/1.x only)
- WebSocket upgrades are supported, but after the `101` response the
  connection becomes an opaque tunnel (only the request handshake is
  mediated/hookable)
- No HTTP `CONNECT`, and no upstream HTTP proxy support
- No generic UDP (DNS-only)
- No IPv6 networking in the guest (IPv4 only; synthetic `AAAA` answers exist
  for compatibility)
- No arbitrary TCP/NAT mode
    - allowed TCP paths are limited to HTTP/TLS mediation, optional proxied SSH
      egress, and optional explicit host-mapped TCP rules
- Limited handling for unusual IP behaviors (e.g. fragmentation is not a
  target feature)

If your workload needs general networking, Gondolin's security properties will
not hold as designed; you would need a different architecture (and a different
threat model).

## Debugging

If networking is not behaving as expected, useful things to check first:

- Your allowlist patterns (especially wildcard scope)
- Whether internal-range blocking is preventing the destination
- Whether the protocol is actually HTTP/1.x or TLS with SNI (non-HTTP TLS
  traffic will be blocked)

`GONDOLIN_DEBUG=net` logs connection classification (`tcp blocked ...
(unknown-protocol)`, `connect-not-allowed`, ...), TLS server names, policy
decisions and upstream errors, as well as `console` output of tier-2 policies
(see [Debugging and Troubleshooting](./debug.md)).

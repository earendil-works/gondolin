# Network Stack

This document explains Gondolin's network design: what the guest VM sees, what
the host actually does with that traffic, and which security and policy
guarantees fall out of that design.

The main idea is:

- The guest gets a normal `eth0` interface.
- The host does **not** provide a generic NAT.
- Instead, the host terminates and mediates traffic in a **userspace network
  stack**, and only allows a narrow set of egress patterns (primarily HTTP and TLS
  that can be intercepted).

The guest should be treated as adversarial: the host is the enforcement point.

## Network Design Goals

- Constrain egress to intended destinations (host allowlist + internal-range blocking)
- Prevent arbitrary TCP tunneling (no generic "open socket to the internet")
- Make requests observable and programmable (hooks)
- Enable secret injection without delivering secret values into the guest

## High-Level Architecture

At a high level, the data path looks like this:

1. **Guest app** writes bytes to a socket.
2. Bytes become **Ethernet frames** emitted by the guest kernel via virtio-net.
3. QEMU forwards those frames to the host through a private transport.
4. The host parses frames into L2/L3/L4 and either:
    - services the traffic locally (e.g. DHCP replies),
    - relays it in a restricted way (DNS), or
    - bridges it into **host-side HTTP(S)** using an HTTP parser + TLS MITM.

Conceptually:

- The guest speaks "real networking" (Ethernet/IP/TCP/UDP).
- The host speaks "real networking" only for a narrow subset, and otherwise
  drops packets.

## Addressing and "LAN" Model

The guest is placed into a small private IPv4 subnet with a host-side "gateway":

- Gateway IP: `192.168.127.1`
- Guest IP: `192.168.127.3`
- Subnet: `/24` (`255.255.255.0`)

The host implements enough LAN behavior for a typical Linux userspace to work:

- ARP resolution for the gateway
- DHCP (so the guest can use standard `udhcpc`/dhclient flows)

This is a **virtual** LAN: it is not bridged to the real host network!

## Protocol Layers Implemented by the Host

The host implements a userspace network stack so it can inspect and control all
traffic:

- Ethernet framing and dispatch
- ARP (so the guest can discover the "gateway" MAC)
- IPv4 parsing and emission
- ICMP echo handling (ping)
- DHCP server (address assignment)
- TCP state machine (connection tracking and stream reassembly)
- UDP handling, but *restricted* (see DNS)

Important implication: Gondolin does not rely on "host firewall rules" for
correctness. The enforcement happens *before* any real host sockets are created.

## DNS Handling

DNS exists because it is useful for HTTP clients, but it is intentionally constrained.

### DNS Modes (behavior and effects)

- Only UDP destination port **53** is handled.
- The guest learns a DNS server via DHCP:
  - In `synthetic` / `trusted` mode, the DHCP server advertises the **gateway** (`192.168.127.1`) as the resolver (so the host can intercept DNS)
  - In `open` mode, the DHCP server advertises the host's non-loopback IPv4 resolvers (falling back to `8.8.8.8` if none are suitable)
- DNS behavior is configurable via a **DNS mode**:
  - `synthetic` (default)
    - No upstream DNS; the host replies directly with synthetic answers
    - Responses are only generated for normal-looking queries, and only for `A` / `AAAA` questions
    - This prevents using DNS as a network egress channel
  - `trusted`
    - The guest may send DNS queries to any destination IP, but the host forwards the query only to the host's trusted resolvers
    - Non-DNS payloads on UDP/53 are blocked (queries must parse as a standard DNS query)
    - Trusted upstream resolvers are currently **IPv4-only**; if none are available/configured, Gondolin fails fast
    - This prevents using UDP/53 as arbitrary UDP transport to arbitrary destination IPs, but it does **not** prevent classic DNS tunneling via real DNS semantics
  - `open`
    - UDP/53 is forwarded to the destination IP the guest targeted
    - Payloads are not validated as DNS, which enables DNS-like UDP tunneling

There is no goal of being a full-featured recursive resolver (for example, caching is not required for correctness).

### DNS Options (CLI and SDK)

**CLI** (`gondolin bash` / `gondolin exec`):

- `--dns MODE`
  - Sets the DNS mode: `synthetic` (default), `trusted`, or `open`
- `--dns-trusted-server IP`
  - Repeatable
  - Adds a trusted upstream DNS resolver (IPv4) for `--dns trusted`

**SDK** (`VM.create`):

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  dns: {
    mode: "synthetic", // "synthetic" | "trusted" | "open"

    // trustedServers: ["1.1.1.1"],

    // syntheticIPv4: "192.0.2.1",
    // syntheticIPv6: "2001:db8::1",
    // syntheticTtlSeconds: 60,
  },
});
```

- `dns.mode`
  - Selects `synthetic` / `trusted` / `open`
- `dns.trustedServers`
  - Upstream resolver IPv4 addresses for `trusted` mode
  - If omitted, Gondolin uses the host's configured DNS servers filtered to IPv4
  - In `trusted` mode, having *no* usable IPv4 resolvers is an error
- `dns.syntheticIPv4` / `dns.syntheticIPv6`
  - The IP addresses returned in synthetic `A` / `AAAA` answers (synthetic mode only)
  - Defaults: `192.0.2.1` and `2001:db8::1`
  - `localhost` and `*.localhost` are always answered as loopback (`127.0.0.1` / `::1`)
- `dns.syntheticTtlSeconds`
  - TTL for synthetic answers in `seconds` (synthetic mode only)
  - Default: `60`

### DNS and Policy

Even though DNS is available, policy decisions are **not** based on "what the
guest resolved."  Instead, HTTP policy is enforced by the host using host-side
resolution at the point a real upstream connection is made.

This matters for security because it prevents a class of attacks where the guest
tries to confuse policy via DNS tricks (e.g. DNS rebinding).

## TCP Stream Classification

For each outbound TCP flow, Gondolin inspects the beginning of the byte stream
and classifies it:

- **HTTP**: looks like an HTTP/1.x request line
- **TLS**: looks like a TLS ClientHello
- Anything else: **blocked**

This is the core mechanism that prevents arbitrary TCP tunneling.  The guest can
open TCP sockets, but only connections that quickly turn into HTTP or TLS will
be bridged.

Design notes:

- HTTP `CONNECT` is explicitly denied. This prevents using HTTP as a generic tunnel.
- Protocol classification is deliberately conservative.

## HTTP Bridging

For connections classified as HTTP:

1. The host parses the request line and headers.
2. The host applies the configured request hooks and policy checks.
3. The host performs the actual upstream request using a host HTTP client.
4. The host streams (or buffers, depending on hooks) the response back to the
   guest as an HTTP/1.x response.

The guest experiences this as "it made an HTTP request over TCP", but in reality
the guest never gets a raw upstream TCP tunnel.

## HTTPS via TLS MITM

For connections classified as TLS, Gondolin performs a controlled MITM:

1. The host reads the TLS ClientHello and extracts the intended server name (SNI).
2. The host presents a dynamically generated certificate for that name, signed by a local CA.
3. The guest establishes TLS to the host (believing it is the origin).
4. The host decrypts the HTTP request inside TLS and then repeats the same HTTP
   bridging pipeline as for plain HTTP.

### CA and Guest Trust

To make this work, the guest must trust the host-generated CA:

- Gondolin creates (and caches) a CA keypair on the host.
- The CA certificate is made available inside the guest so common TLS clients
  (curl, node, python, etc.) will accept MITM certificates.

## Policy Enforcement

Policy enforcement happens on the host and is designed to be robust against common evasion tricks.

### Allowlist by Hostname

A typical setup uses an allowlist of hostnames (often with `*` wildcards).
Requests to hosts not on the allowlist are denied.

### Blocking Internal Ranges

By default, Gondolin blocks connections to internal / local ranges (e.g.
loopback, RFC1918, link-local, metadata-style targets).  This prevents the guest
from reaching sensitive services on the host's LAN or cloud metadata endpoints.

### DNS Rebinding Protection

Policy is checked using host-side DNS resolution and is typically validated more than once:

- Once when evaluating the request target
- Again at the point where the underlying HTTP client resolves and connects

This closes the common "resolve to public IP at check-time, then to private IP
at connect-time" rebinding pattern.

### Redirect Handling

Redirects are handled by the host (not blindly followed by the guest's TCP
stack), and each redirect target is re-validated against policy.

## Hooks and Programmability

The network layer exposes hooks so you can:

- Enforce a stricter policy than "hostname allowlist" (paths, methods, headers)
- Rewrite requests (e.g. add/remove headers)
- Observe responses for auditing

A key design principle is that hooks run on the host **after** the traffic has
been parsed into structured HTTP requests, not on raw packets.

## Secret Injection

Secrets are handled as part of the HTTP mediation pipeline:

- The guest receives **placeholders** (random values) in its environment.
- When the guest sends an HTTP request, the host scans headers for placeholders.
- If the destination host is allowed for that secret, the host substitutes the
  real secret value into the outbound request.
- If not allowed, the request is blocked.

This design ensures real secret values never need to exist in the guest's
memory, environment, or filesystem.

## Buffering and Limits

To keep the system predictable and bound resource usage, the network layer
enforces size limits such as:

- Maximum request body size
- Maximum response body size (especially when response hooks need buffering)
- Limits for header parsing and internal queues

If you plan to transfer large payloads, design around these limits (e.g. avoid
large downloads through response hooks).

## Known Limitations

The network stack is intentionally *not* a general-purpose internet connection.
Common limitations include:

- No HTTP/3 or HTTP/2 (HTTP/1.x only)
- No WebSockets
- No HTTP `CONNECT`
- No generic UDP (DNS-only)
- No arbitrary TCP protocols
- Limited handling for unusual IP behaviors (e.g. fragmentation is not a target feature)

If your workload needs general networking, Gondolin's security properties will
not hold as designed; you would need a different architecture (and a different
threat model).

## Debugging

If networking is not behaving as expected, useful things to check first:

- Your allowlist patterns (especially wildcard scope)
- Whether internal-range blocking is preventing the destination
- Whether the protocol is actually HTTP/1.x or TLS with SNI (non-HTTP TLS traffic will be blocked)

Gondolin also includes debug logging for networking to help trace policy
decisions and connection classification.

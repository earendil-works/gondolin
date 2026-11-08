# Network Access

The guest VM has a normal `eth0` interface, but there is no NAT behind it.
Gondolin terminates the guest's traffic on the host and only lets a narrow set
of things through: HTTP and HTTPS requests (which it parses, checks against
your policy and then performs itself), DNS, and explicitly configured SSH and
TCP exceptions. This page covers what the guest can reach and how to change
that.

Restrict HTTP(S) egress to a few hosts:

```bash
gondolin bash --allow-host api.github.com --allow-host "*.npmjs.org"
```

```ts
import { VM, createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com", "*.npmjs.org"],
});

const vm = await VM.create({ httpHooks, env });
await vm.exec("curl -sS https://api.github.com/rate_limit");
```

For path, method or header rules and for rewriting requests and responses, see
[HTTP Hooks and Policies](./hooks.md). To give the guest API keys without
exposing them, see [Secrets](./secrets.md). How the network stack works
internally is described in [Network Stack](./network.md).

## What the Guest Can Reach by Default

With no network options at all:

| Traffic | Behaviour |
| --- | --- |
| HTTP/1.x and HTTPS (TLS) on any port | Mediated: the host parses the request and makes it itself; any public host is allowed, internal addresses are blocked |
| Other TCP (raw protocols, databases, SSH, HTTP `CONNECT`, ...) | Dropped |
| DNS (UDP port 53) | Answered by the host with synthetic addresses (see [DNS](#dns)) |
| Other UDP (QUIC/HTTP/3, NTP, ...) | Dropped |
| ICMP echo (`ping`) | Answered by the host for every address; nothing leaves the host |

Some consequences:

- **The host decides where a request goes.** For HTTP the target is the URL's
  host (the `Host` header), for HTTPS the TLS server name and `Host` header.
  The IP address the guest connected to and the answers the guest got from DNS
  are not used: the host resolves the name itself when it connects.
- **HTTPS is intercepted.** The host terminates TLS with a certificate signed
  by a local CA that the guest trusts (see [The MITM CA](#the-mitm-ca)) and
  makes its own TLS connection upstream, verifying the server's certificate
  (see [Upstream TLS Trust](#upstream-tls-trust)).
- **HTTP/1.1 only.** The guest negotiates HTTP/1.1; HTTP/2 and HTTP/3 are not
  available.
- **Internal ranges are blocked.** Loopback, RFC 1918 private networks,
  link-local (including cloud metadata endpoints such as `169.254.169.254`),
  carrier-grade NAT (`100.64.0.0/10`), `0.0.0.0/8`, IPv6 loopback, link-local
  and unique-local addresses, and IPv6 forms that embed such an IPv4 address
  (IPv4-mapped, NAT64, 6to4, Teredo) are refused, also when a public name
  resolves to them. See [Internal Hosts](#internal-hosts) to allow specific
  ones.
- A denied HTTP(S) request gets an HTTP error response (usually
  `403 Forbidden`); a denied raw TCP connection is reset.

## Allowing Hosts

`allowedHosts` (SDK) and `--allow-host` (CLI) restrict mediated HTTP(S) egress
to matching host names:

```bash
gondolin exec --allow-host api.github.com -- curl -sS https://api.github.com/rate_limit
gondolin bash --allow-host "*.github.com" --allow-host api.openai.com
```

```ts
const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com", "*.githubusercontent.com"],
});
const vm = await VM.create({ httpHooks, env });
```

Pattern rules:

- Patterns match the request's host name, case-insensitively; ports are not
  part of the pattern.
- `*` matches any host. Inside a pattern, `*` matches any substring, including
  dots and the empty string: `*.github.com` matches `api.github.com` and
  `a.b.github.com` but not `github.com`, and `*github.com` would also match
  `evilgithub.com`. List the apex domain separately if you need it.
- An IP-literal URL (`http://203.0.113.5/`) is matched as the string
  `203.0.113.5`.

Defaults:

- SDK: omitting `allowedHosts` allows every host; an explicit empty list
  (`allowedHosts: []`) denies all mediated HTTP(S).
- CLI: without `--allow-host` every public host is allowed.
- Internal ranges stay blocked in every case unless you allow them (next
  section).

**Secrets do not restrict egress.** `createHttpHooks({ secrets })` without
`allowedHosts`, or `--host-secret` without `--allow-host`, leaves every public
host reachable; a secret's hosts only control where its placeholder is
substituted. Always pair secrets with an allowlist:

```bash
gondolin bash --allow-host api.github.com --host-secret GITHUB_TOKEN@api.github.com
```

```ts
const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: { hosts: ["api.github.com"], value: process.env.GITHUB_TOKEN! },
  },
});
```

The allowlist is checked again for every redirect hop and for requests that a
hook rewrote. Per-secret host lists (`secrets.NAME.hosts`) only control where a
secret may be substituted and do not change the allowlist; see
[Secrets](./secrets.md#host-matching-and-allowlists).

## Internal Hosts

To reach a service on your LAN, a VPN or the host itself over mediated HTTP,
allow it by name with `allowedInternalHosts`:

```ts
const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.example.com"],
  allowedInternalHosts: ["litellm.corp.example", "*.svc.internal"],
});
```

- The patterns use the same syntax as `allowedHosts`.
- Matching hosts may resolve to internal addresses; every other host still may
  not.
- Hosts listed there are allowed even if they are not repeated in
  `allowedHosts`.

`blockInternalRanges: false` turns the internal-range block off for all
allowed hosts. Prefer `allowedInternalHosts`: with the block off, any allowed
name that resolves (or is made to resolve) to `127.0.0.1` or a metadata
address reaches it.

To reach `localhost` on the host, use the address the request should go to
upstream, for example `http://127.0.0.1:8080/` (allowed with
`allowedInternalHosts: ["127.0.0.1"]`). Inside the guest, `localhost` always
resolves to the guest itself.

A custom `isIpAllowed` callback without `createHttpHooks()` replaces the
built-in internal-range block entirely; with `createHttpHooks()` it can only
narrow what the declarative options allow. See
[HTTP Hooks and Policies](./hooks.md#isipallowed).

The CLI has no flag for internal hosts. Use [`--tcp-map`](#host-mapped-tcp)
for a specific local service, or a [`--hooks-script`](./hooks.md#tier-2-policies)
policy that defines `isIpAllowed` (without `--allow-host` and `--host-secret`,
its `isIpAllowed` replaces the internal-range block).

## DNS

DNS lookups work in the guest, but their answers do not decide where mediated
traffic goes. The DNS mode controls what the host does with UDP port 53:

| Mode | Behaviour |
| --- | --- |
| `synthetic` (default) | The host answers `A`/`AAAA` queries itself with synthetic addresses; nothing is forwarded upstream, so DNS cannot be used as an egress channel |
| `trusted` | Valid DNS queries (to any resolver IP) are forwarded only to the host's trusted resolvers; prevents arbitrary UDP to arbitrary IPs, but not DNS tunneling through real lookups |
| `open` | UDP/53 is forwarded to whatever IP the guest targeted, without validating the payload (allows UDP tunneling over port 53) |

Synthetic DNS is enough for HTTP(S): the guest connects to the synthetic
address and the host routes the request by name. Use `trusted` or `open` only
for software that needs real addresses (and keep in mind that the guest still
cannot connect to them outside of HTTP(S) and the configured exceptions).

```bash
gondolin bash --dns trusted --dns-trusted-server 1.1.1.1
```

```ts
const vm = await VM.create({
  dns: {
    mode: "synthetic", // "synthetic" | "trusted" | "open"
    // trustedServers: ["1.1.1.1"],     // trusted mode
    // syntheticIPv4: "192.0.2.1",
    // syntheticIPv6: "2001:db8::1",
    // syntheticTtlSeconds: 60,
    // syntheticHostMapping: "single",  // or "per-host"
  },
});
```

| Option (SDK / CLI) | Meaning |
| --- | --- |
| `dns.mode` / `--dns MODE` | `synthetic` (default), `trusted` or `open` |
| `dns.trustedServers` / `--dns-trusted-server IP` (repeatable) | upstream resolvers for `trusted` mode, IPv4 only; default: the host's IPv4 resolvers. VM creation fails when there is none |
| `dns.syntheticIPv4`, `dns.syntheticIPv6` | addresses in synthetic answers (default `192.0.2.1`, `2001:db8::1`) |
| `dns.syntheticTtlSeconds` | TTL of synthetic answers in `seconds` (default `60`) |
| `dns.syntheticHostMapping` / `--dns-synthetic-host-mapping MODE` | `single`: every name gets the same synthetic address; `per-host`: every name gets its own, so the host can tell which name a TCP connection was meant for |

Notes:

- `localhost` and `*.localhost` always resolve to loopback (`127.0.0.1` /
  `::1`) in synthetic mode.
- `per-host` mapping is required by [host-mapped TCP](#host-mapped-tcp) and
  [SSH egress](./ssh.md); it is selected automatically when `tcp.hosts` or
  `ssh.allowedHosts` are configured, and other DNS modes are rejected then.
- `--dns-trusted-server` requires `--dns trusted`, and
  `--dns-synthetic-host-mapping` requires synthetic mode.
- With a [remote daemon](./remote.md), `trusted` mode uses the configured
  servers or the daemon machine's `/etc/resolv.conf`, not your machine's
  resolvers. The static CLI also reads `/etc/resolv.conf`.

## Host-Mapped TCP

For non-HTTP protocols (for example a Postgres database during development)
you can map a guest host name, optionally with a port, to an explicit upstream
`HOST:PORT`:

```bash
gondolin bash --tcp-map pg.internal=127.0.0.1:5432
gondolin bash --tcp-map pg.internal:5432=db.example.com:5432
```

```ts
const vm = await VM.create({
  tcp: {
    hosts: {
      "pg.internal": "127.0.0.1:5432",      // any port
      "cache.internal:6379": "10.0.0.7:6379", // only port 6379
    },
  },
});
await vm.exec("psql -h pg.internal -U postgres -c 'select 1'");
```

Semantics:

- A key `HOST` matches every destination port for that name; `HOST:PORT`
  matches one port. When both exist, the port-specific rule wins.
- The value is always `UPSTREAM_HOST:UPSTREAM_PORT` (IPv6 hosts in brackets).
- Matching uses the synthetic DNS address the guest connected to, so the guest
  must look the name up through Gondolin's DNS. This needs synthetic DNS with
  `per-host` mapping, which `tcp.hosts` (and the CLI with `--tcp-map`) selects
  automatically; another DNS mode is an error.

Mapped connections are raw TCP tunnels to the configured target:

- No HTTP parsing, hooks or secret substitution.
- No allowlist or internal-range check: the mapping itself is the permission,
  which is why `127.0.0.1` works as a target.
- The upstream connection is opened by the Gondolin daemon (`gondolind`), so
  with a [remote daemon](./remote.md) `127.0.0.1` is the daemon's machine.

Use this as a narrow exception for specific services, not as a general network
mode.

## SSH Egress

Outbound SSH (for example `git clone git@github.com:...`) is off by default and
can be enabled for allowlisted hosts. It is proxied by the host, which
authenticates upstream with your ssh-agent or a configured key and only allows
non-interactive `exec` requests. See [SSH](./ssh.md) for the options.

## WebSockets

WebSocket upgrades (`Upgrade: websocket` over HTTP/1.1) are allowed by default.
The handshake request passes through the allowlist and the request hooks like
any other request; after the `101 Switching Protocols` response the connection
is an opaque tunnel, and the frames are not inspected.

Disable them for egress with:

```bash
gondolin bash --disable-websockets
```

```ts
const vm = await VM.create({ allowWebSockets: false });
// or VM.create({ sandbox: { allowWebSockets: false } })
```

`--disable-websockets` also disables WebSockets on the ingress gateway of
`gondolin bash --listen`; in the SDK, ingress has its own option (see
[Ingress](./ingress.md)).

## Body Size Limits

| Option | Default | Applies to |
| --- | --- | --- |
| `maxHttpBodyBytes` | 64 MiB | request bodies the guest sends (larger requests get `413 Payload Too Large`) |
| `maxHttpResponseBodyBytes` | 64 MiB | response bodies that are buffered: when an `onResponse` hook reads the body, and bodies of responses returned by hooks (larger ones end in `502 Bad Gateway`) |

```ts
const vm = await VM.create({
  maxHttpBodyBytes: 16 * 1024 * 1024,
  maxHttpResponseBodyBytes: 256 * 1024 * 1024,
});
```

Responses that no hook reads are streamed to the guest and are not limited, so
large downloads work as long as response hooks leave the body alone.

## Redirects

The host follows redirects (`301`, `302`, `303`, `307`, `308`) itself; the guest
only sees the final response. Every hop is checked against the allowlist, the
internal-range block and the request hooks again, so a redirect cannot leave
the policy.

- At most 10 redirects are followed; more end in `508 Loop Detected`.
- `303`, and `301`/`302` after a `POST`, turn the request into a `GET` without
  body.
- Cross-origin hops drop the `Authorization` and `Cookie` headers.
- `307`/`308` replay the request body. Streamed bodies (chunked uploads) are
  only replayable up to 1 MiB; beyond that the redirect fails with `502`.

## Upstream TLS Trust

The host verifies the certificates of upstream HTTPS servers:

- **SDK and Node.js CLI:** against your Node.js process's default CA store,
  that is, Node's bundled Mozilla roots plus `NODE_EXTRA_CA_CERTS` (and the
  operating system's store when Node runs with `--use-system-ca`). This also
  holds for [remote daemons](./remote.md): the store is sent along.
- **Static `gondolin` CLI:** against the Mozilla roots plus the system's PEM
  roots (`SSL_CERT_FILE` / `SSL_CERT_DIR` replace them, the distribution bundle
  on Linux, `/etc/ssl/cert.pem` on macOS), and `NODE_EXTRA_CA_CERTS`.

Neither reads the macOS keychain by default. A root installed only there (for
example the CA of a corporate TLS proxy) has to be exported:

```bash
security find-certificate -a -p -c "My Corp CA" > ca.pem
export NODE_EXTRA_CA_CERTS="$PWD/ca.pem"
```

## The MITM CA

To intercept HTTPS, Gondolin signs per-host certificates with a local CA:

- The CA is created on first use and cached in `~/.cache/gondolin/ssl`
  (`$XDG_CACHE_HOME/gondolin/ssl` when set). Override the directory with
  `sandbox.mitmCertDir` or `GONDOLIN_MITM_CERT_DIR` (also honoured by both
  CLIs), for example a temporary directory for a per-run CA.
- A [remote daemon](./remote.md) uses its own CA, cached on its machine; the
  guest is given that certificate instead.
- The CA certificate is mounted into the guest at `/etc/gondolin/mitm/ca.crt`.
  The guest's init installs it with `update-ca-certificates` where possible,
  writes a merged bundle to `/run/gondolin/ca-certificates.crt`, and exports
  `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE` (the merged bundle)
  and `NODE_EXTRA_CA_CERTS` (the CA), so curl, OpenSSL-based tools, Python and
  Node.js accept the intercepted connections.

Gotchas:

- Tools that bring their own CA list or pin certificates need to be pointed at
  `/run/gondolin/ca-certificates.crt` (or fail).
- The CA mount needs Gondolin's `/etc/gondolin` mount: with `vfs: null`, or a
  custom mount over `/etc/gondolin`, the guest does not get the CA and HTTPS
  verification fails in the guest.
- The CA private key can sign certificates every guest trusts; treat it as
  sensitive (see [Security Design](./security.md#tls-mitm-ca-handling)).

## No Upstream HTTP Proxy

Upstream requests are made directly from the machine the daemon runs on.
`HTTP_PROXY` / `HTTPS_PROXY` are not supported, and there is no pluggable
upstream HTTP client. To send selected requests elsewhere, rewrite them in an
`onRequest` hook (or return your own `Response` from it); see
[HTTP Hooks and Policies](./hooks.md).

## Disabling Networking

`sandbox.netEnabled: false` starts the VM without a network device:

```ts
const vm = await VM.create({ sandbox: { netEnabled: false } });
```

The guest then has no `eth0`, the MITM CA is not mounted, and network options
(`httpHooks`, `dns`, `tcp`, `ssh`) have no effect. [Ingress](./ingress.md) and
[`vm.enableSsh()`](./ssh.md) do not use the guest network and keep working.
To keep the interface but deny all mediated HTTP(S), use
`createHttpHooks({ allowedHosts: [] })` instead.

## Debugging

`GONDOLIN_DEBUG=net` logs connection classification, policy decisions and
upstream errors (see [Debugging and Troubleshooting](./debug.md)). Common
causes of blocked traffic:

- An allowlist pattern that does not cover the apex domain (`*.example.com`
  vs. `example.com`).
- The destination resolves to an internal address.
- The client speaks something other than HTTP/1.x or TLS (for example HTTP/3
  over UDP, or a raw protocol that needs [`--tcp-map`](#host-mapped-tcp)).
- The client uses an HTTP proxy via `CONNECT` (unset `HTTPS_PROXY` in the
  guest).

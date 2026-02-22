# SDK: Network Access

See also: [SDK Overview](./sdk.md), [Network Stack](./network.md), [Ingress](./ingress.md), [SSH](./ssh.md)

## Network Policy

The network stack only allows HTTP and TLS traffic. TCP flows are classified and
non-HTTP traffic is dropped. Requests are intercepted and replayed via `fetch`
on the host side, enabling:

- Host allowlists with wildcard support
- Request/response hooks for logging and modification
- Secret injection without exposing credentials to the guest
- DNS rebinding protection

```ts
import { createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.example.com", "*.github.com"],
  secrets: {
    API_KEY: { hosts: ["api.example.com"], value: process.env.API_KEY! },
  },
  blockInternalRanges: true, // default: true
  isRequestAllowed: (req) => req.method !== "DELETE",
  isIpAllowed: ({ ip }) => !ip.startsWith("203.0.113."),
  onRequestHead: async (req) => {
    console.log(req.url);
    return req;
  },
  onResponse: async (res, req) => {
    console.log(req.url, res.status);
    return res;
  },
});
```

Egress hook behavior:

- `onRequestHead(request)` receives a WHATWG `Request` with no body
    - return `undefined` to keep it unchanged
    - return a `Request` to continue with rewrites
    - return a `Response` to short-circuit upstream fetch
- `onRequest(request)` receives a WHATWG `Request` (buffered body path)
    - return `undefined` to keep it unchanged
    - return a `Request` to continue with rewrites, or a `Response` to short-circuit
    - request bodies are one-shot streams; if you read the body and still forward, use `request.clone()` or return a new `Request`
- `onResponse(response, request)` receives WHATWG `Response` + final `Request`
    - return `undefined` to keep it unchanged
    - return a `Response` to rewrite

Important note: secrets maybe be expanded prior to `onRequestHead` and
`onRequest` is invoked.  This means that if you use those functions for logging
this may include secrets.

Short-circuited responses skip upstream fetch (including DNS/IP policy checks) and do not call `onResponse`.

Notable consequences:

- Secret placeholders are substituted in request headers by default (including Basic auth token decoding/re-encoding)
    - For full behavior, caveats, and best practices, see [Secrets Handling](./secrets.md)
- ICMP echo requests in the guest "work", but are synthetic (you can ping any address)
- HTTP redirects are resolved on the host and hidden from the guest (the guest only sees the final response), so redirects cannot escape the allowlist
- WebSockets are supported via HTTP/1.1 Upgrade, but after the `101` response the connection becomes an opaque tunnel (only the request handshake is hookable)
    - Disable egress WebSockets via `VM.create({ allowWebSockets: false })` (or `sandbox.allowWebSockets: false`)
    - Disable ingress WebSockets via `vm.enableIngress({ allowWebSockets: false })`
- DNS is available in multiple modes:
    - `synthetic` (default): no upstream DNS, returns synthetic answers
    - `trusted`: forwards queries only to trusted host resolvers
      This prevents using UDP/53 as arbitrary UDP transport to arbitrary destination IPs

      Note: trusted upstream resolvers are currently **IPv4-only**; if none are configured/found, VM creation fails

    - `open`: forwards UDP/53 to the destination IP the guest targeted

- Even though the guest does DNS resolutions, they're largely disregarded for
  policy; the host enforces policy against the HTTP `Host` header and does its own
  resolution to prevent DNS rebinding attacks

For deeper conceptual background, see [Network stack](./network.md).

## `vm.enableIngress()`

You can expose HTTP servers running inside the guest VM to the host machine.
This feature is called "ingress" internally.

When you call `vm.enableIngress()`:

- the host starts a local HTTP gateway (default: `127.0.0.1:<ephemeral>`)
- requests are routed based on `/etc/gondolin/listeners` inside the guest

Ingress requires the default `/etc/gondolin` mount. If you disable VFS entirely
(`vfs: null`) or override `/etc/gondolin` with a custom mount, `enableIngress()`
will fail.

Minimal example:

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create();

const ingress = await vm.enableIngress({
  listenHost: "127.0.0.1",
  listenPort: 0, // 0 picks an ephemeral port
});

console.log("Ingress:", ingress.url);

// Route all requests to the guest server on port 8000
vm.setIngressRoutes([{ prefix: "/", port: 8000, stripPrefix: true }]);

// Start a server inside the guest
// NOTE: the guest currently executes one command at a time; a long-running
// vm.exec() (like a server) will block additional exec requests.
const server = vm.exec(["/bin/sh", "-lc", "python -m http.server 8000"], {
  buffer: false,
  stdout: "inherit",
  stderr: "inherit",
});

// Now you can reach the guest service from the host at ingress.url
// ...

await ingress.close();
await vm.close();
```

### Ingress Hooks

`enableIngress()` can install **host-side hook points** on the ingress gateway.
This is useful for:

- allow/deny decisions based on client IP / path / route
- rewriting upstream target paths (or headers)
- adding/removing response headers
- optionally buffering responses so you can rewrite bodies

Hooks are configured via `enableIngress({ hooks: ... })`:

- `hooks.isAllowed(info) -> boolean`: return `false` to deny (default response: `403 forbidden`)
    - for a custom deny response, throw `new IngressRequestBlockedError(...)`
- `hooks.onRequest(request) -> patch`: rewrite headers and/or upstream target
    - can also enable per-request response buffering via `bufferResponseBody: true`
- `hooks.onResponse(response, request) -> patch`: rewrite status/headers and optionally replace the body

Streaming vs buffering:

- by default, responses are streamed directly (no buffering)
- if you enable buffering (either globally via `enableIngress({ bufferResponseBody: true })` or per-request via `onRequest()`), the full upstream response body is buffered before `onResponse()` runs and provided as `response.body`

Header patch semantics:

- set a header to a `string`/`string[]` to set/overwrite it
- set a header to `null` to delete it

Example:

```ts
import { IngressRequestBlockedError, VM } from "@earendil-works/gondolin";

const vm = await VM.create();

await vm.enableIngress({
  hooks: {
    isAllowed: ({ clientIp, path }) => {
      if (path.startsWith("/admin")) {
        throw new IngressRequestBlockedError(
          `admin blocked for ${clientIp}`,
          403,
          "Forbidden",
          "nope\n",
        );
      }
      return true;
    },

    onRequest: (req) => ({
      // Rewrite /api/* -> /* inside the guest
      backendTarget: req.backendTarget.startsWith("/api/")
        ? req.backendTarget.slice(4)
        : req.backendTarget,
      headers: { "x-added": "1", "x-remove": null },

      // Only buffer responses we plan to inspect/modify
      bufferResponseBody: req.backendTarget.endsWith(".json"),
      maxBufferedResponseBodyBytes: 8 * 1024 * 1024,
    }),

    onResponse: (res) => ({
      headers: { "x-ingress": "1" },
      body: res.body
        ? Buffer.from(res.body.toString("utf8").toUpperCase())
        : undefined,
    }),
  },
});
```

You can read or replace the current routing table programmatically:

- `vm.getIngressRoutes()`
- `vm.setIngressRoutes(routes)`

See also: [Ingress](./ingress.md).

## `vm.enableSsh()`

For workflows that prefer SSH tooling (scp/rsync/ssh port forwards), you can
start an `sshd` inside the guest and expose it via a host-local TCP forwarder:

```ts
const access = await vm.enableSsh();
console.log(access.command); // ready-to-run ssh command

// ...
await access.close();
```

See also: [SSH access](./ssh.md).

## SSH Egress

You can optionally allow outbound SSH (default port `22`, with non-standard ports enabled by allowlisting `HOST:PORT`) from the guest to an allowlist.
This is useful for git-over-SSH (e.g. cloning private repos) without granting the
guest arbitrary TCP access.

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

    // Optional safety knobs:
    // maxUpstreamConnectionsPerTcpSession: 4,
    // maxUpstreamConnectionsTotal: 64,
    // upstreamReadyTimeoutMs: 15_000,
  },
});
```

Notes:

- SSH egress is proxied by the host and intentionally limited to non-interactive
  `exec` usage (no shells, no subsystems like `sftp`)
- SSH egress is not necessary to attach to a VM, that can also happen with `gondolin attach`.
- See: [SSH](./ssh.md) and [Network stack](./network.md)

# Ingress

Ingress exposes HTTP servers running inside the VM to the host: a gateway on a
host port forwards each request to a server on the guest's loopback interface,
according to a routing table the guest (or your program) controls.

```bash
gondolin bash --listen
```

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create();
const ingress = await vm.enableIngress(); // http://127.0.0.1:<ephemeral>
vm.setIngressRoutes([{ prefix: "/", port: 8000, stripPrefix: true }]);
```

This is intentionally not a generic port forward. It only speaks HTTP, so the
host keeps control over what the sandbox exposes and can inspect, rewrite or
deny every request with [hooks](#ingress-hooks).

How it works:

1. A small guest helper (`sandboxingress`) opens TCP connections to guest
   loopback (`127.0.0.1`).
2. A host-side HTTP gateway listens on a host port.
3. Each incoming request is routed to a guest-local HTTP server based on the
   routing table in `/etc/gondolin/listeners`.

## CLI Usage

Start an interactive VM shell with ingress enabled:

```bash
gondolin bash --listen
```

This prints something like:

```
Ingress enabled: http://127.0.0.1:58650
Configure routes by editing /etc/gondolin/listeners inside the VM.
```

By default, the gateway binds to `127.0.0.1` on an ephemeral port. `--listen`
works the same in the [static CLI](./cli.md#static-cli-no-nodejs).

To bind a specific host interface and port:

```bash
# HOST:PORT
gondolin bash --listen 127.0.0.1:8008

# :PORT or PORT (host defaults to 127.0.0.1)
gondolin bash --listen :8008
gondolin bash --listen 8008

# IPv6 hosts in brackets
gondolin bash --listen '[::1]:8008'

# PORT=0 picks an ephemeral port
gondolin bash --listen 127.0.0.1:0
```

`--disable-websockets` turns off WebSocket upgrades through the gateway (and
for guest egress). See the [CLI reference](./cli.md#gondolin-bash) for the
other `bash` options.

### Quick Start Example

Inside the VM, configure a route:

```sh
echo '/ :8000' > /etc/gondolin/listeners
```

And then start a server:

```sh
python3 -m http.server 8000
```

Now from the host:

```bash
curl -v http://127.0.0.1:58650/
```

## SDK Usage

`vm.enableIngress()` starts the VM if it is not running yet, starts the host
gateway and returns an `IngressAccess`:

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

// Start a server inside the guest (it keeps running while other
// vm.exec() calls run)
const server = vm.exec(["/bin/sh", "-lc", "python3 -m http.server 8000"], {
  buffer: false,
  stdout: "inherit",
  stderr: "inherit",
});

// Now you can reach the guest service from the host at ingress.url
// ...

await ingress.close();
await vm.close();
```

There is one gateway per VM: calling `enableIngress()` again returns the
first `IngressAccess` (the new options are ignored), and `vm.close()` stops
it. `IngressAccess` has:

- `host`, `port`: where the gateway listens
- `url`: `http://HOST:PORT`
- `close()`: stops the gateway

### `enableIngress()` Options

| Option | Default | Meaning |
| --- | --- | --- |
| `listenHost` | `127.0.0.1` | host interface to bind |
| `listenPort` | `0` | host port to bind (`0` = ephemeral) |
| `allowWebSockets` | `true` | allow WebSocket upgrades |
| `hooks` | none | [ingress hooks](#ingress-hooks) |
| `bufferResponseBody` | `false` | buffer full upstream responses before `onResponse` runs |
| `maxBufferedResponseBodyBytes` | 2 MiB | largest buffered response body in `bytes` |
| `upstreamHeaderTimeoutMs` | `2000` | timeout waiting for the guest server's response headers in `ms` |
| `upstreamResponseTimeoutMs` | `15000` | timeout between response body chunks in `ms` |

### Routes from the SDK

You can read or replace the routing table programmatically:

- `vm.getIngressRoutes()` returns the current routes (parsed from
  `/etc/gondolin/listeners`; `[]` when the mount is not available)
- `vm.setIngressRoutes(routes)` replaces them and writes the canonical file
  back into the guest

A route is `{ prefix, port, stripPrefix }` (an `IngressRoute`): `prefix` must
not be empty or contain whitespace, `port` is the guest loopback port
(1–65535), and `stripPrefix` defaults to `true`. Invalid routes throw.

## Routing Table

The file `/etc/gondolin/listeners` is the authoritative ingress configuration.
The host gateway watches it and reloads routes shortly after it changes. If an
edit does not parse (or the file grows beyond 64 KiB), the previous routes stay
in effect.

Gondolin may rewrite the file into a canonical form (normalized prefixes, a
trailing newline, and consistent formatting). Unknown `key=value` options are
ignored for forward compatibility.

This file is provided by the host via a dedicated `/etc/gondolin` mount, so the
configuration is per-VM and does not persist after the VM is closed and is
also not snapshotted.

Each non-empty, non-comment line has the form:

```
<prefix> :<port> [key=value ...]
```

- `prefix` is a URL path prefix and must start with `/`.
- `:<port>` is the guest loopback port to connect to.
- `#` starts a comment (everything after `#` is ignored).

Example:

```text
# Send everything to the server on port 8000
/ :8000

# Route /api/* to port 9000, and strip the /api prefix
/api :9000
```

### Prefix Matching

If multiple routes match, the longest matching prefix wins.

For example:

```text
/     :8000
/api  :9000
```

- `/api/users` goes to `:9000`
- `/about` goes to `:8000`

### Strip Prefix

By default, the prefix is stripped before the request is forwarded.

Example route:

```text
/api :9000
```

- Host request `GET /api/users` becomes guest request `GET /users`.

To disable rewriting (`strip_prefix` accepts `true` or `false`):

```text
/api :9000 strip_prefix=false
```

### Forwarded Headers

The gateway adds `X-Forwarded-For` (appending the client IP),
`X-Forwarded-Host`, `X-Forwarded-Proto: http`, and, when a non-root prefix is
stripped, `X-Forwarded-Prefix` to each upstream request.

## Ingress Hooks

`enableIngress({ hooks })` installs host-side hook points on the gateway. Use
them to:

- allow or deny requests based on client IP, path or route
- rewrite the upstream target path, method or headers
- add or remove response headers
- optionally buffer responses so you can rewrite bodies

The hooks:

- `isAllowed(info) -> boolean`: return `false` to deny (default response:
  `403 Forbidden`, body `forbidden`). `info` has `clientIp`, `method`, `path`
  (including the query), `headers` (lowercased) and the matched `route`.
- `onRequest(request) -> patch | undefined`: `request` has `clientIp`,
  `method`, `path`, `route`, `backendHost`, `backendPort`, `backendTarget`
  (path and query sent to the guest) and `headers`. The patch may set
  `method`, `backendPort`, `backendTarget`, `headers`, and per request
  `bufferResponseBody` / `maxBufferedResponseBodyBytes`. `backendHost` may
  only be `127.0.0.1` or `localhost`.
- `onResponse(response, request) -> patch | undefined`: `response` has
  `statusCode`, `statusMessage`, `headers` and, when buffered, `body` (a
  `Buffer`). The patch may set `statusCode`, `statusMessage`, `headers` and a
  replacement `body`.

All hooks may be async. For a custom deny response from any hook, throw
`new IngressRequestBlockedError(message, statusCode, statusMessage, body)`
(defaults: `403`, `"Forbidden"`, `"forbidden\n"`). Any other error answers
`502 Bad Gateway`.

Streaming vs buffering:

- by default, responses are streamed directly (no buffering)
- if you enable buffering (globally via `enableIngress({ bufferResponseBody:
  true })` or per request from `onRequest()`) and an `onResponse` hook is
  installed, the full upstream response body is buffered before
  `onResponse()` runs and provided as `response.body`; a body larger than
  `maxBufferedResponseBodyBytes` fails the request with `502`
- a replacement `body` is sent with a fixed `Content-Length`

Header patch semantics:

- set a header to a `string`/`string[]` to set or overwrite it
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

## Behavior and Limitations

- The gateway only speaks HTTP (HTTP/1.1 on the host side).
- WebSocket upgrades are supported by default. The handshake goes through the
  hooks, but after the `101` response the gateway tunnels bytes. Disable them
  with `enableIngress({ allowWebSockets: false })` or `--disable-websockets`
  (upgrade requests then get `501`).
- Each inbound request is forwarded over a fresh guest loopback TCP
  connection. The gateway sets `Connection: close`.
- The guest backend must be reachable on `127.0.0.1:<port>`. Most servers
  binding to `0.0.0.0:<port>` will also accept loopback.
- Ingress requires the default `/etc/gondolin` mount. If you disable VFS
  entirely (`vfs: null`) or override `/etc/gondolin` with your own mount,
  `enableIngress()` fails.
- With a [remote daemon](./remote.md) the gateway still listens on your
  machine; the streams are tunneled through the daemon connection.

## Debugging

- `404` (`no route`) means no route in `/etc/gondolin/listeners` matched.
- `502` means the gateway could not connect to the guest backend, the backend
  closed the connection before sending a response, it timed out, or a hook
  failed.

With any `GONDOLIN_DEBUG` value set, the gateway prints the underlying error
of a `502` to stderr (`ingress bad gateway: ...`); `protocol` also traces the
guest streams:

```bash
GONDOLIN_DEBUG=protocol gondolin bash --listen
```

See [Debugging and Troubleshooting](./debug.md).

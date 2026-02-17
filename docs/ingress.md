# Ingress and Listening

Gondolin can expose HTTP servers running inside the guest VM to the host machine.

This feature is called "ingress" internally. It works by:

1. Starting a small guest helper (`sandboxingress`) that can open TCP connections
   to guest loopback (`127.0.0.1`).
2. Starting a host-side HTTP gateway that listens on a host port.
3. Routing each incoming host HTTP request to a guest-local HTTP server based on
   a routing table in `/etc/gondolin/listeners`.

This is intentionally not a generic port forward.  It is designed specifically
for HTTP services with the intention to allow the host greater control over
what the sandbox is exposing.

## CLI Usage

Start an interactive VM shell and enable ingress:

```bash
gondolin bash --listen
```

This prints something like:

```
Ingress enabled: http://127.0.0.1:58650
Configure routes by editing /etc/gondolin/listeners inside the VM.
```

By default, the gateway binds to `127.0.0.1` on an ephemeral port.

To bind a specific host interface and port:

```bash
# HOST:PORT
gondolin bash --listen 127.0.0.1:8008

# :PORT (defaults to 127.0.0.1)
gondolin bash --listen :8008

# PORT=0 picks an ephemeral port
gondolin bash --listen 127.0.0.1:0
```

## Quick Start Example

Inside the VM configure a route (inside the VM):

```sh
echo '/ :8000' > /etc/gondolin/listeners
```

And then start a server:

```sh
python -m http.server 8000
```

Now from the host:

```bash
curl -v http://127.0.0.1:58650/
```

## Routing Table

The file `/etc/gondolin/listeners` is the authoritative ingress configuration.
The host gateway watches it and reloads routes shortly after it changes.

Gondolin may rewrite the file into a canonical form (normalized prefixes, a
trailing newline, and consistent formatting).  Unknown `key=value` options are
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

To disable rewriting:

```text
/api :9000 strip_prefix=false
```

## Behavior And Limitations

- The gateway only speaks HTTP (HTTP/1.1 on the host side).
- WebSocket upgrades are supported by default, but after the `101` response the gateway tunnels bytes (only the handshake is hookable). Disable via `enableIngress({ allowWebSockets: false })` or `--disable-websockets`.
- Each inbound request is forwarded over a fresh guest loopback TCP connection.
  The gateway sets `Connection: close`.
- The guest backend must be reachable on `127.0.0.1:<port>`.
  Most servers binding to `0.0.0.0:<port>` will also accept loopback.
- Ingress requires the default `/etc/gondolin` mount.
  Do not override `/etc/gondolin` with your own VFS mount.

## Debugging

If requests hang or return `404`/`502`, enable protocol debug logging on the host:

- `404` usually means no route matched `/etc/gondolin/listeners`.
- `502` usually means the gateway could not connect to the guest backend or the
  backend closed the connection before sending a response.

```bash
GONDOLIN_DEBUG=protocol gondolin bash --listen
```

## SDK Usage

You can also enable ingress via the TypeScript SDK. See: [SDK Networking, Ingress, and SSH](./sdk-network.md).

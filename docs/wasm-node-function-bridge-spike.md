# WASM Node function-bridge spike

## Goal

Validate a **Node-first WASM path** that keeps Gondolin on the same control-plane framing as `qemu` / `krun`, without stdio framing hacks.

## Why this spike

The previous `wasm` branch proved feasibility, but it also showed pain points:

- runtime focus drifted to `wasmtime` instead of Node
- stdio transport required bootstrap/sync workarounds
- PTY behavior became fragile because control traffic and process stdio shared the same stream semantics

## What this spike changes

This spike adds transport plumbing that can be reused by all backends, including a future Node WASM backend:

1. `ServerTransport` interface in `host/src/sandbox/server-transport.ts`
2. `UnixSocketTransport` for current virtio socket behavior
3. `StreamTransport` for stream-backed channels
4. `FunctionBridgeTransport` for callback/import-based runtime bridges
5. `SandboxServer` transport injection (`transportFactory`) so core server logic can run on any transport without forking exec/file/flow-control logic

No qemu/krun behavior is changed by default.

## Follow-up: runner harness spike

This follow-up adds an explicit Node-side bridge runner skeleton and wires it into an experimental backend path:

- `host/src/sandbox/wasm-function-bridge-runner.ts`
  - starts a dedicated Node child with IPC only for control frames
  - exposes `createControlTransport()` backed by `FunctionBridgeTransport`
- `host/src/sandbox/wasm-function-bridge-runner-entry.ts`
  - harness-mode guest loop that consumes framed requests and emits framed responses
  - demonstrates `exec_request`, `stdin_data`, `pty_resize`, and `exec_response` flow over function bridge callbacks
- `host/src/sandbox/wasm-function-bridge-controller.ts`
  - controller shim that maps runner lifecycle to sandbox controller state/events
- `host/src/sandbox/server.ts`
  - `vmm=wasm-node` wiring for control channel via `FunctionBridgeTransport`
  - fs/ssh/ingress channels now also route through channelized function-bridge transports
- `host/test/wasm-function-bridge-runner.test.ts`
  - round-trip PTY exec test using the harness runner
- `host/test/wasm-node-sandbox-spike.test.ts`
  - sandbox-level smoke for `vmm=wasm-node` exec over function bridge harness

This is intentionally a harness and not yet the final WASI sandboxd adapter, but it removes stdio control coupling and validates the runner protocol surface we need for the real Node WASM runtime path.

## PTY-specific coverage in this spike

`host/test/server-transport.test.ts` includes a PTY-focused frame round-trip using `FunctionBridgeTransport`:

- host sends `exec_request` with `pty: true`
- host sends `pty_resize`
- guest-side harness receives both via regular framed protocol
- guest sends `exec_output` + `exec_response` back over the same bridge

This is intentionally protocol-level: it validates PTY control-message path without stdio envelope coupling.

## Try it locally

Harness mode (default when no wasm path is configured):

```bash
node host/bin/gondolin.ts bash --vmm wasm-node
```

Real wasm module mode (stdio adapter behind function-bridge transport):

```bash
GONDOLIN_WASM_PATH=/absolute/path/to/sandbox.wasm \
node host/bin/gondolin.ts bash --vmm wasm-node
```

## Run the spike tests

```bash
cd host
node --test \
  test/server-transport.test.ts \
  test/wasm-function-bridge-runner.test.ts \
  test/wasm-node-sandbox-spike.test.ts
```

## Next step to turn this into a real Node WASM backend

1. Build a Node WASM runner that exposes explicit imports/host functions, e.g.
   - `gondolin_bridge_send(ptr, len)`
   - `gondolin_bridge_recv(ptr, max_len)`
   - `gondolin_bridge_poll(timeout_ms)`
2. Keep guest framing identical to existing virtio message protocol
3. Route runner bridge callbacks through `FunctionBridgeTransport`
4. Add a bash PTY smoke test for wasm backend parity:
   - `vm.exec("bash", { pty: true, stdin: true })`
   - send `echo __gondolin_ok__` over stdin
   - assert prompt + echo output + clean exit
   - assert resize (`pty_resize`) is observed and applied
5. Keep unsupported areas explicit behind capability gates instead of creating parallel server/VM semantics

## VFS write-up (parity plan)

### Current state

- `vmm=wasm-node` now routes control/fs/ssh/ingress through channelized function bridge transports
- hostfs-backed mounts (`RealFSProvider`, including readonly wrappers) are now mapped directly via WASI preopens
- full fs mount parity for custom virtual providers still depends on guest-side `sandboxfs` availability and mount wiring
- `VM.ensureVfsReady()` skips mount-waiting on `wasm-node` and only materializes MITM CA trust when available
- backend capability remains `vfsMounts=false` until full provider parity is validated

### Design principle

Keep the host control plane unchanged:

- same frame format (`virtio-protocol` framing)
- same fs RPC message schema
- same backpressure and queue semantics

In other words: bridge the transport, not the protocol.

### Plan

1. **Promote runner IPC to multi-channel framing**
   - add logical channel id/name (`control`, `fs`, `ssh`, `ingress`)
   - continue using the same framed payload bytes per channel
2. **Keep fs on channelized `FunctionBridgeTransport` and complete guest adapter**
   - `SandboxServer` keeps existing `fsBridge` flow unchanged
3. **Guest-side fs adapter for wasm runtime**
   - provide a wasm-side endpoint that speaks the existing `fs_request`/`fs_response` messages
   - keep mount readiness signal contract (`vfs_ready`/error semantics)
4. **Flip capability gates once parity tests pass**
   - set `vfsMounts=true` for wasm-node only when validated
   - remove wasm-only VFS readiness bypass in `VM.ensureVfsReady()`

### VFS acceptance checks

- hostfs mount smoke (`--mount-hostfs ...:/workspace`) shows real guest-visible directory contents on `wasm-node`
- readonly hostfs mounts reject guest writes
- no wasm-specific file protocol branch introduced in `SandboxServer`

## Networking write-up (parity plan)

### Current state

- network backend is now enabled for `wasm-node` and wired through the same DHCP/DNS/HTTP/TLS mediation stack
- TCP forward channels (`openTcpStream`, `openIngressStream`) remain capability-gated off
- `ssh` / `ingress` bridge channels are transported via the function bridge and ready for guest-side forwarding hooks

### Design principle

Split networking parity into two layers:

1. **Virtio-serial tcp-forward parity** (`virtio-ssh`, `virtio-ingress` equivalents)
2. **Guest egress mediation parity** (HTTP/TLS hooks, DNS policy, secret injection)

Both should reuse existing host logic and protocol contracts.

### Plan A: tcp-forward channel parity (host↔guest loopback)

1. Use the same multi-channel bridge shape as VFS (`ssh`, `ingress`)
2. Wire `SandboxServer` `sshBridge` / `ingressBridge` to function bridge transports
3. Ensure guest forwarders speak unchanged `tcp_open`/`tcp_data`/`tcp_closed`/`tcp_opened`
4. Enable `tcpForwardChannels` capability only after parity tests pass

This unlocks `enableSsh()` and ingress loopback paths without inventing wasm-only APIs.

### Plan B: egress mediation parity (internet access)

1. Introduce a runtime-agnostic guest network ingress/egress abstraction on host
   - current QEMU socket backend becomes one implementation
   - wasm runtime frame source/sink becomes another
2. Keep existing policy stack unchanged
   - DNS modes
   - HTTP/TLS mediation
   - request/response hooks
   - secret placeholder substitution
3. Add explicit gating for unsupported modes until fully wired

### Networking acceptance checks

- backend parity network hook smoke test passes on `wasm-node`
- ingress parity smoke (`GONDOLIN_BACKEND_PARITY_INGRESS=1`) passes on `wasm-node`
- no policy divergence in allowlist/DNS/secret handling between backends

## Why this bridge scales

If we keep transport as the only backend-specific layer, the function bridge is
generic enough to carry any virtio-equivalent channel in code:

- control
- fs
- ssh
- ingress
- (optionally) network frame ingress/egress

That preserves a single host protocol and avoids wasm-specific control-plane forks.

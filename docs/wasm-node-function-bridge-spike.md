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
  - non-control channels use no-op transports in this spike
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

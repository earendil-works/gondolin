# djs-hooks (throwaway prototype)

Prototype for M6: djs as gondolind's tier-2 hook engine. The findings are in
[`native/docs/djs-hooks.md`](../../docs/djs-hooks.md).

This crate is **not** part of the native workspace. It has its own `[workspace]`
table, so `make -C native check` never builds it. It path-depends on a djs
checkout at `~/Development/djs` (`djs-core`, `djs-prelude`) and on the workspace
crates `gondolin-egress`, `gondolin-proto` and `gondolin-wire`.

- `src/lib.rs`: `DjsHooks`, a `HookBackend` that runs `onRequest` in djs. It
  compiles the policy once into a snapshot, then runs each call either in a
  fresh VM from that snapshot or in a pooled VM. Heads go in through the djs
  wire format and bodies are read through an async host function. Any failure
  fails closed (`HookError::Failed`, which egress answers with 502).
- `src/shim.js`: the hook environment. It is a restricted
  `Headers`/`URL`/`URLSearchParams`/`Request`/`Response` plus
  `HttpRequestBlockedError` and `console`.
- `policies/*.js`: the policies the benchmark runs.
- `src/bin/bench.rs`: compares native Rust, djs (fresh and pooled VMs) and tier 3.
  The tier-3 baseline is a node child process that speaks the controller frame
  protocol and serves calls through the host package's `NativeHookService`;
  `RemoteHooks` sits on the daemon side.
- `src/bin/probe.rs`: runs one policy in a loop, for profilers.
- `node/controller.mts`: the tier-3 controller.

```sh
cargo run --release --bin bench -- 10000
cargo run --release --bin probe -- policies/allowlist.js 100000
```

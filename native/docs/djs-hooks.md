# djs as the tier-2 hook engine (M6 research)

Status: research and prototype; the production implementation is
`native/crates/gondolin-hooks-djs` on djs-embed (see `native/DESIGN.md`,
"Hook tiers", and `docs/native.md`, "Tier-2 Hooks"). The prototype is
[`native/experiments/djs-hooks/`](../experiments/djs-hooks/). It sits outside
the workspace and path-depends on `~/Development/djs`; this doc used djs
`88c5fd9b`.

> Status (historical): the recommendations below were implemented
> differently in places. Production uses djs-embed (git dependency pinned in
> `gondolin-hooks-djs/Cargo.toml`), the policy is `configure.net.djs_hooks`
> (not `NetConfig.hooks`), calls run in pooled instances reset to the
> snapshot after each call (not fresh VMs) on the egress task in fuel slices
> with a wall-clock deadline (no dedicated pool), policies can be scripts,
> ES modules, TypeScript or JSON with in-memory imports (no esbuild
> bundling), URLs are parsed by `gondolin_http::url` (not the `url` crate),
> and node's consumed-body rule is kept. Current numbers are in `PLAN.md`
> (M6); the tables here are prototype measurements.

Tier 2 runs user JavaScript hooks inside `gondolind`, so a hook no longer pays
a controller round trip (tier 3). This doc answers four questions:

1. How do we embed djs?
2. What hook contract can djs offer?
3. What do ES modules need?
4. What does a call cost?

**Short answer: djs works as a tier-2 engine today.** Tier 3 still has to do
module loading, and the embedding API is too internal to depend on yet.

| | |
|---|---|
| Policy compile (shim and policy) | ~1–5 ms, once. The snapshot is 238 KiB. |
| Empty hook call | 3.5 µs, 450 fuel |
| Realistic header policy (allowlist, secret check, two header edits) | 26 µs pooled, 33 µs fresh VM, ~5.9k fuel |
| Hook that reads 64 KiB of body | 20 µs pooled, 35 µs fresh VM |
| Tier 3 (node controller over a pipe) | 70 µs for header-only, 157 µs for the 64 KiB body (p99 0.16 / 0.76 ms) |
| Fail closed | Fuel, memory, exceptions, bad returns, never-settled promises, syntax errors and engine panics all end as `HookError::Failed`, which egress answers with 502 |

Tier 2 is 2–8× faster than tier 3 per call. It also does not serialize on one
node event loop, so it scales across cores: ~200k calls/s with 8 callers,
against ~30k for node. It is still ~40× slower than a native closure on
header-only work, so declarative tier 1 remains the default for anything it can
express.

## 1. Native embedding API

### What the prototype uses

The prototype uses the following djs-core / djs-prelude surface, all of it
public items of internal modules:

| Purpose | API |
|---|---|
| Create a VM | `djs_prelude::new_vm(VmOptions { memory_limit, frozen_builtins: true, .. })` |
| Host functions | `Vm::new_host_function(id, name)` (sync), `Vm::new_async_host_function(id, name)` (returns a promise), `Vm::define_global` |
| Compile | `Vm::compile(src, &CompileOptions::script(name))`, then `Vm::call` and `Vm::run` |
| Snapshot | `Vm::collect`, `Vm::image()`, `Vm::from_bytes_trusted(image, opts)` |
| Per call | `Vm::global_path`, `Vm::call(f, this, args)`, `Vm::run_metered(slice)`, `Status::{Done, Threw, OutOfFuel, HostCall, Idle, HostOutOfMemory}` |
| Host calls | `Vm::host_call(id) -> HostCallInfo { fn_id, args }`, `Vm::new_host_calls()`, `Vm::resolve_host_call(id, Ok/Err)` |
| Values in | `djs_core::wire::{decode, DecodeOptions}`, which needs `interp::{Intrinsic, intrinsic}` for the prototypes. The prototype has its own wire encoder (`wire::Writer` in `lib.rs`), because djs ships none for Rust hosts. |
| Values out | `Value::{as_string, as_bool}`, `Heap::str_to_string`. The decision comes back as a JSON string through a sync host function (below). |
| Errors | `Vm::new_error(ErrorKind::TypeError, ..)`, `Vm::error_stack`, `Vm::display`, `Vm::abort` |

`Vm` is `Send` but not `Sync`, so one VM serves one call at a time and
parallelism comes from several VMs. It builds natively on darwin-arm64 with the
default `full`/`unicode` features. `lazy`, `dump` and `compile-cache` are not
needed.

### Compile once, then fresh VM or long-lived VM

At policy load, the host builds a VM from the prelude base. It defines the host
functions, runs `shim.js` and then the policy script, collects, and keeps
`vm.image()` as the policy snapshot. A syntax error or a throw at the top level
fails the load (`configure.net` would answer `invalid_request`), so it never
surfaces per request.

Per call there are two choices:

- **Fresh VM from the snapshot.** `Vm::from_bytes_trusted(image.clone())` costs
  ~6–7 µs on header-only calls (a 238 KiB copy plus load) and more when the call
  allocates a lot (a 64 KiB body: +15 µs, because the heap has to grow). This
  gives full isolation: no state leaks between requests or between guests that
  share a policy, results are deterministic, and nothing needs recycling.
  `Vm::replace_image` could reuse the allocation and save part of the copy.
- **Long-lived (pooled) VMs.** ~20% cheaper. Globals persist, so a policy can
  keep counters or caches. But that state is per pool member and therefore
  nondeterministic, unless the pool has a single VM, which serializes the
  policy. A VM whose call failed in any way is dropped and never returned to the
  pool, because `abort()` leaves the realm intact but the policy's globals may be
  half-updated. A real implementation would also recycle VMs after N calls or
  once the heap passes a threshold.

**Recommendation:** fresh VMs by default. Offer an opt-in `stateful` mode later,
backed by a single VM per policy or, better, by a host key-value store exposed
as a host function. `frozen_builtins: true` keeps policies from patching
builtins, which also matters for pooled VMs.

### Sync vs async host functions

- **Sync** (`Status::HostCall { call_id, fn_id }`). The VM parks and the host
  answers before the VM continues. Use these for pure, bounded work: URL
  parsing (the `url` crate, so URL semantics match egress exactly), logging, and
  the result channel `__settle(ok, json)`.
- **Async** (an async host function returns a promise). Once only async calls
  are pending, `run` returns `Idle`. The host takes `new_host_calls()`, awaits
  the Rust future (here `BodyHandle::read_to_end`), resolves the calls by id and
  runs again. This is how body reads map onto egress's lazy `BodyHandle`. If
  the VM is `Idle` with nothing outstanding, the hook's promise can never
  settle, and the call fails.
- **Getting an async entry's result.** `Status::Done(v)` hands back the entry
  function's return value, which for an `async onRequest` is a promise. When the
  VM goes `Idle` first, there is no GC-safe way to keep `v` across the following
  `run`s. The shim therefore attaches `.then(settle, settle)` and the host reads
  the decision from the `__settle` sync call. djs should offer this directly
  (requirement E4 below).

### Fuel, memory and time

- **Fuel.** `run_metered(slice)` runs in slices of 200k fuel (~1 ms). Between
  slices the host checks the per-call budget (default 50M fuel, ~0.2 s CPU) and
  calls `tokio::task::yield_now()`, so a slow hook never holds a runtime worker
  for long. The measured rate is ~4 ns per fuel unit on allocation-heavy shim
  code. A production version should run hooks on a small dedicated pool (or
  `spawn_blocking`), so CPU-bound policies can't starve the network runtime at
  all, and should add a wall-clock deadline around body reads.
- **Memory.** `VmOptions::memory_limit` caps the heap (64 MiB default, 4 MiB in
  the test). Running out raises a *catchable* `InternalError: out of memory`. A
  policy that swallows it can still return a decision, which is the policy's
  own choice. Fuel still bounds it, but an option to make OOM uncatchable
  (requirement E6) would be cleaner. `HostOutOfMemory` aborts the call.
- **Fail closed.** Every non-decision outcome maps to `HookError::Failed`, which
  egress turns into `502 Bad Gateway`, as for tier-3 exceptions. These outcomes
  are:
  - `Threw`;
  - a rejected hook promise;
  - fuel exhausted (the host calls `vm.abort()`);
  - `HostOutOfMemory`;
  - a never-settled promise;
  - a decision with the wrong shape;
  - an engine panic.

  `HttpRequestBlockedError` maps to `HookError::Blocked`, which keeps its own
  status. `run_metered` is wrapped in `catch_unwind`; a panic fails the call and
  the VM is dropped. djs documents engine panics as bugs (in wasm they trap), so
  dropping the VM is the only safe recovery. The bench prints each of these
  cases.

### What a stable embedding crate should look like

gondolind should not depend on `djs_core::interp`, `Heap` or wire internals. A
small `djs-embed` crate (in the djs repo, versioned with it) covering the
prototype's needs would look roughly like this:

```rust
let policy = djs_embed::Program::compile(Source::script("policy.js", src), &CompileConfig {
    host_functions: &[HostFn::sync(URL_PARSE, "__url_parse"), HostFn::r#async(BODY_READ, "__body_read")],
    prelude: &[Source::script("<gondolin-hooks>", SHIM)],
    frozen_builtins: true,
})?;                                         // -> Snapshot (bytes + build hash), Send + Sync
let mut vm = policy.instantiate(&Limits { memory, fuel })?;   // fresh VM; or vm.reset()
let call = vm.call_async("__gondolin_on_request", &[Arg::wire(&head), Arg::int(stream)])?;
loop {
    match vm.step(slice) {                   // Step::{Settled(Result<Wire, Wire>), HostCall(Call),
        Step::HostCall(c) => c.resolve(...),  //        Pending(Vec<Call>), OutOfFuel, Failed(Error)}
        ...
    }
}
```

The essential pieces:

- A shareable compiled snapshot.
- Typed host functions that take `&str`/`&[u8]`/wire arguments.
- An async entry point whose settled value is returned to the host.
- Wire in and wire out with a Rust encoder.
- Budgets.
- One `Error` enum.

The full list is under "Requirements for djs" below.

## 2. Hook contract

### Data model

What crosses the boundary matches egress's `HookBackend` and the controller
protocol's `hook_call`, so tier 2 and tier 3 see the same shapes:

- **In.** `{ method, url, headers: [[name, value], ...] }`, wire-encoded. Header
  names are lowercase and coalesced, as `RequestHead` has them. A body stream id
  is passed when the registration asks for bodies.
- **Out.** A plain-data decision, mirroring `gondolin_proto::net::HookDecision`:
  - `continue`;
  - `request` with a head and a body: `original`, `none`, or inline
    `text`/`bytes`;
  - `respond` (`response`) with a head and a body;
  - `block` with a status, status text and message.

  The prototype uses JSON for this. A real implementation should use the same
  names and the proto's `status_text`, and return bytes as a wire `BYTES` value
  instead of a JSON number array.
- **Bodies stay on the host.** `request.text()`, `json()`, `bytes()` and
  `arrayBuffer()` are async host calls. The host pulls the `BodyHandle` once
  (within the egress body limit) and caches the bytes for clones. A hook that
  never reads the body costs nothing for it (3.6 µs either way), and the
  original stream is forwarded untouched. The host decodes text (UTF-8,
  replacing invalid sequences), because djs has no `TextDecoder`.

### The shim (`experiments/djs-hooks/src/shim.js`, ~330 lines of plain JS)

- **`Headers`.** Supports `append`, `set`, `get`, `getSetCookie`, `has`,
  `delete`, `forEach`, and sorted `entries`/`keys`/`values`/iteration. Name
  validation and value trimming follow the spec, with set-cookie kept apart.
  Heads from the host are trusted, so their headers are installed without
  re-validation. A mutation counter lets an unchanged head answer `continue`
  without re-serializing; this cut the empty-call cost from 10.7 to 3.2 µs.
- **`URL`** (read-only accessors, `canParse`, `searchParams`) and
  **`URLSearchParams`.** Parsing is a sync host call into the `url` crate.
- **`Request`.** `method`, `url`, `headers`, `clone()`, `bodyUsed`, the body
  readers, and `new Request(input, { method, headers, body })` to build a
  replacement.
- **`Response`.** `status`, `statusText`, `headers`, `ok`, `Response.json`, and
  a string or `Uint8Array` body.
- **`HttpRequestBlockedError(message, status, statusText)`**, which becomes a
  `block` decision.
- **`console.*`**, which goes to the daemon log through a sync host function.
- **Hook semantics.** The hook returns `undefined` or the original request
  (in-place header edits count as a replacement), a new `Request`, or a
  `Response`, as tier 3 does.

One deliberate difference remains. Node refuses to forward a request whose body
the hook consumed without cloning ("onRequest consumed the request body"). The
shim allows it, because the host retains the bytes. For portability between
tiers, the production shim should keep node's rule; the benchmark policies use
`req.clone().text()`, which works on both.

### Node hook features tier 2 cannot support

- **Arbitrary closures over controller state.** Node hooks can capture
  in-process maps, database handles or SDK objects. Tier-2 hooks are
  self-contained source; state only comes from config data, or from host
  functions that gondolind chooses to expose.
- **Node and npm APIs.** `fs`, `net`, `process`, `Buffer`, `require`, and
  npm packages unless they are pure JS and bundled (see §3).
- **`fetch()` and other outbound I/O from a hook.** Calling an auth service or
  a secret manager would need explicit host functions, if ever. Timers
  (`setTimeout`) and `AbortSignal`/`request.signal` are also missing.
- **Streaming bodies.** There is no `ReadableStream`, `request.body` piping,
  `TransformStream`, or streamed replacement/response bodies. Bodies are whole
  values within egress's buffer limits, which tier 3 already enforces for
  replaced bodies. `Blob`, `FormData`/multipart parsing and charset-aware text
  decoding are also missing.
- **`crypto.subtle` and `crypto.randomUUID`.** HMAC/SigV4-style request signing
  would need host functions (a natural `@sdk/crypto` candidate).
  `TextEncoder`/`TextDecoder` (ask djs) and `Intl` are also absent.
- **Fetch-only `Request` fields.** `cache`, `credentials`, `mode`, `redirect`,
  `referrer`, `integrity`, `keepalive` and `signal` are meaningless here and
  absent. So are `Response.redirect`/`Response.error` (easy to add) and
  `instanceof` checks against node's own classes.
- **Wall-clock-dependent policies.** `Date.now()` is the host-set VM clock.
  Pass the time explicitly if a policy needs it.

## 3. ES modules

djs has no modules today. `import`/`export` are syntax errors, and `import()`
compiles but rejects one job later with "could not load module" (D1582,
`builtins/import.ts`). The `@sdk/...` harness hooks want three things:

- policies written as modules (`export async function onRequest(req)`);
- imports of harness-provided libraries (`import { allowHosts, secret } from
  "@sdk/net"`);
- sharing helpers between policies.

### Interim: bundle on the controller

The Node SDK can run esbuild on the policy entry when it compiles the
`configure.net` message: `bundle: true`, `format: "iife"`, a `globalName` or a
footer that assigns `globalThis.onRequest`, `platform: "neutral"`, and the
`@sdk/*` modules resolved from the SDK package by a plugin. It ships one script
string to gondolind, which compiles it as above.

Pros:
- works today;
- no djs changes;
- bundling errors surface on the client.

Cons:
- esbuild becomes a dependency of the host package (it is not one today), which
  is awkward for the pure-config use case and impossible for non-node
  controllers;
- no top-level `await` in IIFE output;
- stack traces need source maps, which djs does not consume;
- every policy duplicates the `@sdk` code in its snapshot;
- `import()` stays unsupported;
- version skew between the bundled `@sdk` code and gondolind's host functions
  must be checked by hand.

### Target: native module support in djs

gondolind resolves `@sdk/...` itself. These can be synthetic modules backed by
host functions, or JS modules shipped inside gondolind. The user's own modules
come in the config as `{ specifier: source }`. The engine does no I/O.

### Requirements for djs

**Modules**

- **M1.** Module goal: `CompileOptions::module(name)`, which parses
  `import`/`export` (including `export default`, re-exports and `export * as`)
  in strict mode.
- **M2.** A host loader. Specifier resolution is a host callback
  `(specifier, referrer) -> ModuleSource | Error`. Bare specifiers such as
  `@sdk/net` are passed through verbatim, with no URL or path semantics built
  in. It can be synchronous: the source map is in memory.
- **M3.** Linking and evaluation per spec: live bindings, cycles, namespace
  objects, `import.meta` (at least `url` = specifier), and errors at link time
  (a missing export is a `SyntaxError` before the first request).
- **M4.** Synthetic modules: the host provides a module whose exports are host
  functions or values, created from Rust without JS source. This is for
  `@sdk/...` APIs backed by gondolind.
- **M5.** `import()` goes through the same loader. The host answers like an
  async host call, so the result arrives in a later `run`.
- **M6.** Linked module graphs survive `collect`/`image()`/`from_bytes`. This is
  the compile-once, instantiate-many model: a snapshot taken after evaluation
  must contain the evaluated graph.
- **M7.** Access to a module's exports from the host:
  `vm.module_export(module, "onRequest")`.
- **M8** (nice to have). Top-level `await` (async module evaluation), JSON
  modules (`with { type: "json" }`) for policy data, and source maps (or at
  least a filename/line offset per module) for stack traces.

**Embedding**

- **E1.** A stable embedding crate (`djs-embed`) with semver, so gondolind does
  not reach into `interp`, `heap` or `wire` internals. It should be usable as a
  git or crates.io dependency, and cross-compile to `*-linux-musl` with zig, as
  gondolind does. Untested: djs-prelude's build script makes the base image on
  the build host; check that images are target-independent for 64-bit LE.
- **E2.** A compiled snapshot that is `Send + Sync`, can be shared across
  threads and cloned into VMs cheaply. Ideally VMs reset to it in place
  (`reset()` reusing the allocation) and do copy-on-write if possible. Today's
  `from_bytes_trusted(image.clone())` costs ~6 µs on a 238 KiB image.
- **E3.** Typed host-call arguments and results: `&str`, `&[u8]`, number, bool
  and wire values, without `Heap::str_to_string` or `Value` internals.
- **E4.** An async entry point. Calling a function that returns a promise
  should end in `Done`/`Threw` with the *settled* value once its promise
  settles, or give a GC-safe handle to poll. That needs rooted handles for
  values kept across `run`s.
- **E5.** Wire format for Rust hosts:
  - a Rust encoder in djs, since everyone writes their own;
  - a `Vm::decode_wire(bytes)` that needs no intrinsics;
  - an outbound encoder (value → wire) for results, instead of
    `JSON.stringify` plus a host call;
  - `STR_UTF8` without the UTF-16 length up front (the decoder can count). The
    up-front count made a 64 KiB text body cost ~40 µs until the prototype added
    an ASCII fast path;
  - `BYTES` → `Uint8Array` that can wrap host-owned bytes (`bytes::Bytes`)
    without a copy, or at least a single copy.
- **E6.** Budgets:
  - per-call fuel (exists: `run_metered`);
  - memory (exists: `memory_limit`);
  - an option to make heap exhaustion uncatchable, so a policy cannot swallow
    it;
  - documented guarantees that `abort()` leaves the VM reusable.
- **E7.** Failure model. Document that a panic poisons the VM, so the host must
  drop it. Make that safe under `catch_unwind` (no global state). Alternatively,
  turn known internal errors into `Status::Failed` instead of panics.

**Builtins**

- **B1.** `TextEncoder`/`TextDecoder` (UTF-8 only is enough) and
  `structuredClone`, if cheap.
- **B2.** Optionally a spec `URL`/`URLSearchParams`. The prototype's host-call
  URL is fine and matches egress exactly, so this is low priority.
- **B3.** No `fetch`, timers or `Request`/`Response` in the engine. The fetch
  types stay in gondolind's shim, where they are tied to the hook contract.

## 4. Byte passing and per-call cost

Setup:
- Apple M5 Max, release build, tokio multi-thread runtime with 8 workers.
- `cargo run --release --bin bench -- 10000` in the prototype.
- The machine was shared with other agents (load average ~10–18). The table
  is the quietest of several runs; under load the djs rows move by ~10–30%
  and the node rows by 2–4×.

Columns:
- p50/p99 latency and calls/s use one sequential caller.
- The "8 callers" column uses eight concurrent callers on the same backend.

Backends:
- **djs fresh** builds a VM from the snapshot per call.
- **djs pooled** reuses VMs.
- **node tier 3** runs `RemoteHooks` and a node child that speaks the
  controller frame protocol over stdio and serves calls with the host package's
  `NativeHookService` (`node/controller.mts`), running the same policy file as
  plain JS.
- **native Rust** is the same policy as a `HookBackend` closure.

All rows include the harness: cloning the head, plus for body rows building a
`PullableBody` over a 64 KiB `Bytes` and discarding it.

| engine | hook | p50 µs | p99 µs | calls/s (1 caller) | calls/s (8 callers) | fuel/call |
|---|---|---:|---:|---:|---:|---:|
| native Rust | header-only | 0.6 | 0.8 | 1,608,000 | 4,985,000 | – |
| djs pooled | empty policy | 3.5 | 6.2 | 262,000 | 563,000 | 453 |
| djs fresh | header-only | 33.0 | 51.0 | 29,700 | 179,500 | 5,931 |
| djs pooled | header-only | 26.2 | 55.5 | 36,200 | 223,400 | 5,931 |
| node tier 3 | header-only | 69.7 | 159.6 | 13,300 | 28,800 | – |
| native Rust | 64 KiB body | 18.9 | 21.6 | 52,400 | 279,100 | – |
| djs pooled | 64 KiB read as text, unused | 15.4 | 40.3 | 52,000 | 213,300 | 1,273 |
| djs pooled | 64 KiB read as bytes, unused | 15.3 | 42.2 | 52,000 | 218,400 | 1,642 |
| djs fresh | 64 KiB body | 35.1 | 42.0 | 28,800 | 128,700 | 1,299 |
| djs pooled | 64 KiB body | 20.3 | 49.7 | 40,700 | 196,900 | 1,299 |
| node tier 3 | 64 KiB body | 157.2 | 763.7 | 5,500 | 8,500 | – |

The workloads:
- **Header-only** is `policies/allowlist.js`:
  - a host allowlist with a wildcard;
  - a scan of every header for a secret placeholder that is not allowed for the
    destination;
  - `set` of one header and `delete` of another;
  - the replaced head is returned.
- **64 KiB body** is `policies/body.js`, which does
  `await req.clone().text()` and then a `.includes()` check.

The native body row's time is mostly harness and a UTF-8 lossy copy, not the
policy itself.

### Where the time goes

Sampled with `probe` and macOS `sample`.

- **Fixed cost (~3.5 µs).**
  - A wire decode of the head (~8 headers).
  - The `Request`/`Headers` wrapper objects.
  - The promise chain.
  - `JSON.stringify` of the decision.
  - `serde_json` on the host.
  - It was 10.7 µs before the trusted-head and mutation-counter fast paths.
    Dropping JSON for wire-out (E5) would shave a bit more.
- **Policy code.** The interpreter (`run_hot`) dominates. The allowlist policy
  is ~5.9k fuel, about 22 µs. Writing it with plain loops instead of
  `Object.entries` and header iterators that sort and allocate would roughly
  halve it. Policy cost scales with fuel, at ~4 ns per unit.
- **Bytes in.**
  - With `BYTES` → `Uint8Array`, 64 KiB costs a single memcpy into the heap
    plus GC pressure: compaction `memmove`s show up once bodies are large.
  - Text needs a UTF-8 check and a transcode into a djs string. The format's
    up-front UTF-16 length forced a full `encode_utf16().count()`. That and
    `from_utf8_lossy` were ~70% of the samples (64 KiB text: 67 µs) until the
    prototype short-circuited ASCII and valid UTF-8 (now 15 µs, the same as
    bytes).
  - The real fix is E5: let the decoder count, or wrap host bytes.
- **Fresh VM.** +6–7 µs per call for the image copy and load, and +15 µs when
  the call grows the heap (body rows).
- **Tier 3.** CBOR framing, a pipe round trip, the node event loop, and real
  WHATWG `Request` construction. A body adds `body_pull` round trips and
  `ReadableStream` plumbing. Node is single-threaded, so concurrency barely
  helps (13k → 29k calls/s), and its p99 is 2–15× worse. The real controller
  link is a socket with other traffic multiplexed on it, so production tier 3
  will be somewhat slower still.

## Recommendation and next steps

1. Build tier 2 as a `gondolin-hooks-djs` crate implementing `HookBackend`,
   behind a cargo feature in gondolind. Move the prototype's shim, wire glue and
   drive loop over once `djs-embed` (E1–E5) exists. Until then, pin a djs git
   revision; publishing is blocked on djs being consumable as a dependency.
2. The config shape is a policy source (or module map) in `NetConfig.hooks`,
   compiled at `configure.net`. Compile errors reject the config. Each phase is
   registered only if the policy exports it (`onRequest`, `onResponse`,
   `isRequestAllowed`, `isIpAllowed`), so egress keeps the early-policy fast
   path for phases a policy does not define.
3. Use fresh VMs per call, hooks on a dedicated thread pool, and limits from
   config (fuel, memory, a wall-clock deadline for body reads).
4. Ship the esbuild bundling path in the Node SDK only if users need `@sdk`
   imports before djs gains modules (M1–M7).
5. Extend the shim to `onResponse` (response heads plus a lazy response body),
   `isRequestAllowed` and `isIpAllowed`, which are simple plain-data calls.
   Keep node's consumed-body rule for parity.

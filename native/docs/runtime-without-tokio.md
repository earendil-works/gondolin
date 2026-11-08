# Should gondolind drop tokio?

> Status (historical): the recommendation was implemented in M8 (`PLAN.md`).
> tokio stays with `rt`, `rt-multi-thread`, `net`, `time`, `sync` and
> `io-util` (plus `io-std` in gondolind and `fs` in gondolin-assets);
> russh, rsa, hyper/reqwest/tower, url/idna, rcgen, serde/ciborium/serde_json,
> tracing, async-trait, futures-util, thiserror, flate2/tar,
> rustls-native-certs and rustix were replaced by own code or libc. The
> binary has 26 third-party runtime crates; the budget is
> `native/deps-budget` (`make -C native deps`). Counts and tables below are
> from before the diet. Conventions for new code: `native/DESIGN.md`,
> "Dependency diet conventions". The `net_relay` module in the inventory
> below was removed later, together with the node engine.

Research note for the dependency diet (owner target: fewer than 30 runtime
crates; today 249 on macOS, 248 on Linux for `gondolin-cli`, which links the
whole daemon). Measurements are from an M5 Max (macOS 26, 18 cores) and the
`gondolin-linux-test` Docker image (Linux 6.x on Docker Desktop's linuxkit VM,
18 vCPUs, arm64). The tools are under `native/experiments/runtime-probe/`
(excluded from the workspace): `deps.sh` (crate counts of scratch crates) and
the `runtime-probe` binary (thread/task memory, relay CPU).

## Summary

- **tokio's crate cost is small once trimmed.** With the features we need
  (`rt`, `rt-multi-thread`, `net`, `time`, `sync`) tokio adds **4 crates**
  (tokio, mio, socket2, pin-project-lite); `io-util` adds `bytes` (+1),
  `process`/`signal` add signal-hook-registry (+1, +errno on Linux). `full`, as
  configured today, adds **16** (parking_lot ×4, smallvec, tokio-macros and the
  proc-macro stack, signal-hook-registry). An own runtime would save 3–5 crates
  over trimmed tokio; mio or polling alone are +1.
- **What blows the budget is not the runtime.** Measured on scratch crates:
  russh adds ~104 crates on top of tokio, rsa (MITM CA key generation) 20, the
  assets/native-roots set (flate2, tar, rustls-native-certs) 12 on macOS. The
  smallest plausible core (smoltcp, ring, rustls, webpki-roots, libc, rustix) is
  already **22**; with trimmed tokio it is **26–29**.
- **Runtime overhead is not where the CPU goes.** Relaying through sockets, a
  current-thread tokio runtime costs the same CPU per GiB as a hand-written
  poll loop (0.65 vs 0.64 s/GiB at 64 flows on macOS; 0.41 vs 0.46 on Linux).
  The multi-thread model (tokio's multi-thread scheduler *or* thread-per-flow)
  is what costs: 3–5× the CPU per GiB at 64 flows on macOS, thread-per-flow 25×
  on Linux. Thread-per-flow also costs 42–51 KiB RSS per idle flow (touched
  stack) against ~0.7–0.9 KiB per idle task.
- **tokio is ~2% of the binary.** cargo-bloat attributes 605 KiB of the 7.3 MiB
  `.text` to tokio, but 448 KiB of that are task poll functions with our futures
  inlined (they exist under any executor). tokio's own code is ~156 KiB.
- **Recommendation: keep tokio, trimmed to minimal features; do not write an
  own runtime now.** Write the replacements (HTTP/1.1, SSH, CBOR/JSON) as
  sans-io cores with thin tokio adapters, so a later runtime swap only touches
  adapters. Drop russh and rsa first: together they are ~125 of the ~220
  crates to lose, and nothing about them depends on the runtime decision.

## 1. Inventory: where tokio is used

### Who pins tokio (dependencies)

`cargo tree -i tokio` (macOS): our 8 crates plus hyper, hyper-util,
hyper-rustls, tokio-rustls, tower, reqwest, russh, russh-util (and tokio-stream
as a dev-dependency). Features in the tree: the workspace asks for `full`;
otherwise russh-util needs `macros` + `rt`, russh `io-util`, `sync`, `time`,
`net`, `rt-multi-thread`, hyper `sync`, hyper-util/reqwest/tower `time`. Every
crate on the diet list (hyper*, tower, reqwest, russh, tokio-rustls) is
tokio-based; **tokio cannot leave before all of them did**. Conversely, none of
them needs more than the minimal features, so trimming tokio does not have to
wait for them (except `macros`, which russh-util enables until russh goes).

### API use per crate

Regex counts of API mentions (`experiments/runtime-probe/api-counts.py crates`;
the categories: runtime = `tokio::runtime`/`block_on`/
`block_in_place`, spawn = `tokio::spawn`/`JoinHandle`/`JoinSet`/`yield_now`,
net = Unix/TCP/UDP types and `lookup_host`, io = `Async*Ext`/`copy*`/`duplex`/
`split`/`BufReader`/stdio, traits = `AsyncRead`/`AsyncWrite` in signatures,
time = `sleep`/`timeout`/`Instant`, sync = `mpsc`/`oneshot`/`Notify`/`watch`/
async `Mutex`/`Semaphore`, macros = `select!`/`join!`/`try_join!`/`pin!`).
"src" is non-test code (test modules, `tests/`, `benches/`, `examples/` are
"test"). Counts are approximate (std `UnixStream`/`thread::spawn` match too);
gondolin-virtiofs and gondolin-proto use no tokio at all.

| crate (src) | runtime | spawn | blocking | net | process | io | traits | time | sync | signal | fs | macros | `#[async_trait]` | `async fn` | `.await` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gondolin-wire | 0 | 0 | 0 | 0 | 0 | 2 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 6 |
| gondolin-netstack | 0 | 4 | 0 | 14 | 0 | 5 | 16 | 3 | 8 | 0 | 0 | 5 | 1 | 6 | 8 |
| gondolin-egress | 1 | 4 | 1 | 11 | 0 | 7 | 28 | 11 | 9 | 0 | 0 | 1 | 8 | 45 | 99 |
| gondolin-sshproxy | 0 | 5 | 0 | 2 | (4)¹ | 9 | 8 | 2 | 4 | 0 | 0 | 1 | 2 | 24 | 50 |
| gondolin-vfs | 2 | 0 | 1 | 0 | 0 | 1 | 4 | 4 | 9 | 0 | 0 | 0 | 13 | 223 | 294 |
| gondolin-assets | 0 | 0 | 2 | 0 | 0 | 2 | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 8 | 21 |
| gondolind | 5 | 28 | 1 | 29 | 3 | 12 | 11 | 16 | 36 | 0 | 0 | 3 | 20 | 40 | 66 |
| gondolin-cli | 2 | 23 | 0 | 16 | 0 | 20 | 6 | 16 | 34 | 8 | 0 | 5 | 0 | 65 | 185 |
| **total src** | 10 | 64 | 5 | 72 | 3 | 58 | 77 | 53 | 100 | 8 | 1 | 15 | 44 | 416 | 729 |
| total tests | 36 | 71 | 0 | 33 | 5 | 89 | 11 | 50 | 28 | 0 | 0 | 1 | 24 | 280 | 1252 |

¹ russh child-process waits in the proxy, not `tokio::process`.

Plus **150 `#[tokio::test]`** functions (egress 63, netstack 31, sshproxy 21,
vfs 18, gondolind 9, assets 6, wire 1, cli 1).

Distinct tokio APIs in src (what an own runtime would have to provide):
`spawn`, `JoinHandle` (+ abort-on-drop), `JoinSet`, `spawn_blocking`,
`block_in_place` (1), `Handle::current`/`Handle::block_on` from foreign threads
(virtio-fs queue threads drive VFS futures), `yield_now`; `UnixStream`/
`UnixListener`, `TcpStream`/`TcpListener`, `UdpSocket` (netstack DNS),
`lookup_host` (egress resolver); `AsyncRead`/`AsyncWrite`/`ReadBuf` and the ext
traits, `split`, `copy`, `copy_bidirectional`, `BufReader` (QMP), `duplex`
(mostly tests), `stdin`/`stdout` (controller stdio); `sleep`, `sleep_until`,
`timeout`, `timeout_at`, `Instant`; `mpsc` (bounded, async send, `try_recv`),
`oneshot`, `Notify` (netstack poll/tx wakeups, ssh pump, tcpfwd), `watch`
(cli), async `Mutex` (egress `PullableBody`, vfs), `Semaphore` (egress flow
cap); `process::Command`/`Child` (QEMU, watchdog, piped stdout/stderr);
`signal::unix` (cli); `fs::File` (assets download); `select!` (biased, in the
session actor, vmm, guest, net_relay (since removed), cli), `join!`/`try_join!`.

### Async seams (traits at crate boundaries)

13 `#[async_trait]` object-safe traits: `FlowHandler` (netstack→egress),
`HookBackend`, `ControllerLink`, `Resolver` (egress), `SshHooks` (sshproxy),
`Provider`, `FileHandle`, `ObjectBackend` (vfs), `VfsBackend`, `NetBackend`,
`ControllerHandler`, `ControllerRequests`, `PortHandler` (gondolind). Plus
`FlowStream`/`UpstreamIo` (= `AsyncRead + AsyncWrite`). None of them names a
tokio type except through `AsyncRead`/`AsyncWrite`; `async-trait` itself is a
separate (proc-macro) crate and can be replaced by hand-written
`Pin<Box<dyn Future + Send + '_>>` signatures regardless of the runtime.

## 2. Dependency cost of the candidates (measured)

`experiments/runtime-probe/deps.sh`: scratch crates with a base set plus one
runtime candidate, `cargo tree -e normal` unique crates (name + version)
without the scratch crate. `m0` is the smallest plausible post-diet core
(smoltcp, ring, rustls, webpki-roots, libc, rustix); `b0` adds what assets and
native roots use today (rustls-native-certs, flate2, tar).

| variant | macOS | Linux | added crates |
|---|---|---|---|
| m0 (no runtime: own executor or threads) | 22 | 22 | – |
| m0 + mio (no default features) | 23 | 23 | mio |
| m0 + polling | 23 | 23 | polling |
| m0 + tokio rt, rt-multi-thread, net, time, sync | 26 | 26 | tokio, mio, socket2, pin-project-lite |
| … + io-util | 27 | 27 | + bytes |
| … + process, signal, io-std | 28 | 29 | + signal-hook-registry (+ errno) |
| m0 + tokio full (today's setting) | 38 | 39 | + parking_lot, parking_lot_core, lock_api, scopeguard, smallvec, tokio-macros, syn, quote, proc-macro2, unicode-ident |
| b0 | 34 | 31 | – |
| b0 + mio (default features) | 36 | 33 | mio, log |
| b0 + async-io + futures-lite | 45 | 42 | 11 (polling, concurrent-queue, crossbeam-utils, parking, fastrand, slab, futures-core/-io/-lite, pin-project-lite) |
| b0 + smol | 60 | 58 | 26 |
| b0 + tokio full + tokio-rustls, futures-util, async-trait, pin-project-lite, bytes (today's async stack) | 56 | 54 | 22 |
| b0 + tokio full + russh | 154 | 153 | russh alone: +104 |
| b0 + rsa (MITM CA key generation) | 54 | 51 | +20 |

Reading: (a) own executor/reactor on libc and (c) thread-per-flow are +0;
(b) mio-only or polling-only +1; (d) the smol family +11…+26, worse than tokio;
(e) trimmed tokio +4…+6. **Dropping tokio saves at most 4–6 crates**; trimming
`full` to the minimal set saves 10–12 of the 16 by itself. The proc-macro stack
(syn, quote, proc-macro2, unicode-ident) disappears only if `thiserror`,
`async-trait`, `serde_derive` and `tokio-macros` all go.

## 3. Runtime cost (measured)

### Memory: idle flows

`runtime-probe idle-threads N STACK_KIB TOUCH_KIB` spawns N threads blocked in
`read()`, each having touched TOUCH_KiB of stack (a blocking HTTP+TLS+hook call
chain touches tens of KiB); `idle-tasks N WORKERS` holds N tokio tasks awaiting
a socket read. RSS delta per flow:

| | macOS (16 KiB pages) | Linux (4 KiB pages) |
|---|---|---|
| thread, 64 KiB stack, nothing touched | 18.8 KiB | 14.3 KiB |
| thread, 32 KiB touched (stack size 64 KiB…2 MiB: no difference) | 50.8 KiB | 42.3 KiB |
| thread, 128 KiB touched | 146.8 KiB | 146.3 KiB |
| tokio task (1024 tasks, 4 workers) | 0.72 KiB | 0.88 KiB |

1024 guest flows (the netstack cap) as threads: 50–150 MiB RSS that is never
returned (touched stack pages stay resident); as tasks: ~1 MiB plus the future
sizes (boxed by async-trait, typically a few KiB). Buffers (rustls records,
read buffers) are the same in both models. Thread spawn: 7–30 µs on macOS,
~170 µs in the Docker VM.

### CPU: relaying a flow

`runtime-probe relay MODE FLOWS MIB CHUNK_KIB` moves MIB per flow from one
socketpair to another (the shape of a proxied flow, syscall-bound, no TLS);
sources/sinks run in a forked child so the parent's rusage is the relay alone.
Relay CPU in s/GiB (lower is better) and wall throughput:

| macOS, 64 KiB chunks | 1 flow | 8 flows | 64 flows | 256 flows |
|---|---|---|---|---|
| thread per flow | 0.70–0.78 (0.8–0.9 GiB/s) | 2.43 (2.1) | 3.36 (2.0) | 2.66 (2.2) |
| tokio multi-thread | 0.83–0.91 (0.8) | 1.67 (1.6) | 2.77 (1.8) | 2.69 (2.0) |
| tokio current-thread | 0.78–0.86 (0.8–0.9) | 0.72 (1.3) | 0.65 (1.5) | 0.66 (1.5) |
| own `poll(2)` loop, 1 thread | 0.74–0.75 (0.9) | 0.75 (1.2) | 0.64 (1.5) | 0.67 (1.5) |

| macOS, 4 KiB chunks | 1 flow | 64 flows |
|---|---|---|
| thread per flow | 1.02 (0.53 GiB/s) | 3.09 (1.8) |
| tokio multi-thread | 1.15 (0.66) | 4.48 (1.6) |
| tokio current-thread | 1.11 (0.68) | 0.76 (1.3) |
| own `poll(2)` loop | 1.00 (0.73) | 1.24 (0.8) |

| Linux (Docker), 64 KiB chunks | 1 flow | 64 flows |
|---|---|---|
| thread per flow | 0.35 (1.7 GiB/s) | 11.7 (0.58) |
| tokio multi-thread | 0.35 (1.9) | 2.06 (2.7) |
| tokio current-thread | 0.36 (1.7) | 0.41 (2.2) |
| own `poll(2)` loop | 0.36 (1.6) | 0.46 (2.1) |

- tokio's executor overhead is user time: 0.1–0.2 s/GiB on macOS against
  0.6–0.9 s/GiB of syscalls; with one thread it matches a hand-written loop.
- A naive own reactor loses to tokio as soon as it is not epoll/kqueue: the
  `poll(2)` loop at 64 flows × 4 KiB uses 60% more CPU and is 40% slower than
  tokio current-thread. An own runtime needs kqueue/epoll edge-triggered
  readiness, i.e. it reimplements mio.
- Cross-core wakeups are the cost: many threads (tokio workers or one thread
  per flow) contend on the same sockets and wake each other. This matches the
  earlier gondolind upload profile (tokio worker park/unpark,
  `__psynch_cvsignal` + `mach_absolute_time`, ~14%). That is a scheduling
  question (one current-thread runtime per VM, or keeping a flow's netstack
  and egress work on one worker), not a dependency question. Real egress flows
  also do TLS (user CPU that does benefit from more cores), so the
  current-thread variant needs measuring on the MITM path before switching.

### Binary size

`cargo bloat --release -p gondolin-cli --bin gondolin --crates` (fat LTO,
`strip = none`; the stripped binary is 10.2 MiB): tokio 605 KiB of 7.3 MiB
`.text` (8.1%), but by function, 448 KiB are `runtime::task::raw::poll` /
`spawn` instantiations whose bodies are our futures (`BlockingTask<…vfs host
op…>`, session/egress futures) and would exist with any executor. tokio's own
code (scheduler, io driver, timers, sync, net) is **~156 KiB (2.1%)**. An own
runtime would be maybe 50–100 KiB: ~1% of the binary. For comparison: russh
541 KiB, hyper + hyper-util 313 KiB, ssh_key + crypto_bigint + num_bigint
440 KiB.

## 4. Fit per component

| component | today | what async buys | no-tokio fit |
|---|---|---|---|
| netstack (`gondolin-netstack`, 3k lines) | smoltcp (poll-based) in one `State` behind a mutex; `serve()` = reader/writer/ticker in one task; per-flow `NetTcpStream: AsyncRead + AsyncWrite` with wakers; DNS via tokio `UdpSocket` + `timeout` | flows hand bytes to egress futures through wakers; backpressure is "don't wake the reader" | Good for any model: the core is already sans-io. An own event loop could own smoltcp outright (no mutex). The `AsyncRead`/`AsyncWrite` flow API is the seam to keep (own traits or futures-io if tokio goes). |
| egress (`gondolin-egress`, 5.8k lines) | hyper server per guest flow, hyper-util client pool, tokio-rustls (MITM + upstream), lazy hook bodies (`PullableBody`, async `Mutex`), remote hooks over the controller, WebSocket/CONNECT tunnels, `Semaphore` flow cap | everything: a request waits on hooks (remote round trips), bodies stream lazily with backpressure in both directions, tunnels are full duplex, idle/head timeouts everywhere | Worst fit for no-async. Thread-per-flow needs 2 threads per full-duplex flow, timeouts via `SO_RCVTIMEO`/condvar deadlines, cancellation by shutting down fds; measured 42–150 KiB/flow and 3–25× relay CPU. A callback/state-machine design (mio) means turning every hook await into an explicit state: a full rewrite of the pipeline (`http.rs`, `body.rs`, `ws.rs`, ~1.7k lines plus the hyper replacement). |
| sshproxy (`gondolin-sshproxy`, 1.9k lines) | russh server + client, write pump (`spawn` + `Notify`), `SshHooks` | channels multiplexed over one connection, window/backpressure | russh is tokio-only. The planned own exec-only SSH can be sans-io (packet codec + channel state) with a ~200-line tokio driver. |
| controller protocol (`gondolin-wire`, gondolind `controller.rs`, `stdio.rs`) | `FrameReader`/`FrameWriter` over tokio `AsyncRead`/`AsyncWrite`, stdin via tokio's blocking stdio | concurrent requests (VFS RPC, hooks) multiplexed with oneshot replies | Fine with threads too (one reader thread, one writer thread, channels), but the callers are async (hooks, VFS), so it stays async while they are. |
| session actor (gondolind `session.rs`, 1.5k lines) | one task, biased `select!` over 4 channels | single-threaded actor, no locking | Any model; with tokio minimal `select!` needs replacing (no `macros`): a small `poll_fn` over the receivers. |
| QEMU process + watchdog (`vmm.rs`) | `tokio::process` with piped stdout/stderr, `select!` child wait vs stop, watchdog helper process | little | Threads are the better fit: `std::process` + one waiter thread + two log reader threads per VM. Removes `process` (and with the cli's `signal`, signal-hook-registry). |
| VFS (`gondolin-vfs`, 9.3k lines; 223 `async fn`) | async `Provider`/`FileHandle`; host provider runs blocking syscalls via `spawn_blocking` or inline on virtio-fs threads (`with_inline_blocking` + `Handle::block_on`) | sandboxfs RPC and object backends that call the controller | The host path is blocking already; the async signatures exist for controller-backed providers. Making it sync would touch every provider (the largest mechanical change of all) for no crate saving. |
| virtio-fs (`gondolin-virtiofs`) | own vhost-user, std threads + libc | – | Already runtime-free. |
| assets / cli | reqwest download, tokio fs, signals, TCP ingress (hyper), registry over Unix sockets | concurrent ingress connections | Download is one blocking request (threads fine); ingress is a proxy like egress. |
| timers | `timeout`/`sleep` at 53 src sites (head/body/idle timeouts, DNS, retries, idle pause, QMP) | composable timeouts on any await | Thread model: per-call socket timeouts and deadline arithmetic; own runtime: a timer heap in the reactor. |

## 5. Options: effort and risk

| option | crates vs trimmed tokio | new code | changed call sites | risk |
|---|---|---|---|---|
| (e) keep tokio, minimal features | 0 (−10…12 vs today) | ~100 lines: `select!` helper, QEMU waiter threads, signal self-pipe in cli, test attribute stays via dev-dependency `macros` | ~15 `select!`/`join!`, 3 process, 8 signal, 1 fs, stdio | low; covered by the existing 150 async tests + host tests |
| (a) own executor + reactor (kqueue/epoll, timers, sync, net, process) | −4…6 | ~3–4k lines of unsafe-adjacent concurrency code (smol's equivalent, async-io + async-executor + async-task + async-channel + event-listener + polling, is ~9.7k non-blank lines for more platforms) | ~470 API mentions in src, ~300 in tests, 150 test attributes; async fns unchanged | high: wakeup/edge-trigger bugs show up as hangs under load; the relay data shows a naive reactor is slower than tokio |
| (b) mio + own executor | −3…5 | ~2.5–3k (no reactor syscalls) | as (a) | high, as (a) |
| (b′) mio + callbacks/state machines, no async | −3…5 | rewrite of egress pipeline, netstack flow API, sshproxy, controller | all 416 async fns / 729 awaits in src | very high: hook awaits and lazy bodies become explicit states |
| (c) thread per flow, blocking std I/O | −4…6 | – | all async code rewritten to blocking (416 fns / 729 awaits src, 280 / 1252 tests) | very high, and measured worse: 42–150 KiB RSS per flow, 3–25× relay CPU at 64 flows |
| (d) smol / async-io family | +5…+22 | – | as (a) | – (costs more crates than tokio) |

## 6. End-state counts

Assuming russh, rsa, reqwest, hyper*/tower, url/idna, rcgen/x509, serde/
ciborium/serde_json/tracing, async-trait, futures-util and tokio-rustls are all
replaced by own code (macOS / Linux):

| core | without tokio | with minimal tokio (rt, rt-multi-thread, net, time, sync) | + io-util, process, signal |
|---|---|---|---|
| m0: smoltcp, ring, rustls, webpki-roots, libc, rustix | 22 / 22 | **26 / 26** | 28 / 29 |
| b0: m0 + rustls-native-certs, flate2, tar | 34 / 31 | 38 / 35 | 40 / 38 |

So under 30 is reachable with tokio, but only from the m0 core: native roots
(+5 macOS: security-framework, core-foundation and their -sys crates; +2
Linux), flate2 + tar (+6), thiserror (+5 with the proc-macro stack),
lru/indexmap (hashbrown, foldhash, equivalent, allocator-api2) each break the
budget on their own, with or without tokio. The runtime decision is worth 4
crates; the core decisions are worth 15+.

## 7. Recommendation

Keep tokio with minimal features (`rt`, `rt-multi-thread`, `net`, `time`,
`sync`; `io-util` only while `bytes` stays for other reasons). Do not write an
own runtime: it saves 4 crates and ~1% of the binary for 3–4k lines of the
hardest code in the daemon, and the data shows no CPU win over tokio's
current-thread scheduler (the CPU win available is a scheduling change, which
tokio supports). Thread-per-flow is measurably worse for egress.

Write every replacement as a **sans-io core plus a thin tokio adapter**
(HTTP/1.1 codec, SSH transport/channels, CBOR/JSON, URL); the netstack already
is one. That keeps the option to swap the runtime later without redoing any of
the protocol work, and makes the cores fuzzable without a runtime.

Order (largest saving first, no step redone by a later one):

1. **russh → own exec-only SSH** (sans-io over ring): −104 crates. Also
   removes tokio's `macros` requirement (russh-util).
2. **rsa** (MITM CA key generation, −20): generate the CA with ring (ECDSA
   P-256, which ring can generate and sign with) or keep RSA only for loading
   an existing node-engine CA; check compatibility with the shared CA dir.
3. **hyper, hyper-util, hyper-rustls, tower, http, http-body, reqwest,
   tokio-rustls**: one own HTTP/1.1 sans-io codec (server side for guest
   flows, client side for upstream and asset downloads) + an own
   rustls-over-`AsyncRead`/`AsyncWrite` adapter (~200 lines).
4. **url/idna, rcgen/x509/asn1/time** (own DER writer over ring), then
   **serde/ciborium/serde_json/tracing** and **async-trait/futures-util**
   (hand-written boxed futures at the 13 trait seams).
5. **Trim tokio** to the minimal features (can be done any time; best right
   after step 1 since russh-util pins `macros`): replace 15 `select!`/`join!`
   with a `poll_fn` helper, QEMU child handling with std threads, cli signals
   with a self-pipe, the assets `fs::File` with std; keep `macros` as a
   dev-dependency feature for `#[tokio::test]` (dev features do not unify into
   the release build with resolver 3). −10…12 crates vs today.
6. **Core trims**, the decisions that actually decide "under 30":
   rustls-native-certs (own keychain/`/etc/ssl` loader or webpki-roots only),
   flate2 + tar (own tar reader over miniz_oxide),
   thiserror, lru/indexmap.
7. Revisit the runtime only if, after 1–6, the count is at 26–29 and the
   remaining 4 tokio crates are the difference. With sans-io cores the swap is
   then mechanical: the adapters plus ~470 API mentions.

Separately (performance, not dependencies): measure one current-thread runtime
per VM (or per netstack + its flows) against the multi-thread runtime on the
MITM benchmark and the exec/net host benchmarks; the relay data suggests
2–4× less CPU per GiB for socket-bound flows at the cost of TLS parallelism.

## Reproducing

```bash
cd native/experiments/runtime-probe
./deps.sh                     # crate counts (section 2)
cargo build --release
B=target/release/runtime-probe-experiment
$B idle-threads 1024 256 32   # RSS per idle thread (section 3)
$B idle-tasks 1024 4          # RSS per idle tokio task
for m in threads tokio-mt tokio-ct poll; do $B relay $m 64 32 64; done
# binary share
CARGO_PROFILE_RELEASE_STRIP=none cargo bloat --release -p gondolin-cli --bin gondolin --crates
```

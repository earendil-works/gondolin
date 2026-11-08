# gondolind: plan and status

See `DESIGN.md` for the architecture. Status markers: `[ ]` todo, `[~]` in
progress, `[x]` done. Every milestone ends with the host tests passing for what it
covers (on both engines while the node engine existed) and a benchmark run
recorded in `host/bench/results/`. The node engine is removed; items that
mention it are history.

Work happens in worktrees under `../gondolin-wt/<agent>` on branches
`native/<agent>` and is merged into `main` by the coordinator. The first team
(`core`, `vfs`, `netstack`, `egress`, `bench`) is archived; current: `hooks`
(tier-2 djs hooks), `djs` (in ~/Development/djs).

## M0: foundations

- [x] Design and plan (`native/DESIGN.md`, `native/PLAN.md`)
- [x] Cargo workspace scaffold with crate seams (`native/`)
- [x] Benchmark harness (`host/bench/`), engine switch via `GONDOLIN_ENGINE`
- [x] Baseline numbers for the node engine (`host/bench/results/SUMMARY.md`;
      the node result files are in git history since the removal)

## M1: core daemon (exec) — done (merged)

- [x] `gondolin-wire`: framing + CBOR, async reader/writer, tests
- [x] `gondolin-proto`: session + exec + file-op messages
- [x] `gondolind`: session, QEMU args (parity test vs `buildQemuArgs`, removed
      with the node engine), private
      socket dir, chardev/netdev listeners, log tail + exit hints, idle pause
      via QMP + clock sync
- [x] Guest control channel: boot config, time sync, exec/stdin/pty/windows,
      `SandboxServer` queueing rules, guest file operations for `vm.fs`
- [x] TS: `host/src/native/{transport,server,config}.ts`, `VMOptions.engine`
- [x] Host suite on the native engine: 696/698 (same as node) after M4 work; was 672/684, failures are SSH/ingress
      (M4); interim VFS = controller `FsRpcService` over `vfs_rpc`, interim
      network = node `QemuNetworkBackend` on an external socket
- [x] Benchmarks: boot and exec latency on par with node
- [x] Exec throughput: non-blocking stdio, batched writes, 64 KiB output
      coalescing, fast-path CBOR in TS, raw-byte stdin (both engines); native
      on par with node, daemon CPU ÷3 (stdout) / ÷2 (stdin); stdin 65 → 105 MB/s

## M2: VFS — done (merged)

- [x] `gondolin-vfs`: sandboxfs RPC host side, mount routing, binds
- [x] Native providers: hardened `host` (openat2 on Linux, fd walk elsewhere),
      hide/readonly layers incl. tmpfs upper, `memory`, `static`
- [x] Object tier: cache with TTL/revalidation, chunked reads/writes, commit on
      close/write; adapter keeps JS providers the source of truth
- [x] Blocking `before` hooks only when registered, async bounded events,
      `fs_call` handle API, `vfs_invalidate`
- [x] TS translation (RealFS/Readonly/Shadow → native, others → object; remote
      → object for controller-local providers), `ObjectProvider`,
      `createObjectMount`, `nativeMounts`
- [x] Full host suite on both engines: 748 tests, 0 failures
- [ ] Commit errors cannot surface at `close()`/`fsync()` over sandboxfs (no
      FLUSH/FSYNC forwarded); fixed by virtio-fs (M7)
- [ ] Benchmarks on a quiet machine (the object tier behind user-visible
      `MemoryProvider` was expected to be slower than the node engine on
      small-file metadata)

## M3: network — done (merged)

- [x] `gondolin-netstack` (smoltcp TCP, ~1.5/1.0 GB/s in-process): Ethernet/ARP/DHCP/IPv4/ICMP echo, TCP (flows as
      streams with backpressure), UDP-DNS (synthetic/trusted/open, per-host
      synthetic mapping)
- [x] `gondolin-egress` (~2.4 GB/s HTTPS in-process): classification (HTTP, TLS, blocked; CONNECT denied),
      HTTP/1.1 bridging with hyper, TLS MITM (SNI, rcgen leaf certs from the
      controller's CA), WebSocket upgrade tunnels, limits, redirects
- [x] Declarative policy: allowlist, internal ranges + DNS rebinding checks at
      connect, secrets (headers incl. Basic auth, optional query), placeholders,
      `policy_update`
- [x] Tier-3 hooks over the pipe with lazy bodies; TS `Request`/`Response`
      reconstruction; `createHttpHooks()` compiles to policy
- [x] Network host tests pass with the native engine (723/723 both engines;
      remote: native net default, daemon CA, known_hosts as content)
- [x] Perf: per-flow smoltcp socket sets, PSH/64 KiB coalescing, 2 s DNS
      cache; interleaved same-minute runs: native ahead on every net workload
      (e.g. HTTP 64 MiB down/up 243–260/264–273 vs node 132–176/91 MB/s)
- [x] Hook latency: small bodies inline with `hook_call`, DNS overlapped with
      onRequest; body-reading hook 1.9–2.0 ms vs node 2.1–2.3 ms (loaded
      machine; confirm on the quiet A/B)
- [x] sshproxy deadlocks fixed (consumption-based windows, separate reader and
      writer tasks; now in our own SSH implementation)

## M4: remaining parity

- [x] SSH egress proxy (VM test `ssh-egress` on both engines)
- [x] Mapped TCP egress (`tcp.hosts`) in egress
- [x] `vm.enableSsh()` / ingress (`fwd_*` relay with credits)
- [x] Disk checkpoints on both VMMs
- [ ] Snapshot/checkpoint restore via QMP
- [x] krun backend (12/12 backend-parity tests)
- [x] macOS watchdog so QEMU dies with a SIGKILLed daemon
- [x] CLI on the native engine (`--engine`, `--native-command`, `--remote`),
      VM-level CLI tests on both engines
- [x] `pnpm test:both`; `engine: "auto"`; `DEFAULT_SANDBOX_ENGINE` constant
      (all superseded by the retirement step 2: `test:both` and the constant
      are gone, `auto` = native)
- [x] Default engine was `auto` (native when a working gondolind was found,
      else node); `GONDOLIN_ENGINE=node` now throws

## M5: remote and packaging

- [x] Asset resolution and download (`gondolin-assets`, shares node's cache)
- [x] `gondolind assets` CLI + image selectors in `configure.vm`
- [x] MITM CA generation in the daemon (node-compatible cache)
- [x] Remote-clean daemon: daemon-side image/rootfs overlay, `native.connect`
      over any duplex (pi-env `openProcess` shape), `assertRemoteConfigure`,
      relay network mode (removed with the node engine);
      `host/scripts/test-native-remote.sh` (54/54)
- [x] Remote checkpoints (daemon-side overlay export/import, node file format)
- [x] Static release builds (musl via zig cc + darwin): `make native-release`
- [x] Linux test runner inside a Gondolin VM: `make native-test-linux`
- [x] Platform npm packages `@earendil-works/gondolin-native-*` + release jobs
      (unpublished; confirm `macos-15-intel` runner label, npm scope setup)
- [x] `getNativeBinaryPath` / `ensureNativeBinary` for remote platforms
- [ ] pi-env integration — deferred by the owner
- [x] Static `gondolin` CLI without Node (bash/exec/list/attach/snapshot/
      image, `--listen`, `--ssh`) on an in-process Rust controller; session
      registry and checkpoints compatible with the node CLI both ways;
      `--print-configure` parity test (15 vectors); multi-call (`gondolin daemon`)
- [x] One binary per platform package (multi-call `gondolin`, SDK starts
      `gondolin daemon`); fat LTO: 10–12 MB static binaries, 5 MB tarballs
- [~] Dependency diet, see M8
- [x] Release readiness without releasing: actionlint-clean workflows,
      retired `macos-14` replaced, image release uses source-built helpers
      (virtio-fs), `scripts/release-dry-run.sh`, `RELEASING.md`
- [x] macOS QEMU: upstream patch ready (`native/docs/qemu-vhost-net-non-linux.patch`)
      + Homebrew formula change recommended (not sent)
- [x] Linux tests in Docker (`make native-test-docker`): cargo arm64 + amd64,
      TCG VMs through the native engine incl. virtio-fs/memfd/openat2/pdeathsig,
      102/103 host test files on native
- [x] Linux with KVM: Lima vz + nestedVirtualization (`make native-test-kvm`);
      410 Rust tests, virtio-fs on stock Ubuntu QEMU 8.2.2; host suites mostly
      pass, remaining failures are timeouts (nested exits ~30 µs, boot 12.8 s)

## M6: djs hooks (tier 2)

- [x] Prototype (`native/experiments/djs-hooks/`, `native/docs/djs-hooks.md`):
      header-only hook 26–33 µs p50 vs 70 µs tier 3; 64 KiB body 20–35 µs vs
      157 µs; fails closed on fuel/memory/exceptions/panics
- [~] djs side (agent `djs` in ~/Development/djs, following djs's own process):
      embedding crate (E1–E7), ES modules (M1–M8), TextEncoder/Decoder (B1),
      byte passing, musl/darwin cross-builds, no third-party deps
- [x] Production `gondolin-hooks-djs` on djs-embed (git rev 9cc1291, behind
      `engine.rs`): `configure.net.djs_hooks`, `createDjsHooks()`, `--hooks-script`,
      tier order declarative → djs → controller; 0.23 ms vs 0.29 ms (tier 3) vs
      0.58 ms (node) per hooked request; +1.8 MB binary (feature `djs-hooks`);
      third-party budget unchanged (djs counted as first-party)
- [x] djs pin 0e58f62c; pooled instances shrink to 1 MiB after reset instead
      of being dropped; TypeScript and JSON policies; CLIs (and
      `djsHooksOptionsFromFile`) load relative imports from disk into the
      in-memory module map
- [ ] TypeScript `./x.js` → `x.ts` import mapping (NodeNext convention)
- [ ] Clean tier-2 vs tier-3 VM benchmark on a quiet machine
- [ ] djs: ES modules (requirements M1–M8; esbuild bundling as interim) and
      builtins B1–B3
- [x] Profile byte passing and hook cost (ASCII/UTF-8 fast path found)

## M7: faster guest filesystem transport — done (merged)

- [x] Feasibility study and prototype (`native/docs/virtio-fs.md`)
- [x] `FsCore` inode layer shared by sandboxfs and virtio-fs; 4 request queues;
      zero-copy reads into guest memory
- [x] QEMU probe (cached), shm/memfd guest RAM, `vhost-user-fs` device; guest
      `sandboxfs --virtiofs` with sandboxfs fallback; old images keep working
- [x] FLUSH/FSYNC commit object-tier writes → errors at `close()`/`fsync()`
- [x] Measured (loaded machine): metadata 1.8–4.4×, large I/O 10–14× vs sandboxfs
- [x] Directory fd cache for host mounts (hardened, 1 s TTL, LRU 256);
      FLUSH no longer fsyncs (creates 5.4 s → 0.66 s); one-copy writes;
      object reads 3 MiB ranges + opt-in `inlineMaxBytes`
- [ ] Released sandbox helpers with `--virtiofs` (needs a helper release)
- [ ] macOS: a QEMU with vhost-user (Homebrew lacks it; build fix upstream)
- [x] virtio-fs on krun: patched libkrun forwards FUSE over a socket
      (`krun_add_virtiofs_socket`); 1.8–3.5× faster than sandboxfs on macOS
- [ ] krun virtio-fs: zero-copy (read/write guest memory from the socket),
      pipelined requests, upstream the libkrun patch

## Node engine retirement

- [x] Step 1: `engine: "node"` deprecated (one-time warning), `fetch` narrowed
      (no longer switches native egress to JS), interim fallbacks internal
- [x] CI: `native` job (check, tests, release build) and one `test` job
      (guest tests, virtio-fs check, full host suite on the native engine
      with `GONDOLIN_VMM=qemu`, sandboxfs fallback run on stock Ubuntu
      QEMU/KVM); the deprecated node-engine job is gone
- [x] x86_64 `microvm` (MMIO vhost-user-fs, memory-backend) and q35 + virtio-fs
      boot and pass under TCG on QEMU 8.2.2 (GitHub's) and 10.0 (`make
      native-test-docker PHASES=vm-x64`)
- [ ] First real CI run with KVM (not pushed yet)
- [x] Step 2: the node engine and the fallback modes are removed; `auto` =
      native; test-both dropped. The SDK's in-process sandbox server,
      network stack and `FsRpcService` are deleted (`SandboxServer` and
      `FsRpcService` are no longer exported), the daemon accepts only
      `vfs`/`net` mode `native` (`vfs_proxy.rs`, `net_relay.rs`, `vfs_rpc`,
      `netdev_*` deleted), `engine: "node"` throws, a missing `gondolind` is
      an error instead of a fallback, `VMOptions.fetch` is ignored; the TS
      fuzz targets for DNS, network and virtio went with the code (the Rust
      side is fuzzed by `native/fuzz`); bench variants are native-only

## M8: dependency diet — done (249 → 26 runtime crates)

Decision: keep tokio with minimal features (`native/docs/runtime-without-tokio.md`).
Every replacement is a sans-io protocol core plus a thin tokio adapter, fuzzed
like the code it replaces. `make -C native deps` enforces the budget (CI job).

- [x] Own exec-only SSH over ring replaces russh (OpenSSH interop both ways)
- [x] MITM CA via ring; own x509 writer instead of rcgen/x509/asn1/time
- [x] `gondolin-http` (sans-io HTTP/1.1 + rustls adapter) instead of hyper,
      reqwest, tower, tokio-rustls; `gondolin_http::url` instead of url/idna
- [x] Own CBOR/JSON codec + `wire_struct!`/`wire_enum!`/`wire_tagged!`
      instead of serde/ciborium/serde_json; `gondolin-log` instead of tracing;
      no proc macros, async-trait, thiserror, futures, lru, indexmap, base64
- [x] Own tar reader + gzip over miniz_oxide; own system-root loader; libc
      instead of rustix; tokio trimmed (rt, net, time, sync, io-util)
- [x] Result: 26 crates on all four targets (tokio/mio/socket2/
      pin-project-lite/bytes, libc/cfg-if, ring/untrusted/getrandom, rustls/
      webpki/pki-types/subtle/zeroize/once_cell, webpki-roots, miniz_oxide/
      adler2, smoltcp + 6 helpers); Cargo.lock 332 → 131 packages; release
      binary 10.2 → 6.2 MB (aarch64)
- [x] Post-diet validation: Docker Linux (arm64, amd64 emulated, TCG VMs incl.
      x86_64 microvm, whole host suite 760/0), Linux VM tests 32/32, 18 fuzz
      targets × 5 min clean, release dry run incl. krun; fixed native resume
      from locally built images
- [x] Post-diet perf: no regression. Same-run A/B of pre-diet (510d126) vs
      post-diet binaries: concurrent execs 5.3k vs 5.9k/s, sandboxfs equal; the
      gaps in SUMMARY.md compared runs at different load (use
      `--interleave native-prev,native` with several rounds)
- [ ] Optional: smoltcp's 6 unconditional helpers (trimmed vendor or own TCP)
- [ ] Optional: fewer thread handoffs per sandboxfs request (virtio-fs is the
      fast path; sandboxfs suffers most under host load)

## Hardening

- [x] cargo-fuzz targets for every guest-facing parser (`make native-fuzz`);
      found and fixed a guest-triggerable panic (Basic auth slicing)
- [x] Security review (`native/docs/security-review.md`); fixed decompression
      bomb in controller-side hook decoding and `__proto__` in CBOR→JS
- [x] Panic containment: unwind in release, flows reset, requests answer
      errors, session/netstack-driver panics fail closed (+1.6 MB binary)
- [x] IPv6 transition formats (NAT64, 6to4, Teredo, mapped) checked for
      embedded internal IPv4 in both engines

## Guest

- [x] rngd removed (the kernel's hwrng thread credits virtio-rng entropy; crng
      ready before userspace): QEMU CPU in the first 15 s after boot 22 s → 1 s
      on both engines; reaches users with the next image release

## Node-engine issues found along the way (fixed)

- stdin had no backpressure in `vm.exec`: `stdin_ack` credits, `write()`/`drain()`
- `rm -rf` on sandboxfs mounts left entries (readdir cookies vs unlink)
- `MemoryProvider` writes copied the whole buffer on every extend
- body-reading hooks pinned large receive buffers (5.4 GB RSS → 361 MB);
  `Expect: 100-continue` uploads through the node bridge failed with 502
- WebSocket upgrade only tried the first allowed address
- SSH egress lost exec results from fast upstreams

## Log

- 2026-09: plan written; M0 scaffold and gondolin-wire on main; agents
  bench, core, vfs, netstack, egress started.

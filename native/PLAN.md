# gondolind: plan and status

See `DESIGN.md` for the architecture. Status markers: `[ ]` todo, `[~]` in
progress, `[x]` done. Every milestone ends with tests passing on both engines
for what it covers and a benchmark run recorded in `host/bench/results/`.

Work happens in worktrees under `../gondolin-wt/<agent>` on branches
`native/<agent>` and is merged into `main` by the coordinator. Owners: `core`
(gondolind session/QEMU/exec, TS transport), `vfs`, `netstack`, `egress`,
`bench`.

## M0: foundations

- [x] Design and plan (`native/DESIGN.md`, `native/PLAN.md`)
- [x] Cargo workspace scaffold with crate seams (`native/`)
- [x] Benchmark harness (`host/bench/`), engine switch via `GONDOLIN_ENGINE`
- [x] Baseline numbers for the node engine (`host/bench/results/SUMMARY.md`)

## M1: core daemon (exec) — done (merged)

- [x] `gondolin-wire`: framing + CBOR, async reader/writer, tests
- [x] `gondolin-proto`: session + exec + file-op messages
- [x] `gondolind`: session, QEMU args (parity test vs `buildQemuArgs`), private
      socket dir, chardev/netdev listeners, log tail + exit hints, idle pause
      via QMP + clock sync
- [x] Guest control channel: boot config, time sync, exec/stdin/pty/windows,
      `SandboxServer` queueing rules, guest file operations for `vm.fs`
- [x] TS: `host/src/native/{transport,server,config}.ts`, `VMOptions.engine`
- [x] Host suite on the native engine: 696/698 (same as node) after M4 work; was 672/684, failures are SSH/ingress
      (M4); interim VFS = controller `FsRpcService` over `vfs_rpc`, interim
      network = node `QemuNetworkBackend` on an external socket
- [ ] Benchmarks: boot, exec latency/throughput, both engines

## M2: VFS — vfs: crate in progress, then native mode replacing the interim `vfs_rpc` proxy

- [ ] `gondolin-vfs`: sandboxfs RPC host side (spec §6), mount routing, binds
- [ ] Native providers: `host` (hardened passthrough, hide rules, readonly,
      tmpfs upper), `memory`, `static`
- [ ] Object tier: cache, fetch on open, commit on flush/fsync/release, errors at
      close, invalidation, chunked large files
- [ ] `vfs_event` stream, controller `fs_call` API, `vm.fs` on native mounts
- [ ] TS: provider translation, `ObjectProvider` + adapter for `VirtualProvider`,
      native mount descriptors
- [ ] VFS host tests pass with the native engine
- [ ] Benchmarks: metadata ops, small files, large files per mount kind

## M3: network — done (merged); throughput tuning in progress (netstack)

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
- [ ] Benchmarks: HTTP/HTTPS latency + throughput, hook round trip (first
      look: native ~100 MB/s vs node 217/183 MB/s download — being fixed)

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
- [ ] Flip the default to `auto` (after native VFS + egress land and benchmarks)

## M5: remote and packaging

- [x] Asset resolution and download (`gondolin-assets`, shares node's cache)
- [x] `gondolind assets` CLI + image selectors in `configure.vm`
- [x] MITM CA generation in the daemon (node-compatible cache)
- [x] Remote-clean daemon: daemon-side image/rootfs overlay, `native.connect`
      over any duplex (pi-env `openProcess` shape), `assertRemoteConfigure`,
      relay network mode; `host/scripts/test-native-remote.sh` (54/54)
- [x] Remote checkpoints (daemon-side overlay export/import, node file format)
- [x] Static release builds (musl via zig cc + darwin): `make native-release`
- [x] Linux test runner inside a Gondolin VM: `make native-test-linux`
- [x] Platform npm packages `@earendil-works/gondolin-native-*` + release jobs
      (unpublished; confirm `macos-15-intel` runner label, npm scope setup)
- [x] `getNativeBinaryPath` / `ensureNativeBinary` for remote platforms
- [ ] pi-env integration: deploy `gondolind` with the daemon, start via
      `openProcess`, SDK over that connection

## M6: djs hooks (tier 2)

- [x] Prototype (`native/experiments/djs-hooks/`, `native/docs/djs-hooks.md`):
      header-only hook 26–33 µs p50 vs 70 µs tier 3; 64 KiB body 20–35 µs vs
      157 µs; fails closed on fuel/memory/exceptions/panics
- [ ] Production `gondolin-hooks-djs` crate — blocked on a stable `djs-embed`
      crate (requirements E1–E7 in the doc)
- [ ] djs: ES modules (requirements M1–M8; esbuild bundling as interim) and
      builtins B1–B3
- [x] Profile byte passing and hook cost (ASCII/UTF-8 fast path found)

## M7: faster guest filesystem transport

- [x] Feasibility study (`native/docs/virtio-fs.md`): feasible; prototype
      `gondolin-virtiofs` is 3–5× faster on metadata, 14–20× on large I/O
      (macOS, needs a QEMU built with `--enable-vhost-user`)
- [ ] Put `gondolin-vfs` behind the virtio-fs `FileSystem` trait; multi-queue,
      zero-copy, handle-based inode table; QEMU + guest mount wiring with
      sandboxfs fallback (probe `-device help`)
- [ ] macOS: Homebrew/QEMU build fix or a shipped QEMU

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

# Engine benchmarks

Workloads that run against both host engines (`node`, the in-process
TypeScript engine, and `native`, `gondolind`) to track the performance impact
of the move to the native engine. See `native/DESIGN.md` ("Benchmarks").

## Running

From `host/`:

```bash
node bench/run.ts                          # all suites, node engine
GONDOLIN_ENGINE=native node bench/run.ts   # same against gondolind
node bench/run.ts --engine native --suite boot,exec
node bench/run.ts --quick                  # smoke run: fewer iterations, smaller payloads
node bench/run.ts --suite vfs --filter large-read
node bench/run.ts --interleave node,native # alternate engines per workload group
node bench/run.ts --summary-only           # regenerate results/SUMMARY.md
```

Options:

| flag | meaning |
|---|---|
| `--engine node\|native` | engine (default: `GONDOLIN_ENGINE`, else `node`) |
| `--interleave node,native` | run both engines, alternating per workload group |
| `--suite a,b` | suites to run: `boot`, `exec`, `vfs`, `net` (default: all) |
| `--quick` | at most 1 warmup and 3 iterations, smaller payloads |
| `--iterations N` | override measured iterations of every workload |
| `--filter regex` | only workloads whose name matches (setup of unmatched groups is skipped) |
| `--out dir` | results directory (default: `bench/results`) |
| `--note text` | caveat stored with the run and shown in SUMMARY.md (with `--interleave`: native runs only) |
| `--no-save` | print only, write nothing |

A full run takes roughly 10 minutes on an M-series Mac. Requires the same
setup as the VM tests (QEMU with HVF/KVM, guest image available).

## Results

Each suite run writes `results/<engine>-<suite>[-quick]-<timestamp>.json`:
machine info (CPU, OS, node and QEMU versions, git commit), and per workload
its parameters, warmup/iteration counts, raw samples and statistics (median,
p95, min, max, mean) per metric, resource cost, and the error if it failed.
`results/SUMMARY.md` is regenerated after every run from the latest complete
(non-quick, unfiltered) run per engine and suite, with node and native side by
side and a native/node ratio. Commit full runs; quick runs are for smoke tests.

Metrics:

- `wallMs`: host wall time of one iteration (includes the exec round trip).
- `guestMs`: time measured inside the guest (python `perf_counter_ns` around
  the operation). Preferred over `wallMs` in the summary when present.
- `requestMs`: per-request latency measured by the guest HTTP client.
- `MBps`, `execsPerSec`, `requestsPerSec`: throughput derived from the above.
- cost (`cost: true` workloads, i.e. throughput ones): cpu time and sampled
  peak RSS of this node process (`host`) and of the engine processes over the
  measured iterations. Engine processes are `VM.getHostPid()` plus its
  descendants (QEMU on the node engine; `gondolind` and its QEMU on the native
  engine) or `vm.getEnginePids()` if the VM provides it. Note that the host
  process also runs the local HTTP upstreams of the net suite, and QEMU cpu
  includes guest cpu time.

## Noise

Run on an otherwise idle machine; `machine.loadAvg` is recorded per run. On
Apple silicon, run-to-run variance of throughput workloads is large (up to
~40% between runs, likely from QEMU threads landing on performance vs.
efficiency cores) even when the iterations within a run agree. Compare engines
with runs taken back to back, and repeat a suite (`--suite net --filter ...`)
before trusting a small difference.

## Suites

- `boot`: fresh VM per iteration: `VM.create` until `exec("true")` returns,
  plus `close()` time.
- `exec`: one VM. Sequential `exec("true")` (login shell) and `["/bin/true"]`
  round trips, 16 concurrent execs, stdout throughput (`dd` of 256 MiB to a
  consumed `stdout: "pipe"` stream), stdin throughput (256 MiB from an async
  iterable into `wc -c`).
- `vfs`: one VM with every mount kind: guest tmpfs (reference),
  `MemoryProvider`, `RealFSProvider`, `ShadowProvider(RealFSProvider)`,
  `ReadonlyProvider(RealFSProvider)` and a JS delegating provider standing in
  for the object tier. Per kind: create+write 1000 x 4 KiB files, stat and read
  them, `scandir` of a 5000 entry directory, `find`/`ls -lR` of a 2000 file
  source-like tree, untar of that tree, large sequential write (`dd
  conv=fsync`) and read. Guest caches are dropped before read workloads. Large
  files are 256 MiB, 64 MiB on memory-backed mounts.
- `net`: local HTTP and HTTPS upstreams in this process on `localhost`
  (127.0.0.1 and ::1); the guest connects to an arbitrary external address and
  sends `Host`/SNI `localhost`, which the host resolves and allows through
  `allowedInternalHosts`. The upstream certificate is issued by a throwaway CA added to
  this process' default CA store. One VM per hook variant: `policy`
  (`createHttpHooks({ allowedHosts, allowedInternalHosts })`, full workload
  set), `ip-allow` (`{ isIpAllowed: () => true }`), `policy-noop-hooks` and
  `policy-body-hooks` (onRequest/onResponse reading cloned bodies). Workloads:
  sequential small GETs with a new connection each and with keep-alive,
  8-way concurrent GETs, 32 MiB download/upload, 256 MiB download.

## Engine processes and checks

`--engine native` passes `engine: "native"` to `VM.create` (never for `node`)
and refuses to run unless the VM reports `engine === "native"` and its daemon
pid is a `gondolind` process (bypass with `GONDOLIN_BENCH_SKIP_ENGINE_CHECK=1`).
Set `GONDOLIN_NATIVE_BIN` to the binary under test and `GONDOLIN_GUEST_DIR` so
both engines boot the same image (both are recorded in the results).

Cost accounting covers the daemon (`getDaemonPid()` on the native server) and
`VM.getHostPid()` (QEMU on both engines), each with its descendants.

`--interleave node,native` runs each suite slice by slice (per workload group,
see `SLICES` in `run.ts`), alternating engines, so both see the same machine
load; each workload records the 1-minute load average when it started, shown in
`SUMMARY.md`. Prefer it whenever comparing engines.

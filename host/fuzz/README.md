# Host-side fuzzing

This directory contains lightweight, deterministic fuzzers for the TypeScript host.

These fuzzers cover **host-side TypeScript parsers that consume untrusted input**
(tar parsing, SSH exec request parsing). The guest protocol, network stack and
DNS parsing live in the native engine and are fuzzed with cargo-fuzz
(`make native-fuzz`, `native/fuzz`).

## Run

From the repo root:

```bash
make fuzz-host                           # default target (tar), runs forever
make fuzz-host HOST_FUZZ_TARGET=ssh-exec # a single target, runs forever
```

Or directly:

```bash
cd host
pnpm run fuzz -- tar
pnpm run fuzz -- ssh-exec

# bounded run
pnpm run fuzz -- tar --iters 50000
```

## Repro

When a fuzzer crashes it writes an artifact to:

```
host/fuzz/artifacts/<target>/...
```

You can replay it:

```bash
cd host
pnpm run fuzz -- <target> --repro ./fuzz/artifacts/<target>/<file>.bin
```

## Tuning

- `--iters N` number of iterations (default: runs forever; `--iters 0` also runs forever)
- `--seed N` deterministic RNG seed (default: 1)
- `--max-len N` max input length (default: target-specific)

For longer runs, just omit `--iters` (default) or set a higher iteration count.

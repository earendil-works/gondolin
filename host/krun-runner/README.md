# gondolin-krun-runner

Small host-side helper binary for running Gondolin guests with `libkrun`.

## Build

Preferred (repo root):

```bash
make krun-runner
```

This stages `libkrun` under `.cache/libkrun-install/<version>`, extracts a
libkrunfw-compatible kernel under `~/.cache/gondolin/krun/libkrunfw/`, and
builds the runner with bundled shared libraries under
`host/krun-runner/zig-out/lib/`.

Manual build:

```bash
cd host/krun-runner
zig build -Doptimize=ReleaseSafe -Dlibkrun-prefix=/path/to/libkrun/prefix
```

Binary output:

- `zig-out/bin/gondolin-krun-runner`

## Usage

The host controller spawns this binary with:

```bash
gondolin-krun-runner --config /path/to/config.json
```

Use with Gondolin:

- `sandbox.vmm = "krun"`
- optionally set `sandbox.krunRunnerPath`
- or set `GONDOLIN_KRUN_RUNNER`

## Notes

- Runner is linked against `libkrun` and uses an rpath that prefers bundled libs
- The krun backend expects a libkrunfw-compatible kernel image (Gondolin auto-detects the cache populated by `make krun-runner`)
- Currently experimental

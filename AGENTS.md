# Agent Notes

Start by reading `README.md` in the repo root for the current status, repo layout, and next steps.

## Repo Layout

- `guest/` — Zig-based `sandboxd` daemon and Alpine initramfs build (cross-compiled, targets aarch64/x86_64 Linux)
- `host/` — TypeScript host controller, networking stack, VFS, and CLI (`pnpm` workspace)
- `native/` — the native host engine (Rust workspace): the `gondolind` daemon and the static `gondolin` CLI, shipped as one multi-call binary; see `native/DESIGN.md` and `native/PLAN.md`
- `scripts/` — Build tooling (`run-parallel` etc.)
- `docs/` — User documentation (the site built by `make docs`)
- `host/examples/` — Usage examples

## Building & Testing

```bash
make build      # Build everything (guest + host + native)
make check      # Lint + typecheck (guest + host + native)
make test       # Run all tests
```

Host tests run with Node's built-in test runner in strip-only TypeScript mode:

```bash
cd host && pnpm test              # All host tests
cd host && node --test test/specific.test.ts  # Single test
```

Guest builds use Zig (`zig build`). The image builder is in TypeScript (`host/src/build/alpine.ts`).

The native workspace builds with cargo (`make native`, `make native-test`,
`make native-check`). `make native-check` includes `make -C native deps`, which
fails when the `gondolin` binary pulls in more third-party crates than
`native/deps-budget` allows; see "Dependency diet conventions" in
`native/DESIGN.md` before adding a dependency.

### Documentation

```bash
make docs        # Build docs/ into site/ (scripts/docs/build.py)
make serve-docs  # Serve on http://127.0.0.1:8000/, rebuilding on change
```

The navigation lives in `docs/SUMMARY.md`; a page missing from it is not built.
The theme (shared with Earendil's other docs) lives in `scripts/docs/assets/`;
Elanor's tokens and fonts come from npm, pinned in `scripts/docs/elanor.json`
(`scripts/docs/build.py update-elanor`).

## Version Updates & Releases

When preparing a package release, keep all package versions in sync with the release tag:

1. Move relevant `CHANGELOG.md` entries from `## Unreleased` into a new `## X.Y.Z` section, leaving `## Unreleased` in place at the top.
2. Update `host/package.json` `version` to `X.Y.Z`.
3. Update `host/package.json` `optionalDependencies` for `@earendil-works/gondolin-krun-runner-*` and `@earendil-works/gondolin-native-*` to `X.Y.Z`.
4. Update the `version` fields of `packages/gondolin-krun-runner-darwin-arm64/package.json`, `packages/gondolin-krun-runner-linux-x64/package.json` and the four `packages/gondolin-native-{darwin-arm64,darwin-x64,linux-arm64,linux-x64}/package.json` to `X.Y.Z`, and `[workspace.package] version` in `native/Cargo.toml` (it is what `gondolind --version` reports).
5. Run `pnpm install --lockfile-only` from the repo root to refresh `pnpm-lock.yaml`, and `cargo update --workspace` in `native/` to refresh `native/Cargo.lock`.
6. Run at least `make check`; run `make test` when practical, and `scripts/release-dry-run.sh --strict` (packs and installs every npm package and boots VMs from them without publishing; see `RELEASING.md` for the full order including the image release).
7. Commit the version/changelog/lockfile changes, then create and push the tag `vX.Y.Z`.
8. Watch the Release workflow complete. It creates the package release, publishes sandbox helper bundles to `sandbox-helpers--X.Y.Z`, updates `builtin-sandbox-helper-registry.json` on `main`, publishes optional krun runner packages, cross-builds the multi-call `gondolin` (static CLI + `gondolind` daemon) for all platforms on macOS (`make native-release`) and publishes the `gondolin-native-*` packages, then publishes the main npm package.

The package release workflow is tag-driven (`.github/workflows/release.yml`) and verifies that package versions match `vX.Y.Z` before publishing. The main package must not be published until the exact `gondolin:X.Y.Z` sandbox helper registry entry exists; the workflow enforces this by making npm publish depend on the sandbox helper release and registry update. If the helper/registry step needs recovery, dispatch `.github/workflows/sandbox-helpers-release.yml` for `X.Y.Z`/`vX.Y.Z` and wait for the registry commit on `main` before rerunning npm publication. Image releases are separate and are run via the Image Release workflow; do not update package versions for image-only releases. If a release was already published without a changelog entry, add a follow-up `CHANGELOG.md` commit on `main` instead of retagging or republishing.

## Key Conventions

- **TypeScript:** The host package uses Node's strip-only TypeScript support for running `.ts` files directly; see `host/tsconfig.json` (`erasableSyntaxOnly`). Tests use Node's built-in test runner (`node:test`).
- **Zig version:** 0.17.0 (see `guest/build.zig.zon`).
- **Package manager:** pnpm (workspace root + `host/` package).

### Field comments (TS interfaces/types + Zig structs)

Add field comments when the meaning isn’t obvious, especially for **exported/public types**, **host↔guest/protocol/config/on-disk formats**, and anything with **units/encoding**, **sentinel values**, or **invariants**. Skip comments for truly self-explanatory internal fields.

Use `/** … */` above TS properties and `/// …` above Zig fields. Keep comments **one line**, **noun-phrase style**, **no period**, and include units in backticks (e.g. `ms`, `bytes`). Put longer rationale on the struct/type doc comment, not per-field.

## Working with Tests

- Tests are in `host/test/*.test.ts` with shared helpers in `host/test/helpers/`.
- VM integration tests require hardware acceleration (macOS HVF or Linux KVM). Use `shouldSkipVmTests()` from `host/test/helpers/vm-fixture.ts` to gate them.
- Unit tests that don't need a VM should not import VM fixtures. Keep them fast and isolated.
- The test timeout in CI is 120s for VM tests. If adding slow tests, be mindful of this limit.
- Linux without a Linux machine: `make native-test-docker` (Docker Desktop is enough, no KVM needed) runs the native workspace tests on linux/arm64 and emulated linux/amd64, boots native-engine VMs under QEMU TCG (virtio-fs, openat2 mounts, DNS, PDEATHSIG) and runs host tests with `GONDOLIN_ENGINE=native` (`HOST_TESTS=all` for the whole suite, ~4 min). It needs an aarch64 image with source-built helpers in `guest/image/out` (`GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE=1 make -C guest build`; published helpers lack virtio-fs); see `native/scripts/test-linux-docker.sh`. The optional phase `make native-test-docker PHASES=vm-x64` boots the x86_64 CI configuration (forced `microvm` with vhost-user-fs-device, and q35) under TCG with Ubuntu 24.04's QEMU; it needs an x86_64 image in `guest/image/out-x86_64`.

- Linux with real KVM on this Mac (M3 or newer, macOS 15+): `make native-test-kvm` runs the tests in a Lima VM (`vmType: vz` with nested virtualization, so the Ubuntu 24.04 guest kernel runs at EL2 and has `/dev/kvm`; Ubuntu's stock QEMU 8.2, virtio-fs works). `native/scripts/linux-kvm-vm.sh` creates and provisions the VM on first use (QEMU, node, pnpm, rust, zig 0.17, uv; `native/scripts/lima/gondolin-kvm.yaml`), mounts the repo read-only and builds in `~/gondolin` inside the VM (`sync`, `image`, `test [cargo host-both host-native virtiofs bench]`, `run <cmd>`, `shell`, `stop`, `delete`; `make native-test-kvm SUITES=cargo`). Nested guests are slow: every VM exit costs ≥30 µs, a boot takes ~12 s (0.6 s on the Mac), so use it for correctness, not timings; the script raises the startup timeouts (`GONDOLIN_START_TIMEOUT_MS` etc.) and a few host tests with fixed 60–120 s test timeouts still time out there.

## CI Notes

- CI runs on GitHub Actions (Ubuntu). Guest is cross-compiled for both aarch64 and x86_64.
- KVM is enabled on CI runners for VM tests.

## Important: Preserving Working Tree Changes

**Do NOT run `git checkout` or `git restore` on files without explicit user approval.** If you notice uncommitted changes that seem unrelated to your task, ask the user before discarding them. Previous sessions have had agents accidentally reset intentional working-tree changes.

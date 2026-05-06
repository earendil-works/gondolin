# Agent Notes

Start by reading `README.md` in the repo root for the current status, repo layout, and next steps.

## Repo Layout

- `guest/` — Zig-based `sandboxd` daemon and Alpine initramfs build (cross-compiled, targets aarch64/x86_64 Linux)
- `host/` — TypeScript host controller, networking stack, VFS, and CLI (`pnpm` workspace)
- `scripts/` — Build tooling (`run-parallel` etc.)
- `docs/` — Additional documentation (custom images, etc.)
- `examples/` — Usage examples

## Building & Testing

```bash
make build      # Build everything (guest + host)
make check      # Lint + typecheck (guest + host)
make test       # Run all tests
```

Host tests run with Node's built-in test runner in strip-only TypeScript mode:

```bash
cd host && pnpm test              # All host tests
cd host && node --test test/specific.test.ts  # Single test
```

Guest builds use Zig (`zig build`). The image builder is in TypeScript (`host/src/build/alpine.ts`).

## Version Updates & Releases

When preparing a package release, keep all package versions in sync with the release tag:

1. Move relevant `CHANGELOG.md` entries from `## Unreleased` into a new `## X.Y.Z` section, leaving `## Unreleased` in place at the top.
2. Update `host/package.json` `version` to `X.Y.Z`.
3. Update `host/package.json` `optionalDependencies` for `@earendil-works/gondolin-krun-runner-*` to `X.Y.Z`.
4. Update `packages/gondolin-krun-runner-darwin-arm64/package.json` and `packages/gondolin-krun-runner-linux-x64/package.json` `version` fields to `X.Y.Z`.
5. Run `pnpm install --lockfile-only` from the repo root to refresh `pnpm-lock.yaml`.
6. Run at least `make check`; run `make test` when practical.
7. Commit the version/changelog/lockfile changes, then create and push the tag `vX.Y.Z`.

The package release workflow is tag-driven (`.github/workflows/release.yml`) and verifies that package versions match `vX.Y.Z` before publishing. Image releases are separate and are run via the Image Release workflow; do not update package versions for image-only releases. If a release was already published without a changelog entry, add a follow-up `CHANGELOG.md` commit on `main` instead of retagging or republishing.

## Key Conventions

- **TypeScript:** The host package uses Node's strip-only TypeScript support for running `.ts` files directly; see `host/tsconfig.json` (`erasableSyntaxOnly`). Tests use Node's built-in test runner (`node:test`).
- **Zig version:** 0.16.0 (see `guest/build.zig.zon`).
- **Package manager:** pnpm (workspace root + `host/` package).

### Field comments (TS interfaces/types + Zig structs)

Add field comments when the meaning isn’t obvious, especially for **exported/public types**, **host↔guest/protocol/config/on-disk formats**, and anything with **units/encoding**, **sentinel values**, or **invariants**. Skip comments for truly self-explanatory internal fields.

Use `/** … */` above TS properties and `/// …` above Zig fields. Keep comments **one line**, **noun-phrase style**, **no period**, and include units in backticks (e.g. `ms`, `bytes`). Put longer rationale on the struct/type doc comment, not per-field.

## Working with Tests

- Tests are in `host/test/*.test.ts` with shared helpers in `host/test/helpers/`.
- VM integration tests require hardware acceleration (macOS HVF or Linux KVM). Use `shouldSkipVmTests()` from `host/test/helpers/vm-fixture.ts` to gate them.
- Unit tests that don't need a VM should not import VM fixtures. Keep them fast and isolated.
- The test timeout in CI is 120s for VM tests. If adding slow tests, be mindful of this limit.

## CI Notes

- CI runs on GitHub Actions (Ubuntu). Guest is cross-compiled for both aarch64 and x86_64.
- KVM is enabled on CI runners for VM tests.

## Important: Preserving Working Tree Changes

**Do NOT run `git checkout` or `git restore` on files without explicit user approval.** If you notice uncommitted changes that seem unrelated to your task, ask the user before discarding them. Previous sessions have had agents accidentally reset intentional working-tree changes.

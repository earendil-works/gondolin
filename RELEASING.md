# Releasing Gondolin

This expands the checklist in `AGENTS.md` ("Version Updates & Releases"). It
covers the order of the steps, what each workflow publishes, and what the next
release needs for virtio-fs.

## Before tagging

1. **Bump versions.** Follow steps 1–5 in `AGENTS.md`:
   - CHANGELOG section
   - `host/package.json` and its `optionalDependencies`
   - all six `packages/*/package.json`
   - `native/Cargo.toml`
   - `pnpm install --lockfile-only` and `cargo update --workspace`
2. **Dry run.** Run `scripts/release-dry-run.sh --strict`. It does
   everything the Release workflow does except publishing:
   - checks version consistency
   - builds and checks the guest helpers (`sandboxfs --virtiofs`)
   - runs `make native-release`, the host build and `make krun-runner`
   - prepares and packs all npm packages into a temp dir
   - installs them into a scratch project
   - runs `gondolin --version`, `gondolind --version` (the npm bin alias of
     the multi-call binary), the static CLI's `--version` and
     `gondolin-krun-runner --version`
   - boots VMs with the node and native engines and with the static CLI
     (qemu, plus krun on a krun host) from the installed packages

   It needs no credentials and touches nothing remote; packages come from
   the npm registry. `--keep --out DIR` keeps the tarballs.
3. **Checks.** Run `make check` (and `make test` if practical). Also run
   `actionlint` on `.github/workflows/*.yml`; see "Workflow validation"
   below.
4. **Commit and tag.** Commit, then create and push the tag `vX.Y.Z`.

## What the Release workflow does, in order

`release.yml` runs on the `v*` tag:

1. **`create-release`.** Creates the GitHub release `vX.Y.Z`.
2. **`publish-sandbox-helpers`.** Calls `sandbox-helpers-release.yml`:
   - Builds the guest helpers from the tag with Zig 0.17, for `aarch64` and
     `x86_64`.
   - Fails unless `sandboxfs` supports `--virtiofs`.
   - Uploads them to the release `sandbox-helpers--X.Y.Z`.
   - Commits the `gondolin:X.Y.Z` entry to `builtin-sandbox-helper-registry.json`
     on `main`.
3. **`build-native`, `publish-native`, `publish-krun-runner`.** These run in
   parallel once the helpers are out:
   - `build-native` (macos-15) cross-builds the multi-call `gondolin` (static
     CLI and `gondolind` daemon) for the four targets (`make native-release`).
   - `publish-native` packs, smoke-tests (`gondolind --version`,
     `gondolin daemon --version`, `gondolin --version`) and publishes
     `@earendil-works/gondolin-native-*`, each on a runner of its own
     platform. The darwin-x64 package runs on `macos-15-intel`.
   - `publish-krun-runner` builds and publishes
     `@earendil-works/gondolin-krun-runner-{darwin-arm64,linux-x64}`.
4. **`publish-npm`.** Publishes `@earendil-works/gondolin` last, after
   checking that every `optionalDependencies` version matches the tag.

`gondolin build` resolves the helpers for the package version through the
registry on `main`. The main package therefore must not be published before
`gondolin:X.Y.Z` is registered, which the job dependencies enforce.

**Recovery:**
- **Helpers or registry failed:** dispatch `sandbox-helpers-release.yml`
  with `X.Y.Z` / `vX.Y.Z`. Wait for the registry commit on `main`, then
  re-run the failed jobs of the Release run.
- **A platform package failed:** re-run that job. Already-published
  versions can't be republished, so never retag a version that reached npm.

## Images (separate, after the package release)

Guest images are released with the **Image Release** workflow (manual
dispatch) and are not tied to package versions. Run it after the package
release, with `source_ref: vX.Y.Z` and a new `image_tag`. It updates
`builtin-image-registry.json` on `main`, both `alpine-base:<tag>` and
`alpine-base:latest`, which runtime image resolution reads.

The image carries the helpers and `/init` of `source_ref`. The workflow:
- builds the helpers from that source;
- checks `sandboxfs --virtiofs`;
- passes `GONDOLIN_SANDBOX_HELPERS_DIR=guest/zig-out`, as CI does.

Without `GONDOLIN_SANDBOX_HELPERS_DIR`, `gondolin build` would download the
*published* helpers for `host/package.json`'s version. That is what the
workflow did before this change: images built from `main` before a package
release would have shipped the previous release's `sandboxfs`, without
virtio-fs.

### virtio-fs in the next release

What has to happen for users to get virtio-fs (native engine,
`vhost-user-fs`):

1. **Package release `vX.Y.Z`** (above). Helpers `gondolin:X.Y.Z` include
   `sandboxfs --virtiofs`, so custom images built with `gondolin build` after
   the release get it.
2. **Image Release from `vX.Y.Z`.** This is the step that matters for most
   users: the default `alpine-base:latest` image must contain the new
   `sandboxfs` and the new `/init` (`sandboxfs.virtiofs=` boot flag).
3. **Nothing else is needed.** Older images keep working: the native engine
   probes for the guest's support and falls back to sandboxfs. The same goes
   for hosts whose QEMU lacks `vhost-user-fs-pci`, which includes Homebrew's
   QEMU on macOS (see `native/docs/qemu-macos-vhost-user.md`), and for krun.
   `GONDOLIN_VIRTIOFS=0|1` overrides the choice.

## Workflow validation

```sh
actionlint                                   # go install github.com/rhysd/actionlint/cmd/actionlint@latest
actionlint -shellcheck /path/to/shellcheck   # also lints the run: scripts
```

Both were clean on 2026-11-06 (actionlint 1.7.11, shellcheck 0.11.0). Action
versions in use were checked against the GitHub API, and all their tags
exist.

### Runner labels

Source: the `actions/runner-images` README, checked 2026-11-06, and
<https://github.com/actions/runner-images/issues/15226>.

- **macOS 14 was retired on GitHub Actions on 2026-11-02**, Intel and arm64.
  The release jobs moved from `macos-14` to `macos-15`.
- **`macos-15`** is arm64; **`macos-15-intel`** is x64 and valid.
  `macos-26` and `macos-26-intel` are the newer images; `macos-latest` is
  macOS 26 arm64.
- **`ubuntu-24.04-arm`** and `ubuntu-latest` (24.04) are current.

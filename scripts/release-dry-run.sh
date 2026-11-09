#!/usr/bin/env bash
# Release dry run: everything the Release workflow does except publishing.
#
#   scripts/release-dry-run.sh [--version X.Y.Z] [--strict] [--skip-native-build]
#                              [--skip-krun] [--skip-vm] [--keep] [--out DIR]
#
# 1. Version consistency: host/package.json, its optionalDependencies, every
#    packages/*/package.json, native/Cargo.toml and native/Cargo.lock,
#    CHANGELOG.md section (warning; an error with --strict), git tag not taken.
# 2. Builds: `make native-release` (the multi-call `gondolin` for all four
#    targets), the host
#    package (`pnpm --filter @earendil-works/gondolin run build`) and, on
#    darwin-arm64 / linux-x64, `make krun-runner`.
# 3. Stages copies of packages/* (the checkout is not modified), runs the
#    prepare scripts, `npm pack`s main + krun + native into <out>/tarballs and
#    checks their contents. Packages that cannot be built on this host (the
#    other platform's krun runner) are packed from the checkout as stubs, marked.
# 4. Installs the main tarball into a scratch project, with every optional
#    platform package overridden to its local tarball (the version may not be on
#    npm yet), then runs `gondolin --version`, `gondolind --version` (the
#    platform package's npm bin alias of the multi-call binary), the static
#    CLI's `--version`, `gondolin-krun-runner --version` and boots a VM with the
#    Node CLI and with the static CLI from the installed packages.
#
# Nothing is published, tagged or pushed. Needs the release toolchain (Rust
# with the four targets, Zig 0.17, pnpm, npm) and network access for npm
# dependencies; the VM smoke test needs QEMU (krun is tried in addition on a
# krun host) and a cached or downloadable image.
# shellcheck disable=SC2015,SC2016,SC2086,SC2012,SC2001 # ok/fail never fail; JS in single quotes; intended word splitting
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

VERSION=""
STRICT=0
SKIP_NATIVE=0
SKIP_KRUN=0
SKIP_VM=0
KEEP=0
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --strict) STRICT=1; shift ;;
    --skip-native-build) SKIP_NATIVE=1; shift ;;
    --skip-krun) SKIP_KRUN=1; shift ;;
    --skip-vm) SKIP_VM=1; shift ;;
    --keep) KEEP=1; shift ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

VERSION=${VERSION#v}
[ -n "$VERSION" ] || VERSION=$(node -p "require('./host/package.json').version")
if [ -z "$OUT" ]; then
  OUT=$(mktemp -d "${TMPDIR:-/tmp}/gondolin-release-dry-run.XXXXXX")
  [ "$KEEP" = 1 ] || trap 'rm -rf "$OUT"' EXIT
fi
mkdir -p "$OUT/stage" "$OUT/tarballs" "$OUT/scratch"
OUT=$(cd "$OUT" && pwd -P)

ERRORS=0
WARNINGS=0
step() { printf '\n==> %s\n' "$*"; }
ok() { printf '  ok    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; WARNINGS=$((WARNINGS + 1)); }
fail() { printf '  FAIL  %s\n' "$*"; ERRORS=$((ERRORS + 1)); }

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) HOST_KEY=darwin-arm64 ;;
  Darwin-x86_64) HOST_KEY=darwin-x64 ;;
  Linux-aarch64|Linux-arm64) HOST_KEY=linux-arm64 ;;
  Linux-x86_64) HOST_KEY=linux-x64 ;;
  *) HOST_KEY=unsupported ;;
esac

NATIVE_PKGS="gondolin-native-darwin-arm64 gondolin-native-darwin-x64 gondolin-native-linux-arm64 gondolin-native-linux-x64"
KRUN_PKGS="gondolin-krun-runner-darwin-arm64 gondolin-krun-runner-linux-x64"

echo "release dry run for $VERSION (host $HOST_KEY, output $OUT)"

# ---------------------------------------------------------------------------
step "Version consistency"

pkg_field() { node -p "require('./$1/package.json').$2"; }

v=$(pkg_field host version)
[ "$v" = "$VERSION" ] && ok "host/package.json $v" || fail "host/package.json is $v, expected $VERSION"

for p in $NATIVE_PKGS $KRUN_PKGS; do
  v=$(pkg_field "packages/$p" version)
  [ "$v" = "$VERSION" ] && ok "packages/$p $v" || fail "packages/$p is $v, expected $VERSION"
  dep=$(node -p "(require('./host/package.json').optionalDependencies || {})['@earendil-works/$p'] || ''")
  [ "$dep" = "$VERSION" ] && ok "host optionalDependencies @earendil-works/$p $dep" \
    || fail "host optionalDependencies @earendil-works/$p is '${dep}', expected $VERSION"
done
extra=$(node -e '
  const deps = Object.keys(require("./host/package.json").optionalDependencies || {});
  const known = process.argv.slice(1).map((p) => `@earendil-works/${p}`);
  console.log(deps.filter((d) => !known.includes(d)).join(" "));' $NATIVE_PKGS $KRUN_PKGS)
[ -z "$extra" ] || fail "host optionalDependencies without a packages/ dir: $extra"

v=$(sed -n '/^\[workspace.package\]/,/^\[/s/^version = "\(.*\)"/\1/p' native/Cargo.toml)
[ "$v" = "$VERSION" ] && ok "native/Cargo.toml $v" || fail "native/Cargo.toml is $v, expected $VERSION"
v=$(awk '/^name = "gondolind"$/ { getline; gsub(/version = |"/, ""); print; exit }' native/Cargo.lock)
[ "$v" = "$VERSION" ] && ok "native/Cargo.lock gondolind $v" \
  || fail "native/Cargo.lock has gondolind $v, expected $VERSION (cargo update --workspace in native/)"

if grep -q "^## $VERSION\$" CHANGELOG.md; then
  ok "CHANGELOG.md has '## $VERSION'"
elif [ "$STRICT" = 1 ]; then
  fail "CHANGELOG.md has no '## $VERSION' section"
else
  warn "CHANGELOG.md has no '## $VERSION' section (move Unreleased entries before tagging)"
fi
grep -q '^## Unreleased$' CHANGELOG.md && ok "CHANGELOG.md keeps '## Unreleased'" \
  || warn "CHANGELOG.md lost its '## Unreleased' heading"

if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  warn "tag v$VERSION already exists locally"
else
  ok "tag v$VERSION not taken locally"
fi
if node -e 'process.exit(require("./builtin-sandbox-helper-registry.json").refs[`gondolin:${process.argv[1]}`] ? 0 : 1)' "$VERSION"; then
  warn "builtin-sandbox-helper-registry.json already has gondolin:$VERSION"
else
  ok "sandbox helpers gondolin:$VERSION not registered yet (the Release workflow adds them)"
fi

if pnpm install --frozen-lockfile --lockfile-only >/dev/null 2>&1; then
  ok "pnpm-lock.yaml matches the package manifests"
else
  fail "pnpm-lock.yaml is out of date (pnpm install --lockfile-only)"
fi

# ---------------------------------------------------------------------------
step "Guest helpers (built from source, as the helper/image releases do)"
(cd guest && zig build -Doptimize=ReleaseSmall >/dev/null)
if grep -q -- '--virtiofs' guest/zig-out/bin/sandboxfs; then
  ok "sandboxfs supports --virtiofs"
else
  fail "sandboxfs lacks --virtiofs"
fi

# ---------------------------------------------------------------------------
step "Builds"

if [ "$SKIP_NATIVE" = 0 ]; then
  make native-release >"$OUT/native-release.log" 2>&1 || { tail -30 "$OUT/native-release.log"; fail "make native-release"; }
fi
for t in aarch64-apple-darwin x86_64-apple-darwin aarch64-unknown-linux-musl x86_64-unknown-linux-musl; do
  [ -x "native/target/dist/$t/gondolin" ] && ok "native/target/dist/$t/gondolin" \
    || fail "native/target/dist/$t/gondolin missing (make native-release)"
done

pnpm --filter @earendil-works/gondolin run build >"$OUT/host-build.log" 2>&1 \
  && ok "host package built" || { tail -30 "$OUT/host-build.log"; fail "host package build"; }
node host/dist/bin/gondolin.js --help >/dev/null && ok "host/dist/bin/gondolin.js --help" \
  || fail "host/dist/bin/gondolin.js --help"

KRUN_HOST=""
case "$HOST_KEY" in
  darwin-arm64) KRUN_HOST=gondolin-krun-runner-darwin-arm64 ;;
  linux-x64) KRUN_HOST=gondolin-krun-runner-linux-x64 ;;
esac
if [ -n "$KRUN_HOST" ] && [ "$SKIP_KRUN" = 0 ]; then
  make krun-runner >"$OUT/krun-runner.log" 2>&1 && ok "make krun-runner" \
    || { tail -30 "$OUT/krun-runner.log"; fail "make krun-runner"; KRUN_HOST=""; }
elif [ -n "$KRUN_HOST" ]; then
  warn "krun runner build skipped (--skip-krun); its package is packed as a stub"
  KRUN_HOST=""
fi

# ---------------------------------------------------------------------------
step "Prepare and pack npm packages"

pack() { # <dir> -> prints the tarball path
  local dir=$1
  local name
  name=$(cd "$dir" && npm pack --silent --pack-destination "$OUT/tarballs" | tail -1)
  echo "$OUT/tarballs/$name"
}

declare -a OVERRIDES=()
check_bin() { # <tarball> <entry> <min bytes>
  local size
  size=$(tar -tvzf "$1" "package/$2" 2>/dev/null | awk '{print $5}')
  if [ -n "$size" ] && [ "$size" -ge "$3" ]; then
    ok "$(basename "$1"): $2 ($size bytes)"
  else
    fail "$(basename "$1"): $2 missing or too small (${size:-absent})"
  fi
}

for p in $NATIVE_PKGS; do
  rm -rf "$OUT/stage/$p" && cp -R "packages/$p" "$OUT/stage/$p"
  if node scripts/prepare-native-package.mjs --package "$OUT/stage/$p" >"$OUT/stage/$p.log" 2>&1; then
    tgz=$(pack "$OUT/stage/$p")
    check_bin "$tgz" bin/gondolin 1000000
    check_bin "$tgz" LICENSE 1000
  else
    cat "$OUT/stage/$p.log"
    fail "prepare $p"
    tgz=$(pack "packages/$p")
  fi
  OVERRIDES+=("@earendil-works/$p=$tgz")
done

for p in $KRUN_PKGS; do
  rm -rf "$OUT/stage/$p" && cp -R "packages/$p" "$OUT/stage/$p"
  if [ "$p" = "$KRUN_HOST" ]; then
    if node scripts/prepare-krun-runner-package.mjs --package "$OUT/stage/$p" >"$OUT/stage/$p.log" 2>&1; then
      tgz=$(pack "$OUT/stage/$p")
      check_bin "$tgz" bin/gondolin-krun-runner 100000
    else
      cat "$OUT/stage/$p.log"
      fail "prepare $p"
      tgz=$(pack "$OUT/stage/$p")
    fi
  else
    tgz=$(pack "$OUT/stage/$p")
    echo "  stub  $(basename "$tgz") (not built here; the workflow builds it on its own runner)"
  fi
  OVERRIDES+=("@earendil-works/$p=$tgz")
done

MAIN_TGZ=$(pack host)
check_bin "$MAIN_TGZ" dist/bin/gondolin.js 1000
[ "$(tar -xOzf "$MAIN_TGZ" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0)).version')" = "$VERSION" ] \
  && ok "$(basename "$MAIN_TGZ") version $VERSION" || fail "$(basename "$MAIN_TGZ") version mismatch"
ls -l "$OUT/tarballs" | sed 's/^/        /'

# ---------------------------------------------------------------------------
step "Install into a scratch project"

node - "$OUT/scratch/package.json" "$MAIN_TGZ" "${OVERRIDES[@]}" <<'NODE'
const [file, main, ...overrides] = process.argv.slice(2);
const pkg = {
  name: "gondolin-release-dry-run",
  private: true,
  dependencies: { "@earendil-works/gondolin": `file:${main}` },
  // Optional platform packages come from the local tarballs: the version may
  // not be on npm yet.
  overrides: Object.fromEntries(
    overrides.map((o) => {
      const i = o.lastIndexOf("=");
      return [o.slice(0, i), `file:${o.slice(i + 1)}`];
    }),
  ),
};
require("fs").writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
NODE
(cd "$OUT/scratch" && npm install --no-audit --no-fund >"$OUT/npm-install.log" 2>&1) \
  && ok "npm install" || { tail -30 "$OUT/npm-install.log"; fail "npm install"; }

SCRATCH_BIN="$OUT/scratch/node_modules/.bin"
# The installed packages only: no checkout binaries, no overrides.
unset GONDOLIN_NATIVE_BIN GONDOLIN_GUEST_DIR GONDOLIN_SANDBOX_HELPERS_DIR GONDOLIN_ENGINE

out=$(cd "$OUT/scratch" && "$SCRATCH_BIN/gondolin" --version 2>&1) || true
echo "$out" | sed 's/^/        /'
echo "$out" | grep -qx "gondolin $VERSION" && ok "gondolin --version" || fail "gondolin --version"
if [ "$HOST_KEY" != unsupported ]; then
  echo "$out" | grep -q "gondolind: $OUT/scratch/node_modules/@earendil-works/gondolin-native-$HOST_KEY/bin/gondolin daemon" \
    && ok "gondolin resolves the installed gondolin-native-$HOST_KEY" \
    || fail "gondolin does not resolve the installed gondolin-native-$HOST_KEY"
  out=$("$SCRATCH_BIN/gondolind" --version 2>&1) || true
  [ "$out" = "gondolind $VERSION" ] && ok "gondolind --version: $out" || fail "gondolind --version: $out"
  static_cli="$OUT/scratch/node_modules/@earendil-works/gondolin-native-$HOST_KEY/bin/gondolin"
  out=$("$static_cli" --version 2>&1) || true
  [ "$out" = "gondolin $VERSION (static)" ] && ok "static gondolin --version: $out" \
    || fail "static gondolin --version: $out"
fi
if [ -n "$KRUN_HOST" ]; then
  out=$("$SCRATCH_BIN/gondolin-krun-runner" --version 2>&1) && ok "gondolin-krun-runner --version: $out" \
    || fail "gondolin-krun-runner --version: $out"
fi

# ---------------------------------------------------------------------------
if [ "$SKIP_VM" = 0 ]; then
  step "Smoke VM boots with the installed packages"
  VMMS=qemu
  [ -n "$KRUN_HOST" ] && VMMS="qemu krun"
  for vmm in $VMMS; do
    if out=$(cd "$OUT/scratch" && "$SCRATCH_BIN/gondolin" exec --vmm "$vmm" -- /bin/sh -c 'echo gondolin-smoke-$(uname -m)' 2>&1); then
      echo "$out" | grep -q gondolin-smoke- && ok "node CLI, $vmm: $(echo "$out" | grep gondolin-smoke- | head -1)" \
        || fail "node CLI, $vmm: unexpected output: $out"
    else
      echo "$out" | tail -20 | sed 's/^/        /'
      fail "node CLI, $vmm: VM boot"
    fi
    if [ "$HOST_KEY" != unsupported ]; then
      if out=$(cd "$OUT/scratch" && "$static_cli" exec --vmm "$vmm" -- /bin/sh -c 'echo gondolin-smoke-$(uname -m)' 2>&1); then
        echo "$out" | grep -q gondolin-smoke- && ok "static CLI, $vmm: $(echo "$out" | grep gondolin-smoke- | head -1)" \
          || fail "static CLI, $vmm: unexpected output: $out"
      else
        echo "$out" | tail -20 | sed 's/^/        /'
        fail "static CLI, $vmm: VM boot"
      fi
    fi
  done
fi

# ---------------------------------------------------------------------------
step "Summary"
echo "  $ERRORS error(s), $WARNINGS warning(s)"
[ "$KEEP" = 1 ] && echo "  artifacts kept in $OUT"
[ "$ERRORS" = 0 ]

#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/smoke-build-no-zig.sh [options]

Smoke-test that `gondolin build` succeeds when `zig` on PATH is a failing shim.

The script stages sandbox helper binaries first, then prepends a fake `zig` that
exits with an error while running the user-facing build command.

Options:
  --arch <aarch64|x86_64>   Target guest architecture (default: host arch)
  --config <file>           Build config passed to `gondolin build --config`
  --output <dir>            Output directory (default: temporary directory)
  --helpers-dir <dir>       Existing helper dir with bin/sandbox*; skips setup Zig build
  --keep-output             Keep the temporary output directory after success/failure
  -h, --help                Show this help

Environment:
  PNPM                      pnpm command to use (default: pnpm)
  ZIG                       Zig command used only for helper setup (default: zig)
USAGE
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PNPM_CMD="${PNPM:-pnpm}"
ZIG_CMD="${ZIG:-zig}"

ARCH=""
CONFIG=""
OUTPUT=""
HELPERS_DIR=""
KEEP_OUTPUT=0
OUTPUT_IS_TEMP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      ARCH="${2:-}"
      shift 2
      ;;
    --config)
      CONFIG="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --helpers-dir)
      HELPERS_DIR="${2:-}"
      shift 2
      ;;
    --keep-output)
      KEEP_OUTPUT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$ARCH" ]]; then
  ARCH="$(node -p 'process.arch === "arm64" ? "aarch64" : "x86_64"')"
fi

case "$ARCH" in
  aarch64) TARGET="aarch64-linux-musl" ;;
  x86_64) TARGET="x86_64-linux-musl" ;;
  *)
    echo "unsupported --arch: $ARCH (expected aarch64 or x86_64)" >&2
    exit 2
    ;;
esac

if [[ -n "$CONFIG" && ! -f "$CONFIG" ]]; then
  echo "config file not found: $CONFIG" >&2
  exit 2
fi

if [[ -z "$OUTPUT" ]]; then
  OUTPUT="$(mktemp -d "${TMPDIR:-/tmp}/gondolin-no-zig-assets.XXXXXX")"
  OUTPUT_IS_TEMP=1
else
  mkdir -p "$OUTPUT"
fi

NOZIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gondolin-no-zig-shim.XXXXXX")"
STORE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gondolin-no-zig-store.XXXXXX")"
TEMP_HELPERS_DIR=""

cleanup() {
  local status=$?
  rm -rf "$NOZIG_DIR" "$STORE_DIR"
  if [[ -n "$TEMP_HELPERS_DIR" ]]; then
    rm -rf "$TEMP_HELPERS_DIR"
  fi
  if [[ "$OUTPUT_IS_TEMP" -eq 1 && "$KEEP_OUTPUT" -eq 0 ]]; then
    rm -rf "$OUTPUT"
  elif [[ "$OUTPUT_IS_TEMP" -eq 1 ]]; then
    echo "Kept output directory: $OUTPUT" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ -z "$HELPERS_DIR" ]]; then
  if ! command -v "$ZIG_CMD" >/dev/null 2>&1; then
    echo "Zig is required only for this smoke test's helper setup." >&2
    echo "Install Zig or pass --helpers-dir <dir> with prebuilt sandbox helpers." >&2
    exit 1
  fi

  echo "[setup] Building sandbox helpers with real Zig for $TARGET" >&2
  (cd "$ROOT/guest" && "$ZIG_CMD" build -Doptimize=ReleaseSmall -Dtarget="$TARGET")

  TEMP_HELPERS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gondolin-helpers.XXXXXX")"
  mkdir -p "$TEMP_HELPERS_DIR/bin"
  cp \
    "$ROOT/guest/zig-out/bin/sandboxd" \
    "$ROOT/guest/zig-out/bin/sandboxfs" \
    "$ROOT/guest/zig-out/bin/sandboxssh" \
    "$ROOT/guest/zig-out/bin/sandboxingress" \
    "$TEMP_HELPERS_DIR/bin/"
  chmod +x "$TEMP_HELPERS_DIR/bin/"*
  HELPERS_DIR="$TEMP_HELPERS_DIR"
else
  for name in sandboxd sandboxfs sandboxssh sandboxingress; do
    if [[ ! -f "$HELPERS_DIR/bin/$name" ]]; then
      echo "helper binary not found: $HELPERS_DIR/bin/$name" >&2
      exit 2
    fi
  done
fi

cat > "$NOZIG_DIR/zig" <<'SH'
#!/bin/sh
echo "FAIL: zig was invoked during gondolin build" >&2
exit 42
SH
chmod +x "$NOZIG_DIR/zig"

BUILD_ARGS=(build --arch "$ARCH" --output "$OUTPUT")
if [[ -n "$CONFIG" ]]; then
  BUILD_ARGS+=(--config "$CONFIG")
fi

unset GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE

echo "[smoke] Running gondolin build with failing zig shim first on PATH" >&2
PATH="$NOZIG_DIR:$PATH" \
GONDOLIN_SANDBOX_HELPERS_DIR="$HELPERS_DIR" \
GONDOLIN_SANDBOX_HELPER_STORE="$STORE_DIR" \
"$PNPM_CMD" -C "$ROOT/host" gondolin "${BUILD_ARGS[@]}"

echo "[smoke] Verifying built assets" >&2
PATH="$NOZIG_DIR:$PATH" \
"$PNPM_CMD" -C "$ROOT/host" gondolin build --verify "$OUTPUT"

echo "PASS: gondolin build did not invoke zig"
echo "Output: $OUTPUT"

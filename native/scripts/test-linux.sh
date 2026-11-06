#!/usr/bin/env bash
# Cross-compiles the native workspace's tests for Linux (musl, static) and runs
# them inside a Gondolin VM, so Linux-only code paths are exercised on macOS.
#
# usage: native/scripts/test-linux.sh [cargo test args...]
#   e.g. native/scripts/test-linux.sh -p gondolin-netstack
# env:   TARGET (default: the host architecture's *-unknown-linux-musl; the VM
#        runs the host architecture, so only that one can run)
# Needs: zig 0.17, the rust target, node, QEMU and a guest image (as for
# `gondolin exec`). Tests skipped in the guest are listed in test-linux.skip.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
NATIVE=$(cd "$HERE/.." && pwd)
# shellcheck source=cross-env.sh
source "$HERE/cross-env.sh"

case "$(uname -m)" in
  arm64|aarch64) default_target=aarch64-unknown-linux-musl ;;
  *) default_target=x86_64-unknown-linux-musl ;;
esac
TARGET=${TARGET:-$default_target}
cross_env "$TARGET"

args=("$@")
[ ${#args[@]} -eq 0 ] && args=(--workspace)

cd "$NATIVE"
json=$(mktemp)
trap 'rm -f "$json"' EXIT
echo "building tests for $TARGET" >&2
cargo test --no-run --target "$TARGET" --message-format=json-render-diagnostics "${args[@]}" > "$json"
node "$HERE/test-linux.mts" "$json" "$HERE/test-linux.skip"

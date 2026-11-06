#!/usr/bin/env bash
# Run the host test suite on both engines (node, then native) and report
# per engine. Used to verify parity before flipping the default engine.
#
# Usage: scripts/test-both.sh [--release] [test files...]   (default: test/*.test.ts)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native="$here/../native"

profile=debug
cargo_flags=()
if [[ "${1:-}" == "--release" ]]; then
  profile=release
  cargo_flags+=(--release)
  shift
fi
(cd "$native" && cargo build -p gondolind ${cargo_flags[@]+"${cargo_flags[@]}"}) || exit 1

cd "$here"
if [[ $# -eq 0 ]]; then
  set -- test/*.test.ts
fi

status=0
for engine in node native; do
  echo "=== engine: $engine"
  if ! GONDOLIN_ENGINE="$engine" GONDOLIN_NATIVE_BIN="$native/target/$profile/gondolind" \
    node --test "$@"; then
    echo "=== engine $engine: FAILED"
    status=1
  fi
done
exit $status

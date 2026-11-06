#!/usr/bin/env bash
# Build gondolind and run host tests on the native engine.
#
# Usage: scripts/test-native.sh [--release] [test files...]
# Without test files, the tests listed below run. Pass `all` to run every
# host test with GONDOLIN_ENGINE=native.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native="$here/../native"

profile=debug
cargo_flags=()
if [[ "${1:-}" == "--release" ]]; then
  profile=release
  cargo_flags+=(--release)
  shift
fi

(cd "$native" && cargo build -p gondolind -p gondolin-cli ${cargo_flags[@]+"${cargo_flags[@]}"})
# the multi-call binary as the platform packages ship it (`gondolin daemon`)
export GONDOLIN_NATIVE_BIN="$native/target/$profile/gondolin"
export GONDOLIN_CLI_BIN="$native/target/$profile/gondolin"
export GONDOLIN_ENGINE=native

# Tests covering what the native engine implements (exec, file operations,
# VFS via the controller, native network (egress, hooks, SSH egress), lifecycle, SSH/ingress
# streams, krun).
default_tests=(
  test/native-transport.test.ts
  test/native-cli.test.ts
  test/cli-configure-parity.test.ts
  test/native-qemu-args.test.ts
  test/native-mitm-ca.test.ts
  test/native-panic.test.ts
  test/ssh.test.ts
  test/ingress-large-response.test.ts
  test/backend-parity.test.ts
  test/network-egress.test.ts
  test/ssh-egress.test.ts
  test/ssh-exec.test.ts
  test/native-net.test.ts
  test/http-hooks.test.ts
  test/exec.test.ts
  test/backpressure.test.ts
  test/exec-stdin-backpressure.test.ts
  test/network-upload.test.ts
  test/clock-sync.test.ts
  test/host-pid-stats.test.ts
  test/vfs.test.ts
  test/vfs-many-mounts.test.ts
  test/native-vfs.test.ts
  test/fs-rpc.test.ts
  test/checkpoint.test.ts
  test/vm-internals.test.ts
  test/sandbox-stdin-limits.test.ts
  test/sandbox-file-ops.test.ts
  test/cli-*.test.ts
)

cd "$here"
if [[ $# -eq 0 ]]; then
  # shellcheck disable=SC2206 # expand the cli-*.test.ts glob
  set -- ${default_tests[@]}
elif [[ "$1" == "all" ]]; then
  set -- test/*.test.ts
fi
exec node --test "$@"

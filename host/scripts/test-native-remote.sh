#!/usr/bin/env bash
# Prove the native engine is remote-clean on one machine: gondolind runs via
# scripts/gondolind-remote-sim.sh (own HOME/XDG_CACHE_HOME/TMPDIR/cwd, empty
# environment) in remote mode, where the controller refuses to send paths of
# its own machine (assertRemoteConfigure) and the daemon resolves the image,
# prepares the root disk and serves the network.
#
# Usage: scripts/test-native-remote.sh [--release] [test files...]
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

(cd "$native" && cargo build -p gondolind ${cargo_flags[@]+"${cargo_flags[@]}"})
export GONDOLIN_REMOTE_BIN="$native/target/$profile/gondolind"
export GONDOLIN_NATIVE_REMOTE=1
export GONDOLIN_NATIVE_COMMAND="$here/scripts/gondolind-remote-sim.sh"
export GONDOLIN_BACKEND_PARITY_INGRESS=1
# the image "installed" on the simulated remote machine (no download needed)
if [[ -z "${GONDOLIN_REMOTE_GUEST_DIR:-}" && -d "$here/../guest/image/out" ]]; then
  export GONDOLIN_REMOTE_GUEST_DIR="$here/../guest/image/out"
fi

default_tests=(
  test/exec.test.ts
  test/backpressure.test.ts
  test/clock-sync.test.ts
  test/vfs.test.ts
  test/vfs-many-mounts.test.ts
  test/native-vfs.test.ts
  test/ssh.test.ts
  test/backend-parity.test.ts
  test/network-egress.test.ts
  test/ssh-egress.test.ts
  test/native-remote.test.ts
  test/cli-vm.test.ts
)

cd "$here"
if [[ $# -eq 0 ]]; then
  set -- "${default_tests[@]}"
fi
exec node --test "$@"

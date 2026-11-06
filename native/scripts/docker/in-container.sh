#!/usr/bin/env bash
# Runs inside the gondolin-linux-test container (see ../test-linux-docker.sh).
# The repository is mounted read-only at /src; build outputs, node_modules and
# caches live in volumes. Runs as root only to hand the volumes to `tester`,
# then re-executes itself as that user.
#
# usage: in-container.sh <phase>...
#   cargo       cargo test --workspace (linux/arm64, natively)
#   vm          boots VMs (QEMU TCG) through the native engine: linux paths smoke
#   host-tests  host tests with GONDOLIN_ENGINE=native (HOST_TESTS, or HOST_TESTS=all)
# shellcheck disable=SC2016 # expanded by the inner shell
set -euo pipefail

if [ "$(id -u)" = 0 ]; then
  for d in /target /usr/local/cargo/registry /pnpm-store /src/node_modules /src/host/node_modules /work; do
    [ -d "$d" ] && chown tester:tester "$d"
  done
  exec sudo -E -u tester HOME=/home/tester PATH="$PATH" "$0" "$@"
fi

export CARGO_TARGET_DIR=/target
export GONDOLIN_GUEST_DIR=/image
export GONDOLIN_NATIVE_BIN=/target/release/gondolind
export GONDOLIN_FORCE_VM_TESTS=1
export TMPDIR=/work/tmp
mkdir -p "$TMPDIR"
cd /src

FAILED=()
run() { # <label> <cmd...>
  local label=$1; shift
  echo
  echo "=== $label"
  local start=$SECONDS
  if "$@"; then
    echo "=== $label: ok ($((SECONDS - start))s)"
  else
    echo "=== $label: FAILED ($((SECONDS - start))s)"
    FAILED+=("$label")
  fi
}

node_setup() {
  [ -e /src/node_modules/.modules.yaml ] && return 0
  pnpm config set store-dir /pnpm-store >/dev/null
  pnpm install --frozen-lockfile --ignore-scripts=false
}

build_gondolind() {
  (cd native && cargo build --locked --release -p gondolind)
}

for phase in "$@"; do
  case "$phase" in
    cargo)
      run "cargo test --workspace (linux/$(uname -m))" \
        bash -c 'cd native && cargo test --locked --workspace -- ${CARGO_TEST_ARGS:-}'
      ;;
    vm)
      run "node setup" node_setup
      run "build gondolind" build_gondolind
      run "native engine smoke (QEMU TCG)" node native/scripts/docker/linux-smoke.mts
      ;;
    host-tests)
      run "node setup" node_setup
      run "build gondolind" build_gondolind
      tests=${HOST_TESTS:-exec vfs native-vfs network-egress cli-vm}
      if [ "$tests" = all ]; then
        # every host test but krun (out of scope) and container-build (writes
        # host/dist, the checkout is read-only here)
        tests=$(cd host/test && for f in *.test.ts; do echo "${f%.test.ts}"; done | grep -vE '^(krun|container-build)' | tr '\n' ' ')
      fi
      for t in $tests; do
        run "host test $t (native engine)" bash -c "cd host && GONDOLIN_ENGINE=native WS_TIMEOUT=\${WS_TIMEOUT:-900000} node --test --test-concurrency=1 --test-timeout=\${TEST_TIMEOUT_MS:-1800000} test/$t.test.ts"
      done
      ;;
    *) echo "unknown phase $phase" >&2; exit 2 ;;
  esac
done

echo
if [ ${#FAILED[@]} -eq 0 ] 2>/dev/null || [ -z "${FAILED+x}" ]; then
  echo "all phases passed"
else
  printf 'failed: %s\n' "${FAILED[@]}"
  exit 1
fi

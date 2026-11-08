#!/usr/bin/env bash
# Linux with KVM on Apple silicon: a Lima VM (Virtualization.framework with
# nested virtualization, so the guest kernel runs at EL2 and has /dev/kvm) for
# running gondolin's tests on Linux/KVM from a Mac.
#
#   native/scripts/linux-kvm-vm.sh <command> [args]
#
# commands:
#   create     create and start the VM (native/scripts/lima/gondolin-kvm.yaml,
#              the repository mounted read-only), then `provision`
#   provision  install the toolchain in the VM: QEMU (Ubuntu's), node, pnpm,
#              rust stable, zig 0.17, uv (idempotent)
#   sync       copy the repository from the read-only mount into ~/gondolin in
#              the VM (build outputs stay in the VM)
#   image      build the guest image there with source-built helpers
#   test [suite...]
#              create the VM if needed, sync, build the guest image once, then
#              run suites (default: cargo host host-native
#              virtiofs bench):
#                cargo        cargo test --workspace (native/)
#                host         the whole host suite (host/scripts/test-native.sh all)
#                host-native  host/scripts/test-native.sh
#                virtiofs     host/scripts/check-virtiofs.ts (stock QEMU)
#                bench        boot/exec timings (host/bench/run.ts)
#   run <cmd>  run a shell command in ~/gondolin in the VM
#   shell      interactive shell in the VM
#   stop | delete
#
# env: GONDOLIN_KVM_VM (instance name, default gondolin-kvm),
#      GONDOLIN_KVM_CPUS / GONDOLIN_KVM_MEMORY (create; default 8 / 16GiB)
# Needs Lima 2.x and an M3 or newer Mac with macOS 15+ (nested virtualization).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
VM=${GONDOLIN_KVM_VM:-gondolin-kvm}
ZIG_VERSION=0.17.0
NODE_MAJOR=24
# expanded in the VM
# shellcheck disable=SC2016
WORK='$HOME/gondolin'

lima() { limactl shell --workdir / "$VM" -- "$@"; }
in_vm() { lima bash -lc "$1"; }

exists() { limactl list -q 2>/dev/null | grep -qx "$VM"; }

create() {
  if ! exists; then
    limactl create --tty=false --name "$VM" \
      --cpus "${GONDOLIN_KVM_CPUS:-8}" --memory "${GONDOLIN_KVM_MEMORY:-16}" \
      --set ".mounts=[{\"location\":\"$REPO\",\"writable\":false}]" \
      "$HERE/lima/gondolin-kvm.yaml"
  fi
  limactl start --tty=false "$VM"
  check_kvm
  provision
}

check_kvm() {
  in_vm 'sudo dmesg | grep -E "started at EL|Hyp mode" || true
    if [ -e /dev/kvm ]; then echo "/dev/kvm: present"; else
      echo "/dev/kvm missing (nested virtualization needs an M3+ Mac, macOS 15+)" >&2; exit 1; fi'
}

provision() {
  in_vm "set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    if ! command -v qemu-system-aarch64 >/dev/null || ! command -v rsync >/dev/null; then
      sudo apt-get update -q
      sudo apt-get install -y -q qemu-system-arm qemu-utils lz4 e2fsprogs cpio rsync git \
        build-essential pkg-config curl xz-utils ca-certificates openssh-server socat
    fi
    # transparent huge pages for shmem: QEMU's guest RAM is a memfd (shared
    # with the vhost-user-fs backend); with 4 KiB pages every first touch is a
    # nested stage-2 fault, boots are ~2x slower (Ubuntu defaults to never)
    echo 'w /sys/kernel/mm/transparent_hugepage/shmem_enabled - - - - advise' \
      | sudo tee /etc/tmpfiles.d/gondolin-thp.conf >/dev/null
    echo advise | sudo tee /sys/kernel/mm/transparent_hugepage/shmem_enabled >/dev/null
    # /dev/kvm for the (ssh) user without a re-login
    echo 'KERNEL==\"kvm\", MODE=\"0666\"' | sudo tee /etc/udev/rules.d/99-gondolin-kvm.rules >/dev/null
    sudo chmod 666 /dev/kvm
    if ! command -v node >/dev/null || [ \"\$(node -p 'process.versions.node.split(\".\")[0]')\" -lt 22 ]; then
      base=https://nodejs.org/dist/latest-v$NODE_MAJOR.x
      file=\$(curl -fsSL \$base/SHASUMS256.txt | awk '/linux-arm64.tar.xz\$/ {print \$2}')
      curl -fsSL \$base/\$file | sudo tar -xJ -C /usr/local --strip-components=1
    fi
    sudo corepack enable
    if ! command -v cargo >/dev/null && [ ! -x \$HOME/.cargo/bin/cargo ]; then
      curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --component rustfmt,clippy
    fi
    # scripts/run-parallel (guest build) runs with uv
    command -v uv >/dev/null || curl -fsSL https://astral.sh/uv/install.sh | sudo env UV_INSTALL_DIR=/usr/local/bin sh -s -- -q
    if [ ! -x /usr/local/zig-$ZIG_VERSION/zig ]; then
      curl -fsSL https://ziglang.org/download/$ZIG_VERSION/zig-aarch64-linux-$ZIG_VERSION.tar.xz \
        | sudo tar -xJ -C /usr/local
      sudo mv /usr/local/zig-aarch64-linux-$ZIG_VERSION /usr/local/zig-$ZIG_VERSION
      sudo ln -sf /usr/local/zig-$ZIG_VERSION/zig /usr/local/bin/zig
    fi
    echo \"node \$(node --version), zig \$(zig version), \$(\$HOME/.cargo/bin/cargo --version), \$(qemu-system-aarch64 --version | head -1)\""
}

# The VM exists and runs (created and provisioned on first use).
ensure() {
  if ! exists; then
    create
  elif ! limactl list --format '{{.Status}}' "$VM" | grep -qx Running; then
    limactl start --tty=false "$VM"
  fi
}

sync_repo() {
  ensure
  in_vm "mkdir -p $WORK && rsync -a --delete \
    --exclude=.git --exclude=target/ --exclude=node_modules/ --exclude=/host/dist/ \
    --exclude=/guest/zig-out/ --exclude=.zig-cache/ --exclude=/guest/image/out*/ \
    --exclude=/native/fuzz/corpus/ --exclude=/native/fuzz/artifacts/ --exclude=/site/ \
    '$REPO/' $WORK/
    cd $WORK && CI=true pnpm install --frozen-lockfile --reporter=silent"
}

image() {
  in_vm "cd $WORK && GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE=1 make -C guest build"
}

# Nested guests boot ~10x slower than under HVF (every exit costs >= 30 us,
# `perf kvm stat`), so the host tests get generous startup timeouts.
SLOW_ENV='export GONDOLIN_START_TIMEOUT_MS=300000 GONDOLIN_BACKEND_PARITY_START_TIMEOUT_MS=300000
  GONDOLIN_HOST_PID_START_TIMEOUT_MS=300000 GONDOLIN_BACKEND_PARITY_INGRESS_FETCH_TIMEOUT_MS=120000
  GONDOLIN_VFS_READY_TIMEOUT_MS=300000;'

run_suite() {
  local suite=$1
  echo "=== $suite"
  case "$suite" in
    cargo) in_vm "cd $WORK/native && cargo test --workspace" ;;
    host) in_vm "$SLOW_ENV cd $WORK/host && ./scripts/test-native.sh --release all" ;;
    host-native) in_vm "$SLOW_ENV cd $WORK/host && ./scripts/test-native.sh --release" ;;
    virtiofs) in_vm "cd $WORK/host && GONDOLIN_VMM=qemu node scripts/check-virtiofs.ts" ;;
    bench) in_vm "cd $WORK/host && GONDOLIN_BENCH_SKIP_ENGINE_CHECK=1 \
      GONDOLIN_NATIVE_BIN=$WORK/native/target/release/gondolin node bench/run.ts \
      ${BENCH_ARGS:---engine native --suite boot,exec --quick --no-save}" ;;
    *) echo "unknown suite: $suite" >&2; return 2 ;;
  esac
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  create) create ;;
  provision) provision ;;
  sync) sync_repo ;;
  image) sync_repo; image ;;
  test)
    sync_repo
    in_vm "test -f $WORK/guest/image/out/manifest.json" || image
    suites=("$@")
    [ ${#suites[@]} -gt 0 ] || suites=(cargo host host-native virtiofs bench)
    failed=()
    for s in "${suites[@]}"; do run_suite "$s" || failed+=("$s"); done
    if [ ${#failed[@]} -gt 0 ]; then echo "failed: ${failed[*]}" >&2; exit 1; fi
    echo "all suites passed: ${suites[*]}"
    ;;
  run) in_vm "cd $WORK && $*" ;;
  shell) limactl shell --workdir / "$VM" ;;
  stop) limactl stop "$VM" ;;
  delete) limactl delete -f "$VM" ;;
  *) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

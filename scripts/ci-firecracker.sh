#!/usr/bin/env bash
# CI: the host test files that exercise a VM, on the firecracker backend (KVM),
# with the daemon running as root through scripts/gondolind-sudo.sh so VMMs
# run under the jailer.
#
# Needs: Firecracker and its jailer (scripts/install-firecracker.sh), /dev/kvm,
# passwordless sudo, GONDOLIN_GUEST_DIR (an image built from this checkout)
# and GONDOLIN_DAEMON_BIN (gondolind).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../host"

export GONDOLIN_VMM=firecracker
export GONDOLIN_NATIVE_BIN="$here/gondolind-sudo.sh"
# the VM tests skip when this process cannot open /dev/kvm, which only the
# daemon (root) needs here; CI runners give it to root and the kvm group only
export GONDOLIN_FORCE_VM_TESTS=1
: "${GONDOLIN_DAEMON_BIN:?set GONDOLIN_DAEMON_BIN to the gondolind binary}"
: "${GONDOLIN_GUEST_DIR:?set GONDOLIN_GUEST_DIR to a guest image built from this checkout}"
NODE=${NODE:-node}

echo "==> firecracker backend check (jailed VMM, vsock, overlay root, sandboxfs)"
"$NODE" scripts/check-firecracker.ts

tests=(
  backpressure checkpoint djs-hooks-vm exec exec-stdin-backpressure
  firecracker-options host-pid-stats http-hooks ingress-forwarding
  ingress-websocket mitm native-net native-vfs network-egress
  network-upload ssh ssh-egress ssh-exec tmpfs vfs vfs-hooks-compose
  vfs-many-mounts vfs-mounts
)
files=()
for t in "${tests[@]}"; do files+=("test/$t.test.ts"); done
echo "==> host tests on firecracker: ${tests[*]}"
"$NODE" --test --test-concurrency=2 "${files[@]}"

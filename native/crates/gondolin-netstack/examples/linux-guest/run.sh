#!/usr/bin/env bash
# Boots a Gondolin guest image under QEMU with its netdev served by the
# `netdev_demo` example and runs `nettest.sh` inside (DHCP, ping, DNS, echo,
# upload/download throughput). Needs qemu-system-aarch64 with HVF/KVM, lz4 and
# cpio. Usage: run.sh <image-dir containing vmlinuz-virt, initramfs.cpio.lz4, rootfs.ext4>
set -euo pipefail
IMG=${1:?image directory}
HERE=$(cd "$(dirname "$0")" && pwd)
NATIVE=$(cd "$HERE/../../../.." && pwd)
WORK=$(mktemp -d)
trap 'kill ${DEMO:-} 2>/dev/null || true; rm -rf "$WORK"' EXIT

(cd "$NATIVE" && cargo build --release -p gondolin-netstack --example netdev_demo)
mkdir -p "$WORK/overlay"
cp "$HERE/netinit" "$HERE/nettest.sh" "$WORK/overlay/"
chmod +x "$WORK/overlay/netinit"
(cd "$WORK/overlay" && find . ! -name . | cpio -o -H newc > "$WORK/overlay.cpio" 2>/dev/null)
lz4 -dc "$IMG/initramfs.cpio.lz4" | cat - "$WORK/overlay.cpio" > "$WORK/initrd.cpio"

"$NATIVE/target/release/examples/netdev_demo" "$WORK/net.sock" 2> "$WORK/demo.log" &
DEMO=$!
sleep 0.5

case "$(uname -s)" in
  Darwin) ACCEL=hvf ;;
  *) ACCEL=kvm ;;
esac
qemu-system-aarch64 -M virt,accel=$ACCEL -cpu host -m 1024 -smp 2 -nographic -no-reboot \
  -kernel "$IMG/vmlinuz-virt" -initrd "$WORK/initrd.cpio" \
  -append "console=ttyAMA0 rdinit=/netinit quiet${GUEST_MTU:+ GUEST_MTU=$GUEST_MTU}" \
  -drive "file=$IMG/rootfs.ext4,format=raw,if=none,id=drive0,snapshot=on" \
  -device virtio-blk-pci,drive=drive0 \
  -netdev "stream,id=net0,server=off,addr.type=unix,addr.path=$WORK/net.sock" \
  -device virtio-net-pci,netdev=net0,mac=02:00:00:00:00:01 < /dev/null
echo "----- host side"
cat "$WORK/demo.log"

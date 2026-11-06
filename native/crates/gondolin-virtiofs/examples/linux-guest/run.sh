#!/usr/bin/env bash
# Boots a Gondolin guest image with a vhost-user-fs device served by the
# `virtiofs_demo` example and runs fstest.sh (bench-like workloads on guest
# tmpfs and on the virtio-fs mount).
# usage: run.sh <image-dir> <qemu-system-aarch64 with vhost-user> [host-dir]
set -euo pipefail
IMG=${1:?image directory}
QEMU=${2:?qemu binary built with --enable-vhost-user}
HERE=$(cd "$(dirname "$0")" && pwd)
NATIVE=$(cd "$HERE/../../../.." && pwd)
WORK=$(mktemp -d)
SHARE=${3:-$WORK/share}
mkdir -p "$SHARE"
trap 'kill ${DEMO:-} 2>/dev/null || true; rm -rf "$WORK"' EXIT

(cd "$NATIVE" && cargo build -q --release -p gondolin-virtiofs --example virtiofs_demo)
mkdir -p "$WORK/overlay"
cp "$HERE/fsinit" "$HERE/fstest.sh" "$HERE/fsbench.py" "$WORK/overlay/"
chmod +x "$WORK/overlay/fsinit"
(cd "$WORK/overlay" && find . ! -name . | cpio -o -H newc > "$WORK/overlay.cpio" 2>/dev/null)
lz4 -dc "$IMG/initramfs.cpio.lz4" | cat - "$WORK/overlay.cpio" > "$WORK/initrd.cpio"

"$NATIVE/target/release/examples/virtiofs_demo" "$WORK/vfs.sock" "$SHARE" ${CACHE_SECS:-1} 2> "$WORK/vfs.log" &
DEMO=$!
sleep 0.5
case "$(uname -s)" in
  Darwin) ACCEL=hvf; MEM="memory-backend-shm" ;;
  *) ACCEL=kvm; MEM="memory-backend-memfd" ;;
esac
"$QEMU" -M virt,accel=$ACCEL,memory-backend=mem -cpu host -m 2G -smp 2 -nographic -no-reboot \
  -object $MEM,id=mem,size=2G,share=on \
  -kernel "$IMG/vmlinuz-virt" -initrd "$WORK/initrd.cpio" \
  -append "console=ttyAMA0 rdinit=/fsinit quiet fstest=${FSTEST:-all}" \
  -drive "file=$IMG/rootfs.ext4,format=raw,if=none,id=drive0,snapshot=on" \
  -device virtio-blk-pci,drive=drive0 \
  -chardev socket,id=vfs,path="$WORK/vfs.sock" \
  -device vhost-user-fs-pci,chardev=vfs,tag=gondolin,queue-size=1024 < /dev/null
echo "----- host side"
cat "$WORK/vfs.log"
ls "$SHARE" | head

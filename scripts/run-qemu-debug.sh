#!/usr/bin/env bash
set -euo pipefail

# Resolve gondolin guest options from the installed npm package
# (uses @earendil-works/gondolin from node resolution)

eval "$(node -e '
const { resolveSandboxServerOptionsAsync } = require("@earendil-works/gondolin");
(async () => {
  const o = await resolveSandboxServerOptionsAsync({ console: "stdio" });
  const platform = process.platform;
  const arch = process.arch;
  const defaultMachine = (o.machineType ?? (
    platform === "linux" && arch === "x64" ? "microvm" :
    arch === "arm64" ? "virt" :
    "q35"
  ));
  const defaultAccel = (o.accel ?? (
    platform === "linux" ? "kvm" :
    platform === "darwin" ? "hvf" :
    "tcg"
  ));
  const defaultCpu = (o.cpu ?? (
    platform === "linux" || platform === "darwin" ? "host" : "max"
  ));

  const lines = [
    `QEMU_PATH=${o.qemuPath}`,
    `KERNEL_PATH=${o.kernelPath}`,
    `INITRD_PATH=${o.initrdPath}`,
    `ROOTFS_PATH=${o.rootfsPath}`,
    `MEMORY=${o.memory}`,
    `CPUS=${o.cpus}`,
    `VIRTIO_SOCK=${o.virtioSocketPath}`,
    `VIRTIO_FS_SOCK=${o.virtioFsSocketPath}`,
    `NET_SOCK=${o.netSocketPath}`,
    `NET_MAC=${o.netMac}`,
    `MACHINE_TYPE=${defaultMachine}`,
    `ACCEL=${defaultAccel}`,
    `CPU=${defaultCpu}`,
  ];
  console.log(lines.join("\n"));
})();
')"

APPEND="console=ttyAMA0 initramfs_async=1 sandboxfs.mount=/data"

QEMU_CMD=(
  "$QEMU_PATH"
  -nodefaults
  -no-reboot
  -m "$MEMORY"
  -smp "$CPUS"
  -kernel "$KERNEL_PATH"
  -initrd "$INITRD_PATH"
  -append "$APPEND"
  -nographic
  -serial stdio
  -object rng-random,filename=/dev/urandom,id=rng0
  -device virtio-rng-pci,rng=rng0
  -chardev "socket,id=virtiocon0,path=${VIRTIO_SOCK},server=on,wait=off"
  -chardev "socket,id=virtiofs0,path=${VIRTIO_FS_SOCK},server=on,wait=off"
  -device virtio-serial-pci,id=virtio-serial0
  -device "virtserialport,chardev=virtiocon0,name=virtio-port,bus=virtio-serial0.0"
  -device "virtserialport,chardev=virtiofs0,name=virtio-fs,bus=virtio-serial0.0"
  -drive "file=${ROOTFS_PATH},format=raw,if=none,id=drive0,snapshot=on"
  -device "virtio-blk-pci,drive=drive0"
  -netdev "stream,id=net0,server=on,addr.type=unix,addr.path=${NET_SOCK}"
  -device "virtio-net-pci,netdev=net0,mac=${NET_MAC}"
)

if [ -n "$MACHINE_TYPE" ]; then
  QEMU_CMD+=( -machine "$MACHINE_TYPE" )
fi
if [ -n "$ACCEL" ]; then
  QEMU_CMD+=( -accel "$ACCEL" )
fi
if [ -n "$CPU" ]; then
  QEMU_CMD+=( -cpu "$CPU" )
fi

if [ -n "${QEMU_LOG:-}" ]; then
  QEMU_CMD+=( -d guest_errors -D "$QEMU_LOG" )
fi

printf 'Running QEMU:\n  %q' "${QEMU_CMD[0]}"
for arg in "${QEMU_CMD[@]:1}"; do
  printf ' %q' "$arg"
done
printf '\n\n'

exec "${QEMU_CMD[@]}"

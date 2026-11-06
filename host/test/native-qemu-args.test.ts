import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { __test, type SandboxConfig } from "../src/sandbox/controller.ts";
import { nativeDaemonArgs } from "../src/native/binary.ts";
import { resolveNativeBinary } from "../src/native/transport.ts";

function findBinary(): string | null {
  try {
    return resolveNativeBinary();
  } catch {
    return null;
  }
}

const binary = findBinary();

const base: SandboxConfig = {
  qemuPath: "qemu-system-aarch64",
  kernelPath: "/img/vmlinuz-virt",
  initrdPath: "/img/initramfs.cpio.lz4",
  rootDiskPath: "/img/rootfs.qcow2",
  rootDiskFormat: "qcow2",
  memory: "1G",
  cpus: 2,
  virtioSocketPath: "/s/control.sock",
  virtioFsSocketPath: "/s/fs.sock",
  virtioSshSocketPath: "/s/ssh.sock",
  virtioIngressSocketPath: "/s/ingress.sock",
  append: "console=ttyAMA0 initramfs_async=1 sandboxfs.mount=/data",
  autoRestart: false,
};

const cases: Array<[string, Partial<SandboxConfig>]> = [
  ["defaults for the host", {}],
  ["x86_64 qemu", { qemuPath: "/usr/bin/qemu-system-x86_64" }],
  [
    "explicit kvm + microvm",
    { qemuPath: "qemu-system-x86_64", accel: "kvm", machineType: "microvm" },
  ],
  ["explicit tcg", { accel: "tcg,thread=multi" }],
  ["cpu override", { cpu: "cortex-a72", machineType: "virt" }],
  ["console none", { console: "none" }],
  [
    "raw readonly snapshot disk",
    {
      rootDiskFormat: "raw",
      rootDiskReadOnly: true,
      rootDiskVolatileMode: "snapshot",
    },
  ],
  ["no root disk", { rootDiskPath: undefined }],
  ["network", { netSocketPath: "/s/net.sock", netMac: "02:00:00:00:00:09" }],
  ["network default mac", { netSocketPath: "/s/net.sock" }],
  ["qmp", { qmpSocketPath: "/s/qmp.sock" }],
];

function nativeArgs(config: SandboxConfig): string[] {
  const input = {
    vm: {
      qemu_path: config.qemuPath,
      kernel_path: config.kernelPath,
      initrd_path: config.initrdPath,
      root_disk: config.rootDiskPath
        ? {
            path: config.rootDiskPath,
            format: config.rootDiskFormat ?? "raw",
            read_only: config.rootDiskReadOnly ?? false,
            snapshot: config.rootDiskVolatileMode === "snapshot",
          }
        : undefined,
      memory: config.memory,
      cpus: config.cpus,
      machine_type: config.machineType,
      accel: config.accel,
      cpu: config.cpu,
      console: config.console,
      mac: config.netMac,
    },
    append: config.append,
    control: config.virtioSocketPath,
    fs: config.virtioFsSocketPath,
    ssh: config.virtioSshSocketPath,
    ingress: config.virtioIngressSocketPath,
    net_socket: config.netSocketPath,
    qmp_socket: config.qmpSocketPath,
  };
  const out = execFileSync(
    binary!,
    [...nativeDaemonArgs(binary!), "--qemu-args"],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
    },
  );
  return JSON.parse(out) as string[];
}

for (const [name, overrides] of cases) {
  test(`native qemu args match buildQemuArgs: ${name}`, {
    skip: binary ? false : "gondolind binary not built",
  }, () => {
    const config: SandboxConfig = { ...base, ...overrides };
    assert.deepEqual(nativeArgs(config), __test.buildQemuArgs(config));
  });
}

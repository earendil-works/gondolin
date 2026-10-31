import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { __test as controllerTest } from "../src/sandbox/controller.ts";
import type { SandboxConfig } from "../src/sandbox/controller.ts";
import {
  extraDiskMounts,
  resolveSandboxServerOptions,
  type SandboxExtraDisk,
} from "../src/sandbox/server-options.ts";
import {
  assertExtraDiskMountsDoNotOverlap,
  buildExtraDisksAppend,
} from "../src/sandbox/extra-disks.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-extra-disks-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function touch(name: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, "");
  return file;
}

const kernelPath = touch("vmlinuz");
const initrdPath = touch("initramfs.cpio");
const rootfsPath = touch("rootfs.ext4");

function resolveWith(extraDisks?: SandboxExtraDisk[], vmm?: "qemu" | "krun") {
  return resolveSandboxServerOptions(
    {
      vmm,
      imagePath: { kernelPath, initrdPath, rootfsPath },
      extraDisks,
    },
    undefined,
    { resolveDefaultKrunRunnerPath: () => "/bin/false" },
  );
}

function makeConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    qemuPath: "qemu-system-aarch64",
    kernelPath: "/tmp/vmlinuz",
    initrdPath: "/tmp/initrd",
    rootDiskPath: "/tmp/rootfs.ext4",
    rootDiskFormat: "raw",
    memory: "256M",
    cpus: 1,
    virtioSocketPath: "/tmp/virtio.sock",
    virtioFsSocketPath: "/tmp/virtiofs.sock",
    virtioSshSocketPath: "/tmp/virtio-ssh.sock",
    virtioIngressSocketPath: "/tmp/virtio-ingress.sock",
    append: "console=ttyS0",
    machineType: "virt",
    accel: "tcg",
    cpu: "max",
    console: "none",
    autoRestart: false,
    ...overrides,
  };
}

function optionValues(args: string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag ? [args[i + 1]!] : []));
}

test("extraDisks: resolves to an empty list when omitted", () => {
  assert.deepEqual(resolveWith().extraDisks, []);
});

test("extraDisks: defaults to read-only with the format inferred from the path", () => {
  const raw = touch("toolchain.img");
  const qcow2 = touch("data.qcow2");

  const resolved = resolveWith([
    { path: raw, serial: "toolchain" },
    { path: qcow2, readOnly: false },
  ]);

  assert.deepEqual(resolved.extraDisks, [
    { path: raw, format: "raw", readOnly: true, serial: "toolchain" },
    { path: qcow2, format: "qcow2", readOnly: false },
  ]);
});

test("extraDisks: resolves relative paths to absolute ones", () => {
  const disk = touch("relative.img");
  const relative = path.relative(process.cwd(), disk);

  const resolved = resolveWith([{ path: relative }]);

  assert.equal(resolved.extraDisks[0]!.path, disk);
});

test("extraDisks: rejects a missing disk image", () => {
  assert.throws(
    () => resolveWith([{ path: path.join(tmp, "missing.img") }]),
    /sandbox\.extraDisks\[0\]\.path does not exist/,
  );
});

test("extraDisks: rejects serials the virtio-blk id field cannot hold", () => {
  const disk = touch("serial.img");
  for (const serial of ["", "a".repeat(21), "has space", "comma,s"]) {
    assert.throws(
      () => resolveWith([{ path: disk, serial }]),
      /sandbox\.extraDisks\[0\]\.serial must be 1-20 characters/,
      `serial ${JSON.stringify(serial)}`,
    );
  }
  assert.equal(
    resolveWith([{ path: disk, serial: "a".repeat(20) }]).extraDisks[0]!.serial,
    "a".repeat(20),
  );
});

test("extraDisks: rejects duplicate serials", () => {
  const first = touch("first.img");
  const second = touch("second.img");
  assert.throws(
    () =>
      resolveWith([
        { path: first, serial: "same" },
        { path: second, serial: "same" },
      ]),
    /sandbox\.extraDisks\[1\]\.serial is not unique/,
  );
});

test("extraDisks: rejected for vmm=krun", () => {
  const disk = touch("krun.img");
  assert.throws(
    () => resolveWith([{ path: disk }], "krun"),
    /Unsupported sandbox option for vmm=krun: sandbox\.extraDisks/,
  );
});

test("buildQemuArgs: attaches extra disks after the root disk on virtio-blk-pci", () => {
  const args = controllerTest.buildQemuArgs(
    makeConfig({
      extraDisks: [
        {
          path: "/disks/toolchain.img",
          format: "raw",
          readOnly: true,
          serial: "toolchain",
        },
        { path: "/disks/data.qcow2", format: "qcow2", readOnly: false },
      ],
    }),
  );

  assert.deepEqual(optionValues(args, "-drive"), [
    "file=/tmp/rootfs.ext4,format=raw,if=none,id=drive0",
    "file=/disks/toolchain.img,format=raw,if=none,id=drive1,readonly=on",
    "file=/disks/data.qcow2,format=qcow2,if=none,id=drive2",
  ]);
  const blkDevices = optionValues(args, "-device").filter((value) =>
    value.startsWith("virtio-blk"),
  );
  assert.deepEqual(blkDevices, [
    "virtio-blk-pci,drive=drive0",
    "virtio-blk-pci,drive=drive1,serial=toolchain",
    "virtio-blk-pci,drive=drive2",
  ]);
});

test("buildQemuArgs: extra disks use virtio-blk-device on microvm", () => {
  const args = controllerTest.buildQemuArgs(
    makeConfig({
      qemuPath: "qemu-system-x86_64",
      machineType: "microvm",
      extraDisks: [
        {
          path: "/disks/toolchain.img",
          format: "raw",
          readOnly: true,
          serial: "toolchain",
        },
      ],
    }),
  );

  assert.ok(
    optionValues(args, "-device").includes(
      "virtio-blk-device,drive=drive1,serial=toolchain",
    ),
  );
});

test("buildQemuArgs: escapes commas in extra disk paths", () => {
  const args = controllerTest.buildQemuArgs(
    makeConfig({
      extraDisks: [{ path: "/disks/a,b.img", format: "raw", readOnly: true }],
    }),
  );

  assert.ok(
    optionValues(args, "-drive").includes(
      "file=/disks/a,,b.img,format=raw,if=none,id=drive1,readonly=on",
    ),
  );
});

test("buildQemuArgs: attaches extra disks without a root disk", () => {
  const args = controllerTest.buildQemuArgs(
    makeConfig({
      rootDiskPath: undefined,
      extraDisks: [{ path: "/disks/only.img", format: "raw", readOnly: true }],
    }),
  );

  assert.deepEqual(optionValues(args, "-drive"), [
    "file=/disks/only.img,format=raw,if=none,id=drive1,readonly=on",
  ]);
});

test("extraDisks: mountPath is normalized and gets a generated serial", () => {
  const first = touch("mounted-first.img");
  const second = touch("mounted-second.img");

  const resolved = resolveWith([
    { path: first, serial: "toolchain", mountPath: "/opt/toolchain/" },
    { path: second, mountPath: "/opt/data", readOnly: false },
  ]);

  assert.deepEqual(resolved.extraDisks, [
    {
      path: first,
      format: "raw",
      readOnly: true,
      serial: "toolchain",
      mountPath: "/opt/toolchain",
    },
    {
      path: second,
      format: "raw",
      readOnly: false,
      serial: "gondolin-disk1",
      mountPath: "/opt/data",
    },
  ]);
  assert.deepEqual(extraDiskMounts(resolved.extraDisks), [
    { serial: "toolchain", mountPath: "/opt/toolchain", readOnly: true },
    { serial: "gondolin-disk1", mountPath: "/opt/data", readOnly: false },
  ]);
});

test("extraDisks: a disk without mountPath gets no generated serial", () => {
  const disk = touch("unmounted.img");
  assert.equal(resolveWith([{ path: disk }]).extraDisks[0]!.serial, undefined);
});

test("extraDisks: rejects an explicit serial that a generated one would reuse", () => {
  const first = touch("generated-first.img");
  const second = touch("generated-second.img");
  assert.throws(
    () =>
      resolveWith([
        { path: first, mountPath: "/opt/a" },
        { path: second, serial: "gondolin-disk0" },
      ]),
    /sandbox\.extraDisks\[0\] needs a serial/,
  );
});

test("extraDisks: rejects invalid mount paths", () => {
  const disk = touch("bad-mount.img");
  for (const mountPath of [
    "relative",
    "/",
    "/with space",
    "/with,comma",
    "/with:colon",
    "/glob*",
    "/proc",
    "/dev/disk",
    "/run/x",
  ]) {
    assert.throws(
      () => resolveWith([{ path: disk, mountPath }]),
      /sandbox\.extraDisks\[0\]\.mountPath/,
      mountPath,
    );
  }
});

test("extraDisks: rejects duplicate mount paths", () => {
  const first = touch("dup-first.img");
  const second = touch("dup-second.img");
  assert.throws(
    () =>
      resolveWith([
        { path: first, mountPath: "/opt/x" },
        { path: second, mountPath: "/opt/x/" },
      ]),
    /mountPath specified more than once: \/opt\/x/,
  );
});

test("extraDisks: may sit below a tmpfs mount but not on or above one", () => {
  const disk = touch("tmpfs-overlap.img");
  assert.equal(
    resolveWith([{ path: disk, mountPath: "/tmp/tools" }]).extraDisks[0]!
      .mountPath,
    "/tmp/tools",
  );
  for (const mountPath of ["/tmp", "/var"]) {
    assert.throws(
      () => resolveWith([{ path: disk, mountPath }]),
      /would hide the tmpfs mount/,
      mountPath,
    );
  }
  assert.equal(
    resolveSandboxServerOptions({
      imagePath: { kernelPath, initrdPath, rootfsPath },
      tmpfs: {},
      extraDisks: [{ path: disk, mountPath: "/tmp" }],
    }).extraDisks[0]!.mountPath,
    "/tmp",
  );
});

test("extraDisks: mounts may not overlap VFS mounts", () => {
  const mounts = [
    { serial: "s", mountPath: "/workspace/tools", readOnly: true },
  ];
  assert.doesNotThrow(() =>
    assertExtraDiskMountsDoNotOverlap(mounts, { vfs: ["/data", "/other"] }),
  );
  for (const vfsPath of [
    "/workspace",
    "/workspace/tools",
    "/workspace/tools/x",
    "/",
  ]) {
    assert.throws(
      () => assertExtraDiskMountsDoNotOverlap(mounts, { vfs: [vfsPath] }),
      /overlaps the VFS mount/,
      vfsPath,
    );
  }
});

test("extraDisks: cmdline append lists mounts sorted by path", () => {
  assert.equal(
    buildExtraDisksAppend([
      { serial: "inner", mountPath: "/opt/a/b", readOnly: false },
      { serial: "outer", mountPath: "/opt/a", readOnly: true },
    ]),
    "gondolin.disks=outer:/opt/a:ro,inner:/opt/a/b:rw",
  );
});

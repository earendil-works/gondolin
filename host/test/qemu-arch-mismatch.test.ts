import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveSandboxServerOptions } from "../src/sandbox/server-options.ts";

function makeTempAssetsDir(arch: "aarch64" | "x86_64"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-arch-"));

  // Required asset files (can be empty for this test).
  fs.writeFileSync(path.join(dir, "vmlinuz-virt"), "");
  fs.writeFileSync(path.join(dir, "initramfs.cpio.lz4"), "");
  fs.writeFileSync(path.join(dir, "rootfs.ext4"), "");

  // Manifest is what we use to detect the guest architecture.
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        config: {
          arch,
          distro: "alpine",
          alpine: { version: "3.23.0" },
        },
        buildTime: new Date().toISOString(),
        assets: {
          kernel: "vmlinuz-virt",
          initramfs: "initramfs.cpio.lz4",
          rootfs: "rootfs.ext4",
        },
        checksums: {
          kernel: "",
          initramfs: "",
          rootfs: "",
        },
      },
      null,
      2,
    ),
  );

  return dir;
}

test("resolveSandboxServerOptions fails fast on guest/qemu arch mismatch", () => {
  const dir = makeTempAssetsDir("aarch64");
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          qemuPath: "qemu-system-x86_64",
        }),
      /Guest image architecture mismatch/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions allows matching guest/qemu arch", () => {
  const dir = makeTempAssetsDir("aarch64");
  try {
    const resolved = resolveSandboxServerOptions({
      imagePath: dir,
      qemuPath: "qemu-system-aarch64",
    });
    assert.equal(path.basename(resolved.kernelPath), "vmlinuz-virt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions fails fast on guest/krun host arch mismatch", () => {
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const otherArch = hostArch === "aarch64" ? "x86_64" : "aarch64";
  const dir = makeTempAssetsDir(otherArch);
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          vmm: "krun",
        }),
      /Guest image architecture mismatch for libkrun backend/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions rejects invalid vmm backend", () => {
  const dir = makeTempAssetsDir("aarch64");
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          vmm: "wat" as any,
        }),
      /invalid sandbox vmm backend/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions rejects qemu-only options for krun", () => {
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const dir = makeTempAssetsDir(hostArch);
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          vmm: "krun",
          qemuPath: "qemu-system-aarch64",
          machineType: "virt",
          accel: "tcg",
          cpu: "max",
        }),
      /Unsupported sandbox options for vmm=krun: sandbox\.qemuPath, sandbox\.machineType, sandbox\.accel, sandbox\.cpu/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions rejects single qemu-only option for krun", () => {
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const dir = makeTempAssetsDir(hostArch);
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions({
          imagePath: dir,
          vmm: "krun",
          machineType: "virt",
        }),
      /Unsupported sandbox option for vmm=krun: sandbox\.machineType/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions uses GONDOLIN_KRUN_KERNEL override", () => {
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const dir = makeTempAssetsDir(hostArch);
  const kernelOverride = path.join(dir, "krun-override-kernel");
  const initrdOverride = path.join(dir, "krun-override-initrd");
  fs.writeFileSync(kernelOverride, "kernel");
  fs.writeFileSync(initrdOverride, "");

  const prevKernel = process.env.GONDOLIN_KRUN_KERNEL;
  const prevInitrd = process.env.GONDOLIN_KRUN_INITRD;
  process.env.GONDOLIN_KRUN_KERNEL = kernelOverride;
  process.env.GONDOLIN_KRUN_INITRD = initrdOverride;

  try {
    const resolved = resolveSandboxServerOptions({
      imagePath: dir,
      vmm: "krun",
    });

    assert.equal(resolved.kernelPath, kernelOverride);
    assert.equal(resolved.initrdPath, initrdOverride);
  } finally {
    if (prevKernel === undefined) delete process.env.GONDOLIN_KRUN_KERNEL;
    else process.env.GONDOLIN_KRUN_KERNEL = prevKernel;
    if (prevInitrd === undefined) delete process.env.GONDOLIN_KRUN_INITRD;
    else process.env.GONDOLIN_KRUN_INITRD = prevInitrd;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions keeps explicit asset object for krun", () => {
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const dir = makeTempAssetsDir(hostArch);
  const kernelOverride = path.join(dir, "krun-override-kernel");
  fs.writeFileSync(kernelOverride, "kernel");

  const prevKernel = process.env.GONDOLIN_KRUN_KERNEL;
  process.env.GONDOLIN_KRUN_KERNEL = kernelOverride;

  try {
    const explicitAssets = {
      kernelPath: path.join(dir, "vmlinuz-virt"),
      initrdPath: path.join(dir, "initramfs.cpio.lz4"),
      rootfsPath: path.join(dir, "rootfs.ext4"),
    };

    const resolved = resolveSandboxServerOptions({
      imagePath: explicitAssets,
      vmm: "krun",
    });

    assert.equal(resolved.kernelPath, explicitAssets.kernelPath);
    assert.equal(resolved.initrdPath, explicitAssets.initrdPath);
  } finally {
    if (prevKernel === undefined) delete process.env.GONDOLIN_KRUN_KERNEL;
    else process.env.GONDOLIN_KRUN_KERNEL = prevKernel;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

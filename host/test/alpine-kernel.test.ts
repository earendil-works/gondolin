import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../src/build/alpine.ts";

const { stageInstalledKernel } = __test;

function writeKernel(root: string, name: string, contents: string): void {
  const bootDir = path.join(root, "boot");
  fs.mkdirSync(bootDir, { recursive: true });
  fs.writeFileSync(path.join(bootDir, name), contents);
}

test("alpine build: stages kernel from the filesystem containing modules", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-kernel-"));
  const rootfsDir = path.join(tmp, "rootfs");
  const initramfsDir = path.join(tmp, "initramfs");
  const outputPath = path.join(tmp, "vmlinuz-virt");

  writeKernel(rootfsDir, "vmlinuz-virt", "rootfs-kernel");
  writeKernel(initramfsDir, "vmlinuz-virt", "initramfs-kernel");

  try {
    stageInstalledKernel(
      rootfsDir,
      initramfsDir,
      false,
      "vmlinuz-virt",
      outputPath,
    );
    assert.equal(fs.readFileSync(outputPath, "utf8"), "rootfs-kernel");

    stageInstalledKernel(
      rootfsDir,
      initramfsDir,
      true,
      "vmlinuz-virt",
      outputPath,
    );
    assert.equal(fs.readFileSync(outputPath, "utf8"), "initramfs-kernel");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("alpine build: rejects a kernel missing beside its modules", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-kernel-"));

  try {
    assert.throws(
      () =>
        stageInstalledKernel(
          path.join(tmp, "rootfs"),
          path.join(tmp, "initramfs"),
          true,
          "vmlinuz-custom",
          path.join(tmp, "vmlinuz-virt"),
        ),
      /Kernel image 'vmlinuz-custom' was not installed in the filesystem containing its modules/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

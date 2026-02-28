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

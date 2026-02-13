import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveSandboxServerOptions } from "../src/sandbox-server";

function makeTempAssetsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-stdin-"));

  // Required asset files (can be empty for this test).
  fs.writeFileSync(path.join(dir, "vmlinuz-virt"), "");
  fs.writeFileSync(path.join(dir, "initramfs.cpio.lz4"), "");
  fs.writeFileSync(path.join(dir, "rootfs.ext4"), "");

  // A minimal manifest so arch detection passes.
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        config: {
          arch: "aarch64",
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
      2
    )
  );

  return dir;
}

test("resolveSandboxServerOptions ensures queued stdin caps are >= maxStdinBytes", () => {
  const dir = makeTempAssetsDir();
  try {
    const resolved = resolveSandboxServerOptions({
      imagePath: dir,
      qemuPath: "qemu-system-aarch64",
      maxStdinBytes: 16 * 1024 * 1024,
    });

    assert.ok(resolved.maxQueuedStdinBytes >= resolved.maxStdinBytes);
    assert.ok(resolved.maxTotalQueuedStdinBytes >= resolved.maxQueuedStdinBytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function makeTempGuestDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-guest-assets-"));
  fs.writeFileSync(path.join(dir, "vmlinuz-virt"), "");
  fs.writeFileSync(path.join(dir, "initramfs.cpio.lz4"), "");
  fs.writeFileSync(path.join(dir, "rootfs.ext4"), "");
  return dir;
}

test("cli: gondolin bash renders a friendly error if qemu is missing from PATH", () => {
  const guestDir = makeTempGuestDir();
  const emptyPathDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-empty-path-"),
  );

  try {
    const hostDir = path.join(import.meta.dirname, "..");

    const result = spawnSync(
      process.execPath,
      ["bin/gondolin.ts", "bash"],
      {
        cwd: hostDir,
        env: {
          ...process.env,
          GONDOLIN_GUEST_DIR: guestDir,
          PATH: emptyPathDir,
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );

    assert.notEqual(
      result.status,
      0,
      `expected non-zero exit, got ${result.status}`,
    );

    const stderr = result.stderr ?? "";
    assert.match(stderr, /QEMU binary '.*qemu.*' not found/i);

    if (process.platform === "darwin") {
      assert.match(stderr, /brew install qemu/);
    } else {
      assert.match(stderr, /apt install qemu/i);
    }
  } finally {
    fs.rmSync(guestDir, { recursive: true, force: true });
    fs.rmSync(emptyPathDir, { recursive: true, force: true });
  }
});

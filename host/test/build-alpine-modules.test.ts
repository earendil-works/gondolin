/**
 * Owns regression coverage for initramfs kernel-module selection in the Alpine builder
 * Does not own end-to-end image build or VM boot integration behavior
 * Invariant: required boot modules resolve regardless of compression suffix
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test } from "../src/build-alpine";

function writeFile(filePath: string, content = ""): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("build-alpine: copyInitramfsModules resolves compressed modules from modules.dep", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-build-alpine-modules-"));
  const srcDir = path.join(tmpDir, "src");
  const dstDir = path.join(tmpDir, "dst");

  try {
    const deps = [
      "kernel/drivers/block/virtio_blk.ko.zst:",
      "kernel/fs/ext4/ext4.ko.zst: kernel/fs/jbd2/jbd2.ko.zst kernel/crypto/crc32c_generic.ko.zst kernel/lib/libcrc32c.ko.zst",
      "kernel/fs/jbd2/jbd2.ko.zst:",
      "kernel/crypto/crc32c_generic.ko.zst:",
      "kernel/lib/libcrc32c.ko.zst:",
    ].join("\n");

    writeFile(path.join(srcDir, "modules.dep"), `${deps}\n`);
    writeFile(path.join(srcDir, "modules.alias"), "# test metadata\n");

    writeFile(path.join(srcDir, "kernel/drivers/block/virtio_blk.ko.zst"));
    writeFile(path.join(srcDir, "kernel/fs/ext4/ext4.ko.zst"));
    writeFile(path.join(srcDir, "kernel/fs/jbd2/jbd2.ko.zst"));
    writeFile(path.join(srcDir, "kernel/crypto/crc32c_generic.ko.zst"));
    writeFile(path.join(srcDir, "kernel/lib/libcrc32c.ko.zst"));

    __test.copyInitramfsModules(srcDir, dstDir);

    const expectedModules = [
      "kernel/drivers/block/virtio_blk.ko.zst",
      "kernel/fs/ext4/ext4.ko.zst",
      "kernel/fs/jbd2/jbd2.ko.zst",
      "kernel/crypto/crc32c_generic.ko.zst",
      "kernel/lib/libcrc32c.ko.zst",
    ];

    for (const entry of expectedModules) {
      assert.equal(fs.existsSync(path.join(dstDir, entry)), true, `missing copied module: ${entry}`);
    }

    assert.equal(fs.existsSync(path.join(dstDir, "modules.dep")), true);
    assert.equal(fs.existsSync(path.join(dstDir, "modules.alias")), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INITRAMFS_FILENAME,
  KERNEL_FILENAME,
  KRUN_INITRD_FILENAME,
  KRUN_KERNEL_FILENAME,
} from "../src/build/shared.ts";
import { __test as nativeBuildTest } from "../src/build/native.ts";

test("writeKrunAssetsFromAlpine reuses the Alpine kernel and initramfs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-krun-assets-"));

  try {
    const kernelPath = path.join(dir, KERNEL_FILENAME);
    const initramfsPath = path.join(dir, INITRAMFS_FILENAME);
    fs.writeFileSync(kernelPath, "bzImage");
    fs.writeFileSync(initramfsPath, "initramfs");

    nativeBuildTest.writeKrunAssetsFromAlpine(dir, kernelPath);

    assert.equal(
      fs.readFileSync(path.join(dir, KRUN_KERNEL_FILENAME), "utf8"),
      "bzImage",
    );
    assert.equal(
      fs.readFileSync(path.join(dir, KRUN_INITRD_FILENAME), "utf8"),
      "initramfs",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

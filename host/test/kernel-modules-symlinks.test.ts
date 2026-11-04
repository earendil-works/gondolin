import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncKernelModules } from "../src/alpine/kernel-modules.ts";

test("kernel module copy keeps guest-relative symlinks verbatim", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-modules-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const rootfs = path.join(root, "rootfs");
  const initramfs = path.join(root, "initramfs");
  const version = "6.test";
  const initramfsModules = path.join(initramfs, "lib/modules", version);
  fs.mkdirSync(initramfsModules, { recursive: true });
  fs.mkdirSync(path.join(rootfs, "lib/modules"), { recursive: true });

  fs.writeFileSync(path.join(initramfsModules, "target.ko"), "module");
  try {
    fs.symlinkSync("target.ko", path.join(initramfsModules, "link.ko"));
  } catch {
    // Windows without Developer Mode / elevation cannot create symlinks.
    t.skip("symlink creation is not permitted on this host");
    return;
  }

  // The initramfs version is absent from the rootfs, so every module is copied.
  syncKernelModules(rootfs, initramfs, () => {}, {
    copyRootfsToInitramfs: false,
  });

  const copied = path.join(rootfs, "lib/modules", version, "link.ko");
  assert.equal(
    fs.readlinkSync(copied),
    "target.ko",
    "a relative link must stay relative, not point back into the host temp dir",
  );
});

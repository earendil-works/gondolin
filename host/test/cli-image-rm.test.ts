import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import assert from "node:assert/strict";
import test from "node:test";

import { computeAssetBuildId } from "../src/assets.ts";
import { importImageFromDirectory } from "../src/images.ts";

const hostDir = path.join(import.meta.dirname, "..");

function createFakeAssets(): { dir: string; buildId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cli-image-"));
  fs.writeFileSync(path.join(dir, "vmlinuz-virt"), "kernel");
  fs.writeFileSync(path.join(dir, "initramfs.cpio.lz4"), "initramfs");
  fs.writeFileSync(path.join(dir, "rootfs.ext4"), "rootfs");
  const checksums = {
    kernel: "kernel",
    initramfs: "initramfs",
    rootfs: "rootfs",
  };
  const buildId = computeAssetBuildId({ checksums, arch: "x86_64" });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      version: 1,
      buildId,
      config: { arch: "x86_64", distro: "alpine" },
      buildTime: new Date().toISOString(),
      assets: {
        kernel: "vmlinuz-virt",
        initramfs: "initramfs.cpio.lz4",
        rootfs: "rootfs.ext4",
      },
      checksums,
    }),
  );
  return { dir, buildId };
}

function runImageCommand(storeDir: string, args: string[], input?: string) {
  return spawnSync(process.execPath, ["bin/gondolin.ts", "image", ...args], {
    cwd: hostDir,
    env: { ...process.env, GONDOLIN_IMAGE_STORE: storeDir },
    encoding: "utf8",
    input,
    timeout: 15000,
  });
}

test("cli: image ls shows untagged images and rm prompts before deletion", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-store-"));
  const assets = createFakeAssets();
  const previousStore = process.env.GONDOLIN_IMAGE_STORE;

  try {
    process.env.GONDOLIN_IMAGE_STORE = storeDir;
    const imported = importImageFromDirectory(assets.dir);

    const listed = runImageCommand(storeDir, ["ls"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(
      listed.stdout,
      new RegExp(`<untagged>  x86_64=${assets.buildId}`),
    );

    const declined = runImageCommand(storeDir, ["rm", assets.buildId], "n\n");
    assert.equal(declined.status, 0, declined.stderr);
    assert.match(declined.stdout, /Aborted/);
    assert.equal(fs.existsSync(imported.assetDir), true);

    const accepted = runImageCommand(storeDir, ["rm", "--untagged"], "yes\n");
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, new RegExp(`Deleted: ${assets.buildId}`));
    assert.equal(fs.existsSync(imported.assetDir), false);
  } finally {
    if (previousStore === undefined) {
      delete process.env.GONDOLIN_IMAGE_STORE;
    } else {
      process.env.GONDOLIN_IMAGE_STORE = previousStore;
    }
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
  }
});

test("cli: image rm requires exactly one removal mode", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-store-"));

  try {
    const result = runImageCommand(storeDir, [
      "rm",
      "--all",
      "--untagged",
      "--yes",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires exactly one/);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

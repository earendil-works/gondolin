import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeAssetBuildId } from "../src/assets.ts";
import {
  INITRAMFS_FILENAME,
  KERNEL_FILENAME,
  KRUN_INITRD_FILENAME,
  KRUN_KERNEL_FILENAME,
  ROOTFS_FILENAME,
  WASM_FILENAME,
  writeAssetManifest,
} from "../src/build/shared.ts";
import type { BuildConfig } from "../src/build/config.ts";

function makeConfig(): BuildConfig {
  return {
    arch: "x86_64",
    distro: "alpine",
    alpine: {
      version: "3.23.0",
      krunfwVersion: "v5.2.1",
    },
  };
}

test("builder: writeAssetManifest includes krun checksums when krun assets exist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-manifest-"));

  try {
    fs.writeFileSync(path.join(dir, KERNEL_FILENAME), "kernel");
    fs.writeFileSync(path.join(dir, INITRAMFS_FILENAME), "initramfs");
    fs.writeFileSync(path.join(dir, ROOTFS_FILENAME), "rootfs");
    fs.writeFileSync(path.join(dir, KRUN_KERNEL_FILENAME), "krun-kernel");
    fs.writeFileSync(path.join(dir, KRUN_INITRD_FILENAME), "");

    const { manifest } = writeAssetManifest(dir, makeConfig());

    assert.equal(manifest.assets.krunKernel, KRUN_KERNEL_FILENAME);
    assert.equal(manifest.assets.krunInitrd, KRUN_INITRD_FILENAME);
    assert.ok(manifest.checksums.krunKernel);
    assert.ok(manifest.checksums.krunInitrd);
    assert.equal(
      manifest.buildId,
      computeAssetBuildId({ checksums: manifest.checksums, arch: "x86_64" }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("builder: writeAssetManifest includes wasm checksum when wasm asset exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-manifest-"));

  try {
    fs.writeFileSync(path.join(dir, KERNEL_FILENAME), "kernel");
    fs.writeFileSync(path.join(dir, INITRAMFS_FILENAME), "initramfs");
    fs.writeFileSync(path.join(dir, ROOTFS_FILENAME), "rootfs");
    fs.writeFileSync(path.join(dir, WASM_FILENAME), "wasm");

    const { manifest } = writeAssetManifest(dir, makeConfig());

    assert.equal(manifest.assets.wasm, WASM_FILENAME);
    assert.ok(manifest.checksums.wasm);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("builder: writeAssetManifest omits krun checksums when krun assets are absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-manifest-"));

  try {
    fs.writeFileSync(path.join(dir, KERNEL_FILENAME), "kernel");
    fs.writeFileSync(path.join(dir, INITRAMFS_FILENAME), "initramfs");
    fs.writeFileSync(path.join(dir, ROOTFS_FILENAME), "rootfs");

    const { manifest } = writeAssetManifest(dir, makeConfig());

    assert.equal(manifest.assets.krunKernel, undefined);
    assert.equal(manifest.assets.krunInitrd, undefined);
    assert.equal(manifest.assets.wasm, undefined);
    assert.equal(manifest.checksums.krunKernel, undefined);
    assert.equal(manifest.checksums.krunInitrd, undefined);
    assert.equal(manifest.checksums.wasm, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

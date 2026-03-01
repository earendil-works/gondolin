import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, mock } from "node:test";

import {
  MANIFEST_FILENAME,
  computeAssetBuildId,
  ensureGuestAssets,
  getAssetDirectory,
  getAssetVersion,
  hasGuestAssets,
  loadAssetManifest,
  loadGuestAssets,
  __test,
} from "../src/assets.ts";

afterEach(() => {
  mock.restoreAll();
  __test.resetAssetVersionCache();
});

test("assets: loadAssetManifest returns null for missing/invalid manifest", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-assets-manifest-"),
  );
  try {
    assert.equal(loadAssetManifest(dir), null);

    fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), "not json");
    assert.equal(loadAssetManifest(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("assets: loadAssetManifest parses valid manifest", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-assets-manifest-"),
  );
  try {
    const checksums = { kernel: "", initramfs: "", rootfs: "" };
    const manifest = {
      version: 1,
      buildId: computeAssetBuildId({ checksums, arch: "aarch64" }),
      config: {
        arch: "aarch64",
        distro: "alpine",
        alpine: { version: "3.23.0" },
      },
      buildTime: new Date().toISOString(),
      assets: { kernel: "k", initramfs: "i", rootfs: "r" },
      checksums,
    };
    fs.writeFileSync(
      path.join(dir, MANIFEST_FILENAME),
      JSON.stringify(manifest),
    );

    const parsed = loadAssetManifest(dir);
    assert.ok(parsed);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.buildId, manifest.buildId);
    assert.equal(parsed.assets.kernel, "k");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("assets: computeAssetBuildId is deterministic", () => {
  const id1 = computeAssetBuildId({
    checksums: { kernel: "a", initramfs: "b", rootfs: "c" },
    arch: "aarch64",
  });
  const id2 = computeAssetBuildId({
    checksums: { kernel: "a", initramfs: "b", rootfs: "c" },
    arch: "aarch64",
  });
  const id3 = computeAssetBuildId({
    checksums: { kernel: "a", initramfs: "b", rootfs: "d" },
    arch: "aarch64",
  });

  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
});

test("assets: loadGuestAssets uses manifest filenames and validates existence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-assets-load-"));
  try {
    const manifest = {
      version: 1,
      config: {
        arch: "aarch64",
        distro: "alpine",
        alpine: { version: "3.23.0" },
      },
      buildTime: new Date().toISOString(),
      assets: {
        kernel: "kernel.bin",
        initramfs: "initrd.bin",
        rootfs: "rootfs.img",
      },
      checksums: { kernel: "", initramfs: "", rootfs: "" },
    };
    fs.writeFileSync(
      path.join(dir, MANIFEST_FILENAME),
      JSON.stringify(manifest),
    );

    assert.throws(() => loadGuestAssets(dir), /Missing guest assets/);

    fs.writeFileSync(path.join(dir, "kernel.bin"), "");
    fs.writeFileSync(path.join(dir, "initrd.bin"), "");
    fs.writeFileSync(path.join(dir, "rootfs.img"), "");

    const assets = loadGuestAssets(dir);
    assert.equal(path.basename(assets.kernelPath), "kernel.bin");
    assert.equal(path.basename(assets.initrdPath), "initrd.bin");
    assert.equal(path.basename(assets.rootfsPath), "rootfs.img");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("assets: getAssetVersion returns v-prefixed semver", () => {
  const version = getAssetVersion();
  assert.match(version, /^v\d+\.\d+\.\d+/);
});

test("assets: getAssetDirectory and hasGuestAssets respect GONDOLIN_GUEST_DIR", () => {
  const prev = process.env.GONDOLIN_GUEST_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-assets-dir-"));

  try {
    process.env.GONDOLIN_GUEST_DIR = dir;

    assert.equal(getAssetDirectory(), dir);
    assert.equal(hasGuestAssets(), false);

    fs.writeFileSync(path.join(dir, "vmlinuz-virt"), "");
    fs.writeFileSync(path.join(dir, "initramfs.cpio.lz4"), "");
    fs.writeFileSync(path.join(dir, "rootfs.ext4"), "");

    assert.equal(hasGuestAssets(), true);
  } finally {
    if (prev === undefined) delete process.env.GONDOLIN_GUEST_DIR;
    else process.env.GONDOLIN_GUEST_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("assets: ensureGuestAssets with GONDOLIN_GUEST_DIR does not download", async () => {
  const prev = process.env.GONDOLIN_GUEST_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-assets-ensure-"));
  try {
    process.env.GONDOLIN_GUEST_DIR = dir;

    const fetchSpy = mock.fn();
    (globalThis as any).fetch = fetchSpy;

    await assert.rejects(() => ensureGuestAssets(), /Missing guest assets/);
    assert.equal(fetchSpy.mock.calls.length, 0);

    fs.writeFileSync(path.join(dir, "vmlinuz-virt"), "");
    fs.writeFileSync(path.join(dir, "initramfs.cpio.lz4"), "");
    fs.writeFileSync(path.join(dir, "rootfs.ext4"), "");

    const assets = await ensureGuestAssets();
    assert.equal(path.dirname(assets.kernelPath), dir);
    assert.equal(fetchSpy.mock.calls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.GONDOLIN_GUEST_DIR;
    else process.env.GONDOLIN_GUEST_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeDefaultManifest(dir: string, arch: "aarch64" | "x86_64"): string {
  const checksums = {
    kernel: `k-${arch}`,
    initramfs: `i-${arch}`,
    rootfs: `r-${arch}`,
  };
  const buildId = computeAssetBuildId({ checksums, arch });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "vmlinuz-virt"), "");
  fs.writeFileSync(path.join(dir, "initramfs.cpio.lz4"), "");
  fs.writeFileSync(path.join(dir, "rootfs.ext4"), "");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      version: 1,
      buildId,
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
      checksums,
    }),
  );
  return buildId;
}

test("assets: default image ref can resolve from image store symlink", () => {
  const prevStore = process.env.GONDOLIN_IMAGE_STORE;
  const prevDefault = process.env.GONDOLIN_DEFAULT_IMAGE;

  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-image-store-"),
  );

  try {
    process.env.GONDOLIN_IMAGE_STORE = storeDir;
    process.env.GONDOLIN_DEFAULT_IMAGE = "alpine-base:latest";

    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const buildId = writeDefaultManifest(
      path.join(storeDir, "objects", "obj-1"),
      arch,
    );

    const linkPath = path.join(storeDir, "refs", "alpine-base", "latest", arch);
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(
      path.join("..", "..", "..", "objects", "obj-1"),
      linkPath,
      "dir",
    );

    const resolvedDir = __test.resolveDefaultImageAssetDirFromStore();
    assert.ok(resolvedDir);
    assert.equal(
      path.resolve(resolvedDir!),
      path.resolve(storeDir, "objects", "obj-1"),
    );

    const resolved = loadGuestAssets(resolvedDir!);
    assert.equal(path.basename(resolved.kernelPath), "vmlinuz-virt");

    const manifest = loadAssetManifest(path.dirname(resolved.kernelPath));
    assert.equal(manifest?.buildId, buildId);
  } finally {
    if (prevStore === undefined) delete process.env.GONDOLIN_IMAGE_STORE;
    else process.env.GONDOLIN_IMAGE_STORE = prevStore;

    if (prevDefault === undefined) delete process.env.GONDOLIN_DEFAULT_IMAGE;
    else process.env.GONDOLIN_DEFAULT_IMAGE = prevDefault;

    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test("assets: default image ref rejects traversal segments", () => {
  const prevStore = process.env.GONDOLIN_IMAGE_STORE;
  const prevDefault = process.env.GONDOLIN_DEFAULT_IMAGE;

  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-image-store-"),
  );

  try {
    process.env.GONDOLIN_IMAGE_STORE = storeDir;
    process.env.GONDOLIN_DEFAULT_IMAGE = "a/../../../tmp:latest";

    assert.equal(__test.resolveDefaultImageAssetDirFromStore(), null);
  } finally {
    if (prevStore === undefined) delete process.env.GONDOLIN_IMAGE_STORE;
    else process.env.GONDOLIN_IMAGE_STORE = prevStore;

    if (prevDefault === undefined) delete process.env.GONDOLIN_DEFAULT_IMAGE;
    else process.env.GONDOLIN_DEFAULT_IMAGE = prevDefault;

    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

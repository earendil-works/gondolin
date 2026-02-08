import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, mock } from "node:test";
import * as child_process from "child_process";

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
} from "../src/assets";

// In ESM, built-in modules expose live bindings via getters which cannot be
// replaced with node:test mocks. The actual mutable exports object is on
// `default`.
const cp: any = (child_process as any).default ?? (child_process as any);

afterEach(() => {
  mock.restoreAll();
  // reset cached asset version between tests so env changes are respected
  __test.resetAssetVersionCache();
});

test("assets: loadAssetManifest returns null for missing/invalid manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-assets-manifest-"));
  try {
    assert.equal(loadAssetManifest(dir), null);

    fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), "not json");
    assert.equal(loadAssetManifest(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("assets: loadAssetManifest parses valid manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-assets-manifest-"));
  try {
    const checksums = { kernel: "", initramfs: "", rootfs: "" };
    const manifest = {
      version: 1,
      buildId: computeAssetBuildId({ checksums, arch: "aarch64" }),
      config: { arch: "aarch64", distro: "alpine", alpine: { version: "3.23.0" } },
      buildTime: new Date().toISOString(),
      assets: { kernel: "k", initramfs: "i", rootfs: "r" },
      checksums,
    };
    fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), JSON.stringify(manifest));

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
      config: { arch: "aarch64", distro: "alpine", alpine: { version: "3.23.0" } },
      buildTime: new Date().toISOString(),
      assets: { kernel: "kernel.bin", initramfs: "initrd.bin", rootfs: "rootfs.img" },
      checksums: { kernel: "", initramfs: "", rootfs: "" },
    };
    fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), JSON.stringify(manifest));

    // missing should throw
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

    // No download should happen; missing assets should throw from loadGuestAssets.
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

test("assets: downloadAndExtract downloads to temp file and cleans it up", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-assets-download-"));

  try {
    const bundleName = __test.getAssetBundleName();

    // Mock fetch to stream a few bytes.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    (globalThis as any).fetch = mock.fn(async () => {
      return new Response(body, {
        status: 200,
        headers: { "content-length": "3" },
      });
    });

    // Mock tar extraction: create expected files in the target dir.
    mock.method(cp, "execSync", (cmd: string, opts: any) => {
      assert.match(cmd, /tar -xzf/);
      assert.equal(opts.cwd, dir);
      fs.writeFileSync(path.join(dir, "vmlinuz-virt"), "");
      fs.writeFileSync(path.join(dir, "initramfs.cpio.lz4"), "");
      fs.writeFileSync(path.join(dir, "rootfs.ext4"), "");
      return Buffer.from("");
    });

    await __test.downloadAndExtract(dir);

    // The downloaded tarball should be cleaned up.
    assert.equal(fs.existsSync(path.join(dir, bundleName)), false);
    // And the extracted assets should exist.
    assert.equal(__test.assetsExist(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("assets: downloadAndExtract throws on non-ok response", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-assets-download-"));
  try {
    (globalThis as any).fetch = mock.fn(async () => {
      return new Response("no", { status: 404, statusText: "Not Found" });
    });

    await assert.rejects(() => __test.downloadAndExtract(dir), /Failed to download guest image/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

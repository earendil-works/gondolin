import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { computeAssetBuildId } from "../src/assets";
import {
  importImageFromDirectory,
  listImageRefs,
  resolveImageSelector,
  setImageRef,
  tagImage,
} from "../src/images";
import { resolveSandboxServerOptions } from "../src/sandbox/server-options";

const prevImageStore = process.env.GONDOLIN_IMAGE_STORE;

afterEach(() => {
  if (prevImageStore === undefined) {
    delete process.env.GONDOLIN_IMAGE_STORE;
  } else {
    process.env.GONDOLIN_IMAGE_STORE = prevImageStore;
  }
});

type FakeAssets = {
  dir: string;
  buildId: string;
};

function createFakeAssets(arch: "aarch64" | "x86_64"): FakeAssets {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-images-assets-"));

  const kernel = path.join(dir, "vmlinuz-virt");
  const initramfs = path.join(dir, "initramfs.cpio.lz4");
  const rootfs = path.join(dir, "rootfs.ext4");

  fs.writeFileSync(kernel, `kernel-${arch}`);
  fs.writeFileSync(initramfs, `initramfs-${arch}`);
  fs.writeFileSync(rootfs, `rootfs-${arch}`);

  const checksums = {
    kernel: `k-${arch}`,
    initramfs: `i-${arch}`,
    rootfs: `r-${arch}`,
  };

  const buildId = computeAssetBuildId({ checksums, arch });

  const manifest = {
    version: 1,
    buildId,
    config: {
      arch,
      distro: "alpine",
      alpine: {
        version: "3.23.0",
      },
    },
    buildTime: new Date().toISOString(),
    assets: {
      kernel: "vmlinuz-virt",
      initramfs: "initramfs.cpio.lz4",
      rootfs: "rootfs.ext4",
    },
    checksums,
  };

  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));

  return { dir, buildId };
}

function patchManifestAssets(
  dir: string,
  assets: { kernel?: string; initramfs?: string; rootfs?: string },
): void {
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    assets: { kernel: string; initramfs: string; rootfs: string };
  };
  manifest.assets = {
    ...manifest.assets,
    ...assets,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}

test("images: import and resolve by build id", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const assets = createFakeAssets("aarch64");

  try {
    const imported = importImageFromDirectory(assets.dir);
    assert.equal(imported.buildId, assets.buildId);
    assert.equal(imported.arch, "aarch64");

    const resolved = resolveImageSelector(assets.buildId);
    assert.equal(resolved.source, "build-id");
    assert.equal(resolved.buildId, assets.buildId);
    assert.equal(
      path.resolve(resolved.assetDir),
      path.resolve(imported.assetDir),
    );
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
  }
});

test("images: refs resolve with architecture fallback when single target exists", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const assets = createFakeAssets("aarch64");

  try {
    const imported = importImageFromDirectory(assets.dir);
    setImageRef("default:latest", imported.buildId, imported.arch);

    const resolved = resolveImageSelector("default:latest", "x86_64");
    assert.equal(resolved.source, "ref");
    assert.equal(resolved.buildId, imported.buildId);
    assert.equal(resolved.arch, "aarch64");

    const refs = listImageRefs();
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.reference, "default:latest");
    assert.equal(refs[0]?.targets.aarch64, imported.buildId);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
  }
});

test("images: tagImage can tag from asset directory selectors", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const assets = createFakeAssets("x86_64");

  try {
    const imported = importImageFromDirectory(assets.dir);
    const tagged = tagImage(assets.dir, "tooling:dev");

    assert.equal(tagged.reference, "tooling:dev");
    assert.equal(tagged.targets.x86_64, imported.buildId);

    const resolved = resolveImageSelector("tooling:dev", "x86_64");
    assert.equal(resolved.buildId, imported.buildId);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
  }
});

test("images: import rejects manifest asset traversal paths", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const assets = createFakeAssets("aarch64");

  try {
    const victimPath = path.join(storeDir, "victim.txt");
    fs.writeFileSync(victimPath, "safe");

    patchManifestAssets(assets.dir, {
      kernel: "../../victim.txt",
    });

    assert.throws(
      () => importImageFromDirectory(assets.dir),
      /manifest\.assets\.kernel.*must stay within/,
    );
    assert.equal(fs.readFileSync(victimPath, "utf8"), "safe");
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
  }
});

test("images: import rejects absolute manifest asset paths", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const assets = createFakeAssets("x86_64");

  try {
    patchManifestAssets(assets.dir, {
      rootfs: path.join(os.tmpdir(), "gondolin-evil-rootfs.ext4"),
    });

    assert.throws(
      () => importImageFromDirectory(assets.dir),
      /manifest\.assets\.rootfs.*absolute paths are not allowed/,
    );
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
  }
});

test("images: setImageRef fails fast on corrupted ref index json", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const assets = createFakeAssets("aarch64");

  try {
    const imported = importImageFromDirectory(assets.dir);
    const refsPath = path.join(storeDir, "refs.json");
    fs.writeFileSync(refsPath, "{not-json");

    assert.throws(
      () => setImageRef("default:latest", imported.buildId, imported.arch),
      /failed to parse image ref index/,
    );
    assert.equal(fs.readFileSync(refsPath, "utf8"), "{not-json");
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
  }
});

test("images: setImageRef fails fast on invalid ref index schema", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const assets = createFakeAssets("x86_64");

  try {
    const imported = importImageFromDirectory(assets.dir);
    const refsPath = path.join(storeDir, "refs.json");
    fs.writeFileSync(refsPath, JSON.stringify({ version: 1, refs: [] }));

    assert.throws(
      () => setImageRef("default:latest", imported.buildId, imported.arch),
      /refs must be an object/,
    );
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
  }
});

test("images: sandbox server options accept image refs", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const assets = createFakeAssets("aarch64");

  try {
    const imported = importImageFromDirectory(assets.dir);
    setImageRef("default:latest", imported.buildId, imported.arch);

    const resolved = resolveSandboxServerOptions({
      imagePath: "default:latest",
      qemuPath: "qemu-system-aarch64",
      netEnabled: false,
    });

    assert.equal(path.dirname(resolved.rootfsPath), imported.assetDir);
    assert.equal(path.dirname(resolved.kernelPath), imported.assetDir);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
  }
});

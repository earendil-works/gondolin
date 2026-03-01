import assert from "node:assert/strict";
import child_process from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { computeAssetBuildId } from "../src/assets.ts";
import {
  ensureImageSelector,
  importImageFromDirectory,
  listImageRefs,
  resolveImageSelector,
  setImageRef,
  tagImage,
} from "../src/images.ts";
import { resolveSandboxServerOptions } from "../src/sandbox/server-options.ts";

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

function patchManifest(
  dir: string,
  update: (manifest: Record<string, unknown>) => void,
): void {
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  update(manifest);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}

function patchManifestAssets(
  dir: string,
  assets: { kernel?: string; initramfs?: string; rootfs?: string },
): void {
  patchManifest(dir, (manifest) => {
    const currentAssets = (manifest.assets ?? {}) as Record<string, unknown>;
    manifest.assets = {
      ...currentAssets,
      ...assets,
    };
  });
}

function patchManifestBuildId(dir: string, buildId: string): void {
  patchManifest(dir, (manifest) => {
    manifest.buildId = buildId;
  });
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

test("images: import handles ENOTEMPTY race as already-imported", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const assets = createFakeAssets("aarch64");
  const objectDir = path.join(storeDir, "objects", assets.buildId);

  const originalRenameSync = fs.renameSync;
  let renameCalls = 0;

  fs.renameSync = ((oldPath: any, newPath: any) => {
    renameCalls += 1;
    if (renameCalls === 1) {
      fs.mkdirSync(path.dirname(objectDir), { recursive: true });
      fs.cpSync(assets.dir, objectDir, { recursive: true });
      const error = new Error("simulated concurrent import") as Error & {
        code?: string;
      };
      error.code = "ENOTEMPTY";
      throw error;
    }
    return originalRenameSync(oldPath, newPath);
  }) as typeof fs.renameSync;

  try {
    const imported = importImageFromDirectory(assets.dir);
    assert.equal(imported.created, false);
    assert.equal(imported.buildId, assets.buildId);
    assert.equal(path.resolve(imported.assetDir), path.resolve(objectDir));
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
  }
});

test("images: failed import cleans up temporary staging directories", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const assets = createFakeAssets("aarch64");

  try {
    patchManifestAssets(assets.dir, {
      kernel: "missing-kernel",
    });

    assert.throws(
      () => importImageFromDirectory(assets.dir),
      /missing manifest\.assets\.kernel file/,
    );

    const objectsDir = path.join(storeDir, "objects");
    if (fs.existsSync(objectsDir)) {
      const leftovers = fs
        .readdirSync(objectsDir)
        .filter((name) => name.startsWith(`.tmp-${assets.buildId}-`));
      assert.deepEqual(leftovers, []);
    }
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
  }
});

test("images: import rejects non-uuid manifest build ids", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const assets = createFakeAssets("aarch64");

  try {
    patchManifestBuildId(assets.dir, "../escaped");

    assert.throws(
      () => importImageFromDirectory(assets.dir),
      /invalid image build id: \.\.\/escaped/,
    );
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
  }
});

test("images: import rejects uppercase manifest build ids", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const assets = createFakeAssets("x86_64");

  try {
    patchManifestBuildId(assets.dir, assets.buildId.toUpperCase());

    assert.throws(
      () => importImageFromDirectory(assets.dir),
      /invalid image build id/,
    );
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

test("images: setImageRef stores refs as symlinks", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const assets = createFakeAssets("aarch64");

  try {
    const imported = importImageFromDirectory(assets.dir);
    setImageRef("default:latest", imported.buildId, imported.arch);

    const refLink = path.join(storeDir, "refs", "default", "latest", "aarch64");
    assert.equal(fs.lstatSync(refLink).isSymbolicLink(), true);

    const target = fs.readlinkSync(refLink);
    const resolved = path.resolve(path.dirname(refLink), target);
    assert.equal(path.resolve(resolved), path.resolve(imported.assetDir));
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
  }
});

test("images: resolveImageSelector fails fast on malformed ref links", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  try {
    const refPath = path.join(storeDir, "refs", "default", "latest", "x86_64");
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, "not-a-symlink");

    assert.throws(
      () => resolveImageSelector("default:latest", "x86_64"),
      /not a symlink/,
    );
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test("images: ensureImageSelector pulls refs from builtin registry", async () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-images-store-"),
  );
  process.env.GONDOLIN_IMAGE_STORE = storeDir;

  const prevRegistryUrl = process.env.GONDOLIN_IMAGE_REGISTRY_URL;
  process.env.GONDOLIN_IMAGE_REGISTRY_URL =
    "https://example.invalid/builtin-image-registry.json";

  const assets = createFakeAssets("x86_64");
  const archivePath = path.join(
    os.tmpdir(),
    `gondolin-image-${Date.now()}.tar.gz`,
  );

  try {
    child_process.execFileSync(
      "tar",
      [
        "-czf",
        archivePath,
        "manifest.json",
        "vmlinuz-virt",
        "initramfs.cpio.lz4",
        "rootfs.ext4",
      ],
      { cwd: assets.dir, stdio: "pipe" },
    );

    const registry = {
      schema: 1,
      refs: {
        "alpine-base:latest": {
          x86_64: {
            url: "https://example.invalid/assets/alpine-base-latest-x86_64.tar.gz",
            buildId: assets.buildId,
          },
        },
      },
      builds: {},
    };

    const archiveData = fs.readFileSync(archivePath);
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes("builtin-image-registry.json")) {
        return new Response(JSON.stringify(registry), {
          status: 200,
          headers: { etag: '"test"' },
        });
      }
      if (url.endsWith("alpine-base-latest-x86_64.tar.gz")) {
        return new Response(archiveData, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const resolved = await ensureImageSelector("alpine-base:latest", "x86_64");
    assert.equal(resolved.source, "ref");
    assert.equal(resolved.buildId, assets.buildId);

    const refs = listImageRefs();
    assert.equal(refs[0]?.reference, "alpine-base:latest");
    assert.equal(refs[0]?.targets.x86_64, assets.buildId);
  } finally {
    if (prevRegistryUrl === undefined) {
      delete process.env.GONDOLIN_IMAGE_REGISTRY_URL;
    } else {
      process.env.GONDOLIN_IMAGE_REGISTRY_URL = prevRegistryUrl;
    }

    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(assets.dir, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
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

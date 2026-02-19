import fs from "fs";
import os from "os";
import path from "path";

import {
  createTempQcow2Overlay,
  ensureQemuImgAvailable,
  getQcow2BackingFilename,
  rebaseQcow2InPlace,
} from "./qemu-img";

import {
  getAssetDirectory,
  loadAssetManifest,
  loadGuestAssets,
  type GuestAssets,
} from "./assets";
import type { VMOptions } from "./vm";

const CHECKPOINT_SCHEMA_VERSION = 1 as const;

// Trailer format (appended to the end of the qcow2 file):
//   [utf8 json bytes][8-byte magic][u64be json length]
//
// QEMU/qemu-img tolerate trailing bytes after the qcow2 image. We use that to
// store the checkpoint metadata in the same file.
//
// Note: The magic is a file-format marker for "qcow2 + JSON trailer".
// It is intentionally *not* tied to the JSON schema version.
const TRAILER_MAGIC = Buffer.from("GONDCPT1"); // 8 bytes
const TRAILER_SIZE = 16;

function cacheBaseDir(): string {
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

function defaultCheckpointDir(): string {
  return (
    process.env.GONDOLIN_CHECKPOINT_DIR ??
    path.join(cacheBaseDir(), "gondolin", "checkpoints")
  );
}

function sanitizeName(name: string): string {
  const trimmed = name.trim();
  const safe = trimmed
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe.length ? safe : "checkpoint";
}

export type VmCheckpointData = {
  /** checkpoint schema version */
  version: typeof CHECKPOINT_SCHEMA_VERSION;

  /** checkpoint name */
  name: string;

  /** creation timestamp (iso 8601) */
  createdAt: string;

  /** qcow2 disk filename (relative to checkpointDir in legacy directory format) */
  diskFile: string;

  /** deterministic guest asset build identifier (uuid) */
  guestAssetBuildId: string;
};

type VmCheckpointDataV2 = Omit<VmCheckpointData, "version"> & { version: 2 };

type VmCheckpointDataOnDisk = VmCheckpointData | VmCheckpointDataV2;

function writeCheckpointTrailer(
  diskPath: string,
  data: VmCheckpointData,
): void {
  const json = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8");
  const footer = Buffer.alloc(TRAILER_SIZE);
  TRAILER_MAGIC.copy(footer, 0);
  footer.writeBigUInt64BE(BigInt(json.length), 8);
  fs.appendFileSync(diskPath, Buffer.concat([json, footer]));
}

function readCheckpointTrailer(diskPath: string): VmCheckpointData {
  const fd = fs.openSync(diskPath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size < TRAILER_SIZE) {
      throw new Error(`checkpoint file has no trailer: ${diskPath}`);
    }

    const footer = Buffer.alloc(TRAILER_SIZE);
    fs.readSync(fd, footer, 0, TRAILER_SIZE, stat.size - TRAILER_SIZE);

    if (!footer.subarray(0, 8).equals(TRAILER_MAGIC)) {
      throw new Error(`checkpoint file has no trailer: ${diskPath}`);
    }

    const len = footer.readBigUInt64BE(8);
    if (len > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`checkpoint trailer too large: ${String(len)} bytes`);
    }

    const jsonLen = Number(len);
    const jsonStart = stat.size - TRAILER_SIZE - jsonLen;
    if (jsonStart < 0) {
      throw new Error(`invalid checkpoint trailer length: ${jsonLen}`);
    }

    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, jsonStart);

    const raw = jsonBuf.toString("utf8");
    const data = JSON.parse(raw) as VmCheckpointDataOnDisk;

    if (data.version !== CHECKPOINT_SCHEMA_VERSION) {
      throw new Error(
        `unsupported checkpoint version: ${String((data as any).version)}`,
      );
    }

    return data;
  } finally {
    fs.closeSync(fd);
  }
}

function validateGuestAssetsExist(assets: GuestAssets): boolean {
  return (
    fs.existsSync(assets.kernelPath) &&
    fs.existsSync(assets.initrdPath) &&
    fs.existsSync(assets.rootfsPath)
  );
}

function findCommonAssetDir(assets: GuestAssets): string | null {
  const kernelDir = path.dirname(assets.kernelPath);
  const initrdDir = path.dirname(assets.initrdPath);
  const rootfsDir = path.dirname(assets.rootfsPath);
  if (kernelDir !== initrdDir || kernelDir !== rootfsDir) return null;
  return kernelDir;
}

function scanForBuildId(cacheRoot: string, buildId: string): string | null {
  const root = path.resolve(cacheRoot);
  if (!fs.existsSync(root)) return null;

  const maxDirs = 5000;
  const maxDepth = 6;
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  let visited = 0;

  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    visited++;
    if (visited > maxDirs) return null;

    try {
      const manifest = loadAssetManifest(dir);
      if (manifest?.buildId === buildId) {
        // Ensure this looks like an actual asset directory
        loadGuestAssets(dir);
        return dir;
      }

      if (depth >= maxDepth) continue;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Avoid scanning checkpoints (can contain huge files).
        if (entry.name === "checkpoints") continue;
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    } catch {
      // ignore unreadable dirs
    }
  }

  return null;
}

function devGuestOutDirs(): string[] {
  // Try to mirror host/src/assets.ts dev resolution. Keep this local to avoid
  // exporting more internal APIs.
  const possibleRepoRoots = [
    path.resolve(__dirname, "..", ".."),
    path.resolve(__dirname, "..", "..", ".."),
  ];

  return possibleRepoRoots.map((repoRoot) =>
    path.join(repoRoot, "guest", "image", "out"),
  );
}

function resolveAssetDirByBuildId(buildId: string): {
  assetDir: string;
  searched: string[];
} {
  const searched: string[] = [];

  const tryDir = (label: string, dir: string): string | null => {
    const resolved = path.resolve(dir);
    searched.push(`${label}=${resolved}`);

    const manifest = loadAssetManifest(resolved);
    if (manifest?.buildId !== buildId) {
      return null;
    }

    // Ensure assets exist.
    loadGuestAssets(resolved);
    return resolved;
  };

  // 1) Explicit env override
  if (process.env.GONDOLIN_GUEST_DIR) {
    const found = tryDir("GONDOLIN_GUEST_DIR", process.env.GONDOLIN_GUEST_DIR);
    if (found) return { assetDir: found, searched };
  }

  // 2) Local dev checkout
  for (const dir of devGuestOutDirs()) {
    const found = tryDir("dev", dir);
    if (found) return { assetDir: found, searched };
  }

  // 3) Default asset directory (package version cache)
  const defaultDir = getAssetDirectory();
  const foundDefault = tryDir("default", defaultDir);
  if (foundDefault) return { assetDir: foundDefault, searched };

  // 4) Cache scan
  const cacheRoot = path.join(cacheBaseDir(), "gondolin");
  searched.push(`cache-scan=${cacheRoot}`);
  const found = scanForBuildId(cacheRoot, buildId);
  if (found) {
    return { assetDir: found, searched };
  }

  const msg =
    `Unable to locate guest assets for checkpoint buildId=${buildId}\n` +
    `Searched:\n` +
    searched.map((x) => `  - ${x}`).join("\n") +
    `\n\n` +
    `To resume this checkpoint, pass the guest assets directory explicitly:\n` +
    `  checkpoint.resume({ sandbox: { imagePath: \"/path/to/guest/assets\" } })`;
  throw new Error(msg);
}

function ensureCheckpointBackedByRootfs(
  checkpointDiskPath: string,
  rootfsPath: string,
): void {
  const backing = getQcow2BackingFilename(checkpointDiskPath);
  if (!backing) return;

  const backingAbs = path.isAbsolute(backing)
    ? path.resolve(backing)
    : path.resolve(path.dirname(checkpointDiskPath), backing);
  const desired = path.resolve(rootfsPath);

  if (backingAbs === desired) return;

  rebaseQcow2InPlace(checkpointDiskPath, desired, "raw");
}

function resolveGuestAssetsForResume(
  requiredBuildId: string,
  options: VMOptions,
): { imagePath: any; assets: GuestAssets } {
  const userImagePath = options.sandbox?.imagePath;

  if (userImagePath !== undefined) {
    if (typeof userImagePath === "string") {
      const assetDir = path.resolve(userImagePath);
      const manifest = loadAssetManifest(assetDir);
      if (!manifest?.buildId) {
        throw new Error(
          `guest assets at ${assetDir} are missing manifest buildId (cannot resume checkpoint)`,
        );
      }
      if (manifest.buildId !== requiredBuildId) {
        throw new Error(
          `guest assets do not match checkpoint buildId\n` +
            `  required: ${requiredBuildId}\n` +
            `  provided: ${manifest.buildId}\n` +
            `Fix: pass the correct assets directory to sandbox.imagePath`,
        );
      }

      return { imagePath: assetDir, assets: loadGuestAssets(assetDir) };
    }

    if (userImagePath && typeof userImagePath === "object") {
      const assets = userImagePath as GuestAssets;
      if (!assets.kernelPath || !assets.initrdPath || !assets.rootfsPath) {
        throw new Error(
          "sandbox.imagePath object must include kernelPath, initrdPath, and rootfsPath",
        );
      }
      if (!validateGuestAssetsExist(assets)) {
        throw new Error(
          `guest assets not found: ${assets.kernelPath}, ${assets.initrdPath}, ${assets.rootfsPath}`,
        );
      }

      const commonDir = findCommonAssetDir(assets);
      if (!commonDir) {
        throw new Error(
          "cannot validate sandbox.imagePath asset object: kernel/initrd/rootfs must be in the same directory to load manifest.json",
        );
      }

      const manifest = loadAssetManifest(commonDir);
      if (!manifest?.buildId) {
        throw new Error(
          `guest assets at ${commonDir} are missing manifest buildId (cannot resume checkpoint)`,
        );
      }
      if (manifest.buildId !== requiredBuildId) {
        throw new Error(
          `guest assets do not match checkpoint buildId\n` +
            `  required: ${requiredBuildId}\n` +
            `  provided: ${manifest.buildId}\n` +
            `Fix: pass the correct assets directory to sandbox.imagePath`,
        );
      }

      return { imagePath: userImagePath, assets };
    }

    throw new Error(
      "sandbox.imagePath must be a directory path or an asset path object",
    );
  }

  const { assetDir } = resolveAssetDirByBuildId(requiredBuildId);
  return { imagePath: assetDir, assets: loadGuestAssets(assetDir) };
}

/**
 * Disk-only checkpoint that can be resumed using qcow2 backing files.
 */
export class VmCheckpoint {
  private readonly checkpointPath: string;
  private readonly isDirectory: boolean;
  private readonly data: VmCheckpointData;
  private readonly baseVmOptions: VMOptions | null;

  constructor(
    checkpointPath: string,
    data: VmCheckpointData,
    baseVmOptions?: VMOptions | null,
    opts?: { isDirectory?: boolean },
  ) {
    this.checkpointPath = checkpointPath;
    this.isDirectory = opts?.isDirectory ?? false;
    this.data = data;
    this.baseVmOptions = baseVmOptions ?? null;
  }

  /** checkpoint name */
  get name(): string {
    return this.data.name;
  }

  /** absolute path to the checkpoint container */
  get path(): string {
    return this.checkpointPath;
  }

  /** absolute path to the directory containing the checkpoint file */
  get dir(): string {
    return this.isDirectory
      ? this.checkpointPath
      : path.dirname(this.checkpointPath);
  }

  /** absolute path to the qcow2 disk file */
  get diskPath(): string {
    return this.isDirectory
      ? path.join(this.checkpointPath, this.data.diskFile)
      : this.checkpointPath;
  }

  /** deterministic guest asset build identifier (uuid) */
  get guestAssetBuildId(): string {
    return this.data.guestAssetBuildId;
  }

  toJSON(): VmCheckpointData {
    return this.data;
  }

  /**
   * Resume the checkpoint into a new VM.
   *
   * The resumed VM is implemented as a fresh qcow2 overlay backed by this
   * checkpoint's qcow2 disk image.
   */
  async resume(options: VMOptions = {}): Promise<import("./vm").VM> {
    // Dynamic require to avoid import cycles.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { VM } = require("./vm") as typeof import("./vm");

    ensureQemuImgAvailable();

    const checkpointDisk = this.diskPath;
    if (!fs.existsSync(checkpointDisk)) {
      throw new Error(`checkpoint disk not found: ${checkpointDisk}`);
    }

    const resolved = resolveGuestAssetsForResume(
      this.data.guestAssetBuildId,
      options,
    );

    // Fix qcow2 backing filename portability by rebasing in-place on resume.
    ensureCheckpointBackedByRootfs(checkpointDisk, resolved.assets.rootfsPath);

    const overlayPath = createTempQcow2Overlay(checkpointDisk, "qcow2");

    const base = this.baseVmOptions ?? {};
    const merged: VMOptions = {
      ...base,
      ...options,
      sandbox: {
        ...(base.sandbox ?? {}),
        ...(options.sandbox ?? {}),
        imagePath: resolved.imagePath,
        rootDiskPath: overlayPath,
        rootDiskFormat: "qcow2",
        rootDiskSnapshot: false,
        rootDiskReadOnly: false,
        rootDiskDeleteOnClose: true,
      },
    };

    return await VM.create(merged);
  }

  /** @deprecated Use {@link resume} */
  async clone(options: VMOptions = {}): Promise<import("./vm").VM> {
    return await this.resume(options);
  }

  /** Load a checkpoint from a qcow2 file (new) or checkpoint directory/json (legacy). */
  static load(checkpointPath: string): VmCheckpoint {
    const resolved = path.resolve(checkpointPath);
    const stat = fs.statSync(resolved);

    if (stat.isDirectory()) {
      const dir = resolved;
      const jsonPath = path.join(dir, "checkpoint.json");
      const raw = fs.readFileSync(jsonPath, "utf8");
      const data = JSON.parse(raw) as VmCheckpointDataOnDisk;
      const normalized =
        (data as any).version === 2
          ? ({ ...data, version: 1 } as VmCheckpointData)
          : (data as VmCheckpointData);

      if (normalized.version !== CHECKPOINT_SCHEMA_VERSION) {
        throw new Error(
          `unsupported checkpoint version: ${String((data as any).version)}`,
        );
      }

      return new VmCheckpoint(dir, normalized, null, { isDirectory: true });
    }

    // Legacy: explicit checkpoint.json path.
    if (
      resolved.endsWith(path.sep + "checkpoint.json") ||
      path.basename(resolved) === "checkpoint.json"
    ) {
      const dir = path.dirname(resolved);
      const raw = fs.readFileSync(resolved, "utf8");
      const data = JSON.parse(raw) as VmCheckpointDataOnDisk;
      const normalized =
        (data as any).version === 2
          ? ({ ...data, version: 1 } as VmCheckpointData)
          : (data as VmCheckpointData);

      if (normalized.version !== CHECKPOINT_SCHEMA_VERSION) {
        throw new Error(
          `unsupported checkpoint version: ${String((data as any).version)}`,
        );
      }

      return new VmCheckpoint(dir, normalized, null, { isDirectory: true });
    }

    // New: qcow2 file with metadata trailer.
    const data = readCheckpointTrailer(resolved);
    return new VmCheckpoint(resolved, data, null, { isDirectory: false });
  }

  /** Delete the checkpoint (file or legacy directory). */
  delete(): void {
    if (this.isDirectory) {
      fs.rmSync(this.checkpointPath, { recursive: true, force: true });
    } else {
      fs.rmSync(this.checkpointPath, { force: true });
    }
  }

  /**
   * Create the canonical checkpoint directory path for a checkpoint name (legacy).
   */
  static getCheckpointDir(name: string): string {
    return path.join(defaultCheckpointDir(), sanitizeName(name));
  }

  /** Create a checkpoint metadata trailer and append it to a qcow2 file. */
  static writeTrailer(diskPath: string, data: VmCheckpointData): void {
    writeCheckpointTrailer(diskPath, data);
  }
}

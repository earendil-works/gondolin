import fs from "fs";
import os from "os";
import path from "path";

import { createTempQcow2Overlay, ensureQemuImgAvailable } from "./qemu-img";

import type { GuestAssets } from "./assets";
import type { VMOptions } from "./vm";

const CHECKPOINT_SCHEMA_VERSION = 1 as const;

function cacheBaseDir(): string {
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

function defaultCheckpointDir(): string {
  return process.env.GONDOLIN_CHECKPOINT_DIR ?? path.join(cacheBaseDir(), "gondolin", "checkpoints");
}

function sanitizeName(name: string): string {
  const trimmed = name.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length ? safe : "checkpoint";
}

export type VmCheckpointData = {
  /** checkpoint schema version */
  version: typeof CHECKPOINT_SCHEMA_VERSION;

  /** checkpoint name */
  name: string;

  /** creation timestamp (iso 8601) */
  createdAt: string;

  /** qcow2 disk filename (relative to checkpointDir) */
  diskFile: string;

  /** guest asset paths used when the checkpoint was created */
  guestAssets: GuestAssets;
};


/**
 * Disk-only checkpoint that can be cloned using qcow2 backing files.
 */
export class VmCheckpoint {
  private readonly checkpointDir: string;
  private readonly data: VmCheckpointData;
  private readonly baseVmOptions: VMOptions | null;

  constructor(checkpointDir: string, data: VmCheckpointData, baseVmOptions?: VMOptions | null) {
    this.checkpointDir = checkpointDir;
    this.data = data;
    this.baseVmOptions = baseVmOptions ?? null;
  }

  /** checkpoint name */
  get name(): string {
    return this.data.name;
  }

  /** absolute path to the checkpoint directory */
  get dir(): string {
    return this.checkpointDir;
  }

  /** absolute path to the qcow2 disk file */
  get diskPath(): string {
    return path.join(this.checkpointDir, this.data.diskFile);
  }

  /** guest assets used for this checkpoint */
  get guestAssets(): GuestAssets {
    return this.data.guestAssets;
  }

  toJSON(): VmCheckpointData {
    return this.data;
  }

  /**
   * Clone the checkpoint into a new VM.
   *
   * The clone is implemented as a fresh qcow2 overlay backed by this
   * checkpoint's qcow2 disk image.
   */
  async clone(options: VMOptions = {}): Promise<import("./vm").VM> {
    // Dynamic require to avoid import cycles.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { VM } = require("./vm") as typeof import("./vm");

    ensureQemuImgAvailable();

    const backing = this.diskPath;
    if (!fs.existsSync(backing)) {
      throw new Error(`checkpoint disk not found: ${backing}`);
    }

    const overlayPath = createTempQcow2Overlay(backing, "qcow2");

    const base = this.baseVmOptions ?? {};
    const merged: VMOptions = {
      ...base,
      ...options,
      sandbox: {
        ...(base.sandbox ?? {}),
        ...(options.sandbox ?? {}),
        imagePath: this.data.guestAssets,
        rootDiskPath: overlayPath,
        rootDiskFormat: "qcow2",
        rootDiskSnapshot: false,
        rootDiskDeleteOnClose: true,
      },
    };

    return await VM.create(merged);
  }

  /** Load a checkpoint from a checkpoint directory or json file path. */
  static load(checkpointPath: string): VmCheckpoint {
    const resolved = path.resolve(checkpointPath);
    const stat = fs.statSync(resolved);

    let dir: string;
    let jsonPath: string;

    if (stat.isDirectory()) {
      dir = resolved;
      jsonPath = path.join(dir, "checkpoint.json");
    } else {
      dir = path.dirname(resolved);
      jsonPath = resolved;
    }

    const raw = fs.readFileSync(jsonPath, "utf8");
    const data = JSON.parse(raw) as VmCheckpointData;

    if (data.version !== CHECKPOINT_SCHEMA_VERSION) {
      throw new Error(`unsupported checkpoint version: ${String((data as any).version)}`);
    }

    return new VmCheckpoint(dir, data, null);
  }

  /** Delete the checkpoint directory and all files under it. */
  delete(): void {
    fs.rmSync(this.checkpointDir, { recursive: true, force: true });
  }

  /**
   * Create the canonical checkpoint directory path for a checkpoint name.
   */
  static getCheckpointDir(name: string): string {
    return path.join(defaultCheckpointDir(), sanitizeName(name));
  }
}

export const __test = {
  defaultCheckpointDir,
  sanitizeName,
};

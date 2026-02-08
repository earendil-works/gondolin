import fs from "fs";
import os from "os";
import path from "path";

import { createTempQcow2Overlay, ensureQemuImgAvailable } from "./qemu-img";

import type { GuestAssets } from "./assets";
import type { VMOptions } from "./vm";

const CHECKPOINT_SCHEMA_VERSION = 1 as const;

// Trailer format (appended to the end of the qcow2 file):
//   [utf8 json bytes][8-byte magic][u64be json length]
//
// QEMU/qemu-img tolerate trailing bytes after the qcow2 image. We use that to
// store the checkpoint metadata in the same file.
const TRAILER_MAGIC = Buffer.from("GONDCPT1"); // 8 bytes
const TRAILER_SIZE = 16;

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

  /** qcow2 disk filename (relative to checkpointDir in legacy directory format) */
  diskFile: string;

  /** guest asset paths used when the checkpoint was created */
  guestAssets: GuestAssets;
};

function writeCheckpointTrailer(diskPath: string, data: VmCheckpointData): void {
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
    const data = JSON.parse(raw) as VmCheckpointData;

    if (data.version !== CHECKPOINT_SCHEMA_VERSION) {
      throw new Error(`unsupported checkpoint version: ${String((data as any).version)}`);
    }

    return data;
  } finally {
    fs.closeSync(fd);
  }
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
    opts?: { isDirectory?: boolean }
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

  /**
   * Absolute path to the checkpoint container.
   *
   * - New format: absolute path to the qcow2 file (with JSON trailer)
   * - Legacy format: absolute path to the checkpoint directory
   */
  get path(): string {
    return this.checkpointPath;
  }

  /** absolute path to the directory containing the checkpoint file */
  get dir(): string {
    return this.isDirectory ? this.checkpointPath : path.dirname(this.checkpointPath);
  }

  /** absolute path to the qcow2 disk file */
  get diskPath(): string {
    return this.isDirectory ? path.join(this.checkpointPath, this.data.diskFile) : this.checkpointPath;
  }

  /** guest assets used for this checkpoint */
  get guestAssets(): GuestAssets {
    return this.data.guestAssets;
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
      const data = JSON.parse(raw) as VmCheckpointData;

      if (data.version !== CHECKPOINT_SCHEMA_VERSION) {
        throw new Error(`unsupported checkpoint version: ${String((data as any).version)}`);
      }

      return new VmCheckpoint(dir, data, null, { isDirectory: true });
    }

    // Legacy: explicit checkpoint.json path.
    if (resolved.endsWith(path.sep + "checkpoint.json") || path.basename(resolved) === "checkpoint.json") {
      const dir = path.dirname(resolved);
      const raw = fs.readFileSync(resolved, "utf8");
      const data = JSON.parse(raw) as VmCheckpointData;

      if (data.version !== CHECKPOINT_SCHEMA_VERSION) {
        throw new Error(`unsupported checkpoint version: ${String((data as any).version)}`);
      }

      return new VmCheckpoint(dir, data, null, { isDirectory: true });
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

export const __test = {
  defaultCheckpointDir,
  sanitizeName,
};

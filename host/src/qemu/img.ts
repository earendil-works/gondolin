import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

type Qcow2CreateOptions = {
  /** overlay file path */
  path: string;
  /** backing file path */
  backingPath: string;
  /** backing format passed to qemu-img as `-F` */
  backingFormat: "raw" | "qcow2";
};

function tmpDir(): string {
  // macOS has tighter unix socket path limits in the default temp dir and we
  // already standardize on /tmp elsewhere.
  return process.platform === "darwin" ? "/tmp" : os.tmpdir();
}

/** Ensure `qemu-img` can be invoked. */
export function ensureQemuImgAvailable(): void {
  execFileSync("qemu-img", ["--version"], { stdio: "ignore" });
}

export function inferDiskFormatFromPath(diskPath: string): "raw" | "qcow2" {
  const lower = diskPath.toLowerCase();
  if (lower.endsWith(".qcow2") || lower.endsWith(".qcow")) return "qcow2";
  return "raw";
}

/** Parse a disk size string into `bytes`. */
export function parseDiskSizeToBytes(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `invalid disk size: ${String(value)} (expected a positive integer byte count)`,
      );
    }
    return value;
  }

  if (typeof value !== "string") {
    throw new Error(
      `invalid disk size: ${String(value)} (expected a string like "2G")`,
    );
  }

  const trimmed = value.trim();
  const match = /^(\d+)\s*([a-zA-Z]*)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `invalid disk size: ${JSON.stringify(value)} (expected a positive integer with optional K/M/G/T/P/E suffix)`,
    );
  }

  const amount = BigInt(match[1]!);
  if (amount <= 0n) {
    throw new Error(
      `invalid disk size: ${JSON.stringify(value)} (expected a positive integer)`,
    );
  }

  let suffix = match[2]!.toLowerCase();
  if (suffix.endsWith("ib")) {
    suffix = suffix.slice(0, -2);
  } else if (suffix.endsWith("b")) {
    suffix = suffix.slice(0, -1);
  }

  const exponents: Record<string, number> = {
    "": 0,
    byte: 0,
    bytes: 0,
    k: 1,
    m: 2,
    g: 3,
    t: 4,
    p: 5,
    e: 6,
  };
  const exponent = exponents[suffix];
  if (exponent === undefined) {
    throw new Error(
      `invalid disk size suffix: ${JSON.stringify(match[2])} (expected K/M/G/T/P/E)`,
    );
  }

  const bytes = amount * 1024n ** BigInt(exponent);
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`disk size is too large: ${JSON.stringify(value)}`);
  }
  return Number(bytes);
}

function createQcow2Overlay(opts: Qcow2CreateOptions): void {
  const dir = path.dirname(opts.path);
  fs.mkdirSync(dir, { recursive: true });

  // qemu-img will fail if the file exists.
  fs.rmSync(opts.path, { force: true });

  execFileSync(
    "qemu-img",
    [
      "create",
      "-f",
      "qcow2",
      "-F",
      opts.backingFormat,
      "-b",
      opts.backingPath,
      opts.path,
    ],
    { stdio: "ignore" },
  );
}

export function createTempQcow2Overlay(
  backingPath: string,
  backingFormat: "raw" | "qcow2",
): string {
  const overlayPath = path.join(
    tmpDir(),
    `gondolin-disk-${randomUUID().slice(0, 8)}.qcow2`,
  );
  try {
    createQcow2Overlay({ path: overlayPath, backingPath, backingFormat });
    return overlayPath;
  } catch (err) {
    fs.rmSync(overlayPath, { force: true });
    throw err;
  }
}

/**
 * Move a file to a new location, falling back to copy+unlink across devices.
 */
export function moveFile(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (err: any) {
    if (err && err.code === "EXDEV") {
      fs.copyFileSync(src, dst);
      fs.rmSync(src, { force: true });
      return;
    }
    throw err;
  }
}

type QemuImgInfo = Record<string, unknown>;

function qemuImgInfoJson(imagePath: string): QemuImgInfo {
  const raw = execFileSync("qemu-img", ["info", "--output=json", imagePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(raw) as QemuImgInfo;
}

function extractBackingFilename(info: any): string | null {
  if (info && typeof info["backing-filename"] === "string") {
    return info["backing-filename"];
  }

  const fmt = info?.["format-specific"]?.data;
  if (fmt && typeof fmt["backing-filename"] === "string") {
    return fmt["backing-filename"];
  }

  return null;
}

/**
 * Return the qcow2 backing filename recorded in the image (if any).
 *
 * Note: this is the string stored in the qcow2 metadata and may be relative.
 */
export function getQcow2BackingFilename(imagePath: string): string | null {
  const info = qemuImgInfoJson(imagePath);
  return extractBackingFilename(info);
}

/** Return the image virtual size in `bytes`. */
export function getImageVirtualSizeBytes(imagePath: string): number {
  const info = qemuImgInfoJson(imagePath);
  const value = info["virtual-size"];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `qemu-img info did not report a valid virtual size for ${imagePath}`,
    );
  }
  return value as number;
}

/** Grow an image's virtual size to at least `bytes`. */
export function ensureDiskImageMinimumSize(
  imagePath: string,
  sizeBytes: number,
): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`invalid disk resize target: ${String(sizeBytes)}`);
  }
  if (getImageVirtualSizeBytes(imagePath) >= sizeBytes) return;
  execFileSync("qemu-img", ["resize", imagePath, String(sizeBytes)], {
    stdio: "ignore",
  });
}

/** Resolve qcow2 backing metadata into an absolute path when present. */
export function resolveQcow2BackingPath(imagePath: string): string | null {
  const backing = getQcow2BackingFilename(imagePath);
  if (!backing) return null;
  return path.isAbsolute(backing)
    ? path.resolve(backing)
    : path.resolve(path.dirname(imagePath), backing);
}

/**
 * Rebase a qcow2 image to a new backing file path in-place.
 */
export function rebaseQcow2InPlace(
  imagePath: string,
  backingPath: string,
  backingFormat: "raw" | "qcow2",
  mode: "safe" | "unsafe" = "unsafe",
): void {
  const args = ["rebase"];
  if (mode === "unsafe") {
    args.push("-u");
  }
  args.push("-F", backingFormat, "-b", backingPath, imagePath);
  execFileSync("qemu-img", args, { stdio: "ignore" });
}

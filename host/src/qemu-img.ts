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
    { stdio: "ignore" }
  );
}

export function createTempQcow2Overlay(backingPath: string, backingFormat: "raw" | "qcow2"): string {
  const overlayPath = path.join(tmpDir(), `gondolin-disk-${randomUUID().slice(0, 8)}.qcow2`);
  createQcow2Overlay({ path: overlayPath, backingPath, backingFormat });
  return overlayPath;
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

/**
 * Rebase a qcow2 image to a new backing file path (in-place, unsafe mode).
 */
export function rebaseQcow2InPlace(
  imagePath: string,
  backingPath: string,
  backingFormat: "raw" | "qcow2"
): void {
  execFileSync(
    "qemu-img",
    ["rebase", "-u", "-F", backingFormat, "-b", backingPath, imagePath],
    { stdio: "ignore" }
  );
}

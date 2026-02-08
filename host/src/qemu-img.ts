import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

export type Qcow2CreateOptions = {
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

export function createQcow2Overlay(opts: Qcow2CreateOptions): void {
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

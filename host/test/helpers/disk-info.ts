/**
 * Disk image metadata for tests through the daemon's `--disk-info` (the
 * built-in qcow2 reader; no qemu-img needed).
 */

import { execFileSync } from "node:child_process";

import { nativeDaemonArgs } from "../../src/native/binary.ts";
import { resolveNativeBinary } from "../../src/native/transport.ts";

export type DiskInfo = {
  /** `raw` or `qcow2` (probed) */
  format: "raw" | "qcow2";
  /** virtual size in `bytes` */
  virtual_size: number;
  /** backing file name as stored */
  backing_file?: string;
  /** backing file resolved against the image's directory */
  full_backing_file?: string;
  /** backing format */
  backing_format?: string;
};

export function diskInfo(imagePath: string): DiskInfo {
  const binary = resolveNativeBinary();
  const out = execFileSync(
    binary,
    [...nativeDaemonArgs(binary), "--disk-info", imagePath],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as DiskInfo;
}

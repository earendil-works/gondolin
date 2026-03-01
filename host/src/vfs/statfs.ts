import { getSystemErrorName } from "node:util";

import { createErrnoError } from "./errors.ts";
import type { VfsStatfs } from "./node/index.ts";
import { ERRNO } from "./utils.ts";

type MaybeStatfsProvider = {
  statfs?: (path: string) => Promise<VfsStatfs>;
};

const SYNTHETIC_STATFS: Readonly<VfsStatfs> = Object.freeze({
  bsize: 4096,
  frsize: 4096,
  blocks: 16_777_216, // 64 GiB at 4 KiB blocks
  bfree: 16_777_216,
  bavail: 16_777_216,
  files: 16_777_216,
  ffree: 16_777_216,
  namelen: 255,
});

export function cloneSyntheticStatfs(): VfsStatfs {
  return { ...SYNTHETIC_STATFS };
}

export async function delegateStatfsOrEnosys(
  provider: MaybeStatfsProvider,
  path: string,
): Promise<VfsStatfs> {
  if (typeof provider.statfs === "function") {
    return provider.statfs(path);
  }
  throw createErrnoError(ERRNO.ENOSYS, "statfs", path);
}

export function normalizeStatfs(raw: VfsStatfs): VfsStatfs {
  const U32_MAX = 0xffff_ffff;
  const safeUint = (value: unknown, fallback: number) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      return fallback;
    return Math.min(Math.round(value), Number.MAX_SAFE_INTEGER);
  };
  const safeU32 = (value: unknown, fallback: number, min = 0) =>
    Math.max(min, Math.min(safeUint(value, fallback), U32_MAX));

  const bsize = safeU32(raw.bsize, SYNTHETIC_STATFS.bsize, 1);
  const frsize = safeU32(raw.frsize, SYNTHETIC_STATFS.frsize, 1);
  const namelen = safeU32(raw.namelen, SYNTHETIC_STATFS.namelen);
  const blocks = safeUint(raw.blocks, SYNTHETIC_STATFS.blocks);
  const files = safeUint(raw.files, SYNTHETIC_STATFS.files);
  const bfree = Math.min(safeUint(raw.bfree, SYNTHETIC_STATFS.bfree), blocks);
  const bavail = Math.min(safeUint(raw.bavail, SYNTHETIC_STATFS.bavail), bfree);
  const ffree = Math.min(safeUint(raw.ffree, SYNTHETIC_STATFS.ffree), files);
  return { bsize, frsize, namelen, blocks, bfree, bavail, files, ffree };
}

export function isErrnoValue(error: unknown, errno: number): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as NodeJS.ErrnoException;
  if (
    typeof maybeError.errno === "number" &&
    Math.abs(maybeError.errno) === errno
  ) {
    return true;
  }

  if (typeof maybeError.code !== "string") {
    return false;
  }
  if (maybeError.code === `ERRNO_${errno}`) {
    return true;
  }

  try {
    return maybeError.code === getSystemErrorName(errno);
  } catch {
    return false;
  }
}

export function isStatfsProbeFallbackError(error: unknown): boolean {
  return isErrnoValue(error, ERRNO.ENOSYS) || isErrnoValue(error, ERRNO.ENOENT);
}

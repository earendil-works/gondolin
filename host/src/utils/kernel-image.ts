import fs from "node:fs";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b, 0x08]);
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const BZIP2_MAGIC = Buffer.from("BZh", "latin1");

const BZIMAGE_MAGIC = Buffer.from("MZ", "latin1");

/**
 * Whether an x86_64 kernel file has a format libkrun can load.
 *
 * Images published before the x86_64 bzImage fix ship the libkrunfw flat
 * bundle as `krunKernel`; libkrun's raw x86_64 path cannot load it, so callers
 * use this to fall back to the image's base kernel instead.  Keep the magic
 * list in sync with `host/krun-runner/main.zig`.
 */
export function isLoadableX86Kernel(kernelPath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(kernelPath, "r");
  } catch {
    return false;
  }

  try {
    const header = Buffer.alloc(4);
    const n = fs.readSync(fd, header, 0, header.length, 0);

    if (
      n >= ELF_MAGIC.length &&
      header.subarray(0, ELF_MAGIC.length).equals(ELF_MAGIC)
    ) {
      return true;
    }
    if (
      n >= BZIMAGE_MAGIC.length &&
      header.subarray(0, BZIMAGE_MAGIC.length).equals(BZIMAGE_MAGIC)
    ) {
      return true;
    }
    if (
      n >= GZIP_MAGIC.length &&
      header.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC)
    ) {
      return true;
    }
    if (
      n >= BZIP2_MAGIC.length &&
      header.subarray(0, BZIP2_MAGIC.length).equals(BZIP2_MAGIC)
    ) {
      return true;
    }
    if (
      n >= ZSTD_MAGIC.length &&
      header.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)
    ) {
      return true;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

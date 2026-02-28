import fs from "fs";
import path from "path";
import { createGunzip } from "zlib";
import { Writable } from "stream";
import { pipeline } from "stream/promises";

import type { TarEntry } from "./types.ts";
import { hasSymlinkComponent } from "./rootfs.ts";

/** Parse a raw tar archive buffer into entries */
export function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);

    // Check for end-of-archive (two zero blocks)
    if (header.every((b) => b === 0)) {
      break;
    }

    const name = readTarString(header, 0, 100);
    const mode = parseInt(readTarString(header, 100, 8), 8) || 0;
    const size = parseInt(readTarString(header, 124, 12), 8) || 0;
    const typeFlag = header[156];
    const linkName = readTarString(header, 157, 100);

    // Handle UStar prefix
    const magic = readTarString(header, 257, 6);
    let fullName = name;
    if (magic === "ustar" || magic === "ustar\0") {
      const prefix = readTarString(header, 345, 155);
      if (prefix) {
        fullName = `${prefix}/${name}`;
      }
    }

    // PAX extended headers (type 'x' or 'g') — read content and skip
    if (typeFlag === 0x78 || typeFlag === 0x67) {
      const blocks = Math.ceil(size / 512);
      offset += 512 + blocks * 512;
      continue;
    }

    const type =
      typeFlag === 0 || typeFlag === 0x30
        ? 0 // regular file
        : typeFlag === 0x35
          ? 5 // directory
          : typeFlag === 0x32
            ? 2 // symlink
            : typeFlag === 0x31
              ? 1 // hardlink
              : typeFlag;

    offset += 512;

    let content: Buffer | null = null;
    if (size > 0) {
      content = Buffer.from(buf.subarray(offset, offset + size));
      offset += Math.ceil(size / 512) * 512;
    }

    entries.push({ name: fullName, type, mode, size, linkName, content });
  }

  return entries;
}

function readTarString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nullIdx = slice.indexOf(0);
  const end = nullIdx === -1 ? length : nullIdx;
  return slice.subarray(0, end).toString("utf8");
}

/** Decompress a .tar.gz file and return the raw tar buffer */
export async function decompressTarGz(filePath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const input = fs.createReadStream(filePath);
  const gunzip = createGunzip();
  const collector = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, cb: () => void) {
      chunks.push(chunk);
      cb();
    },
  });
  await pipeline(input, gunzip, collector);
  return Buffer.concat(chunks);
}

/** Extract a .tar.gz file into a directory (safe against symlink traversal) */
export async function extractTarGz(
  tarGzPath: string,
  destDir: string,
): Promise<void> {
  const raw = await decompressTarGz(tarGzPath);
  const entries = parseTar(raw);
  extractEntries(entries, destDir);
}

/** Extract tar entries into a directory with symlink-safety checks */
export function extractEntries(entries: TarEntry[], destDir: string): void {
  const absRoot = path.resolve(destDir);

  for (const entry of entries) {
    // Skip APK metadata files
    if (entry.name.startsWith(".") && !entry.name.startsWith("./")) {
      continue;
    }

    const target = path.resolve(destDir, entry.name);

    // Guard: target must be inside destDir
    if (!target.startsWith(absRoot + path.sep) && target !== absRoot) {
      continue;
    }

    // Guard: no symlink in any intermediate path component
    if (hasSymlinkComponent(target, absRoot)) {
      process.stderr.write(`skipping symlinked path ${entry.name}\n`);
      continue;
    }

    // Prepare for extraction — remove existing entry if needed
    prepareTarget(target, entry.type === 5);

    if (entry.type === 5) {
      // Directory
      fs.mkdirSync(target, { recursive: true });
    } else if (entry.type === 2) {
      // Symlink
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.symlinkSync(entry.linkName, target);
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
      }
    } else if (entry.type === 1) {
      // Hardlink
      const linkTarget = path.resolve(destDir, entry.linkName);
      if (
        linkTarget.startsWith(absRoot + path.sep) &&
        fs.existsSync(linkTarget)
      ) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try {
          fs.linkSync(linkTarget, target);
        } catch {
          // Fall back to copy
          if (fs.existsSync(linkTarget)) {
            fs.copyFileSync(linkTarget, target);
          }
        }
      }
    } else if (entry.type === 0 && entry.content) {
      // Regular file
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.content);
      try {
        fs.chmodSync(target, entry.mode & 0o7777);
      } catch {
        // chmod may fail on some platforms; ignore
      }
    }
  }
}

/** Prepare a target path for extraction: remove existing entries that conflict */
function prepareTarget(target: string, isDir: boolean): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return; // Doesn't exist, nothing to do
  }

  if (isDir && stat.isDirectory()) return; // Already a directory, fine

  try {
    if (stat.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      fs.unlinkSync(target);
    }
  } catch {
    // Try harder: fix permissions then remove
    try {
      fs.chmodSync(target, 0o700);
    } catch {
      // ignore
    }
    try {
      if (stat.isDirectory()) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.unlinkSync(target);
      }
    } catch {
      // Last resort: ignore
    }
  }
}

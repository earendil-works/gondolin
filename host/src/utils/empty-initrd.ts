import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A valid but empty initrd: a newc cpio archive holding only the `TRAILER!!!`
 * entry, padded to `512` bytes.
 *
 * libkrun places the initrd at the end of guest RAM; a 0-byte initrd ends up
 * one byte past the end of RAM and fails with `InvalidGuestAddress`.
 */
export function createEmptyInitrd(): Buffer {
  const name = "TRAILER!!!\0";
  const fields = [
    0, // ino
    0, // mode
    0, // uid
    0, // gid
    1, // nlink
    0, // mtime
    0, // filesize
    0, // devmajor
    0, // devminor
    0, // rdevmajor
    0, // rdevminor
    name.length, // namesize
    0, // check
  ];
  const header = `070701${fields.map((v) => v.toString(16).padStart(8, "0")).join("")}`;
  const out = Buffer.alloc(512);
  out.write(header + name, 0, "latin1");
  return out;
}

/** Shared on-disk location of the generated empty initrd */
export function getDefaultKrunInitrdPath(): string {
  return path.join(os.tmpdir(), "gondolin-krun-empty-initrd.cpio");
}

/** Write the empty initrd to `initrdPath` unless it already has the expected contents */
export function ensureEmptyInitrdFile(initrdPath: string): boolean {
  const expected = createEmptyInitrd();
  try {
    if (fs.readFileSync(initrdPath).equals(expected)) return true;
  } catch {
    // missing or unreadable: (re)create below
  }
  try {
    fs.mkdirSync(path.dirname(initrdPath), { recursive: true });
    const tmpPath = `${initrdPath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, expected);
    fs.renameSync(tmpPath, initrdPath);
    return true;
  } catch {
    return false;
  }
}

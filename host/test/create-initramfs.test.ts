import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createInitramfs } from "../src/alpine/utils.ts";

/** Legacy LZ4 frame magic written by `lz4 -l` */
const LZ4_LEGACY_MAGIC = [0x02, 0x21, 0x4c, 0x18];

function hasCommand(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const missingTools = ["cpio", "lz4", "sh", "find"].filter(
  (command) => !hasCommand(command),
);
const skipWithoutTools =
  missingTools.length > 0
    ? `requires ${missingTools.join(", ")} on PATH`
    : false;

function makeSourceTree(dir: string): string {
  const sourceDir = path.join(dir, "root");
  fs.mkdirSync(path.join(sourceDir, "etc"), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "etc", "motd"), "hello\n");
  return sourceDir;
}

test("createInitramfs writes a compressed cpio archive", {
  skip: skipWithoutTools,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-initramfs-"));

  try {
    const sourceDir = makeSourceTree(dir);
    const archivePath = path.join(dir, "initramfs.cpio.lz4");

    createInitramfs(sourceDir, archivePath);

    const archive = fs.readFileSync(archivePath);
    assert.ok(
      archive.length > LZ4_LEGACY_MAGIC.length,
      `archive is empty (${archive.length} bytes)`,
    );
    assert.deepEqual([...archive.subarray(0, 4)], LZ4_LEGACY_MAGIC);

    const listing = execFileSync(
      "sh",
      ["-c", 'lz4 -d -c "$1" | cpio -it 2>/dev/null', "sh", archivePath],
      { encoding: "utf8" },
    );
    assert.match(listing, /etc\/motd/);
    assert.equal(
      fs.existsSync(`${archivePath}.cpio`),
      false,
      "temporary cpio archive was not removed",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createInitramfs reports a missing cpio binary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-initramfs-"));

  try {
    const sourceDir = makeSourceTree(dir);
    // A PATH with only `sh`: the cpio/lz4 commands are unreachable, so the
    // pipeline must fail instead of producing an empty archive.
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    const shPath = ["/bin/sh", "/usr/bin/sh"].find((candidate) =>
      fs.existsSync(candidate),
    );
    assert.ok(shPath, "no sh binary found");
    fs.symlinkSync(shPath, path.join(binDir, "sh"));

    const previousPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      assert.throws(
        () => createInitramfs(sourceDir, path.join(dir, "initramfs.cpio.lz4")),
        /cpio is required/,
      );
    } finally {
      process.env.PATH = previousPath;
    }

    assert.equal(
      fs.existsSync(path.join(dir, "initramfs.cpio.lz4")),
      false,
      "a broken initramfs was written",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

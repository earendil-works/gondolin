import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { findE2fsprogsTool, findMke2fs, getDirSizeKb } from "./alpine/utils.ts";
import { parseDiskSizeToBytes } from "./qemu/img.ts";

const execFileAsync = promisify(execFile);

const BLOCK_SIZE = 4096;
const INODE_SIZE = 256;
const SPARE_INODES = 64;
/** Room for the superblock, group descriptors, bitmaps and extent trees in `bytes` */
const METADATA_SLACK_BYTES = 4 * 1024 * 1024;
const MAX_AUTO_SIZE_ATTEMPTS = 6;
const JOURNAL_SIZE_MIB = 16;

const MISSING_E2FSPROGS_HINT =
  "creating a disk image requires e2fsprogs (mke2fs, debugfs, e2fsck); see the build requirements in docs/custom-images.md";

/** Options for {@link createDiskImage} */
export type CreateDiskImageOptions = {
  /** host directory whose contents become the filesystem root */
  sourceDir: string;
  /** host path of the image to write, replaced atomically if it exists */
  outputPath: string;
  /** image size in `bytes` or with a K/M/G/T suffix, or `"auto"` to fit the contents (default: `"auto"`) */
  size?: string | number;
  /** give the filesystem a journal so the disk can be attached with `readOnly: false` (default: `false`) */
  allowWrite?: boolean;
};

/** Disk image written by {@link createDiskImage} */
export type DiskImage = {
  /** absolute host path of the image */
  path: string;
  /** image size in `bytes` */
  sizeBytes: number;
};

/**
 * Build a raw ext4 disk image from a host directory
 *
 * Every file in the image is owned by root regardless of who owns it on the
 * host, so the guest sees it the way a package manager would install it.  The
 * filesystem has no journal unless `allowWrite` is set: a read-only mount
 * never uses one, while a writable disk needs it to survive a VM stopped
 * mid-write.  An `"auto"` size fits the contents with a little headroom (and
 * the journal), so a writable disk that needs room to grow wants a `size`.
 */
export async function createDiskImage(
  options: CreateDiskImageOptions,
): Promise<DiskImage> {
  const sourceDir = path.resolve(options.sourceDir);
  const outputPath = path.resolve(options.outputPath);
  if (!fs.statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`disk image source is not a directory: ${sourceDir}`);
  }
  const requestedSize = options.size ?? "auto";
  const allowWrite = options.allowWrite ?? false;
  const fixedSize =
    requestedSize === "auto"
      ? null
      : Math.ceil(parseDiskSizeToBytes(requestedSize) / BLOCK_SIZE) *
        BLOCK_SIZE;

  const tools = findTools();
  const inodes = countEntries(sourceDir) + SPARE_INODES;
  let sizeBytes =
    fixedSize ??
    Math.ceil(
      (getDirSizeKb(sourceDir) * 1024 * 1.01 +
        inodes * INODE_SIZE +
        METADATA_SLACK_BYTES +
        (allowWrite ? JOURNAL_SIZE_MIB * 1024 * 1024 : 0)) /
        BLOCK_SIZE,
    ) * BLOCK_SIZE;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    for (let attempt = 1; ; attempt++) {
      fs.rmSync(tempPath, { force: true });
      try {
        await execFileAsync(tools.mke2fs, [
          "-q",
          "-t",
          "ext4",
          ...(allowWrite
            ? ["-J", `size=${JOURNAL_SIZE_MIB}`]
            : ["-O", "^has_journal"]),
          "-m",
          "0",
          "-b",
          String(BLOCK_SIZE),
          "-I",
          String(INODE_SIZE),
          "-N",
          String(inodes),
          "-E",
          "root_owner=0:0",
          "-d",
          sourceDir,
          "-F",
          tempPath,
          `${sizeBytes / 1024}k`,
        ]);
        break;
      } catch (err) {
        // the estimate can fall short for trees of many small files or
        // large directories; grow and retry rather than overshooting up front
        if (fixedSize !== null || attempt >= MAX_AUTO_SIZE_ATTEMPTS) {
          throw new Error(
            `mke2fs failed to build a ${sizeBytes} byte image from ${sourceDir}: ${commandError(err)}`,
          );
        }
        sizeBytes = Math.ceil((sizeBytes * 1.1) / BLOCK_SIZE) * BLOCK_SIZE;
      }
    }

    await chownTreeToRoot(tools.debugfs, tempPath, sourceDir);

    try {
      await execFileAsync(tools.e2fsck, ["-fn", tempPath]);
    } catch (err) {
      throw new Error(
        `e2fsck found problems in the image built from ${sourceDir}: ${commandError(err)}`,
      );
    }

    fs.renameSync(tempPath, outputPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }

  return { path: outputPath, sizeBytes };
}

function findTools() {
  let mke2fs: string;
  try {
    mke2fs = findMke2fs();
  } catch {
    throw new Error(`mke2fs not found: ${MISSING_E2FSPROGS_HINT}`);
  }
  const debugfs = findE2fsprogsTool(mke2fs, "debugfs");
  const e2fsck = findE2fsprogsTool(mke2fs, "e2fsck");
  if (!debugfs || !e2fsck) {
    throw new Error(
      `${debugfs ? "e2fsck" : "debugfs"} not found: ${MISSING_E2FSPROGS_HINT}`,
    );
  }
  return { mke2fs, debugfs, e2fsck };
}

/** Entries below `dir`, each of which takes an inode */
function countEntries(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    count++;
    if (entry.isDirectory()) count += countEntries(path.join(dir, entry.name));
  }
  return count;
}

/** mke2fs `-d` copies host ownership, so every inode is reassigned to root */
async function chownTreeToRoot(
  debugfs: string,
  imagePath: string,
  sourceDir: string,
) {
  const commands: string[] = [];
  const walk = (dir: string, guestDir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const guestPath = `${guestDir}/${entry.name}`;
      if (/[\x00-\x1f\x7f]/.test(guestPath)) {
        throw new Error(
          `disk image source path contains control characters: ${JSON.stringify(path.join(dir, entry.name))}`,
        );
      }
      // debugfs reads a doubled quote inside a quoted argument as a literal one
      const quoted = `"${guestPath.replaceAll('"', '""')}"`;
      commands.push(`sif ${quoted} uid 0`, `sif ${quoted} gid 0`);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), guestPath);
    }
  };
  walk(sourceDir, "");
  if (commands.length === 0) return;

  const commandFile = `${imagePath}.debugfs`;
  fs.writeFileSync(commandFile, `${commands.join("\n")}\n`);
  try {
    const { stderr } = await execFileAsync(
      debugfs,
      ["-w", "-f", commandFile, imagePath],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    // debugfs exits 0 when a command fails; anything past its version banner
    // on stderr is a failed command
    const failures = stderr
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("debugfs "));
    if (failures.length > 0) {
      throw Object.assign(new Error("debugfs reported errors"), {
        stderr: failures.slice(0, 5).join("\n"),
      });
    }
  } catch (err) {
    throw new Error(
      `debugfs failed to set root ownership in the image built from ${sourceDir}: ${commandError(err)}`,
    );
  } finally {
    fs.rmSync(commandFile, { force: true });
  }
}

function commandError(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" ? stderr.trim() : "";
  return text || (err instanceof Error ? err.message : String(err));
}

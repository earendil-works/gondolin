import fs from "node:fs";
import path from "node:path";

import {
  RESERVED_GUEST_MOUNT_PATHS,
  UNSUPPORTED_GUEST_MOUNT_PATH_CHARS,
} from "./tmpfs.ts";

/** Kernel cmdline parameter carrying the extra disk mount list to `/init` */
export const EXTRA_DISKS_CMDLINE_PARAM = "gondolin.disks";

/** File `/init` appends a line to for every extra disk it fails to mount */
export const EXTRA_DISKS_FAILED_PATH = "/run/gondolin/disks.failed";

const EXT_SUPERBLOCK_OFFSET = 1024;
const EXT_MAGIC = 0xef53;
const EXT_FEATURE_COMPAT_HAS_JOURNAL = 0x4;

/**
 * Whether a raw image holds an ext2/3/4 filesystem without a journal
 *
 * Such a filesystem is only consistent after a clean unmount, so writing it
 * from a VM that can be stopped at any point risks corrupting it.
 */
export function isJournallessExtImage(imagePath: string): boolean {
  const superblock = Buffer.alloc(0x60);
  const fd = fs.openSync(imagePath, "r");
  let bytesRead: number;
  try {
    bytesRead = fs.readSync(
      fd,
      superblock,
      0,
      superblock.length,
      EXT_SUPERBLOCK_OFFSET,
    );
  } finally {
    fs.closeSync(fd);
  }
  if (bytesRead < superblock.length) return false;
  if (superblock.readUInt16LE(0x38) !== EXT_MAGIC) return false;
  return (superblock.readUInt32LE(0x5c) & EXT_FEATURE_COMPAT_HAS_JOURNAL) === 0;
}

/** Extra disk that `/init` mounts during boot */
export type ExtraDiskMount = {
  /** virtio-blk serial `/init` finds the device by */
  serial: string;
  /** absolute guest mount point */
  mountPath: string;
  /** mount read-only */
  readOnly: boolean;
};

/**
 * Validate and normalize an extra disk guest mount path
 *
 * The path ends up on the kernel cmdline like a tmpfs path, so the same
 * characters are rejected.
 */
export function normalizeExtraDiskMountPath(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error(
      `${field} must be an absolute guest path: ${String(value)}`,
    );
  }
  let normalized = path.posix.normalize(value);
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized === "/") {
    throw new Error(`${field} cannot be /`);
  }
  if (UNSUPPORTED_GUEST_MOUNT_PATH_CHARS.test(normalized)) {
    throw new Error(
      `${field} contains unsupported characters (whitespace, ',', ':', quotes, glob characters or '\\'): ${normalized}`,
    );
  }
  for (const reserved of RESERVED_GUEST_MOUNT_PATHS) {
    if (isGuestPathWithin(reserved, normalized)) {
      throw new Error(`${field} is a reserved guest path: ${normalized}`);
    }
  }
  return normalized;
}

/**
 * Check that no extra disk mount hides, or is hidden by, another guest mount
 *
 * `/init` mounts tmpfs first, then extra disks, then the VFS mounts.  A disk
 * may therefore sit below a tmpfs mount, but not on or above one, and may not
 * overlap a VFS mount at all.
 */
export function assertExtraDiskMountsDoNotOverlap(
  disks: readonly ExtraDiskMount[],
  other: { tmpfs?: readonly string[]; vfs?: readonly string[] },
) {
  const seen = new Set<string>();
  for (const disk of disks) {
    if (seen.has(disk.mountPath)) {
      throw new Error(
        `extra disk mountPath specified more than once: ${disk.mountPath}`,
      );
    }
    seen.add(disk.mountPath);

    for (const tmpfsPath of other.tmpfs ?? []) {
      if (isGuestPathWithin(disk.mountPath, tmpfsPath)) {
        throw new Error(
          `extra disk mountPath ${disk.mountPath} would hide the tmpfs mount at ${tmpfsPath}`,
        );
      }
    }
    for (const vfsPath of other.vfs ?? []) {
      if (
        isGuestPathWithin(disk.mountPath, vfsPath) ||
        isGuestPathWithin(vfsPath, disk.mountPath)
      ) {
        throw new Error(
          `extra disk mountPath ${disk.mountPath} overlaps the VFS mount at ${vfsPath}`,
        );
      }
    }
  }
}

/**
 * Build the `gondolin.disks=` kernel cmdline argument
 *
 * Format: `gondolin.disks=<serial>:<path>:<ro|rw>[,...]`, sorted by path so a
 * disk is mounted before any disk below it.
 */
export function buildExtraDisksAppend(disks: readonly ExtraDiskMount[]) {
  const entries = [...disks]
    .sort((a, b) =>
      a.mountPath < b.mountPath ? -1 : a.mountPath > b.mountPath ? 1 : 0,
    )
    .map(
      (disk) =>
        `${disk.serial}:${disk.mountPath}:${disk.readOnly ? "ro" : "rw"}`,
    );
  return `${EXTRA_DISKS_CMDLINE_PARAM}=${entries.join(",")}`;
}

function isGuestPathWithin(root: string, candidate: string) {
  return root === "/" || candidate === root || candidate.startsWith(`${root}/`);
}

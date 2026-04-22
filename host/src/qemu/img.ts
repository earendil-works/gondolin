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

type ResolveQemuImgPathDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  qemuPath?: string;
  existsSync?: typeof fs.existsSync;
  probeQemuImg?: (candidatePath: string) => boolean;
};

function tmpDir(): string {
  // macOS has tighter unix socket path limits in the default temp dir and we
  // already standardize on /tmp elsewhere.
  return process.platform === "darwin" ? "/tmp" : os.tmpdir();
}

function probeQemuImgBinary(candidatePath: string): boolean {
  try {
    execFileSync(candidatePath, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function qemuImgSiblingCandidate(
  qemuPath: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!qemuPath || !/[\\/]/.test(qemuPath)) {
    return null;
  }

  const pathModule = platform === "win32" ? path.win32 : path.posix;
  return pathModule.join(
    pathModule.dirname(qemuPath),
    platform === "win32" ? "qemu-img.exe" : "qemu-img",
  );
}

function buildDefaultQemuImgCandidates(
  deps: ResolveQemuImgPathDeps = {},
): string[] {
  const platform = deps.platform ?? process.platform;
  const candidates: string[] = [];

  const siblingCandidate = qemuImgSiblingCandidate(deps.qemuPath, platform);
  if (siblingCandidate) {
    candidates.push(siblingCandidate);
  }

  if (platform !== "win32") {
    candidates.push("qemu-img");
    return Array.from(new Set(candidates));
  }

  const env = deps.env ?? process.env;
  candidates.push("qemu-img", "qemu-img.exe");
  const installRoots = [env.ProgramW6432, env.ProgramFiles].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  for (const root of installRoots) {
    candidates.push(path.win32.join(root, "qemu", "qemu-img.exe"));
  }

  return Array.from(new Set(candidates));
}

function resolveQemuImgPath(deps: ResolveQemuImgPathDeps = {}): string {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const probeQemuImg = deps.probeQemuImg ?? probeQemuImgBinary;
  const candidates = buildDefaultQemuImgCandidates(deps);

  for (const candidate of candidates) {
    const isExplicitPath = /[\\/]/.test(candidate);
    if (isExplicitPath && !existsSync(candidate)) {
      continue;
    }
    if (probeQemuImg(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
}

/** Ensure `qemu-img` can be invoked. */
export function ensureQemuImgAvailable(qemuPath?: string): void {
  execFileSync(resolveQemuImgPath({ qemuPath }), ["--version"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

export function inferDiskFormatFromPath(diskPath: string): "raw" | "qcow2" {
  const lower = diskPath.toLowerCase();
  if (lower.endsWith(".qcow2") || lower.endsWith(".qcow")) return "qcow2";
  return "raw";
}

function createQcow2Overlay(
  opts: Qcow2CreateOptions,
  qemuPath?: string,
): void {
  const dir = path.dirname(opts.path);
  fs.mkdirSync(dir, { recursive: true });

  // qemu-img will fail if the file exists.
  fs.rmSync(opts.path, { force: true });

  execFileSync(
    resolveQemuImgPath({ qemuPath }),
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
    { stdio: "ignore", windowsHide: true },
  );
}

export function createTempQcow2Overlay(
  backingPath: string,
  backingFormat: "raw" | "qcow2",
  qemuPath?: string,
): string {
  const overlayPath = path.join(
    tmpDir(),
    `gondolin-disk-${randomUUID().slice(0, 8)}.qcow2`,
  );
  createQcow2Overlay({ path: overlayPath, backingPath, backingFormat }, qemuPath);
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

function qemuImgInfoJson(imagePath: string, qemuPath?: string): QemuImgInfo {
  const raw = execFileSync(
    resolveQemuImgPath({ qemuPath }),
    ["info", "--output=json", imagePath],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
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
export function getQcow2BackingFilename(
  imagePath: string,
  qemuPath?: string,
): string | null {
  const info = qemuImgInfoJson(imagePath, qemuPath);
  return extractBackingFilename(info);
}

/** Resolve qcow2 backing metadata into an absolute path when present. */
export function resolveQcow2BackingPath(
  imagePath: string,
  qemuPath?: string,
): string | null {
  const backing = getQcow2BackingFilename(imagePath, qemuPath);
  if (!backing) return null;
  return path.isAbsolute(backing)
    ? path.resolve(backing)
    : path.resolve(path.dirname(imagePath), backing);
}

/**
 * Rebase a qcow2 image to a new backing file path in-place.
 */
export function rebaseQcow2InPlace(
  imagePath: string,
  backingPath: string,
  backingFormat: "raw" | "qcow2",
  mode: "safe" | "unsafe" = "unsafe",
  qemuPath?: string,
): void {
  const args = ["rebase"];
  if (mode === "unsafe") {
    args.push("-u");
  }
  args.push("-F", backingFormat, "-b", backingPath, imagePath);
  execFileSync(resolveQemuImgPath({ qemuPath }), args, {
    stdio: "ignore",
    windowsHide: true,
  });
}

export const __test = {
  buildDefaultQemuImgCandidates,
  resolveQemuImgPath,
};

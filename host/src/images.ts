import child_process from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadAssetManifest, loadGuestAssets } from "./assets.ts";
import type { Architecture } from "./build/config.ts";
import {
  getHostNodeArchCached,
  normalizeArchitecture as normalizeImageArch,
} from "./host/arch.ts";
import {
  getImageStoreDirectory,
  isImageBuildId as isBuildId,
  parseImageRef,
} from "./image-ref.ts";
import {
  describeAvailableKeys,
  fetchCachedJsonRegistry,
  normalizeSha256,
  parseKeyedRegistry,
  parseRegistryUrl,
  resolveKeyedRegistryRef,
  selectKeyedEntry,
} from "./registry.ts";
import { isPathWithin } from "./utils/path.ts";

export { getImageStoreDirectory } from "./image-ref.ts";

const BUILTIN_IMAGE_REGISTRY_SCHEMA = 1 as const;
const DEFAULT_IMAGE_REGISTRY_URL =
  "https://raw.githubusercontent.com/earendil-works/gondolin/main/builtin-image-registry.json";

const DOWNLOAD_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export type ImageArch = Architecture;

export interface ImageRefTargets {
  /** build id for `aarch64` */
  aarch64?: string;
  /** build id for `x86_64` */
  x86_64?: string;
}

export interface LocalImageRef {
  /** canonical image reference (`name:tag`) */
  reference: string;
  /** build ids mapped by architecture */
  targets: ImageRefTargets;
  /** last update timestamp (`iso 8601`) */
  updatedAt: string;
}

export interface ImportedImage {
  /** imported content-derived build id */
  buildId: string;
  /** image architecture from manifest */
  arch: ImageArch;
  /** object directory containing guest assets */
  assetDir: string;
  /** whether a new object was created */
  created: boolean;
}

export interface ResolvedImage {
  /** source selector (`path`, `build-id`, or `ref`) */
  source: "path" | "build-id" | "ref";
  /** selector value used for resolution */
  selector: string;
  /** resolved guest asset directory */
  assetDir: string;
  /** resolved content-derived build id if known */
  buildId?: string;
  /** resolved architecture when available */
  arch?: ImageArch;
}

type ImageResolutionErrorCode =
  | "object_not_found"
  | "ref_not_found"
  | "ref_arch_not_found";

class ImageResolutionError extends Error {
  /** stable resolution error code */
  readonly code: ImageResolutionErrorCode;

  constructor(code: ImageResolutionErrorCode, message: string) {
    super(message);
    this.name = "ImageResolutionError";
    this.code = code;
  }
}

type RegistryImageSource = {
  /** downloadable archive url */
  url: string;
  /** expected archive checksum (`sha256` hex) */
  sha256?: string;
  /** expected imported architecture */
  arch?: ImageArch;
};

type BuiltinImageRegistry = {
  /** registry schema version */
  schema: typeof BUILTIN_IMAGE_REGISTRY_SCHEMA;
  /** named refs mapped by architecture to build ids */
  refs: Record<string, Partial<Record<ImageArch, string>>>;
  /** build-id keyed sources */
  builds: Record<string, RegistryImageSource>;
};

function imageObjectRootDir(): string {
  return path.join(getImageStoreDirectory(), "objects");
}

function imageRefRootDir(): string {
  return path.join(getImageStoreDirectory(), "refs");
}

function builtinRegistryUrl(): string {
  const value = process.env.GONDOLIN_IMAGE_REGISTRY_URL?.trim();
  return value && value.length > 0 ? value : DEFAULT_IMAGE_REGISTRY_URL;
}

function defaultImageArch(): ImageArch {
  return normalizeImageArch(getHostNodeArchCached()) ?? "x86_64";
}

function ensurePathWithinRoot(
  root: string,
  candidate: string,
  label: string,
): string {
  if (!isPathWithin(root, candidate)) {
    throw new Error(`invalid ${label}: path escapes ${path.resolve(root)}`);
  }
  return path.resolve(candidate);
}

export function normalizeImageBuildId(buildId: string): string {
  if (!isBuildId(buildId)) {
    throw new Error(`invalid image build id: ${buildId}`);
  }
  return buildId;
}

function detectImageArchFromAssetDir(assetDir: string): ImageArch {
  const manifest = loadAssetManifest(assetDir);
  const arch = normalizeImageArch(manifest?.config?.arch);
  if (!arch) {
    throw new Error(
      `guest assets at ${assetDir} are missing a normalized arch in manifest.config.arch`,
    );
  }
  return arch;
}

export function getImageObjectDirectory(buildId: string): string {
  const canonicalBuildId = normalizeImageBuildId(buildId);
  return path.join(imageObjectRootDir(), canonicalBuildId);
}

function ensureImageObjectExists(buildId: string): string {
  const canonicalBuildId = normalizeImageBuildId(buildId);

  const objectDir = getImageObjectDirectory(canonicalBuildId);
  if (!fs.existsSync(objectDir)) {
    throw new ImageResolutionError(
      "object_not_found",
      `image object not found for buildId ${canonicalBuildId} (expected ${objectDir})`,
    );
  }

  loadGuestAssets(objectDir);
  return objectDir;
}

function resolveContainedAssetPath(
  baseDir: string,
  assetPath: unknown,
  fieldName: string,
): string {
  if (typeof assetPath !== "string" || assetPath.trim().length === 0) {
    throw new Error(`invalid ${fieldName}: expected non-empty string`);
  }
  if (path.isAbsolute(assetPath)) {
    throw new Error(`invalid ${fieldName}: absolute paths are not allowed`);
  }

  const resolvedPath = path.resolve(baseDir, assetPath);
  if (
    resolvedPath === path.resolve(baseDir) ||
    !isPathWithin(baseDir, resolvedPath)
  ) {
    throw new Error(
      `invalid ${fieldName}: path must stay within ${baseDir} (got '${assetPath}')`,
    );
  }

  return resolvedPath;
}

function ensureSafeImportSourcePath(
  rootDir: string,
  sourcePath: string,
  fieldName: string,
): string {
  const realSourcePath = fs.realpathSync(sourcePath);
  const resolvedRootDir = fs.realpathSync(rootDir);
  if (!isPathWithin(resolvedRootDir, realSourcePath)) {
    throw new Error(
      `invalid ${fieldName}: resolved path escapes ${resolvedRootDir} (${realSourcePath})`,
    );
  }

  const stat = fs.statSync(realSourcePath);
  if (!stat.isFile()) {
    throw new Error(
      `invalid ${fieldName}: expected regular file at ${realSourcePath}`,
    );
  }

  return realSourcePath;
}

export function importImageFromDirectory(assetDir: string): ImportedImage {
  const resolvedDir = path.resolve(assetDir);
  const manifest = loadAssetManifest(resolvedDir);
  if (!manifest?.buildId) {
    throw new Error(
      `guest assets at ${resolvedDir} are missing manifest buildId (cannot import image)`,
    );
  }

  const buildId = normalizeImageBuildId(manifest.buildId);

  const arch = normalizeImageArch(manifest.config?.arch);
  if (!arch) {
    throw new Error(
      `guest assets at ${resolvedDir} are missing a normalized arch in manifest.config.arch`,
    );
  }

  const objectDir = getImageObjectDirectory(buildId);

  let created = false;
  if (!fs.existsSync(objectDir)) {
    created = true;

    const tmpDir = path.join(
      imageObjectRootDir(),
      `.tmp-${buildId}-${randomUUID().slice(0, 8)}`,
    );

    let finalized = false;

    try {
      fs.mkdirSync(tmpDir, { recursive: true });

      const manifestPath = path.join(resolvedDir, "manifest.json");
      fs.copyFileSync(manifestPath, path.join(tmpDir, "manifest.json"));

      const sourceKernelPath = resolveContainedAssetPath(
        resolvedDir,
        manifest.assets?.kernel,
        "manifest.assets.kernel",
      );
      const sourceInitramfsPath = resolveContainedAssetPath(
        resolvedDir,
        manifest.assets?.initramfs,
        "manifest.assets.initramfs",
      );
      const sourceRootfsPath = resolveContainedAssetPath(
        resolvedDir,
        manifest.assets?.rootfs,
        "manifest.assets.rootfs",
      );
      const sourceKrunKernelPath =
        manifest.assets?.krunKernel === undefined
          ? undefined
          : resolveContainedAssetPath(
              resolvedDir,
              manifest.assets.krunKernel,
              "manifest.assets.krunKernel",
            );
      const sourceKrunInitrdPath =
        manifest.assets?.krunInitrd === undefined
          ? undefined
          : resolveContainedAssetPath(
              resolvedDir,
              manifest.assets.krunInitrd,
              "manifest.assets.krunInitrd",
            );

      if (!fs.existsSync(sourceKernelPath)) {
        throw new Error(
          `missing manifest.assets.kernel file at ${sourceKernelPath}`,
        );
      }
      if (!fs.existsSync(sourceInitramfsPath)) {
        throw new Error(
          `missing manifest.assets.initramfs file at ${sourceInitramfsPath}`,
        );
      }
      if (!fs.existsSync(sourceRootfsPath)) {
        throw new Error(
          `missing manifest.assets.rootfs file at ${sourceRootfsPath}`,
        );
      }
      if (sourceKrunKernelPath && !fs.existsSync(sourceKrunKernelPath)) {
        throw new Error(
          `missing manifest.assets.krunKernel file at ${sourceKrunKernelPath}`,
        );
      }
      if (sourceKrunInitrdPath && !fs.existsSync(sourceKrunInitrdPath)) {
        throw new Error(
          `missing manifest.assets.krunInitrd file at ${sourceKrunInitrdPath}`,
        );
      }

      const safeKernelPath = ensureSafeImportSourcePath(
        resolvedDir,
        sourceKernelPath,
        "manifest.assets.kernel",
      );
      const safeInitramfsPath = ensureSafeImportSourcePath(
        resolvedDir,
        sourceInitramfsPath,
        "manifest.assets.initramfs",
      );
      const safeRootfsPath = ensureSafeImportSourcePath(
        resolvedDir,
        sourceRootfsPath,
        "manifest.assets.rootfs",
      );

      const targetKernelPath = resolveContainedAssetPath(
        tmpDir,
        manifest.assets?.kernel,
        "manifest.assets.kernel",
      );
      const targetInitramfsPath = resolveContainedAssetPath(
        tmpDir,
        manifest.assets?.initramfs,
        "manifest.assets.initramfs",
      );
      const targetRootfsPath = resolveContainedAssetPath(
        tmpDir,
        manifest.assets?.rootfs,
        "manifest.assets.rootfs",
      );

      const targetKrunKernelPath =
        sourceKrunKernelPath === undefined
          ? undefined
          : resolveContainedAssetPath(
              tmpDir,
              manifest.assets!.krunKernel,
              "manifest.assets.krunKernel",
            );
      const targetKrunInitrdPath =
        sourceKrunInitrdPath === undefined
          ? undefined
          : resolveContainedAssetPath(
              tmpDir,
              manifest.assets!.krunInitrd,
              "manifest.assets.krunInitrd",
            );

      fs.mkdirSync(path.dirname(targetKernelPath), {
        recursive: true,
      });
      fs.mkdirSync(path.dirname(targetInitramfsPath), {
        recursive: true,
      });
      fs.mkdirSync(path.dirname(targetRootfsPath), {
        recursive: true,
      });
      if (targetKrunKernelPath) {
        fs.mkdirSync(path.dirname(targetKrunKernelPath), { recursive: true });
      }
      if (targetKrunInitrdPath) {
        fs.mkdirSync(path.dirname(targetKrunInitrdPath), { recursive: true });
      }

      fs.copyFileSync(safeKernelPath, targetKernelPath);
      fs.copyFileSync(safeInitramfsPath, targetInitramfsPath);
      fs.copyFileSync(safeRootfsPath, targetRootfsPath);
      if (targetKrunKernelPath && sourceKrunKernelPath) {
        const safeKrunKernelPath = ensureSafeImportSourcePath(
          resolvedDir,
          sourceKrunKernelPath,
          "manifest.assets.krunKernel",
        );
        fs.copyFileSync(safeKrunKernelPath, targetKrunKernelPath);
      }
      if (targetKrunInitrdPath && sourceKrunInitrdPath) {
        const safeKrunInitrdPath = ensureSafeImportSourcePath(
          resolvedDir,
          sourceKrunInitrdPath,
          "manifest.assets.krunInitrd",
        );
        fs.copyFileSync(safeKrunInitrdPath, targetKrunInitrdPath);
      }

      fs.mkdirSync(imageObjectRootDir(), { recursive: true });

      try {
        fs.renameSync(tmpDir, objectDir);
        finalized = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") {
          throw err;
        }

        // Handle races where another process imported the same build concurrently.
        created = false;
      }
    } finally {
      if (!finalized) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  }

  loadGuestAssets(objectDir);

  return {
    buildId,
    arch,
    assetDir: objectDir,
    created,
  };
}

function symlinkTargetForRef(reference: string, arch: ImageArch): string {
  const parsed = parseImageRef(reference);
  const refsRoot = imageRefRootDir();
  const linkPath = path.resolve(refsRoot, parsed.name, parsed.tag, arch);
  return ensurePathWithinRoot(refsRoot, linkPath, `image ref '${reference}'`);
}

function writeRefSymlink(
  reference: string,
  arch: ImageArch,
  objectDir: string,
): void {
  const linkPath = symlinkTargetForRef(reference, arch);
  const linkDir = path.dirname(linkPath);
  fs.mkdirSync(linkDir, { recursive: true });

  const relativeTarget = path.relative(linkDir, objectDir) || ".";
  const tmpPath = `${linkPath}.tmp-${randomUUID().slice(0, 8)}`;

  fs.symlinkSync(relativeTarget, tmpPath, "dir");
  try {
    fs.renameSync(tmpPath, linkPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

function readBuildIdFromRefSymlink(linkPath: string): string {
  const stat = fs.lstatSync(linkPath);
  if (!stat.isSymbolicLink()) {
    throw new Error(`invalid image ref link: ${linkPath} is not a symlink`);
  }

  const target = fs.readlinkSync(linkPath);
  const objectDir = path.resolve(path.dirname(linkPath), target);
  const manifest = loadAssetManifest(objectDir);
  if (!manifest?.buildId) {
    throw new Error(
      `image ref points to object without manifest buildId: ${linkPath} -> ${objectDir}`,
    );
  }

  normalizeImageBuildId(manifest.buildId);
  loadGuestAssets(objectDir);
  return manifest.buildId;
}

function readLocalRefTargets(reference: string): {
  targets: ImageRefTargets;
  updatedAt: string;
} {
  const parsed = parseImageRef(reference);
  const targets: ImageRefTargets = {};
  let newestMtime = 0;

  for (const arch of ["aarch64", "x86_64"] as const) {
    const linkPath = symlinkTargetForRef(parsed.canonical, arch);
    if (!fs.existsSync(linkPath)) continue;

    const stat = fs.lstatSync(linkPath);
    newestMtime = Math.max(newestMtime, stat.mtimeMs);
    targets[arch] = readBuildIdFromRefSymlink(linkPath);
  }

  const updatedAt =
    newestMtime > 0
      ? new Date(newestMtime).toISOString()
      : new Date(0).toISOString();

  return { targets, updatedAt };
}

export function setImageRef(
  reference: string,
  buildId: string,
  arch: ImageArch,
): LocalImageRef {
  const normalizedArch = normalizeImageArch(arch);
  if (!normalizedArch) {
    throw new Error(`invalid image arch: ${arch}`);
  }

  const objectDir = ensureImageObjectExists(buildId);
  const detectedArch = detectImageArchFromAssetDir(objectDir);
  if (detectedArch !== normalizedArch) {
    throw new Error(
      `image object arch mismatch for ${buildId}: requested ${normalizedArch}, object is ${detectedArch}`,
    );
  }

  const parsedRef = parseImageRef(reference);
  writeRefSymlink(parsedRef.canonical, normalizedArch, objectDir);

  const { targets, updatedAt } = readLocalRefTargets(parsedRef.canonical);
  return {
    reference: parsedRef.canonical,
    targets,
    updatedAt,
  };
}

function collectRefSymlinkEntries(root: string): Array<{
  reference: string;
  arch: ImageArch;
  updatedAtMs: number;
}> {
  if (!fs.existsSync(root)) return [];

  const entries: Array<{
    reference: string;
    arch: ImageArch;
    updatedAtMs: number;
  }> = [];

  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    const dirEntries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of dirEntries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }

      const normalizedArch = normalizeImageArch(entry.name);
      if (!normalizedArch) continue;

      const stat = fs.lstatSync(full);
      if (!stat.isSymbolicLink()) continue;

      const rel = path.relative(root, full);
      const parts = rel.split(path.sep);
      if (parts.length < 3) continue;

      const tag = parts[parts.length - 2]!;
      const name = parts.slice(0, parts.length - 2).join("/");
      if (!name || !tag) continue;

      try {
        const parsed = parseImageRef(`${name}:${tag}`);
        entries.push({
          reference: parsed.canonical,
          arch: normalizedArch,
          updatedAtMs: stat.mtimeMs,
        });
      } catch {
        // ignore invalid ref path entries
      }
    }
  }

  return entries;
}

export function listImageRefs(): LocalImageRef[] {
  const root = imageRefRootDir();
  const symlinkEntries = collectRefSymlinkEntries(root);
  const refs = new Map<
    string,
    { targets: ImageRefTargets; updatedAtMs: number }
  >();

  for (const entry of symlinkEntries) {
    let current = refs.get(entry.reference);
    if (!current) {
      current = { targets: {}, updatedAtMs: 0 };
      refs.set(entry.reference, current);
    }

    try {
      const linkPath = symlinkTargetForRef(entry.reference, entry.arch);
      current.targets[entry.arch] = readBuildIdFromRefSymlink(linkPath);
      current.updatedAtMs = Math.max(current.updatedAtMs, entry.updatedAtMs);
    } catch {
      // Ignore broken ref links in listing output.
    }
  }

  return Array.from(refs.entries())
    .map(([reference, entry]) => ({
      reference,
      targets: entry.targets,
      updatedAt: new Date(entry.updatedAtMs || 0).toISOString(),
    }))
    .sort((a, b) => a.reference.localeCompare(b.reference));
}

function resolveBuildIdFromRef(
  reference: string,
  arch?: ImageArch,
): {
  buildId: string;
  arch: ImageArch;
} {
  const parsedRef = parseImageRef(reference);
  const local = readLocalRefTargets(parsedRef.canonical);

  const requestedArch = normalizeImageArch(arch) ?? defaultImageArch();
  const selected = selectKeyedEntry(local.targets, requestedArch, true);
  if (selected) {
    return { buildId: selected.buildId, arch: selected.key };
  }

  const availableArchs = describeAvailableKeys(local.targets);
  if (availableArchs === "none") {
    throw new ImageResolutionError(
      "ref_not_found",
      `image ref not found: ${parsedRef.canonical}`,
    );
  }

  throw new ImageResolutionError(
    "ref_arch_not_found",
    `image ref '${parsedRef.canonical}' has no target for ${requestedArch} (available: ${availableArchs})`,
  );
}

function resolvePathSelector(selector: string): string | null {
  const resolved = path.resolve(selector);
  if (!fs.existsSync(resolved)) {
    return null;
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`image selector path is not a directory: ${resolved}`);
  }
  return resolved;
}

export function resolveImageSelector(
  selector: string,
  arch?: ImageArch,
): ResolvedImage {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new Error("image selector must not be empty");
  }

  const pathSelector = resolvePathSelector(trimmed);
  if (pathSelector) {
    loadGuestAssets(pathSelector);
    const manifest = loadAssetManifest(pathSelector);
    const resolvedArch =
      normalizeImageArch(manifest?.config?.arch) ?? undefined;
    return {
      source: "path",
      selector: pathSelector,
      assetDir: pathSelector,
      buildId: manifest?.buildId,
      arch: resolvedArch,
    };
  }

  if (isBuildId(trimmed)) {
    const buildId = normalizeImageBuildId(trimmed);
    const assetDir = ensureImageObjectExists(buildId);
    return {
      source: "build-id",
      selector: buildId,
      assetDir,
      buildId,
      arch: detectImageArchFromAssetDir(assetDir),
    };
  }

  const resolved = resolveBuildIdFromRef(trimmed, arch);
  const assetDir = ensureImageObjectExists(resolved.buildId);

  return {
    source: "ref",
    selector: parseImageRef(trimmed).canonical,
    assetDir,
    buildId: resolved.buildId,
    arch: resolved.arch,
  };
}

function parseRegistrySource(
  value: unknown,
  where: string,
  baseUrl: URL,
): RegistryImageSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid ${where}: expected object`);
  }

  const rec = value as Record<string, unknown>;
  const out: RegistryImageSource = {
    url: parseRegistryUrl(rec.url, `${where}.url`, baseUrl),
  };

  if (rec.sha256 !== undefined) {
    out.sha256 = normalizeSha256(rec.sha256, `${where}.sha256`);
  }

  if (rec.arch !== undefined) {
    if (typeof rec.arch !== "string") {
      throw new Error(`invalid ${where}.arch: expected string`);
    }
    const arch = normalizeImageArch(rec.arch);
    if (!arch) {
      throw new Error(`invalid ${where}.arch: ${String(rec.arch)}`);
    }
    out.arch = arch;
  }

  return out;
}

function parseBuiltinRegistry(
  raw: unknown,
  sourceUrl: string,
): BuiltinImageRegistry {
  const { refs, builds } = parseKeyedRegistry(raw, sourceUrl, {
    label: "builtin image registry",
    schema: BUILTIN_IMAGE_REGISTRY_SCHEMA,
    keyName: "arch",
    normalizeKey: normalizeImageArch,
    normalizeBuildId: normalizeImageBuildId,
    canonicalRef: (reference) => parseImageRef(reference).canonical,
    parseBuild: parseRegistrySource,
    buildKey: (source) => source.arch,
  });
  return { schema: BUILTIN_IMAGE_REGISTRY_SCHEMA, refs, builds };
}

function formatProgressBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  if (unit === 0) {
    return `${Math.round(value)}${units[unit]}`;
  }
  if (value >= 100) {
    return `${value.toFixed(0)}${units[unit]}`;
  }
  if (value >= 10) {
    return `${value.toFixed(1)}${units[unit]}`;
  }
  return `${value.toFixed(2)}${units[unit]}`;
}

function formatProgressDuration(totalMs: number): string {
  if (totalMs < 1000) {
    return `${Math.max(1, Math.round(totalMs))}ms`;
  }

  const totalSeconds = Math.max(1, Math.round(totalMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

type DownloadProgress = {
  /** add downloaded chunk bytes */
  addChunk: (chunkBytes: number) => void;
  /** mark download success */
  finish: () => void;
  /** mark download failure */
  fail: () => void;
};

function truncateProgressLine(line: string): string {
  const columns = process.stderr.columns;
  if (!columns || columns < 8) {
    return line;
  }
  if (line.length <= columns - 1) {
    return line;
  }
  return `${line.slice(0, Math.max(1, columns - 2))}…`;
}

function createDownloadProgress(
  label: string,
  totalBytes: number | null,
): DownloadProgress {
  const isTty = Boolean(process.stderr.isTTY) && process.env.CI !== "true";
  if (!isTty) {
    return {
      addChunk() {},
      finish() {},
      fail() {},
    };
  }

  const startedAt = Date.now();
  let downloadedBytes = 0;
  let frame = 0;
  let interval: NodeJS.Timeout | null = null;
  let finished = false;

  const details = (elapsedMs: number): { progress: string; eta?: string } => {
    if (!totalBytes || totalBytes <= 0) {
      return {
        progress: formatProgressBytes(downloadedBytes),
      };
    }

    const progress = `${formatProgressBytes(downloadedBytes)}/${formatProgressBytes(totalBytes)}`;
    const elapsedSeconds = Math.max(elapsedMs / 1000, 0.001);
    const speedBytesPerSecond = downloadedBytes / elapsedSeconds;
    if (downloadedBytes <= 0 || speedBytesPerSecond <= 0) {
      return { progress };
    }

    const remainingBytes = Math.max(0, totalBytes - downloadedBytes);
    const etaSeconds = remainingBytes / speedBytesPerSecond;
    return {
      progress,
      eta: formatProgressDuration(etaSeconds * 1000),
    };
  };

  const render = (line: string, final = false): void => {
    process.stderr.write(`\r\x1b[2K${truncateProgressLine(line)}`);
    if (final) {
      process.stderr.write("\n");
    }
  };

  interval = setInterval(() => {
    const spinner =
      DOWNLOAD_SPINNER_FRAMES[frame % DOWNLOAD_SPINNER_FRAMES.length];
    frame += 1;
    const elapsedMs = Date.now() - startedAt;
    const info = details(elapsedMs);
    const etaSuffix = info.eta ? `, eta ${info.eta}` : "";
    render(`${spinner} downloading ${label} ${info.progress}${etaSuffix}`);
  }, 250);
  interval.unref();

  return {
    addChunk(chunkBytes: number) {
      downloadedBytes += chunkBytes;
    },

    finish() {
      if (finished) return;
      finished = true;
      if (interval) {
        clearInterval(interval);
      }
      const elapsed = formatProgressDuration(Date.now() - startedAt);
      const progress = totalBytes
        ? `${formatProgressBytes(totalBytes)}/${formatProgressBytes(totalBytes)}`
        : formatProgressBytes(downloadedBytes);
      render(`✓ downloaded ${label} ${progress} in ${elapsed}`, true);
    },

    fail() {
      if (finished) return;
      finished = true;
      if (interval) {
        clearInterval(interval);
      }
      const elapsed = formatProgressDuration(Date.now() - startedAt);
      render(`✗ failed downloading ${label} after ${elapsed}`, true);
    },
  };
}

async function fetchBuiltinImageRegistry(): Promise<BuiltinImageRegistry> {
  return await fetchCachedJsonRegistry({
    url: builtinRegistryUrl(),
    storeDir: getImageStoreDirectory(),
    cacheFileName: "builtin-image-registry-cache.json",
    userAgent: "gondolin-image-registry",
    parse: parseBuiltinRegistry,
    label: "builtin image registry",
  });
}

async function downloadArchive(
  source: RegistryImageSource,
  archivePath: string,
  progressLabel: string,
): Promise<void> {
  const response = await fetch(source.url, {
    headers: {
      "User-Agent": "gondolin-image-fetch",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `failed to download image archive: ${response.status} ${response.statusText} (${source.url})`,
    );
  }

  const rawContentLength = response.headers.get("content-length");
  const totalBytes =
    rawContentLength && /^\d+$/.test(rawContentLength)
      ? Number.parseInt(rawContentLength, 10)
      : null;
  const progress = createDownloadProgress(progressLabel, totalBytes);

  const hash = createHash("sha256");
  const stream = fs.createWriteStream(archivePath, { flags: "w" });

  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      hash.update(value);
      const chunk = Buffer.from(value);
      progress.addChunk(chunk.length);
      await new Promise<void>((resolve, reject) => {
        stream.write(chunk, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }

    await new Promise<void>((resolve, reject) => {
      stream.end((error: Error | null | undefined) => {
        if (error) reject(error);
        else resolve();
      });
    });

    if (source.sha256) {
      const got = hash.digest("hex");
      if (got !== source.sha256) {
        throw new Error(
          `downloaded image checksum mismatch for ${source.url}\n  expected: ${source.sha256}\n  got:      ${got}`,
        );
      }
    }

    progress.finish();
  } catch (error) {
    progress.fail();
    throw error;
  } finally {
    stream.destroy();
  }
}

async function importImageFromSource(
  source: RegistryImageSource,
  expectedBuildId?: string,
  progressLabel = "image",
): Promise<ImportedImage> {
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-image-pull-"),
  );
  const archivePath = path.join(tmpRoot, "image.tar.gz");
  const extractDir = path.join(tmpRoot, "extract");

  try {
    await downloadArchive(source, archivePath, progressLabel);
    fs.mkdirSync(extractDir, { recursive: true });

    child_process.execFileSync("tar", ["-xzf", archivePath, "-C", extractDir], {
      stdio: "pipe",
    });

    const imported = importImageFromDirectory(extractDir);

    if (source.arch && imported.arch !== source.arch) {
      throw new Error(
        `downloaded image arch mismatch\n  expected: ${source.arch}\n  got:      ${imported.arch}\n  source:   ${source.url}`,
      );
    }

    if (expectedBuildId && imported.buildId !== expectedBuildId) {
      throw new Error(
        `downloaded image buildId mismatch\n  expected: ${expectedBuildId}\n  got:      ${imported.buildId}\n  source:   ${source.url}`,
      );
    }

    return imported;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function isExpectedLocalImageMiss(error: unknown): boolean {
  if (!(error instanceof ImageResolutionError)) {
    return false;
  }

  return (
    error.code === "object_not_found" ||
    error.code === "ref_not_found" ||
    error.code === "ref_arch_not_found"
  );
}

export async function ensureImageSelector(
  selector: string,
  arch?: ImageArch,
): Promise<ResolvedImage> {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new Error("image selector must not be empty");
  }

  const absoluteSelectorPath = path.resolve(trimmed);
  if (fs.existsSync(absoluteSelectorPath)) {
    const stat = fs.statSync(absoluteSelectorPath);
    if (!stat.isDirectory()) {
      throw new Error(
        `image selector path is not a directory: ${absoluteSelectorPath}`,
      );
    }
  }

  try {
    return resolveImageSelector(selector, arch);
  } catch (error) {
    if (!isExpectedLocalImageMiss(error)) {
      throw error;
    }
  }

  const registry = await fetchBuiltinImageRegistry();

  if (isBuildId(trimmed)) {
    const buildId = normalizeImageBuildId(trimmed);
    const source = registry.builds[buildId];
    if (!source) {
      throw new Error(
        `image build id not found in builtin registry builds metadata: ${buildId}`,
      );
    }

    await importImageFromSource(source, buildId, buildId);
    return resolveImageSelector(buildId, arch);
  }

  const parsedRef = parseImageRef(trimmed);
  const {
    buildId,
    key: resolvedArch,
    build: source,
  } = resolveKeyedRegistryRef(
    registry,
    parsedRef.canonical,
    normalizeImageArch(arch) ?? defaultImageArch(),
    { label: "image", allowSingleFallback: true },
  );

  const imported = await importImageFromSource(
    source,
    buildId,
    parsedRef.canonical,
  );
  if (imported.arch !== resolvedArch) {
    throw new Error(
      `registry ref '${parsedRef.canonical}' (${resolvedArch}) resolved to ${imported.arch}`,
    );
  }

  setImageRef(parsedRef.canonical, imported.buildId, imported.arch);
  return resolveImageSelector(parsedRef.canonical, arch);
}

export function tagImage(
  source: string,
  targetReference: string,
  arch?: ImageArch,
): LocalImageRef {
  const resolved = resolveImageSelector(source, arch);
  if (!resolved.buildId) {
    throw new Error(
      `image selector '${source}' does not have a buildId (expected manifest buildId)`,
    );
  }

  const resolvedArch =
    normalizeImageArch(arch) ??
    resolved.arch ??
    detectImageArchFromAssetDir(resolved.assetDir);

  return setImageRef(targetReference, resolved.buildId, resolvedArch);
}

function pruneEmptyRefDirectories(startDir: string): void {
  const root = path.resolve(imageRefRootDir());
  let current = path.resolve(startDir);

  while (current !== root) {
    const relative = path.relative(root, current);
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) return;
    if (!fs.existsSync(current) || fs.readdirSync(current).length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function localRefsForBuildId(buildId: string): Array<{
  reference: string;
  arch: ImageArch;
  linkPath: string;
}> {
  const objectDir = path.resolve(getImageObjectDirectory(buildId));
  const refs: Array<{
    reference: string;
    arch: ImageArch;
    linkPath: string;
  }> = [];

  for (const entry of collectRefSymlinkEntries(imageRefRootDir())) {
    const linkPath = symlinkTargetForRef(entry.reference, entry.arch);
    const target = fs.readlinkSync(linkPath);
    if (path.resolve(path.dirname(linkPath), target) !== objectDir) continue;
    refs.push({ ...entry, linkPath });
  }

  return refs;
}

function removeRefLink(linkPath: string): void {
  fs.rmSync(linkPath, { force: true });
  pruneEmptyRefDirectories(path.dirname(linkPath));
}

export function listUntaggedImages(): ResolvedImage[] {
  const objectRoot = imageObjectRootDir();
  if (!fs.existsSync(objectRoot)) return [];

  const referenced = new Set<string>();
  for (const entry of collectRefSymlinkEntries(imageRefRootDir())) {
    try {
      const linkPath = symlinkTargetForRef(entry.reference, entry.arch);
      referenced.add(readBuildIdFromRefSymlink(linkPath));
    } catch {
      // Ignore malformed refs, consistent with listImageRefs().
    }
  }

  const images: ResolvedImage[] = [];
  for (const entry of fs.readdirSync(objectRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isBuildId(entry.name)) continue;
    const buildId = normalizeImageBuildId(entry.name);
    if (referenced.has(buildId)) continue;

    try {
      const assetDir = ensureImageObjectExists(buildId);
      images.push({
        source: "build-id",
        selector: buildId,
        assetDir,
        buildId,
        arch: detectImageArchFromAssetDir(assetDir),
      });
    } catch {
      // Ignore malformed image objects, consistent with listImageRefs().
    }
  }

  return images.sort((a, b) => a.selector.localeCompare(b.selector));
}

function removeUnreferencedObject(buildId: string): boolean {
  if (localRefsForBuildId(buildId).length > 0) return false;

  const objectDir = getImageObjectDirectory(buildId);
  if (!fs.existsSync(objectDir)) return false;
  fs.rmSync(objectDir, { recursive: true, force: true });
  return true;
}

export function removeUntaggedImages(): {
  removedBuildIds: string[];
} {
  const removedBuildIds: string[] = [];
  for (const image of listUntaggedImages()) {
    if (image.buildId && removeUnreferencedObject(image.buildId)) {
      removedBuildIds.push(image.buildId);
    }
  }
  return { removedBuildIds };
}

export function removeAllImages(): {
  removedRefs: Array<{ reference: string; arch: ImageArch }>;
  removedBuildIds: string[];
} {
  const removedRefs = collectRefSymlinkEntries(imageRefRootDir()).map(
    ({ reference, arch }) => ({ reference, arch }),
  );
  const removedBuildIds = fs.existsSync(imageObjectRootDir())
    ? fs
        .readdirSync(imageObjectRootDir(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isBuildId(entry.name))
        .map((entry) => normalizeImageBuildId(entry.name))
        .sort()
    : [];

  fs.rmSync(imageRefRootDir(), { recursive: true, force: true });
  fs.rmSync(imageObjectRootDir(), { recursive: true, force: true });
  return { removedRefs, removedBuildIds };
}

export function removeImage(
  selector: string,
  options: { force?: boolean } = {},
): {
  selector: string;
  removedRefs: Array<{ reference: string; arch: ImageArch }>;
  removedBuildIds: string[];
} {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new Error("image selector must not be empty");
  }

  const removedRefs: Array<{ reference: string; arch: ImageArch }> = [];
  const removedBuildIds: string[] = [];

  if (isBuildId(trimmed)) {
    const buildId = normalizeImageBuildId(trimmed);
    const objectDir = getImageObjectDirectory(buildId);
    if (!fs.existsSync(objectDir)) {
      throw new ImageResolutionError(
        "object_not_found",
        `image object not found for buildId ${buildId} (expected ${objectDir})`,
      );
    }

    const refs = localRefsForBuildId(buildId);
    if (refs.length > 0 && !options.force) {
      const labels = refs
        .map((ref) => `${ref.reference} (${ref.arch})`)
        .join(", ");
      throw new Error(
        `image object ${buildId} is referenced by ${labels}; remove those tags first or use --force`,
      );
    }

    for (const ref of refs) {
      removeRefLink(ref.linkPath);
      removedRefs.push({ reference: ref.reference, arch: ref.arch });
    }
    fs.rmSync(objectDir, { recursive: true, force: true });
    removedBuildIds.push(buildId);
    return { selector: buildId, removedRefs, removedBuildIds };
  }

  const parsed = parseImageRef(trimmed);
  const targetBuildIds = new Set<string>();
  let found = false;

  for (const arch of ["aarch64", "x86_64"] as const) {
    const linkPath = symlinkTargetForRef(parsed.canonical, arch);
    try {
      if (!fs.lstatSync(linkPath).isSymbolicLink()) {
        throw new Error(`invalid image ref link: ${linkPath} is not a symlink`);
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    found = true;
    try {
      targetBuildIds.add(readBuildIdFromRefSymlink(linkPath));
    } catch {
      // Remove malformed local refs, but do not infer an object to delete.
    }
    removeRefLink(linkPath);
    removedRefs.push({ reference: parsed.canonical, arch });
  }

  if (!found) {
    throw new ImageResolutionError(
      "ref_not_found",
      `image ref not found: ${parsed.canonical}`,
    );
  }

  for (const buildId of targetBuildIds) {
    if (removeUnreferencedObject(buildId)) {
      removedBuildIds.push(buildId);
    }
  }

  return {
    selector: parsed.canonical,
    removedRefs,
    removedBuildIds,
  };
}

export const __test = {
  parseImageRef,
  normalizeImageArch,
  isBuildId,
  normalizeImageBuildId,
  parseBuiltinRegistry,
};

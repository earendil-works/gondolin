import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

import { loadAssetManifest, loadGuestAssets } from "./assets";
import { getHostNodeArchCached } from "./host/arch";
import type { Architecture } from "./build/config";

const IMAGE_REF_INDEX_VERSION = 1 as const;

const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const IMAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

interface ImageRefIndexEntry {
  /** build ids mapped by architecture */
  targets: ImageRefTargets;
  /** last update timestamp (`iso 8601`) */
  updatedAt: string;
}

interface ImageRefIndex {
  /** index schema version */
  version: typeof IMAGE_REF_INDEX_VERSION;
  /** image refs by canonical `name:tag` */
  refs: Record<string, ImageRefIndexEntry>;
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

type ParsedImageRef = {
  /** image name component */
  name: string;
  /** image tag component */
  tag: string;
  /** canonical `name:tag` */
  canonical: string;
};

function cacheBaseDir(): string {
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

export function getImageStoreDirectory(): string {
  return (
    process.env.GONDOLIN_IMAGE_STORE ??
    path.join(cacheBaseDir(), "gondolin", "images")
  );
}

function imageObjectRootDir(): string {
  return path.join(getImageStoreDirectory(), "objects");
}

function imageRefIndexPath(): string {
  return path.join(getImageStoreDirectory(), "refs.json");
}

function normalizeImageArch(
  value: string | undefined | null,
): ImageArch | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === "aarch64" || lower === "arm64") return "aarch64";
  if (lower === "x86_64" || lower === "amd64" || lower === "x64") {
    return "x86_64";
  }
  return null;
}

function defaultImageArch(): ImageArch {
  return normalizeImageArch(getHostNodeArchCached()) ?? "x86_64";
}

function parseImageRef(reference: string): ParsedImageRef {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new Error("image reference must not be empty");
  }

  const colon = trimmed.lastIndexOf(":");
  const hasExplicitTag = colon > 0 && colon < trimmed.length - 1;

  const name = hasExplicitTag ? trimmed.slice(0, colon) : trimmed;
  const tag = hasExplicitTag ? trimmed.slice(colon + 1) : "latest";

  if (!IMAGE_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid image name '${name}' (allowed: letters, numbers, '.', '_', '-', '/')`,
    );
  }
  if (!IMAGE_TAG_PATTERN.test(tag)) {
    throw new Error(
      `invalid image tag '${tag}' (allowed: letters, numbers, '.', '_', '-')`,
    );
  }

  return {
    name,
    tag,
    canonical: `${name}:${tag}`,
  };
}

function isBuildId(value: string): boolean {
  return BUILD_ID_PATTERN.test(value);
}

function defaultRefIndex(): ImageRefIndex {
  return {
    version: IMAGE_REF_INDEX_VERSION,
    refs: {},
  };
}

function loadRefIndex(): ImageRefIndex {
  const indexPath = imageRefIndexPath();
  if (!fs.existsSync(indexPath)) {
    return defaultRefIndex();
  }

  try {
    const raw = fs.readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw) as ImageRefIndex;
    if (parsed.version !== IMAGE_REF_INDEX_VERSION || !parsed.refs) {
      return defaultRefIndex();
    }
    return parsed;
  } catch {
    return defaultRefIndex();
  }
}

function saveRefIndex(index: ImageRefIndex): void {
  const storeDir = getImageStoreDirectory();
  fs.mkdirSync(storeDir, { recursive: true });

  const indexPath = imageRefIndexPath();
  const tmpPath = `${indexPath}.tmp-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2));
  fs.renameSync(tmpPath, indexPath);
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
  return path.join(imageObjectRootDir(), buildId);
}

function ensureImageObjectExists(buildId: string): string {
  if (!isBuildId(buildId)) {
    throw new Error(`invalid image build id: ${buildId}`);
  }

  const objectDir = getImageObjectDirectory(buildId);
  if (!fs.existsSync(objectDir)) {
    throw new Error(
      `image object not found for buildId ${buildId} (expected ${objectDir})`,
    );
  }

  loadGuestAssets(objectDir);
  return objectDir;
}

export function importImageFromDirectory(assetDir: string): ImportedImage {
  const resolvedDir = path.resolve(assetDir);
  const manifest = loadAssetManifest(resolvedDir);
  if (!manifest?.buildId) {
    throw new Error(
      `guest assets at ${resolvedDir} are missing manifest buildId (cannot import image)`,
    );
  }

  const arch = normalizeImageArch(manifest.config?.arch);
  if (!arch) {
    throw new Error(
      `guest assets at ${resolvedDir} are missing a normalized arch in manifest.config.arch`,
    );
  }

  const sourceAssets = loadGuestAssets(resolvedDir);
  const objectDir = getImageObjectDirectory(manifest.buildId);

  let created = false;
  if (!fs.existsSync(objectDir)) {
    created = true;

    const tmpDir = path.join(
      imageObjectRootDir(),
      `.tmp-${manifest.buildId}-${randomUUID().slice(0, 8)}`,
    );

    fs.mkdirSync(tmpDir, { recursive: true });

    const manifestPath = path.join(resolvedDir, "manifest.json");
    fs.copyFileSync(manifestPath, path.join(tmpDir, "manifest.json"));

    const assetNames = manifest.assets;
    fs.mkdirSync(path.dirname(path.join(tmpDir, assetNames.kernel)), {
      recursive: true,
    });
    fs.mkdirSync(path.dirname(path.join(tmpDir, assetNames.initramfs)), {
      recursive: true,
    });
    fs.mkdirSync(path.dirname(path.join(tmpDir, assetNames.rootfs)), {
      recursive: true,
    });

    fs.copyFileSync(
      sourceAssets.kernelPath,
      path.join(tmpDir, assetNames.kernel),
    );
    fs.copyFileSync(
      sourceAssets.initrdPath,
      path.join(tmpDir, assetNames.initramfs),
    );
    fs.copyFileSync(
      sourceAssets.rootfsPath,
      path.join(tmpDir, assetNames.rootfs),
    );

    fs.mkdirSync(imageObjectRootDir(), { recursive: true });

    try {
      fs.renameSync(tmpDir, objectDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw err;
      }

      // Handle races where another process imported the same build concurrently.
      fs.rmSync(tmpDir, { recursive: true, force: true });
      created = false;
    }
  }

  loadGuestAssets(objectDir);

  return {
    buildId: manifest.buildId,
    arch,
    assetDir: objectDir,
    created,
  };
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
  const index = loadRefIndex();
  const now = new Date().toISOString();

  const existing = index.refs[parsedRef.canonical];
  const targets: ImageRefTargets = {
    ...(existing?.targets ?? {}),
    [normalizedArch]: buildId,
  };

  index.refs[parsedRef.canonical] = {
    targets,
    updatedAt: now,
  };

  saveRefIndex(index);

  return {
    reference: parsedRef.canonical,
    targets,
    updatedAt: now,
  };
}

export function listImageRefs(): LocalImageRef[] {
  const index = loadRefIndex();
  return Object.entries(index.refs)
    .map(([reference, entry]) => ({
      reference,
      targets: { ...entry.targets },
      updatedAt: entry.updatedAt,
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
  const index = loadRefIndex();
  const entry = index.refs[parsedRef.canonical];

  if (!entry) {
    throw new Error(`image ref not found: ${parsedRef.canonical}`);
  }

  const requestedArch = normalizeImageArch(arch) ?? defaultImageArch();
  const exact = entry.targets[requestedArch];
  if (exact) {
    return { buildId: exact, arch: requestedArch };
  }

  const available = Object.entries(entry.targets).filter(
    (pair): pair is [ImageArch, string] => {
      const [name, value] = pair;
      return normalizeImageArch(name) !== null && typeof value === "string";
    },
  );

  if (available.length === 1) {
    const [fallbackArch, fallbackBuildId] = available[0]!;
    return {
      buildId: fallbackBuildId,
      arch: fallbackArch,
    };
  }

  const availableArchs = available.map(([name]) => name).join(", ") || "none";
  throw new Error(
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
    const buildId = trimmed.toLowerCase();
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

export const __test = {
  parseImageRef,
  normalizeImageArch,
  isBuildId,
};

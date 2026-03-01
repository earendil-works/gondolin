import child_process from "child_process";
import { randomUUID, createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { loadAssetManifest, loadGuestAssets } from "./assets.ts";
import type { Architecture } from "./build/config.ts";
import { getHostNodeArchCached } from "./host/arch.ts";

const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const IMAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const IMAGE_NAME_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const BUILTIN_IMAGE_REGISTRY_SCHEMA = 1 as const;
const DEFAULT_IMAGE_REGISTRY_URL =
  "https://raw.githubusercontent.com/earendil-works/gondolin/main/builtin-image-registry.json";

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

type ParsedImageRef = {
  /** image name component */
  name: string;
  /** image tag component */
  tag: string;
  /** canonical `name:tag` */
  canonical: string;
};

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
  /** expected imported build id */
  buildId?: string;
  /** expected imported architecture */
  arch?: ImageArch;
};

type BuiltinImageRegistry = {
  /** registry schema version */
  schema: typeof BUILTIN_IMAGE_REGISTRY_SCHEMA;
  /** named refs mapped by architecture */
  refs: Record<string, Partial<Record<ImageArch, RegistryImageSource>>>;
  /** build-id keyed sources */
  builds: Record<string, RegistryImageSource>;
};

type RegistryCache = {
  /** source registry URL */
  url: string;
  /** HTTP etag from the last successful fetch */
  etag?: string;
  /** cached registry payload */
  registry: BuiltinImageRegistry;
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

function imageRefRootDir(): string {
  return path.join(getImageStoreDirectory(), "refs");
}

function registryCachePath(): string {
  return path.join(
    getImageStoreDirectory(),
    "builtin-image-registry-cache.json",
  );
}

function builtinRegistryUrl(): string {
  const value = process.env.GONDOLIN_IMAGE_REGISTRY_URL?.trim();
  return value && value.length > 0 ? value : DEFAULT_IMAGE_REGISTRY_URL;
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

function ensurePathWithinRoot(
  root: string,
  candidate: string,
  label: string,
): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`invalid ${label}: path escapes ${resolvedRoot}`);
  }
  return resolvedCandidate;
}

function validateImageNameSegments(name: string): void {
  const segments = name.split("/");
  if (segments.length === 0) {
    throw new Error(`invalid image name '${name}'`);
  }

  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.length === 0) {
      throw new Error(
        `invalid image name '${name}' (must not contain path traversal segments)`,
      );
    }
    if (!IMAGE_NAME_SEGMENT_PATTERN.test(segment)) {
      throw new Error(
        `invalid image name '${name}' (invalid segment '${segment}')`,
      );
    }
  }
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
  validateImageNameSegments(name);

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
  const relative = path.relative(baseDir, resolvedPath);
  if (
    relative.length === 0 ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `invalid ${fieldName}: path must stay within ${baseDir} (got '${assetPath}')`,
    );
  }

  return resolvedPath;
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

      fs.mkdirSync(path.dirname(targetKernelPath), {
        recursive: true,
      });
      fs.mkdirSync(path.dirname(targetInitramfsPath), {
        recursive: true,
      });
      fs.mkdirSync(path.dirname(targetRootfsPath), {
        recursive: true,
      });

      fs.copyFileSync(sourceKernelPath, targetKernelPath);
      fs.copyFileSync(sourceInitramfsPath, targetInitramfsPath);
      fs.copyFileSync(sourceRootfsPath, targetRootfsPath);

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
  const exact = local.targets[requestedArch];
  if (exact) {
    return { buildId: exact, arch: requestedArch };
  }

  const available = Object.entries(local.targets).filter(
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

  if (available.length === 0) {
    throw new ImageResolutionError(
      "ref_not_found",
      `image ref not found: ${parsedRef.canonical}`,
    );
  }

  const availableArchs = available.map(([name]) => name).join(", ") || "none";
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
  if (typeof value === "string") {
    return {
      url: new URL(value, baseUrl).toString(),
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid ${where}: expected string or object`);
  }

  const rec = value as Record<string, unknown>;
  if (typeof rec.url !== "string" || rec.url.length === 0) {
    throw new Error(`invalid ${where}.url: expected non-empty string`);
  }

  const out: RegistryImageSource = {
    url: new URL(rec.url, baseUrl).toString(),
  };

  if (rec.sha256 !== undefined) {
    if (typeof rec.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(rec.sha256)) {
      throw new Error(
        `invalid ${where}.sha256: expected 64-char lowercase hex`,
      );
    }
    out.sha256 = rec.sha256;
  }

  if (rec.buildId !== undefined) {
    if (typeof rec.buildId !== "string") {
      throw new Error(`invalid ${where}.buildId: expected string`);
    }
    out.buildId = normalizeImageBuildId(rec.buildId);
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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid builtin image registry: expected object");
  }

  const rec = raw as Record<string, unknown>;
  if (rec.schema !== BUILTIN_IMAGE_REGISTRY_SCHEMA) {
    throw new Error(
      `invalid builtin image registry schema: expected ${BUILTIN_IMAGE_REGISTRY_SCHEMA}`,
    );
  }

  const baseUrl = new URL(sourceUrl);

  if (!rec.refs || typeof rec.refs !== "object" || Array.isArray(rec.refs)) {
    throw new Error("invalid builtin image registry: refs must be an object");
  }

  const refs: Record<
    string,
    Partial<Record<ImageArch, RegistryImageSource>>
  > = {};
  for (const [reference, archMap] of Object.entries(
    rec.refs as Record<string, unknown>,
  )) {
    const parsedRef = parseImageRef(reference);
    if (parsedRef.canonical !== reference) {
      throw new Error(`invalid builtin image registry ref key: ${reference}`);
    }

    if (!archMap || typeof archMap !== "object" || Array.isArray(archMap)) {
      throw new Error(`invalid registry ref '${reference}': expected object`);
    }

    const mapped: Partial<Record<ImageArch, RegistryImageSource>> = {};
    for (const [archKey, value] of Object.entries(
      archMap as Record<string, unknown>,
    )) {
      const arch = normalizeImageArch(archKey);
      if (!arch) {
        throw new Error(
          `invalid registry ref '${reference}' arch key: ${archKey}`,
        );
      }

      mapped[arch] = parseRegistrySource(
        value,
        `refs['${reference}']['${archKey}']`,
        baseUrl,
      );
    }

    refs[parsedRef.canonical] = mapped;
  }

  const builds: Record<string, RegistryImageSource> = {};
  if (rec.builds !== undefined) {
    if (
      !rec.builds ||
      typeof rec.builds !== "object" ||
      Array.isArray(rec.builds)
    ) {
      throw new Error(
        "invalid builtin image registry: builds must be an object",
      );
    }

    for (const [buildId, value] of Object.entries(
      rec.builds as Record<string, unknown>,
    )) {
      const canonical = normalizeImageBuildId(buildId);
      const source = parseRegistrySource(
        value,
        `builds['${buildId}']`,
        baseUrl,
      );
      if (source.buildId && source.buildId !== canonical) {
        throw new Error(
          `invalid registry build '${buildId}': buildId mismatch (${source.buildId})`,
        );
      }
      builds[canonical] = {
        ...source,
        buildId: canonical,
      };
    }
  }

  return {
    schema: BUILTIN_IMAGE_REGISTRY_SCHEMA,
    refs,
    builds,
  };
}

function loadRegistryCache(url: string): RegistryCache | null {
  const cachePath = registryCachePath();
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(cachePath, "utf8"),
    ) as RegistryCache;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.url !== url) return null;
    const registry = parseBuiltinRegistry(parsed.registry as unknown, url);
    return {
      url,
      etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
      registry,
    };
  } catch {
    return null;
  }
}

function saveRegistryCache(cache: RegistryCache): void {
  const storeDir = getImageStoreDirectory();
  fs.mkdirSync(storeDir, { recursive: true });

  const cachePath = registryCachePath();
  const tmpPath = `${cachePath}.tmp-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2));
  fs.renameSync(tmpPath, cachePath);
}

async function fetchBuiltinImageRegistry(): Promise<BuiltinImageRegistry> {
  const url = builtinRegistryUrl();
  const cached = loadRegistryCache(url);

  const headers: Record<string, string> = {
    "User-Agent": "gondolin-image-registry",
  };
  if (cached?.etag) {
    headers["If-None-Match"] = cached.etag;
  }

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    if (cached) {
      return cached.registry;
    }
    throw new Error(
      `failed to fetch builtin image registry from ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 304 && cached) {
    return cached.registry;
  }

  if (!response.ok) {
    if (cached) {
      return cached.registry;
    }
    throw new Error(
      `failed to fetch builtin image registry: ${response.status} ${response.statusText} (${url})`,
    );
  }

  const text = await response.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `failed to parse builtin image registry json from ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const registry = parseBuiltinRegistry(raw, url);
  saveRegistryCache({
    url,
    etag: response.headers.get("etag") ?? undefined,
    registry,
  });

  return registry;
}

async function downloadArchive(
  source: RegistryImageSource,
  archivePath: string,
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

  const hash = createHash("sha256");
  const stream = fs.createWriteStream(archivePath, { flags: "w" });

  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      hash.update(value);
      const chunk = Buffer.from(value);
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
  } finally {
    stream.destroy();
  }

  if (source.sha256) {
    const got = hash.digest("hex");
    if (got !== source.sha256) {
      throw new Error(
        `downloaded image checksum mismatch for ${source.url}\n  expected: ${source.sha256}\n  got:      ${got}`,
      );
    }
  }
}

async function importImageFromSource(
  source: RegistryImageSource,
  expectedBuildId?: string,
): Promise<ImportedImage> {
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-image-pull-"),
  );
  const archivePath = path.join(tmpRoot, "image.tar.gz");
  const extractDir = path.join(tmpRoot, "extract");

  try {
    await downloadArchive(source, archivePath);
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

    if (source.buildId && imported.buildId !== source.buildId) {
      throw new Error(
        `downloaded image buildId mismatch\n  expected: ${source.buildId}\n  got:      ${imported.buildId}\n  source:   ${source.url}`,
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

type RegistryRefSourceCandidate = {
  /** canonical image ref */
  reference: string;
  /** candidate architecture */
  arch: ImageArch;
  /** candidate source metadata */
  source: RegistryImageSource;
};

function resolveRegistrySourceForRef(
  registry: BuiltinImageRegistry,
  reference: string,
  arch?: ImageArch,
): {
  source: RegistryImageSource;
  requestedArch: ImageArch;
} {
  const parsedRef = parseImageRef(reference);
  const entries = registry.refs[parsedRef.canonical];
  if (!entries) {
    throw new Error(
      `image ref not found in builtin registry: ${parsedRef.canonical}`,
    );
  }

  const requestedArch = normalizeImageArch(arch) ?? defaultImageArch();
  const exact = entries[requestedArch];
  if (exact) {
    return { source: exact, requestedArch };
  }

  const available = Object.entries(entries).filter(
    (pair): pair is [ImageArch, RegistryImageSource] => {
      const [name, value] = pair;
      return normalizeImageArch(name) !== null && value !== undefined;
    },
  );

  if (available.length === 1) {
    const [, source] = available[0]!;
    return {
      source,
      requestedArch,
    };
  }

  const availableArchs = available.map(([name]) => name).join(", ") || "none";
  throw new Error(
    `image ref '${parsedRef.canonical}' has no registry source for ${requestedArch} (available: ${availableArchs})`,
  );
}

function collectRegistryRefSourceCandidates(
  registry: BuiltinImageRegistry,
): RegistryRefSourceCandidate[] {
  const out: RegistryRefSourceCandidate[] = [];
  for (const [reference, archMap] of Object.entries(registry.refs)) {
    for (const [archKey, source] of Object.entries(archMap)) {
      const arch = normalizeImageArch(archKey);
      if (!arch || !source) continue;
      out.push({
        reference,
        arch,
        source,
      });
    }
  }
  return out;
}

async function importBuildIdFromRegistryRefs(
  registry: BuiltinImageRegistry,
  buildId: string,
): Promise<ImportedImage> {
  const candidates = collectRegistryRefSourceCandidates(registry)
    .filter((candidate) => {
      return (
        candidate.source.buildId === undefined ||
        candidate.source.buildId === buildId
      );
    })
    .sort((a, b) => {
      const aScore = a.source.buildId === buildId ? 0 : 1;
      const bScore = b.source.buildId === buildId ? 0 : 1;
      return aScore - bScore;
    });

  const seenUrls = new Set<string>();
  let lastError: unknown = null;

  for (const candidate of candidates) {
    if (seenUrls.has(candidate.source.url)) continue;
    seenUrls.add(candidate.source.url);

    try {
      const imported = await importImageFromSource(candidate.source, buildId);
      setImageRef(candidate.reference, imported.buildId, candidate.arch);
      return imported;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw new Error(
      `image build id not found in builtin registry: ${buildId} (last error: ${lastError.message})`,
    );
  }

  throw new Error(`image build id not found in builtin registry: ${buildId}`);
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
    if (source) {
      await importImageFromSource({ ...source, buildId }, buildId);
      return resolveImageSelector(buildId, arch);
    }

    await importBuildIdFromRegistryRefs(registry, buildId);
    return resolveImageSelector(buildId, arch);
  }

  const parsedRef = parseImageRef(trimmed);
  const { source, requestedArch } = resolveRegistrySourceForRef(
    registry,
    parsedRef.canonical,
    arch,
  );

  const imported = await importImageFromSource(source);
  if (source === registry.refs[parsedRef.canonical]?.[requestedArch]) {
    if (imported.arch !== requestedArch) {
      throw new Error(
        `registry source for '${parsedRef.canonical}' (${requestedArch}) resolved to ${imported.arch}`,
      );
    }
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

export const __test = {
  parseImageRef,
  normalizeImageArch,
  isBuildId,
  normalizeImageBuildId,
  parseBuiltinRegistry,
};

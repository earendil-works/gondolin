import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type {
  BuildConfig,
  ContainerRuntime,
  OciPullPolicy,
  RootfsMode,
} from "./build/config.ts";

let cachedAssetVersion: string | null = null;

const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IMAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function resolveAssetVersion(): string {
  if (cachedAssetVersion) return cachedAssetVersion;

  const possiblePackageJsons = [
    path.resolve(import.meta.dirname, "..", "package.json"), // src/ (native ts runtime) -> host/package.json
    path.resolve(import.meta.dirname, "..", "..", "package.json"), // src/* (workspace) -> repo/package.json fallback
  ];

  for (const pkgPath of possiblePackageJsons) {
    try {
      if (!fs.existsSync(pkgPath)) continue;
      const raw = fs.readFileSync(pkgPath, "utf8");
      const pkg = JSON.parse(raw) as { version?: string };
      if (pkg.version) {
        cachedAssetVersion = `v${pkg.version}`;
        return cachedAssetVersion;
      }
    } catch {
      // ignore and fall through
    }
  }

  cachedAssetVersion = "v0.0.0";
  return cachedAssetVersion;
}

function cacheBaseDir(): string {
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

function getImageStoreDirectory(): string {
  return (
    process.env.GONDOLIN_IMAGE_STORE ??
    path.join(cacheBaseDir(), "gondolin", "images")
  );
}

function defaultGuestImageSelector(): string {
  return process.env.GONDOLIN_DEFAULT_IMAGE ?? "alpine-base:latest";
}

/**
 * Walk upwards from a starting directory until the filesystem root.
 */
function findUpwards<T>(
  startDir: string,
  probe: (dir: string) => T | null,
): T | null {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const found = probe(dir);
    if (found !== null) return found;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function tryFindRepoGuestAssetsDir(): string | null {
  const tryFindFrom = (anchor: string): string | null =>
    findUpwards(anchor, (dir) => {
      const candidate = path.join(dir, "guest", "image", "out");
      return assetsExist(candidate) ? candidate : null;
    });

  return tryFindFrom(process.cwd()) ?? tryFindFrom(import.meta.dirname);
}

function normalizeImageArch(
  value: string | undefined | null,
): "aarch64" | "x86_64" | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === "aarch64" || lower === "arm64") return "aarch64";
  if (lower === "x86_64" || lower === "amd64" || lower === "x64") {
    return "x86_64";
  }
  return null;
}

function hostDefaultImageArch(): "aarch64" | "x86_64" {
  return normalizeImageArch(process.arch) ?? "x86_64";
}

function parseImageRef(selector: string): { name: string; tag: string } | null {
  const trimmed = selector.trim();
  if (!trimmed) return null;

  const colon = trimmed.lastIndexOf(":");
  const hasExplicitTag = colon > 0 && colon < trimmed.length - 1;
  const name = hasExplicitTag ? trimmed.slice(0, colon) : trimmed;
  const tag = hasExplicitTag ? trimmed.slice(colon + 1) : "latest";

  if (!IMAGE_NAME_PATTERN.test(name)) return null;
  if (!IMAGE_TAG_PATTERN.test(tag)) return null;

  return { name, tag };
}

function resolveDefaultImageAssetDirFromStore(): string | null {
  const selector = defaultGuestImageSelector().trim();
  if (!selector) return null;

  const storeDir = getImageStoreDirectory();

  if (BUILD_ID_PATTERN.test(selector)) {
    const objectDir = path.join(storeDir, "objects", selector);
    return assetsExist(objectDir) ? objectDir : null;
  }

  const parsedRef = parseImageRef(selector);
  if (!parsedRef) return null;

  const archOrder: Array<"aarch64" | "x86_64"> = [
    hostDefaultImageArch(),
    hostDefaultImageArch() === "aarch64" ? "x86_64" : "aarch64",
  ];

  for (const arch of archOrder) {
    const linkPath = path.join(
      storeDir,
      "refs",
      parsedRef.name,
      parsedRef.tag,
      arch,
    );
    if (!fs.existsSync(linkPath)) continue;

    try {
      const target = fs.readlinkSync(linkPath);
      const objectDir = path.resolve(path.dirname(linkPath), target);
      if (assetsExist(objectDir)) {
        return objectDir;
      }
    } catch {
      // ignore malformed links and continue fallback order
    }
  }

  return null;
}

/**
 * Determine where to look for guest assets.
 *
 * Priority:
 * 1. GONDOLIN_GUEST_DIR environment variable (explicit override)
 * 2. Local repo checkout (searches upwards for guest/image/out)
 * 3. Local image store root (~/.cache/gondolin/images)
 */
function getAssetDir(): string {
  if (process.env.GONDOLIN_GUEST_DIR) {
    return process.env.GONDOLIN_GUEST_DIR;
  }

  const repoDir = tryFindRepoGuestAssetsDir();
  if (repoDir) return repoDir;

  const localDefaultDir = resolveDefaultImageAssetDirFromStore();
  if (localDefaultDir) return localDefaultDir;

  return getImageStoreDirectory();
}

export const MANIFEST_FILENAME = "manifest.json";

// Fixed namespace UUID used for deriving deterministic guest asset build IDs.
//
// This must never change, otherwise the same asset checksums would produce
// different IDs across versions.
const GUEST_ASSET_BUILD_ID_NAMESPACE = "7b6ed0c0-7e7f-4c2a-8b2d-0bf3d5be9d52";

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`invalid uuid: ${uuid}`);
  return Buffer.from(hex, "hex");
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}

function uuidv5(name: string, namespace: string): string {
  const ns = uuidToBytes(namespace);
  const hash = createHash("sha1");
  hash.update(ns);
  hash.update(Buffer.from(name, "utf8"));
  const digest = hash.digest();
  const bytes = Buffer.from(digest.subarray(0, 16));

  // Set version to 5 (0101)
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  // Set variant to RFC 4122 (10xx)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return bytesToUuid(bytes);
}

export type AssetBuildIdInput = {
  /** sha256 checksums (hex) */
  checksums: { kernel: string; initramfs: string; rootfs: string };
  /** guest architecture identifier (e.g. "aarch64") */
  arch?: string;
};

/**
 * Compute a deterministic guest asset build ID.
 *
 * This is intentionally derived from *content* (checksums), not host paths.
 */
export function computeAssetBuildId(input: AssetBuildIdInput): string {
  const arch = input.arch ?? "unknown";
  const name =
    "gondolin-asset-build" +
    "\n" +
    `kernel=${input.checksums.kernel}` +
    "\n" +
    `initramfs=${input.checksums.initramfs}` +
    "\n" +
    `rootfs=${input.checksums.rootfs}` +
    "\n" +
    `arch=${arch}`;

  return uuidv5(name, GUEST_ASSET_BUILD_ID_NAMESPACE);
}

/**
 * Manifest describing the built assets.
 */
export interface AssetManifest {
  /** manifest schema version */
  version: 1;

  /** deterministic content-derived build identifier (uuid) */
  buildId?: string;

  /** build configuration */
  config: BuildConfig;

  /** runtime defaults used by vm creation */
  runtimeDefaults?: {
    /** default rootfs write mode */
    rootfsMode?: RootfsMode;
  };

  /** resolved OCI source metadata captured during rootfs export */
  ociSource?: {
    /** requested OCI image reference from build config */
    image: string;
    /** OCI runtime used for export */
    runtime: ContainerRuntime;
    /** OCI platform used for export */
    platform: string;
    /** OCI pull policy used for export */
    pullPolicy: OciPullPolicy;
    /** resolved OCI digest (`sha256:...`) */
    digest?: string;
    /** resolved OCI image reference (`repo@sha256:...`) */
    reference?: string;
  };

  /** build timestamp (iso 8601) */
  buildTime: string;

  /** asset filenames */
  assets: {
    /** kernel image filename */
    kernel: string;
    /** initramfs filename */
    initramfs: string;
    /** rootfs filename */
    rootfs: string;
  };

  /** sha256 checksums (hex) */
  checksums: {
    /** kernel checksum */
    kernel: string;
    /** initramfs checksum */
    initramfs: string;
    /** rootfs checksum */
    rootfs: string;
  };
}

/**
 * Guest image asset paths.
 */
export interface GuestAssets {
  /** linux kernel path */
  kernelPath: string;
  /** compressed initramfs path */
  initrdPath: string;
  /** rootfs image path */
  rootfsPath: string;
}

/**
 * Load an asset manifest from a directory.
 */
export function loadAssetManifest(assetDir: string): AssetManifest | null {
  const manifestPath = path.join(assetDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(manifestPath, "utf8");
    const raw = JSON.parse(content) as any;

    if (!raw || typeof raw !== "object") {
      return null;
    }

    return raw as AssetManifest;
  } catch {
    return null;
  }
}

/**
 * Load guest assets from a custom directory.
 *
 * This is useful when you've built custom assets using `gondolin build`.
 * The directory should contain manifest.json or the default filenames
 * (vmlinuz-virt, initramfs.cpio.lz4, and rootfs.ext4).
 *
 * @param assetDir Path to the directory containing the assets
 * @returns Paths to the guest assets
 * @throws If any required assets are missing
 */
export function loadGuestAssets(assetDir: string): GuestAssets {
  const resolvedDir = path.resolve(assetDir);
  const manifest = loadAssetManifest(resolvedDir);
  const assetFiles = manifest?.assets ?? {
    kernel: "vmlinuz-virt",
    initramfs: "initramfs.cpio.lz4",
    rootfs: "rootfs.ext4",
  };

  const kernelPath = path.join(resolvedDir, assetFiles.kernel);
  const initrdPath = path.join(resolvedDir, assetFiles.initramfs);
  const rootfsPath = path.join(resolvedDir, assetFiles.rootfs);

  const missing: string[] = [];

  if (!fs.existsSync(kernelPath)) {
    missing.push(assetFiles.kernel);
  }
  if (!fs.existsSync(initrdPath)) {
    missing.push(assetFiles.initramfs);
  }
  if (!fs.existsSync(rootfsPath)) {
    missing.push(assetFiles.rootfs);
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing guest assets in ${resolvedDir}: ${missing.join(", ")}\n` +
        `Run 'gondolin build' to create custom assets, or ensure the directory contains all required files.`,
    );
  }

  return {
    kernelPath,
    initrdPath,
    rootfsPath,
  };
}

/**
 * Check if all guest assets are present in a directory.
 */
function assetsExist(dir: string): boolean {
  const manifest = loadAssetManifest(dir);
  const assetFiles = manifest?.assets ?? {
    kernel: "vmlinuz-virt",
    initramfs: "initramfs.cpio.lz4",
    rootfs: "rootfs.ext4",
  };

  return (
    fs.existsSync(path.join(dir, assetFiles.kernel)) &&
    fs.existsSync(path.join(dir, assetFiles.initramfs)) &&
    fs.existsSync(path.join(dir, assetFiles.rootfs))
  );
}

/**
 * Ensure guest assets are available.
 *
 * Resolution priority:
 * 1. GONDOLIN_GUEST_DIR environment override
 * 2. Local dev checkout (`guest/image/out`)
 * 3. Default image selector (`GONDOLIN_DEFAULT_IMAGE`, default `alpine-base:latest`)
 */
export async function ensureGuestAssets(): Promise<GuestAssets> {
  if (process.env.GONDOLIN_GUEST_DIR) {
    return loadGuestAssets(process.env.GONDOLIN_GUEST_DIR);
  }

  const repoDir = tryFindRepoGuestAssetsDir();
  if (repoDir) {
    return loadGuestAssets(repoDir);
  }

  const localDefaultDir = resolveDefaultImageAssetDirFromStore();
  if (localDefaultDir) {
    return loadGuestAssets(localDefaultDir);
  }

  const { ensureImageSelector } = await import("./images.ts");
  const resolved = await ensureImageSelector(defaultGuestImageSelector());
  return loadGuestAssets(resolved.assetDir);
}

/**
 * Get the current package-derived asset version string.
 */
export function getAssetVersion(): string {
  return resolveAssetVersion();
}

/**
 * Get the preferred local asset location root.
 */
export function getAssetDirectory(): string {
  return getAssetDir();
}

/**
 * Check if guest assets are available without downloading.
 */
export function hasGuestAssets(): boolean {
  if (process.env.GONDOLIN_GUEST_DIR) {
    return assetsExist(process.env.GONDOLIN_GUEST_DIR);
  }

  const repoDir = tryFindRepoGuestAssetsDir();
  if (repoDir) {
    return assetsExist(repoDir);
  }

  const localDefaultDir = resolveDefaultImageAssetDirFromStore();
  return localDefaultDir !== null && assetsExist(localDefaultDir);
}

/**
 * Resolve guest assets synchronously without downloading.
 */
export function resolveGuestAssetsSync(): GuestAssets | null {
  if (process.env.GONDOLIN_GUEST_DIR) {
    return loadGuestAssets(process.env.GONDOLIN_GUEST_DIR);
  }

  const repoDir = tryFindRepoGuestAssetsDir();
  if (repoDir && assetsExist(repoDir)) {
    return loadGuestAssets(repoDir);
  }

  const localDefaultDir = resolveDefaultImageAssetDirFromStore();
  if (!localDefaultDir || !assetsExist(localDefaultDir)) {
    return null;
  }

  return loadGuestAssets(localDefaultDir);
}

/** @internal */
export const __test = {
  resolveAssetVersion,
  getAssetDir,
  assetsExist,
  defaultGuestImageSelector,
  resolveDefaultImageAssetDirFromStore,
  resetAssetVersionCache: () => {
    cachedAssetVersion = null;
  },
};

import fs from "node:fs";
import path from "node:path";
import type {
  BuildConfig,
  ContainerRuntime,
  OciPullPolicy,
  RootfsMode,
} from "./build/config.ts";
import { normalizeArchitecture } from "./host/arch.ts";
import {
  getImageStoreDirectory,
  isImageBuildId,
  tryParseImageRef,
} from "./image-ref.ts";
import { isPathWithin } from "./utils/path.ts";
import { uuidv5 } from "./utils/uuid.ts";

let cachedAssetVersion: string | null = null;

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

function resolveDefaultImageAssetDirFromStore(): string | null {
  const selector = defaultGuestImageSelector().trim();
  if (!selector) return null;

  const storeDir = getImageStoreDirectory();

  if (isImageBuildId(selector)) {
    const objectDir = path.join(storeDir, "objects", selector);
    return assetsExist(objectDir) ? objectDir : null;
  }

  const parsedRef = tryParseImageRef(selector);
  if (!parsedRef) return null;

  const hostArch = normalizeArchitecture(process.arch) ?? "x86_64";
  const archOrder: Array<"aarch64" | "x86_64"> = [
    hostArch,
    hostArch === "aarch64" ? "x86_64" : "aarch64",
  ];

  const refsRoot = path.join(storeDir, "refs");

  for (const arch of archOrder) {
    const linkPath = path.join(refsRoot, parsedRef.name, parsedRef.tag, arch);
    if (!isPathWithin(refsRoot, linkPath) || !fs.existsSync(linkPath)) {
      continue;
    }

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

export type AssetBuildIdInput = {
  /** sha256 checksums (hex) */
  checksums: {
    kernel: string;
    initramfs: string;
    rootfs: string;
    krunKernel?: string;
    krunInitrd?: string;
  };
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

  const parts = [
    "gondolin-asset-build",
    `kernel=${input.checksums.kernel}`,
    `initramfs=${input.checksums.initramfs}`,
    `rootfs=${input.checksums.rootfs}`,
  ];

  if (input.checksums.krunKernel !== undefined) {
    parts.push(`krunKernel=${input.checksums.krunKernel}`);
  }
  if (input.checksums.krunInitrd !== undefined) {
    parts.push(`krunInitrd=${input.checksums.krunInitrd}`);
  }

  parts.push(`arch=${arch}`);

  return uuidv5(parts.join("\n"), GUEST_ASSET_BUILD_ID_NAMESPACE);
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
    /** krun-compatible kernel image filename */
    krunKernel?: string;
    /** krun initrd image filename */
    krunInitrd?: string;
  };

  /** sha256 checksums (hex) */
  checksums: {
    /** kernel checksum */
    kernel: string;
    /** initramfs checksum */
    initramfs: string;
    /** rootfs checksum */
    rootfs: string;
    /** krun-compatible kernel checksum */
    krunKernel?: string;
    /** krun initrd checksum */
    krunInitrd?: string;
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
 * Return the directory containing all guest assets, or `null` if they are
 * missing or split across directories.
 *
 * @internal
 */
export function findCommonAssetDir(
  assets: Partial<GuestAssets>,
): string | null {
  const kernelDir = assets.kernelPath ? path.dirname(assets.kernelPath) : null;
  const initrdDir = assets.initrdPath ? path.dirname(assets.initrdPath) : null;
  const rootfsDir = assets.rootfsPath ? path.dirname(assets.rootfsPath) : null;

  if (!kernelDir || !initrdDir || !rootfsDir) return null;
  if (kernelDir !== initrdDir || kernelDir !== rootfsDir) return null;
  return kernelDir;
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

  if (assetFiles.krunKernel) {
    const krunKernelPath = path.join(resolvedDir, assetFiles.krunKernel);
    if (!fs.existsSync(krunKernelPath)) {
      missing.push(assetFiles.krunKernel);
    }
  }

  if (assetFiles.krunInitrd) {
    const krunInitrdPath = path.join(resolvedDir, assetFiles.krunInitrd);
    if (!fs.existsSync(krunInitrdPath)) {
      missing.push(assetFiles.krunInitrd);
    }
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

  const required =
    fs.existsSync(path.join(dir, assetFiles.kernel)) &&
    fs.existsSync(path.join(dir, assetFiles.initramfs)) &&
    fs.existsSync(path.join(dir, assetFiles.rootfs));

  if (!required) {
    return false;
  }

  if (
    assetFiles.krunKernel &&
    !fs.existsSync(path.join(dir, assetFiles.krunKernel))
  ) {
    return false;
  }

  if (
    assetFiles.krunInitrd &&
    !fs.existsSync(path.join(dir, assetFiles.krunInitrd))
  ) {
    return false;
  }

  return true;
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

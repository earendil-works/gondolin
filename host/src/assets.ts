import fs from "fs";
import path from "path";
import os from "os";
import { createWriteStream } from "fs";
import child_process from "child_process";
import { createHash } from "crypto";
import type {
  BuildConfig,
  ContainerRuntime,
  OciPullPolicy,
  RootfsMode,
} from "./build/config.ts";

const GITHUB_ORG = "earendil-works";
const GITHUB_REPO = "gondolin";

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

/**
 * Get the platform-specific asset bundle name.
 * We build separate bundles for arm64 and x64.
 */
function getAssetBundleName(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `gondolin-guest-${arch}.tar.gz`;
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

/**
 * Determine where to look for / store guest assets.
 *
 * Priority:
 * 1. GONDOLIN_GUEST_DIR environment variable (explicit override)
 * 2. Local repo checkout (searches upwards for guest/image/out)
 * 3. User cache directory (~/.cache/gondolin/<version>)
 */
function getAssetDir(): string {
  // Explicit override
  if (process.env.GONDOLIN_GUEST_DIR) {
    return process.env.GONDOLIN_GUEST_DIR;
  }

  const tryFindRepoAssetsFrom = (anchor: string): string | null =>
    findUpwards(anchor, (dir) => {
      const candidate = path.join(dir, "guest", "image", "out");
      return assetsExist(candidate) ? candidate : null;
    });

  // Prefer whatever directory the caller is operating in, but also check the
  // module location (works even when invoked from a different cwd).
  const repoDir =
    tryFindRepoAssetsFrom(process.cwd()) ??
    tryFindRepoAssetsFrom(import.meta.dirname);
  if (repoDir) return repoDir;

  // User cache directory
  const cacheBase =
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(cacheBase, "gondolin", resolveAssetVersion());
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
 * Download and extract the guest image bundle from GitHub releases.
 */
async function downloadAndExtract(assetDir: string): Promise<void> {
  const bundleName = getAssetBundleName();
  const assetVersion = resolveAssetVersion();
  const url = `https://github.com/${GITHUB_ORG}/${GITHUB_REPO}/releases/download/${assetVersion}/${bundleName}`;

  fs.mkdirSync(assetDir, { recursive: true });

  const tempFile = path.join(assetDir, bundleName);

  try {
    process.stderr.write(
      `Downloading gondolin guest image (${assetVersion})...\n`,
    );
    process.stderr.write(`  URL: ${url}\n`);

    const response = await fetch(url, {
      headers: {
        "User-Agent": `gondolin/${assetVersion}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to download guest image: ${response.status} ${response.statusText}\n` +
          `URL: ${url}\n` +
          `Make sure the release exists and the asset is uploaded.`,
      );
    }

    const contentLength = response.headers.get("content-length");
    const totalBytes = contentLength ? parseInt(contentLength, 10) : null;

    // Stream to temp file with progress
    const fileStream = createWriteStream(tempFile);

    if (response.body) {
      let downloadedBytes = 0;
      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        fileStream.write(Buffer.from(value));
        downloadedBytes += value.length;

        if (totalBytes) {
          const percent = ((downloadedBytes / totalBytes) * 100).toFixed(1);
          const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
          const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
          process.stderr.write(
            `\r  Progress: ${mb}/${totalMb} MB (${percent}%)`,
          );
        }
      }

      process.stderr.write("\n");
    }

    await new Promise<void>((resolve, reject) => {
      fileStream.end((err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Extract
    process.stderr.write(`  Extracting to ${assetDir}...\n`);
    child_process.execSync(`tar -xzf "${bundleName}"`, {
      cwd: assetDir,
      stdio: "pipe",
    });

    // Verify extraction
    if (!assetsExist(assetDir)) {
      throw new Error(
        "Extraction completed but expected files are missing. " +
          "The archive may be corrupted or have an unexpected structure.",
      );
    }

    process.stderr.write(`  Guest image installed successfully.\n`);
  } finally {
    // Clean up temp file
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

/**
 * Ensure guest assets are available, downloading them if necessary.
 *
 * This function checks for the guest image files (kernel, initramfs, rootfs)
 * and downloads them from GitHub releases if they're not present locally.
 *
 * Asset location priority:
 * 1. GONDOLIN_GUEST_DIR environment variable (explicit override, no download)
 * 2. Local development checkout (../guest/image/out)
 * 3. User cache (~/.cache/gondolin/<version>)
 *
 * @returns Paths to the guest assets
 * @throws If download fails or assets cannot be verified
 * @throws If GONDOLIN_GUEST_DIR is set but assets are missing
 */
export async function ensureGuestAssets(): Promise<GuestAssets> {
  const assetDir = getAssetDir();

  // If GONDOLIN_GUEST_DIR is explicitly set, don't download - require assets to exist
  if (process.env.GONDOLIN_GUEST_DIR) {
    return loadGuestAssets(assetDir);
  }

  // Check if already present (repo checkout or cache)
  if (!assetsExist(assetDir)) {
    await downloadAndExtract(assetDir);
  }

  return loadGuestAssets(assetDir);
}

/**
 * Get the current asset version string.
 */
export function getAssetVersion(): string {
  return resolveAssetVersion();
}

/**
 * Get the asset directory path without ensuring assets exist.
 * Useful for checking where assets would be stored.
 */
export function getAssetDirectory(): string {
  return getAssetDir();
}

/**
 * Check if guest assets are available without downloading.
 */
export function hasGuestAssets(): boolean {
  return assetsExist(getAssetDir());
}

/**
 * Resolve guest assets synchronously without downloading.
 *
 * Resolution priority:
 * 1. GONDOLIN_GUEST_DIR (explicit override)
 * 2. Repo checkout (guest/image/out)
 * 3. Cache directory (if already populated)
 */
export function resolveGuestAssetsSync(): GuestAssets | null {
  // Explicit override must be respected (and should error if broken)
  if (process.env.GONDOLIN_GUEST_DIR) {
    return loadGuestAssets(process.env.GONDOLIN_GUEST_DIR);
  }

  // getAssetDir() picks repo assets when available, otherwise the cache location
  const dir = getAssetDir();
  if (!assetsExist(dir)) return null;
  return loadGuestAssets(dir);
}

/** @internal */
// Expose internal helpers for unit tests. Not part of the public API.
export const __test = {
  resolveAssetVersion,
  getAssetBundleName,
  getAssetDir,
  assetsExist,
  downloadAndExtract,
  resetAssetVersionCache: () => {
    cachedAssetVersion = null;
  },
};

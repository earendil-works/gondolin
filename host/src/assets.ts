import fs from "fs";
import path from "path";
import os from "os";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { execSync } from "child_process";
import { createHash } from "crypto";
import type { BuildConfig } from "./build-config";

const GITHUB_ORG = "earendil-works";
const GITHUB_REPO = "gondolin";

let cachedAssetVersion: string | null = null;

function resolveAssetVersion(): string {
  if (cachedAssetVersion) return cachedAssetVersion;

  const possiblePackageJsons = [
    path.resolve(__dirname, "..", "package.json"), // src/ (tsx/dev) -> host/package.json
    path.resolve(__dirname, "..", "..", "package.json"), // dist/src (npm) -> package/package.json
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
 * Determine where to look for / store guest assets.
 *
 * Priority:
 * 1. GONDOLIN_GUEST_DIR environment variable (explicit override)
 * 2. Local development checkout (guest/image/out relative to package)
 * 3. User cache directory (~/.cache/gondolin/<version>)
 */
function getAssetDir(): string {
  // Explicit override
  if (process.env.GONDOLIN_GUEST_DIR) {
    return process.env.GONDOLIN_GUEST_DIR;
  }

  // Check for local development (repo checkout)
  // Handle both source (src/) and compiled (dist/src/) paths
  // We need to find the repo root where guest/ lives
  const possibleRepoRoots = [
    path.resolve(__dirname, "..", ".."),       // from src/: -> host/ -> gondolin/
    path.resolve(__dirname, "..", "..", ".."), // from dist/src/: -> dist/ -> host/ -> gondolin/
  ];
  
  for (const repoRoot of possibleRepoRoots) {
    const devPath = path.join(repoRoot, "guest", "image", "out");
    if (fs.existsSync(path.join(devPath, "vmlinuz-virt"))) {
      return devPath;
    }
  }

  // User cache directory
  const cacheBase =
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(cacheBase, "gondolin", resolveAssetVersion());
}

export const MANIFEST_FILENAME = "manifest.json";

/**
 * Manifest describing the built assets.
 */
export interface AssetManifest {
  /** Manifest version for future compatibility */
  version: 1;

  /** Build configuration used */
  config: BuildConfig;

  /** Timestamp of the build */
  buildTime: string;

  /** Asset file information */
  assets: {
    /** Kernel image filename */
    kernel: string;
    /** Initramfs filename */
    initramfs: string;
    /** Root filesystem filename */
    rootfs: string;
  };

  /** Checksums for verification */
  checksums: {
    kernel: string;
    initramfs: string;
    rootfs: string;
  };
}

/**
 * Guest image asset paths.
 */
export interface GuestAssets {
  /** Path to the Linux kernel (vmlinuz-virt) */
  kernelPath: string;
  /** Path to the compressed initramfs (initramfs.cpio.lz4) */
  initrdPath: string;
  /** Path to the root filesystem image (rootfs.ext4) */
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
    return JSON.parse(content) as AssetManifest;
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
        `Run 'gondolin build' to create custom assets, or ensure the directory contains all required files.`
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
  return (
    fs.existsSync(path.join(dir, "vmlinuz-virt")) &&
    fs.existsSync(path.join(dir, "initramfs.cpio.lz4")) &&
    fs.existsSync(path.join(dir, "rootfs.ext4"))
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
    process.stderr.write(`Downloading gondolin guest image (${assetVersion})...\n`);
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
          `Make sure the release exists and the asset is uploaded.`
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
          process.stderr.write(`\r  Progress: ${mb}/${totalMb} MB (${percent}%)`);
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
    execSync(`tar -xzf "${bundleName}"`, { cwd: assetDir, stdio: "pipe" });

    // Verify extraction
    if (!assetsExist(assetDir)) {
      throw new Error(
        "Extraction completed but expected files are missing. " +
          "The archive may be corrupted or have an unexpected structure."
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

  // Check if already present
  if (!assetsExist(assetDir)) {
    await downloadAndExtract(assetDir);
  }

  return {
    kernelPath: path.join(assetDir, "vmlinuz-virt"),
    initrdPath: path.join(assetDir, "initramfs.cpio.lz4"),
    rootfsPath: path.join(assetDir, "rootfs.ext4"),
  };
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

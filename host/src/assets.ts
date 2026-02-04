import fs from "fs";
import path from "path";
import os from "os";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { execSync } from "child_process";
import { createHash } from "crypto";

// This should match the package version when releasing
const ASSET_VERSION = "v0.1.0";
const GITHUB_ORG = "earendil-works";
const GITHUB_REPO = "gondolin";

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
  const possibleRoots = [
    path.resolve(__dirname, "..", ".."),      // from src/: host/ -> ../guest
    path.resolve(__dirname, "..", "..", ".."), // from dist/src/: host/ -> ../guest
  ];
  
  for (const root of possibleRoots) {
    const devPath = path.join(root, "..", "guest", "image", "out");
    if (fs.existsSync(path.join(devPath, "vmlinuz-virt"))) {
      return devPath;
    }
  }

  // User cache directory
  const cacheBase =
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(cacheBase, "gondolin", ASSET_VERSION);
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
  const url = `https://github.com/${GITHUB_ORG}/${GITHUB_REPO}/releases/download/${ASSET_VERSION}/${bundleName}`;

  fs.mkdirSync(assetDir, { recursive: true });

  const tempFile = path.join(assetDir, bundleName);

  try {
    process.stderr.write(`Downloading gondolin guest image (${ASSET_VERSION})...\n`);
    process.stderr.write(`  URL: ${url}\n`);

    const response = await fetch(url, {
      headers: {
        "User-Agent": `gondolin/${ASSET_VERSION}`,
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
 * 1. GONDOLIN_GUEST_DIR environment variable
 * 2. Local development checkout (../guest/image/out)
 * 3. User cache (~/.cache/gondolin/<version>)
 *
 * @returns Paths to the guest assets
 * @throws If download fails or assets cannot be verified
 */
export async function ensureGuestAssets(): Promise<GuestAssets> {
  const assetDir = getAssetDir();

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
  return ASSET_VERSION;
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

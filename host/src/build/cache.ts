import fs from "fs";
import path from "path";

import { parseApkIndex, refreshPackageIndexes } from "../alpine/packages.ts";
import { gondolinCacheDir } from "../cache.ts";
import type { Architecture } from "./config.ts";

const ALPINE_CACHE_ENTRY_PATTERNS = [
  /^alpine-minirootfs-.*\.tar\.gz$/,
  /^APKINDEX-/,
  /^(?:aarch64|x86_64)-.*\.apk$/,
] as const;

export function alpineBuildCacheDirectory(): string {
  return gondolinCacheDir("build");
}

function isAlpineCacheEntry(name: string): boolean {
  return ALPINE_CACHE_ENTRY_PATTERNS.some((pattern) => pattern.test(name));
}

export function inspectAlpineBuildCache(
  cacheDir = alpineBuildCacheDirectory(),
): {
  cacheDir: string;
  minirootfs: Array<{
    version: string;
    arch: Architecture;
    modifiedAt: string;
  }>;
  indexes: Array<{
    file: string;
    modifiedAt: string;
    kernelPackages: Array<{ name: string; version: string }>;
  }>;
  packageArchiveCount: number;
  sizeBytes: number;
} {
  const result = {
    cacheDir,
    minirootfs: [] as Array<{
      version: string;
      arch: Architecture;
      modifiedAt: string;
    }>,
    indexes: [] as Array<{
      file: string;
      modifiedAt: string;
      kernelPackages: Array<{ name: string; version: string }>;
    }>,
    packageArchiveCount: 0,
    sizeBytes: 0,
  };

  if (!fs.existsSync(cacheDir)) return result;

  for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() || !isAlpineCacheEntry(entry.name)) continue;

    const entryPath = path.join(cacheDir, entry.name);
    const stat = fs.statSync(entryPath);
    result.sizeBytes += stat.size;

    const minirootfsMatch = entry.name.match(
      /^alpine-minirootfs-(.+)-(aarch64|x86_64)\.tar\.gz$/,
    );
    if (minirootfsMatch) {
      result.minirootfs.push({
        version: minirootfsMatch[1]!,
        arch: minirootfsMatch[2]! as Architecture,
        modifiedAt: stat.mtime.toISOString(),
      });
      continue;
    }

    if (entry.name.startsWith("APKINDEX-") && !entry.name.endsWith(".tar.gz")) {
      const packages = parseApkIndex(fs.readFileSync(entryPath, "utf8"));
      result.indexes.push({
        file: entry.name,
        modifiedAt: stat.mtime.toISOString(),
        kernelPackages: packages
          .filter((pkg) => /^Linux .* kernel$/.test(pkg.T ?? ""))
          .map((pkg) => ({ name: pkg.P, version: pkg.V }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
      continue;
    }

    if (entry.name.endsWith(".apk")) {
      result.packageArchiveCount += 1;
    }
  }

  result.minirootfs.sort((a, b) =>
    `${a.version}-${a.arch}`.localeCompare(`${b.version}-${b.arch}`),
  );
  result.indexes.sort((a, b) => a.file.localeCompare(b.file));
  return result;
}

export function removeAlpineBuildCache(
  cacheDir = alpineBuildCacheDirectory(),
): { removedEntries: number; removedBytes: number } {
  let removedEntries = 0;
  let removedBytes = 0;
  if (!fs.existsSync(cacheDir)) return { removedEntries, removedBytes };

  for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() || !isAlpineCacheEntry(entry.name)) continue;
    const entryPath = path.join(cacheDir, entry.name);
    removedBytes += fs.statSync(entryPath).size;
    fs.rmSync(entryPath, { force: true });
    removedEntries += 1;
  }

  return { removedEntries, removedBytes };
}

export async function updateAlpineBuildCache(options: {
  arch: Architecture;
  version: string;
  branch?: string;
  mirror?: string;
  cacheDir?: string;
}): Promise<string[]> {
  const branch =
    options.branch ?? `v${options.version.split(".").slice(0, 2).join(".")}`;
  const mirror = (
    options.mirror ?? "https://dl-cdn.alpinelinux.org/alpine"
  ).replace(/\/+$/, "");
  const repos = ["main", "community"].map(
    (repository) => `${mirror}/${branch}/${repository}`,
  );

  return await refreshPackageIndexes(
    repos,
    options.arch,
    options.cacheDir ?? alpineBuildCacheDirectory(),
  );
}

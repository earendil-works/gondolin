import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { extractTarGz } from "../alpine/tar.ts";
import {
  fetchCachedJsonRegistry,
  normalizeSha256,
  parseKeyedRegistry,
  parseRegistryUrl,
  resolveKeyedRegistryRef,
} from "../registry.ts";
import { cacheBaseDir, downloadToBuffer } from "./helpers.ts";

const TRUFFLEHOG_REGISTRY_SCHEMA = 1 as const;
const DEFAULT_TRUFFLEHOG_REF = "trufflehog:3.95.3";
const DEFAULT_TRUFFLEHOG_REGISTRY_URL =
  "https://raw.githubusercontent.com/earendil-works/gondolin/main/builtin-trufflehog-registry.json";

type SupportedPlatform =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64";

type TrufflehogRegistryBuild = {
  /** tool version */
  version: string;
  /** target platform */
  platform: SupportedPlatform;
  /** binary archive url */
  url: string;
  /** binary archive checksum */
  sha256?: string;
  /** source archive url */
  sourceUrl?: string;
  /** source archive checksum */
  sourceSha256?: string;
};

type BuiltinTrufflehogRegistry = {
  /** registry schema version */
  schema: typeof TRUFFLEHOG_REGISTRY_SCHEMA;
  /** named refs mapped by platform to build ids */
  refs: Record<string, Partial<Record<SupportedPlatform, string>>>;
  /** build-id keyed sources */
  builds: Record<string, TrufflehogRegistryBuild>;
};

export interface EnsureTrufflehogOptions {
  /** explicit cache/store directory */
  storeDir?: string;
  /** optional logger */
  log?: (msg: string) => void;
}

export interface TrufflehogStatus {
  /** helper ref */
  ref: string;
  /** helper version */
  version: string;
  /** resolved platform key */
  platform: SupportedPlatform;
  /** managed install path */
  managedPath: string;
  /** whether a managed binary already exists */
  installed: boolean;
  /** download url for this platform */
  downloadUrl: string;
  /** build id */
  buildId: string;
}

export function getTrufflehogStoreDirectory(): string {
  return path.join(cacheBaseDir(), "gondolin", "tools", "trufflehog");
}

function trufflehogRegistryUrl(value?: string): string {
  const explicit = value?.trim();
  if (explicit) return explicit;
  return DEFAULT_TRUFFLEHOG_REGISTRY_URL;
}

function objectDir(storeDir: string, buildId: string): string {
  return path.join(storeDir, "objects", buildId);
}

function installedBinaryPath(storeDir: string, buildId: string): string {
  return path.join(objectDir(storeDir, buildId), "bin", "trufflehog");
}

function installedSourcePath(storeDir: string, buildId: string): string {
  return path.join(objectDir(storeDir, buildId), "source");
}

function normalizeSupportedPlatform(value: string): SupportedPlatform | null {
  if (value === "darwin-arm64") return value;
  if (value === "darwin-x64") return value;
  if (value === "linux-arm64") return value;
  if (value === "linux-x64") return value;
  return null;
}

function resolveSupportedPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): SupportedPlatform {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && (arch === "x64" || arch === "amd64")) {
    return "darwin-x64";
  }
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "linux" && (arch === "x64" || arch === "amd64")) {
    return "linux-x64";
  }
  throw new Error(
    `trufflehog helper is not available for this platform: ${platform}/${arch}`,
  );
}

function parseRef(reference: string): string {
  const trimmed = reference.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(trimmed)
  ) {
    throw new Error(`invalid trufflehog ref: ${reference}`);
  }
  return trimmed;
}

function parseRegistryBuild(
  raw: unknown,
  where: string,
  baseUrl: URL,
): TrufflehogRegistryBuild {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`invalid ${where}: expected object`);
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.version !== "string" || !rec.version) {
    throw new Error(`invalid ${where}.version: expected string`);
  }
  if (typeof rec.platform !== "string") {
    throw new Error(`invalid ${where}.platform: expected string`);
  }
  const platform = normalizeSupportedPlatform(rec.platform);
  if (!platform) {
    throw new Error(`invalid ${where}.platform: ${String(rec.platform)}`);
  }
  const build: TrufflehogRegistryBuild = {
    version: rec.version,
    platform,
    url: parseRegistryUrl(rec.url, `${where}.url`, baseUrl),
  };

  if (rec.sha256 !== undefined) {
    build.sha256 = normalizeSha256(rec.sha256, `${where}.sha256`);
  }
  if (rec.sourceUrl !== undefined) {
    build.sourceUrl = parseRegistryUrl(
      rec.sourceUrl,
      `${where}.sourceUrl`,
      baseUrl,
    );
  }
  if (rec.sourceSha256 !== undefined) {
    build.sourceSha256 = normalizeSha256(
      rec.sourceSha256,
      `${where}.sourceSha256`,
    );
  }

  return build;
}

function parseBuiltinTrufflehogRegistry(
  raw: unknown,
  sourceUrl: string,
): BuiltinTrufflehogRegistry {
  const { refs, builds } = parseKeyedRegistry(raw, sourceUrl, {
    label: "builtin trufflehog registry",
    schema: TRUFFLEHOG_REGISTRY_SCHEMA,
    keyName: "platform",
    normalizeKey: normalizeSupportedPlatform,
    normalizeBuildId: (buildId) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(buildId)) {
        throw new Error(`invalid builtin trufflehog build id: ${buildId}`);
      }
      return buildId;
    },
    canonicalRef: parseRef,
    parseBuild: parseRegistryBuild,
    buildKey: (build) => build.platform,
  });
  return { schema: TRUFFLEHOG_REGISTRY_SCHEMA, refs, builds };
}

async function fetchBuiltinTrufflehogRegistry(options: {
  registryUrl?: string;
  storeDir?: string;
}): Promise<BuiltinTrufflehogRegistry> {
  const storeDir = options.storeDir ?? getTrufflehogStoreDirectory();
  const url = trufflehogRegistryUrl(options.registryUrl);
  return await fetchCachedJsonRegistry({
    url,
    storeDir,
    cacheFileName: "builtin-trufflehog-registry-cache.json",
    userAgent: "gondolin-trufflehog-registry",
    parse: parseBuiltinTrufflehogRegistry,
    label: "builtin trufflehog registry",
  });
}

async function resolveManagedBuild(
  storeDir: string,
  platform: SupportedPlatform,
): Promise<{ ref: string; buildId: string; build: TrufflehogRegistryBuild }> {
  const registry = await fetchBuiltinTrufflehogRegistry({ storeDir });
  const ref = parseRef(DEFAULT_TRUFFLEHOG_REF);
  const { buildId, build } = resolveKeyedRegistryRef(registry, ref, platform, {
    label: "trufflehog",
  });
  return { ref, buildId, build };
}

function findBinary(rootDir: string): string | null {
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === "trufflehog") {
        return fullPath;
      }
    }
  }
  return null;
}

async function installManagedBinary(
  storeDir: string,
  buildId: string,
  build: TrufflehogRegistryBuild,
  log?: (msg: string) => void,
): Promise<string> {
  const targetPath = installedBinaryPath(storeDir, buildId);
  if (fs.existsSync(targetPath)) return targetPath;

  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-trufflehog-"),
  );
  const archivePath = path.join(tmpRoot, "trufflehog.tar.gz");
  const extractDir = path.join(tmpRoot, "extract");
  const installDir = path.dirname(targetPath);

  try {
    log?.(`Downloading trufflehog ${build.version} for ${build.platform}`);
    fs.writeFileSync(
      archivePath,
      await downloadToBuffer(
        build.url,
        build.sha256,
        "gondolin-trufflehog-fetch",
      ),
    );
    fs.mkdirSync(extractDir, { recursive: true });
    await extractTarGz(archivePath, extractDir);

    const binary = findBinary(extractDir);
    if (!binary) {
      throw new Error(
        "downloaded trufflehog archive did not contain a trufflehog binary",
      );
    }

    fs.mkdirSync(path.dirname(installDir), { recursive: true });
    if (!fs.existsSync(targetPath)) {
      const tmpInstallDir = `${installDir}.tmp-${randomUUID().slice(0, 8)}`;
      try {
        fs.mkdirSync(tmpInstallDir, { recursive: true });
        fs.copyFileSync(binary, path.join(tmpInstallDir, "trufflehog"));
        fs.chmodSync(path.join(tmpInstallDir, "trufflehog"), 0o755);
        fs.renameSync(tmpInstallDir, installDir);
      } catch (error) {
        fs.rmSync(tmpInstallDir, { recursive: true, force: true });
        if (!fs.existsSync(targetPath)) throw error;
      }
    }

    fs.chmodSync(targetPath, 0o755);
    return targetPath;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export async function ensureTrufflehogSourceDir(
  options: Omit<EnsureTrufflehogOptions, "binaryPath"> = {},
): Promise<string> {
  const storeDir = options.storeDir ?? getTrufflehogStoreDirectory();
  const platform = resolveSupportedPlatform();
  const { buildId, build } = await resolveManagedBuild(storeDir, platform);
  const targetDir = installedSourcePath(storeDir, buildId);
  if (fs.existsSync(path.join(targetDir, "pkg", "detectors"))) {
    return targetDir;
  }
  if (!build.sourceUrl) {
    throw new Error(`trufflehog build ${buildId} does not provide sourceUrl`);
  }

  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-trufflehog-src-"),
  );
  const archivePath = path.join(tmpRoot, "trufflehog-source.tar.gz");
  const extractDir = path.join(tmpRoot, "extract");

  try {
    options.log?.(`Downloading trufflehog source ${build.version}`);
    fs.writeFileSync(
      archivePath,
      await downloadToBuffer(
        build.sourceUrl,
        build.sourceSha256,
        "gondolin-trufflehog-source-fetch",
      ),
    );
    fs.mkdirSync(extractDir, { recursive: true });
    await extractTarGz(archivePath, extractDir);

    const extractedRoot = fs
      .readdirSync(extractDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(extractDir, entry.name))
      .find((dir) => fs.existsSync(path.join(dir, "pkg", "detectors")));
    if (!extractedRoot) {
      throw new Error(
        "downloaded trufflehog source archive did not contain pkg/detectors",
      );
    }

    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    if (!fs.existsSync(targetDir)) {
      const tmpInstallDir = `${targetDir}.tmp-${randomUUID().slice(0, 8)}`;
      try {
        fs.cpSync(extractedRoot, tmpInstallDir, { recursive: true });
        fs.renameSync(tmpInstallDir, targetDir);
      } catch (error) {
        fs.rmSync(tmpInstallDir, { recursive: true, force: true });
        if (!fs.existsSync(targetDir)) throw error;
      }
    }

    return targetDir;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export async function ensureTrufflehogBinary(
  options: EnsureTrufflehogOptions = {},
): Promise<string> {
  const storeDir = options.storeDir ?? getTrufflehogStoreDirectory();
  const platform = resolveSupportedPlatform();
  const { buildId, build } = await resolveManagedBuild(storeDir, platform);
  return await installManagedBinary(storeDir, buildId, build, options.log);
}

export async function getTrufflehogStatus(
  options: Omit<EnsureTrufflehogOptions, "log"> = {},
): Promise<TrufflehogStatus> {
  const storeDir = options.storeDir ?? getTrufflehogStoreDirectory();
  const platform = resolveSupportedPlatform();
  const { ref, buildId, build } = await resolveManagedBuild(storeDir, platform);
  const managedPath = installedBinaryPath(storeDir, buildId);
  return {
    ref,
    version: build.version,
    platform,
    managedPath,
    installed: fs.existsSync(managedPath),
    downloadUrl: build.url,
    buildId,
  };
}

export const __test = {
  resolveSupportedPlatform,
  installedBinaryPath,
  installedSourcePath,
  parseBuiltinTrufflehogRegistry,
};

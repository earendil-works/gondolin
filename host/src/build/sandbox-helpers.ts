import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractTarGz } from "../alpine/tar.ts";
import { normalizeArchitecture } from "../host/arch.ts";
import {
  fetchCachedJsonRegistry,
  normalizeSha256,
  parseKeyedRegistry,
  parseRegistryUrl,
  resolveKeyedRegistryRef,
} from "../registry.ts";
import { digestToUuidV5 } from "../utils/uuid.ts";
import type { Architecture } from "./config.ts";
import { cacheBaseDir, computeFileHash, downloadToBuffer } from "./helpers.ts";

const SANDBOX_HELPER_REGISTRY_SCHEMA = 1 as const;
const SANDBOX_HELPER_MANIFEST_SCHEMA = 1 as const;
const SANDBOX_HELPER_KIND = "gondolin-sandbox-helpers" as const;
const DEFAULT_SANDBOX_HELPER_REGISTRY_URL =
  "https://raw.githubusercontent.com/earendil-works/gondolin/main/builtin-sandbox-helper-registry.json";

const HELPER_BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HELPER_REF_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const HELPER_REF_NAME_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HELPER_REF_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export const SANDBOX_HELPER_BINARY_NAMES = [
  "sandboxd",
  "sandboxfs",
  "sandboxssh",
  "sandboxingress",
] as const;

export type SandboxHelperBinaryName =
  (typeof SANDBOX_HELPER_BINARY_NAMES)[number];

export type SandboxHelperChecksums = Record<SandboxHelperBinaryName, string>;

export interface SandboxHelperManifest {
  /** manifest schema version */
  schema: typeof SANDBOX_HELPER_MANIFEST_SCHEMA;
  /** manifest kind marker */
  kind: typeof SANDBOX_HELPER_KIND;
  /** compatible gondolin package version */
  gondolinVersion: string;
  /** source git ref used for the build */
  sourceRef?: string;
  /** guest architecture */
  arch: Architecture;
  /** Zig target triple */
  target?: string;
  /** Zig compiler version */
  zigVersion?: string;
  /** binary checksums (`sha256` hex) */
  checksums: SandboxHelperChecksums;
}

export interface SandboxHelperBinaryPaths {
  /** path to `sandboxd` executable */
  sandboxdPath: string;
  /** path to `sandboxfs` executable */
  sandboxfsPath: string;
  /** path to `sandboxssh` executable */
  sandboxsshPath: string;
  /** path to `sandboxingress` executable */
  sandboxingressPath: string;
}

export interface ResolvedSandboxHelpers {
  /** helper source location */
  source: "directory" | "cache" | "download";
  /** helper object build id */
  buildId?: string;
  /** helper architecture */
  arch: Architecture;
  /** helper manifest when present */
  manifest?: SandboxHelperManifest;
  /** resolved executable paths */
  paths: SandboxHelperBinaryPaths;
}

export interface ResolveSandboxHelperOptions {
  /** target guest architecture */
  arch: Architecture;
  /** compatible gondolin package version */
  gondolinVersion?: string;
  /** helper registry ref (`name:tag`) */
  ref?: string;
  /** explicit helper directory */
  helpersDir?: string;
  /** helper registry URL */
  registryUrl?: string;
  /** helper cache/store directory */
  storeDir?: string;
  /** optional progress logger */
  log?: (msg: string) => void;
}

export interface SandboxHelperBuildIdInput {
  /** target guest architecture */
  arch: Architecture;
  /** binary checksums (`sha256` hex) */
  checksums: SandboxHelperChecksums;
}

type ParsedHelperRef = {
  /** helper ref name */
  name: string;
  /** helper ref tag */
  tag: string;
  /** canonical helper ref */
  canonical: string;
};

type RegistrySandboxHelperSource = {
  /** downloadable archive URL */
  url: string;
  /** expected archive checksum (`sha256` hex) */
  sha256?: string;
  /** expected helper architecture */
  arch?: Architecture;
  /** compatible gondolin package version */
  gondolinVersion?: string;
  /** Zig target triple */
  target?: string;
  /** Zig compiler version */
  zigVersion?: string;
};

type BuiltinSandboxHelperRegistry = {
  /** registry schema version */
  schema: typeof SANDBOX_HELPER_REGISTRY_SCHEMA;
  /** named refs mapped by architecture to build ids */
  refs: Record<string, Partial<Record<Architecture, string>>>;
  /** build-id keyed sources */
  builds: Record<string, RegistrySandboxHelperSource>;
};

export function getSandboxHelperStoreDirectory(): string {
  return (
    process.env.GONDOLIN_SANDBOX_HELPER_STORE ??
    path.join(cacheBaseDir(), "gondolin", "sandbox-helpers")
  );
}

function sandboxHelperRegistryUrl(value?: string): string {
  const envValue = process.env.GONDOLIN_SANDBOX_HELPER_REGISTRY_URL?.trim();
  const explicit = value?.trim();
  if (explicit && explicit.length > 0) return explicit;
  if (envValue && envValue.length > 0) return envValue;
  return DEFAULT_SANDBOX_HELPER_REGISTRY_URL;
}

function helperObjectRootDir(storeDir: string): string {
  return path.join(storeDir, "objects");
}

function helperObjectDir(storeDir: string, buildId: string): string {
  return path.join(
    helperObjectRootDir(storeDir),
    normalizeHelperBuildId(buildId),
  );
}

function normalizeHelperBuildId(value: string): string {
  const lower = value.toLowerCase();
  if (!HELPER_BUILD_ID_PATTERN.test(lower)) {
    throw new Error(`invalid sandbox helper build id: ${value}`);
  }
  return lower;
}

export function computeSandboxHelperBuildId(
  input: SandboxHelperBuildIdInput,
): string {
  const parts = ["gondolin-sandbox-helper-build", `arch=${input.arch}`];
  for (const name of SANDBOX_HELPER_BINARY_NAMES) {
    parts.push(`${name}=${normalizeSha256(input.checksums[name], name)}`);
  }

  return digestToUuidV5(createHash("sha256").update(parts.join("\n")).digest());
}

function hasValidRefNameSegments(name: string): boolean {
  const segments = name.split("/");
  if (segments.length === 0) return false;

  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return false;
    }
    if (!HELPER_REF_NAME_SEGMENT_PATTERN.test(segment)) {
      return false;
    }
  }

  return true;
}

function parseSandboxHelperRef(reference: string): ParsedHelperRef {
  const trimmed = reference.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0 || colon >= trimmed.length - 1) {
    throw new Error(`invalid sandbox helper ref: ${reference}`);
  }

  const name = trimmed.slice(0, colon);
  const tag = trimmed.slice(colon + 1);
  if (!HELPER_REF_NAME_PATTERN.test(name) || !hasValidRefNameSegments(name)) {
    throw new Error(`invalid sandbox helper ref name: ${name}`);
  }
  if (!HELPER_REF_TAG_PATTERN.test(tag)) {
    throw new Error(`invalid sandbox helper ref tag: ${tag}`);
  }

  return { name, tag, canonical: `${name}:${tag}` };
}

export function sandboxHelperRefForVersion(version: string): string {
  const normalized = version.trim().replace(/^v/, "");
  return parseSandboxHelperRef(`gondolin:${normalized}`).canonical;
}

function resolveHostPackageVersion(): string {
  let dir = import.meta.dirname;

  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === "@earendil-works/gondolin" && parsed.version) {
          return parsed.version;
        }
      } catch {
        // Ignore malformed package metadata while walking upward.
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return "0.0.0";
}

function parseRegistrySource(
  raw: unknown,
  where: string,
  baseUrl: URL,
): RegistrySandboxHelperSource {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`invalid ${where}: expected object`);
  }

  const rec = raw as Record<string, unknown>;
  const source: RegistrySandboxHelperSource = {
    url: parseRegistryUrl(rec.url, `${where}.url`, baseUrl),
  };

  if (rec.sha256 !== undefined) {
    source.sha256 = normalizeSha256(rec.sha256, `${where}.sha256`);
  }
  if (rec.arch !== undefined) {
    if (typeof rec.arch !== "string") {
      throw new Error(`invalid ${where}.arch: expected string`);
    }
    const arch = normalizeArchitecture(rec.arch);
    if (!arch) {
      throw new Error(`invalid ${where}.arch: ${rec.arch}`);
    }
    source.arch = arch;
  }
  if (rec.gondolinVersion !== undefined) {
    if (typeof rec.gondolinVersion !== "string" || !rec.gondolinVersion) {
      throw new Error(`invalid ${where}.gondolinVersion: expected string`);
    }
    source.gondolinVersion = rec.gondolinVersion;
  }
  if (rec.target !== undefined) {
    if (typeof rec.target !== "string" || !rec.target) {
      throw new Error(`invalid ${where}.target: expected string`);
    }
    source.target = rec.target;
  }
  if (rec.zigVersion !== undefined) {
    if (typeof rec.zigVersion !== "string" || !rec.zigVersion) {
      throw new Error(`invalid ${where}.zigVersion: expected string`);
    }
    source.zigVersion = rec.zigVersion;
  }

  return source;
}

function parseBuiltinSandboxHelperRegistry(
  raw: unknown,
  sourceUrl: string,
): BuiltinSandboxHelperRegistry {
  const { refs, builds } = parseKeyedRegistry(raw, sourceUrl, {
    label: "builtin sandbox helper registry",
    schema: SANDBOX_HELPER_REGISTRY_SCHEMA,
    keyName: "arch",
    normalizeKey: normalizeArchitecture,
    normalizeBuildId: normalizeHelperBuildId,
    canonicalRef: (reference) => parseSandboxHelperRef(reference).canonical,
    parseBuild: parseRegistrySource,
    buildKey: (source) => source.arch,
  });
  return { schema: SANDBOX_HELPER_REGISTRY_SCHEMA, refs, builds };
}

async function fetchBuiltinSandboxHelperRegistry(
  options: Pick<ResolveSandboxHelperOptions, "registryUrl" | "storeDir">,
): Promise<BuiltinSandboxHelperRegistry> {
  const storeDir = options.storeDir ?? getSandboxHelperStoreDirectory();
  const url = sandboxHelperRegistryUrl(options.registryUrl);
  return await fetchCachedJsonRegistry({
    url,
    storeDir,
    cacheFileName: "builtin-sandbox-helper-registry-cache.json",
    userAgent: "gondolin-sandbox-helper-registry",
    parse: parseBuiltinSandboxHelperRegistry,
    label: "builtin sandbox helper registry",
  });
}

function parseSandboxHelperManifest(raw: unknown): SandboxHelperManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid sandbox helper manifest: expected object");
  }

  const rec = raw as Record<string, unknown>;
  if (rec.schema !== SANDBOX_HELPER_MANIFEST_SCHEMA) {
    throw new Error(
      `invalid sandbox helper manifest schema: expected ${SANDBOX_HELPER_MANIFEST_SCHEMA}`,
    );
  }
  if (rec.kind !== SANDBOX_HELPER_KIND) {
    throw new Error(
      `invalid sandbox helper manifest kind: ${String(rec.kind)}`,
    );
  }
  if (typeof rec.gondolinVersion !== "string" || !rec.gondolinVersion) {
    throw new Error("invalid sandbox helper manifest gondolinVersion");
  }
  if (typeof rec.arch !== "string") {
    throw new Error("invalid sandbox helper manifest arch");
  }
  const arch = normalizeArchitecture(rec.arch);
  if (!arch) {
    throw new Error(`invalid sandbox helper manifest arch: ${rec.arch}`);
  }
  if (
    !rec.checksums ||
    typeof rec.checksums !== "object" ||
    Array.isArray(rec.checksums)
  ) {
    throw new Error("invalid sandbox helper manifest checksums");
  }

  const rawChecksums = rec.checksums as Record<string, unknown>;
  const checksums = {} as SandboxHelperChecksums;
  for (const name of SANDBOX_HELPER_BINARY_NAMES) {
    checksums[name] = normalizeSha256(
      rawChecksums[name],
      `sandbox helper manifest checksums.${name}`,
    );
  }

  const manifest: SandboxHelperManifest = {
    schema: SANDBOX_HELPER_MANIFEST_SCHEMA,
    kind: SANDBOX_HELPER_KIND,
    gondolinVersion: rec.gondolinVersion,
    arch,
    checksums,
  };

  if (rec.sourceRef !== undefined) {
    if (typeof rec.sourceRef !== "string" || !rec.sourceRef) {
      throw new Error("invalid sandbox helper manifest sourceRef");
    }
    manifest.sourceRef = rec.sourceRef;
  }
  if (rec.target !== undefined) {
    if (typeof rec.target !== "string" || !rec.target) {
      throw new Error("invalid sandbox helper manifest target");
    }
    manifest.target = rec.target;
  }
  if (rec.zigVersion !== undefined) {
    if (typeof rec.zigVersion !== "string" || !rec.zigVersion) {
      throw new Error("invalid sandbox helper manifest zigVersion");
    }
    manifest.zigVersion = rec.zigVersion;
  }

  return manifest;
}

export function loadSandboxHelperManifest(
  helperDir: string,
): SandboxHelperManifest | null {
  const manifestPath = path.join(helperDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;

  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  return parseSandboxHelperManifest(raw);
}

function helperBinDir(helperDir: string): string {
  const nested = path.join(helperDir, "bin");
  if (fs.existsSync(path.join(nested, "sandboxd"))) {
    return nested;
  }
  return helperDir;
}

function buildHelperPaths(binDir: string): SandboxHelperBinaryPaths {
  return {
    sandboxdPath: path.join(binDir, "sandboxd"),
    sandboxfsPath: path.join(binDir, "sandboxfs"),
    sandboxsshPath: path.join(binDir, "sandboxssh"),
    sandboxingressPath: path.join(binDir, "sandboxingress"),
  };
}

function pathForHelperName(
  paths: SandboxHelperBinaryPaths,
  name: SandboxHelperBinaryName,
): string {
  switch (name) {
    case "sandboxd":
      return paths.sandboxdPath;
    case "sandboxfs":
      return paths.sandboxfsPath;
    case "sandboxssh":
      return paths.sandboxsshPath;
    case "sandboxingress":
      return paths.sandboxingressPath;
  }
}

function assertExecutableFiles(paths: SandboxHelperBinaryPaths): void {
  for (const name of SANDBOX_HELPER_BINARY_NAMES) {
    const filePath = pathForHelperName(paths, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch {
      throw new Error(`sandbox helper binary not found: ${filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(
        `sandbox helper binary is not a regular file: ${filePath}`,
      );
    }
  }
}

function computeHelperChecksums(
  paths: SandboxHelperBinaryPaths,
): SandboxHelperChecksums {
  const checksums = {} as SandboxHelperChecksums;
  for (const name of SANDBOX_HELPER_BINARY_NAMES) {
    checksums[name] = computeFileHash(pathForHelperName(paths, name));
  }
  return checksums;
}

function verifyManifestChecksums(
  manifest: SandboxHelperManifest,
  paths: SandboxHelperBinaryPaths,
): void {
  const actual = computeHelperChecksums(paths);
  for (const name of SANDBOX_HELPER_BINARY_NAMES) {
    const expected = manifest.checksums[name];
    if (actual[name] !== expected) {
      throw new Error(
        `sandbox helper checksum mismatch for ${name}\n  expected: ${expected}\n  got:      ${actual[name]}`,
      );
    }
  }
}

function resolveSandboxHelperDirectory(
  helperDir: string,
  options: {
    expectedArch?: Architecture;
    expectedGondolinVersion?: string;
    /** content-derived build id the helpers must match */
    expectedBuildId?: string;
    source: "directory" | "cache";
  },
): ResolvedSandboxHelpers {
  const resolvedDir = path.resolve(helperDir);
  const manifest = loadSandboxHelperManifest(resolvedDir);
  const paths = buildHelperPaths(helperBinDir(resolvedDir));
  assertExecutableFiles(paths);

  let arch = options.expectedArch;
  let buildId: string | undefined;
  if (manifest) {
    verifyManifestChecksums(manifest, paths);
    arch = manifest.arch;
    buildId = computeSandboxHelperBuildId({
      arch: manifest.arch,
      checksums: manifest.checksums,
    });

    if (options.expectedArch && manifest.arch !== options.expectedArch) {
      throw new Error(
        `sandbox helper arch mismatch\n  expected: ${options.expectedArch}\n  got:      ${manifest.arch}`,
      );
    }
    if (
      options.expectedGondolinVersion &&
      manifest.gondolinVersion !== options.expectedGondolinVersion
    ) {
      throw new Error(
        `sandbox helper gondolinVersion mismatch\n  expected: ${options.expectedGondolinVersion}\n  got:      ${manifest.gondolinVersion}`,
      );
    }
    if (options.expectedBuildId && buildId !== options.expectedBuildId) {
      throw new Error(
        `sandbox helper buildId mismatch\n  expected: ${options.expectedBuildId}\n  got:      ${buildId}\n  dir:      ${resolvedDir}`,
      );
    }
  } else if (!arch) {
    throw new Error(
      `sandbox helper manifest not found: ${path.join(resolvedDir, "manifest.json")}`,
    );
  }

  return {
    source: options.source,
    buildId,
    arch,
    manifest: manifest ?? undefined,
    paths,
  };
}

async function importSandboxHelpersFromSource(
  source: RegistrySandboxHelperSource,
  expectedBuildId: string,
  storeDir: string,
): Promise<ResolvedSandboxHelpers> {
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-sandbox-helpers-"),
  );
  const archivePath = path.join(tmpRoot, "helpers.tar.gz");
  const extractDir = path.join(tmpRoot, "extract");

  try {
    fs.writeFileSync(
      archivePath,
      await downloadToBuffer(
        source.url,
        source.sha256,
        "gondolin-sandbox-helper-fetch",
        {
          downloadLabel: "sandbox helper archive",
          checksumLabel: "downloaded sandbox helper",
        },
      ),
    );
    fs.mkdirSync(extractDir, { recursive: true });
    await extractTarGz(archivePath, extractDir);

    const extracted = resolveSandboxHelperDirectory(extractDir, {
      expectedArch: source.arch,
      expectedGondolinVersion: source.gondolinVersion,
      source: "cache",
    });
    if (!extracted.manifest) {
      throw new Error(
        "downloaded sandbox helper archive is missing manifest.json",
      );
    }
    if (extracted.buildId !== expectedBuildId) {
      throw new Error(
        `downloaded sandbox helper buildId mismatch\n  expected: ${expectedBuildId}\n  got:      ${extracted.buildId ?? "unknown"}\n  source:   ${source.url}`,
      );
    }

    const objectDir = helperObjectDir(storeDir, expectedBuildId);
    const objectsRoot = path.dirname(objectDir);
    fs.mkdirSync(objectsRoot, { recursive: true });

    if (!fs.existsSync(objectDir)) {
      const tmpObjectDir = `${objectDir}.tmp-${randomUUID().slice(0, 8)}`;
      try {
        fs.cpSync(extractDir, tmpObjectDir, { recursive: true });
        for (const name of SANDBOX_HELPER_BINARY_NAMES) {
          fs.chmodSync(path.join(tmpObjectDir, "bin", name), 0o755);
        }
        fs.renameSync(tmpObjectDir, objectDir);
      } catch (error) {
        fs.rmSync(tmpObjectDir, { recursive: true, force: true });
        if (fs.existsSync(objectDir)) {
          return {
            ...resolveSandboxHelperDirectory(objectDir, {
              expectedArch: source.arch,
              expectedBuildId,
              source: "cache",
            }),
            source: "download",
          };
        }
        throw error;
      }
    }

    const resolved = resolveSandboxHelperDirectory(objectDir, {
      expectedArch: source.arch,
      expectedBuildId,
      source: "cache",
    });
    return { ...resolved, source: "download" };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export async function ensureSandboxHelperBinaries(
  options: ResolveSandboxHelperOptions,
): Promise<ResolvedSandboxHelpers> {
  const gondolinVersion =
    options.gondolinVersion ?? resolveHostPackageVersion();
  const explicitHelpersDir =
    options.helpersDir ?? process.env.GONDOLIN_SANDBOX_HELPERS_DIR;

  if (explicitHelpersDir && explicitHelpersDir.trim().length > 0) {
    return resolveSandboxHelperDirectory(explicitHelpersDir, {
      expectedArch: options.arch,
      expectedGondolinVersion: gondolinVersion,
      source: "directory",
    });
  }

  const storeDir = options.storeDir ?? getSandboxHelperStoreDirectory();
  const registry = await fetchBuiltinSandboxHelperRegistry(options);
  const ref = options.ref ?? sandboxHelperRefForVersion(gondolinVersion);
  const { buildId, build: source } = resolveKeyedRegistryRef(
    registry,
    parseSandboxHelperRef(ref).canonical,
    options.arch,
    { label: "sandbox helper" },
  );

  const objectDir = helperObjectDir(storeDir, buildId);
  if (fs.existsSync(objectDir)) {
    // Build ids are content-addressed and the registry maps several releases
    // to the same build when helper binaries are unchanged.  The cached
    // manifest records whichever release was downloaded first, so verify the
    // content instead of the release version.
    return resolveSandboxHelperDirectory(objectDir, {
      expectedArch: options.arch,
      expectedBuildId: buildId,
      source: "cache",
    });
  }

  options.log?.(`Downloading sandbox helpers for ${options.arch} (${ref})`);
  return importSandboxHelpersFromSource(source, buildId, storeDir);
}

export const __test = {
  parseBuiltinSandboxHelperRegistry,
  parseSandboxHelperManifest,
  parseSandboxHelperRef,
  normalizeArchitecture,
  normalizeHelperBuildId,
};

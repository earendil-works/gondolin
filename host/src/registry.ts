/**
 * Shared helpers for the builtin JSON registries (images, sandbox helpers,
 * trufflehog).
 *
 * All registries share the same shape: a `schema` version, a `builds` map of
 * build id to downloadable source, and a `refs` map of `name:tag` to a
 * per-key (architecture or platform) build id.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "./utils/error.ts";

export function normalizeSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`invalid ${label}: expected sha256 hex string`);
  }
  return value.toLowerCase();
}

/**
 * Parse a (possibly relative) registry url field against the registry url.
 */
export function parseRegistryUrl(
  value: unknown,
  where: string,
  baseUrl: URL,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid ${where}: expected string`);
  }
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    throw new Error(`invalid ${where}: ${value}`);
  }
}

/** Parsed `refs`/`builds` portion of a builtin registry */
export type KeyedRegistry<K extends string, S> = {
  /** canonical refs mapped by key (arch or platform) to build ids */
  refs: Record<string, Partial<Record<K, string>>>;
  /** build-id keyed sources */
  builds: Record<string, S>;
};

export type KeyedRegistryParseOptions<K extends string, S> = {
  /** human readable registry name used in error messages */
  label: string;
  /** expected `schema` value */
  schema: number;
  /** name of the per-ref key used in error messages (e.g. `arch`) */
  keyName: string;
  /** normalize a ref key, returning `null` if unsupported */
  normalizeKey: (key: string) => K | null;
  /** validate and canonicalize a build id (throws on invalid input) */
  normalizeBuildId: (buildId: string) => string;
  /** validate a ref and return its canonical form (throws on invalid input) */
  canonicalRef: (reference: string) => string;
  /** parse a single build entry */
  parseBuild: (raw: unknown, where: string, baseUrl: URL) => S;
  /** key a build is restricted to, if any */
  buildKey: (build: S) => K | undefined;
};

function expectRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

/**
 * Parse and validate a builtin registry document.
 */
export function parseKeyedRegistry<K extends string, S>(
  raw: unknown,
  sourceUrl: string,
  options: KeyedRegistryParseOptions<K, S>,
): KeyedRegistry<K, S> {
  const { label, keyName } = options;
  const rec = expectRecord(raw, `invalid ${label}: expected object`);
  if (rec.schema !== options.schema) {
    throw new Error(`invalid ${label} schema: expected ${options.schema}`);
  }

  const baseUrl = new URL(sourceUrl);

  const rawBuilds = expectRecord(
    rec.builds,
    `invalid ${label}: builds must be an object`,
  );
  const builds: Record<string, S> = {};
  for (const [buildId, value] of Object.entries(rawBuilds)) {
    builds[options.normalizeBuildId(buildId)] = options.parseBuild(
      value,
      `builds['${buildId}']`,
      baseUrl,
    );
  }

  const rawRefs = expectRecord(
    rec.refs,
    `invalid ${label}: refs must be an object`,
  );
  const refs: Record<string, Partial<Record<K, string>>> = {};
  for (const [reference, keyMap] of Object.entries(rawRefs)) {
    const canonical = options.canonicalRef(reference);
    if (canonical !== reference) {
      throw new Error(`invalid ${label} ref key: ${reference}`);
    }

    const entries = expectRecord(
      keyMap,
      `invalid registry ref '${reference}': expected object`,
    );
    const mapped: Partial<Record<K, string>> = {};
    for (const [rawKey, value] of Object.entries(entries)) {
      const where = `refs['${reference}']['${rawKey}']`;
      const key = options.normalizeKey(rawKey);
      if (!key) {
        throw new Error(
          `invalid registry ref '${reference}' ${keyName} key: ${rawKey}`,
        );
      }
      if (typeof value !== "string") {
        throw new Error(`invalid ${where}: expected build id string`);
      }

      const buildId = options.normalizeBuildId(value);
      const build = builds[buildId];
      if (!build) {
        throw new Error(`invalid ${where}: unknown build id ${buildId}`);
      }
      const buildKey = options.buildKey(build);
      if (buildKey && buildKey !== key) {
        throw new Error(
          `invalid ${where}: ${keyName} ${key} does not match build ${keyName} ${buildKey}`,
        );
      }

      mapped[key] = buildId;
    }

    refs[canonical] = mapped;
  }

  return { refs, builds };
}

/**
 * Pick the build id for `key` from a per-key ref map.
 *
 * If `allowSingleFallback` is set and there is no exact match but exactly one
 * entry, that entry is returned instead.
 */
export function selectKeyedEntry<K extends string>(
  entries: Partial<Record<K, string>>,
  key: K,
  allowSingleFallback = false,
): { key: K; buildId: string } | null {
  const exact = entries[key];
  if (exact) return { key, buildId: exact };

  if (allowSingleFallback) {
    const available = Object.entries(entries).filter(
      (pair): pair is [K, string] => typeof pair[1] === "string",
    );
    if (available.length === 1) {
      const [fallbackKey, buildId] = available[0]!;
      return { key: fallbackKey, buildId };
    }
  }

  return null;
}

/** Comma separated list of keys present in a per-key ref map */
export function describeAvailableKeys<K extends string>(
  entries: Partial<Record<K, string>>,
): string {
  return (
    Object.entries(entries)
      .filter(([, value]) => typeof value === "string")
      .map(([name]) => name)
      .join(", ") || "none"
  );
}

/**
 * Resolve a canonical ref to a registry build for `key`.
 */
export function resolveKeyedRegistryRef<K extends string, S>(
  registry: KeyedRegistry<K, S>,
  canonicalRef: string,
  key: K,
  options: {
    /** ref kind used in error messages (e.g. `image`) */
    label: string;
    /** use the only available entry if there is no exact match */
    allowSingleFallback?: boolean;
  },
): { buildId: string; key: K; build: S } {
  const entries = registry.refs[canonicalRef];
  if (!entries) {
    throw new Error(
      `${options.label} ref not found in builtin registry: ${canonicalRef}`,
    );
  }

  const selected = selectKeyedEntry(
    entries,
    key,
    options.allowSingleFallback ?? false,
  );
  if (!selected) {
    throw new Error(
      `${options.label} ref '${canonicalRef}' has no registry source for ${key} (available: ${describeAvailableKeys(entries)})`,
    );
  }

  const build = registry.builds[selected.buildId];
  if (!build) {
    throw new Error(
      `${options.label} ref '${canonicalRef}' points to unknown registry build id: ${selected.buildId}`,
    );
  }

  return { buildId: selected.buildId, key: selected.key, build };
}

type RegistryCache<T> = {
  /** source registry URL */
  url: string;
  /** HTTP etag from the last successful fetch */
  etag?: string;
  /** cached registry payload */
  registry: T;
};

function loadRegistryCache<T>(
  url: string,
  storeDir: string,
  cacheFileName: string,
  parse: (raw: unknown, sourceUrl: string) => T,
): RegistryCache<T> | null {
  const cachePath = path.join(storeDir, cacheFileName);
  if (!fs.existsSync(cachePath)) return null;

  try {
    const parsed = JSON.parse(
      fs.readFileSync(cachePath, "utf8"),
    ) as RegistryCache<T>;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.url !== url) return null;
    return {
      url,
      etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
      registry: parse(parsed.registry as unknown, url),
    };
  } catch {
    return null;
  }
}

function saveRegistryCache<T>(
  cache: RegistryCache<T>,
  storeDir: string,
  cacheFileName: string,
): void {
  fs.mkdirSync(storeDir, { recursive: true });
  const cachePath = path.join(storeDir, cacheFileName);
  const tmpPath = `${cachePath}.tmp-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2));
  fs.renameSync(tmpPath, cachePath);
}

export async function fetchCachedJsonRegistry<T>(options: {
  url: string;
  storeDir: string;
  cacheFileName: string;
  userAgent: string;
  parse: (raw: unknown, sourceUrl: string) => T;
  label: string;
}): Promise<T> {
  const cached = loadRegistryCache(
    options.url,
    options.storeDir,
    options.cacheFileName,
    options.parse,
  );

  const headers: Record<string, string> = {
    "User-Agent": options.userAgent,
  };
  if (cached?.etag) {
    headers["If-None-Match"] = cached.etag;
  }

  let response: Response;
  try {
    response = await fetch(options.url, { headers });
  } catch (error) {
    if (cached) return cached.registry;
    throw new Error(
      `failed to fetch ${options.label} from ${options.url}: ${errorMessage(error)}`,
    );
  }

  if (response.status === 304 && cached) {
    return cached.registry;
  }
  if (!response.ok) {
    if (cached) return cached.registry;
    throw new Error(
      `failed to fetch ${options.label}: ${response.status} ${response.statusText} (${options.url})`,
    );
  }

  const text = await response.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `failed to parse ${options.label} json from ${options.url}: ${errorMessage(error)}`,
    );
  }

  const registry = options.parse(raw, options.url);
  saveRegistryCache(
    {
      url: options.url,
      etag: response.headers.get("etag") ?? undefined,
      registry,
    },
    options.storeDir,
    options.cacheFileName,
  );
  return registry;
}

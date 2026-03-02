import { createHash } from "node:crypto";

import {
  SECRET_MAPPING_DATA,
  SECRET_MAPPING_JSON,
  SECRET_MAPPING_SHA256,
} from "./generated/secret-mapping.ts";
import { compilePattern } from "./regex.ts";
import type { SecretMappingData, ValuePattern } from "./types.ts";

interface ReadonlyValuePattern {
  readonly id: string;
  readonly keyword?: string;
  readonly regex: string;
  readonly keywords?: readonly string[];
  readonly secret_group?: number;
}

interface ReadonlySecretMappingData {
  readonly schema_version: number;
  readonly generated_at: string;
  readonly keyword_host_map: Readonly<Record<string, readonly string[]>>;
  readonly exact_name_host_map: Readonly<Record<string, readonly string[]>>;
  readonly value_patterns: readonly ReadonlyValuePattern[];
}

export interface CompiledPattern {
  readonly id: string;
  readonly keyword?: string;
  readonly regex: RegExp;
}

export interface PatternStore {
  readonly raw: ReadonlySecretMappingData;
  readonly compiledValuePatterns: readonly CompiledPattern[];
  readonly failedValuePatterns: ReadonlyArray<{ id: string; error: string }>;
  readonly keywordEntries: ReadonlyArray<{
    keyword: string;
    hosts: readonly string[];
    normalized: string;
  }>;
}

export class PatternCompilationError extends Error {
  readonly code = "SECRET_FILTER_PATTERN_COMPILE_FAILED";
  readonly failures: Array<{ id: string; error: string }>;

  constructor(failures: Array<{ id: string; error: string }>) {
    const ids = failures.map((failure) => failure.id).join(", ");
    super(`Failed to compile ${failures.length} value pattern(s): ${ids}`);
    this.name = "PatternCompilationError";
    this.failures = failures;
  }
}

export class PatternIntegrityError extends Error {
  readonly code = "SECRET_FILTER_MAPPING_CHECKSUM_MISMATCH";
  readonly expectedSha256: string;
  readonly actualSha256: string;

  constructor(expectedSha256: string, actualSha256: string) {
    super(
      `Mapping checksum mismatch for secret-mapping.gondolin.json (expected ${expectedSha256}, got ${actualSha256})`,
    );
    this.name = "PatternIntegrityError";
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

export class PatternSchemaError extends Error {
  readonly code = "SECRET_FILTER_MAPPING_SCHEMA_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PatternSchemaError";
  }
}

let cached: PatternStore | null = null;

function uniqueHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts)];
}

function normalizeKeyword(token: string): string {
  return token.toLowerCase().replace(/[-_\s]/g, "");
}

function compileValuePatterns(valuePatterns: readonly ReadonlyValuePattern[]): {
  compiledValuePatterns: CompiledPattern[];
  failedValuePatterns: Array<{ id: string; error: string }>;
} {
  const compiledValuePatterns: CompiledPattern[] = [];
  const failedValuePatterns: Array<{ id: string; error: string }> = [];

  for (const vp of valuePatterns) {
    try {
      compiledValuePatterns.push({
        id: vp.id,
        keyword: vp.keyword,
        regex: compilePattern(vp.regex),
      });
    } catch (error) {
      failedValuePatterns.push({
        id: vp.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { compiledValuePatterns, failedValuePatterns };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PatternSchemaError(`${path} must be a non-empty string`);
  }

  return value;
}

function expectStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new PatternSchemaError(`${path} must be an array of strings`);
  }

  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.length === 0) {
      throw new PatternSchemaError(
        `${path}[${index}] must be a non-empty string`,
      );
    }
    out.push(item);
  }

  return out;
}

function validateHostMap(
  value: unknown,
  path: string,
): Record<string, string[]> {
  if (!isRecord(value)) {
    throw new PatternSchemaError(
      `${path} must be an object mapping string keys to string arrays`,
    );
  }

  const out: Record<string, string[]> = Object.create(null);
  for (const [key, hosts] of Object.entries(value)) {
    if (key.length === 0) {
      throw new PatternSchemaError(`${path} contains an empty key`);
    }
    out[key] = expectStringArray(hosts, `${path}.${key}`);
  }

  return out;
}

function validateValuePatterns(value: unknown): ValuePattern[] {
  if (!Array.isArray(value)) {
    throw new PatternSchemaError("value_patterns must be an array");
  }

  const out: ValuePattern[] = [];

  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      throw new PatternSchemaError(
        `value_patterns[${index}] must be an object`,
      );
    }

    const allowedKeys = new Set([
      "id",
      "keyword",
      "regex",
      "keywords",
      "secret_group",
    ]);
    for (const key of Object.keys(item)) {
      if (!allowedKeys.has(key)) {
        throw new PatternSchemaError(
          `value_patterns[${index}] contains unknown key: ${key}`,
        );
      }
    }

    const id = expectNonEmptyString(item.id, `value_patterns[${index}].id`);
    const regex = expectNonEmptyString(
      item.regex,
      `value_patterns[${index}].regex`,
    );

    const keywordValue = item.keyword;
    const keyword =
      keywordValue === undefined
        ? undefined
        : expectNonEmptyString(
            keywordValue,
            `value_patterns[${index}].keyword`,
          );

    const keywordsValue = item.keywords;
    const keywords =
      keywordsValue === undefined
        ? undefined
        : expectStringArray(keywordsValue, `value_patterns[${index}].keywords`);

    const secretGroupValue = item.secret_group;
    let secret_group: number | undefined;
    if (secretGroupValue !== undefined) {
      if (
        typeof secretGroupValue !== "number" ||
        !Number.isInteger(secretGroupValue) ||
        secretGroupValue < 0
      ) {
        throw new PatternSchemaError(
          `value_patterns[${index}].secret_group must be a non-negative integer`,
        );
      }
      secret_group = secretGroupValue;
    }

    out.push({ id, regex, keyword, keywords, secret_group });
  }

  return out;
}

function validateSecretMappingData(value: unknown): SecretMappingData {
  if (!isRecord(value)) {
    throw new PatternSchemaError("mapping must be a JSON object");
  }

  const allowedTopLevelKeys = new Set([
    "schema_version",
    "generated_at",
    "keyword_host_map",
    "exact_name_host_map",
    "value_patterns",
  ]);

  for (const key of Object.keys(value)) {
    if (!allowedTopLevelKeys.has(key)) {
      throw new PatternSchemaError(
        `mapping contains unknown top-level key: ${key}`,
      );
    }
  }

  const schemaVersion = value.schema_version;
  if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion <= 0
  ) {
    throw new PatternSchemaError("schema_version must be a positive integer");
  }

  return {
    schema_version: schemaVersion,
    generated_at: expectNonEmptyString(value.generated_at, "generated_at"),
    keyword_host_map: validateHostMap(
      value.keyword_host_map,
      "keyword_host_map",
    ),
    exact_name_host_map: validateHostMap(
      value.exact_name_host_map,
      "exact_name_host_map",
    ),
    value_patterns: validateValuePatterns(value.value_patterns),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }

  return value;
}

export function getPatternStore(): PatternStore {
  if (cached) {
    return cached;
  }

  const actualSha = createHash("sha256")
    .update(Buffer.from(SECRET_MAPPING_JSON, "utf8"))
    .digest("hex");

  if (actualSha !== SECRET_MAPPING_SHA256) {
    throw new PatternIntegrityError(SECRET_MAPPING_SHA256, actualSha);
  }

  const validated = validateSecretMappingData(SECRET_MAPPING_DATA);

  const { compiledValuePatterns, failedValuePatterns } = compileValuePatterns(
    validated.value_patterns,
  );

  if (failedValuePatterns.length > 0) {
    throw new PatternCompilationError(failedValuePatterns);
  }

  const keywordEntries = Object.entries(validated.keyword_host_map)
    .filter(([keyword, hosts]) => keyword.length > 0 && hosts.length > 0)
    .map(([keyword, hosts]) => ({
      keyword: keyword.toLowerCase(),
      hosts: uniqueHosts(hosts),
      normalized: normalizeKeyword(keyword),
    }))
    .sort((a, b) => {
      const lenDelta = b.keyword.length - a.keyword.length;
      if (lenDelta !== 0) {
        return lenDelta;
      }
      return a.keyword.localeCompare(b.keyword);
    });

  const store: PatternStore = {
    raw: deepFreeze(validated) as ReadonlySecretMappingData,
    compiledValuePatterns: deepFreeze(compiledValuePatterns),
    failedValuePatterns: deepFreeze(failedValuePatterns),
    keywordEntries: deepFreeze(keywordEntries),
  };

  cached = store;
  return store;
}

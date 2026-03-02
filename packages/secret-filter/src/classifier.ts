import { getPatternStore } from "./patterns.ts";
import type {
  ClassifyEnvResult,
  ClassifyOptions,
  ClassifyResult,
} from "./types.ts";

const KEYWORD_SECRET_HINT_PATTERN =
  /(?:^|_)(API_KEY|KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH|PASS|PASSPHRASE|PRIVATE_KEY)(?:$|_)/i;

const GENERIC_SECRET_NAME_PATTERN =
  /(?:^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PASSPHRASE|PRIVATE_KEY)(?:$|_)/i;

function dedupeHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts)];
}

function normalizeToken(input: string): string {
  return input.toLowerCase().replace(/[-_\s]/g, "");
}

function findOverrideHosts(
  name: string,
  options?: ClassifyOptions,
): string[] | null {
  const overrides = options?.overrides;
  if (!overrides) {
    return null;
  }

  return (
    overrides[name] ??
    overrides[name.toUpperCase()] ??
    overrides[name.toLowerCase()] ??
    null
  );
}

function resolveHostsFromName(name: string): {
  hosts: string[];
  matchedBy?: "name-exact" | "name-keyword";
  keyword?: string;
} {
  const store = getPatternStore();

  const exactHosts =
    store.raw.exact_name_host_map[name] ??
    store.raw.exact_name_host_map[name.toUpperCase()];

  if (exactHosts?.length) {
    return {
      hosts: dedupeHosts(exactHosts),
      matchedBy: "name-exact",
    };
  }

  const lower = name.toLowerCase();
  const normalizedName = normalizeToken(name);
  const hasSecretHint = KEYWORD_SECRET_HINT_PATTERN.test(name);

  if (!hasSecretHint) {
    return { hosts: [] };
  }

  for (const entry of store.keywordEntries) {
    if (
      !(
        lower.includes(entry.keyword) ||
        normalizedName.includes(entry.normalized)
      )
    ) {
      continue;
    }

    return {
      hosts: dedupeHosts(entry.hosts),
      matchedBy: "name-keyword",
      keyword: entry.keyword,
    };
  }

  return { hosts: [] };
}

export function classify(
  name: string,
  value: string,
  options?: ClassifyOptions,
): ClassifyResult {
  const store = getPatternStore();

  const overrideHosts = findOverrideHosts(name, options);
  if (overrideHosts) {
    const hosts = dedupeHosts(overrideHosts);
    return {
      name,
      isSecret: true,
      hosts,
      dropped: hosts.length === 0,
      matchedBy: "override",
      reason: hosts.length === 0 ? "override hosts are empty" : undefined,
    };
  }

  for (const pattern of store.compiledValuePatterns) {
    if (!pattern.regex.test(value)) {
      continue;
    }

    const fromKeyword = pattern.keyword
      ? (store.raw.keyword_host_map[pattern.keyword] ?? [])
      : [];
    const hosts =
      fromKeyword.length > 0
        ? dedupeHosts(fromKeyword)
        : dedupeHosts(resolveHostsFromName(name).hosts);

    return {
      name,
      isSecret: true,
      hosts,
      dropped: hosts.length === 0,
      matchedBy: "value",
      patternId: pattern.id,
      keyword: pattern.keyword,
      reason:
        hosts.length === 0 ? "value matched but no host mapping" : undefined,
    };
  }

  const fromName = resolveHostsFromName(name);
  if (fromName.hosts.length > 0) {
    return {
      name,
      isSecret: true,
      hosts: fromName.hosts,
      dropped: false,
      matchedBy: fromName.matchedBy,
      keyword: fromName.keyword,
    };
  }

  if (GENERIC_SECRET_NAME_PATTERN.test(name)) {
    return {
      name,
      isSecret: true,
      hosts: [],
      dropped: true,
      matchedBy: "name-pattern",
      reason: "secret-like variable name with no host mapping",
    };
  }

  return {
    name,
    isSecret: false,
    hosts: [],
    dropped: false,
  };
}

export function classifyEnv(
  env: Record<string, string | undefined>,
  options?: ClassifyOptions,
): ClassifyEnvResult {
  const result: ClassifyEnvResult = {
    secrets: [],
    dropped: [],
    safe: [],
  };

  for (const [name, rawValue] of Object.entries(env)) {
    if (rawValue === undefined) {
      continue;
    }

    const classified = classify(name, rawValue, options);

    if (!classified.isSecret) {
      result.safe.push(name);
      continue;
    }

    if (classified.dropped) {
      result.dropped.push(classified);
      continue;
    }

    result.secrets.push(classified);
  }

  return result;
}

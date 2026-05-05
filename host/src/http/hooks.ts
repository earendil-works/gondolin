import crypto from "crypto";
import net from "net";

import {
  ON_REQUEST_EARLY_POLICY_SAFE,
  type HttpHooks,
} from "../qemu/contracts.ts";
import { HttpRequestBlockedError } from "./utils.ts";
import { extractIPv4Mapped, parseIPv6Hextets } from "../utils/ip.ts";
import { matchesAnyHost, normalizeHostnamePattern } from "../host/patterns.ts";

export type SecretDefinition = {
  /** host patterns this secret may be sent to */
  hosts: string[];
  /** secret value */
  value: string;
};

export type CreateHttpHooksOptions = {
  /** allowed host patterns (omitted = allow all, explicit empty = deny all) */
  allowedHosts?: string[];
  /** host patterns allowed to resolve to internal ip ranges */
  allowedInternalHosts?: string[];
  /** secret definitions keyed by env var name */
  secrets?: Record<string, SecretDefinition>;
  /** placeholder replacement in URL query string (default: false) */
  replaceSecretsInQuery?: boolean;
  /** whether to block internal ip ranges (default: true) */
  blockInternalRanges?: boolean;
  /** custom request policy callback */
  isRequestAllowed?: HttpHooks["isRequestAllowed"];
  /** custom ip policy callback */
  isIpAllowed?: HttpHooks["isIpAllowed"];

  /** request hook */
  onRequest?: HttpHooks["onRequest"];

  /** response hook */
  onResponse?: HttpHooks["onResponse"];
};

export type UpdateSecretOptions = {
  /** updated secret value */
  value?: string;
  /** updated host patterns this secret may be sent to */
  hosts?: string[];
};

export type SecretManagerEntry = {
  /** env var name */
  name: string;
  /** guest-visible placeholder value */
  placeholder: string;
  /** allowed host patterns */
  hosts: string[];
  /** whether placeholder substitution yields an empty string */
  deleted: boolean;
};

export type SecretManager = {
  /** list configured secrets */
  listSecrets(): SecretManagerEntry[];
  /** update an existing secret */
  updateSecret(name: string, options: UpdateSecretOptions): void;
  /** replace an existing secret with an empty string */
  deleteSecret(name: string): void;
};

export type CreateHttpHooksResult = {
  /** http hook implementation */
  httpHooks: HttpHooks;
  /** environment mapping for secret placeholders */
  env: Record<string, string>;
  /** resolved allowed hosts */
  allowedHosts: string[];
  /** runtime manager for configured secrets */
  secretManager: SecretManager;
};

type SecretEntry = {
  name: string;
  placeholder: string;
  value: string;
  revokedValues: string[];
  hosts: string[];
  deleted: boolean;
};

export function createHttpHooks(
  options: CreateHttpHooksOptions = {},
): CreateHttpHooksResult {
  const env: Record<string, string> = {};
  const blockInternalRanges = options.blockInternalRanges ?? true;
  const configuredAllowedHosts =
    options.allowedHosts === undefined ? ["*"] : uniqueHosts(options.allowedHosts);
  const secretEntries = new Map<string, SecretEntry>();

  for (const [name, secret] of Object.entries(options.secrets ?? {})) {
    const placeholder = `GONDOLIN_SECRET_${crypto.randomBytes(24).toString("hex")}`;
    env[name] = placeholder;
    secretEntries.set(name, {
      name,
      placeholder,
      value: secret.value,
      revokedValues: [],
      hosts: uniqueHosts(secret.hosts),
      deleted: false,
    });
  }

  const allowedInternalHosts = uniqueHosts(options.allowedInternalHosts ?? []);
  const allowedHosts = mergeAllowedHosts(
    configuredAllowedHosts,
    allowedInternalHosts,
  );

  const getSecretEntries = (): SecretEntry[] => Array.from(secretEntries.values());

  const getSecretEntry = (name: string): SecretEntry => {
    const entry = secretEntries.get(name);
    if (!entry) {
      throw new Error(`unknown secret: ${name}`);
    }
    return entry;
  };

  const secretManager: SecretManager = {
    listSecrets() {
      return getSecretEntries().map((entry) => ({
        name: entry.name,
        placeholder: entry.placeholder,
        hosts: [...entry.hosts],
        deleted: entry.deleted,
      }));
    },
    updateSecret(name, update) {
      const entry = getSecretEntry(name);
      if (entry.deleted) {
        throw new Error(`secret deleted: ${name}`);
      }
      if (update.hosts !== undefined) {
        entry.hosts = uniqueHosts(update.hosts);
      }
      if (update.value !== undefined && update.value !== entry.value) {
        entry.revokedValues = addUniqueString(entry.revokedValues, entry.value);
        entry.value = update.value;
        entry.revokedValues = entry.revokedValues.filter(
          (value) => value !== entry.value,
        );
      }
    },
    deleteSecret(name) {
      const entry = getSecretEntry(name);
      if (entry.deleted) {
        return;
      }
      entry.deleted = true;
    },
  };

  const applySecretsToRequest = (request: Request): Request => {
    assertRequestShape(request);
    const hostname = getHostname(request.url);
    const entries = getSecretEntries();

    // Defense-in-depth: if the request already contains real secret values (eg: because
    // it was constructed from a redirected hop), make sure we still enforce per-secret
    // destination allowlists.
    assertSecretValuesAllowedForHost(
      request,
      hostname,
      entries,
      options.replaceSecretsInQuery ?? false,
    );

    const headers = replaceSecretPlaceholdersInHeaders(
      request.headers,
      hostname,
      entries,
    );
    const url = replaceSecretPlaceholdersInUrlParameters(
      request.url,
      hostname,
      entries,
      options.replaceSecretsInQuery ?? false,
    );

    if (url === request.url) {
      if (headers !== request.headers) {
        syncHeaders(request.headers, headers);
      }
      return request;
    }

    return cloneRequestWith(request, {
      url,
      headers,
    });
  };

  const onRequest: NonNullable<HttpHooks["onRequest"]> = async (request) => {
    // Run user hooks first so rewrites can influence both secret allowlist checks
    // and downstream policy evaluation.
    let nextRequest = request;

    if (options.onRequest) {
      const updated = await options.onRequest(nextRequest);
      if (updated) {
        if ("status" in updated) {
          return normalizeResponse(updated);
        }
        assertRequestShape(updated);
        nextRequest = updated;
      }
    }

    // Inject secrets at the last possible moment (after rewrites).
    return applySecretsToRequest(nextRequest);
  };

  // Internal optimization: pre-body policy checks are only safe when no user
  // onRequest callback can short-circuit/rewrite destination semantics.
  onRequest[ON_REQUEST_EARLY_POLICY_SAFE] = !options.onRequest;

  const httpHooks: HttpHooks = {
    isRequestAllowed: async (request) => {
      if (options.isRequestAllowed) {
        return options.isRequestAllowed(request);
      }
      return true;
    },
    isIpAllowed: async (info) => {
      const hostnameAllowedByHostList = matchesAnyHost(
        info.hostname,
        allowedHosts,
      );
      if (!hostnameAllowedByHostList) {
        return false;
      }

      if (
        blockInternalRanges &&
        isInternalAddress(info.ip) &&
        !matchesAnyHost(info.hostname, allowedInternalHosts)
      ) {
        return false;
      }

      if (options.isIpAllowed) {
        return options.isIpAllowed(info);
      }
      return true;
    },
    onRequest,
    onResponse: options.onResponse,
  };

  return { httpHooks, env, allowedHosts, secretManager };
}

function cloneRequestWith(
  request: Request,
  options: {
    url: string;
    headers: Headers;
  },
): Request {
  const method = request.method.toUpperCase();
  const canHaveBody = method !== "GET" && method !== "HEAD";

  return new Request(options.url, {
    method: request.method,
    headers: options.headers,
    body: canHaveBody ? request.body : undefined,
    ...(canHaveBody && request.body ? ({ duplex: "half" } as const) : {}),
  });
}

function normalizeResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: cloneHeaders(response.headers),
  });
}

function cloneHeaders(headers: Headers): Headers {
  const cloned = new Headers(headers);
  const raw = headers as { getSetCookie?: () => unknown };
  if (typeof raw.getSetCookie !== "function") {
    return cloned;
  }

  const cookies = raw.getSetCookie();
  if (!Array.isArray(cookies)) {
    return cloned;
  }

  cloned.delete("set-cookie");
  for (const value of cookies) {
    if (typeof value === "string") {
      cloned.append("set-cookie", value);
    }
  }
  return cloned;
}

function assertRequestShape(value: unknown): asserts value is Request {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as any).url !== "string" ||
    typeof (value as any).method !== "string" ||
    typeof (value as any).headers?.forEach !== "function"
  ) {
    throw new TypeError(
      "onRequest must return Request, Response, or undefined",
    );
  }
}

function syncHeaders(target: Headers, source: Headers): void {
  const sourceKeys = new Set<string>();

  source.forEach((_value, key) => {
    sourceKeys.add(key.toLowerCase());
  });

  const toDelete: string[] = [];
  target.forEach((_value, key) => {
    if (!sourceKeys.has(key.toLowerCase())) {
      toDelete.push(key);
    }
  });

  for (const key of toDelete) {
    target.delete(key);
  }

  source.forEach((value, key) => {
    target.set(key, value);
  });
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function assertSecretValuesAllowedForHost(
  request: Request,
  hostname: string,
  entries: SecretEntry[],
  checkQuery: boolean,
) {
  if (entries.length === 0) return;

  for (const entry of entries) {
    if (
      requestContainsRevokedOrDeletedSecretValuesInHeaders(
        request.headers,
        entry.revokedValues,
        entry.deleted ? [] : [entry.value],
      ) ||
      (checkQuery &&
        requestContainsRevokedOrDeletedSecretValuesInQuery(
          request.url,
          entry.revokedValues,
          entry.deleted ? [] : [entry.value],
        ))
    ) {
      throw new HttpRequestBlockedError(
        `secret ${entry.name} revoked for host: ${hostname || "unknown"}`,
      );
    }

    if (entry.deleted) {
      if (
        requestContainsRevokedOrDeletedSecretValuesInHeaders(
          request.headers,
          [entry.value],
          [],
        )
      ) {
        throw new HttpRequestBlockedError(
          `secret ${entry.name} deleted for host: ${hostname || "unknown"}`,
        );
      }

      if (
        checkQuery &&
        requestContainsRevokedOrDeletedSecretValuesInQuery(
          request.url,
          [entry.value],
          [],
        )
      ) {
        throw new HttpRequestBlockedError(
          `secret ${entry.name} deleted for host: ${hostname || "unknown"}`,
        );
      }

      continue;
    }

    // If the destination is allowed for this secret, we don't care whether the secret
    // value already appears in the request.
    if (matchesAnyHost(hostname, entry.hosts)) continue;

    if (requestContainsSecretValuesInHeaders(request.headers, [entry.value])) {
      throw new HttpRequestBlockedError(
        `secret ${entry.name} not allowed for host: ${hostname || "unknown"}`,
      );
    }

    if (checkQuery && requestContainsSecretValuesInQuery(request.url, [entry.value])) {
      throw new HttpRequestBlockedError(
        `secret ${entry.name} not allowed for host: ${hostname || "unknown"}`,
      );
    }
  }
}

function requestContainsSecretValuesInHeaders(
  headers: Headers,
  values: string[],
): boolean {
  const nonEmptyValues = values.filter(Boolean);
  if (nonEmptyValues.length === 0) return false;

  for (const [headerName, headerValue] of headers.entries()) {
    if (!headerValue) continue;

    for (const value of nonEmptyValues) {
      // Plaintext match (eg: Authorization: Bearer <token>)
      if (headerValue.includes(value)) {
        return true;
      }

      // Basic auth uses base64 encoding
      if (/^(authorization|proxy-authorization)$/i.test(headerName)) {
        const decoded = decodeBasicAuth(headerValue);
        if (decoded && decoded.includes(value)) {
          return true;
        }
      }
    }
  }

  return false;
}

function requestContainsRevokedOrDeletedSecretValuesInHeaders(
  headers: Headers,
  forbiddenValues: string[],
  allowedValues: string[],
): boolean {
  const nonEmptyForbiddenValues = forbiddenValues.filter(Boolean);
  const nonEmptyAllowedValues = allowedValues.filter(Boolean);
  if (nonEmptyForbiddenValues.length === 0) return false;

  for (const [headerName, headerValue] of headers.entries()) {
    if (!headerValue) continue;

    if (/^(authorization|proxy-authorization)$/i.test(headerName)) {
      const decoded = decodeBasicAuthStrict(headerValue);
      if (decoded) {
        if (
          containsForbiddenValueOutsideAllowedRanges(
            decoded,
            nonEmptyForbiddenValues,
            nonEmptyAllowedValues,
          )
        ) {
          return true;
        }
        continue;
      }

      if (
        containsForbiddenValueOutsideAllowedRanges(
          headerValue,
          nonEmptyForbiddenValues,
          nonEmptyAllowedValues,
        )
      ) {
        return true;
      }

      continue;
    }

    if (
      containsForbiddenValueOutsideAllowedRanges(
        headerValue,
        nonEmptyForbiddenValues,
        nonEmptyAllowedValues,
      )
    ) {
      return true;
    }
  }

  return false;
}

function decodeBasicAuth(value: string): string | null {
  const match = value.match(/^(Basic)(\s+)(\S+)(\s*)$/i);
  if (!match) return null;

  const token = match[3];
  try {
    return Buffer.from(token, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function decodeBasicAuthStrict(value: string): string | null {
  const match = value.match(/^(Basic)(\s+)(\S+)(\s*)$/i);
  if (!match) return null;

  const token = match[3];
  if (!token || !/^[A-Za-z0-9+/]+={0,2}$/.test(token)) {
    return null;
  }

  if (token.length % 4 === 1) {
    return null;
  }

  const decoded = Buffer.from(token, "base64").toString("utf8");
  const normalizedToken = stripBase64Padding(token);
  const normalizedDecoded = stripBase64Padding(
    Buffer.from(decoded, "utf8").toString("base64"),
  );

  if (normalizedDecoded !== normalizedToken) {
    return null;
  }

  return decoded;
}

function requestContainsSecretValuesInQuery(
  url: string,
  values: string[],
): boolean {
  const nonEmptyValues = values.filter(Boolean);
  if (nonEmptyValues.length === 0) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!parsed.search) return false;

  for (const [name, value] of parsed.searchParams.entries()) {
    for (const secretValue of nonEmptyValues) {
      if (name.includes(secretValue) || value.includes(secretValue)) {
        return true;
      }
    }
  }

  return false;
}

function requestContainsRevokedOrDeletedSecretValuesInQuery(
  url: string,
  forbiddenValues: string[],
  allowedValues: string[],
): boolean {
  const nonEmptyForbiddenValues = forbiddenValues.filter(Boolean);
  const nonEmptyAllowedValues = allowedValues.filter(Boolean);
  if (nonEmptyForbiddenValues.length === 0) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!parsed.search) return false;

  for (const [name, value] of parsed.searchParams.entries()) {
    if (
      containsForbiddenValueOutsideAllowedRanges(
        name,
        nonEmptyForbiddenValues,
        nonEmptyAllowedValues,
      ) ||
      containsForbiddenValueOutsideAllowedRanges(
        value,
        nonEmptyForbiddenValues,
        nonEmptyAllowedValues,
      )
    ) {
      return true;
    }
  }

  return false;
}

function containsForbiddenValueOutsideAllowedRanges(
  container: string,
  forbiddenValues: string[],
  allowedValues: string[],
): boolean {
  if (!container) return false;

  const allowedRanges = allowedValues.flatMap((value) =>
    collectStringMatchRanges(container, value),
  );

  for (const forbiddenValue of forbiddenValues) {
    for (const range of collectStringMatchRanges(container, forbiddenValue)) {
      if (!isRangeCoveredByAllowedValue(range, allowedRanges)) {
        return true;
      }
    }
  }

  return false;
}

function collectStringMatchRanges(
  container: string,
  search: string,
): Array<{ start: number; end: number }> {
  if (!search) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  let start = container.indexOf(search);

  while (start !== -1) {
    ranges.push({ start, end: start + search.length });
    start = container.indexOf(search, start + 1);
  }

  return ranges;
}

function isRangeCoveredByAllowedValue(
  candidate: { start: number; end: number },
  allowedRanges: Array<{ start: number; end: number }>,
): boolean {
  return allowedRanges.some(
    (allowed) => allowed.start <= candidate.start && allowed.end >= candidate.end,
  );
}

function replaceSecretPlaceholdersInHeaders(
  incomingHeaders: Headers,
  hostname: string,
  entries: SecretEntry[],
): Headers {
  if (entries.length === 0) return incomingHeaders;

  let headers: Headers | null = null;

  for (const [headerName, value] of incomingHeaders.entries()) {
    let updated = value;

    // Plaintext placeholder replacement (eg: `Authorization: Bearer $TOKEN`).
    updated = replaceSecretPlaceholdersInString(updated, hostname, entries);

    // Basic auth uses base64 encoding of `username:password`, so placeholders
    // won't appear in the header value directly.
    updated = replaceBasicAuthSecretPlaceholders(
      headerName,
      updated,
      hostname,
      entries,
    );

    if (updated !== value) {
      if (!headers) {
        headers = new Headers(incomingHeaders);
      }
      headers.set(headerName, updated);
    }
  }

  return headers ?? incomingHeaders;
}

function replaceSecretPlaceholdersInUrlParameters(
  url: string,
  hostname: string,
  entries: SecretEntry[],
  enabled: boolean,
): string {
  if (!enabled || entries.length === 0) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (!parsed.search) return url;

  const updatedParams = new URLSearchParams();
  let changed = false;

  for (const [name, value] of parsed.searchParams.entries()) {
    const updatedName = replaceSecretPlaceholdersInString(
      name,
      hostname,
      entries,
    );
    const updatedValue = replaceSecretPlaceholdersInString(
      value,
      hostname,
      entries,
    );
    if (updatedName !== name || updatedValue !== value) changed = true;
    updatedParams.append(updatedName, updatedValue);
  }

  if (!changed) return url;

  const nextSearch = updatedParams.toString();
  parsed.search = nextSearch ? `?${nextSearch}` : "";
  return parsed.toString();
}

function replaceBasicAuthSecretPlaceholders(
  headerName: string,
  headerValue: string,
  hostname: string,
  entries: SecretEntry[],
): string {
  // Only touch request headers that are expected to carry credentials.
  if (!/^(authorization|proxy-authorization)$/i.test(headerName)) {
    return headerValue;
  }

  const match = headerValue.match(/^(Basic)(\s+)(\S+)(\s*)$/i);
  if (!match) return headerValue;

  const scheme = match[1];
  const whitespace = match[2];
  const token = match[3];
  const trailing = match[4] ?? "";

  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64").toString("utf8");
  } catch {
    return headerValue;
  }

  const updatedDecoded = replaceSecretPlaceholdersInString(
    decoded,
    hostname,
    entries,
  );
  if (updatedDecoded === decoded) return headerValue;

  const updatedToken = Buffer.from(updatedDecoded, "utf8").toString("base64");
  return `${scheme}${whitespace}${updatedToken}${trailing}`;
}

function replaceSecretPlaceholdersInString(
  value: string,
  hostname: string,
  entries: SecretEntry[],
): string {
  let updated = value;

  for (const entry of entries) {
    if (!updated.includes(entry.placeholder)) continue;
    if (entry.deleted) {
      updated = replaceAll(updated, entry.placeholder, "");
      continue;
    }

    assertSecretAllowedForHost(entry, hostname);
    updated = replaceAll(updated, entry.placeholder, entry.value);
  }

  return updated;
}

function assertSecretAllowedForHost(
  entry: SecretEntry,
  hostname: string,
): void {
  if (matchesAnyHost(hostname, entry.hosts)) return;
  throw new HttpRequestBlockedError(
    `secret ${entry.name} not allowed for host: ${hostname || "unknown"}`,
  );
}

function isInternalAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const octets = ip.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [a, b] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 255) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const hextets = parseIPv6Hextets(ip);
  if (!hextets) return false;

  const isAllZero = hextets.every((value) => value === 0);
  const isLoopback =
    hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1;
  if (isAllZero || isLoopback) return true;

  if ((hextets[0] & 0xfe00) === 0xfc00) return true;
  if ((hextets[0] & 0xffc0) === 0xfe80) return true;

  const mapped = extractIPv4Mapped(hextets);
  if (mapped && isPrivateIPv4(mapped)) return true;

  return false;
}

function stripBase64Padding(value: string): string {
  return value.replace(/=+$/g, "");
}

function uniqueHosts(hosts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const host of hosts) {
    const normalized = normalizeHostnamePattern(host);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function mergeAllowedHosts(
  configuredAllowedHosts: string[],
  allowedInternalHosts: string[],
): string[] {
  if (configuredAllowedHosts.includes("*")) {
    return ["*"];
  }

  return uniqueHosts([...configuredAllowedHosts, ...allowedInternalHosts]);
}

function addUniqueString(values: string[], value: string): string[] {
  if (!value || values.includes(value)) {
    return values;
  }
  return [...values, value];
}

function replaceAll(
  value: string,
  search: string,
  replacement: string,
): string {
  if (!search) return value;
  return value.split(search).join(replacement);
}

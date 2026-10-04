import crypto from "node:crypto";

import {
  ON_REQUEST_EARLY_POLICY_SAFE,
  type HttpHooks,
} from "../qemu/contracts.ts";
import { HttpRequestBlockedError } from "./utils.ts";
import { isInternalIpAddress } from "../utils/ip.ts";
import { matchesAnyHost, normalizeHostnamePattern } from "../host/patterns.ts";

export type SecretDefinition = {
  /** host patterns this secret may be sent to */
  hosts: string[];
  /** secret value */
  value: string;
  /** guest-visible placeholder value or generator */
  placeholder?: string | (() => string);
};

export type MakePlaceholderFuncOptions = {
  /** literal prefix before random characters */
  prefix?: string;
  /** literal suffix after random characters */
  suffix?: string;
  /** random character count */
  length: number;
  /** random character alphabet (default: `HEX_ALPHABET`) */
  alphabet?: string;
};

/** hexadecimal lowercase alphabet */
export const HEX_ALPHABET = "0123456789abcdef";
/** lowercase ASCII alphabet */
export const LOWERCASE_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
/** uppercase ASCII alphabet */
export const UPPERCASE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** RFC 4648 base32 alphabet without padding */
export const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** RFC 4648 base32hex alphabet without padding */
export const BASE32_HEX_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
/** uppercase, lowercase, and digit alphabet */
export const BASE62_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** base64url alphabet without padding */
export const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export type SecretPlaceholderMode = "shared" | "unique";

export type CreateHttpHooksOptions = {
  /** allowed host patterns (omitted = allow all, explicit empty = deny all) */
  allowedHosts?: string[];
  /** host patterns allowed to resolve to internal ip ranges */
  allowedInternalHosts?: string[];
  /** secret definitions keyed by env var name */
  secrets?: Record<string, SecretDefinition>;
  /** placeholder replacement in URL query string (default: false) */
  replaceSecretsInQuery?: boolean;
  /** secret placeholder strategy (default: `shared`) */
  secretPlaceholderMode?: SecretPlaceholderMode;
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
  identifier: string;
  placeholder: string;
  value: string;
  revokedValues: string[];
  hosts: string[];
  deleted: boolean;
};

type SecretReplacementContext = {
  mode: SecretPlaceholderMode;
  marker?: string;
};

export function makePlaceholderFunc(
  options: MakePlaceholderFuncOptions,
): () => string {
  const prefix = options.prefix ?? "";
  const suffix = options.suffix ?? "";
  const length = options.length;
  const alphabet = options.alphabet ?? HEX_ALPHABET;

  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("placeholder length must be a non-negative integer");
  }
  if (alphabet.length === 0) {
    throw new Error("placeholder alphabet must not be empty");
  }

  return () => {
    let random = "";
    for (let i = 0; i < length; i++) {
      random += alphabet[crypto.randomInt(alphabet.length)];
    }
    return `${prefix}${random}${suffix}`;
  };
}

export function createHttpHooks(
  options: CreateHttpHooksOptions = {},
): CreateHttpHooksResult {
  const env: Record<string, string> = {};
  const secretPlaceholderMode = options.secretPlaceholderMode ?? "shared";
  const secretMarker =
    secretPlaceholderMode === "shared" ? makeSecretMarker() : undefined;
  const blockInternalRanges = options.blockInternalRanges ?? true;
  const configuredAllowedHosts =
    options.allowedHosts === undefined
      ? ["*"]
      : uniqueHosts(options.allowedHosts);
  const secretEntries = new Map<string, SecretEntry>();

  for (const [name, secret] of Object.entries(options.secrets ?? {})) {
    const identifier = makeSecretIdentifier(name);
    assertSecretIdentifierIsSafe(name, identifier, secretEntries.values());
    const placeholder = resolveSecretPlaceholder(
      name,
      secret,
      secretPlaceholderMode,
      secretMarker,
      identifier,
    );
    if (
      !(secretPlaceholderMode === "shared" && secret.placeholder === undefined)
    ) {
      assertSecretPlaceholderIsSafe(
        name,
        placeholder,
        secret.value,
        secretEntries.values(),
      );
    }
    env[name] = placeholder;
    secretEntries.set(name, {
      name,
      identifier,
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

  const getSecretEntries = (): SecretEntry[] =>
    Array.from(secretEntries.values());

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
      if (update.value === entry.placeholder) {
        throw new Error(`secret value must not equal placeholder: ${name}`);
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
    const replacementContext: SecretReplacementContext = {
      mode: secretPlaceholderMode,
      marker: secretMarker,
    };

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
      replacementContext,
    );
    const url = replaceSecretPlaceholdersInUrlParameters(
      request.url,
      hostname,
      entries,
      options.replaceSecretsInQuery ?? false,
      replacementContext,
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
        isInternalIpAddress(info.ip) &&
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

function resolveSecretPlaceholder(
  name: string,
  secret: SecretDefinition,
  mode: SecretPlaceholderMode,
  marker: string | undefined,
  identifier: string,
): string {
  if (mode === "shared" && !marker) {
    throw new Error("shared secret placeholder mode requires a marker");
  }

  const generatedPlaceholder =
    mode === "shared"
      ? `${marker}.${identifier}`
      : makeDefaultSecretPlaceholder();
  const placeholder =
    secret.placeholder === undefined
      ? generatedPlaceholder
      : typeof secret.placeholder === "function"
        ? secret.placeholder()
        : secret.placeholder;

  if (typeof placeholder !== "string" || placeholder.length === 0) {
    throw new Error(`invalid placeholder for secret: ${name}`);
  }

  return placeholder;
}

function makeDefaultSecretPlaceholder(): string {
  return `GONDOLIN_SECRET_${crypto.randomBytes(24).toString("hex")}`;
}

function makeSecretMarker(): string {
  return crypto.randomBytes(24).toString("hex");
}

function makeSecretIdentifier(name: string): string {
  const identifier = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
  if (!identifier) {
    throw new Error(`invalid secret identifier for ${name}`);
  }
  return identifier;
}

function assertSecretIdentifierIsSafe(
  name: string,
  identifier: string,
  existingEntries: Iterable<SecretEntry>,
): void {
  for (const entry of existingEntries) {
    if (identifier === entry.identifier) {
      throw new Error(
        `secret identifier for ${name} collides with secret identifier for ${entry.name}`,
      );
    }
  }
}

function assertSecretPlaceholderIsSafe(
  name: string,
  placeholder: string,
  value: string,
  existingEntries: Iterable<SecretEntry>,
): void {
  if (value === placeholder) {
    throw new Error(`secret value must not equal placeholder: ${name}`);
  }

  for (const entry of existingEntries) {
    if (placeholder === entry.placeholder) {
      throw new Error(`duplicate secret placeholder: ${placeholder}`);
    }
    if (
      placeholder.includes(entry.placeholder) ||
      entry.placeholder.includes(placeholder)
    ) {
      throw new Error(
        `secret placeholder for ${name} overlaps with secret placeholder for ${entry.name}`,
      );
    }
  }
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

    if (
      checkQuery &&
      requestContainsSecretValuesInQuery(request.url, [entry.value])
    ) {
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
        if (decoded?.includes(value)) {
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
    (allowed) =>
      allowed.start <= candidate.start && allowed.end >= candidate.end,
  );
}

function replaceSecretPlaceholdersInHeaders(
  incomingHeaders: Headers,
  hostname: string,
  entries: SecretEntry[],
  context: SecretReplacementContext,
): Headers {
  if (entries.length === 0) return incomingHeaders;

  let headers: Headers | null = null;

  for (const [headerName, value] of incomingHeaders.entries()) {
    let updated = value;

    // Plaintext placeholder replacement (eg: `Authorization: Bearer $TOKEN`).
    updated = replaceSecretPlaceholdersInString(
      updated,
      hostname,
      entries,
      context,
    );

    // Basic auth uses base64 encoding of `username:password`, so placeholders
    // won't appear in the header value directly.
    updated = replaceBasicAuthSecretPlaceholders(
      headerName,
      updated,
      hostname,
      entries,
      context,
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
  context: SecretReplacementContext,
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
      context,
    );
    const updatedValue = replaceSecretPlaceholdersInString(
      value,
      hostname,
      entries,
      context,
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
  context: SecretReplacementContext,
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
    context,
  );
  if (updatedDecoded === decoded) return headerValue;

  const updatedToken = Buffer.from(updatedDecoded, "utf8").toString("base64");
  return `${scheme}${whitespace}${updatedToken}${trailing}`;
}

function replaceSecretPlaceholdersInString(
  value: string,
  hostname: string,
  entries: SecretEntry[],
  context: SecretReplacementContext,
): string {
  const secretValueRanges = entries.flatMap((entry) =>
    collectStringMatchRanges(value, entry.value),
  );
  const replacements = [
    ...collectMarkerSecretReferenceRanges(value, entries, context),
    ...collectLegacySecretReferenceRanges(value, entries, context),
  ].filter(
    (replacement) =>
      !isRangeCoveredByAllowedValue(replacement, secretValueRanges),
  );

  return applySecretReplacements(value, hostname, replacements);
}

function collectLegacySecretReferenceRanges(
  value: string,
  entries: SecretEntry[],
  context: SecretReplacementContext,
): Array<{ start: number; end: number; entry: SecretEntry }> {
  const markerPlaceholders =
    context.mode === "shared" && context.marker
      ? new Set(entries.map((entry) => `${context.marker}.${entry.identifier}`))
      : null;
  const replacements: Array<{
    start: number;
    end: number;
    entry: SecretEntry;
  }> = [];

  for (const entry of entries) {
    if (markerPlaceholders?.has(entry.placeholder)) continue;
    for (const range of collectStringMatchRanges(value, entry.placeholder)) {
      replacements.push({ ...range, entry });
    }
  }

  return replacements;
}

function applySecretReplacements(
  value: string,
  hostname: string,
  replacements: Array<{ start: number; end: number; entry: SecretEntry }>,
): string {
  if (replacements.length === 0) return value;

  replacements.sort((a, b) => a.start - b.start || b.end - a.end);

  let updated = "";
  let offset = 0;

  for (const replacement of replacements) {
    if (replacement.start < offset) continue;

    updated += value.slice(offset, replacement.start);

    if (replacement.entry.deleted) {
      updated += "";
    } else {
      assertSecretAllowedForHost(replacement.entry, hostname);
      updated += replacement.entry.value;
    }

    offset = replacement.end;
  }

  return updated + value.slice(offset);
}

function collectMarkerSecretReferenceRanges(
  value: string,
  entries: SecretEntry[],
  context: SecretReplacementContext,
): Array<{ start: number; end: number; entry: SecretEntry }> {
  if (context.mode !== "shared" || !context.marker) {
    return [];
  }

  const byIdentifier = new Map(
    entries
      .filter(
        (entry) =>
          entry.placeholder === `${context.marker}.${entry.identifier}`,
      )
      .map((entry) => [entry.identifier, entry]),
  );
  const replacements: Array<{
    start: number;
    end: number;
    entry: SecretEntry;
  }> = [];
  const prefix = `${context.marker}.`;

  let searchFrom = 0;
  while (searchFrom < value.length) {
    const start = value.indexOf(prefix, searchFrom);
    if (start === -1) break;

    const identifierStart = start + prefix.length;
    let identifierEnd = identifierStart;

    while (identifierEnd < value.length) {
      const ch = value[identifierEnd]!;
      if (!/[A-Za-z0-9_-]/.test(ch)) break;
      identifierEnd += 1;
    }

    const identifier = value.slice(identifierStart, identifierEnd);
    const entry = byIdentifier.get(identifier);
    if (identifier && entry) {
      replacements.push({ start, end: identifierEnd, entry });
    }

    searchFrom = identifierStart;
  }

  return replacements;
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

import net from "net";
import dns from "dns";
import { Agent } from "undici";
import forge from "node-forge";

import type {
  HeaderValue,
  HttpHookRequest,
  HttpHooks,
  HttpIpAllowInfo,
  HttpResponseHeaders,
} from "./qemu-net";

export class HttpRequestBlockedError extends Error {
  status: number;
  statusText: string;

  constructor(message = "request blocked", status = 403, statusText = "Forbidden") {
    super(message);
    this.name = "HttpRequestBlockedError";
    this.status = status;
    this.statusText = statusText;
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

const DEFAULT_SHARED_UPSTREAM_CONNECTIONS_PER_ORIGIN = 16;
const DEFAULT_SHARED_UPSTREAM_MAX_ORIGINS = 512;
const DEFAULT_SHARED_UPSTREAM_IDLE_TTL_MS = 30 * 1000;

export function stripHopByHopHeaders<T extends HeaderValue>(
  this: any,
  headers: Record<string, T>
): Record<string, T> {
  const connectionValue = headers["connection"];
  const connection = Array.isArray(connectionValue)
    ? connectionValue.join(",")
    : typeof connectionValue === "string"
      ? connectionValue
      : "";

  const connectionTokens = new Set<string>();
  if (connection) {
    for (const token of connection.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized) connectionTokens.add(normalized);
    }
  }

  const output: Record<string, T> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalizedName)) continue;
    if (connectionTokens.has(normalizedName)) continue;
    output[normalizedName] = value;
  }
  return output;
}

export function stripHopByHopHeadersForWebSocket(
  this: any,
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = { ...headers };

  // Unlike normal HTTP proxying, WebSocket handshakes require forwarding Connection/Upgrade
  // Still strip proxy-only and framing hop-by-hop headers
  delete out["keep-alive"];
  delete out["proxy-connection"];
  delete out["proxy-authenticate"];
  delete out["proxy-authorization"];

  // No request bodies for WebSocket handshake
  delete out["content-length"];
  delete out["transfer-encoding"];
  delete out["expect"];

  // Avoid forwarding framed/trailer-related hop-by-hop headers
  delete out["te"];
  delete out["trailer"];

  // Apply Connection: token stripping, but keep Upgrade + WebSocket-specific headers
  const connection = out["connection"]?.toLowerCase() ?? "";
  const tokens = connection
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const keepNominated = new Set([
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ]);

  for (const token of tokens) {
    if (keepNominated.has(token)) continue;
    delete out[token];
  }

  return out;
}

type LookupEntry = {
  address: string;
  family: 4 | 6;
};

type LookupResult = string | dns.LookupAddress[];

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: LookupResult,
  family?: number
) => void;

type LookupFn = (
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, address: LookupResult, family?: number) => void
) => void;

export function createLookupGuard(
  info: {
    hostname: string;
    port: number;
    protocol: "http" | "https";
  },
  isIpAllowed: NonNullable<HttpHooks["isIpAllowed"]>,
  lookupFn: LookupFn = (dns.lookup as unknown as LookupFn).bind(dns)
) {
  return (
    hostname: string,
    options: dns.LookupOneOptions | dns.LookupAllOptions | number,
    callback: LookupCallback
  ) => {
    const normalizedOptions = normalizeLookupOptions(options);
    lookupFn(hostname, normalizedOptions, (err, address, family) => {
      if (err) {
        callback(err, normalizeLookupFailure(normalizedOptions));
        return;
      }

      void (async () => {
        const entries = normalizeLookupEntries(address, family);
        if (entries.length === 0) {
          callback(new Error("DNS lookup returned no addresses"), normalizeLookupFailure(normalizedOptions));
          return;
        }

        const allowedEntries: LookupEntry[] = [];

        for (const entry of entries) {
          const allowed = await isIpAllowed({
            hostname: info.hostname,
            ip: entry.address,
            family: entry.family,
            port: info.port,
            protocol: info.protocol,
          } satisfies HttpIpAllowInfo);
          if (allowed) {
            if (!normalizedOptions.all) {
              callback(null, entry.address, entry.family);
              return;
            }
            allowedEntries.push(entry);
          }
        }

        if (normalizedOptions.all && allowedEntries.length > 0) {
          callback(
            null,
            allowedEntries.map((entry) => ({
              address: entry.address,
              family: entry.family,
            }))
          );
          return;
        }

        callback(
          new HttpRequestBlockedError(`blocked by policy: ${info.hostname}`),
          normalizeLookupFailure(normalizedOptions)
        );
      })().catch((error) => {
        callback(error as Error, normalizeLookupFailure(normalizedOptions));
      });
    });
  };
}

export function normalizeLookupEntries(address: LookupResult | undefined, family?: number): LookupEntry[] {
  if (!address) return [];

  if (Array.isArray(address)) {
    return address
      .map((entry) => {
        const family = entry.family === 6 ? 6 : 4;
        return {
          address: entry.address,
          family: family as 4 | 6,
        };
      })
      .filter((entry) => Boolean(entry.address));
  }

  const resolvedFamily = family === 6 || family === 4 ? family : net.isIP(address);
  if (resolvedFamily !== 4 && resolvedFamily !== 6) return [];
  return [{ address, family: resolvedFamily }];
}

export function normalizeLookupOptions(
  options: dns.LookupOneOptions | dns.LookupAllOptions | number
): dns.LookupOneOptions | dns.LookupAllOptions {
  if (typeof options === "number") {
    return { family: options };
  }
  return options;
}

export function normalizeLookupFailure(options: dns.LookupOneOptions | dns.LookupAllOptions): LookupResult {
  return options.all ? [] : "";
}

function normalizeOriginPort(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === "https:") return "443";
  if (url.protocol === "http:") return "80";
  return "";
}

function isSameOrigin(a: URL, b: URL): boolean {
  return (
    a.protocol === b.protocol &&
    a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
    normalizeOriginPort(a) === normalizeOriginPort(b)
  );
}

type FetchResponseLike = {
  status: number;
  headers: { get: (name: string) => string | null };
};

export function getRedirectUrl(response: FetchResponseLike, currentUrl: URL): URL | null {
  if (![301, 302, 303, 307, 308].includes(response.status)) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    return new URL(location, currentUrl);
  } catch {
    return null;
  }
}

export function applyRedirectRequest(
  request: HttpHookRequest,
  status: number,
  sourceUrl: URL,
  redirectUrl: URL
): HttpHookRequest {
  let method = request.method;
  let body = request.body;

  if (status === 303 && method !== "GET" && method !== "HEAD") {
    method = "GET";
    body = null;
  } else if ((status === 301 || status === 302) && method === "POST") {
    method = "GET";
    body = null;
  }

  const headers = { ...request.headers };
  if (headers.host) {
    headers.host = redirectUrl.host;
  }

  if (!isSameOrigin(sourceUrl, redirectUrl)) {
    // Do not forward credentials across origins
    delete headers.authorization;
    delete headers.cookie;
  }

  if (!body || method === "GET" || method === "HEAD") {
    delete headers["content-length"];
    delete headers["content-type"];
    delete headers["transfer-encoding"];
  }

  return {
    method,
    url: redirectUrl.toString(),
    headers,
    body,
  };
}

type SharedDispatcherEntry = {
  dispatcher: Agent;
  lastUsedAt: number;
};

export function closeSharedDispatchers(this: any) {
  for (const entry of (this.sharedDispatchers as Map<string, SharedDispatcherEntry>).values()) {
    try {
      entry.dispatcher.close();
    } catch {
      // ignore
    }
  }
  (this.sharedDispatchers as Map<string, SharedDispatcherEntry>).clear();
}

function pruneSharedDispatchers(this: any, now = Date.now()) {
  if ((this.sharedDispatchers as Map<string, SharedDispatcherEntry>).size === 0) return;

  for (const [key, entry] of this.sharedDispatchers as Map<string, SharedDispatcherEntry>) {
    if (now - entry.lastUsedAt <= DEFAULT_SHARED_UPSTREAM_IDLE_TTL_MS) continue;
    (this.sharedDispatchers as Map<string, SharedDispatcherEntry>).delete(key);
    try {
      entry.dispatcher.close();
    } catch {
      // ignore
    }
  }
}

function evictSharedDispatchersIfNeeded(this: any) {
  while ((this.sharedDispatchers as Map<string, SharedDispatcherEntry>).size > DEFAULT_SHARED_UPSTREAM_MAX_ORIGINS) {
    const oldestKey = (this.sharedDispatchers as Map<string, SharedDispatcherEntry>).keys().next().value as
      | string
      | undefined;
    if (!oldestKey) break;
    const oldest = (this.sharedDispatchers as Map<string, SharedDispatcherEntry>).get(oldestKey);
    (this.sharedDispatchers as Map<string, SharedDispatcherEntry>).delete(oldestKey);
    try {
      oldest?.dispatcher.close();
    } catch {
      // ignore
    }
  }
}

export function getCheckedDispatcher(
  this: any,
  info: {
    hostname: string;
    port: number;
    protocol: "http" | "https";
  }
): Agent | null {
  const isIpAllowed = this.options.httpHooks?.isIpAllowed as HttpHooks["isIpAllowed"] | undefined;
  if (!isIpAllowed) return null;

  pruneSharedDispatchers.call(this);

  const key = `${info.protocol}://${info.hostname}:${info.port}`;
  const cached = (this.sharedDispatchers as Map<string, SharedDispatcherEntry>).get(key);
  if (cached) {
    cached.lastUsedAt = Date.now();
    // LRU: move to map tail
    (this.sharedDispatchers as Map<string, SharedDispatcherEntry>).delete(key);
    (this.sharedDispatchers as Map<string, SharedDispatcherEntry>).set(key, cached);
    return cached.dispatcher;
  }

  const lookupFn = createLookupGuard(
    {
      hostname: info.hostname,
      port: info.port,
      protocol: info.protocol,
    },
    isIpAllowed
  );

  const dispatcher = new Agent({
    connect: { lookup: lookupFn },
    connections: DEFAULT_SHARED_UPSTREAM_CONNECTIONS_PER_ORIGIN,
  });

  (this.sharedDispatchers as Map<string, SharedDispatcherEntry>).set(key, {
    dispatcher,
    lastUsedAt: Date.now(),
  });
  evictSharedDispatchersIfNeeded.call(this);

  return dispatcher;
}

export function caCertVerifiesLeaf(caCert: forge.pki.Certificate, leafCert: forge.pki.Certificate): boolean {
  try {
    return caCert.verify(leafCert);
  } catch {
    return false;
  }
}

export function privateKeyMatchesLeafCert(keyPem: string, leafCert: forge.pki.Certificate): boolean {
  try {
    const privateKey = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
    const publicKey = leafCert.publicKey as forge.pki.rsa.PublicKey;
    return (
      privateKey.n.toString(16) === publicKey.n.toString(16) &&
      privateKey.e.toString(16) === publicKey.e.toString(16)
    );
  } catch {
    return false;
  }
}

export function headersToRecord(this: any, headers: Headers): HttpResponseHeaders {
  const record: HttpResponseHeaders = {};

  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });

  // undici/Node fetch supports multiple Set-Cookie values via getSetCookie()
  const anyHeaders = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    const cookies = anyHeaders.getSetCookie();
    if (cookies.length === 1) {
      record["set-cookie"] = cookies[0]!;
    } else if (cookies.length > 1) {
      record["set-cookie"] = cookies;
    }
  }

  return record;
}

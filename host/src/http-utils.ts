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
  QemuNetworkBackend,
} from "./qemu-net";

export class HttpRequestBlockedError extends Error {
  status: number;
  statusText: string;

  constructor(
    message = "request blocked",
    status = 403,
    statusText = "Forbidden",
  ) {
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
  headers: Record<string, T>,
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
  headers: Record<string, string>,
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
  family?: number,
) => void;

type LookupFn = (
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: LookupResult,
    family?: number,
  ) => void,
) => void;

export function createLookupGuard(
  info: {
    hostname: string;
    port: number;
    protocol: "http" | "https";
  },
  isIpAllowed: NonNullable<HttpHooks["isIpAllowed"]>,
  lookupFn: LookupFn = (dns.lookup as unknown as LookupFn).bind(dns),
) {
  return (
    hostname: string,
    options: dns.LookupOneOptions | dns.LookupAllOptions | number,
    callback: LookupCallback,
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
          callback(
            new Error("DNS lookup returned no addresses"),
            normalizeLookupFailure(normalizedOptions),
          );
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
            })),
          );
          return;
        }

        callback(
          new HttpRequestBlockedError(`blocked by policy: ${info.hostname}`),
          normalizeLookupFailure(normalizedOptions),
        );
      })().catch((error) => {
        callback(error as Error, normalizeLookupFailure(normalizedOptions));
      });
    });
  };
}

export function normalizeLookupEntries(
  address: LookupResult | undefined,
  family?: number,
): LookupEntry[] {
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

  const resolvedFamily =
    family === 6 || family === 4 ? family : net.isIP(address);
  if (resolvedFamily !== 4 && resolvedFamily !== 6) return [];
  return [{ address, family: resolvedFamily }];
}

export function normalizeLookupOptions(
  options: dns.LookupOneOptions | dns.LookupAllOptions | number,
): dns.LookupOneOptions | dns.LookupAllOptions {
  if (typeof options === "number") {
    return { family: options };
  }
  return options;
}

export function normalizeLookupFailure(
  options: dns.LookupOneOptions | dns.LookupAllOptions,
): LookupResult {
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

export function getRedirectUrl(
  response: FetchResponseLike,
  currentUrl: URL,
): URL | null {
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
  redirectUrl: URL,
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

export function closeSharedDispatchers(backend: QemuNetworkBackend) {
  for (const entry of backend.http.sharedDispatchers.values()) {
    try {
      entry.dispatcher.close();
    } catch {
      // ignore
    }
  }
  backend.http.sharedDispatchers.clear();
}

function pruneSharedDispatchers(backend: QemuNetworkBackend, now = Date.now()) {
  if (backend.http.sharedDispatchers.size === 0) return;

  for (const [key, entry] of backend.http.sharedDispatchers) {
    if (now - entry.lastUsedAt <= DEFAULT_SHARED_UPSTREAM_IDLE_TTL_MS) continue;
    backend.http.sharedDispatchers.delete(key);
    try {
      entry.dispatcher.close();
    } catch {
      // ignore
    }
  }
}

function evictSharedDispatchersIfNeeded(backend: QemuNetworkBackend) {
  while (
    backend.http.sharedDispatchers.size > DEFAULT_SHARED_UPSTREAM_MAX_ORIGINS
  ) {
    const oldestKey = backend.http.sharedDispatchers.keys().next().value as
      | string
      | undefined;
    if (!oldestKey) break;
    const oldest = backend.http.sharedDispatchers.get(oldestKey);
    backend.http.sharedDispatchers.delete(oldestKey);
    try {
      oldest?.dispatcher.close();
    } catch {
      // ignore
    }
  }
}

export function getCheckedDispatcher(
  backend: QemuNetworkBackend,
  info: {
    hostname: string;
    port: number;
    protocol: "http" | "https";
  },
): Agent | null {
  const isIpAllowed = backend.options.httpHooks?.isIpAllowed as
    | HttpHooks["isIpAllowed"]
    | undefined;
  if (!isIpAllowed) return null;

  pruneSharedDispatchers(backend);

  const key = `${info.protocol}://${info.hostname}:${info.port}`;
  const cached = backend.http.sharedDispatchers.get(key);
  if (cached) {
    cached.lastUsedAt = Date.now();
    // LRU: move to map tail
    backend.http.sharedDispatchers.delete(key);
    backend.http.sharedDispatchers.set(key, cached);
    return cached.dispatcher;
  }

  const lookupFn = createLookupGuard(
    {
      hostname: info.hostname,
      port: info.port,
      protocol: info.protocol,
    },
    isIpAllowed,
  );

  const dispatcher = new Agent({
    connect: { lookup: lookupFn },
    connections: DEFAULT_SHARED_UPSTREAM_CONNECTIONS_PER_ORIGIN,
  });

  backend.http.sharedDispatchers.set(key, {
    dispatcher,
    lastUsedAt: Date.now(),
  });
  evictSharedDispatchersIfNeeded(backend);

  return dispatcher;
}

export function caCertVerifiesLeaf(
  caCert: forge.pki.Certificate,
  leafCert: forge.pki.Certificate,
): boolean {
  try {
    return caCert.verify(leafCert);
  } catch {
    return false;
  }
}

export function privateKeyMatchesLeafCert(
  keyPem: string,
  leafCert: forge.pki.Certificate,
): boolean {
  try {
    const privateKey = forge.pki.privateKeyFromPem(
      keyPem,
    ) as forge.pki.rsa.PrivateKey;
    const publicKey = leafCert.publicKey as forge.pki.rsa.PublicKey;
    return (
      privateKey.n.toString(16) === publicKey.n.toString(16) &&
      privateKey.e.toString(16) === publicKey.e.toString(16)
    );
  } catch {
    return false;
  }
}

export function headersToRecord(
  this: any,
  headers: Headers,
): HttpResponseHeaders {
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

export type HttpRequestData = {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  body: Buffer;
};

export class HttpReceiveBuffer {
  private readonly chunks: Buffer[] = [];
  private totalBytes = 0;

  get length() {
    return this.totalBytes;
  }

  append(chunk: Buffer) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
  }

  resetTo(buffer: Buffer) {
    this.chunks.length = 0;
    this.totalBytes = 0;
    this.append(buffer);
  }

  /**
   * Find the start offset of the first "\r\n\r\n" sequence or -1 if missing
   */
  findHeaderEnd(maxSearchBytes: number): number {
    const pattern = [0x0d, 0x0a, 0x0d, 0x0a];
    let matched = 0;
    let index = 0;

    for (const chunk of this.chunks) {
      for (let i = 0; i < chunk.length; i += 1) {
        if (index >= maxSearchBytes) return -1;
        const b = chunk[i]!;

        if (b === pattern[matched]) {
          matched += 1;
          if (matched === pattern.length) {
            return index - (pattern.length - 1);
          }
        } else {
          // Only possible overlap is a new '\r'.
          matched = b === pattern[0] ? 1 : 0;
        }

        index += 1;
      }
    }

    return -1;
  }

  /**
   * Copies the first `n` bytes into a contiguous Buffer
   */
  prefix(n: number): Buffer {
    if (n <= 0) return Buffer.alloc(0);
    if (n >= this.totalBytes) return this.toBuffer();

    const out = Buffer.allocUnsafe(n);
    let written = 0;

    for (const chunk of this.chunks) {
      if (written >= n) break;
      const remaining = n - written;
      const take = Math.min(remaining, chunk.length);
      chunk.copy(out, written, 0, take);
      written += take;
    }

    return out;
  }

  /**
   * Copies the bytes from `start` (inclusive) to the end into a contiguous Buffer
   */
  suffix(start: number): Buffer {
    if (start <= 0) return this.toBuffer();
    if (start >= this.totalBytes) return Buffer.alloc(0);

    const outLen = this.totalBytes - start;
    const out = Buffer.allocUnsafe(outLen);
    let written = 0;
    let skipped = 0;

    for (const chunk of this.chunks) {
      if (skipped + chunk.length <= start) {
        skipped += chunk.length;
        continue;
      }

      const chunkStart = Math.max(0, start - skipped);
      const take = chunk.length - chunkStart;
      chunk.copy(out, written, chunkStart, chunkStart + take);
      written += take;
      skipped += chunk.length;
    }

    return out;
  }

  cursor(start = 0): HttpReceiveCursor {
    return new HttpReceiveCursor(this.chunks, this.totalBytes, start);
  }

  toBuffer(): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    if (this.chunks.length === 1) return this.chunks[0]!;
    return Buffer.concat(this.chunks, this.totalBytes);
  }
}

export class HttpReceiveCursor {
  private chunkIndex = 0;
  private chunkOffset = 0;
  offset: number;

  constructor(
    private readonly chunks: Buffer[],
    private readonly totalBytes: number,
    startOffset: number,
  ) {
    this.offset = startOffset;

    let remaining = startOffset;
    while (this.chunkIndex < this.chunks.length) {
      const chunk = this.chunks[this.chunkIndex]!;
      if (remaining < chunk.length) {
        this.chunkOffset = remaining;
        break;
      }
      remaining -= chunk.length;
      this.chunkIndex += 1;
    }

    if (this.chunkIndex >= this.chunks.length && remaining !== 0) {
      // Clamp: cursor can start at end, but never beyond.
      this.offset = this.totalBytes;
      this.chunkIndex = this.chunks.length;
      this.chunkOffset = 0;
    }
  }

  private cloneState() {
    return {
      chunkIndex: this.chunkIndex,
      chunkOffset: this.chunkOffset,
      offset: this.offset,
    };
  }

  private commitState(state: {
    chunkIndex: number;
    chunkOffset: number;
    offset: number;
  }) {
    this.chunkIndex = state.chunkIndex;
    this.chunkOffset = state.chunkOffset;
    this.offset = state.offset;
  }

  private readByteFrom(state: {
    chunkIndex: number;
    chunkOffset: number;
    offset: number;
  }) {
    if (state.offset >= this.totalBytes) return null;

    while (state.chunkIndex < this.chunks.length) {
      const chunk = this.chunks[state.chunkIndex]!;
      if (state.chunkOffset < chunk.length) {
        const b = chunk[state.chunkOffset]!;
        state.chunkOffset += 1;
        state.offset += 1;
        return b;
      }
      state.chunkIndex += 1;
      state.chunkOffset = 0;
    }

    return null;
  }

  remaining() {
    return Math.max(0, this.totalBytes - this.offset);
  }

  tryConsumeSequenceIfPresent(sequence: number[]): boolean | null {
    const state = this.cloneState();

    for (const expected of sequence) {
      const b = this.readByteFrom(state);
      if (b === null) return null;
      if (b !== expected) return false;
    }

    this.commitState(state);
    return true;
  }

  tryConsumeExactSequence(sequence: number[]): boolean | null {
    const consumed = this.tryConsumeSequenceIfPresent(sequence);
    if (consumed === null) return null;
    if (!consumed) {
      throw new Error("invalid chunk terminator");
    }
    return true;
  }

  tryReadLineAscii(maxBytes: number): string | null {
    const state = this.cloneState();
    const bytes: number[] = [];

    while (true) {
      const b = this.readByteFrom(state);
      if (b === null) return null;

      if (b === 0x0d) {
        const b2 = this.readByteFrom(state);
        if (b2 === null) return null;
        if (b2 !== 0x0a) {
          throw new Error("invalid line terminator");
        }

        this.commitState(state);
        return Buffer.from(bytes).toString("ascii");
      }

      bytes.push(b);
      if (bytes.length > maxBytes) {
        throw new Error("chunk size line too large");
      }
    }
  }

  tryReadBytes(n: number): Buffer | null {
    if (n === 0) return Buffer.alloc(0);
    if (this.remaining() < n) return null;

    const state = this.cloneState();
    const firstChunk = this.chunks[state.chunkIndex];
    if (firstChunk && state.chunkOffset + n <= firstChunk.length) {
      const slice = firstChunk.subarray(
        state.chunkOffset,
        state.chunkOffset + n,
      );
      state.chunkOffset += n;
      state.offset += n;
      this.commitState(state);
      return slice;
    }

    const out = Buffer.allocUnsafe(n);
    let written = 0;

    while (written < n) {
      const chunk = this.chunks[state.chunkIndex];
      if (!chunk) return null;

      if (state.chunkOffset >= chunk.length) {
        state.chunkIndex += 1;
        state.chunkOffset = 0;
        continue;
      }

      const available = chunk.length - state.chunkOffset;
      const take = Math.min(available, n - written);
      chunk.copy(out, written, state.chunkOffset, state.chunkOffset + take);
      state.chunkOffset += take;
      state.offset += take;
      written += take;
    }

    this.commitState(state);
    return out;
  }

  tryConsumeUntilDoubleCrlf(): boolean | null {
    const pattern = [0x0d, 0x0a, 0x0d, 0x0a];
    const state = this.cloneState();
    let matched = 0;

    while (true) {
      const b = this.readByteFrom(state);
      if (b === null) return null;

      if (b === pattern[matched]) {
        matched += 1;
        if (matched === pattern.length) {
          this.commitState(state);
          return true;
        }
      } else {
        matched = b === pattern[0] ? 1 : 0;
      }
    }
  }
}

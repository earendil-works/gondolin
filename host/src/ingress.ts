import { EventEmitter } from "events";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "http";
import type { Duplex, Writable } from "stream";

import type { VirtualProvider } from "./vfs";
import type { SandboxServer } from "./sandbox-server";

const MAX_LISTENERS_FILE_BYTES = 64 * 1024;
const MAX_HTTP_HEADER_BYTES = 64 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

class ListenersFileTooLargeError extends Error {
  /** stable identifier for listeners size-cap violations */
  readonly code = "LISTENERS_FILE_TOO_LARGE";

  constructor() {
    super("listeners file too large");
    this.name = "ListenersFileTooLargeError";
  }
}

export type IngressRoute = {
  /** external path prefix (must start with "/") */
  prefix: string;
  /** guest loopback port */
  port: number;
  /** whether to strip prefix (default: true) */
  stripPrefix: boolean;
};

export type ParsedListenersFile = {
  routes: IngressRoute[];
};

export function parseListenersFile(text: string): ParsedListenersFile {
  const routes: IngressRoute[] = [];

  // Be tolerant of NUL padding (can happen with some file update patterns)
  text = text.replace(/\0/g, "");

  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    let line = lines[lineNo]!;
    const hash = line.indexOf("#");
    if (hash !== -1) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;

    const parts = line.split(/\s+/g);
    if (parts.length < 2) {
      throw new Error(`invalid listeners file line ${lineNo + 1}: expected '<prefix> <backend>'`);
    }

    const prefix = parts[0]!;
    const backend = parts[1]!;

    if (!prefix.startsWith("/")) {
      throw new Error(`invalid listeners file line ${lineNo + 1}: prefix must start with '/'`);
    }

    if (!backend.startsWith(":")) {
      throw new Error(`invalid listeners file line ${lineNo + 1}: backend must be ':<port>'`);
    }

    const portText = backend.slice(1);
    if (!/^\d+$/.test(portText)) {
      throw new Error(`invalid listeners file line ${lineNo + 1}: invalid port`);
    }
    const port = Number.parseInt(portText, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`invalid listeners file line ${lineNo + 1}: invalid port`);
    }

    let stripPrefix = true;

    for (const opt of parts.slice(2)) {
      const eq = opt.indexOf("=");
      if (eq === -1) {
        throw new Error(`invalid listeners file line ${lineNo + 1}: invalid option '${opt}'`);
      }
      const key = opt.slice(0, eq);
      const value = opt.slice(eq + 1);
      if (key === "strip_prefix") {
        if (value === "true") stripPrefix = true;
        else if (value === "false") stripPrefix = false;
        else throw new Error(`invalid listeners file line ${lineNo + 1}: strip_prefix must be true|false`);
      } else {
        // forward-compatible: ignore unknown keys
      }
    }

    routes.push({ prefix: normalizePrefix(prefix), port, stripPrefix });
  }

  return { routes };
}

export function serializeListenersFile(data: ParsedListenersFile): string {
  const lines: string[] = [];

  for (const route of data.routes) {
    const opts: string[] = [];
    if (!route.stripPrefix) {
      opts.push("strip_prefix=false");
    }
    lines.push([route.prefix, `:${route.port}`, ...opts].join("\t"));
  }

  return lines.join("\n") + "\n";
}

function normalizePrefix(prefix: string): string {
  let p = prefix;
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

function stripPrefix(pathname: string, prefix: string): string {
  if (prefix === "/") return pathname;
  if (pathname === prefix) return "/";
  if (pathname.startsWith(prefix + "/")) {
    const rest = pathname.slice(prefix.length);
    return rest.length === 0 ? "/" : rest;
  }
  return pathname;
}

function normalizeIncomingHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = v;
  }
  return out;
}

function joinHeaderValue(raw: string | string[] | undefined): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.join(",");
  return "";
}

function parseTransferEncoding(raw: string | string[] | undefined): string[] {
  const joined = joinHeaderValue(raw);
  if (!joined) return [];
  return joined
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function parseContentLength(raw: string | string[] | undefined): number | null {
  if (raw === undefined) return null;

  const values = Array.isArray(raw) ? raw : [raw];
  const trimmed = values.map((v) => v.trim());

  // Node may coalesce duplicate headers into a single comma-separated string.
  if (trimmed.length === 1 && trimmed[0]!.includes(",")) {
    return null;
  }

  if (trimmed.some((v) => v.includes(",") || !/^\d+$/.test(v))) {
    return null;
  }

  const first = trimmed[0]!;
  if (!trimmed.every((v) => v === first)) {
    return null;
  }

  const n = Number.parseInt(first, 10);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

function filterHopByHop(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  const connection = joinHeaderValue(headers["connection"]).toLowerCase();
  const connectionTokens = new Set(
    connection
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
  );

  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(k)) continue;
    if (connectionTokens.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function normalizeHeaderRecord(headers: Record<string, string | string[]>): IngressHeaders {
  const out: IngressHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function applyHeaderPatch(base: IngressHeaders, patch: IngressHeaderPatch): IngressHeaders {
  const out: IngressHeaders = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const key = k.toLowerCase();
    if (v === null || v === undefined) {
      delete out[key];
    } else {
      out[key] = v;
    }
  }
  return out;
}

function coerceError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

async function waitForReadableOrThrow(stream: Duplex, closedMessage: string): Promise<void> {
  const s = stream as any;
  if (s.destroyed || s.readableEnded) {
    throw new Error(closedMessage);
  }

  await new Promise<void>((resolve, reject) => {
    const onReadable = () => cleanup(() => resolve());
    const onEnd = () => cleanup(() => reject(new Error(closedMessage)));
    const onClose = () => cleanup(() => reject(new Error(closedMessage)));
    const onError = (err: unknown) => cleanup(() => reject(coerceError(err)));

    const cleanup = (fn: () => void) => {
      stream.off("readable", onReadable);
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError as any);
      fn();
    };

    stream.once("readable", onReadable);
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.once("error", onError as any);
  });
}

async function writeStream(stream: Writable, chunk: Buffer | string): Promise<void> {
  const s = stream as any;
  if (s.destroyed || s.writableEnded || s.writableFinished) {
    throw new Error("stream closed");
  }

  await new Promise<void>((resolve, reject) => {
    let needDrain = false;
    let wrote = false;
    let drained = false;

    const onError = (err: unknown) => cleanup(() => reject(coerceError(err)));
    const onClose = () => cleanup(() => reject(new Error("stream closed")));
    const onFinish = () => cleanup(() => reject(new Error("stream finished")));
    const onDrain = () => {
      drained = true;
      if (wrote) cleanup(() => resolve());
    };

    const onWrite = (err?: Error | null) => {
      if (err) return cleanup(() => reject(err));
      wrote = true;
      if (!needDrain || drained) cleanup(() => resolve());
    };

    const cleanup = (fn: () => void) => {
      stream.off("error", onError as any);
      stream.off("close", onClose);
      stream.off("finish", onFinish);
      stream.off("drain", onDrain);
      fn();
    };

    // Always attach an error handler while a write is in flight so we don't crash
    // on an unhandled "error" event.
    stream.on("error", onError as any);
    stream.once("close", onClose);
    stream.once("finish", onFinish);

    try {
      needDrain = !stream.write(chunk, onWrite);
    } catch (err) {
      cleanup(() => reject(coerceError(err)));
      return;
    }

    if (needDrain) {
      stream.once("drain", onDrain);
    }
  });
}

function parseStatusLine(line: string): { statusCode: number; statusMessage: string } {
  // HTTP/1.1 200 OK
  const m = /^HTTP\/\d+\.\d+\s+(\d{3})\s*(.*)$/.exec(line);
  if (!m) throw new Error(`invalid http status line: ${JSON.stringify(line)}`);
  const statusCode = Number.parseInt(m[1]!, 10);
  const statusMessage = m[2] ?? "";
  return { statusCode, statusMessage };
}

function parseHeaders(raw: string): Record<string, string | string[]> {
  const lines = raw.split("\r\n");
  const headers: Record<string, string | string[]> = {};
  for (const line of lines) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    const prev = headers[key];
    if (prev === undefined) {
      headers[key] = value;
    } else if (Array.isArray(prev)) {
      prev.push(value);
    } else {
      headers[key] = [prev, value];
    }
  }
  return headers;
}

async function readHttpHead(stream: Duplex): Promise<{ statusCode: number; statusMessage: string; headers: Record<string, string | string[]>; rest: Buffer }> {
  let buf = Buffer.alloc(0);
  while (true) {
    const idx = buf.indexOf("\r\n\r\n");
    if (idx !== -1) {
      const head = buf.subarray(0, idx).toString("utf8");
      const rest = buf.subarray(idx + 4);
      const [statusLine, ...headerLines] = head.split("\r\n");
      if (!statusLine) throw new Error("missing status line");
      const { statusCode, statusMessage } = parseStatusLine(statusLine);
      const headers = parseHeaders(headerLines.join("\r\n"));
      return { statusCode, statusMessage, headers, rest };
    }

    if (buf.length > MAX_HTTP_HEADER_BYTES) {
      throw new Error("upstream headers too large");
    }

    const chunk = stream.read() as Buffer | null;
    if (chunk) {
      buf = Buffer.concat([buf, chunk]);
      continue;
    }

    // Note: Duplex streams can emit "close" without "end" when destroyed.
    // Treat that as an upstream close so we don't hang waiting for headers.
    await waitForReadableOrThrow(stream, "upstream closed before sending headers");
  }
}

async function* decodeChunkedBody(stream: Duplex, initial: Buffer): AsyncGenerator<Buffer> {
  let buf = initial;

  const readMore = async () => {
    while (true) {
      const chunk = stream.read() as Buffer | null;
      if (chunk) {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
        return;
      }
      await waitForReadableOrThrow(stream, "upstream closed during chunked body");
    }
  };

  while (true) {
    // Need a full line for chunk size
    while (buf.indexOf("\r\n") === -1) {
      await readMore();
    }

    const lineEnd = buf.indexOf("\r\n");
    const line = buf.subarray(0, lineEnd).toString("ascii");
    buf = buf.subarray(lineEnd + 2);

    const semi = line.indexOf(";");
    const sizeStr = (semi === -1 ? line : line.slice(0, semi)).trim();
    const size = Number.parseInt(sizeStr, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error("invalid chunk size");

    if (size === 0) {
      // Consume trailer part (0 or more header lines), terminated by an empty line.
      // If there are no trailers, the buffer starts with "\r\n".
      if (buf.length < 2) {
        await readMore();
      }
      if (buf.subarray(0, 2).toString("ascii") === "\r\n") {
        buf = buf.subarray(2);
        return;
      }
      while (buf.indexOf("\r\n\r\n") === -1) {
        if (buf.length > MAX_HTTP_HEADER_BYTES) {
          throw new Error("upstream trailers too large");
        }
        await readMore();
      }
      const trailerEnd = buf.indexOf("\r\n\r\n");
      buf = buf.subarray(trailerEnd + 4);
      return;
    }

    // Stream chunk payload without buffering the entire chunk into memory.
    let remaining = size;
    while (remaining > 0) {
      if (buf.length === 0) {
        await readMore();
        continue;
      }

      const take = Math.min(remaining, buf.length);
      yield buf.subarray(0, take);
      buf = buf.subarray(take);
      remaining -= take;
    }

    // Consume trailing CRLF
    while (buf.length < 2) {
      await readMore();
    }
    if (buf[0] !== 13 || buf[1] !== 10) throw new Error("invalid chunk terminator");
    buf = buf.subarray(2);
  }
}

async function* readFixedBody(stream: Duplex, initial: Buffer, length: number): AsyncGenerator<Buffer> {
  let remaining = length;
  let buf = initial;

  while (remaining > 0) {
    if (buf.length === 0) {
      const chunk = stream.read() as Buffer | null;
      if (chunk) {
        buf = chunk;
      } else {
        await waitForReadableOrThrow(stream, "upstream closed before content-length satisfied");
        continue;
      }
    }

    const take = Math.min(remaining, buf.length);
    yield buf.subarray(0, take);
    buf = buf.subarray(take);
    remaining -= take;
  }
}

async function* readToEnd(stream: Duplex, initial: Buffer): AsyncGenerator<Buffer> {
  if (initial.length > 0) yield initial;
  for await (const chunk of stream) {
    yield Buffer.from(chunk as Buffer);
  }
}

async function bufferAsyncIterable(iter: AsyncIterable<Buffer>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of iter) {
    const b = Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) {
      throw new Error(`buffered body too large (>${maxBytes} bytes)`);
    }
    chunks.push(b);
  }

  return Buffer.concat(chunks, total);
}

export class GondolinListeners extends EventEmitter {
  private routes: IngressRoute[] = [];
  private reloadTimer: NodeJS.Timeout | null = null;
  private lastReloadError: unknown = null;

  constructor(private readonly etcProvider: VirtualProvider) {
    super();
  }

  getLastReloadError(): unknown {
    return this.lastReloadError;
  }

  getRoutes(): IngressRoute[] {
    return [...this.routes];
  }

  /** Called by VFS hooks when /etc/gondolin/listeners may have changed */
  notifyDirty(): void {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      try {
        this.reloadNow();
      } catch (err) {
        // Keep old routes on parse failure.
        this.lastReloadError = err;
        // Do NOT emit the special "error" event (would crash the process if unhandled).
        this.emit("reloadError", err);
      }
    }, 25);
  }

  /** Replace the routing table and write canonical listeners file back into the guest */
  setRoutes(routes: IngressRoute[]): void {
    const normalized: IngressRoute[] = [];

    for (const r of routes) {
      if (typeof r.prefix !== "string" || r.prefix.trim() === "") {
        throw new Error("invalid ingress route prefix");
      }
      if (/\s/.test(r.prefix)) {
        throw new Error("invalid ingress route prefix");
      }

      const port = r.port;
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`invalid ingress route port: ${port}`);
      }

      const stripPrefix = r.stripPrefix ?? true;
      if (typeof stripPrefix !== "boolean") {
        throw new Error("invalid ingress route stripPrefix");
      }

      normalized.push({
        prefix: normalizePrefix(r.prefix),
        port,
        stripPrefix,
      });
    }

    this.routes = normalized;
    this.lastReloadError = null;
    this.writeCanonical();
    this.emit("changed", this.getRoutes());
  }

  /** Parse listeners file and update routes; also canonicalize file contents */
  reloadNow(): void {
    const text = this.readListenersText();
    const parsed = parseListenersFile(text);
    this.routes = parsed.routes;
    this.lastReloadError = null;

    const canonical = serializeListenersFile({ routes: this.routes });
    if (canonical !== text) {
      this.writeListenersText(canonical);
    }

    this.emit("changed", this.getRoutes());
  }

  private readListenersText(): string {
    try {
      const st = this.etcProvider.statSync("/listeners");
      if (st.size > MAX_LISTENERS_FILE_BYTES) {
        throw new ListenersFileTooLargeError();
      }

      // Prefer provider-level readFileSync if present.
      const p = this.etcProvider as any;
      if (typeof p.readFileSync === "function") {
        const buf = p.readFileSync("/listeners", "utf8");
        return typeof buf === "string" ? buf : buf.toString("utf8");
      }
      const handle = this.etcProvider.openSync("/listeners", "r");
      try {
        const result = handle.readFileSync("utf8");
        return typeof result === "string" ? result : result.toString("utf8");
      } finally {
        handle.closeSync();
      }
    } catch (err) {
      // If the file exists but violates our size cap, propagate so reloadNow keeps the previous routes.
      if (err instanceof ListenersFileTooLargeError) {
        throw err;
      }

      // Missing file means "no routes".
      const code = (err as any)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return "";
      }

      // Any other provider error should keep the last-known-good routes.
      throw err;
    }
  }

  private writeCanonical() {
    const text = serializeListenersFile({ routes: this.routes });
    this.writeListenersText(text);
  }

  private writeListenersText(text: string) {
    if (Buffer.byteLength(text, "utf8") > MAX_LISTENERS_FILE_BYTES) {
      throw new ListenersFileTooLargeError();
    }

    // Write through the underlying provider directly (not via VFS hooks)
    const handle = this.etcProvider.openSync("/listeners", "w");
    try {
      handle.writeFileSync(text);
    } finally {
      handle.closeSync();
    }
  }
}

export type IngressHeaderValue = string | string[];
export type IngressHeaders = Record<string, IngressHeaderValue>;
export type IngressHeaderPatch = Record<string, IngressHeaderValue | null | undefined>;

export class IngressRequestBlockedError extends Error {
  /** http status code */
  readonly statusCode: number;
  /** http status message */
  readonly statusMessage: string;
  /** response body */
  readonly body: string;

  constructor(message = "request blocked", statusCode = 403, statusMessage = "Forbidden", body = "forbidden\n") {
    super(message);
    this.name = "IngressRequestBlockedError";
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.body = body;
  }
}

export type IngressAllowInfo = {
  /** client ip address (as reported by Node) */
  clientIp: string;
  /** http method */
  method: string;
  /** request path including query */
  path: string;
  /** request headers (lowercased) */
  headers: Record<string, string | string[]>;
  /** matched ingress route */
  route: IngressRoute;
};

export type IngressHookRequest = {
  /** client ip address (as reported by Node) */
  clientIp: string;
  /** http method */
  method: string;
  /** original request path including query */
  path: string;
  /** matched ingress route */
  route: IngressRoute;

  /** upstream target host */
  backendHost: string;
  /** upstream target port */
  backendPort: number;
  /** upstream request target (path + query) */
  backendTarget: string;

  /** upstream request headers (lowercased) */
  headers: IngressHeaders;
};

export type IngressHookRequestPatch = {
  /** updated http method */
  method?: string;
  /** updated upstream host */
  backendHost?: string;
  /** updated upstream port */
  backendPort?: number;
  /** updated upstream request target (path + query) */
  backendTarget?: string;
  /** upstream header patch */
  headers?: IngressHeaderPatch;

  /** buffer full upstream response body before calling onResponse */
  bufferResponseBody?: boolean;
  /** max buffered upstream response body size in `bytes` */
  maxBufferedResponseBodyBytes?: number;
};

export type IngressHookResponse = {
  /** http status code */
  statusCode: number;
  /** http status message */
  statusMessage: string;
  /** response headers (lowercased) */
  headers: IngressHeaders;
  /** buffered response body (only if `bufferResponseBody` is enabled) */
  body?: Buffer;
};

export type IngressHookResponsePatch = {
  /** updated http status code */
  statusCode?: number;
  /** updated http status message */
  statusMessage?: string;
  /** response header patch */
  headers?: IngressHeaderPatch;
  /** replacement response body */
  body?: Buffer;
};

export type IngressGatewayHooks = {
  /** allow/deny callback */
  isAllowed?: (info: IngressAllowInfo) => Promise<boolean> | boolean;
  /** request rewrite hook (rewrite headers / upstream target) */
  onRequest?: (request: IngressHookRequest) => Promise<IngressHookRequestPatch | void> | IngressHookRequestPatch | void;
  /** response rewrite hook (rewrite status / headers and optionally body) */
  onResponse?: (
    response: IngressHookResponse,
    request: IngressHookRequest
  ) => Promise<IngressHookResponsePatch | void> | IngressHookResponsePatch | void;
};

export type EnableIngressOptions = {
  /** host interface to bind (default: 127.0.0.1) */
  listenHost?: string;
  /** host port to bind (default: 0 = ephemeral) */
  listenPort?: number;

  /** ingress gateway hooks */
  hooks?: IngressGatewayHooks;

  /** buffer full upstream response bodies before sending them to the client (default: false) */
  bufferResponseBody?: boolean;

  /** max buffered upstream response body size in `bytes` (default: 2 MiB) */
  maxBufferedResponseBodyBytes?: number;
};

export type IngressAccess = {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
};

export class IngressGateway {
  private server: http.Server | null = null;
  private hooks: IngressGatewayHooks | null;
  private bufferResponseBody: boolean;
  private maxBufferedResponseBodyBytes: number;

  constructor(
    private readonly sandbox: SandboxServer,
    private readonly listeners: GondolinListeners,
    options: Pick<EnableIngressOptions, "hooks" | "bufferResponseBody" | "maxBufferedResponseBodyBytes"> = {}
  ) {
    this.hooks = options.hooks ?? null;
    this.bufferResponseBody = options.bufferResponseBody ?? false;
    this.maxBufferedResponseBodyBytes = options.maxBufferedResponseBodyBytes ?? 2 * 1024 * 1024;
  }

  async listen(options: EnableIngressOptions = {}): Promise<IngressAccess> {
    if (this.server) {
      throw new Error("ingress gateway already running");
    }

    if (options.hooks !== undefined) {
      this.hooks = options.hooks ?? null;
    }
    if (options.bufferResponseBody !== undefined) {
      this.bufferResponseBody = options.bufferResponseBody;
    }
    if (options.maxBufferedResponseBodyBytes !== undefined) {
      this.maxBufferedResponseBodyBytes = options.maxBufferedResponseBodyBytes;
    }

    const listenHost = options.listenHost ?? "127.0.0.1";
    const listenPort = options.listenPort ?? 0;

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    // Ensure we don't crash on client errors.
    server.on("clientError", (err, socket) => {
      try {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      } catch {
        // ignore
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: listenHost, port: listenPort }, () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.server = server;

    const addr = server.address();
    if (!addr || typeof addr === "string") {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.server = null;
      throw new Error("unexpected ingress listen address");
    }

    const host = listenHost;
    const port = addr.port;

    return {
      host,
      port,
      url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
      close: async () => {
        const s = this.server;
        this.server = null;
        if (!s) return;
        await new Promise<void>((resolve) => s.close(() => resolve()));
      },
    };
  }

  private pickRoute(pathname: string): IngressRoute | null {
    const routes = this.listeners.getRoutes();
    let best: IngressRoute | null = null;
    for (const route of routes) {
      if (!pathMatchesPrefix(pathname, route.prefix)) continue;
      if (!best || route.prefix.length > best.prefix.length) {
        best = route;
      }
    }
    return best;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let upstream: Duplex | null = null;
    let upstreamError: unknown = null;

    const onUpstreamError = (err: unknown) => {
      upstreamError = err;
      // Prevent an unhandled "error" event from crashing the process.
      // The request handler will surface failures via awaited reads/writes.
    };

    try {
      const url = new URL(req.url ?? "/", "http://gondolin.local");
      const route = this.pickRoute(url.pathname);
      if (!route) {
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain");
        res.end("no route\n");
        return;
      }

      const hooks = this.hooks;
      const clientIp = req.socket.remoteAddress ?? "";
      const clientMethod = (req.method ?? "GET").toUpperCase();
      const path = url.pathname + url.search;
      const incoming = normalizeIncomingHeaders(req.headers);

      if (hooks?.isAllowed) {
        const allowed = await hooks.isAllowed({ clientIp, method: clientMethod, path, headers: incoming, route });
        if (!allowed) {
          throw new IngressRequestBlockedError();
        }
      }

      // Rewrite path
      const backendPathname = route.stripPrefix ? stripPrefix(url.pathname, route.prefix) : url.pathname;

      // Response buffering defaults (can be overridden per-request via onRequest)
      let bufferResponseBody = this.bufferResponseBody;
      let maxBufferedResponseBodyBytes = this.maxBufferedResponseBodyBytes;

      // Build initial upstream request config (can be patched by onRequest)
      let hookRequest: IngressHookRequest = {
        clientIp,
        method: clientMethod,
        path,
        route,
        backendHost: "127.0.0.1",
        backendPort: route.port,
        backendTarget: backendPathname + url.search,
        headers: normalizeHeaderRecord(filterHopByHop(incoming)),
      };

      // Remove body framing headers; we choose framing ourselves.
      delete hookRequest.headers["content-length"];
      delete hookRequest.headers["transfer-encoding"];
      delete hookRequest.headers["expect"];

      const hostHeader = typeof incoming["host"] === "string" ? incoming["host"] : "localhost";
      hookRequest.headers["host"] = hostHeader;
      hookRequest.headers["connection"] = "close";

      // Forwarded headers
      if (clientIp) {
        const prev = hookRequest.headers["x-forwarded-for"];
        if (typeof prev === "string" && prev.length > 0) {
          hookRequest.headers["x-forwarded-for"] = `${prev}, ${clientIp}`;
        } else {
          hookRequest.headers["x-forwarded-for"] = clientIp;
        }
      }
      hookRequest.headers["x-forwarded-host"] = hostHeader;
      hookRequest.headers["x-forwarded-proto"] = "http";
      if (route.stripPrefix && route.prefix !== "/") {
        hookRequest.headers["x-forwarded-prefix"] = route.prefix;
      }

      if (hooks?.onRequest) {
        const patch = await hooks.onRequest(hookRequest);
        if (patch) {
          if (patch.method !== undefined) hookRequest.method = patch.method;
          if (patch.backendHost !== undefined) hookRequest.backendHost = patch.backendHost;
          if (patch.backendPort !== undefined) hookRequest.backendPort = patch.backendPort;
          if (patch.backendTarget !== undefined) hookRequest.backendTarget = patch.backendTarget;
          if (patch.headers) {
            hookRequest.headers = applyHeaderPatch(hookRequest.headers, patch.headers);
          }
          if (patch.bufferResponseBody !== undefined) bufferResponseBody = patch.bufferResponseBody;
          if (patch.maxBufferedResponseBodyBytes !== undefined) {
            maxBufferedResponseBodyBytes = patch.maxBufferedResponseBodyBytes;
          }
        }
      }

      hookRequest.method = (hookRequest.method ?? "GET").toUpperCase();

      if (hookRequest.backendHost !== "127.0.0.1" && hookRequest.backendHost !== "localhost") {
        throw new Error(`invalid ingress backend host: ${hookRequest.backendHost}`);
      }

      if (!Number.isInteger(hookRequest.backendPort) || hookRequest.backendPort <= 0 || hookRequest.backendPort > 65535) {
        throw new Error(`invalid ingress backend port: ${hookRequest.backendPort}`);
      }

      if (!hookRequest.backendTarget.startsWith("/")) {
        throw new Error(`invalid ingress backend target: ${hookRequest.backendTarget}`);
      }

      // Enforce hop-by-hop filtering after the user hook
      hookRequest.headers = normalizeHeaderRecord(filterHopByHop(hookRequest.headers as any));

      // Remove body framing headers; we choose framing ourselves.
      delete hookRequest.headers["content-length"];
      delete hookRequest.headers["transfer-encoding"];
      delete hookRequest.headers["expect"];
      hookRequest.headers["connection"] = "close";

      // Decide request body encoding (based on what we received from the client)
      const hasBody =
        incoming["content-length"] !== undefined ||
        incoming["transfer-encoding"] !== undefined ||
        clientMethod === "POST" ||
        clientMethod === "PUT" ||
        clientMethod === "PATCH";

      const incomingTeTokens = parseTransferEncoding(incoming["transfer-encoding"]);
      const hasTransferEncoding = incomingTeTokens.length > 0;
      const incomingContentLength = parseContentLength(incoming["content-length"]);

      let useChunked = false;

      // If the client used transfer-encoding, never forward its content-length.
      // Node already de-chunks/frames the inbound body; forwarding a conflicting
      // content-length to the guest backend can cause mis-framing.
      if (!hasTransferEncoding && incomingContentLength !== null) {
        hookRequest.headers["content-length"] = String(incomingContentLength);
      } else if (hasBody) {
        useChunked = true;
        hookRequest.headers["transfer-encoding"] = "chunked";
      }

      upstream = await this.sandbox.openIngressStream({
        host: hookRequest.backendHost,
        port: hookRequest.backendPort,
        timeoutMs: 2000,
      });
      upstream.on("error", onUpstreamError);

      // Send request line + headers
      const headerLines: string[] = [];
      headerLines.push(`${hookRequest.method} ${hookRequest.backendTarget} HTTP/1.1`);
      for (const [k, v] of Object.entries(hookRequest.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const vv of v) headerLines.push(`${k}: ${vv}`);
        } else {
          headerLines.push(`${k}: ${v}`);
        }
      }
      const headerBlob = headerLines.join("\r\n") + "\r\n\r\n";

      await writeStream(upstream, headerBlob);

      // Stream body
      if (hasBody) {
        if (useChunked) {
          for await (const chunk of req) {
            const b = Buffer.from(chunk as Buffer);
            if (b.length === 0) continue;
            await writeStream(upstream, Buffer.from(b.length.toString(16) + "\r\n", "ascii"));
            await writeStream(upstream, b);
            await writeStream(upstream, "\r\n");
          }
          await writeStream(upstream, "0\r\n\r\n");
          upstream.end();
        } else {
          for await (const chunk of req) {
            await writeStream(upstream, Buffer.from(chunk as Buffer));
          }
          upstream.end();
        }
      } else {
        upstream.end();
      }

      // Read response head
      const head = await readHttpHead(upstream);
      let respHeaders = normalizeHeaderRecord(filterHopByHop(head.headers));
      delete respHeaders["content-length"]; // let node decide unless we keep fixed-length
      delete respHeaders["transfer-encoding"];

      // Body mode
      const upstreamTeTokens = parseTransferEncoding(head.headers["transfer-encoding"]);
      const isChunked = upstreamTeTokens.includes("chunked");
      const contentLength = parseContentLength(head.headers["content-length"]);

      // If we have a fixed content-length and the upstream isn't chunked, preserve it.
      if (!isChunked && contentLength !== null) {
        respHeaders["content-length"] = String(contentLength);
      }

      const responseForHook: IngressHookResponse = {
        statusCode: head.statusCode,
        statusMessage: head.statusMessage,
        headers: respHeaders,
      };

      let bodyIter: AsyncIterable<Buffer> = isChunked
        ? decodeChunkedBody(upstream, head.rest)
        : contentLength !== null
          ? readFixedBody(upstream, head.rest, contentLength)
          : readToEnd(upstream, head.rest);

      const shouldBufferResponseBody = bufferResponseBody && !!hooks?.onResponse;
      if (shouldBufferResponseBody) {
        const max = maxBufferedResponseBodyBytes;
        if (!Number.isInteger(max) || max <= 0) {
          throw new Error("invalid maxBufferedResponseBodyBytes");
        }
        responseForHook.body = await bufferAsyncIterable(bodyIter, max);
      }

      if (hooks?.onResponse) {
        const patch = await hooks.onResponse(responseForHook, hookRequest);
        if (patch) {
          if (patch.statusCode !== undefined) responseForHook.statusCode = patch.statusCode;
          if (patch.statusMessage !== undefined) responseForHook.statusMessage = patch.statusMessage;
          if (patch.headers) responseForHook.headers = applyHeaderPatch(responseForHook.headers, patch.headers);
          if (patch.body !== undefined) responseForHook.body = patch.body;
        }
      }

      const finalHeaders = normalizeHeaderRecord(filterHopByHop(responseForHook.headers as any));

      // If we buffered the response (or a hook provided an explicit replacement body), send it with a fixed content-length.
      if (responseForHook.body !== undefined) {
        delete finalHeaders["transfer-encoding"];
        finalHeaders["content-length"] = String(responseForHook.body.length);

        res.writeHead(responseForHook.statusCode, responseForHook.statusMessage, finalHeaders as any);
        if (responseForHook.body.length > 0) {
          await writeStream(res, responseForHook.body);
        }
        res.end();
        return;
      }

      res.writeHead(responseForHook.statusCode, responseForHook.statusMessage, finalHeaders as any);

      for await (const chunk of bodyIter) {
        await writeStream(res, chunk);
      }
      res.end();
    } catch (err) {
      if (err instanceof IngressRequestBlockedError) {
        try {
          if (res.headersSent) {
            (res as any).destroy?.();
            (res as any).socket?.destroy?.();
            return;
          }

          res.writeHead(err.statusCode, err.statusMessage, { "content-type": "text/plain" });
          res.end(err.body);
        } catch {
          // ignore
        }
        return;
      }

      if (process.env.GONDOLIN_DEBUG) {
        // Avoid leaking internal error details to network clients, but keep them
        // available for debugging when explicitly enabled.
        console.error("ingress bad gateway:", err);
      }

      try {
        if (res.headersSent) {
          // We already forwarded upstream headers; writing a gateway body here can
          // corrupt fixed-length responses.
          (res as any).destroy?.();
          (res as any).socket?.destroy?.();
          return;
        }

        res.statusCode = 502;
        res.setHeader("content-type", "text/plain");
        res.end("bad gateway\n");
      } catch {
        // If the client disconnected, res.end()/destroy() can throw synchronously.
        // Swallow it to avoid turning this into an unhandled rejection.
      }
    } finally {
      if (upstream) {
        try {
          upstream.destroy(upstreamError instanceof Error ? upstreamError : undefined);
        } catch {
          // ignore
        }
      }
    }
  }
}

export type GondolinEtcMount = {
  provider: VirtualProvider;
  listeners: GondolinListeners;
};

export function createGondolinEtcMount(provider: VirtualProvider): GondolinEtcMount {
  const listeners = new GondolinListeners(provider);
  // Ensure file exists with canonical empty content.
  try {
    listeners.setRoutes([]);
  } catch {
    // ignore
  }
  return { provider, listeners };
}

export function isGondolinListenersRelevantPath(path: string | undefined): boolean {
  return path === "/etc/gondolin/listeners";
}

const LISTENERS_RELOAD_OPS = new Set(["writeFile", "truncate", "rename", "unlink", "release"]);

export function createGondolinEtcHooks(listeners: GondolinListeners, etcProvider?: VirtualProvider) {
  return {
    after: (ctx: {
      op: string;
      path?: string;
      oldPath?: string;
      newPath?: string;
      data?: Buffer;
      size?: number;
      offset?: number;
      length?: number;
    }) => {
      // Only reload when the file is in a stable state (close/rename/writeFile).
      if (!LISTENERS_RELOAD_OPS.has(ctx.op)) {
        return;
      }
      if (
        isGondolinListenersRelevantPath(ctx.path) ||
        isGondolinListenersRelevantPath(ctx.oldPath) ||
        isGondolinListenersRelevantPath(ctx.newPath)
      ) {
        listeners.notifyDirty();
      }
    },
    before: (ctx: { op: string; path?: string; data?: Buffer; size?: number; offset?: number; length?: number }) => {
      if (!isGondolinListenersRelevantPath(ctx.path)) return;

      if (ctx.op === "writeFile" && ctx.data && ctx.data.length > MAX_LISTENERS_FILE_BYTES) {
        throw new ListenersFileTooLargeError();
      }

      // Guard open+write growth, not just writeFile/truncate.
      if (ctx.op === "write") {
        if (typeof ctx.length !== "number") {
          throw new ListenersFileTooLargeError();
        }

        // In append mode (O_APPEND), the RPC layer writes with position=null.
        // That maps to an undefined offset in the hook context.
        let offset = ctx.offset;
        if (typeof offset !== "number") {
          if (!etcProvider) {
            throw new Error("/etc/gondolin/listeners append writes not supported");
          }
          try {
            offset = etcProvider.statSync("/listeners").size;
          } catch (err: any) {
            if (err?.code === "ENOENT") {
              offset = 0;
            } else {
              throw err;
            }
          }
        }

        if (offset + ctx.length > MAX_LISTENERS_FILE_BYTES) {
          throw new ListenersFileTooLargeError();
        }
      }

      if (ctx.op === "truncate" && typeof ctx.size === "number" && ctx.size > MAX_LISTENERS_FILE_BYTES) {
        throw new ListenersFileTooLargeError();
      }
    },
  };
}

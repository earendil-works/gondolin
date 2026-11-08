/**
 * HTTP/1.x helpers for the ingress gateway (header parsing, response heads,
 * hop-by-hop stripping) and the error type hooks throw to block requests.
 */

/** Header value as parsed from the wire (repeated headers become arrays) */
export type InternalHeaderValue = string | string[];
/** Response headers to serialize */
export type InternalHttpResponseHeaders = Record<string, InternalHeaderValue>;

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

export function parseHeaderLines(
  lines: Iterable<string>,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};

  for (const line of lines) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim().toLowerCase();
    if (!key) continue;

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

export function parseContentLength(
  raw: string | string[] | undefined,
): number | null {
  if (raw === undefined) return null;
  const rawString = Array.isArray(raw) ? raw.join(",") : raw;
  const n = Number.parseInt(rawString, 10);
  if (!Number.isSafeInteger(n) || n < 0) {
    return null;
  }
  return n;
}

export const MAX_HTTP_HEADER_BYTES = 64 * 1024;

export type HttpWireVersion = "HTTP/1.0" | "HTTP/1.1";

function renderHttpResponseHead(
  response: {
    status: number;
    statusText: string;
    headers: InternalHttpResponseHeaders;
  },
  httpVersion: HttpWireVersion = "HTTP/1.1",
): string {
  const statusLine = `${httpVersion} ${response.status} ${response.statusText}\r\n`;

  const headerLines: string[] = [];
  for (const [rawName, rawValue] of Object.entries(response.headers)) {
    const name = rawName.replace(/[\r\n:]+/g, "");
    if (!name) continue;

    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const v of values) {
      const value = String(v).replace(/[\r\n]+/g, " ");
      headerLines.push(`${name}: ${value}`);
    }
  }

  let headerBlock = statusLine;
  if (headerLines.length > 0) {
    headerBlock += `${headerLines.join("\r\n")}\r\n`;
  }
  headerBlock += "\r\n";

  return headerBlock;
}

export function sendHttpResponseHead(
  write: (chunk: Buffer) => void,
  response: {
    status: number;
    statusText: string;
    headers: InternalHttpResponseHeaders;
  },
  httpVersion: HttpWireVersion = "HTTP/1.1",
  encoding: BufferEncoding = "utf8",
) {
  const head = renderHttpResponseHead(response, httpVersion);
  write(Buffer.from(head, encoding));
}

export function sendHttpResponse(
  write: (chunk: Buffer) => void,
  response: {
    status: number;
    statusText: string;
    headers: InternalHttpResponseHeaders;
    body: Buffer;
  },
  httpVersion: HttpWireVersion = "HTTP/1.1",
  encoding: BufferEncoding = "utf8",
) {
  sendHttpResponseHead(write, response, httpVersion, encoding);
  if (response.body.length > 0) {
    write(response.body);
  }
}

function joinInternalHeaderValue(raw: string | string[] | undefined): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.join(",");
  return "";
}

export function isWebSocketUpgradeRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const upgrade = joinInternalHeaderValue(headers.upgrade).toLowerCase();
  if (upgrade === "websocket") return true;

  // Some clients omit Upgrade/Connection but include the WebSocket-specific headers.
  if (headers["sec-websocket-key"] || headers["sec-websocket-version"]) {
    return true;
  }

  return false;
}

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

export function stripHopByHopHeaders<T extends InternalHeaderValue>(
  this: any,
  headers: Record<string, T>,
): Record<string, T> {
  const connectionValue = headers.connection;
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

export function stripHopByHopHeadersForWebSocket<T extends InternalHeaderValue>(
  this: any,
  headers: Record<string, T>,
): Record<string, T> {
  const out: Record<string, T> = { ...headers };

  // Unlike normal HTTP proxying, WebSocket handshakes require forwarding Connection/Upgrade
  // Still strip proxy-only and framing hop-by-hop headers
  delete out["keep-alive"];
  delete out["proxy-connection"];
  delete out["proxy-authenticate"];
  delete out["proxy-authorization"];

  // No request bodies for WebSocket handshake
  delete out["content-length"];
  delete out["transfer-encoding"];
  delete out.expect;

  // Avoid forwarding framed/trailer-related hop-by-hop headers
  delete out.te;
  delete out.trailer;

  // Apply Connection: token stripping, but keep Upgrade + WebSocket-specific headers
  const connectionValue = out.connection;
  const connection = Array.isArray(connectionValue)
    ? connectionValue.join(",")
    : typeof connectionValue === "string"
      ? connectionValue
      : "";
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

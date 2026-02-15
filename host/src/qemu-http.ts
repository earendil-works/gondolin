import net from "net";
import tls from "tls";
import dns from "dns";
import { fetch as undiciFetch } from "undici";
import type { ReadableStream as WebReadableStream } from "stream/web";

import type {
  HttpHookRequest,
  HttpHookResponse,
  HttpIpAllowInfo,
  HttpResponseHeaders,
  QemuNetworkBackend,
  TcpSession,
} from "./qemu-net";

import {
  HttpRequestBlockedError,
  applyRedirectRequest,
  getCheckedDispatcher,
  getRedirectUrl,
  normalizeLookupEntries,
  stripHopByHopHeaders,
  stripHopByHopHeadersForWebSocket,
} from "./http-utils";

export {
  HttpRequestBlockedError,
  applyRedirectRequest,
  closeSharedDispatchers,
  createLookupGuard,
  getCheckedDispatcher,
  getRedirectUrl,
  normalizeLookupEntries,
  normalizeLookupFailure,
  normalizeLookupOptions,
  stripHopByHopHeaders,
  stripHopByHopHeadersForWebSocket,
} from "./http-utils";

export const MAX_HTTP_REDIRECTS = 10;
export const MAX_HTTP_HEADER_BYTES = 64 * 1024;
export const MAX_HTTP_PIPELINE_BYTES = 64 * 1024;

// When streaming request bodies (Content-Length, no buffering), keep the internal
// ReadableStream queue bounded and apply coarse-grained backpressure to QEMU.
export const HTTP_STREAMING_REQUEST_BODY_HIGH_WATER_BYTES = 64 * 1024;
export const HTTP_STREAMING_RX_PAUSE_HIGH_WATER_BYTES = 512 * 1024;
export const HTTP_STREAMING_RX_PAUSE_LOW_WATER_BYTES = 256 * 1024;

// Chunked framing (chunk-size lines + trailers) can add overhead on top of the decoded body.
// Keep this bounded separately from maxHttpBodyBytes.
export const MAX_HTTP_CHUNKED_OVERHEAD_BYTES = 256 * 1024;

type FetchResponse = Awaited<ReturnType<typeof undiciFetch>>;

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

class HttpReceiveCursor {
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

export type HttpSession = {
  buffer: HttpReceiveBuffer;
  processing: boolean;
  closed: boolean;

  /** cached request head state (we only process one HTTP request per TCP session) */
  head?: {
    method: string;
    target: string;
    version: string;
    headers: Record<string, string>;
    bodyOffset: number;

    hookRequest: HttpHookRequest;
    /** request head used as the base for `httpHooks.onRequest` */
    hookRequestForBodyHook?: HttpHookRequest | null;
    bufferRequestBody: boolean;
    maxBodyBytes: number;

    bodyMode: "none" | "content-length" | "chunked";
    contentLength: number;
  };

  /** active streaming request body state (Content-Length only) */
  streamingBody?: {
    /** bytes remaining in the declared Content-Length body in `bytes` */
    remaining: number;
    /** upstream body stream controller */
    controller: ReadableStreamDefaultController<Uint8Array> | null;
    /** whether the body stream is complete or canceled */
    done: boolean;
    /** bytes observed after body completion in `bytes` (HTTP pipelining/coalescing) */
    pipelineBytes: number;

    /** pending body chunks not yet enqueued into the ReadableStream */
    pending: Buffer[];
    /** pending body bytes not yet enqueued into the ReadableStream in `bytes` */
    pendingBytes: number;
    /** close the stream after pending bytes are drained */
    closeAfterPending: boolean;

    /** drains pending chunks into the ReadableStream while respecting backpressure */
    drain: () => void;
  };

  /** whether we already sent an interim 100-continue response */
  sentContinue?: boolean;
};

export type WebSocketState = {
  /** current websocket state */
  phase: "handshake" | "open";
  /** connected upstream socket (null until connected) */
  upstream: net.Socket | null;
  /** buffered guest->upstream bytes while the upstream socket is not yet connected */
  pending: Buffer[];
  /** bytes currently queued in `pending` in `bytes` */
  pendingBytes: number;
};

function getMaxHttpStreamingPendingBytes(backend: QemuNetworkBackend): number {
  let maxPending = 0;
  for (const session of backend.tcpSessions.values()) {
    const pending = session.http?.streamingBody?.pendingBytes ?? 0;
    if (pending > maxPending) maxPending = pending;
  }
  return maxPending;
}

export function updateQemuRxPauseState(backend: QemuNetworkBackend) {
  const socket = backend.socket;
  if (!socket) return;

  const maxPending = getMaxHttpStreamingPendingBytes(backend);

  if (
    !backend.http.qemuRxPausedForHttpStreaming &&
    maxPending >= HTTP_STREAMING_RX_PAUSE_HIGH_WATER_BYTES
  ) {
    backend.http.qemuRxPausedForHttpStreaming = true;
    try {
      socket.pause();
    } catch {
      // ignore
    }
    return;
  }

  if (
    backend.http.qemuRxPausedForHttpStreaming &&
    maxPending <= HTTP_STREAMING_RX_PAUSE_LOW_WATER_BYTES
  ) {
    backend.http.qemuRxPausedForHttpStreaming = false;
    try {
      socket.resume();
    } catch {
      // ignore
    }
  }
}

export async function handlePlainHttpData(
  backend: QemuNetworkBackend,
  key: string,
  session: TcpSession,
  data: Buffer,
) {
  if (session.ws) {
    handleWebSocketClientData(backend, key, session, data);
    return;
  }

  await handleHttpDataWithWriter(backend, key, session, data, {
    scheme: "http",
    write: (chunk: Buffer) => {
      backend.stack?.handleTcpData({ key, data: chunk });
    },
    finish: () => {
      backend.stack?.handleTcpEnd({ key });
      backend.flush();
    },
    waitForWritable: () => backend.waitForFlowResume(key),
  });
}

export async function handleTlsHttpData(
  backend: QemuNetworkBackend,
  key: string,
  session: TcpSession,
  data: Buffer,
) {
  const tlsSession = session.tls;
  if (!tlsSession) return;

  if (session.ws) {
    handleWebSocketClientData(backend, key, session, data);
    return;
  }

  await handleHttpDataWithWriter(backend, key, session, data, {
    scheme: "https",
    write: (chunk: Buffer) => {
      tlsSession.socket.write(chunk);
    },
    finish: () => {
      tlsSession.socket.end(() => {
        backend.stack?.handleTcpEnd({ key });
        backend.flush();
      });
    },
    waitForWritable: () => backend.waitForFlowResume(key),
  });
}

function abortWebSocketSession(
  backend: QemuNetworkBackend,
  key: string,
  session: TcpSession,
  reason: string,
) {
  if (backend.options.debug) {
    backend.emitDebug(
      `websocket session aborted ${session.srcIP}:${session.srcPort} -> ${session.dstIP}:${session.dstPort} reason=${reason}`,
    );
  }

  try {
    session.ws?.upstream?.destroy();
  } catch {
    // ignore
  }

  try {
    session.tls?.socket.destroy();
  } catch {
    // ignore
  }

  session.ws = undefined;
  backend.abortTcpSession(key, session, reason);
}

function handleWebSocketClientData(
  backend: QemuNetworkBackend,
  key: string,
  session: TcpSession,
  data: Buffer,
) {
  const ws = session.ws;
  if (!ws) return;
  if (data.length === 0) return;

  const upstream = ws.upstream;

  if (upstream && upstream.writable) {
    const nextWritable = upstream.writableLength + data.length;
    if (nextWritable > backend.maxTcpPendingWriteBytes) {
      abortWebSocketSession(
        backend,
        key,
        session,
        `socket-write-buffer-exceeded (${nextWritable} > ${backend.maxTcpPendingWriteBytes})`,
      );
      return;
    }

    upstream.write(data);
    return;
  }

  // Handshake in progress (or upstream not yet connected): buffer until we have an upstream.
  const nextBytes = ws.pendingBytes + data.length;
  if (nextBytes > backend.maxTcpPendingWriteBytes) {
    abortWebSocketSession(
      backend,
      key,
      session,
      `pending-write-buffer-exceeded (${nextBytes} > ${backend.maxTcpPendingWriteBytes})`,
    );
    return;
  }

  ws.pending.push(data);
  ws.pendingBytes = nextBytes;
}

function maybeSend100ContinueFromHead(
  backend: QemuNetworkBackend,
  httpSession: HttpSession,
  head: {
    version: string;
    headers: Record<string, string>;
    bodyOffset: number;
  },
  bufferedBodyBytes: number,
  write: (chunk: Buffer) => void,
) {
  if (httpSession.sentContinue) return;
  if (head.version !== "HTTP/1.1") return;

  const expect = head.headers["expect"]?.toLowerCase();
  if (!expect) return;

  const expectations = expect
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!expectations.includes("100-continue")) return;

  // For Content-Length, only send Continue if the body is not fully buffered yet.
  const contentLengthRaw = head.headers["content-length"];
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : 0;
  if (Number.isFinite(contentLength) && contentLength > bufferedBodyBytes) {
    write(Buffer.from("HTTP/1.1 100 Continue\r\n\r\n"));
    httpSession.sentContinue = true;
    return;
  }

  // For chunked bodies, we don't know completeness without parsing. If the client used
  // Expect: 100-continue, reply as soon as we see a supported chunked request head.
  const transferEncodingHeader = head.headers["transfer-encoding"];
  const encodings = transferEncodingHeader
    ?.split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  const supportedChunked =
    Boolean(encodings?.length) &&
    encodings![encodings!.length - 1] === "chunked" &&
    encodings!.every((encoding) => encoding === "chunked");

  if (supportedChunked) {
    write(Buffer.from("HTTP/1.1 100 Continue\r\n\r\n"));
    httpSession.sentContinue = true;
  }
}

export async function handleHttpDataWithWriter(
  backend: QemuNetworkBackend,
  key: string,
  session: TcpSession,
  data: Buffer,
  options: {
    scheme: "http" | "https";
    write: (chunk: Buffer) => void;
    finish: () => void;
    waitForWritable?: () => Promise<void>;
  },
) {
  const httpSession: HttpSession =
    session.http ??
    ({
      buffer: new HttpReceiveBuffer(),
      processing: false,
      closed: false,
      sentContinue: false,
    } satisfies HttpSession);
  session.http = httpSession;

  if (httpSession.closed) return;

  // If we are currently streaming a request body to the upstream fetch, forward
  // bytes directly and avoid buffering.
  if (httpSession.streamingBody) {
    const streamState = httpSession.streamingBody;

    if (data.length === 0) return;

    // We only support a single HTTP request per TCP flow. If the guest pipelines
    // additional bytes after the declared Content-Length, discard them (up to a
    // strict cap) so the in-flight response can still be delivered.
    if (streamState.done) {
      streamState.pipelineBytes += data.length;
      if (streamState.pipelineBytes > MAX_HTTP_PIPELINE_BYTES) {
        httpSession.closed = true;
        backend.abortTcpSession(
          key,
          session,
          `http-extra-bytes-after-body (${streamState.pipelineBytes} bytes)`,
        );
      }
      return;
    }

    const take = Math.min(streamState.remaining, data.length);
    const extra = data.length - take;

    if (take > 0) {
      streamState.pending.push(data.subarray(0, take));
      streamState.pendingBytes += take;
      streamState.remaining -= take;
      streamState.drain();
    }

    if (streamState.remaining === 0) {
      streamState.done = true;
      streamState.closeAfterPending = true;
      streamState.drain();
    }

    if (extra > 0) {
      streamState.pipelineBytes += extra;
      if (streamState.pipelineBytes > MAX_HTTP_PIPELINE_BYTES) {
        httpSession.closed = true;
        backend.abortTcpSession(
          key,
          session,
          `http-body-pipeline-exceeds-cap (${streamState.pipelineBytes} bytes)`,
        );
      }
    }

    return;
  }

  httpSession.buffer.append(data);
  if (httpSession.processing) return;

  try {
    // Parse + cache request head.
    if (!httpSession.head) {
      const headerEnd = httpSession.buffer.findHeaderEnd(
        MAX_HTTP_HEADER_BYTES + 4,
      );
      if (headerEnd === -1) {
        if (httpSession.buffer.length > MAX_HTTP_HEADER_BYTES) {
          throw new HttpRequestBlockedError(
            `request headers exceed ${MAX_HTTP_HEADER_BYTES} bytes`,
            431,
            "Request Header Fields Too Large",
          );
        }
        return;
      }

      if (headerEnd > MAX_HTTP_HEADER_BYTES) {
        throw new HttpRequestBlockedError(
          `request headers exceed ${MAX_HTTP_HEADER_BYTES} bytes`,
          431,
          "Request Header Fields Too Large",
        );
      }

      const headBuf = httpSession.buffer.prefix(headerEnd + 4);
      const head = parseHttpHead(backend, headBuf);
      if (!head) return;

      const bufferedBodyBytes = Math.max(
        0,
        httpSession.buffer.length - head.bodyOffset,
      );

      // Validate Expect early so we don't send 100-continue for requests we must reject.
      validateExpectHeader(backend, head.version, head.headers);

      // Asterisk-form (OPTIONS *) is valid HTTP but does not map to a URL fetch.
      if (head.method === "OPTIONS" && head.target === "*") {
        const version: "HTTP/1.0" | "HTTP/1.1" =
          head.version === "HTTP/1.0" ? "HTTP/1.0" : "HTTP/1.1";
        respondWithError(
          backend,
          options.write,
          501,
          "Not Implemented",
          version,
        );
        httpSession.closed = true;
        options.finish();
        backend.flush();
        return;
      }

      // Determine request body framing.
      const transferEncodingHeader = head.headers["transfer-encoding"];
      let bodyMode: "none" | "content-length" | "chunked" = "none";
      let contentLength = 0;

      if (transferEncodingHeader) {
        const encodings = transferEncodingHeader
          .split(",")
          .map((value: string) => value.trim().toLowerCase())
          .filter(Boolean);

        if (
          encodings.length === 0 ||
          encodings[encodings.length - 1] !== "chunked" ||
          !encodings.every((encoding: string) => encoding === "chunked")
        ) {
          throw new HttpRequestBlockedError(
            `unsupported transfer-encoding: ${transferEncodingHeader}`,
            501,
            "Not Implemented",
          );
        }

        bodyMode = "chunked";
      } else {
        const contentLengthRaw = head.headers["content-length"];
        if (contentLengthRaw) {
          if (contentLengthRaw.includes(",")) {
            throw new Error("multiple content-length headers");
          }
          contentLength = Number(contentLengthRaw);
          if (
            !Number.isFinite(contentLength) ||
            !Number.isInteger(contentLength) ||
            contentLength < 0
          ) {
            throw new Error("invalid content-length");
          }
        }

        if (contentLength > 0) {
          bodyMode = "content-length";
        }
      }

      const dummyRequest: HttpRequestData = {
        method: head.method,
        target: head.target,
        version: head.version,
        headers: head.headers,
        body: Buffer.alloc(0),
      };

      const hasUpgrade = (() => {
        const connection = head.headers["connection"]?.toLowerCase() ?? "";
        return (
          Boolean(head.headers["upgrade"]) ||
          connection
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
            .includes("upgrade") ||
          Boolean(head.headers["sec-websocket-key"]) ||
          Boolean(head.headers["sec-websocket-version"])
        );
      })();

      const upgradeIsWebSocket = isWebSocketUpgradeRequest(
        backend,
        dummyRequest,
      );
      if (hasUpgrade && !(backend.http.allowWebSockets && upgradeIsWebSocket)) {
        const version: "HTTP/1.0" | "HTTP/1.1" =
          head.version === "HTTP/1.0" ? "HTTP/1.0" : "HTTP/1.1";
        respondWithError(
          backend,
          options.write,
          501,
          "Not Implemented",
          version,
        );
        httpSession.closed = true;
        options.finish();
        backend.flush();
        return;
      }

      const url = buildFetchUrl(backend, dummyRequest, options.scheme);
      if (!url) {
        const version: "HTTP/1.0" | "HTTP/1.1" =
          head.version === "HTTP/1.0" ? "HTTP/1.0" : "HTTP/1.1";
        respondWithError(backend, options.write, 400, "Bad Request", version);
        httpSession.closed = true;
        options.finish();
        backend.flush();
        return;
      }

      const headHookBase: HttpHookRequest = {
        method: head.method,
        url,
        headers: upgradeIsWebSocket
          ? stripHopByHopHeadersForWebSocket(head.headers)
          : stripHopByHopHeaders(head.headers),
        body: null,
      };

      const headHooked = await applyRequestHeadHooks(backend, headHookBase);

      let maxBodyBytes = backend.http.maxHttpBodyBytes;
      if (headHooked.maxBufferedRequestBodyBytes !== null) {
        maxBodyBytes = Math.min(
          maxBodyBytes,
          headHooked.maxBufferedRequestBodyBytes,
        );
      }

      if (
        bodyMode === "content-length" &&
        Number.isFinite(maxBodyBytes) &&
        contentLength > maxBodyBytes
      ) {
        throw new HttpRequestBlockedError(
          `request body exceeds ${maxBodyBytes} bytes`,
          413,
          "Payload Too Large",
        );
      }

      // Validate request policy + IP policy on the (possibly rewritten) head.
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(headHooked.request.url);
      } catch {
        throw new HttpRequestBlockedError("invalid url", 400, "Bad Request");
      }

      const protocol = getUrlProtocol(parsedUrl);
      if (!protocol) {
        throw new HttpRequestBlockedError(
          "unsupported protocol",
          400,
          "Bad Request",
        );
      }

      const port = getUrlPort(parsedUrl, protocol);
      if (!Number.isFinite(port) || port <= 0) {
        throw new HttpRequestBlockedError("invalid port", 400, "Bad Request");
      }

      await ensureRequestAllowed(backend, headHooked.request);
      await ensureIpAllowed(backend, parsedUrl, protocol, port);

      maybeSend100ContinueFromHead(
        backend,
        httpSession,
        head,
        bufferedBodyBytes,
        options.write,
      );

      httpSession.head = {
        method: head.method,
        target: head.target,
        version: head.version,
        headers: head.headers,
        bodyOffset: head.bodyOffset,
        hookRequest: headHooked.request,
        hookRequestForBodyHook: headHooked.requestForBodyHook,
        bufferRequestBody: headHooked.bufferRequestBody,
        maxBodyBytes,
        bodyMode,
        contentLength,
      };
    }

    const state = httpSession.head;
    if (!state) return;

    const httpVersion: "HTTP/1.0" | "HTTP/1.1" =
      state.version === "HTTP/1.0" ? "HTTP/1.0" : "HTTP/1.1";

    // WebSocket upgrade handling (no request bodies allowed).
    if (backend.http.allowWebSockets) {
      const stub: HttpRequestData = {
        method: state.method,
        target: state.target,
        version: state.version,
        headers: state.headers,
        body: Buffer.alloc(0),
      };

      if (isWebSocketUpgradeRequest(backend, stub)) {
        if (state.bodyMode !== "none") {
          throw new HttpRequestBlockedError(
            "websocket upgrade requests must not have a body",
            400,
            "Bad Request",
          );
        }

        // Prevent further HTTP parsing on this TCP session; upgraded connections become opaque tunnels.
        httpSession.closed = true;
        httpSession.processing = true;

        session.ws = session.ws ?? {
          phase: "handshake",
          upstream: null,
          pending: [],
          pendingBytes: 0,
        };

        // Anything already buffered after the request head is treated as early websocket data.
        const early = httpSession.buffer.suffix(state.bodyOffset);
        httpSession.buffer.resetTo(Buffer.alloc(0));
        if (early.length > 0) {
          handleWebSocketClientData(backend, key, session, early);
        }

        let keepOpen = false;
        try {
          keepOpen = await handleWebSocketUpgrade(
            backend,
            key,
            stub,
            session,
            options,
            httpVersion,
            {
              headHookRequest: state.hookRequest,
              headHookRequestForBodyHook: state.hookRequestForBodyHook ?? null,
            },
          );
        } finally {
          httpSession.processing = false;
          if (!keepOpen) {
            options.finish();
            backend.flush();
          }
        }
        return;
      }
    }

    // Buffering / streaming decision based on onRequestHead.
    const bufferedBodyBytes = Math.max(
      0,
      httpSession.buffer.length - state.bodyOffset,
    );

    if (state.bodyMode === "chunked") {
      // Currently chunked request bodies are always buffered.
      const maxBuffered =
        state.bodyOffset +
        state.maxBodyBytes +
        MAX_HTTP_CHUNKED_OVERHEAD_BYTES +
        MAX_HTTP_PIPELINE_BYTES;
      if (httpSession.buffer.length > maxBuffered) {
        throw new HttpRequestBlockedError(
          `request body exceeds ${state.maxBodyBytes} bytes`,
          413,
          "Payload Too Large",
        );
      }

      const chunked = decodeChunkedBodyFromReceiveBuffer(
        backend,
        httpSession.buffer,
        state.bodyOffset,
        state.maxBodyBytes,
      );

      if (!chunked.complete) {
        maybeSend100ContinueFromHead(
          backend,
          httpSession,
          state,
          bufferedBodyBytes,
          options.write,
        );
        return;
      }

      const remainingStart = state.bodyOffset + chunked.bytesConsumed;
      if (
        httpSession.buffer.length - remainingStart >
        MAX_HTTP_PIPELINE_BYTES
      ) {
        throw new HttpRequestBlockedError(
          `request pipeline exceeds ${MAX_HTTP_PIPELINE_BYTES} bytes`,
          413,
          "Payload Too Large",
        );
      }

      const remaining = httpSession.buffer.suffix(remainingStart);
      httpSession.buffer.resetTo(remaining);

      const body = chunked.body;
      const baseHookRequest = state.hookRequestForBodyHook ?? state.hookRequest;
      let hookRequest: HttpHookRequest = {
        method: baseHookRequest.method,
        url: baseHookRequest.url,
        headers: {
          ...baseHookRequest.headers,
          "content-length": body.length.toString(),
        },
        body: body.length > 0 ? body : null,
      };

      if (state.bufferRequestBody) {
        hookRequest = await applyRequestBodyHooks(backend, hookRequest);
      }

      // Normalize framing headers for fetch.
      hookRequest.headers = { ...hookRequest.headers };
      delete hookRequest.headers["transfer-encoding"];
      if (hookRequest.body) {
        hookRequest.headers["content-length"] =
          hookRequest.body.length.toString();
      } else {
        delete hookRequest.headers["content-length"];
      }

      // If the buffered onRequest hook rewrote the destination or relevant headers,
      // re-run request/ip policy checks against the final request.
      if (
        state.bufferRequestBody &&
        !isSamePolicyRelevantRequestHead(
          backend,
          hookRequest,
          state.hookRequest,
        )
      ) {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(hookRequest.url);
        } catch {
          throw new HttpRequestBlockedError("invalid url", 400, "Bad Request");
        }

        const protocol = getUrlProtocol(parsedUrl);
        if (!protocol) {
          throw new HttpRequestBlockedError(
            "unsupported protocol",
            400,
            "Bad Request",
          );
        }

        const port = getUrlPort(parsedUrl, protocol);
        if (!Number.isFinite(port) || port <= 0) {
          throw new HttpRequestBlockedError("invalid port", 400, "Bad Request");
        }

        await ensureRequestAllowed(backend, hookRequest);
        await ensureIpAllowed(backend, parsedUrl, protocol, port);
      }

      httpSession.processing = true;
      let releaseHttpConcurrency: (() => void) | null = null;

      try {
        releaseHttpConcurrency = await backend.http.httpConcurrency.acquire();
        await fetchHookRequestAndRespond(backend, {
          request: hookRequest,
          httpVersion,
          write: options.write,
          waitForWritable: options.waitForWritable,
          hooksAppliedFirstHop: true,
          policyCheckedFirstHop: true,
          enableBodyHook: state.bufferRequestBody,
        });
      } finally {
        releaseHttpConcurrency?.();
        httpSession.processing = false;
        httpSession.closed = true;
        options.finish();
        backend.flush();
      }

      return;
    }

    // Content-Length or no body.
    const contentLength = state.contentLength;

    const maxBuffered =
      state.bodyOffset + contentLength + MAX_HTTP_PIPELINE_BYTES;
    if (httpSession.buffer.length > maxBuffered) {
      throw new HttpRequestBlockedError(
        `request exceeds ${contentLength} bytes`,
        413,
        "Payload Too Large",
      );
    }

    if (
      !state.bufferRequestBody &&
      contentLength > 0 &&
      bufferedBodyBytes < contentLength
    ) {
      // If the client uses Expect: 100-continue, avoid starting the upstream fetch
      // until we see at least one body byte (the client may be waiting).
      const expect = state.headers["expect"]?.toLowerCase() ?? "";
      if (expect.includes("100-continue") && bufferedBodyBytes === 0) {
        return;
      }

      // Start streaming the request body to the upstream fetch.
      const streamState: NonNullable<HttpSession["streamingBody"]> = {
        remaining: contentLength,
        controller: null,
        done: false,
        pipelineBytes: 0,
        pending: [],
        pendingBytes: 0,
        closeAfterPending: false,
        drain: () => {
          const c = streamState.controller;
          if (!c) return;

          try {
            while (streamState.pending.length > 0) {
              const desired =
                typeof c.desiredSize === "number" ? c.desiredSize : 0;
              if (desired <= 0) break;

              const head = streamState.pending[0]!;
              if (head.length <= desired) {
                c.enqueue(head);
                streamState.pending.shift();
                streamState.pendingBytes -= head.length;
              } else {
                c.enqueue(head.subarray(0, desired));
                streamState.pending[0] = head.subarray(desired);
                streamState.pendingBytes -= desired;
              }
            }

            if (
              streamState.closeAfterPending &&
              streamState.pendingBytes === 0
            ) {
              streamState.closeAfterPending = false;
              c.close();
            }
          } catch {
            // The upstream fetch may have canceled/closed the request body stream early.
            streamState.done = true;
            streamState.controller = null;
            streamState.pending.length = 0;
            streamState.pendingBytes = 0;
            streamState.closeAfterPending = false;
          } finally {
            updateQemuRxPauseState(backend);
          }
        },
      };

      const bodyStream = new ReadableStream<Uint8Array>(
        {
          start: (c) => {
            streamState.controller = c;
            streamState.drain();
          },
          pull: (c) => {
            streamState.controller = c;
            streamState.drain();
          },
          cancel: () => {
            streamState.done = true;
            streamState.controller = null;
            streamState.pending.length = 0;
            streamState.pendingBytes = 0;
            streamState.closeAfterPending = false;
            updateQemuRxPauseState(backend);
          },
        },
        {
          highWaterMark: HTTP_STREAMING_REQUEST_BODY_HIGH_WATER_BYTES,
          size: (chunk: Uint8Array) => chunk.byteLength,
        },
      );

      httpSession.streamingBody = streamState;

      // Extract any already-buffered body bytes and clear the receive buffer.
      const initialBody = httpSession.buffer.suffix(state.bodyOffset);
      httpSession.buffer.resetTo(Buffer.alloc(0));

      // Kick off the upstream fetch.
      httpSession.processing = true;
      let releaseHttpConcurrency: (() => void) | null = null;

      // Normalize framing headers for streaming requests.
      // If onRequestHead rewrote Content-Length / Transfer-Encoding, ensure we still
      // send a self-consistent request upstream.
      const streamingRequest: HttpHookRequest = {
        method: state.hookRequest.method,
        url: state.hookRequest.url,
        headers: Object.fromEntries(
          Object.entries(state.hookRequest.headers).map(([key, value]) => [
            key.toLowerCase(),
            value,
          ]),
        ),
        body: null,
      };

      const expectedLength = contentLength.toString();
      const hookedLength = streamingRequest.headers["content-length"];
      if (
        hookedLength !== undefined &&
        hookedLength !== expectedLength &&
        backend.options.debug
      ) {
        backend.emitDebug(
          `http bridge onRequestHead rewrote content-length (${hookedLength} -> ${expectedLength}); overriding for streaming`,
        );
      }

      delete streamingRequest.headers["transfer-encoding"];
      streamingRequest.headers["content-length"] = expectedLength;

      const safeWrite = (chunk: Buffer) => {
        if (httpSession.closed) return;
        options.write(chunk);
      };

      (async () => {
        try {
          releaseHttpConcurrency = await backend.http.httpConcurrency.acquire();
          await fetchHookRequestAndRespond(backend, {
            request: streamingRequest,
            httpVersion,
            write: safeWrite,
            waitForWritable: options.waitForWritable,
            hooksAppliedFirstHop: true,
            policyCheckedFirstHop: true,
            enableBodyHook: false,
            initialBodyStream: bodyStream as any,
            initialBodyStreamHasBody: true,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));

          if (error instanceof HttpRequestBlockedError) {
            if (backend.options.debug) {
              backend.emitDebug(`http blocked ${error.message}`);
            }
            respondWithError(
              backend,
              safeWrite,
              error.status,
              error.statusText,
              httpVersion,
            );
          } else {
            backend.emit("error", error);
            respondWithError(
              backend,
              safeWrite,
              502,
              "Bad Gateway",
              httpVersion,
            );
          }
        } finally {
          releaseHttpConcurrency?.();
          httpSession.processing = false;
          if (!httpSession.closed) {
            httpSession.closed = true;
            options.finish();
            backend.flush();
          }
        }
      })();

      // Feed initial bytes into the stream.
      if (initialBody.length > 0) {
        await handleHttpDataWithWriter(
          backend,
          key,
          session,
          initialBody,
          options,
        );
      }

      return;
    }

    // If we know exactly how much body to expect, avoid attempting fetch until complete.
    if (bufferedBodyBytes < contentLength) {
      maybeSend100ContinueFromHead(
        backend,
        httpSession,
        state,
        bufferedBodyBytes,
        options.write,
      );
      return;
    }

    // Body is fully buffered (or empty).
    const full = httpSession.buffer.toBuffer();
    const body =
      contentLength > 0
        ? full.subarray(state.bodyOffset, state.bodyOffset + contentLength)
        : Buffer.alloc(0);
    const remainingStart = state.bodyOffset + contentLength;

    if (full.length - remainingStart > MAX_HTTP_PIPELINE_BYTES) {
      throw new HttpRequestBlockedError(
        `request pipeline exceeds ${MAX_HTTP_PIPELINE_BYTES} bytes`,
        413,
        "Payload Too Large",
      );
    }

    const remaining = full.subarray(remainingStart);
    httpSession.buffer.resetTo(Buffer.from(remaining));

    const baseHookRequest = state.hookRequestForBodyHook ?? state.hookRequest;
    let hookRequest: HttpHookRequest = {
      method: baseHookRequest.method,
      url: baseHookRequest.url,
      headers: { ...baseHookRequest.headers },
      body: body.length > 0 ? Buffer.from(body) : null,
    };

    if (state.bufferRequestBody) {
      hookRequest = await applyRequestBodyHooks(backend, hookRequest);
    }

    // Normalize framing headers for fetch.
    hookRequest.headers = { ...hookRequest.headers };
    delete hookRequest.headers["transfer-encoding"];
    if (hookRequest.body) {
      hookRequest.headers["content-length"] =
        hookRequest.body.length.toString();
    } else {
      delete hookRequest.headers["content-length"];
    }

    // If the buffered onRequest hook rewrote the destination or relevant headers,
    // re-run request/ip policy checks against the final request.
    if (
      state.bufferRequestBody &&
      !isSamePolicyRelevantRequestHead(backend, hookRequest, state.hookRequest)
    ) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(hookRequest.url);
      } catch {
        throw new HttpRequestBlockedError("invalid url", 400, "Bad Request");
      }

      const protocol = getUrlProtocol(parsedUrl);
      if (!protocol) {
        throw new HttpRequestBlockedError(
          "unsupported protocol",
          400,
          "Bad Request",
        );
      }

      const port = getUrlPort(parsedUrl, protocol);
      if (!Number.isFinite(port) || port <= 0) {
        throw new HttpRequestBlockedError("invalid port", 400, "Bad Request");
      }

      await ensureRequestAllowed(backend, hookRequest);
      await ensureIpAllowed(backend, parsedUrl, protocol, port);
    }

    httpSession.processing = true;
    let releaseHttpConcurrency: (() => void) | null = null;

    try {
      releaseHttpConcurrency = await backend.http.httpConcurrency.acquire();
      await fetchHookRequestAndRespond(backend, {
        request: hookRequest,
        httpVersion,
        write: options.write,
        waitForWritable: options.waitForWritable,
        hooksAppliedFirstHop: true,
        policyCheckedFirstHop: true,
        enableBodyHook: state.bufferRequestBody,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (error instanceof HttpRequestBlockedError) {
        if (backend.options.debug) {
          backend.emitDebug(`http blocked ${error.message}`);
        }
        respondWithError(
          backend,
          options.write,
          error.status,
          error.statusText,
          httpVersion,
        );
      } else {
        backend.emit("error", error);
        respondWithError(
          backend,
          options.write,
          502,
          "Bad Gateway",
          httpVersion,
        );
      }
    } finally {
      releaseHttpConcurrency?.();
      httpSession.processing = false;
      if (!httpSession.closed) {
        httpSession.closed = true;
        options.finish();
        backend.flush();
      }
    }

    return;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const version: "HTTP/1.0" | "HTTP/1.1" =
      httpSession.head?.version === "HTTP/1.0" ? "HTTP/1.0" : "HTTP/1.1";

    if (error instanceof HttpRequestBlockedError) {
      if (backend.options.debug) {
        backend.emitDebug(`http blocked ${error.message}`);
      }
      respondWithError(
        backend,
        options.write,
        error.status,
        error.statusText,
        version,
      );
    } else {
      backend.emit("error", error);
      respondWithError(backend, options.write, 400, "Bad Request", version);
    }

    // Abort any active upstream body stream.
    if (httpSession.streamingBody) {
      const controller = httpSession.streamingBody.controller;
      try {
        controller?.error(error);
      } catch {
        // ignore
      }
      httpSession.streamingBody.done = true;
      httpSession.streamingBody.controller = null;
      updateQemuRxPauseState(backend);
    }

    httpSession.closed = true;
    options.finish();
    backend.flush();
  }
}

function parseHttpHead(
  backend: QemuNetworkBackend,
  buffer: Buffer,
): {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  bodyOffset: number;
} | null {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    // Fail fast if we buffered more than the maximum header size without
    // encountering the header terminator (avoid hanging/slowloris).
    if (buffer.length > MAX_HTTP_HEADER_BYTES) {
      throw new HttpRequestBlockedError(
        `request headers exceed ${MAX_HTTP_HEADER_BYTES} bytes`,
        431,
        "Request Header Fields Too Large",
      );
    }
    return null;
  }

  if (headerEnd > MAX_HTTP_HEADER_BYTES) {
    throw new HttpRequestBlockedError(
      `request headers exceed ${MAX_HTTP_HEADER_BYTES} bytes`,
      431,
      "Request Header Fields Too Large",
    );
  }

  const headerBlock = buffer.subarray(0, headerEnd).toString("latin1");
  const lines = headerBlock.split("\r\n");
  if (lines.length === 0) {
    throw new Error("invalid request");
  }

  const [method, target, version] = lines[0].split(" ");
  if (!method || !target || !version || !version.startsWith("HTTP/")) {
    throw new Error("invalid request line");
  }

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;

    if (headers[key]) {
      if (key === "content-length") {
        if (headers[key] !== value) {
          throw new Error("multiple content-length headers");
        }
        continue;
      }
      headers[key] = `${headers[key]}, ${value}`;
    } else {
      headers[key] = value;
    }
  }

  return {
    method,
    target,
    version,
    headers,
    bodyOffset: headerEnd + 4,
  };
}

function validateExpectHeader(
  backend: QemuNetworkBackend,
  version: string,
  headers: Record<string, string>,
) {
  // RFC 9110: unknown expectations MUST be rejected with 417.
  if (version !== "HTTP/1.1") return;

  const expect = headers["expect"]?.toLowerCase();
  if (!expect) return;

  const tokens = expect
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const unsupported = tokens.filter((t) => t !== "100-continue");
  if (unsupported.length > 0) {
    throw new HttpRequestBlockedError(
      `unsupported expect token(s): ${unsupported.join(", ")}`,
      417,
      "Expectation Failed",
    );
  }
}

function decodeChunkedBodyFromReceiveBuffer(
  backend: QemuNetworkBackend,
  receiveBuffer: HttpReceiveBuffer,
  bodyOffset: number,
  maxBodyBytes: number,
): { complete: boolean; body: Buffer; bytesConsumed: number } {
  const cursor = receiveBuffer.cursor(bodyOffset);
  const chunks: Buffer[] = [];
  const enforceLimit = Number.isFinite(maxBodyBytes) && maxBodyBytes >= 0;

  let totalBytes = 0;
  const startOffset = cursor.offset;

  while (true) {
    const sizeLineRaw = cursor.tryReadLineAscii(1024);
    if (sizeLineRaw === null) {
      return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
    }

    const sizeLine = sizeLineRaw.split(";")[0]!.trim();
    const size = parseInt(sizeLine, 16);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error("invalid chunk size");
    }

    // last-chunk + trailer-section
    if (size === 0) {
      const emptyTrailers = cursor.tryConsumeSequenceIfPresent([0x0d, 0x0a]);
      if (emptyTrailers === null) {
        return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
      }

      if (emptyTrailers) {
        return {
          complete: true,
          body: Buffer.concat(chunks, totalBytes),
          bytesConsumed: cursor.offset - startOffset,
        };
      }

      const consumedTrailers = cursor.tryConsumeUntilDoubleCrlf();
      if (consumedTrailers === null) {
        return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
      }

      return {
        complete: true,
        body: Buffer.concat(chunks, totalBytes),
        bytesConsumed: cursor.offset - startOffset,
      };
    }

    if (enforceLimit && totalBytes + size > maxBodyBytes) {
      throw new HttpRequestBlockedError(
        `request body exceeds ${maxBodyBytes} bytes`,
        413,
        "Payload Too Large",
      );
    }

    const chunkData = cursor.tryReadBytes(size);
    if (chunkData === null) {
      return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
    }

    totalBytes += size;
    chunks.push(chunkData);

    const terminator = cursor.tryConsumeExactSequence([0x0d, 0x0a]);
    if (terminator === null) {
      return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
    }
  }
}

export async function fetchHookRequestAndRespond(
  backend: QemuNetworkBackend,
  options: {
    request: HttpHookRequest;
    httpVersion: "HTTP/1.0" | "HTTP/1.1";
    write: (chunk: Buffer) => void;
    waitForWritable?: () => Promise<void>;

    /** whether onRequestHead/onRequest have already been applied to the initial request */
    hooksAppliedFirstHop?: boolean;

    /** whether request policy + IP policy have already been evaluated for the first hop */
    policyCheckedFirstHop?: boolean;

    /** whether to run httpHooks.onRequest (buffered body rewrite hook) */
    enableBodyHook: boolean;

    /** optional streaming request body for the initial hop */
    initialBodyStream?: WebReadableStream<Uint8Array> | null;

    /** whether the initial body stream carries a request body */
    initialBodyStreamHasBody?: boolean;
  },
) {
  const {
    request: initialRequest,
    httpVersion,
    write,
    waitForWritable,
    hooksAppliedFirstHop = false,
    policyCheckedFirstHop = false,
    enableBodyHook,
    initialBodyStream = null,
    initialBodyStreamHasBody = Boolean(initialBodyStream),
  } = options;

  const fetcher = backend.options.fetch ?? undiciFetch;

  let pendingRequest: HttpHookRequest = initialRequest;

  for (
    let redirectCount = 0;
    redirectCount <= MAX_HTTP_REDIRECTS;
    redirectCount += 1
  ) {
    const isFirstHop = redirectCount === 0;

    let currentRequest = pendingRequest;
    if (!(isFirstHop && hooksAppliedFirstHop)) {
      const headResult = await applyRequestHeadHooks(backend, {
        method: currentRequest.method,
        url: currentRequest.url,
        headers: currentRequest.headers,
        body: null,
      });

      const baseForBodyHook =
        headResult.requestForBodyHook ?? headResult.request;
      const headForThisHop = enableBodyHook
        ? baseForBodyHook
        : headResult.request;

      currentRequest = {
        method: headForThisHop.method,
        url: headForThisHop.url,
        headers: headForThisHop.headers,
        body: currentRequest.body,
      };

      if (enableBodyHook) {
        currentRequest = await applyRequestBodyHooks(backend, currentRequest);
      }
    }

    if (backend.options.debug) {
      backend.emitDebug(
        `http bridge ${currentRequest.method} ${currentRequest.url}`,
      );
    }

    let currentUrl: URL;
    try {
      currentUrl = new URL(currentRequest.url);
    } catch {
      respondWithError(backend, write, 400, "Bad Request", httpVersion);
      return;
    }

    const protocol = getUrlProtocol(currentUrl);
    if (!protocol) {
      respondWithError(backend, write, 400, "Bad Request", httpVersion);
      return;
    }

    const port = getUrlPort(currentUrl, protocol);
    if (!Number.isFinite(port) || port <= 0) {
      respondWithError(backend, write, 400, "Bad Request", httpVersion);
      return;
    }

    const requestLabel = `${currentRequest.method} ${currentUrl.toString()}`;
    const responseStart = Date.now();

    if (!(isFirstHop && policyCheckedFirstHop)) {
      await ensureRequestAllowed(backend, currentRequest);
      await ensureIpAllowed(backend, currentUrl, protocol, port);
    }

    const useDefaultFetch = backend.options.fetch === undefined;
    const dispatcher = useDefaultFetch
      ? getCheckedDispatcher(backend, {
          hostname: currentUrl.hostname,
          port,
          protocol,
        })
      : null;

    const streamBodyThisHop =
      isFirstHop && initialBodyStream && initialBodyStreamHasBody
        ? initialBodyStream
        : null;

    const bodyInit = streamBodyThisHop
      ? streamBodyThisHop
      : currentRequest.body
        ? new Uint8Array(currentRequest.body)
        : undefined;

    let response: FetchResponse;
    try {
      response = await fetcher(currentUrl.toString(), {
        method: currentRequest.method,
        headers: currentRequest.headers,
        body: bodyInit as any,
        redirect: "manual",
        ...(streamBodyThisHop ? { duplex: "half" } : {}),
        ...(dispatcher ? { dispatcher } : {}),
      } as any);
    } catch (err) {
      if (backend.options.debug) {
        const message = err instanceof Error ? err.message : String(err);
        backend.emitDebug(
          `http bridge fetch failed ${currentRequest.method} ${currentUrl.toString()} (${message})`,
        );
      }
      throw err;
    }

    const redirectUrl = getRedirectUrl(response, currentUrl);
    if (redirectUrl) {
      if (response.body) {
        await response.body.cancel();
      }

      if (redirectCount >= MAX_HTTP_REDIRECTS) {
        throw new HttpRequestBlockedError(
          "too many redirects",
          508,
          "Loop Detected",
        );
      }

      if (streamBodyThisHop) {
        // Streaming request bodies cannot be replayed on redirects.
        const redirected = applyRedirectRequest(
          {
            method: currentRequest.method,
            url: currentRequest.url,
            headers: currentRequest.headers,
            // Sentinel to indicate a non-empty body so redirect rewriting matches buffered semantics.
            body: Buffer.alloc(1),
          },
          response.status,
          currentUrl,
          redirectUrl,
        );

        if (redirected.body) {
          throw new HttpRequestBlockedError(
            "redirect requires replaying streamed request body",
            502,
            "Bad Gateway",
          );
        }

        pendingRequest = {
          method: redirected.method,
          url: redirected.url,
          headers: redirected.headers,
          body: null,
        };
        continue;
      }

      pendingRequest = applyRedirectRequest(
        currentRequest,
        response.status,
        currentUrl,
        redirectUrl,
      );
      continue;
    }

    if (backend.options.debug) {
      backend.emitDebug(
        `http bridge response ${response.status} ${response.statusText}`,
      );
    }

    let responseHeaders = stripHopByHopHeaders(
      headersToRecord(backend, response.headers),
    );
    const contentEncodingValue = responseHeaders["content-encoding"];
    const contentEncoding = Array.isArray(contentEncodingValue)
      ? contentEncodingValue[0]
      : contentEncodingValue;

    const contentLengthValue = responseHeaders["content-length"];
    const contentLength = Array.isArray(contentLengthValue)
      ? contentLengthValue[0]
      : contentLengthValue;

    const parsedLength = contentLength ? Number(contentLength) : null;
    const hasValidLength =
      parsedLength !== null &&
      Number.isFinite(parsedLength) &&
      parsedLength >= 0;

    if (contentEncoding) {
      delete responseHeaders["content-encoding"];
      delete responseHeaders["content-length"];
    }
    responseHeaders["connection"] = "close";

    const responseBodyStream =
      response.body as WebReadableStream<Uint8Array> | null;

    const suppressBody =
      currentRequest.method === "HEAD" ||
      response.status === 204 ||
      response.status === 304;

    if (suppressBody) {
      if (responseBodyStream) {
        try {
          await responseBodyStream.cancel();
        } catch {
          // ignore cancellation failures
        }
      }

      // No message body is allowed for these responses.
      delete responseHeaders["transfer-encoding"];

      if (response.status === 204 || response.status === 304) {
        delete responseHeaders["content-encoding"];
        responseHeaders["content-length"] = "0";
      } else {
        // HEAD: preserve Content-Length if present, otherwise be explicit.
        if (!responseHeaders["content-length"])
          responseHeaders["content-length"] = "0";
      }

      let hookResponse: HttpHookResponse = {
        status: response.status,
        statusText: response.statusText || "OK",
        headers: responseHeaders,
        body: Buffer.alloc(0),
      };

      if (backend.options.httpHooks?.onResponse) {
        const updated = await backend.options.httpHooks.onResponse(
          hookResponse,
          currentRequest,
        );
        if (updated) hookResponse = updated;
      }

      sendHttpResponse(backend, write, hookResponse, httpVersion);
      return;
    }

    const canStream =
      Boolean(responseBodyStream) && !backend.options.httpHooks?.onResponse;

    if (canStream && responseBodyStream) {
      const allowChunked = httpVersion === "HTTP/1.1";
      let streamedBytes = 0;

      if (contentEncoding || !hasValidLength) {
        delete responseHeaders["content-length"];

        if (allowChunked) {
          responseHeaders["transfer-encoding"] = "chunked";
          sendHttpResponseHead(
            backend,
            write,
            {
              status: response.status,
              statusText: response.statusText || "OK",
              headers: responseHeaders,
            },
            httpVersion,
          );
          streamedBytes = await sendChunkedBody(
            backend,
            responseBodyStream,
            write,
            waitForWritable,
          );
        } else {
          delete responseHeaders["transfer-encoding"];
          sendHttpResponseHead(
            backend,
            write,
            {
              status: response.status,
              statusText: response.statusText || "OK",
              headers: responseHeaders,
            },
            httpVersion,
          );
          streamedBytes = await sendStreamBody(
            backend,
            responseBodyStream,
            write,
            waitForWritable,
          );
        }
      } else {
        responseHeaders["content-length"] = parsedLength!.toString();
        delete responseHeaders["transfer-encoding"];
        sendHttpResponseHead(
          backend,
          write,
          {
            status: response.status,
            statusText: response.statusText || "OK",
            headers: responseHeaders,
          },
          httpVersion,
        );
        streamedBytes = await sendStreamBody(
          backend,
          responseBodyStream,
          write,
          waitForWritable,
        );
      }

      if (backend.options.debug) {
        const elapsed = Date.now() - responseStart;
        backend.emitDebug(
          `http bridge body complete ${requestLabel} ${streamedBytes} bytes in ${elapsed}ms`,
        );
      }

      return;
    }

    const maxResponseBytes = backend.http.maxHttpResponseBodyBytes;

    if (
      hasValidLength &&
      !contentEncoding &&
      parsedLength! > maxResponseBytes
    ) {
      if (responseBodyStream) {
        try {
          await responseBodyStream.cancel();
        } catch {
          // ignore cancellation failures
        }
      }
      throw new HttpRequestBlockedError(
        `response body exceeds ${maxResponseBytes} bytes`,
        502,
        "Bad Gateway",
      );
    }

    const responseBody = responseBodyStream
      ? await bufferResponseBodyWithLimit(
          backend,
          responseBodyStream,
          maxResponseBytes,
        )
      : Buffer.from(await response.arrayBuffer());

    if (responseBody.length > maxResponseBytes) {
      throw new HttpRequestBlockedError(
        `response body exceeds ${maxResponseBytes} bytes`,
        502,
        "Bad Gateway",
      );
    }

    responseHeaders["content-length"] = responseBody.length.toString();

    let hookResponse: HttpHookResponse = {
      status: response.status,
      statusText: response.statusText || "OK",
      headers: responseHeaders,
      body: responseBody,
    };

    if (backend.options.httpHooks?.onResponse) {
      const updated = await backend.options.httpHooks.onResponse(
        hookResponse,
        currentRequest,
      );
      if (updated) hookResponse = updated;
    }

    sendHttpResponse(backend, write, hookResponse, httpVersion);
    if (backend.options.debug) {
      const elapsed = Date.now() - responseStart;
      backend.emitDebug(
        `http bridge body complete ${requestLabel} ${hookResponse.body.length} bytes in ${elapsed}ms`,
      );
    }
    return;
  }
}

function isWebSocketUpgradeRequest(
  backend: QemuNetworkBackend,
  request: HttpRequestData,
): boolean {
  const upgrade = request.headers["upgrade"]?.toLowerCase() ?? "";
  if (upgrade === "websocket") return true;

  // Some clients omit Upgrade/Connection but include the WebSocket-specific headers.
  if (
    request.headers["sec-websocket-key"] ||
    request.headers["sec-websocket-version"]
  )
    return true;

  return false;
}

async function handleWebSocketUpgrade(
  backend: QemuNetworkBackend,
  key: string,
  request: HttpRequestData,
  session: TcpSession,
  options: {
    scheme: "http" | "https";
    write: (chunk: Buffer) => void;
    finish: () => void;
  },
  httpVersion: "HTTP/1.0" | "HTTP/1.1",
  hookContext: {
    /** head after `onRequestHead` (and secret substitution) */
    headHookRequest: HttpHookRequest;
    /** placeholder-only head to feed into `onRequest` */
    headHookRequestForBodyHook: HttpHookRequest | null;
  },
): Promise<boolean> {
  if (request.version !== "HTTP/1.1") {
    throw new HttpRequestBlockedError(
      "websocket upgrade requires HTTP/1.1",
      501,
      "Not Implemented",
    );
  }

  // WebSocket upgrades are always GET without a body.
  if (request.method.toUpperCase() !== "GET") {
    throw new HttpRequestBlockedError(
      "websocket upgrade requires GET",
      400,
      "Bad Request",
    );
  }
  if (request.body.length > 0) {
    throw new HttpRequestBlockedError(
      "websocket upgrade requests must not have a body",
      400,
      "Bad Request",
    );
  }

  const { headHookRequest, headHookRequestForBodyHook } = hookContext;

  // `handleHttpDataWithWriter` already ran `onRequestHead` (and the associated
  // policy checks) for this request. Avoid running it again here (duplicate
  // side effects + policy mismatches).
  let hookRequest: HttpHookRequest = {
    method: headHookRequest.method,
    url: headHookRequest.url,
    headers: { ...headHookRequest.headers },
    body: null,
  };

  // Preserve placeholder-only values for `onRequest` (per secrets docs). The
  // `createHttpHooks` wrapper will inject secrets after the user hook runs.
  hookRequest = await applyRequestBodyHooks(
    backend,
    headHookRequestForBodyHook ?? hookRequest,
  );

  // If `onRequest` rewrote the destination or relevant headers, re-run request
  // policy checks against the final (post-rewrite) request.
  if (!isSamePolicyRelevantRequestHead(backend, hookRequest, headHookRequest)) {
    await ensureRequestAllowed(backend, hookRequest);
  }

  const method = (hookRequest.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    throw new HttpRequestBlockedError(
      "websocket upgrade requires GET",
      400,
      "Bad Request",
    );
  }

  if (hookRequest.body && hookRequest.body.length > 0) {
    throw new HttpRequestBlockedError(
      "websocket upgrade requests must not have a body",
      400,
      "Bad Request",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(hookRequest.url);
  } catch {
    throw new HttpRequestBlockedError("invalid url", 400, "Bad Request");
  }

  const protocol = getUrlProtocol(parsedUrl);
  if (!protocol) {
    throw new HttpRequestBlockedError(
      "unsupported protocol",
      400,
      "Bad Request",
    );
  }

  const port = getUrlPort(parsedUrl, protocol);
  if (!Number.isFinite(port) || port <= 0) {
    throw new HttpRequestBlockedError("invalid port", 400, "Bad Request");
  }

  // Resolve all A/AAAA records and pick the first IP allowed by policy.
  // This pins the websocket tunnel to an allowed address and avoids rejecting
  // a hostname just because the first DNS answer is blocked.
  const { address } = await resolveHostname(backend, parsedUrl.hostname, {
    protocol,
    port,
  });

  const ws = session.ws;
  if (!ws) {
    throw new Error("internal error: websocket state missing");
  }

  const upstream = await connectWebSocketUpstream(backend, {
    protocol,
    hostname: parsedUrl.hostname,
    address,
    port,
  });

  ws.upstream = upstream;

  // Also store upstream in `session.socket` so pause/resume + close propagate.
  session.socket = upstream;
  session.connected = true;

  if (session.flowControlPaused) {
    try {
      upstream.pause();
    } catch {
      // ignore
    }
  }

  const guestWrite = (chunk: Buffer) => {
    options.write(chunk);
    backend.flush();
  };

  let finished = false;
  const finishOnce = () => {
    if (finished) return;
    finished = true;
    options.finish();
  };

  // Ensure Host header exists.
  const reqHeaders: Record<string, string> = { ...hookRequest.headers };
  if (!reqHeaders["host"]) {
    reqHeaders["host"] = parsedUrl.host;
  }

  // Remove body framing headers; websocket handshakes do not send a body.
  delete reqHeaders["content-length"];
  delete reqHeaders["transfer-encoding"];
  delete reqHeaders["expect"];

  const target = (parsedUrl.pathname || "/") + parsedUrl.search;

  const headerLines: string[] = [];
  headerLines.push(`${method} ${target} HTTP/1.1`);
  for (const [rawName, rawValue] of Object.entries(reqHeaders)) {
    const name = rawName.replace(/[\r\n:]+/g, "");
    if (!name) continue;
    const value = String(rawValue).replace(/[\r\n]+/g, " ");
    headerLines.push(`${name}: ${value}`);
  }
  const headerBlob = headerLines.join("\r\n") + "\r\n\r\n";

  upstream.write(Buffer.from(headerBlob, "latin1"));

  // Flush any guest data buffered while we were connecting.
  if (ws.pending.length > 0) {
    const pending = ws.pending;
    ws.pending = [];
    ws.pendingBytes = 0;
    for (const chunk of pending) {
      if (chunk.length === 0) continue;
      upstream.write(chunk);
    }
  }

  // Read handshake response head.
  const resp = await readUpstreamHttpResponseHead(backend, upstream);

  let responseHeaders: HttpResponseHeaders = resp.headers;

  let hookResponse: HttpHookResponse = {
    status: resp.statusCode,
    statusText: resp.statusMessage || "OK",
    headers: responseHeaders,
    body: Buffer.alloc(0),
  };

  if (backend.options.httpHooks?.onResponse) {
    const updated = await backend.options.httpHooks.onResponse(
      hookResponse,
      hookRequest,
    );
    if (updated) hookResponse = updated;
  }

  // If the hook injected a body, send it as a normal HTTP response and do not upgrade.
  if (hookResponse.body.length > 0) {
    const headers = { ...hookResponse.headers };
    delete headers["transfer-encoding"];
    headers["content-length"] = String(hookResponse.body.length);
    sendHttpResponse(
      backend,
      guestWrite,
      { ...hookResponse, headers },
      httpVersion,
    );
    finishOnce();
    upstream.destroy();
    session.ws = undefined;
    return false;
  }

  sendHttpResponseHead(backend, guestWrite, hookResponse, httpVersion);

  if (resp.rest.length > 0) {
    guestWrite(resp.rest);
  }

  const upgraded = resp.statusCode === 101 && hookResponse.status === 101;
  if (!upgraded) {
    finishOnce();
    upstream.destroy();
    session.ws = undefined;
    return false;
  }

  ws.phase = "open";

  upstream.on("data", (chunk: Buffer) => {
    guestWrite(Buffer.from(chunk));
  });

  upstream.on("end", () => {
    finishOnce();
  });

  upstream.on("error", (err: Error) => {
    backend.emit("error", err);
    abortWebSocketSession(backend, key, session, "upstream-error");
  });

  upstream.on("close", () => {
    session.ws = undefined;

    // Some upstreams emit "close" without a prior "end".
    finishOnce();

    // For plain HTTP flows, closing the upstream socket should also close the guest TCP session.
    // For TLS flows, closing the guest TLS socket triggers stack.handleTcpClosed.
    if (options.scheme === "http") {
      // If the session was already aborted/removed, do not emit a second close.
      if (!backend.tcpSessions.has(key)) return;
      backend.stack?.handleTcpClosed({ key });
      backend.resolveFlowResume(key);
      backend.tcpSessions.delete(key);
    }
  });

  // Resume after the header read paused the socket.
  try {
    upstream.resume();
  } catch {
    // ignore
  }

  return true;
}

export async function connectWebSocketUpstream(
  backend: QemuNetworkBackend,
  info: {
    protocol: "http" | "https";
    hostname: string;
    address: string;
    port: number;
  },
): Promise<net.Socket> {
  const timeoutMs = backend.http.webSocketUpstreamConnectTimeoutMs;

  if (info.protocol === "https") {
    const socket = tls.connect({
      host: info.address,
      port: info.port,
      servername: info.hostname,
      ALPNProtocols: ["http/1.1"],
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        socket.off("error", onError);
        socket.off("secureConnect", onConnect);
      };

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onError = (err: Error) => {
        settleReject(err);
      };

      const onConnect = () => {
        settleResolve();
      };

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          const err = new Error(
            `websocket upstream connect timeout after ${timeoutMs}ms`,
          );
          settleReject(err);
          try {
            socket.destroy();
          } catch {
            // ignore
          }
        }, timeoutMs);
      }

      socket.once("error", onError);
      socket.once("secureConnect", onConnect);
    });

    return socket;
  }

  const socket = new net.Socket();
  socket.connect(info.port, info.address);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      socket.off("error", onError);
      socket.off("connect", onConnect);
    };

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onError = (err: Error) => {
      settleReject(err);
    };

    const onConnect = () => {
      settleResolve();
    };

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        const err = new Error(
          `websocket upstream connect timeout after ${timeoutMs}ms`,
        );
        settleReject(err);
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }, timeoutMs);
    }

    socket.once("error", onError);
    socket.once("connect", onConnect);
  });

  return socket;
}

export async function readUpstreamHttpResponseHead(
  backend: QemuNetworkBackend,
  socket: net.Socket,
): Promise<{
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  rest: Buffer;
}> {
  let buf = Buffer.alloc(0);

  return await new Promise((resolve, reject) => {
    const timeoutMs = backend.http.webSocketUpstreamHeaderTimeoutMs;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("end", onEnd);
    };

    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const settleResolve = (value: {
      statusCode: number;
      statusMessage: string;
      headers: Record<string, string | string[]>;
      rest: Buffer;
    }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onError = (err: Error) => {
      settleReject(err);
    };

    const onClose = () => {
      settleReject(new Error("upstream closed before sending headers"));
    };

    const onEnd = () => {
      settleReject(new Error("upstream ended before sending headers"));
    };

    const onData = (chunk: Buffer) => {
      buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);

      if (buf.length > MAX_HTTP_HEADER_BYTES + 4) {
        settleReject(new Error("upstream headers too large"));
        return;
      }

      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;

      const head = buf.subarray(0, idx).toString("latin1");
      const rest = buf.subarray(idx + 4);

      try {
        socket.pause();
      } catch {
        // ignore
      }

      const [statusLine, ...headerLines] = head.split("\r\n");
      if (!statusLine) {
        settleReject(new Error("missing status line"));
        return;
      }

      const m = /^HTTP\/\d+\.\d+\s+(\d{3})\s*(.*)$/.exec(statusLine);
      if (!m) {
        settleReject(
          new Error(`invalid http status line: ${JSON.stringify(statusLine)}`),
        );
        return;
      }

      const statusCode = Number.parseInt(m[1]!, 10);
      const statusMessage = m[2] ?? "";

      const headers: Record<string, string | string[]> = {};
      for (const line of headerLines) {
        if (!line) continue;
        const i = line.indexOf(":");
        if (i === -1) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        const prev = headers[k];
        if (prev === undefined) headers[k] = v;
        else if (Array.isArray(prev)) prev.push(v);
        else headers[k] = [prev, v];
      }

      settleResolve({ statusCode, statusMessage, headers, rest });
    };

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        settleReject(
          new Error(`websocket upstream header timeout after ${timeoutMs}ms`),
        );
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }, timeoutMs);
    }

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("end", onEnd);
  });
}

function sendHttpResponseHead(
  backend: QemuNetworkBackend,
  write: (chunk: Buffer) => void,
  response: {
    status: number;
    statusText: string;
    headers: HttpResponseHeaders;
  },
  httpVersion: "HTTP/1.0" | "HTTP/1.1" = "HTTP/1.1",
) {
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
    headerBlock += headerLines.join("\r\n") + "\r\n";
  }
  headerBlock += "\r\n";
  write(Buffer.from(headerBlock));
}

function sendHttpResponse(
  backend: QemuNetworkBackend,
  write: (chunk: Buffer) => void,
  response: HttpHookResponse,
  httpVersion: "HTTP/1.0" | "HTTP/1.1" = "HTTP/1.1",
) {
  sendHttpResponseHead(backend, write, response, httpVersion);
  if (response.body.length > 0) {
    write(response.body);
  }
}

async function sendChunkedBody(
  backend: QemuNetworkBackend,
  body: WebReadableStream<Uint8Array>,
  write: (chunk: Buffer) => void,
  waitForWritable?: () => Promise<void>,
): Promise<number> {
  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      total += value.length;
      const sizeLine = Buffer.from(`${value.length.toString(16)}\r\n`);
      write(sizeLine);
      write(Buffer.from(value));
      write(Buffer.from("\r\n"));
      if (waitForWritable) {
        await waitForWritable();
      }
    }
  } finally {
    reader.releaseLock();
  }

  write(Buffer.from("0\r\n\r\n"));
  return total;
}

async function sendStreamBody(
  backend: QemuNetworkBackend,
  body: WebReadableStream<Uint8Array>,
  write: (chunk: Buffer) => void,
  waitForWritable?: () => Promise<void>,
): Promise<number> {
  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      total += value.length;
      write(Buffer.from(value));
      if (waitForWritable) {
        await waitForWritable();
      }
    }
  } finally {
    reader.releaseLock();
  }
  return total;
}

async function bufferResponseBodyWithLimit(
  backend: QemuNetworkBackend,
  body: WebReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      if (total + value.length > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore cancellation failures
        }
        throw new HttpRequestBlockedError(
          `response body exceeds ${maxBytes} bytes`,
          502,
          "Bad Gateway",
        );
      }

      total += value.length;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total);
}

function respondWithError(
  backend: QemuNetworkBackend,
  write: (chunk: Buffer) => void,
  status: number,
  statusText: string,
  httpVersion: "HTTP/1.0" | "HTTP/1.1" = "HTTP/1.1",
) {
  const body = Buffer.from(`${status} ${statusText}\n`);
  sendHttpResponse(
    backend,
    write,
    {
      status,
      statusText,
      headers: {
        "content-length": body.length.toString(),
        "content-type": "text/plain",
        connection: "close",
      },
      body,
    },
    httpVersion,
  );
}

function buildFetchUrl(
  backend: QemuNetworkBackend,
  request: HttpRequestData,
  defaultScheme: "http" | "https",
) {
  if (
    request.target.startsWith("http://") ||
    request.target.startsWith("https://") ||
    request.target.startsWith("ws://") ||
    request.target.startsWith("wss://")
  ) {
    // Map WebSocket schemes to HTTP schemes for policy checks / hooks.
    if (request.target.startsWith("ws://")) {
      return `http://${request.target.slice("ws://".length)}`;
    }
    if (request.target.startsWith("wss://")) {
      return `https://${request.target.slice("wss://".length)}`;
    }
    return request.target;
  }
  const host = request.headers["host"];
  if (!host) return null;
  return `${defaultScheme}://${host}${request.target}`;
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

export async function resolveHostname(
  backend: QemuNetworkBackend,
  hostname: string,
  policy?: { protocol: "http" | "https"; port: number },
): Promise<{ address: string; family: 4 | 6 }> {
  const ipFamily = net.isIP(hostname);

  const entries: LookupEntry[] =
    ipFamily === 4 || ipFamily === 6
      ? [{ address: hostname, family: ipFamily }]
      : normalizeLookupEntries(
          // Use all addresses so policy checks can pick the first allowed entry.
          await new Promise<dns.LookupAddress[]>((resolve, reject) => {
            const lookup = backend.options.dnsLookup ?? dns.lookup.bind(dns);
            lookup(
              hostname,
              { all: true, verbatim: true },
              (
                err: NodeJS.ErrnoException | null,
                addresses: dns.LookupAddress[],
              ) => {
                if (err) reject(err);
                else resolve(addresses);
              },
            );
          }),
        );

  if (entries.length === 0) {
    throw new Error("DNS lookup returned no addresses");
  }

  const isIpAllowed = backend.options.httpHooks?.isIpAllowed;
  if (!policy || !isIpAllowed) {
    const first = entries[0]!;
    return { address: first.address, family: first.family };
  }

  for (const entry of entries) {
    const allowed = await isIpAllowed({
      hostname,
      ip: entry.address,
      family: entry.family,
      port: policy.port,
      protocol: policy.protocol,
    } satisfies HttpIpAllowInfo);
    if (allowed) {
      return { address: entry.address, family: entry.family };
    }
  }

  throw new HttpRequestBlockedError(`blocked by policy: ${hostname}`);
}

async function ensureRequestAllowed(
  backend: QemuNetworkBackend,
  request: HttpHookRequest,
) {
  if (!backend.options.httpHooks?.isRequestAllowed) return;

  // Request policy is head-only: never expose request body to this callback.
  const headOnly: HttpHookRequest = {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: null,
  };

  const allowed = await backend.options.httpHooks.isRequestAllowed(headOnly);
  if (!allowed) {
    throw new HttpRequestBlockedError("blocked by request policy");
  }
}

async function ensureIpAllowed(
  backend: QemuNetworkBackend,
  parsedUrl: URL,
  protocol: "http" | "https",
  port: number,
) {
  if (!backend.options.httpHooks?.isIpAllowed) return;

  // Resolve all A/AAAA records and ensure at least one address is permitted.
  // When using the default fetch, the guarded undici lookup will additionally
  // pin the actual connect to an allowed IP.
  await resolveHostname(backend, parsedUrl.hostname, { protocol, port });
}

function isSamePolicyRelevantRequestHead(
  backend: QemuNetworkBackend,
  a: HttpHookRequest,
  b: HttpHookRequest,
): boolean {
  if (a.method !== b.method) return false;
  if (a.url !== b.url) return false;

  const normalize = (headers: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      // These are framing headers that the bridge may normalize between the
      // head parsing step and the eventual fetch.
      if (lower === "content-length" || lower === "transfer-encoding") continue;
      out[lower] = value;
    }
    return out;
  };

  const ah = normalize(a.headers);
  const bh = normalize(b.headers);
  const aKeys = Object.keys(ah);
  const bKeys = Object.keys(bh);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!(key in bh)) return false;
    if (ah[key] !== bh[key]) return false;
  }

  return true;
}

async function applyRequestHeadHooks(
  backend: QemuNetworkBackend,
  request: HttpHookRequest,
): Promise<{
  request: HttpHookRequest;
  /** optional placeholder request head to feed into `httpHooks.onRequest` */
  requestForBodyHook: HttpHookRequest | null;
  bufferRequestBody: boolean;
  maxBufferedRequestBodyBytes: number | null;
}> {
  const hasBodyHook = Boolean(backend.options.httpHooks?.onRequest);

  if (!backend.options.httpHooks?.onRequestHead) {
    return {
      request,
      requestForBodyHook: null,
      bufferRequestBody: hasBodyHook,
      maxBufferedRequestBodyBytes: null,
    };
  }

  const cloned: HttpHookRequest = {
    method: request.method,
    url: request.url,
    headers: { ...request.headers },
    body: null,
  };

  const updated = await backend.options.httpHooks.onRequestHead(cloned);
  const next = (updated ?? cloned) as HttpHookRequest & {
    bufferRequestBody?: boolean;
    maxBufferedRequestBodyBytes?: number;
    requestForBodyHook?: HttpHookRequest;
  };

  return {
    request: {
      method: next.method,
      url: next.url,
      headers: next.headers,
      body: null,
    },
    requestForBodyHook: next.requestForBodyHook ?? null,
    bufferRequestBody:
      typeof next.bufferRequestBody === "boolean"
        ? next.bufferRequestBody
        : hasBodyHook,
    maxBufferedRequestBodyBytes:
      typeof next.maxBufferedRequestBodyBytes === "number" &&
      Number.isFinite(next.maxBufferedRequestBodyBytes) &&
      next.maxBufferedRequestBodyBytes >= 0
        ? next.maxBufferedRequestBodyBytes
        : null,
  };
}

async function applyRequestBodyHooks(
  backend: QemuNetworkBackend,
  request: HttpHookRequest,
): Promise<HttpHookRequest> {
  if (!backend.options.httpHooks?.onRequest) {
    return request;
  }

  const cloned: HttpHookRequest = {
    method: request.method,
    url: request.url,
    headers: { ...request.headers },
    body: request.body,
  };

  const updated = await backend.options.httpHooks.onRequest(cloned);
  return updated ?? cloned;
}

function headersToRecord(
  backend: QemuNetworkBackend,
  headers: Headers,
): HttpResponseHeaders {
  const record: HttpResponseHeaders = {};

  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });

  // undici/Node fetch supports multiple Set-Cookie values via getSetCookie().
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

function getUrlProtocol(url: URL): "http" | "https" | null {
  if (url.protocol === "https:") return "https";
  if (url.protocol === "http:") return "http";
  return null;
}

function getUrlPort(url: URL, protocol: "http" | "https"): number {
  if (url.port) return Number(url.port);
  return protocol === "https" ? 443 : 80;
}

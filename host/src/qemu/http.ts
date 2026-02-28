import net from "net";
import dns from "dns";
import { fetch as undiciFetch } from "undici";
import type { ReadableStream as WebReadableStream } from "stream/web";

import { ON_REQUEST_EARLY_POLICY_SAFE } from "./contracts.ts";
import type {
  HttpIpAllowInfo,
  QemuNetworkBackend,
  TcpSession,
} from "./contracts.ts";
import type {
  InternalHttpRequest,
  InternalHttpResponse,
  InternalHttpResponseHeaders,
} from "../internal/http-types.ts";

import {
  bridgeWebSocketUpgrade,
  handleWebSocketClientData,
  isWebSocketUpgradeRequest,
} from "./ws.ts";

import {
  HttpReceiveBuffer,
  HttpRequestBlockedError,
  MAX_HTTP_HEADER_BYTES,
  parseHeaderLines,
  coalesceHeaderRecord,
  parseContentLength,
  applyRedirectRequest,
  getCheckedDispatcher,
  getRedirectUrl,
  normalizeLookupEntries,
  sendHttpResponse,
  sendHttpResponseHead,
  stripHopByHopHeaders,
  stripHopByHopHeadersForWebSocket,
} from "../http/utils.ts";
import type { HttpRequestData, LookupEntry } from "../http/utils.ts";
import {
  webRequestToInternalHttpRequest,
  webResponseToInternalHttpResponse,
  internalHttpRequestToWebRequest,
  internalHttpResponseToWebResponse,
  responseHeadersToRecord,
} from "../internal/http-conversion.ts";

const MAX_HTTP_REDIRECTS = 10;
export { MAX_HTTP_HEADER_BYTES };
export const MAX_HTTP_PIPELINE_BYTES = 64 * 1024;

// When streaming request bodies (Content-Length, no buffering), keep the internal
// ReadableStream queue bounded and apply coarse-grained backpressure to QEMU.
const HTTP_STREAMING_REQUEST_BODY_HIGH_WATER_BYTES = 64 * 1024;
const HTTP_STREAMING_RX_PAUSE_HIGH_WATER_BYTES = 512 * 1024;
const HTTP_STREAMING_RX_PAUSE_LOW_WATER_BYTES = 256 * 1024;

// Chunked framing (chunk-size lines + trailers) can add overhead on top of the decoded body.
// Keep this bounded separately from maxHttpBodyBytes.
const MAX_HTTP_CHUNKED_OVERHEAD_BYTES = 256 * 1024;

type FetchResponse = Awaited<ReturnType<typeof undiciFetch>>;

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

    requestBase: InternalHttpRequest;
    maxBodyBytes: number;
    /** whether request/ip policy already ran on parsed head */
    policyPrechecked: boolean;

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
    /** whether to discard remaining declared body bytes instead of enqueueing */
    dropRemainingBody: boolean;
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

function has100ContinueExpectation(headers: Record<string, string>): boolean {
  const expect = headers["expect"]?.toLowerCase();
  if (!expect) return false;

  return expect
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes("100-continue");
}

function maybeSend100ContinueFromHead(
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
  if (!has100ContinueExpectation(head.headers)) return;

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

function cleanupStreamingBodyState(
  backend: QemuNetworkBackend,
  httpSession: HttpSession,
  cause?: Error,
): void {
  const streamState = httpSession.streamingBody;
  if (!streamState) {
    return;
  }

  const controller = streamState.controller;
  if (cause) {
    try {
      controller?.error(cause);
    } catch {
      // ignore
    }
  }

  streamState.done = true;
  streamState.controller = null;
  streamState.pending.length = 0;
  streamState.pendingBytes = 0;
  streamState.closeAfterPending = false;

  httpSession.streamingBody = undefined;
  updateQemuRxPauseState(backend);
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
      streamState.remaining -= take;

      if (!streamState.dropRemainingBody) {
        streamState.pending.push(data.subarray(0, take));
        streamState.pendingBytes += take;
        streamState.drain();
      }
    }

    if (streamState.remaining === 0) {
      streamState.done = true;
      if (!streamState.dropRemainingBody) {
        streamState.closeAfterPending = true;
        streamState.drain();
      }
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
      const head = parseHttpHead(headBuf);
      if (!head) return;

      const bufferedBodyBytes = Math.max(
        0,
        httpSession.buffer.length - head.bodyOffset,
      );

      const rawHeaders = head.headers;
      const headers = coalesceHeaderRecord(rawHeaders);

      // Validate Expect early so we don't send 100-continue for requests we must reject.
      validateExpectHeader(head.version, headers);

      // Asterisk-form (OPTIONS *) is valid HTTP but does not map to a URL fetch.
      if (head.method === "OPTIONS" && head.target === "*") {
        const version: "HTTP/1.0" | "HTTP/1.1" =
          head.version === "HTTP/1.0" ? "HTTP/1.0" : "HTTP/1.1";
        respondWithError(options.write, 501, "Not Implemented", version);
        httpSession.closed = true;
        options.finish();
        backend.flush();
        return;
      }

      // Determine request body framing.
      let bodyMode: "none" | "content-length" | "chunked" = "none";
      let contentLength = 0;

      const transferEncodingHeader = headers["transfer-encoding"];
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
        const rawContentLength = rawHeaders["content-length"];
        const parsedContentLength = parseContentLength(rawContentLength);

        // If Content-Length is present but invalid, reject the request instead of
        // silently treating it as missing (which can cause us to forward malformed
        // requests upstream).
        if (rawContentLength !== undefined && parsedContentLength === null) {
          throw new HttpRequestBlockedError(
            "invalid content-length",
            400,
            "Bad Request",
          );
        }

        if (parsedContentLength !== null) {
          contentLength = parsedContentLength;
          headers["content-length"] = String(contentLength);
        }

        if (contentLength > 0) {
          bodyMode = "content-length";
        }
      }

      const dummyRequest: HttpRequestData = {
        method: head.method,
        target: head.target,
        version: head.version,
        headers,
        body: Buffer.alloc(0),
      };

      const hasUpgrade = (() => {
        const connection = headers["connection"]?.toLowerCase() ?? "";
        return (
          Boolean(headers["upgrade"]) ||
          connection
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
            .includes("upgrade") ||
          Boolean(headers["sec-websocket-key"]) ||
          Boolean(headers["sec-websocket-version"])
        );
      })();

      const upgradeIsWebSocket = isWebSocketUpgradeRequest(dummyRequest);
      if (hasUpgrade && !(backend.http.allowWebSockets && upgradeIsWebSocket)) {
        const version: "HTTP/1.0" | "HTTP/1.1" =
          head.version === "HTTP/1.0" ? "HTTP/1.0" : "HTTP/1.1";
        respondWithError(options.write, 501, "Not Implemented", version);
        httpSession.closed = true;
        options.finish();
        backend.flush();
        return;
      }

      const url = buildFetchUrl(dummyRequest, options.scheme);
      if (!url) {
        const version: "HTTP/1.0" | "HTTP/1.1" =
          head.version === "HTTP/1.0" ? "HTTP/1.0" : "HTTP/1.1";
        respondWithError(options.write, 400, "Bad Request", version);
        httpSession.closed = true;
        options.finish();
        backend.flush();
        return;
      }

      const requestBase: InternalHttpRequest = {
        method: head.method,
        url,
        headers: upgradeIsWebSocket
          ? stripHopByHopHeadersForWebSocket(headers)
          : stripHopByHopHeaders(headers),
        body: null,
      };

      const maxBodyBytes = backend.http.maxHttpBodyBytes;

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

      const policyPrechecked = shouldPrecheckRequestPolicies(backend);
      if (policyPrechecked) {
        // Guard against re-entrant calls: the TLS data handler fires
        // without awaiting, so a second chunk can arrive while we are
        // blocked on DNS / IP-policy below.  Setting processing=true
        // here causes the next call to return early at the check above
        // (the new data is already appended to the buffer and will be
        // consumed when the current call resumes).
        httpSession.processing = true;
        await ensureRequestHeadPolicies(backend, requestBase);
        httpSession.processing = false;
      }

      httpSession.head = {
        method: head.method,
        target: head.target,
        version: head.version,
        headers,
        bodyOffset: head.bodyOffset,
        requestBase,
        maxBodyBytes,
        policyPrechecked,
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

      if (isWebSocketUpgradeRequest(stub)) {
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
              baseRequest: state.requestBase,
              policyPrechecked: state.policyPrechecked,
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

    // Buffering / streaming decision based on request framing.
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
        httpSession.buffer,
        state.bodyOffset,
        state.maxBodyBytes,
      );

      if (!chunked.complete) {
        maybeSend100ContinueFromHead(
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
      const baseRequest = state.requestBase;
      const request: InternalHttpRequest = {
        method: baseRequest.method,
        url: baseRequest.url,
        headers: {
          ...baseRequest.headers,
          "content-length": body.length.toString(),
        },
        body: body.length > 0 ? body : null,
      };

      request.headers = { ...request.headers };
      delete request.headers["transfer-encoding"];
      if (request.body) {
        request.headers["content-length"] = request.body.length.toString();
      } else {
        delete request.headers["content-length"];
      }

      httpSession.processing = true;
      let releaseHttpConcurrency: (() => void) | null = null;

      try {
        releaseHttpConcurrency = await backend.http.httpConcurrency.acquire();
        await fetchHookRequestAndRespond(backend, {
          request,
          httpVersion,
          write: options.write,
          waitForWritable: options.waitForWritable,
          policyCheckedFirstHop: state.policyPrechecked,
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

    if (contentLength > 0 && bufferedBodyBytes < contentLength) {
      // If the client uses Expect: 100-continue and no body bytes have arrived yet,
      // send the interim response first and wait for more data.
      const expect = state.headers["expect"]?.toLowerCase() ?? "";
      if (expect.includes("100-continue") && bufferedBodyBytes === 0) {
        maybeSend100ContinueFromHead(
          httpSession,
          state,
          bufferedBodyBytes,
          options.write,
        );
        return;
      }

      // Start streaming the request body to the upstream fetch.
      const streamState: NonNullable<HttpSession["streamingBody"]> = {
        remaining: contentLength,
        controller: null,
        done: false,
        dropRemainingBody: false,
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
                // Dequeue BEFORE enqueue: c.enqueue() can synchronously
                // trigger the pull() callback which re-enters drain().
                // If we enqueue first, the re-entrant drain() sees the
                // same head in pending and double-deducts pendingBytes.
                streamState.pending.shift();
                streamState.pendingBytes -= head.length;
                c.enqueue(head);
              } else {
                const remainder = head.subarray(desired);
                streamState.pending[0] = remainder;
                streamState.pendingBytes -= desired;
                c.enqueue(head.subarray(0, desired));
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
            streamState.done = streamState.remaining === 0;
            streamState.dropRemainingBody = streamState.remaining > 0;
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
            streamState.done = streamState.remaining === 0;
            streamState.dropRemainingBody = streamState.remaining > 0;
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
      const streamingRequest: InternalHttpRequest = {
        method: state.requestBase.method,
        url: state.requestBase.url,
        headers: Object.fromEntries(
          Object.entries(state.requestBase.headers).map(([key, value]) => [
            key.toLowerCase(),
            value,
          ]),
        ),
        body: null,
      };

      const expectedLength = contentLength.toString();
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
            policyCheckedFirstHop: state.policyPrechecked,
            initialBodyStream: bodyStream as any,
            initialBodyStreamHasBody: true,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));

          cleanupStreamingBodyState(backend, httpSession, error);

          if (error instanceof HttpRequestBlockedError) {
            if (backend.options.debug) {
              backend.emitDebug(`http blocked ${error.message}`);
            }
            respondWithError(
              safeWrite,
              error.status,
              error.statusText,
              httpVersion,
            );
          } else {
            backend.emit("error", error);
            respondWithError(safeWrite, 502, "Bad Gateway", httpVersion);
          }
        } finally {
          releaseHttpConcurrency?.();
          cleanupStreamingBodyState(backend, httpSession);
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

    const baseRequest = state.requestBase;
    const request: InternalHttpRequest = {
      method: baseRequest.method,
      url: baseRequest.url,
      headers: { ...baseRequest.headers },
      body: body.length > 0 ? Buffer.from(body) : null,
    };

    // Normalize framing headers for fetch.
    request.headers = { ...request.headers };
    delete request.headers["transfer-encoding"];
    if (request.body) {
      request.headers["content-length"] = request.body.length.toString();
    } else {
      delete request.headers["content-length"];
    }

    httpSession.processing = true;
    let releaseHttpConcurrency: (() => void) | null = null;

    try {
      releaseHttpConcurrency = await backend.http.httpConcurrency.acquire();
      await fetchHookRequestAndRespond(backend, {
        request,
        httpVersion,
        write: options.write,
        waitForWritable: options.waitForWritable,
        policyCheckedFirstHop: state.policyPrechecked,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (error instanceof HttpRequestBlockedError) {
        if (backend.options.debug) {
          backend.emitDebug(`http blocked ${error.message}`);
        }
        respondWithError(
          options.write,
          error.status,
          error.statusText,
          httpVersion,
        );
      } else {
        backend.emit("error", error);
        respondWithError(options.write, 502, "Bad Gateway", httpVersion);
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
      respondWithError(options.write, error.status, error.statusText, version);
    } else {
      backend.emit("error", error);
      respondWithError(options.write, 400, "Bad Request", version);
    }

    // Abort any active upstream body stream.
    cleanupStreamingBodyState(backend, httpSession, error);

    httpSession.closed = true;
    options.finish();
    backend.flush();
  }
}

function parseHttpHead(buffer: Buffer): {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string | string[]>;
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

  const headers = parseHeaderLines(lines.slice(1));

  return {
    method,
    target,
    version,
    headers,
    bodyOffset: headerEnd + 4,
  };
}

function validateExpectHeader(
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
    request: InternalHttpRequest;
    httpVersion: "HTTP/1.0" | "HTTP/1.1";
    write: (chunk: Buffer) => void;
    waitForWritable?: () => Promise<void>;
    /** whether first-hop request/ip policies already ran on parsed head */
    policyCheckedFirstHop?: boolean;

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
    policyCheckedFirstHop = false,
    initialBodyStream = null,
    initialBodyStreamHasBody = Boolean(initialBodyStream),
  } = options;

  const fetcher = backend.options.fetch ?? undiciFetch;

  let pendingRequest: InternalHttpRequest = initialRequest;

  for (
    let redirectCount = 0;
    redirectCount <= MAX_HTTP_REDIRECTS;
    redirectCount += 1
  ) {
    const isFirstHop = redirectCount === 0;

    const streamBodyThisHop =
      isFirstHop && initialBodyStream && initialBodyStreamHasBody
        ? initialBodyStream
        : null;

    const requestHooked = await applyRequestHooks(backend, pendingRequest, {
      maxBodyBytes: backend.http.maxHttpBodyBytes,
      bodyStream: streamBodyThisHop,
    });

    if (requestHooked.shortCircuitResponse) {
      const normalized = normalizeHookResponseForGuest(
        requestHooked.shortCircuitResponse,
        pendingRequest.method,
      );
      sendHttpResponse(write, normalized, httpVersion);
      return;
    }

    const currentRequest = requestHooked.request;
    const bodyStream = requestHooked.bodyStream;

    if (backend.options.debug) {
      backend.emitDebug(
        `http bridge ${currentRequest.method} ${currentRequest.url}`,
      );
    }

    let currentUrl: URL;
    try {
      currentUrl = new URL(currentRequest.url);
    } catch {
      respondWithError(write, 400, "Bad Request", httpVersion);
      return;
    }

    const protocol = getUrlProtocol(currentUrl);
    if (!protocol) {
      respondWithError(write, 400, "Bad Request", httpVersion);
      return;
    }

    const port = getUrlPort(currentUrl, protocol);
    if (!Number.isFinite(port) || port <= 0) {
      respondWithError(write, 400, "Bad Request", httpVersion);
      return;
    }

    const requestLabel = `${currentRequest.method} ${currentUrl.toString()}`;
    const responseStart = Date.now();

    const canSkipFirstHopPolicyChecks =
      isFirstHop &&
      policyCheckedFirstHop &&
      !hasPolicyRelevantRequestHeadChange(pendingRequest, currentRequest);

    if (!canSkipFirstHopPolicyChecks) {
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

    const bodyInit = bodyStream
      ? bodyStream
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
        ...(bodyStream ? { duplex: "half" } : {}),
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

      if (bodyStream) {
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
      responseHeadersToRecord(response.headers),
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
      response.status === 205 ||
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

      if (
        response.status === 204 ||
        response.status === 205 ||
        response.status === 304
      ) {
        delete responseHeaders["content-encoding"];
        responseHeaders["content-length"] = "0";
      } else {
        // HEAD: preserve Content-Length if present, otherwise be explicit.
        if (!responseHeaders["content-length"])
          responseHeaders["content-length"] = "0";
      }

      let hookResponse: InternalHttpResponse = {
        status: response.status,
        statusText: response.statusText || "OK",
        headers: responseHeaders,
        body: Buffer.alloc(0),
      };

      hookResponse = await applyResponseHooks(
        backend,
        hookResponse,
        currentRequest,
      );

      sendHttpResponse(
        write,
        normalizeHookResponseForGuest(hookResponse, currentRequest.method),
        httpVersion,
      );
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
            write,
            {
              status: response.status,
              statusText: response.statusText || "OK",
              headers: responseHeaders,
            },
            httpVersion,
          );
          streamedBytes = await sendChunkedBody(
            responseBodyStream,
            write,
            waitForWritable,
          );
        } else {
          delete responseHeaders["transfer-encoding"];
          sendHttpResponseHead(
            write,
            {
              status: response.status,
              statusText: response.statusText || "OK",
              headers: responseHeaders,
            },
            httpVersion,
          );
          streamedBytes = await sendStreamBody(
            responseBodyStream,
            write,
            waitForWritable,
          );
        }
      } else {
        responseHeaders["content-length"] = parsedLength!.toString();
        delete responseHeaders["transfer-encoding"];
        sendHttpResponseHead(
          write,
          {
            status: response.status,
            statusText: response.statusText || "OK",
            headers: responseHeaders,
          },
          httpVersion,
        );
        streamedBytes = await sendStreamBody(
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
      ? await bufferResponseBodyWithLimit(responseBodyStream, maxResponseBytes)
      : Buffer.from(await response.arrayBuffer());

    if (responseBody.length > maxResponseBytes) {
      throw new HttpRequestBlockedError(
        `response body exceeds ${maxResponseBytes} bytes`,
        502,
        "Bad Gateway",
      );
    }

    responseHeaders["content-length"] = responseBody.length.toString();

    let hookResponse: InternalHttpResponse = {
      status: response.status,
      statusText: response.statusText || "OK",
      headers: responseHeaders,
      body: responseBody,
    };

    hookResponse = await applyResponseHooks(
      backend,
      hookResponse,
      currentRequest,
    );
    hookResponse = normalizeHookResponseForGuest(
      hookResponse,
      currentRequest.method,
    );

    sendHttpResponse(write, hookResponse, httpVersion);
    if (backend.options.debug) {
      const elapsed = Date.now() - responseStart;
      backend.emitDebug(
        `http bridge body complete ${requestLabel} ${hookResponse.body.length} bytes in ${elapsed}ms`,
      );
    }
    return;
  }
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
    /** parsed request head before onRequest */
    baseRequest: InternalHttpRequest;
    /** whether request policy already ran on parsed head */
    policyPrechecked: boolean;
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

  const { baseRequest, policyPrechecked } = hookContext;

  const requestHooked = await applyRequestHooks(backend, baseRequest, {
    maxBodyBytes: 0,
    bodyStream: null,
  });

  if (requestHooked.shortCircuitResponse) {
    const normalized = normalizeHookResponseForGuest(
      requestHooked.shortCircuitResponse,
      baseRequest.method,
    );
    sendHttpResponse(options.write, normalized, httpVersion);
    return false;
  }

  const hookRequest = requestHooked.request;
  const requestPolicyNeedsRecheck =
    !policyPrechecked ||
    hasPolicyRelevantRequestHeadChange(baseRequest, hookRequest);
  if (requestPolicyNeedsRecheck) {
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

  return await bridgeWebSocketUpgrade(
    backend,
    key,
    session,
    {
      protocol,
      address,
      port,
      method,
      parsedUrl,
      hookRequest,
    },
    options,
    httpVersion,
  );
}

async function sendChunkedBody(
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
  write: (chunk: Buffer) => void,
  status: number,
  statusText: string,
  httpVersion: "HTTP/1.0" | "HTTP/1.1" = "HTTP/1.1",
) {
  const body = Buffer.from(`${status} ${statusText}\n`);
  sendHttpResponse(
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

function hasPolicyRelevantRequestHeadChange(
  before: InternalHttpRequest,
  after: InternalHttpRequest,
): boolean {
  if (before.method !== after.method) return true;
  if (before.url !== after.url) return true;

  const beforeEntries = Object.entries(before.headers);
  const afterEntries = Object.entries(after.headers);
  if (beforeEntries.length !== afterEntries.length) return true;

  for (const [key, value] of beforeEntries) {
    if (after.headers[key] !== value) {
      return true;
    }
  }

  return false;
}

function shouldPrecheckRequestPolicies(backend: QemuNetworkBackend): boolean {
  const onRequest = backend.options.httpHooks?.onRequest;
  if (!onRequest) {
    return true;
  }

  return onRequest[ON_REQUEST_EARLY_POLICY_SAFE] === true;
}

async function ensureRequestHeadPolicies(
  backend: QemuNetworkBackend,
  request: InternalHttpRequest,
): Promise<void> {
  await ensureRequestAllowed(backend, request);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
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

  await ensureIpAllowed(backend, parsedUrl, protocol, port);
}

async function ensureRequestAllowed(
  backend: QemuNetworkBackend,
  request: InternalHttpRequest,
) {
  if (!backend.options.httpHooks?.isRequestAllowed) return;

  // Request policy is head-only: never expose request body to this callback.
  const headOnly = internalHttpRequestToWebRequest({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: null,
  });

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

function internalRequestToWebRequestWithBody(
  request: InternalHttpRequest,
  options: {
    bodyStream: WebReadableStream<Uint8Array> | null;
  },
): Request {
  const method = request.method.toUpperCase();
  const hasBufferedBody = Boolean(request.body && request.body.length > 0);
  const hasBody = hasBufferedBody || Boolean(options.bodyStream);
  const canHaveBody = method !== "GET" && method !== "HEAD";

  if (hasBody && !canHaveBody) {
    throw new HttpRequestBlockedError(
      `request body not allowed for ${method} in web hooks`,
      400,
      "Bad Request",
    );
  }

  const body = options.bodyStream
    ? options.bodyStream
    : hasBufferedBody
      ? new Uint8Array(request.body!)
      : undefined;

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: body as any,
    ...(options.bodyStream ? ({ duplex: "half" } as const) : {}),
  });
}

function webRequestHeadToInternalHttpRequest(
  request: Request,
  body: Buffer | null,
): InternalHttpRequest {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return {
    method: request.method,
    url: request.url,
    headers,
    body,
  };
}

type RequestHookOutcome =
  | {
      kind: "forward";
      request: Request;
    }
  | {
      kind: "short-circuit";
      response: InternalHttpResponse;
    };

type RequestBodyPlan =
  | {
      kind: "preserve-original";
    }
  | {
      kind: "none";
    }
  | {
      kind: "materialize-buffered";
    };

function isRequestHookResponse(value: unknown): value is Response {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { status?: unknown }).status === "number" &&
    typeof (value as { headers?: { forEach?: unknown } }).headers?.forEach ===
      "function"
  );
}

function assertRequestHookRequest(value: unknown): asserts value is Request {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { url?: unknown }).url !== "string" ||
    typeof (value as { method?: unknown }).method !== "string" ||
    typeof (value as { headers?: { forEach?: unknown } }).headers?.forEach !==
      "function"
  ) {
    throw new TypeError(
      "onRequest must return Request, Response, or undefined",
    );
  }
}

async function normalizeRequestHookOutcome(
  result: unknown,
  fallbackRequest: Request,
  maxResponseBodyBytes: number,
): Promise<RequestHookOutcome> {
  const next = result ?? fallbackRequest;

  if (isRequestHookResponse(next)) {
    return {
      kind: "short-circuit",
      response: await webResponseToInternalHttpResponse(next, {
        maxBodyBytes: maxResponseBodyBytes,
      }),
    };
  }

  assertRequestHookRequest(next);
  return {
    kind: "forward",
    request: next,
  };
}

function deriveRequestBodyPlan(
  originalRequest: Request,
  hookRequest: Request,
): RequestBodyPlan {
  if (hookRequest.body === originalRequest.body) {
    if (originalRequest.bodyUsed) {
      throw new HttpRequestBlockedError(
        "onRequest consumed the request body; use request.clone() or return a new Request",
        400,
        "Bad Request",
      );
    }

    return { kind: "preserve-original" };
  }

  if (hookRequest.body === null) {
    return { kind: "none" };
  }

  if (hookRequest.bodyUsed) {
    throw new HttpRequestBlockedError(
      "onRequest returned a consumed request body",
      400,
      "Bad Request",
    );
  }

  return { kind: "materialize-buffered" };
}

async function cancelBodyStream(
  stream: WebReadableStream<Uint8Array> | null,
): Promise<void> {
  if (!stream) {
    return;
  }

  try {
    await stream.cancel();
  } catch {
    // ignore cancellation failures
  }
}

async function applyRequestHooks(
  backend: QemuNetworkBackend,
  request: InternalHttpRequest,
  options: {
    maxBodyBytes: number | null;
    bodyStream: WebReadableStream<Uint8Array> | null;
  },
): Promise<{
  request: InternalHttpRequest;
  bodyStream: WebReadableStream<Uint8Array> | null;
  shortCircuitResponse: InternalHttpResponse | null;
}> {
  const cloned: InternalHttpRequest = {
    method: request.method,
    url: request.url,
    headers: { ...request.headers },
    body: request.body,
  };

  if (!backend.options.httpHooks?.onRequest) {
    return {
      request: cloned,
      bodyStream: options.bodyStream,
      shortCircuitResponse: null,
    };
  }

  const hookRequest = internalRequestToWebRequestWithBody(cloned, {
    bodyStream: options.bodyStream,
  });

  const hookResult = await normalizeRequestHookOutcome(
    await backend.options.httpHooks.onRequest(hookRequest),
    hookRequest,
    backend.http.maxHttpResponseBodyBytes,
  );

  if (hookResult.kind === "short-circuit") {
    await cancelBodyStream(options.bodyStream);
    return {
      request: cloned,
      bodyStream: null,
      shortCircuitResponse: hookResult.response,
    };
  }

  const bodyPlan = deriveRequestBodyPlan(hookRequest, hookResult.request);

  if (bodyPlan.kind !== "preserve-original") {
    await cancelBodyStream(options.bodyStream);
  }

  if (bodyPlan.kind === "preserve-original") {
    const preservedBodyStream = options.bodyStream
      ? (hookResult.request.body as WebReadableStream<Uint8Array> | null)
      : null;

    return {
      request: webRequestHeadToInternalHttpRequest(
        hookResult.request,
        cloned.body,
      ),
      bodyStream: preservedBodyStream,
      shortCircuitResponse: null,
    };
  }

  if (bodyPlan.kind === "none") {
    return {
      request: webRequestHeadToInternalHttpRequest(hookResult.request, null),
      bodyStream: null,
      shortCircuitResponse: null,
    };
  }

  const materialized = await webRequestToInternalHttpRequest(
    hookResult.request,
    {
      allowBody: true,
      maxBodyBytes: options.maxBodyBytes,
    },
  );

  return {
    request: webRequestHeadToInternalHttpRequest(
      hookResult.request,
      materialized.body,
    ),
    bodyStream: null,
    shortCircuitResponse: null,
  };
}

async function applyResponseHooks(
  backend: QemuNetworkBackend,
  response: InternalHttpResponse,
  request: InternalHttpRequest,
): Promise<InternalHttpResponse> {
  if (!backend.options.httpHooks?.onResponse) {
    return response;
  }

  const updated = await backend.options.httpHooks.onResponse(
    internalHttpResponseToWebResponse(response),
    internalHttpRequestToWebRequest(request),
  );
  if (!updated) return response;

  return await webResponseToInternalHttpResponse(updated, {
    maxBodyBytes: backend.http.maxHttpResponseBodyBytes,
  });
}

function normalizeHookResponseForGuest(
  response: InternalHttpResponse,
  requestMethod: string,
): InternalHttpResponse {
  const status = response.status;
  const isHead = requestMethod.toUpperCase() === "HEAD";
  const suppressBody =
    isHead || status === 204 || status === 205 || status === 304;

  const headers: InternalHttpResponseHeaders = { ...response.headers };
  headers["connection"] = "close";
  delete headers["transfer-encoding"];

  const body = suppressBody ? Buffer.alloc(0) : response.body;

  if (status === 204 || status === 205 || status === 304) {
    delete headers["content-encoding"];
    headers["content-length"] = "0";
  } else if (isHead) {
    if (!headers["content-length"]) {
      headers["content-length"] = "0";
    }
  } else {
    headers["content-length"] = String(body.length);
  }

  return {
    status,
    statusText: response.statusText || "OK",
    headers,
    body,
  };
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

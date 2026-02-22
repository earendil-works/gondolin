import net from "net";
import tls from "tls";

import type { QemuNetworkBackend, TcpSession } from "./qemu-net";
import type { InternalHttpRequest } from "./internal-http-types";

import {
  MAX_HTTP_HEADER_BYTES,
  isWebSocketUpgradeRequestHeaders,
  sendHttpResponseHead,
} from "./http-utils";
import type { HttpRequestData } from "./http-utils";

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

export function handleWebSocketClientData(
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

export function isWebSocketUpgradeRequest(request: HttpRequestData): boolean {
  return isWebSocketUpgradeRequestHeaders(request.headers);
}

export async function bridgeWebSocketUpgrade(
  backend: QemuNetworkBackend,
  key: string,
  session: TcpSession,
  info: {
    protocol: "http" | "https";
    address: string;
    port: number;
    method: string;
    parsedUrl: URL;
    hookRequest: InternalHttpRequest;
  },
  options: {
    scheme: "http" | "https";
    write: (chunk: Buffer) => void;
    finish: () => void;
  },
  httpVersion: "HTTP/1.0" | "HTTP/1.1",
): Promise<boolean> {
  const ws = session.ws;
  if (!ws) {
    throw new Error("internal error: websocket state missing");
  }

  const upstream = await connectWebSocketUpstream(backend, {
    protocol: info.protocol,
    hostname: info.parsedUrl.hostname,
    address: info.address,
    port: info.port,
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

  const { hookRequest } = info;

  // Ensure Host header exists.
  const reqHeaders: Record<string, string> = { ...hookRequest.headers };
  if (!reqHeaders["host"]) {
    reqHeaders["host"] = info.parsedUrl.host;
  }

  // Remove body framing headers; websocket handshakes do not send a body.
  delete reqHeaders["content-length"];
  delete reqHeaders["transfer-encoding"];
  delete reqHeaders["expect"];

  const target = (info.parsedUrl.pathname || "/") + info.parsedUrl.search;

  const headerLines: string[] = [];
  headerLines.push(`${info.method} ${target} HTTP/1.1`);
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

  const upstreamResponse = {
    status: resp.statusCode,
    statusText: resp.statusMessage || "OK",
    headers: resp.headers,
  };

  sendHttpResponseHead(guestWrite, upstreamResponse, httpVersion);

  if (resp.rest.length > 0) {
    guestWrite(resp.rest);
  }

  const upgraded = resp.statusCode === 101;
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

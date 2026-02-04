import { EventEmitter } from "events";
import net from "net";
import fs from "fs";
import path from "path";
import dgram from "dgram";
import tls from "tls";
import crypto from "crypto";
import { Duplex } from "stream";
import { execFileSync } from "child_process";
import { lookup } from "dns/promises";

import {
  NetworkStack,
  TcpCloseMessage,
  TcpConnectMessage,
  TcpPauseMessage,
  TcpResumeMessage,
  TcpSendMessage,
  TcpFlowProtocol,
  UdpSendMessage,
} from "./network-stack";
import type { SandboxPolicy } from "./policy";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

type UdpSession = {
  socket: dgram.Socket;
  srcIP: string;
  srcPort: number;
  dstIP: string;
  dstPort: number;
};

type HttpRequestData = {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  body: Buffer;
};

type HttpSession = {
  buffer: Buffer;
  processing: boolean;
  closed: boolean;
};

class GuestTlsStream extends Duplex {
  constructor(private readonly onEncryptedWrite: (chunk: Buffer) => void) {
    super();
  }

  pushEncrypted(data: Buffer) {
    this.push(data);
  }

  _read() {
    // data is pushed via pushEncrypted
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.onEncryptedWrite(Buffer.from(chunk));
    callback();
  }
}

type TlsSession = {
  stream: GuestTlsStream;
  socket: tls.TLSSocket;
  servername: string | null;
};

type TcpSession = {
  socket: net.Socket | null;
  srcIP: string;
  srcPort: number;
  dstIP: string;
  dstPort: number;
  connectIP: string;
  flowControlPaused: boolean;
  protocol: TcpFlowProtocol | null;
  connected: boolean;
  pendingWrites: Buffer[];
  http?: HttpSession;
  tls?: TlsSession;
};

export type HttpFetch = typeof fetch;

export type HttpHookRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
};

export type HttpHookResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
};

export type HttpAllowInfo = {
  hostname: string;
  ip: string;
  family: 4 | 6;
  port: number;
  protocol: "http" | "https";
};

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

export type HttpHooks = {
  isAllowed?: (info: HttpAllowInfo) => Promise<boolean> | boolean;
  onRequest?: (request: HttpHookRequest) => Promise<HttpHookRequest | void> | HttpHookRequest | void;
  onResponse?: (
    response: HttpHookResponse,
    request: HttpHookRequest
  ) => Promise<HttpHookResponse | void> | HttpHookResponse | void;
};

export type QemuNetworkOptions = {
  socketPath: string;
  gatewayIP?: string;
  vmIP?: string;
  gatewayMac?: Buffer;
  vmMac?: Buffer;
  debug?: boolean;
  fetch?: HttpFetch;
  httpHooks?: HttpHooks;
  mitmCertDir?: string;
  policy?: SandboxPolicy;
};

export class QemuNetworkBackend extends EventEmitter {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private waitingDrain = false;
  private stack: NetworkStack | null = null;
  private readonly udpSessions = new Map<string, UdpSession>();
  private readonly tcpSessions = new Map<string, TcpSession>();
  private caCertPath: string | null = null;
  private caKeyPath: string | null = null;
  private tlsContexts = new Map<string, tls.SecureContext>();
  private policy: SandboxPolicy | null = null;

  constructor(private readonly options: QemuNetworkOptions) {
    super();
    this.policy = options.policy ?? null;
  }

  start() {
    if (this.server) return;

    if (!fs.existsSync(path.dirname(this.options.socketPath))) {
      fs.mkdirSync(path.dirname(this.options.socketPath), { recursive: true });
    }
    fs.rmSync(this.options.socketPath, { force: true });

    this.server = net.createServer((socket) => this.attachSocket(socket));
    this.server.on("error", (err) => this.emit("error", err));
    this.server.listen(this.options.socketPath);
  }

  stop() {
    this.detachSocket();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  setPolicy(policy: SandboxPolicy | null) {
    this.policy = policy;
    this.emit("policy", policy);
  }

  getPolicy() {
    return this.policy;
  }

  private attachSocket(socket: net.Socket) {
    if (this.socket) this.socket.destroy();
    this.socket = socket;
    this.waitingDrain = false;

    this.resetStack();

    socket.on("data", (chunk) => {
      this.stack?.writeToNetwork(chunk);
      this.flush();
    });

    socket.on("drain", () => {
      this.waitingDrain = false;
      this.flush();
    });

    socket.on("error", (err) => {
      this.emit("error", err);
      this.detachSocket();
    });

    socket.on("close", () => {
      this.detachSocket();
    });
  }

  private detachSocket() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.waitingDrain = false;
    this.cleanupSessions();
    this.stack?.reset();
  }

  private resetStack() {
    this.cleanupSessions();

    this.stack = new NetworkStack({
      gatewayIP: this.options.gatewayIP,
      vmIP: this.options.vmIP,
      gatewayMac: this.options.gatewayMac,
      vmMac: this.options.vmMac,
      callbacks: {
        onUdpSend: (message) => this.handleUdpSend(message),
        onTcpConnect: (message) => this.handleTcpConnect(message),
        onTcpSend: (message) => this.handleTcpSend(message),
        onTcpClose: (message) => this.handleTcpClose(message),
        onTcpPause: (message) => this.handleTcpPause(message),
        onTcpResume: (message) => this.handleTcpResume(message),
      },
      allowTcpFlow: (info) => {
        if (info.protocol !== "http" && info.protocol !== "tls") {
          if (this.options.debug) {
            this.emit(
              "log",
              `[net] tcp blocked ${info.srcIP}:${info.srcPort} -> ${info.dstIP}:${info.dstPort} (${info.protocol})`
            );
          }
          return false;
        }

        const session = this.tcpSessions.get(info.key);
        if (session) {
          session.protocol = info.protocol;
          if (info.protocol === "http" || info.protocol === "tls") {
            session.http = session.http ?? {
              buffer: Buffer.alloc(0),
              processing: false,
              closed: false,
            };
          }
        }
        // XXX: enforce SandboxPolicy allow/deny rules for HTTP/TLS flows here.
        return true;
      },
    });

    this.stack.on("network-activity", () => this.flush());
    this.stack.on("error", (err) => this.emit("error", err));
    if (this.options.debug) {
      this.stack.on("dhcp", (state, ip) => {
        this.emit("log", `[net] dhcp ${state} ${ip}`);
      });
    }
  }

  private flush() {
    if (!this.socket || this.waitingDrain || !this.stack) return;
    while (this.stack.hasPendingData()) {
      const chunk = this.stack.readFromNetwork(64 * 1024);
      if (!chunk || chunk.length === 0) break;
      if (this.options.debug) {
        this.emit("log", `[net] tx ${chunk.length} bytes to qemu`);
      }
      const ok = this.socket.write(chunk);
      if (!ok) {
        this.waitingDrain = true;
        return;
      }
    }
  }

  private cleanupSessions() {
    for (const session of this.udpSessions.values()) {
      try {
        session.socket.close();
      } catch {
        // ignore
      }
    }
    this.udpSessions.clear();

    for (const session of this.tcpSessions.values()) {
      try {
        session.socket?.destroy();
      } catch {
        // ignore
      }
    }
    this.tcpSessions.clear();
  }

  private handleUdpSend(message: UdpSendMessage) {
    // XXX: apply SandboxPolicy allow/deny rules for DNS/UDP destinations here.
    if (message.dstPort !== 53) {
      if (this.options.debug) {
        this.emit("log", `[net] udp blocked ${message.srcIP}:${message.srcPort} -> ${message.dstIP}:${message.dstPort}`);
      }
      return;
    }

    let session = this.udpSessions.get(message.key);
    if (!session) {
      const socket = dgram.createSocket("udp4");
      session = {
        socket,
        srcIP: message.srcIP,
        srcPort: message.srcPort,
        dstIP: message.dstIP,
        dstPort: message.dstPort,
      };
      this.udpSessions.set(message.key, session);

      socket.on("message", (data, rinfo) => {
        if (this.options.debug) {
          this.emit("log", `[net] udp recv ${rinfo.address}:${rinfo.port} -> ${session!.srcIP}:${session!.srcPort} (${data.length} bytes)`);
        }
        this.stack?.handleUdpResponse({
          data: Buffer.from(data),
          srcIP: session!.srcIP,
          srcPort: session!.srcPort,
          dstIP: session!.dstIP,
          dstPort: session!.dstPort,
        });
        this.flush();
      });

      socket.on("error", (err) => {
        this.emit("error", err);
      });
    }

    if (this.options.debug) {
      this.emit("log", `[net] udp send ${message.srcIP}:${message.srcPort} -> ${message.dstIP}:${message.dstPort} (${message.payload.length} bytes)`);
    }
    session.socket.send(message.payload, message.dstPort, message.dstIP);
  }

  private handleTcpConnect(message: TcpConnectMessage) {
    const connectIP =
      message.dstIP === (this.options.gatewayIP ?? "192.168.127.1") ? "127.0.0.1" : message.dstIP;

    const session: TcpSession = {
      socket: null,
      srcIP: message.srcIP,
      srcPort: message.srcPort,
      dstIP: message.dstIP,
      dstPort: message.dstPort,
      connectIP,
      flowControlPaused: false,
      protocol: null,
      connected: false,
      pendingWrites: [],
    };
    this.tcpSessions.set(message.key, session);

    this.stack?.handleTcpConnected({ key: message.key });
    this.flush();
  }

  private handleTcpSend(message: TcpSendMessage) {
    const session = this.tcpSessions.get(message.key);
    if (!session) return;

    if (session.protocol === "http") {
      this.handlePlainHttpData(message.key, session, message.data);
      return;
    }

    if (session.protocol === "tls") {
      this.handleTlsData(message.key, session, message.data);
      return;
    }

    this.ensureTcpSocket(message.key, session);
    if (session.socket && session.connected && session.socket.writable) {
      session.socket.write(message.data);
    } else {
      session.pendingWrites.push(message.data);
    }
  }

  private handleTcpClose(message: TcpCloseMessage) {
    const session = this.tcpSessions.get(message.key);
    if (session) {
      session.http = undefined;
      if (session.tls) {
        if (message.destroy) {
          session.tls.socket.destroy();
        } else {
          session.tls.socket.end();
        }
        session.tls = undefined;
      }
      if (session.socket) {
        if (message.destroy) {
          session.socket.destroy();
        } else {
          session.socket.end();
        }
      } else {
        this.tcpSessions.delete(message.key);
      }
    }
  }

  private handleTcpPause(message: TcpPauseMessage) {
    const session = this.tcpSessions.get(message.key);
    if (session && session.socket) {
      session.flowControlPaused = true;
      session.socket.pause();
    }
  }

  private handleTcpResume(message: TcpResumeMessage) {
    const session = this.tcpSessions.get(message.key);
    if (session && session.socket) {
      session.flowControlPaused = false;
      session.socket.resume();
    }
  }

  private ensureTcpSocket(key: string, session: TcpSession) {
    if (session.socket) return;

    const socket = new net.Socket();
    session.socket = socket;

    socket.connect(session.dstPort, session.connectIP, () => {
      session.connected = true;
      for (const pending of session.pendingWrites) {
        socket.write(pending);
      }
      session.pendingWrites = [];
    });

    socket.on("data", (data) => {
      this.stack?.handleTcpData({ key, data: Buffer.from(data) });
      this.flush();
    });

    socket.on("end", () => {
      this.stack?.handleTcpEnd({ key });
      this.flush();
    });

    socket.on("close", () => {
      this.stack?.handleTcpClosed({ key });
      this.tcpSessions.delete(key);
    });

    socket.on("error", () => {
      this.stack?.handleTcpError({ key });
      this.tcpSessions.delete(key);
    });
  }

  private ensureTlsSession(key: string, session: TcpSession) {
    if (session.tls) return session.tls;

    const stream = new GuestTlsStream((chunk) => {
      this.stack?.handleTcpData({ key, data: chunk });
      this.flush();
    });

    const tlsSocket = new tls.TLSSocket(stream, {
      isServer: true,
      secureContext: this.getTlsContext(session.dstIP),
      ALPNProtocols: ["http/1.1"],
      SNICallback: (servername, callback) => {
        const sni = servername || session.dstIP;
        try {
          const context = this.getTlsContext(sni);
          if (this.options.debug) {
            this.emit("log", `[net] tls sni ${sni}`);
          }
          callback(null, context);
        } catch (err) {
          callback(err as Error);
        }
      },
    });

    tlsSocket.on("data", (data) => {
      this.handleTlsHttpData(key, session, Buffer.from(data));
    });

    tlsSocket.on("error", (err) => {
      this.emit("error", err);
      this.stack?.handleTcpError({ key });
    });

    tlsSocket.on("close", () => {
      this.stack?.handleTcpClosed({ key });
      this.tcpSessions.delete(key);
    });

    session.tls = {
      stream,
      socket: tlsSocket,
      servername: null,
    };

    if (this.options.debug) {
      this.emit("log", `[net] tls mitm start ${session.dstIP}:${session.dstPort}`);
    }

    return session.tls;
  }

  private async handlePlainHttpData(key: string, session: TcpSession, data: Buffer) {
    await this.handleHttpDataWithWriter(key, session, data, {
      scheme: "http",
      write: (chunk) => {
        this.stack?.handleTcpData({ key, data: chunk });
      },
      finish: () => {
        this.stack?.handleTcpEnd({ key });
        this.flush();
      },
    });
  }

  private async handleTlsHttpData(key: string, session: TcpSession, data: Buffer) {
    const tlsSession = session.tls;
    if (!tlsSession) return;

    await this.handleHttpDataWithWriter(key, session, data, {
      scheme: "https",
      write: (chunk) => {
        tlsSession.socket.write(chunk);
      },
      finish: () => {
        tlsSession.socket.end(() => {
          this.stack?.handleTcpEnd({ key });
          this.flush();
        });
      },
    });
  }

  private async handleHttpDataWithWriter(
    key: string,
    session: TcpSession,
    data: Buffer,
    options: { scheme: "http" | "https"; write: (chunk: Buffer) => void; finish: () => void }
  ) {
    const httpSession = session.http ?? {
      buffer: Buffer.alloc(0),
      processing: false,
      closed: false,
    };
    session.http = httpSession;

    if (httpSession.closed) return;

    httpSession.buffer = Buffer.concat([httpSession.buffer, data]);
    if (httpSession.processing) return;

    const parsed = this.parseHttpRequest(httpSession.buffer);
    if (!parsed) return;

    httpSession.processing = true;
    httpSession.buffer = parsed.remaining;

    try {
      await this.fetchAndRespond(parsed.request, options.scheme, options.write);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error instanceof HttpRequestBlockedError) {
        if (this.options.debug) {
          this.emit("log", `[net] http blocked ${error.message}`);
        }
        this.respondWithError(options.write, error.status, error.statusText);
      } else {
        this.emit("error", error);
        this.respondWithError(options.write, 502, "Bad Gateway");
      }
    } finally {
      httpSession.closed = true;
      options.finish();
      this.flush();
    }
  }

  private handleTlsData(key: string, session: TcpSession, data: Buffer) {
    const tlsSession = this.ensureTlsSession(key, session);
    if (!tlsSession) return;
    tlsSession.stream.pushEncrypted(data);
  }

  private parseHttpRequest(buffer: Buffer): { request: HttpRequestData; remaining: Buffer } | null {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;

    const headerBlock = buffer.subarray(0, headerEnd).toString("utf8");
    const lines = headerBlock.split("\r\n");
    if (lines.length === 0) return null;

    const [method, target, version] = lines[0].split(" ");
    if (!method || !target || !version) return null;

    const headers: Record<string, string> = {};
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (!key) continue;
      if (headers[key]) {
        headers[key] = `${headers[key]}, ${value}`;
      } else {
        headers[key] = value;
      }
    }

    const bodyOffset = headerEnd + 4;
    const bodyBuffer = buffer.subarray(bodyOffset);

    // XXX: cap request body size to avoid unbounded buffering (Content-Length/chunked).
    const transferEncoding = headers["transfer-encoding"]?.toLowerCase();
    if (transferEncoding === "chunked") {
      const chunked = this.decodeChunkedBody(bodyBuffer);
      if (!chunked.complete) return null;
      return {
        request: {
          method,
          target,
          version,
          headers,
          body: chunked.body,
        },
        remaining: bodyBuffer.subarray(chunked.bytesConsumed),
      };
    }

    const contentLength = headers["content-length"] ? Number(headers["content-length"]) : 0;
    if (!Number.isFinite(contentLength) || contentLength < 0) return null;

    if (bodyBuffer.length < contentLength) return null;

    return {
      request: {
        method,
        target,
        version,
        headers,
        body: bodyBuffer.subarray(0, contentLength),
      },
      remaining: bodyBuffer.subarray(contentLength),
    };
  }

  private decodeChunkedBody(buffer: Buffer): { complete: boolean; body: Buffer; bytesConsumed: number } {
    let offset = 0;
    const chunks: Buffer[] = [];
    // XXX: enforce a max chunked body size while accumulating chunks.

    while (true) {
      const lineEnd = buffer.indexOf("\r\n", offset);
      if (lineEnd === -1) return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };

      const sizeLine = buffer.subarray(offset, lineEnd).toString("ascii").split(";")[0].trim();
      const size = parseInt(sizeLine, 16);
      if (!Number.isFinite(size)) return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };

      const chunkStart = lineEnd + 2;
      const chunkEnd = chunkStart + size;
      if (buffer.length < chunkEnd + 2) return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };

      if (size > 0) {
        chunks.push(buffer.subarray(chunkStart, chunkEnd));
      }

      if (buffer[chunkEnd] !== 0x0d || buffer[chunkEnd + 1] !== 0x0a) {
        return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
      }

      offset = chunkEnd + 2;
      if (size === 0) {
        return { complete: true, body: Buffer.concat(chunks), bytesConsumed: offset };
      }
    }
  }

  private async fetchAndRespond(
    request: HttpRequestData,
    defaultScheme: "http" | "https",
    write: (chunk: Buffer) => void
  ) {
    const url = this.buildFetchUrl(request, defaultScheme);
    if (!url) {
      this.respondWithError(write, 400, "Bad Request");
      return;
    }

    // XXX: validate URL + DNS/IP to block localhost/private ranges before fetch().
    if (this.options.debug) {
      this.emit("log", `[net] http bridge ${request.method} ${url}`);
    }

    let hookRequest: HttpHookRequest = {
      method: request.method,
      url,
      headers: this.stripHopByHopHeaders(request.headers),
      body: request.body.length > 0 ? request.body : null,
    };

    if (this.options.httpHooks?.onRequest) {
      const updated = await this.options.httpHooks.onRequest(hookRequest);
      if (updated) hookRequest = updated;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(hookRequest.url);
    } catch {
      this.respondWithError(write, 400, "Bad Request");
      return;
    }

    const protocol = parsedUrl.protocol === "https:" ? "https" : parsedUrl.protocol === "http:" ? "http" : null;
    if (!protocol) {
      this.respondWithError(write, 400, "Bad Request");
      return;
    }

    const port = parsedUrl.port
      ? Number(parsedUrl.port)
      : protocol === "https"
        ? 443
        : 80;
    if (!Number.isFinite(port) || port <= 0) {
      this.respondWithError(write, 400, "Bad Request");
      return;
    }

    if (this.options.httpHooks?.isAllowed) {
      const { address, family } = await this.resolveHostname(parsedUrl.hostname);
      const allowed = await this.options.httpHooks.isAllowed({
        hostname: parsedUrl.hostname,
        ip: address,
        family,
        port,
        protocol,
      });
      if (!allowed) {
        throw new HttpRequestBlockedError(`blocked by policy: ${parsedUrl.hostname}`);
      }
    }

    const fetcher = this.options.fetch ?? fetch;
    const response = await fetcher(hookRequest.url, {
      method: hookRequest.method,
      headers: hookRequest.headers,
      body: hookRequest.body ? new Uint8Array(hookRequest.body) : undefined,
    });

    if (this.options.debug) {
      this.emit("log", `[net] http bridge response ${response.status} ${response.statusText}`);
    }

    let responseHeaders = this.stripHopByHopHeaders(this.headersToRecord(response.headers));
    delete responseHeaders["content-encoding"];
    delete responseHeaders["content-length"];
    responseHeaders["connection"] = "close";

    const responseBodyStream = response.body;
    const canStream = Boolean(responseBodyStream) && !this.options.httpHooks?.onResponse;

    if (canStream && responseBodyStream) {
      responseHeaders["transfer-encoding"] = "chunked";
      this.sendHttpResponseHead(write, {
        status: response.status,
        statusText: response.statusText || "OK",
        headers: responseHeaders,
      });
      await this.sendChunkedBody(responseBodyStream, write);
      return;
    }

    const responseBody = Buffer.from(await response.arrayBuffer());
    responseHeaders["content-length"] = responseBody.length.toString();

    let hookResponse: HttpHookResponse = {
      status: response.status,
      statusText: response.statusText || "OK",
      headers: responseHeaders,
      body: responseBody,
    };

    if (this.options.httpHooks?.onResponse) {
      const updated = await this.options.httpHooks.onResponse(hookResponse, hookRequest);
      if (updated) hookResponse = updated;
    }

    this.sendHttpResponse(write, hookResponse);
  }

  private sendHttpResponseHead(
    write: (chunk: Buffer) => void,
    response: { status: number; statusText: string; headers: Record<string, string> }
  ) {
    const statusLine = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
    const headers = Object.entries(response.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\r\n");
    const headerBlock = `${statusLine}${headers}\r\n\r\n`;
    write(Buffer.from(headerBlock));
  }

  private sendHttpResponse(write: (chunk: Buffer) => void, response: HttpHookResponse) {
    this.sendHttpResponseHead(write, response);
    if (response.body.length > 0) {
      write(response.body);
    }
  }

  private async sendChunkedBody(body: ReadableStream<Uint8Array>, write: (chunk: Buffer) => void) {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        const sizeLine = Buffer.from(`${value.length.toString(16)}\r\n`);
        write(sizeLine);
        write(Buffer.from(value));
        write(Buffer.from("\r\n"));
      }
    } finally {
      reader.releaseLock();
    }

    write(Buffer.from("0\r\n\r\n"));
  }

  private respondWithError(write: (chunk: Buffer) => void, status: number, statusText: string) {
    const body = Buffer.from(`${status} ${statusText}\n`);
    this.sendHttpResponse(write, {
      status,
      statusText,
      headers: {
        "content-length": body.length.toString(),
        "content-type": "text/plain",
        connection: "close",
      },
      body,
    });
  }

  private buildFetchUrl(request: HttpRequestData, defaultScheme: "http" | "https") {
    if (request.target.startsWith("http://") || request.target.startsWith("https://")) {
      return request.target;
    }
    const host = request.headers["host"];
    if (!host) return null;
    return `${defaultScheme}://${host}${request.target}`;
  }

  private async resolveHostname(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
    const ipFamily = net.isIP(hostname);
    if (ipFamily === 4 || ipFamily === 6) {
      return { address: hostname, family: ipFamily };
    }
    const result = await lookup(hostname);
    return { address: result.address, family: result.family as 4 | 6 };
  }

  private getMitmDir() {
    return this.options.mitmCertDir ?? path.join(process.cwd(), "var", "mitm");
  }

  private ensureCa() {
    if (this.caCertPath && this.caKeyPath) return;

    const mitmDir = this.getMitmDir();
    fs.mkdirSync(mitmDir, { recursive: true });

    const caKeyPath = path.join(mitmDir, "ca.key");
    const caCertPath = path.join(mitmDir, "ca.crt");

    if (!fs.existsSync(caKeyPath) || !fs.existsSync(caCertPath)) {
      // XXX: openssl invocations here are synchronous and block the event loop.
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-sha256",
          "-days",
          "3650",
          "-nodes",
          "-subj",
          "/CN=gondolin-mitm-ca",
          "-keyout",
          caKeyPath,
          "-out",
          caCertPath,
        ],
        { stdio: "ignore" }
      );

      if (this.options.debug) {
        this.emit("log", `[net] generated mitm CA at ${caCertPath}`);
      }
    }

    this.caKeyPath = caKeyPath;
    this.caCertPath = caCertPath;
  }

  private getTlsContext(servername: string) {
    const normalized = servername.trim() || "unknown";
    const cached = this.tlsContexts.get(normalized);
    if (cached) return cached;

    this.ensureCa();
    if (!this.caCertPath || !this.caKeyPath) {
      throw new Error("MITM CA is not initialized");
    }

    const { keyPath, certPath } = this.ensureLeafCertificate(normalized);
    const leafCert = fs.readFileSync(certPath, "utf8");
    const caCert = fs.readFileSync(this.caCertPath, "utf8");

    const context = tls.createSecureContext({
      key: fs.readFileSync(keyPath),
      cert: `${leafCert}\n${caCert}`,
    });

    this.tlsContexts.set(normalized, context);
    return context;
  }

  private ensureLeafCertificate(servername: string) {
    if (!this.caCertPath || !this.caKeyPath) {
      throw new Error("MITM CA is not initialized");
    }

    const hostsDir = path.join(this.getMitmDir(), "hosts");
    fs.mkdirSync(hostsDir, { recursive: true });

    const hash = crypto.createHash("sha256").update(servername).digest("hex").slice(0, 12);
    const slug = servername.replace(/[^a-zA-Z0-9.-]/g, "_");
    const baseName = `${slug || "host"}-${hash}`;

    const keyPath = path.join(hostsDir, `${baseName}.key`);
    const certPath = path.join(hostsDir, `${baseName}.crt`);

    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return { keyPath, certPath };
    }

    const csrPath = path.join(hostsDir, `${baseName}.csr`);
    const configPath = path.join(hostsDir, `${baseName}.cnf`);

    const safeName = servername.replace(/[\r\n]/g, "");
    const san = net.isIP(servername) ? `IP:${servername}` : `DNS:${servername}`;
    const config = [
      "[req]",
      "distinguished_name=req_dist",
      "prompt=no",
      "req_extensions=v3_req",
      "[req_dist]",
      `CN=${safeName}`,
      "[v3_req]",
      `subjectAltName=${san}`,
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n");

    fs.writeFileSync(configPath, config);

    // XXX: openssl invocations here are synchronous and block the event loop.
    execFileSync("openssl", ["genrsa", "-out", keyPath, "2048"], { stdio: "ignore" });
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-key",
        keyPath,
        "-out",
        csrPath,
        "-config",
        configPath,
      ],
      { stdio: "ignore" }
    );
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        this.caCertPath,
        "-CAkey",
        this.caKeyPath,
        "-CAcreateserial",
        "-out",
        certPath,
        "-days",
        "825",
        "-sha256",
        "-extfile",
        configPath,
        "-extensions",
        "v3_req",
      ],
      { stdio: "ignore" }
    );

    fs.rmSync(csrPath, { force: true });
    fs.rmSync(configPath, { force: true });

    return { keyPath, certPath };
  }

  private stripHopByHopHeaders(headers: Record<string, string>) {
    const output: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
        output[name.toLowerCase()] = value;
      }
    }
    return output;
  }

  private headersToRecord(headers: Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key.toLowerCase()] = value;
    });
    return record;
  }
}

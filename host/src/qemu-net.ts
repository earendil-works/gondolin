import { EventEmitter } from "events";
import net from "net";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import dgram from "dgram";
import tls from "tls";
import crypto from "crypto";
import dns from "dns";
import { Duplex } from "stream";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { monitorEventLoopDelay, performance } from "perf_hooks";
import forge from "node-forge";

import { loadOrCreateMitmCa, resolveMitmCertDir } from "./mitm";
import { lookup } from "dns/promises";
import { Agent, fetch as undiciFetch } from "undici";

const MAX_HTTP_REDIRECTS = 10;
const MAX_HTTP_HEADER_BYTES = 64 * 1024;
export const DEFAULT_MAX_HTTP_BODY_BYTES = 64 * 1024 * 1024;
// Default cap for buffering upstream HTTP *responses* (not streaming).
// This primarily applies when httpHooks.onResponse is installed.
export const DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES = DEFAULT_MAX_HTTP_BODY_BYTES;

type FetchResponse = Awaited<ReturnType<typeof undiciFetch>>;

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
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

type IcmpTiming = {
  srcIP: string;
  dstIP: string;
  id: number;
  seq: number;
  recvTime: number;
  rxTime: number;
  replyTime: number;
  size: number;
};

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
  /** whether we already sent an interim 100-continue response */
  sentContinue?: boolean;
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

export type HttpFetch = typeof undiciFetch;

export type HttpHookRequest = {
  /** http method */
  method: string;
  /** request url */
  url: string;
  /** request headers */
  headers: Record<string, string>;
  /** request body (null for empty) */
  body: Buffer | null;
};

export type HttpHookResponse = {
  /** http status code */
  status: number;
  /** http status text */
  statusText: string;
  /** response headers */
  headers: Record<string, string>;
  /** response body */
  body: Buffer;
};

export type HttpAllowInfo = {
  /** request hostname */
  hostname: string;
  /** resolved ip address */
  ip: string;
  /** ip family */
  family: 4 | 6;
  /** destination port */
  port: number;
  /** url protocol */
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
  /** allow/deny callback */
  isAllowed?: (info: HttpAllowInfo) => Promise<boolean> | boolean;
  /** request rewrite hook */
  onRequest?: (request: HttpHookRequest) => Promise<HttpHookRequest | void> | HttpHookRequest | void;
  /** response rewrite hook */
  onResponse?: (
    response: HttpHookResponse,
    request: HttpHookRequest
  ) => Promise<HttpHookResponse | void> | HttpHookResponse | void;
};

export type QemuNetworkOptions = {
  /** unix socket path for the qemu net backend */
  socketPath: string;
  /** gateway ipv4 address */
  gatewayIP?: string;
  /** guest ipv4 address */
  vmIP?: string;
  /** gateway mac address */
  gatewayMac?: Buffer;
  /** guest mac address */
  vmMac?: Buffer;
  /** whether to enable debug logging */
  debug?: boolean;
  /** http fetch implementation */
  fetch?: HttpFetch;
  /** http interception hooks */
  httpHooks?: HttpHooks;
  /** mitm ca directory path */
  mitmCertDir?: string;
  /** max intercepted http request body size in `bytes` */
  maxHttpBodyBytes?: number;
  /** max buffered upstream http response body size in `bytes` */
  maxHttpResponseBodyBytes?: number;
};

type CaCert = {
  key: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
  certPem: string;
};

export class QemuNetworkBackend extends EventEmitter {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private waitingDrain = false;
  private stack: NetworkStack | null = null;
  private readonly udpSessions = new Map<string, UdpSession>();
  private readonly tcpSessions = new Map<string, TcpSession>();
  private readonly mitmDir: string;
  private caPromise: Promise<CaCert> | null = null;
  private tlsContexts = new Map<string, tls.SecureContext>();
  private tlsContextPromises = new Map<string, Promise<tls.SecureContext>>();
  private readonly icmpTimings = new Map<string, IcmpTiming>();
  private icmpDebugBuffer = Buffer.alloc(0);
  private icmpRxBuffer = Buffer.alloc(0);
  private eventLoopDelay: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private readonly maxHttpBodyBytes: number;
  private readonly maxHttpResponseBodyBytes: number;

  constructor(private readonly options: QemuNetworkOptions) {
    super();
    if (options.debug) {
      this.eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
      this.eventLoopDelay.enable();
    }
    this.mitmDir = resolveMitmCertDir(options.mitmCertDir);
    this.maxHttpBodyBytes = options.maxHttpBodyBytes ?? DEFAULT_MAX_HTTP_BODY_BYTES;
    this.maxHttpResponseBodyBytes =
      options.maxHttpResponseBodyBytes ?? DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES;
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

  close() {
    this.detachSocket();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private attachSocket(socket: net.Socket) {
    if (this.socket) this.socket.destroy();
    this.socket = socket;
    this.waitingDrain = false;

    this.resetStack();

    socket.on("data", (chunk) => {
      if (this.options.debug) {
        const now = performance.now();
        this.trackIcmpRequests(chunk, now);
      }
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
        return true;
      },
    });

    this.stack.on("network-activity", () => this.flush());
    this.stack.on("error", (err) => this.emit("error", err));
    if (this.options.debug) {
      this.icmpTimings.clear();
      this.icmpDebugBuffer = Buffer.alloc(0);
      this.icmpRxBuffer = Buffer.alloc(0);
      this.stack.on("dhcp", (state, ip) => {
        this.emit("log", `[net] dhcp ${state} ${ip}`);
      });
      this.stack.on("icmp", (info) => {
        this.recordIcmpTiming(info as IcmpTiming);
      });
    }
  }

  private flush() {
    if (!this.socket || this.waitingDrain || !this.stack) return;
    while (this.stack.hasPendingData()) {
      const chunk = this.stack.readFromNetwork(64 * 1024);
      if (!chunk || chunk.length === 0) break;
      if (this.options.debug) {
        const now = performance.now();
        this.trackIcmpReplies(chunk, now);
        this.emit("log", `[net] tx ${chunk.length} bytes to qemu`);
      }
      const ok = this.socket.write(chunk);
      if (!ok) {
        this.waitingDrain = true;
        return;
      }
    }
  }

  private recordIcmpTiming(info: IcmpTiming) {
    const key = this.icmpKey(info.srcIP, info.dstIP, info.id, info.seq);
    const existing = this.icmpTimings.get(key);
    if (existing) {
      if (Number.isFinite(info.recvTime) && info.recvTime > 0) {
        existing.recvTime = info.recvTime;
      }
      if (Number.isFinite(info.rxTime) && info.rxTime > 0) {
        existing.rxTime = info.rxTime;
      }
      if (Number.isFinite(info.replyTime) && info.replyTime > 0) {
        existing.replyTime = info.replyTime;
      }
      if (Number.isFinite(info.size) && info.size > 0) {
        existing.size = info.size;
      }
      existing.srcIP = info.srcIP;
      existing.dstIP = info.dstIP;
      return;
    }
    this.icmpTimings.set(key, info);
  }

  private icmpKey(srcIP: string, dstIP: string, id: number, seq: number) {
    return `${id}:${seq}:${srcIP}:${dstIP}`;
  }

  private trackIcmpRequests(chunk: Buffer, now: number) {
    this.icmpRxBuffer = Buffer.concat([this.icmpRxBuffer, chunk]);
    while (this.icmpRxBuffer.length >= 4) {
      const frameLen = this.icmpRxBuffer.readUInt32BE(0);
      if (this.icmpRxBuffer.length < 4 + frameLen) break;
      const frame = this.icmpRxBuffer.subarray(4, 4 + frameLen);
      this.icmpRxBuffer = this.icmpRxBuffer.subarray(4 + frameLen);
      this.logIcmpRequestFrame(frame, now);
    }
  }

  private trackIcmpReplies(chunk: Buffer, now: number) {
    this.icmpDebugBuffer = Buffer.concat([this.icmpDebugBuffer, chunk]);
    while (this.icmpDebugBuffer.length >= 4) {
      const frameLen = this.icmpDebugBuffer.readUInt32BE(0);
      if (this.icmpDebugBuffer.length < 4 + frameLen) break;
      const frame = this.icmpDebugBuffer.subarray(4, 4 + frameLen);
      this.icmpDebugBuffer = this.icmpDebugBuffer.subarray(4 + frameLen);
      this.logIcmpReplyFrame(frame, now);
    }
  }

  private logIcmpRequestFrame(frame: Buffer, now: number) {
    if (frame.length < 14) return;
    const etherType = frame.readUInt16BE(12);
    if (etherType !== 0x0800) return;

    const ip = frame.subarray(14);
    if (ip.length < 20) return;
    const version = ip[0] >> 4;
    if (version !== 4) return;
    const headerLen = (ip[0] & 0x0f) * 4;
    if (ip.length < headerLen) return;
    if (ip[9] !== 1) return;

    const totalLen = ip.readUInt16BE(2);
    const payloadEnd = Math.min(ip.length, totalLen);
    if (payloadEnd <= headerLen) return;

    const icmp = ip.subarray(headerLen, payloadEnd);
    if (icmp.length < 8) return;
    if (icmp[0] !== 8) return;

    const srcIP = `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}`;
    const dstIP = `${ip[16]}.${ip[17]}.${ip[18]}.${ip[19]}`;
    const id = icmp.readUInt16BE(4);
    const seq = icmp.readUInt16BE(6);

    this.recordIcmpTiming({
      srcIP,
      dstIP,
      id,
      seq,
      recvTime: now,
      rxTime: now,
      replyTime: now,
      size: icmp.length,
    });
  }

  private logIcmpReplyFrame(frame: Buffer, now: number) {
    if (frame.length < 14) return;
    const etherType = frame.readUInt16BE(12);
    if (etherType !== 0x0800) return;

    const ip = frame.subarray(14);
    if (ip.length < 20) return;
    const version = ip[0] >> 4;
    if (version !== 4) return;
    const headerLen = (ip[0] & 0x0f) * 4;
    if (ip.length < headerLen) return;
    if (ip[9] !== 1) return;

    const totalLen = ip.readUInt16BE(2);
    const payloadEnd = Math.min(ip.length, totalLen);
    if (payloadEnd <= headerLen) return;

    const icmp = ip.subarray(headerLen, payloadEnd);
    if (icmp.length < 8) return;
    if (icmp[0] !== 0) return;

    const srcIP = `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}`;
    const dstIP = `${ip[16]}.${ip[17]}.${ip[18]}.${ip[19]}`;
    const id = icmp.readUInt16BE(4);
    const seq = icmp.readUInt16BE(6);

    const key = this.icmpKey(dstIP, srcIP, id, seq);
    const timing = this.icmpTimings.get(key);
    if (!timing) return;

    this.icmpTimings.delete(key);

    const processingMs = timing.replyTime - timing.rxTime;
    const queuedMs = now - timing.replyTime;
    const totalMs = now - timing.rxTime;
    const guestToHostMs = Number.isFinite(timing.recvTime)
      ? timing.rxTime - timing.recvTime
      : Number.NaN;

    let eventLoopInfo = "";
    if (this.eventLoopDelay) {
      const meanMs = this.eventLoopDelay.mean / 1e6;
      const maxMs = this.eventLoopDelay.max / 1e6;
      eventLoopInfo = ` evloop_mean=${meanMs.toFixed(3)}ms evloop_max=${maxMs.toFixed(3)}ms`;
      this.eventLoopDelay.reset();
    }

    const guestToHostLabel = Number.isFinite(guestToHostMs)
      ? `guest_to_host=${guestToHostMs.toFixed(3)}ms `
      : "";

    this.emit(
      "log",
      `[net] icmp echo id=${timing.id} seq=${timing.seq} ${timing.srcIP} -> ${timing.dstIP} size=${timing.size} ` +
        `${guestToHostLabel}processing=${processingMs.toFixed(3)}ms ` +
        `queued=${queuedMs.toFixed(3)}ms total=${totalMs.toFixed(3)}ms${eventLoopInfo}`
    );
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
      ALPNProtocols: ["http/1.1"],
      SNICallback: (servername, callback) => {
        const sni = servername || session.dstIP;
        this.getTlsContextAsync(sni)
          .then((context) => {
            if (this.options.debug) {
              this.emit("log", `[net] tls sni ${sni}`);
            }
            callback(null, context);
          })
          .catch((err) => {
            callback(err as Error);
          });
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
      sentContinue: false,
    };
    session.http = httpSession;

    if (httpSession.closed) return;

    httpSession.buffer = Buffer.concat([httpSession.buffer, data]);
    if (httpSession.processing) return;

    let parsed: { request: HttpRequestData; remaining: Buffer } | null = null;
    try {
      this.maybeSend100Continue(httpSession, options.write);
      parsed = this.parseHttpRequest(httpSession.buffer);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error instanceof HttpRequestBlockedError) {
        if (this.options.debug) {
          this.emit("log", `[net] http blocked ${error.message}`);
        }
        this.respondWithError(options.write, error.status, error.statusText);
      } else {
        this.emit("error", error);
        this.respondWithError(options.write, 400, "Bad Request");
      }
      httpSession.closed = true;
      options.finish();
      this.flush();
      return;
    }

    if (!parsed) return;

    httpSession.processing = true;
    httpSession.buffer = parsed.remaining;

    try {
      await this.fetchAndRespond(parsed.request, options.scheme, options.write);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const httpVersion: "HTTP/1.0" | "HTTP/1.1" =
        parsed.request.version === "HTTP/1.0" ? "HTTP/1.0" : "HTTP/1.1";

      if (error instanceof HttpRequestBlockedError) {
        if (this.options.debug) {
          this.emit("log", `[net] http blocked ${error.message}`);
        }
        this.respondWithError(options.write, error.status, error.statusText, httpVersion);
      } else {
        this.emit("error", error);
        this.respondWithError(options.write, 502, "Bad Gateway", httpVersion);
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

  private parseHttpHead(buffer: Buffer): {
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
          "Request Header Fields Too Large"
        );
      }
      return null;
    }

    if (headerEnd > MAX_HTTP_HEADER_BYTES) {
      throw new HttpRequestBlockedError(
        `request headers exceed ${MAX_HTTP_HEADER_BYTES} bytes`,
        431,
        "Request Header Fields Too Large"
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

  private maybeSend100Continue(httpSession: HttpSession, write: (chunk: Buffer) => void) {
    if (httpSession.sentContinue) return;

    const head = this.parseHttpHead(httpSession.buffer);
    if (!head) return;

    if (head.version !== "HTTP/1.1") return;

    const expect = head.headers["expect"]?.toLowerCase();
    if (!expect) return;

    const expectations = expect
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (!expectations.includes("100-continue")) return;

    const bodyBuffer = httpSession.buffer.subarray(head.bodyOffset);
    const maxBodyBytes = this.maxHttpBodyBytes;

    const transferEncoding = head.headers["transfer-encoding"];
    if (transferEncoding) {
      const encodings = transferEncoding
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);

      // Only support TE: chunked (no other transfer-codings)
      if (
        encodings.length > 0 &&
        encodings[encodings.length - 1] === "chunked" &&
        encodings.every((encoding) => encoding === "chunked")
      ) {
        const chunked = this.decodeChunkedBody(bodyBuffer, maxBodyBytes);
        if (!chunked.complete) {
          write(Buffer.from("HTTP/1.1 100 Continue\r\n\r\n"));
          httpSession.sentContinue = true;
        }
        return;
      }
    }

    const contentLengthRaw = head.headers["content-length"];
    const contentLength = contentLengthRaw ? Number(contentLengthRaw) : 0;
    if (Number.isFinite(contentLength) && contentLength > bodyBuffer.length) {
      write(Buffer.from("HTTP/1.1 100 Continue\r\n\r\n"));
      httpSession.sentContinue = true;
    }
  }

  private parseHttpRequest(buffer: Buffer): { request: HttpRequestData; remaining: Buffer } | null {
    const head = this.parseHttpHead(buffer);
    if (!head) return null;

    const { method, target, version, headers, bodyOffset } = head;

    // RFC 9110: unknown expectations MUST be rejected with 417.
    if (version === "HTTP/1.1") {
      const expect = headers["expect"]?.toLowerCase();
      if (expect) {
        const tokens = expect
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);

        const unsupported = tokens.filter((t) => t !== "100-continue");
        if (unsupported.length > 0) {
          throw new HttpRequestBlockedError(
            `unsupported expect token(s): ${unsupported.join(", ")}`,
            417,
            "Expectation Failed"
          );
        }
      }
    }

    const bodyBuffer = buffer.subarray(bodyOffset);
    const maxBodyBytes = this.maxHttpBodyBytes;

    // XXX: cap request body size to avoid unbounded buffering (Content-Length/chunked).
    const transferEncodingHeader = headers["transfer-encoding"];
    if (transferEncodingHeader) {
      const encodings = transferEncodingHeader
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);

      // Only support TE: chunked (no other transfer-codings).
      if (
        encodings.length === 0 ||
        encodings[encodings.length - 1] !== "chunked" ||
        !encodings.every((encoding) => encoding === "chunked")
      ) {
        throw new HttpRequestBlockedError(
          `unsupported transfer-encoding: ${transferEncodingHeader}`,
          501,
          "Not Implemented"
        );
      }

      const chunked = this.decodeChunkedBody(bodyBuffer, maxBodyBytes);
      if (!chunked.complete) return null;

      // We decoded the body, so sanitize framing-related request headers.
      // (Hop-by-hop headers are stripped later, but Content-Length must also be correct.)
      const sanitizedHeaders = { ...headers };
      delete sanitizedHeaders["transfer-encoding"];
      delete sanitizedHeaders["content-length"];
      sanitizedHeaders["content-length"] = chunked.body.length.toString();

      return {
        request: {
          method,
          target,
          version,
          headers: sanitizedHeaders,
          body: chunked.body,
        },
        remaining: bodyBuffer.subarray(chunked.bytesConsumed),
      };
    }

    const contentLengthRaw = headers["content-length"];
    let contentLength = 0;

    if (contentLengthRaw) {
      if (contentLengthRaw.includes(",")) {
        throw new Error("multiple content-length headers");
      }
      contentLength = Number(contentLengthRaw);
      if (!Number.isFinite(contentLength) || !Number.isInteger(contentLength) || contentLength < 0) {
        throw new Error("invalid content-length");
      }
    }

    if (Number.isFinite(maxBodyBytes) && contentLength > maxBodyBytes) {
      throw new HttpRequestBlockedError(
        `request body exceeds ${maxBodyBytes} bytes`,
        413,
        "Payload Too Large"
      );
    }

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

  private decodeChunkedBody(
    buffer: Buffer,
    maxBodyBytes: number
  ): { complete: boolean; body: Buffer; bytesConsumed: number } {
    let offset = 0;
    let totalBytes = 0;
    const chunks: Buffer[] = [];
    const enforceLimit = Number.isFinite(maxBodyBytes) && maxBodyBytes >= 0;

    while (true) {
      const lineEnd = buffer.indexOf("\r\n", offset);
      if (lineEnd === -1) return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };

      const sizeLine = buffer.subarray(offset, lineEnd).toString("ascii").split(";")[0].trim();
      const size = parseInt(sizeLine, 16);
      if (!Number.isFinite(size) || size < 0) {
        throw new Error("invalid chunk size");
      }

      const chunkStart = lineEnd + 2;

      // last-chunk + trailer-section
      if (size === 0) {
        // Empty trailer-section is a single CRLF.
        if (buffer.length < chunkStart + 2) {
          return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
        }

        if (buffer[chunkStart] === 0x0d && buffer[chunkStart + 1] === 0x0a) {
          return { complete: true, body: Buffer.concat(chunks), bytesConsumed: chunkStart + 2 };
        }

        const trailerEnd = buffer.indexOf("\r\n\r\n", chunkStart);
        if (trailerEnd === -1) {
          return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
        }

        return { complete: true, body: Buffer.concat(chunks), bytesConsumed: trailerEnd + 4 };
      }

      const chunkEnd = chunkStart + size;
      if (buffer.length < chunkEnd + 2) {
        return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
      }

      if (enforceLimit && totalBytes + size > maxBodyBytes) {
        throw new HttpRequestBlockedError(
          `request body exceeds ${maxBodyBytes} bytes`,
          413,
          "Payload Too Large"
        );
      }

      totalBytes += size;
      chunks.push(buffer.subarray(chunkStart, chunkEnd));

      if (buffer[chunkEnd] !== 0x0d || buffer[chunkEnd + 1] !== 0x0a) {
        throw new Error("invalid chunk terminator");
      }

      offset = chunkEnd + 2;
    }
  }

  private async fetchAndRespond(
    request: HttpRequestData,
    defaultScheme: "http" | "https",
    write: (chunk: Buffer) => void
  ) {
    const httpVersion: "HTTP/1.0" | "HTTP/1.1" =
      request.version === "HTTP/1.0" ? "HTTP/1.0" : "HTTP/1.1";

    // Asterisk-form (OPTIONS *) is valid HTTP but does not map to a URL fetch.
    if (request.method === "OPTIONS" && request.target === "*") {
      this.respondWithError(write, 501, "Not Implemented", httpVersion);
      return;
    }

    // Explicitly reject Upgrade/WebSocket requests: the HTTP fetch bridge cannot
    // tunnel upgraded connections.
    const connection = request.headers["connection"]?.toLowerCase() ?? "";
    const hasUpgrade =
      Boolean(request.headers["upgrade"]) ||
      connection
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .includes("upgrade") ||
      Boolean(request.headers["sec-websocket-key"]) ||
      Boolean(request.headers["sec-websocket-version"]);

    if (hasUpgrade) {
      this.respondWithError(write, 501, "Not Implemented", httpVersion);
      return;
    }

    const url = this.buildFetchUrl(request, defaultScheme);
    if (!url) {
      this.respondWithError(write, 400, "Bad Request", httpVersion);
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

    const fetcher = this.options.fetch ?? undiciFetch;
    let pendingRequest = hookRequest;

    for (let redirectCount = 0; redirectCount <= MAX_HTTP_REDIRECTS; redirectCount += 1) {
      const currentRequest = await this.applyRequestHooks(pendingRequest);

      let currentUrl: URL;
      try {
        currentUrl = new URL(currentRequest.url);
      } catch {
        this.respondWithError(write, 400, "Bad Request", httpVersion);
        return;
      }

      const protocol = getUrlProtocol(currentUrl);
      if (!protocol) {
        this.respondWithError(write, 400, "Bad Request", httpVersion);
        return;
      }

      const port = getUrlPort(currentUrl, protocol);
      if (!Number.isFinite(port) || port <= 0) {
        this.respondWithError(write, 400, "Bad Request", httpVersion);
        return;
      }

      await this.ensureRequestAllowed(currentUrl, protocol, port);

      const useDefaultFetch = this.options.fetch === undefined;
      // The custom dispatcher re-checks isAllowed against the resolved IP to
      // prevent DNS rebinding from bypassing internal range policies.
      const dispatcher = useDefaultFetch
        ? this.createCheckedDispatcher({
            hostname: currentUrl.hostname,
            port,
            protocol,
          })
        : null;

      try {
        const response = await fetcher(currentUrl.toString(), {
          method: currentRequest.method,
          headers: currentRequest.headers,
          body: currentRequest.body ? new Uint8Array(currentRequest.body) : undefined,
          redirect: "manual",
          ...(dispatcher ? { dispatcher } : {}),
        });

        const redirectUrl = getRedirectUrl(response, currentUrl);
        if (redirectUrl) {
          if (response.body) {
            await response.body.cancel();
          }

          if (redirectCount >= MAX_HTTP_REDIRECTS) {
            throw new HttpRequestBlockedError("too many redirects", 508, "Loop Detected");
          }

          pendingRequest = applyRedirectRequest(pendingRequest, response.status, redirectUrl);
          continue;
        }

        if (this.options.debug) {
          this.emit("log", `[net] http bridge response ${response.status} ${response.statusText}`);
        }

        let responseHeaders = this.stripHopByHopHeaders(this.headersToRecord(response.headers));
        const contentEncoding = responseHeaders["content-encoding"];
        const contentLength = responseHeaders["content-length"];
        const parsedLength = contentLength ? Number(contentLength) : null;
        const hasValidLength =
          parsedLength !== null && Number.isFinite(parsedLength) && parsedLength >= 0;

        if (contentEncoding) {
          delete responseHeaders["content-encoding"];
          delete responseHeaders["content-length"];
        }
        responseHeaders["connection"] = "close";

        const responseBodyStream = response.body as WebReadableStream<Uint8Array> | null;

        const suppressBody =
          currentRequest.method === "HEAD" || response.status === 204 || response.status === 304;

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
            if (!responseHeaders["content-length"]) responseHeaders["content-length"] = "0";
          }

          let hookResponse: HttpHookResponse = {
            status: response.status,
            statusText: response.statusText || "OK",
            headers: responseHeaders,
            body: Buffer.alloc(0),
          };

          if (this.options.httpHooks?.onResponse) {
            const updated = await this.options.httpHooks.onResponse(hookResponse, currentRequest);
            if (updated) hookResponse = updated;
          }

          this.sendHttpResponse(write, hookResponse, httpVersion);
          return;
        }

        const canStream = Boolean(responseBodyStream) && !this.options.httpHooks?.onResponse;

        if (canStream && responseBodyStream) {
          const allowChunked = httpVersion === "HTTP/1.1";

          if (contentEncoding || !hasValidLength) {
            // When the upstream response was encoded (undici may have decoded it for us)
            // or the length is unknown, we cannot safely forward Content-Length.
            delete responseHeaders["content-length"];

            if (allowChunked) {
              responseHeaders["transfer-encoding"] = "chunked";
              this.sendHttpResponseHead(
                write,
                {
                  status: response.status,
                  statusText: response.statusText || "OK",
                  headers: responseHeaders,
                },
                httpVersion
              );
              await this.sendChunkedBody(responseBodyStream, write);
            } else {
              // HTTP/1.0 does not support Transfer-Encoding: chunked.
              delete responseHeaders["transfer-encoding"];
              this.sendHttpResponseHead(
                write,
                {
                  status: response.status,
                  statusText: response.statusText || "OK",
                  headers: responseHeaders,
                },
                httpVersion
              );
              await this.sendStreamBody(responseBodyStream, write);
            }
          } else {
            responseHeaders["content-length"] = parsedLength!.toString();
            delete responseHeaders["transfer-encoding"];
            this.sendHttpResponseHead(
              write,
              {
                status: response.status,
                statusText: response.statusText || "OK",
                headers: responseHeaders,
              },
              httpVersion
            );
            await this.sendStreamBody(responseBodyStream, write);
          }

          return;
        }

        const maxResponseBytes = this.maxHttpResponseBodyBytes;

        // Fast-path rejection when the upstream response declares a length that
        // is already beyond what we're willing to buffer.
        if (hasValidLength && !contentEncoding && parsedLength! > maxResponseBytes) {
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
            "Bad Gateway"
          );
        }

        const responseBody = responseBodyStream
          ? await this.bufferResponseBodyWithLimit(responseBodyStream, maxResponseBytes)
          : Buffer.from(await response.arrayBuffer());

        if (responseBody.length > maxResponseBytes) {
          throw new HttpRequestBlockedError(
            `response body exceeds ${maxResponseBytes} bytes`,
            502,
            "Bad Gateway"
          );
        }

        responseHeaders["content-length"] = responseBody.length.toString();

        let hookResponse: HttpHookResponse = {
          status: response.status,
          statusText: response.statusText || "OK",
          headers: responseHeaders,
          body: responseBody,
        };

        if (this.options.httpHooks?.onResponse) {
          const updated = await this.options.httpHooks.onResponse(hookResponse, currentRequest);
          if (updated) hookResponse = updated;
        }

        this.sendHttpResponse(write, hookResponse, httpVersion);
        return;
      } finally {
        if (dispatcher) {
          dispatcher.close();
        }
      }
    }

  }

  private sendHttpResponseHead(
    write: (chunk: Buffer) => void,
    response: { status: number; statusText: string; headers: Record<string, string> },
    httpVersion: "HTTP/1.0" | "HTTP/1.1" = "HTTP/1.1"
  ) {
    const statusLine = `${httpVersion} ${response.status} ${response.statusText}\r\n`;
    const headers = Object.entries(response.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\r\n");
    const headerBlock = `${statusLine}${headers}\r\n\r\n`;
    write(Buffer.from(headerBlock));
  }

  private sendHttpResponse(
    write: (chunk: Buffer) => void,
    response: HttpHookResponse,
    httpVersion: "HTTP/1.0" | "HTTP/1.1" = "HTTP/1.1"
  ) {
    this.sendHttpResponseHead(write, response, httpVersion);
    if (response.body.length > 0) {
      write(response.body);
    }
  }

  private async sendChunkedBody(body: WebReadableStream<Uint8Array>, write: (chunk: Buffer) => void) {
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

  private async sendStreamBody(body: WebReadableStream<Uint8Array>, write: (chunk: Buffer) => void) {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        write(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async bufferResponseBodyWithLimit(
    body: WebReadableStream<Uint8Array>,
    maxBytes: number
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
            "Bad Gateway"
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

  private respondWithError(
    write: (chunk: Buffer) => void,
    status: number,
    statusText: string,
    httpVersion: "HTTP/1.0" | "HTTP/1.1" = "HTTP/1.1"
  ) {
    const body = Buffer.from(`${status} ${statusText}\n`);
    this.sendHttpResponse(
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
      httpVersion
    );
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

  private async ensureRequestAllowed(
    parsedUrl: URL,
    protocol: "http" | "https",
    port: number
  ) {
    if (!this.options.httpHooks?.isAllowed) return;
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

  private async applyRequestHooks(request: HttpHookRequest): Promise<HttpHookRequest> {
    if (!this.options.httpHooks?.onRequest) {
      return request;
    }
    const cloned: HttpHookRequest = {
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body: request.body,
    };
    const updated = await this.options.httpHooks.onRequest(cloned);
    return updated ?? cloned;
  }

  private createCheckedDispatcher(info: {
    hostname: string;
    port: number;
    protocol: "http" | "https";
  }): Agent | null {
    const isAllowed = this.options.httpHooks?.isAllowed;
    if (!isAllowed) return null;

    const lookupFn = createLookupGuard(info, isAllowed);
    return new Agent({ connect: { lookup: lookupFn } });
  }

  private getMitmDir() {
    return this.mitmDir;
  }

  private async ensureCaAsync(): Promise<CaCert> {
    if (this.caPromise) return this.caPromise;

    this.caPromise = this.loadOrCreateCa();
    return this.caPromise;
  }

  private async loadOrCreateCa(): Promise<CaCert> {
    const mitmDir = this.getMitmDir();
    const ca = await loadOrCreateMitmCa(mitmDir);
    return {
      key: ca.key,
      cert: ca.cert,
      certPem: ca.certPem,
    };
  }

  private async getTlsContextAsync(servername: string): Promise<tls.SecureContext> {
    const normalized = servername.trim() || "unknown";

    // Return cached context if available
    const cached = this.tlsContexts.get(normalized);
    if (cached) return cached;

    // Return pending promise if already loading
    const pending = this.tlsContextPromises.get(normalized);
    if (pending) return pending;

    // Start loading and cache the promise
    const promise = this.createTlsContext(normalized);
    this.tlsContextPromises.set(normalized, promise);

    try {
      const context = await promise;
      this.tlsContexts.set(normalized, context);
      return context;
    } finally {
      this.tlsContextPromises.delete(normalized);
    }
  }

  private async createTlsContext(servername: string): Promise<tls.SecureContext> {
    const ca = await this.ensureCaAsync();
    const { keyPem, certPem } = await this.ensureLeafCertificateAsync(servername, ca);

    return tls.createSecureContext({
      key: keyPem,
      cert: `${certPem}\n${ca.certPem}`,
    });
  }

  private async ensureLeafCertificateAsync(
    servername: string,
    ca: CaCert
  ): Promise<{ keyPem: string; certPem: string }> {
    const hostsDir = path.join(this.getMitmDir(), "hosts");
    await fsp.mkdir(hostsDir, { recursive: true });

    const hash = crypto.createHash("sha256").update(servername).digest("hex").slice(0, 12);
    const slug = servername.replace(/[^a-zA-Z0-9.-]/g, "_");
    const baseName = `${slug || "host"}-${hash}`;

    const keyPath = path.join(hostsDir, `${baseName}.key`);
    const certPath = path.join(hostsDir, `${baseName}.crt`);

    try {
      // Try to load existing cert
      const [keyPem, certPem] = await Promise.all([
        fsp.readFile(keyPath, "utf8"),
        fsp.readFile(certPath, "utf8"),
      ]);
      return { keyPem, certPem };
    } catch {
      // Generate new leaf certificate
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();

      cert.publicKey = keys.publicKey;
      cert.serialNumber = generateSerialNumber();
      const now = new Date(Date.now() - 5 * 60 * 1000);
      cert.validity.notBefore = now;
      cert.validity.notAfter = new Date(now);
      cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + 825);

      const safeName = servername.replace(/[\r\n]/g, "");
      const attrs = [{ name: "commonName", value: safeName }];
      cert.setSubject(attrs);
      cert.setIssuer(ca.cert.subject.attributes);

      const altNames = net.isIP(servername)
        ? [{ type: 7, ip: servername }]
        : [{ type: 2, value: servername }];

      cert.setExtensions([
        { name: "basicConstraints", cA: false },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
        },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames },
      ]);

      cert.sign(ca.key, forge.md.sha256.create());

      const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
      const certPem = forge.pki.certificateToPem(cert);

      await Promise.all([
        fsp.writeFile(keyPath, keyPem),
        fsp.writeFile(certPath, certPem),
      ]);

      return { keyPem, certPem };
    }
  }

  private stripHopByHopHeaders(headers: Record<string, string>) {
    const connection = headers["connection"];
    const connectionTokens = new Set<string>();
    if (connection) {
      for (const token of connection.split(",")) {
        const normalized = token.trim().toLowerCase();
        if (normalized) connectionTokens.add(normalized);
      }
    }

    const output: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const normalizedName = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(normalizedName)) continue;
      if (connectionTokens.has(normalizedName)) continue;
      output[normalizedName] = value;
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

function createLookupGuard(
  info: { hostname: string; port: number; protocol: "http" | "https" },
  isAllowed: NonNullable<HttpHooks["isAllowed"]>,
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
          const allowed = await isAllowed({
            hostname: info.hostname,
            ip: entry.address,
            family: entry.family,
            port: info.port,
            protocol: info.protocol,
          });
          if (allowed) {
            if (!normalizedOptions.all) {
              callback(null, entry.address, entry.family);
              return;
            }
            allowedEntries.push(entry);
          }
        }

        if (normalizedOptions.all && allowedEntries.length > 0) {
          callback(null, allowedEntries.map((entry) => ({
            address: entry.address,
            family: entry.family,
          })));
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

function normalizeLookupEntries(address: LookupResult | undefined, family?: number): LookupEntry[] {
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

function normalizeLookupOptions(
  options: dns.LookupOneOptions | dns.LookupAllOptions | number
): dns.LookupOneOptions | dns.LookupAllOptions {
  if (typeof options === "number") {
    return { family: options };
  }
  return options;
}

function normalizeLookupFailure(options: dns.LookupOneOptions | dns.LookupAllOptions): LookupResult {
  return options.all ? [] : "";
}

function generateSerialNumber(): string {
  return crypto.randomBytes(16).toString("hex");
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

function getRedirectUrl(response: FetchResponse, currentUrl: URL): URL | null {
  if (![301, 302, 303, 307, 308].includes(response.status)) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    return new URL(location, currentUrl);
  } catch {
    return null;
  }
}

function applyRedirectRequest(
  request: HttpHookRequest,
  status: number,
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

/** @internal */
// Expose internal helpers for unit tests. Not part of the public API.
export const __test = {
  createLookupGuard,
  normalizeLookupEntries,
  normalizeLookupOptions,
  normalizeLookupFailure,
  getRedirectUrl,
  applyRedirectRequest,
};

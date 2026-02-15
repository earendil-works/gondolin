import { EventEmitter } from "events";
import { stripTrailingNewline } from "./debug";
import net from "net";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import dgram from "dgram";
import tls from "tls";
import crypto from "crypto";
import dns from "dns";
import { Duplex } from "stream";
import { monitorEventLoopDelay, performance } from "perf_hooks";
import forge from "node-forge";

import {
  generatePositiveSerialNumber,
  isNonNegativeSerialNumberHex,
  loadOrCreateMitmCa,
  resolveMitmCertDir,
} from "./mitm";
import {
  buildSyntheticDnsResponse,
  isLocalhostDnsName,
  isProbablyDnsPacket,
  parseDnsQuery,
} from "./dns";
import { Agent, fetch as undiciFetch } from "undici";

import { AsyncSemaphore } from "./async-utils";
import { SyntheticDnsHostMap, normalizeIpv4Servers } from "./dns-utils";
import {
  assertSshDnsConfig,
  cleanupSshTcpSession,
  createQemuSshInternals,
  handleSshProxyData as handleSshProxyDataImpl,
  isSshFlowAllowed,
  type QemuSshInternals,
  type SshOptions,
  type SshTcpSessionState,
} from "./qemu-ssh";
import {
  caCertVerifiesLeaf,
  closeSharedDispatchers,
  privateKeyMatchesLeafCert,
  HttpReceiveBuffer,
} from "./http-utils";

import {
  handlePlainHttpData,
  handleTlsHttpData,
  updateQemuRxPauseState,
  type HttpSession,
} from "./qemu-http";
import type { WebSocketState } from "./qemu-ws";

export const DEFAULT_MAX_HTTP_BODY_BYTES = 64 * 1024 * 1024;
// Default cap for buffering upstream HTTP *responses* (not streaming).
// This primarily applies when httpHooks.onResponse is installed.
export const DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES = DEFAULT_MAX_HTTP_BODY_BYTES;

const DEFAULT_MAX_TCP_PENDING_WRITE_BYTES = 4 * 1024 * 1024;

const DEFAULT_WEBSOCKET_UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_WEBSOCKET_UPSTREAM_HEADER_TIMEOUT_MS = 10_000;

const DEFAULT_TLS_CONTEXT_CACHE_MAX_ENTRIES = 256;
const DEFAULT_TLS_CONTEXT_CACHE_TTL_MS = 10 * 60 * 1000;

const DEFAULT_DNS_MODE: DnsMode = "synthetic";
const DEFAULT_SYNTHETIC_DNS_IPV4 = "192.0.2.1";
const DEFAULT_SYNTHETIC_DNS_IPV6 = "2001:db8::1";
const DEFAULT_SYNTHETIC_DNS_TTL_SECONDS = 60;
const DEFAULT_SYNTHETIC_DNS_HOST_MAPPING: SyntheticDnsHostMappingMode =
  "single";

const DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS = 128;


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

  /** destination ip as seen by the guest */
  dstIP: string;
  /** destination port as seen by the guest */
  dstPort: number;

  /** upstream destination ip used by the host (dns mode dependent) */
  upstreamIP: string;
  /** upstream destination port used by the host */
  upstreamPort: number;
};

class GuestTlsStream extends Duplex {
  constructor(
    private readonly onEncryptedWrite: (chunk: Buffer) => void | Promise<void>,
  ) {
    super();
  }

  pushEncrypted(data: Buffer) {
    this.push(data);
  }

  _read() {
    // data is pushed via pushEncrypted
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    Promise.resolve(this.onEncryptedWrite(Buffer.from(chunk))).then(
      () => callback(),
      (err) => callback(err as Error),
    );
  }
}

type TlsSession = {
  stream: GuestTlsStream;
  socket: tls.TLSSocket;
  servername: string | null;
};

export type TcpSession = {
  socket: net.Socket | null;
  srcIP: string;
  srcPort: number;
  dstIP: string;
  dstPort: number;
  /** upstream host/ip used by the host socket connect */
  connectIP: string;
  /** synthetic hostname derived from destination synthetic dns ip */
  syntheticHostname: string | null;

  /** @internal */
  ssh?: SshTcpSessionState;
  flowControlPaused: boolean;
  protocol: TcpFlowProtocol | null;
  connected: boolean;
  pendingWrites: Buffer[];
  /** bytes currently queued in `pendingWrites` in `bytes` (does not include Node's socket buffer) */
  pendingWriteBytes: number;
  http?: HttpSession;
  tls?: TlsSession;

  /** active WebSocket upgrade/tunnel state */
  ws?: WebSocketState;
};

/** @internal */
export type QemuHttpInternals = {
  /** max intercepted http request body size in `bytes` */
  maxHttpBodyBytes: number;
  /** max buffered upstream http response body size in `bytes` */
  maxHttpResponseBodyBytes: number;
  /** whether to allow WebSocket upgrades */
  allowWebSockets: boolean;
  /** websocket upstream connect + tls handshake timeout in `ms` */
  webSocketUpstreamConnectTimeoutMs: number;
  /** websocket upstream response header timeout in `ms` */
  webSocketUpstreamHeaderTimeoutMs: number;
  /** semaphore limiting concurrent upstream fetches */
  httpConcurrency: AsyncSemaphore;
  /** shared undici dispatchers keyed by origin */
  sharedDispatchers: Map<string, { dispatcher: Agent; lastUsedAt: number }>;
  /** whether qemu rx is paused due to streaming request backpressure */
  qemuRxPausedForHttpStreaming: boolean;
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

export type HeaderValue = string | string[];
export type HttpResponseHeaders = Record<string, HeaderValue>;

export type HttpHookResponse = {
  /** http status code */
  status: number;
  /** http status text */
  statusText: string;
  /** response headers */
  headers: HttpResponseHeaders;
  /** response body */
  body: Buffer;
};

export type HttpIpAllowInfo = {
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

export type DnsMode = "open" | "trusted" | "synthetic";

export type SyntheticDnsHostMappingMode = "single" | "per-host";

export type DnsOptions = {
  /** dns mode */
  mode?: DnsMode;

  /** trusted resolver ipv4 addresses (mode="trusted") */
  trustedServers?: string[];

  /** synthetic A response ipv4 address (mode="synthetic") */
  syntheticIPv4?: string;

  /** synthetic AAAA response ipv6 address (mode="synthetic") */
  syntheticIPv6?: string;

  /** synthetic response ttl in `seconds` (mode="synthetic") */
  syntheticTtlSeconds?: number;

  /** synthetic hostname mapping strategy (mode="synthetic") */
  syntheticHostMapping?: SyntheticDnsHostMappingMode;
};

export type HttpHookRequestHeadResult = HttpHookRequest & {
  /** whether the request body must be buffered before calling `httpHooks.onRequest` */
  bufferRequestBody?: boolean;
  /** max request body size in `bytes` (applies to both buffered bodies and streaming via Content-Length) */
  maxBufferedRequestBodyBytes?: number;

  /** request head to pass into `httpHooks.onRequest` when buffering is enabled */
  requestForBodyHook?: HttpHookRequest;
};

export type HttpHooks = {
  /** allow/deny callback for request content (request body is always `null`) */
  isRequestAllowed?: (request: HttpHookRequest) => Promise<boolean> | boolean;
  /** allow/deny callback for resolved destination ip */
  isIpAllowed?: (info: HttpIpAllowInfo) => Promise<boolean> | boolean;

  /** request rewrite hook for the request head (method/url/headers only; body is always `null`) */
  onRequestHead?: (
    request: HttpHookRequest,
  ) =>
    | Promise<HttpHookRequestHeadResult | void>
    | HttpHookRequestHeadResult
    | void;

  /** request rewrite hook for buffered requests (request body is provided as a Buffer) */
  onRequest?: (
    request: HttpHookRequest,
  ) => Promise<HttpHookRequest | void> | HttpHookRequest | void;

  /** response rewrite hook */
  onResponse?: (
    response: HttpHookResponse,
    request: HttpHookRequest,
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

  /** dns configuration */
  dns?: DnsOptions;

  /** ssh egress configuration */
  ssh?: SshOptions;

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

  /** whether to allow WebSocket upgrades (default: true) */
  allowWebSockets?: boolean;

  /** max buffered guest->upstream tcp write bytes per session in `bytes` */
  maxTcpPendingWriteBytes?: number;

  /** websocket upstream connect + tls handshake timeout in `ms` */
  webSocketUpstreamConnectTimeoutMs?: number;

  /** websocket upstream response header timeout in `ms` */
  webSocketUpstreamHeaderTimeoutMs?: number;

  /** tls MITM context cache max entries */
  tlsContextCacheMaxEntries?: number;

  /** tls MITM context cache ttl in `ms` (<=0 disables caching) */
  tlsContextCacheTtlMs?: number;

  /** @internal udp socket factory (tests) */
  udpSocketFactory?: () => dgram.Socket;

  /** @internal dns lookup implementation for hostname resolution tests */
  dnsLookup?: (
    hostname: string,
    options: dns.LookupAllOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      addresses: dns.LookupAddress[],
    ) => void,
  ) => void;
};

type CaCert = {
  key: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
  certPem: string;
};

type TlsContextCacheEntry = {
  context: tls.SecureContext;
  lastAccessAt: number;
};

export class QemuNetworkBackend extends EventEmitter {
  /** @internal */
  emitDebug(message: string) {
    // Structured event for consumers (VM / SandboxServer)
    this.emit("debug", "net", stripTrailingNewline(message));
    // Legacy string log event
    this.emit("log", `[net] ${stripTrailingNewline(message)}`);
  }

  /** @internal */
  readonly options: QemuNetworkOptions;

  private server: net.Server | null = null;

  /** @internal */
  socket: net.Socket | null = null;

  private waitingDrain = false;

  /** @internal */
  stack: NetworkStack | null = null;

  private readonly udpSessions = new Map<string, UdpSession>();

  /** @internal */
  readonly tcpSessions = new Map<string, TcpSession>();

  private readonly mitmDir: string;
  private caPromise: Promise<CaCert> | null = null;
  private tlsContexts = new Map<string, TlsContextCacheEntry>();
  private tlsContextPromises = new Map<string, Promise<tls.SecureContext>>();
  private readonly icmpTimings = new Map<string, IcmpTiming>();
  private icmpDebugBuffer = Buffer.alloc(0);
  private icmpRxBuffer = Buffer.alloc(0);
  private eventLoopDelay: ReturnType<typeof monitorEventLoopDelay> | null =
    null;

  /** @internal */
  readonly maxTcpPendingWriteBytes: number;

  /** @internal */
  readonly http: QemuHttpInternals;

  /** @internal */
  readonly ssh: QemuSshInternals;

  private readonly tlsContextCacheMaxEntries: number;
  private readonly tlsContextCacheTtlMs: number;
  private readonly flowResumeWaiters = new Map<string, Array<() => void>>();

  private readonly dnsMode: DnsMode;
  private readonly trustedDnsServers: string[];
  private trustedDnsIndex = 0;
  private readonly syntheticDnsOptions: {
    /** synthetic A response ipv4 address */
    ipv4: string;
    /** synthetic AAAA response ipv6 address */
    ipv6: string;
    /** synthetic response ttl in `seconds` */
    ttlSeconds: number;
  };
  private readonly syntheticDnsHostMapping: SyntheticDnsHostMappingMode;
  private readonly syntheticDnsHostMap: SyntheticDnsHostMap | null;

  constructor(options: QemuNetworkOptions) {
    super();
    this.options = options;

    if (options.debug) {
      this.eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
      this.eventLoopDelay.enable();
    }
    this.mitmDir = resolveMitmCertDir(options.mitmCertDir);

    this.maxTcpPendingWriteBytes =
      options.maxTcpPendingWriteBytes ?? DEFAULT_MAX_TCP_PENDING_WRITE_BYTES;

    this.http = {
      maxHttpBodyBytes: options.maxHttpBodyBytes ?? DEFAULT_MAX_HTTP_BODY_BYTES,
      maxHttpResponseBodyBytes:
        options.maxHttpResponseBodyBytes ??
        DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES,
      allowWebSockets: options.allowWebSockets ?? true,
      webSocketUpstreamConnectTimeoutMs:
        options.webSocketUpstreamConnectTimeoutMs ??
        DEFAULT_WEBSOCKET_UPSTREAM_CONNECT_TIMEOUT_MS,
      webSocketUpstreamHeaderTimeoutMs:
        options.webSocketUpstreamHeaderTimeoutMs ??
        DEFAULT_WEBSOCKET_UPSTREAM_HEADER_TIMEOUT_MS,
      httpConcurrency: new AsyncSemaphore(DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS),
      sharedDispatchers: new Map(),
      qemuRxPausedForHttpStreaming: false,
    };

    this.tlsContextCacheMaxEntries =
      options.tlsContextCacheMaxEntries ??
      DEFAULT_TLS_CONTEXT_CACHE_MAX_ENTRIES;
    this.tlsContextCacheTtlMs =
      options.tlsContextCacheTtlMs ?? DEFAULT_TLS_CONTEXT_CACHE_TTL_MS;

    this.dnsMode = options.dns?.mode ?? DEFAULT_DNS_MODE;
    this.trustedDnsServers = normalizeIpv4Servers(options.dns?.trustedServers);

    if (this.dnsMode === "trusted" && this.trustedDnsServers.length === 0) {
      throw new Error(
        "dns mode 'trusted' requires at least one IPv4 resolver (none found). Provide an IPv4 resolver via --dns-trusted-server or configure an IPv4 DNS server on the host",
      );
    }

    this.syntheticDnsOptions = {
      ipv4: options.dns?.syntheticIPv4 ?? DEFAULT_SYNTHETIC_DNS_IPV4,
      ipv6: options.dns?.syntheticIPv6 ?? DEFAULT_SYNTHETIC_DNS_IPV6,
      ttlSeconds:
        options.dns?.syntheticTtlSeconds ?? DEFAULT_SYNTHETIC_DNS_TTL_SECONDS,
    };

    this.ssh = createQemuSshInternals(options.ssh);

    this.syntheticDnsHostMapping =
      options.dns?.syntheticHostMapping ??
      (this.ssh.enabled ? "per-host" : DEFAULT_SYNTHETIC_DNS_HOST_MAPPING);
    this.syntheticDnsHostMap =
      this.syntheticDnsHostMapping === "per-host"
        ? new SyntheticDnsHostMap()
        : null;

    assertSshDnsConfig({
      ssh: this.ssh,
      dnsMode: this.dnsMode,
      syntheticHostMapping: this.syntheticDnsHostMapping,
    });
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

  async close(): Promise<void> {
    this.detachSocket();
    closeSharedDispatchers(this);

    if (this.eventLoopDelay) {
      try {
        this.eventLoopDelay.disable();
      } catch {
        // ignore
      }
      this.eventLoopDelay = null;
    }

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
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
    this.http.qemuRxPausedForHttpStreaming = false;
    this.waitingDrain = false;
    this.cleanupSessions();
    closeSharedDispatchers(this);
    this.stack?.reset();
  }

  private resetStack() {
    this.cleanupSessions();

    const gatewayIP = this.options.gatewayIP ?? "192.168.127.1";
    const dnsServers = this.dnsMode === "open" ? undefined : [gatewayIP];

    this.stack = new NetworkStack({
      gatewayIP,
      vmIP: this.options.vmIP,
      gatewayMac: this.options.gatewayMac,
      vmMac: this.options.vmMac,
      dnsServers,
      sshPorts: this.ssh.sniffPorts,
      callbacks: {
        onUdpSend: (message) => this.handleUdpSend(message),
        onTcpConnect: (message) => this.handleTcpConnect(message),
        onTcpSend: (message) => this.handleTcpSend(message),
        onTcpClose: (message) => this.handleTcpClose(message),
        onTcpPause: (message) => this.handleTcpPause(message),
        onTcpResume: (message) => this.handleTcpResume(message),
      },
      allowTcpFlow: (info) => {
        if (info.protocol === "ssh") {
          const allowed = isSshFlowAllowed(
            this,
            info.key,
            info.dstIP,
            info.dstPort,
          );
          if (!allowed) {
            if (this.options.debug) {
              this.emitDebug(
                `tcp blocked ${info.srcIP}:${info.srcPort} -> ${info.dstIP}:${info.dstPort} (${info.protocol})`,
              );
            }
            return false;
          }

          const session = this.tcpSessions.get(info.key);
          if (session) {
            session.protocol = "ssh";
          }
          return true;
        }

        if (info.protocol !== "http" && info.protocol !== "tls") {
          if (this.options.debug) {
            this.emitDebug(
              `tcp blocked ${info.srcIP}:${info.srcPort} -> ${info.dstIP}:${info.dstPort} (${info.protocol})`,
            );
          }
          return false;
        }

        const session = this.tcpSessions.get(info.key);
        if (session) {
          session.protocol = info.protocol;
          if (info.protocol === "http" || info.protocol === "tls") {
            session.http = session.http ?? {
              buffer: new HttpReceiveBuffer(),
              processing: false,
              closed: false,
              sentContinue: false,
            };
          }
        }
        return true;
      },
    });

    this.stack.on("network-activity", () => this.flush());
    this.stack.on("error", (err) => this.emit("error", err));
    this.stack.on(
      "tx-drop",
      (info: {
        priority: string;
        bytes: number;
        reason: string;
        evictedBytes?: number;
      }) => {
        if (!this.options.debug) return;
        const evicted =
          typeof info.evictedBytes === "number"
            ? ` evicted=${info.evictedBytes}`
            : "";
        this.emitDebug(
          `tx-drop priority=${info.priority} bytes=${info.bytes} reason=${info.reason}${evicted}`,
        );
      },
    );
    if (this.options.debug) {
      this.icmpTimings.clear();
      this.icmpDebugBuffer = Buffer.alloc(0);
      this.icmpRxBuffer = Buffer.alloc(0);
      this.stack.on("dhcp", (state, ip) => {
        this.emitDebug(`dhcp ${state} ${ip}`);
      });
      this.stack.on("icmp", (info) => {
        this.recordIcmpTiming(info as IcmpTiming);
      });
    }
  }

  /** @internal */
  flush() {
    if (!this.socket || this.waitingDrain || !this.stack) return;
    while (this.stack.hasPendingData()) {
      const chunk = this.stack.readFromNetwork(64 * 1024);
      if (!chunk || chunk.length === 0) break;
      if (this.options.debug) {
        const now = performance.now();
        this.trackIcmpReplies(chunk, now);
        this.emitDebug(`tx ${chunk.length} bytes to qemu`);
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

    this.emitDebug(
      `icmp echo id=${timing.id} seq=${timing.seq} ${timing.srcIP} -> ${timing.dstIP} size=${timing.size} ` +
        `${guestToHostLabel}processing=${processingMs.toFixed(3)}ms ` +
        `queued=${queuedMs.toFixed(3)}ms total=${totalMs.toFixed(3)}ms${eventLoopInfo}`,
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
      cleanupSshTcpSession(this, session);
    }
    this.tcpSessions.clear();
  }

  private pickTrustedDnsServer(): string {
    const servers = this.trustedDnsServers;
    if (servers.length === 0) {
      throw new Error(
        "dns mode 'trusted' requires at least one IPv4 resolver (none configured/found)",
      );
    }
    const index = this.trustedDnsIndex++ % servers.length;
    return servers[index]!;
  }

  private handleSyntheticDns(message: UdpSendMessage) {
    // Only respond to packets that look like DNS.
    if (!isProbablyDnsPacket(message.payload)) return;

    const query = parseDnsQuery(message.payload);
    if (!query) return;

    let mappedIpv4: string | null = null;
    if (
      this.syntheticDnsHostMapping === "per-host" &&
      !isLocalhostDnsName(query.firstQuestion.name)
    ) {
      try {
        mappedIpv4 =
          this.syntheticDnsHostMap?.allocate(query.firstQuestion.name) ?? null;
      } catch (err) {
        // Treat mapping failures as untrusted input; fall back to the default synthetic IP.
        // This avoids guest-triggerable process-level crashes.
        mappedIpv4 = null;
        if (this.options.debug) {
          this.emitDebug(
            `dns synthetic hostmap failed name=${JSON.stringify(query.firstQuestion.name)} err=${formatError(err)}`,
          );
        }
      }
    }

    const response = buildSyntheticDnsResponse(query, {
      ...this.syntheticDnsOptions,
      ipv4: mappedIpv4 ?? this.syntheticDnsOptions.ipv4,
    });

    this.stack?.handleUdpResponse({
      data: response,
      srcIP: message.srcIP,
      srcPort: message.srcPort,
      dstIP: message.dstIP,
      dstPort: message.dstPort,
    });
    this.flush();
  }

  private handleUdpSend(message: UdpSendMessage) {
    if (message.dstPort !== 53) {
      if (this.options.debug) {
        this.emitDebug(
          `udp blocked ${message.srcIP}:${message.srcPort} -> ${message.dstIP}:${message.dstPort}`,
        );
      }
      return;
    }

    if (this.dnsMode === "synthetic") {
      if (this.options.debug) {
        this.emitDebug(
          `dns synthetic ${message.srcIP}:${message.srcPort} -> ${message.dstIP}:${message.dstPort} (${message.payload.length} bytes)`,
        );
      }
      this.handleSyntheticDns(message);
      return;
    }

    if (this.dnsMode === "trusted" && !parseDnsQuery(message.payload)) {
      if (this.options.debug) {
        this.emitDebug(
          `dns blocked (non-dns payload) ${message.srcIP}:${message.srcPort} -> ${message.dstIP}:${message.dstPort} (${message.payload.length} bytes)`,
        );
      }
      return;
    }

    let session = this.udpSessions.get(message.key);
    if (!session) {
      const socket = this.options.udpSocketFactory
        ? this.options.udpSocketFactory()
        : dgram.createSocket("udp4");

      const upstreamIP =
        this.dnsMode === "trusted"
          ? this.pickTrustedDnsServer()
          : message.dstIP;
      const upstreamPort = 53;

      session = {
        socket,
        srcIP: message.srcIP,
        srcPort: message.srcPort,
        dstIP: message.dstIP,
        dstPort: message.dstPort,
        upstreamIP,
        upstreamPort,
      };
      this.udpSessions.set(message.key, session);

      socket.on("message", (data, rinfo) => {
        if (this.options.debug) {
          const via =
            this.dnsMode === "trusted"
              ? ` via ${session!.upstreamIP}:${session!.upstreamPort}`
              : "";
          this.emitDebug(
            `dns recv ${rinfo.address}:${rinfo.port} -> ${session!.srcIP}:${session!.srcPort} (${data.length} bytes)${via}`,
          );
        }

        // Reply to the guest as if it came from the original destination IP.
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
      const via =
        this.dnsMode === "trusted"
          ? ` via ${session.upstreamIP}:${session.upstreamPort}`
          : "";
      this.emitDebug(
        `dns send ${message.srcIP}:${message.srcPort} -> ${message.dstIP}:${message.dstPort} (${message.payload.length} bytes)${via}`,
      );
    }

    session.socket.send(
      message.payload,
      session.upstreamPort,
      session.upstreamIP,
    );
  }

  private handleTcpConnect(message: TcpConnectMessage) {
    const syntheticHostname =
      this.syntheticDnsHostMap?.lookupHostByIp(message.dstIP) ?? null;
    let connectIP =
      message.dstIP === (this.options.gatewayIP ?? "192.168.127.1")
        ? "127.0.0.1"
        : message.dstIP;

    if (syntheticHostname && this.ssh.sniffPortsSet.has(message.dstPort)) {
      connectIP = syntheticHostname;
    }

    const session: TcpSession = {
      socket: null,
      srcIP: message.srcIP,
      srcPort: message.srcPort,
      dstIP: message.dstIP,
      dstPort: message.dstPort,
      connectIP,
      syntheticHostname,
      flowControlPaused: false,
      protocol: null,
      connected: false,
      pendingWrites: [],
      pendingWriteBytes: 0,
    };
    this.tcpSessions.set(message.key, session);

    this.stack?.handleTcpConnected({ key: message.key });
    this.flush();
  }

  /** @internal */
  abortTcpSession(key: string, session: TcpSession, reason: string) {
    if (this.options.debug) {
      this.emitDebug(
        `tcp session aborted ${session.srcIP}:${session.srcPort} -> ${session.dstIP}:${session.dstPort} reason=${reason}`,
      );
    }

    try {
      session.socket?.destroy();
    } catch {
      // ignore
    }
    cleanupSshTcpSession(this, session);

    session.pendingWrites = [];
    session.pendingWriteBytes = 0;
    session.flowControlPaused = false;
    this.resolveFlowResume(key);

    this.stack?.handleTcpError({ key });
    this.tcpSessions.delete(key);
  }

  private queueTcpPendingWrite(
    key: string,
    session: TcpSession,
    data: Buffer,
  ): boolean {
    const nextBytes = session.pendingWriteBytes + data.length;
    if (nextBytes > this.maxTcpPendingWriteBytes) {
      this.abortTcpSession(
        key,
        session,
        `pending-write-buffer-exceeded (${nextBytes} > ${this.maxTcpPendingWriteBytes})`,
      );
      return false;
    }

    session.pendingWrites.push(data);
    session.pendingWriteBytes = nextBytes;
    return true;
  }

  private handleTcpSend(message: TcpSendMessage) {
    const session = this.tcpSessions.get(message.key);
    if (!session) return;

    if (session.protocol === "http") {
      handlePlainHttpData(this, message.key, session, message.data);
      return;
    }

    if (session.protocol === "tls") {
      this.handleTlsData(message.key, session, message.data);
      return;
    }

    if (session.protocol === "ssh") {
      this.handleSshProxyData(message.key, session, message.data);
      return;
    }

    this.ensureTcpSocket(message.key, session);

    if (session.socket && session.connected && session.socket.writable) {
      // Keep the cap strict: check how much is already queued in Node's socket buffer
      // before adding more.
      const nextWritable = session.socket.writableLength + message.data.length;
      if (nextWritable > this.maxTcpPendingWriteBytes) {
        this.abortTcpSession(
          message.key,
          session,
          `socket-write-buffer-exceeded (${nextWritable} > ${this.maxTcpPendingWriteBytes})`,
        );
        return;
      }

      session.socket.write(message.data);
      return;
    }

    this.queueTcpPendingWrite(message.key, session, message.data);
  }

  private handleSshProxyData(key: string, session: TcpSession, data: Buffer) {
    handleSshProxyDataImpl(this, key, session, data);
  }

  private handleTcpClose(message: TcpCloseMessage) {
    const session = this.tcpSessions.get(message.key);
    if (session) {
      if (session.http?.streamingBody && !session.http.streamingBody.done) {
        const controller = session.http.streamingBody.controller;
        try {
          controller?.error(new Error("guest closed"));
        } catch {
          // ignore
        }
        session.http.streamingBody.done = true;
        session.http.streamingBody.controller = null;
        updateQemuRxPauseState(this);
      }

      session.http = undefined;
      session.ws = undefined;
      session.pendingWrites = [];
      session.pendingWriteBytes = 0;
      session.flowControlPaused = false;
      this.resolveFlowResume(message.key);
      if (session.tls) {
        if (message.destroy) {
          session.tls.socket.destroy();
        } else {
          session.tls.socket.end();
        }
        session.tls = undefined;
      }
      cleanupSshTcpSession(this, session);

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
    if (!session) return;
    session.flowControlPaused = true;
    if (session.socket) {
      session.socket.pause();
    }
  }

  private handleTcpResume(message: TcpResumeMessage) {
    const session = this.tcpSessions.get(message.key);
    if (!session) return;
    session.flowControlPaused = false;
    if (session.socket) {
      session.socket.resume();
    }
    this.resolveFlowResume(message.key);
  }

  /** @internal */
  waitForFlowResume(key: string): Promise<void> {
    const session = this.tcpSessions.get(key);
    if (!session || !session.flowControlPaused) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiters = this.flowResumeWaiters.get(key) ?? [];
      waiters.push(resolve);
      this.flowResumeWaiters.set(key, waiters);
    });
  }

  /** @internal */
  resolveFlowResume(key: string) {
    const waiters = this.flowResumeWaiters.get(key);
    if (!waiters) return;
    this.flowResumeWaiters.delete(key);
    for (const resolve of waiters) {
      resolve();
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
      session.pendingWriteBytes = 0;
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
      this.resolveFlowResume(key);
      cleanupSshTcpSession(this, session);
      this.tcpSessions.delete(key);
    });

    socket.on("error", () => {
      this.stack?.handleTcpError({ key });
      this.resolveFlowResume(key);
      cleanupSshTcpSession(this, session);
      this.tcpSessions.delete(key);
    });
  }

  private ensureTlsSession(key: string, session: TcpSession) {
    if (session.tls) return session.tls;

    const stream = new GuestTlsStream(async (chunk) => {
      this.stack?.handleTcpData({ key, data: chunk });
      this.flush();
      await this.waitForFlowResume(key);
    });

    const tlsSocket = new tls.TLSSocket(stream, {
      isServer: true,
      ALPNProtocols: ["http/1.1"],
      SNICallback: (servername, callback) => {
        const sni = servername || session.dstIP;
        this.getTlsContextAsync(sni)
          .then((context) => {
            if (this.options.debug) {
              this.emitDebug(`tls sni ${sni}`);
            }
            callback(null, context);
          })
          .catch((err) => {
            callback(err as Error);
          });
      },
    });

    tlsSocket.on("data", (data) => {
      handleTlsHttpData(this, key, session, Buffer.from(data));
    });

    tlsSocket.on("error", (err) => {
      this.emit("error", err);
      this.stack?.handleTcpError({ key });
    });

    tlsSocket.on("close", () => {
      this.stack?.handleTcpClosed({ key });
      this.resolveFlowResume(key);
      this.tcpSessions.delete(key);
    });

    session.tls = {
      stream,
      socket: tlsSocket,
      servername: null,
    };

    if (this.options.debug) {
      this.emitDebug(`tls mitm start ${session.dstIP}:${session.dstPort}`);
    }

    return session.tls;
  }

  private handleTlsData(key: string, session: TcpSession, data: Buffer) {
    const tlsSession = this.ensureTlsSession(key, session);
    if (!tlsSession) return;
    tlsSession.stream.pushEncrypted(data);
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

  private pruneTlsContextCache(now = Date.now()) {
    if (this.tlsContexts.size === 0) return;

    const ttlMs = this.tlsContextCacheTtlMs;
    if (!Number.isFinite(ttlMs)) return;

    // A ttl <= 0 means "no caching": clear any cached contexts so we don't accumulate entries.
    if (ttlMs <= 0) {
      this.tlsContexts.clear();
      return;
    }

    for (const [key, entry] of this.tlsContexts) {
      if (now - entry.lastAccessAt <= ttlMs) continue;
      this.tlsContexts.delete(key);
    }
  }

  private evictTlsContextCacheIfNeeded() {
    const maxEntries = this.tlsContextCacheMaxEntries;
    if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
      this.tlsContexts.clear();
      return;
    }

    while (this.tlsContexts.size > maxEntries) {
      const oldestKey = this.tlsContexts.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) break;
      this.tlsContexts.delete(oldestKey);
    }
  }

  private async getTlsContextAsync(
    servername: string,
  ): Promise<tls.SecureContext> {
    const normalized = servername.trim() || "unknown";
    const now = Date.now();

    this.pruneTlsContextCache(now);

    const cached = this.tlsContexts.get(normalized);
    if (cached) {
      cached.lastAccessAt = now;
      // LRU: move to the end.
      this.tlsContexts.delete(normalized);
      this.tlsContexts.set(normalized, cached);
      return cached.context;
    }

    const pending = this.tlsContextPromises.get(normalized);
    if (pending) return pending;

    const promise = this.createTlsContext(normalized);
    this.tlsContextPromises.set(normalized, promise);

    try {
      const context = await promise;
      this.tlsContexts.set(normalized, {
        context,
        lastAccessAt: Date.now(),
      });
      this.evictTlsContextCacheIfNeeded();
      return context;
    } finally {
      this.tlsContextPromises.delete(normalized);
    }
  }

  private async createTlsContext(
    servername: string,
  ): Promise<tls.SecureContext> {
    const ca = await this.ensureCaAsync();
    const { keyPem, certPem } = await this.ensureLeafCertificateAsync(
      servername,
      ca,
    );

    return tls.createSecureContext({
      key: keyPem,
      cert: `${certPem}\n${ca.certPem}`,
    });
  }

  private async ensureLeafCertificateAsync(
    servername: string,
    ca: CaCert,
  ): Promise<{ keyPem: string; certPem: string }> {
    const hostsDir = path.join(this.getMitmDir(), "hosts");
    await fsp.mkdir(hostsDir, { recursive: true });

    const hash = crypto
      .createHash("sha256")
      .update(servername)
      .digest("hex")
      .slice(0, 12);
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
      const cert = forge.pki.certificateFromPem(certPem);
      if (!isNonNegativeSerialNumberHex(cert.serialNumber)) {
        throw new Error("persisted mitm leaf cert has an unsafe serial number");
      }
      if (!caCertVerifiesLeaf(ca.cert, cert)) {
        throw new Error("persisted mitm leaf cert is not signed by current ca");
      }
      if (!privateKeyMatchesLeafCert(keyPem, cert)) {
        throw new Error("persisted mitm leaf key does not match cert");
      }
      return { keyPem, certPem };
    } catch {
      // Generate new leaf certificate
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();

      cert.publicKey = keys.publicKey;
      cert.serialNumber = generatePositiveSerialNumber();
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
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

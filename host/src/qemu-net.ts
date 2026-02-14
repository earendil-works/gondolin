import { EventEmitter } from "events";
import { stripTrailingNewline } from "./debug";
import net from "net";
import os from "os";
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

import {
  generatePositiveSerialNumber,
  isNonNegativeSerialNumberHex,
  loadOrCreateMitmCa,
  resolveMitmCertDir,
} from "./mitm";
import { buildSyntheticDnsResponse, isLocalhostDnsName, isProbablyDnsPacket, parseDnsQuery } from "./dns";
import { Agent, fetch as undiciFetch } from "undici";
import {
  Client as SshClient,
  Server as SshServer,
  type AuthContext as SshAuthContext,
  type ClientChannel as SshClientChannel,
  type Connection as SshServerConnection,
  type ServerChannel as SshServerChannel,
  type Session as SshServerSession,
} from "ssh2";

import * as httpImpl from "./qemu-http";
import { HttpRequestBlockedError } from "./qemu-http";
import type { HttpSession, WebSocketState } from "./qemu-http";

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
const DEFAULT_SYNTHETIC_DNS_HOST_MAPPING: SyntheticDnsHostMappingMode = "single";
const SYNTHETIC_DNS_HOSTMAP_PREFIX_A = 198;
const SYNTHETIC_DNS_HOSTMAP_PREFIX_B = 19;

const DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS = 128;

const DEFAULT_SSH_MAX_UPSTREAM_CONNECTIONS_PER_TCP_SESSION = 4;
const DEFAULT_SSH_MAX_UPSTREAM_CONNECTIONS_TOTAL = 64;
const DEFAULT_SSH_UPSTREAM_READY_TIMEOUT_MS = 15_000;
const DEFAULT_SSH_UPSTREAM_KEEPALIVE_INTERVAL_MS = 10_000;
const DEFAULT_SSH_UPSTREAM_KEEPALIVE_COUNT_MAX = 3;

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`max concurrent operations must be > 0 (got ${limit})`);
    }
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }

    this.active += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

function normalizeIpv4Servers(servers?: string[]): string[] {
  const candidates = (servers && servers.length > 0 ? servers : dns.getServers())
    .map((server) => server.split("%")[0])
    .filter((server) => net.isIP(server) === 4);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const server of candidates) {
    if (seen.has(server)) continue;
    seen.add(server);
    unique.push(server);
  }

  return unique;
}

function generateSshHostKey(): string {
  // ssh2 Server hostKeys expects PEM PKCS#1 RSA keys (ed25519 pkcs8 is not supported)
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072,
    privateKeyEncoding: { format: "pem", type: "pkcs1" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return privateKey;
}

type SshAllowedTarget = {
  /** normalized host pattern */
  pattern: string;
  /** destination port */
  port: number;
};

function parseSshTargetPattern(raw: string): SshAllowedTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let hostPattern = trimmed;
  let port = 22;

  // Support bracket form: [host]:port
  if (hostPattern.startsWith("[")) {
    const end = hostPattern.indexOf("]");
    if (end === -1) return null;
    const host = hostPattern.slice(1, end);
    const rest = hostPattern.slice(end + 1);
    if (!host) return null;
    hostPattern = host;

    if (rest) {
      if (!rest.startsWith(":")) return null;
      const portStr = rest.slice(1);
      if (!/^[0-9]+$/.test(portStr)) return null;
      port = Number.parseInt(portStr, 10);
    }
  } else {
    const idx = hostPattern.lastIndexOf(":");
    if (idx !== -1) {
      const maybePort = hostPattern.slice(idx + 1);
      if (/^[0-9]+$/.test(maybePort)) {
        port = Number.parseInt(maybePort, 10);
        hostPattern = hostPattern.slice(0, idx);
      }
    }
  }

  const normalizedPattern = normalizeHostnamePattern(hostPattern);
  if (!normalizedPattern) return null;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }

  return { pattern: normalizedPattern, port };
}

function normalizeSshAllowedTargets(targets?: string[]): SshAllowedTarget[] {
  const out: SshAllowedTarget[] = [];
  const seen = new Set<string>();

  for (const raw of targets ?? []) {
    const parsed = parseSshTargetPattern(raw);
    if (!parsed) continue;
    const key = `${parsed.pattern}:${parsed.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }

  return out;
}

function normalizeSshCredentials(credentials?: Record<string, SshCredential>): ResolvedSshCredential[] {
  const entries: ResolvedSshCredential[] = [];
  for (const [rawPattern, credential] of Object.entries(credentials ?? {})) {
    const target = parseSshTargetPattern(rawPattern);
    if (!target) continue;
    entries.push({
      pattern: target.pattern,
      port: target.port,
      username: credential.username,
      privateKey: credential.privateKey,
      passphrase: credential.passphrase,
    });
  }
  return entries;
}

type OpenSshKnownHostsEntry = {
  /** known_hosts marker like "@revoked" */
  marker: string | null;
  /** raw host patterns from the first column */
  hostPatterns: string[];
  /** key type string (e.g. "ssh-ed25519") */
  keyType: string;
  /** decoded public key blob */
  key: Buffer;
};

function normalizeSshKnownHostsFiles(knownHostsFile?: string | string[]): string[] {
  const candidates: string[] = [];
  if (typeof knownHostsFile === "string") {
    candidates.push(knownHostsFile);
  } else if (Array.isArray(knownHostsFile)) {
    for (const file of knownHostsFile) {
      if (typeof file === "string" && file.trim()) {
        candidates.push(file);
      }
    }
  }

  if (candidates.length === 0) {
    candidates.push(path.join(os.homedir(), ".ssh", "known_hosts"));
    candidates.push("/etc/ssh/ssh_known_hosts");
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const file of candidates) {
    const normalized = file.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function parseOpenSshKnownHosts(content: string): OpenSshKnownHostsEntry[] {
  const entries: OpenSshKnownHostsEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let marker: string | null = null;
    let rest = line;
    if (rest.startsWith("@")) {
      const space = rest.indexOf(" ");
      if (space === -1) continue;
      marker = rest.slice(0, space);
      rest = rest.slice(space + 1).trim();
    }

    const parts = rest.split(/\s+/);
    if (parts.length < 3) continue;
    const [hostsField, keyType, keyB64] = parts;

    let key: Buffer;
    try {
      key = Buffer.from(keyB64, "base64");
    } catch {
      continue;
    }

    if (!hostsField || !keyType || key.length === 0) continue;
    entries.push({
      marker,
      hostPatterns: hostsField.split(",").filter(Boolean),
      keyType,
      key,
    });
  }
  return entries;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchOpenSshHostPattern(hostname: string, pattern: string): boolean {
  const hn = hostname.toLowerCase();
  const pat = pattern.startsWith("|1|") ? pattern : pattern.toLowerCase();

  // Hashed hostnames: "|1|<salt-b64>|<hmac-b64>"
  if (pat.startsWith("|1|")) {
    const parts = pat.split("|");
    // ['', '1', salt, hmac]
    if (parts.length !== 4) return false;
    const saltB64 = parts[2];
    const hmacB64 = parts[3];
    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(saltB64, "base64");
      expected = Buffer.from(hmacB64, "base64");
    } catch {
      return false;
    }
    const actual = crypto.createHmac("sha1", salt).update(hn, "utf8").digest();
    return actual.length === expected.length && actual.equals(expected);
  }

  // Wildcards: "*" and "?" like OpenSSH
  if (pat.includes("*") || pat.includes("?")) {
    const re = new RegExp(
      "^" + escapeRegExp(pat).replace(/\\\*/g, ".*").replace(/\\\?/g, ".") + "$",
      "i"
    );
    return re.test(hn);
  }

  return hn === pat;
}

function hostMatchesOpenSshKnownHostsList(hostname: string, patterns: string[], port: number): boolean {
  const candidates = port === 22 ? [hostname, `[${hostname}]:22`] : [`[${hostname}]:${port}`];

  for (const candidate of candidates) {
    let positive = false;
    for (const rawPattern of patterns) {
      if (!rawPattern) continue;
      const negated = rawPattern.startsWith("!");
      const pattern = negated ? rawPattern.slice(1) : rawPattern;
      if (!pattern) continue;

      if (matchOpenSshHostPattern(candidate, pattern)) {
        if (negated) {
          return false;
        }
        positive = true;
      }
    }
    if (positive) return true;
  }

  return false;
}

function createOpenSshKnownHostsHostVerifier(
  files: string[]
): (hostname: string, key: Buffer, port: number) => boolean {
  const entries: OpenSshKnownHostsEntry[] = [];
  const loadedFiles: string[] = [];

  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      loadedFiles.push(file);
      entries.push(...parseOpenSshKnownHosts(content));
    } catch {
      // Ignore unreadable files here; we'll fail if nothing could be loaded.
    }
  }

  if (loadedFiles.length === 0) {
    throw new Error(`no OpenSSH known_hosts files found (tried ${files.join(", ")})`);
  }

  return (hostname: string, key: Buffer, port: number) => {
    const host = hostname.trim().toLowerCase();
    if (!host) return false;
    const sshPort = Number.isInteger(port) && port > 0 ? port : 22;

    for (const entry of entries) {
      if (!hostMatchesOpenSshKnownHostsList(host, entry.hostPatterns, sshPort)) {
        continue;
      }

      // Respect revoked keys
      if (entry.marker === "@revoked") {
        if (entry.key.equals(key)) {
          return false;
        }
        continue;
      }

      if (entry.key.equals(key)) {
        return true;
      }
    }

    // If we saw matching host patterns but no matching key, reject.
    // If we saw no matching host patterns, also reject (unknown host).
    return false;
  };
}

class SyntheticDnsHostMap {
  private readonly hostToIp = new Map<string, string>();
  private readonly ipToHost = new Map<string, string>();
  private nextHostId = 1;

  /**
   * Allocate (or retrieve) a stable synthetic IPv4 for a hostname.
   *
   * Returns null for invalid/unsupported hostnames or if the mapping space is exhausted.
   * This method must be safe to call on untrusted guest input.
   */
  allocate(hostname: string): string | null {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    // DNS names are limited to 253 chars in presentation format (without trailing dot).
    // Treat anything larger as invalid to avoid unbounded memory usage.
    if (normalized.length > 253) {
      return null;
    }

    const existing = this.hostToIp.get(normalized);
    if (existing) return existing;

    const hostsPerBucket = 254;
    const maxHosts = 0x100 * hostsPerBucket;
    if (this.nextHostId > maxHosts) {
      return null;
    }

    const index = this.nextHostId - 1;
    const hi = Math.floor(index / hostsPerBucket) & 0xff;
    const lo = (index % hostsPerBucket) + 1;
    this.nextHostId += 1;

    const ip = `${SYNTHETIC_DNS_HOSTMAP_PREFIX_A}.${SYNTHETIC_DNS_HOSTMAP_PREFIX_B}.${hi}.${lo}`;

    this.hostToIp.set(normalized, ip);
    this.ipToHost.set(ip, normalized);
    return ip;
  }

  lookupHostByIp(ip: string): string | null {
    return this.ipToHost.get(ip) ?? null;
  }
}

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
  constructor(private readonly onEncryptedWrite: (chunk: Buffer) => void | Promise<void>) {
    super();
  }

  pushEncrypted(data: Buffer) {
    this.push(data);
  }

  _read() {
    // data is pushed via pushEncrypted
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    Promise.resolve(this.onEncryptedWrite(Buffer.from(chunk))).then(
      () => callback(),
      (err) => callback(err as Error)
    );
  }
}

class GuestSshStream extends Duplex {
  constructor(
    private readonly onServerWrite: (chunk: Buffer) => void | Promise<void>,
    private readonly onServerEnd: () => void | Promise<void>
  ) {
    super();
  }

  pushFromGuest(data: Buffer) {
    this.push(data);
  }

  _read() {
    // data is pushed via pushFromGuest
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    Promise.resolve(this.onServerWrite(Buffer.from(chunk))).then(
      () => callback(),
      (err) => callback(err as Error)
    );
  }

  _final(callback: (error?: Error | null) => void) {
    Promise.resolve(this.onServerEnd()).then(
      () => callback(),
      (err) => callback(err as Error)
    );
  }
}

type TlsSession = {
  stream: GuestTlsStream;
  socket: tls.TLSSocket;
  servername: string | null;
};

type ResolvedSshCredential = {
  /** matched host pattern */
  pattern: string;
  /** destination port */
  port: number;
  /** upstream ssh username */
  username?: string;
  /** private key in OpenSSH/PEM format */
  privateKey: string | Buffer;
  /** private key passphrase */
  passphrase?: string | Buffer;
};

type SshProxySession = {
  /** guest-side injected transport stream */
  stream: GuestSshStream;
  /** per-flow ssh server */
  server: SshServer;
  /** guest-side ssh server connection */
  connection: SshServerConnection | null;
  /** active upstream ssh clients created for concurrent exec channels */
  upstreams: Set<SshClient>;
};

type TcpSession = {
  socket: net.Socket | null;
  srcIP: string;
  srcPort: number;
  dstIP: string;
  dstPort: number;
  /** upstream host/ip used by the host socket connect */
  connectIP: string;
  /** synthetic hostname derived from destination synthetic dns ip */
  syntheticHostname: string | null;
  /** resolved upstream credential for ssh proxying */
  sshCredential: ResolvedSshCredential | null;
  /** active ssh proxy state when host-side credentials are used */
  sshProxy?: SshProxySession;
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

type SharedDispatcherEntry = {
  dispatcher: Agent;
  lastUsedAt: number;
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

export type SshCredential = {
  /** upstream ssh username */
  username?: string;
  /** private key in OpenSSH/PEM format */
  privateKey: string | Buffer;
  /** private key passphrase */
  passphrase?: string | Buffer;
};

export type SshExecRequest = {
  /** target hostname derived from synthetic dns mapping */
  hostname: string;
  /** target port */
  port: number;

  /** ssh username the guest authenticated as */
  guestUsername: string;

  /** raw ssh exec command */
  command: string;

  /** source guest flow attribution */
  src: {
    /** guest source ip address */
    ip: string;
    /** guest source port */
    port: number;
  };
};

export type SshExecDecision =
  | { allow: true }
  | {
      allow: false;
      /** process exit code (default: 1) */
      exitCode?: number;
      /** message written to the guest channel stderr (trailing newline implied) */
      message?: string;
    };

export type SshExecPolicy = (request: SshExecRequest) =>
  | SshExecDecision
  | Promise<SshExecDecision>;

export type SshOptions = {
  /** allowed ssh host patterns (optionally with ":PORT" suffix to allow non-standard ports) */
  allowedHosts: string[];
  /** host pattern -> upstream private-key credential */
  credentials?: Record<string, SshCredential>;
  /** ssh-agent socket path (e.g. $SSH_AUTH_SOCK) */
  agent?: string;
  /** OpenSSH known_hosts file path(s) used for default host key verification when `hostVerifier` is not set */
  knownHostsFile?: string | string[];

  /** allow/deny callback for guest ssh exec requests */
  execPolicy?: SshExecPolicy;

  /** max concurrent upstream ssh connections per guest tcp flow */
  maxUpstreamConnectionsPerTcpSession?: number;
  /** max concurrent upstream ssh connections across all guest flows */
  maxUpstreamConnectionsTotal?: number;
  /** upstream ssh connect+handshake timeout in `ms` */
  upstreamReadyTimeoutMs?: number;
  /** upstream ssh keepalive interval in `ms` */
  upstreamKeepaliveIntervalMs?: number;
  /** upstream ssh keepalive probes before disconnect */
  upstreamKeepaliveCountMax?: number;

  /** guest-facing ssh host key */
  hostKey?: string | Buffer;
  /** upstream host key verifier callback (required when `allowedHosts` is non-empty unless `knownHostsFile`/default known_hosts is used) */
  hostVerifier?: (hostname: string, key: Buffer, port: number) => boolean;
};

export { HttpRequestBlockedError };

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
    request: HttpHookRequest
  ) => Promise<HttpHookRequestHeadResult | void> | HttpHookRequestHeadResult | void;

  /** request rewrite hook for buffered requests (request body is provided as a Buffer) */
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
    callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void
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
  private emitDebug(message: string) {
    // Structured event for consumers (VM / SandboxServer)
    this.emit("debug", "net", stripTrailingNewline(message));
    // Legacy string log event
    this.emit("log", `[net] ${stripTrailingNewline(message)}`);
  }
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private waitingDrain = false;
  private qemuRxPausedForHttpStreaming = false;
  private stack: NetworkStack | null = null;
  private readonly udpSessions = new Map<string, UdpSession>();
  private readonly tcpSessions = new Map<string, TcpSession>();
  private readonly mitmDir: string;
  private caPromise: Promise<CaCert> | null = null;
  private tlsContexts = new Map<string, TlsContextCacheEntry>();
  private tlsContextPromises = new Map<string, Promise<tls.SecureContext>>();
  private readonly icmpTimings = new Map<string, IcmpTiming>();
  private icmpDebugBuffer = Buffer.alloc(0);
  private icmpRxBuffer = Buffer.alloc(0);
  private eventLoopDelay: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private readonly maxHttpBodyBytes: number;
  private readonly maxHttpResponseBodyBytes: number;
  private readonly maxTcpPendingWriteBytes: number;
  private readonly allowWebSockets: boolean;
  private readonly webSocketUpstreamConnectTimeoutMs: number;
  private readonly webSocketUpstreamHeaderTimeoutMs: number;
  private readonly tlsContextCacheMaxEntries: number;
  private readonly tlsContextCacheTtlMs: number;
  private readonly httpConcurrency: AsyncSemaphore;
  private readonly sharedDispatchers = new Map<string, SharedDispatcherEntry>();
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
  private readonly sshAllowedTargets: SshAllowedTarget[];
  private readonly sshSniffPorts: number[];
  private readonly sshSniffPortsSet: ReadonlySet<number>;
  private readonly sshCredentials: ResolvedSshCredential[];
  private readonly sshAgent: string | null;
  private sshHostKey: string | null;
  private readonly sshHostVerifier: ((hostname: string, key: Buffer, port: number) => boolean) | null;
  private readonly sshExecPolicy: SshExecPolicy | null;
  private readonly sshMaxUpstreamConnectionsPerTcpSession: number;
  private readonly sshMaxUpstreamConnectionsTotal: number;
  private readonly sshUpstreamReadyTimeoutMs: number;
  private readonly sshUpstreamKeepaliveIntervalMs: number;
  private readonly sshUpstreamKeepaliveCountMax: number;
  private readonly sshUpstreams = new Set<SshClient>();

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

    this.maxTcpPendingWriteBytes =
      options.maxTcpPendingWriteBytes ?? DEFAULT_MAX_TCP_PENDING_WRITE_BYTES;

    this.allowWebSockets = options.allowWebSockets ?? true;
    this.webSocketUpstreamConnectTimeoutMs =
      options.webSocketUpstreamConnectTimeoutMs ?? DEFAULT_WEBSOCKET_UPSTREAM_CONNECT_TIMEOUT_MS;
    this.webSocketUpstreamHeaderTimeoutMs =
      options.webSocketUpstreamHeaderTimeoutMs ?? DEFAULT_WEBSOCKET_UPSTREAM_HEADER_TIMEOUT_MS;

    this.httpConcurrency = new AsyncSemaphore(DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS);

    this.tlsContextCacheMaxEntries =
      options.tlsContextCacheMaxEntries ?? DEFAULT_TLS_CONTEXT_CACHE_MAX_ENTRIES;
    this.tlsContextCacheTtlMs = options.tlsContextCacheTtlMs ?? DEFAULT_TLS_CONTEXT_CACHE_TTL_MS;

    this.dnsMode = options.dns?.mode ?? DEFAULT_DNS_MODE;
    this.trustedDnsServers = normalizeIpv4Servers(options.dns?.trustedServers);

    if (this.dnsMode === "trusted" && this.trustedDnsServers.length === 0) {
      throw new Error(
        "dns mode 'trusted' requires at least one IPv4 resolver (none found). Provide an IPv4 resolver via --dns-trusted-server or configure an IPv4 DNS server on the host"
      );
    }

    this.syntheticDnsOptions = {
      ipv4: options.dns?.syntheticIPv4 ?? DEFAULT_SYNTHETIC_DNS_IPV4,
      ipv6: options.dns?.syntheticIPv6 ?? DEFAULT_SYNTHETIC_DNS_IPV6,
      ttlSeconds: options.dns?.syntheticTtlSeconds ?? DEFAULT_SYNTHETIC_DNS_TTL_SECONDS,
    };

    this.sshAllowedTargets = normalizeSshAllowedTargets(options.ssh?.allowedHosts);
    this.sshSniffPorts = Array.from(new Set(this.sshAllowedTargets.map((t) => t.port)));
    this.sshSniffPortsSet = new Set(this.sshSniffPorts);
    this.sshCredentials = normalizeSshCredentials(options.ssh?.credentials);
    this.sshAgent = options.ssh?.agent ?? null;
    this.sshExecPolicy = options.ssh?.execPolicy ?? null;
    this.sshHostKey =
      typeof options.ssh?.hostKey === "string"
        ? options.ssh.hostKey
        : options.ssh?.hostKey
          ? options.ssh.hostKey.toString("utf8")
          : null;
    let sshHostVerifier = options.ssh?.hostVerifier ?? null;

    // Default to OpenSSH host key verification via known_hosts unless an explicit verifier
    // is provided. This protects against DNS poisoning / MITM for both agent and raw key auth.
    if (
      this.sshAllowedTargets.length > 0 &&
      !sshHostVerifier &&
      (this.sshAgent || this.sshCredentials.length > 0)
    ) {
      const knownHostsFiles = normalizeSshKnownHostsFiles(options.ssh?.knownHostsFile);
      try {
        sshHostVerifier = createOpenSshKnownHostsHostVerifier(knownHostsFiles);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
        throw new Error(
          `ssh egress requires ssh.hostVerifier to validate upstream host keys (failed to load known_hosts: ${message})`
        );
      }
    }

    this.sshHostVerifier = sshHostVerifier;

    const sshMaxPerSession =
      options.ssh?.maxUpstreamConnectionsPerTcpSession ??
      DEFAULT_SSH_MAX_UPSTREAM_CONNECTIONS_PER_TCP_SESSION;
    if (!Number.isInteger(sshMaxPerSession) || sshMaxPerSession <= 0) {
      throw new Error("ssh.maxUpstreamConnectionsPerTcpSession must be an integer > 0");
    }

    const sshMaxTotal =
      options.ssh?.maxUpstreamConnectionsTotal ?? DEFAULT_SSH_MAX_UPSTREAM_CONNECTIONS_TOTAL;
    if (!Number.isInteger(sshMaxTotal) || sshMaxTotal <= 0) {
      throw new Error("ssh.maxUpstreamConnectionsTotal must be an integer > 0");
    }

    const sshReadyTimeoutMs =
      options.ssh?.upstreamReadyTimeoutMs ?? DEFAULT_SSH_UPSTREAM_READY_TIMEOUT_MS;
    if (!Number.isInteger(sshReadyTimeoutMs) || sshReadyTimeoutMs <= 0) {
      throw new Error("ssh.upstreamReadyTimeoutMs must be an integer > 0");
    }

    const sshKeepaliveIntervalMs =
      options.ssh?.upstreamKeepaliveIntervalMs ?? DEFAULT_SSH_UPSTREAM_KEEPALIVE_INTERVAL_MS;
    if (!Number.isInteger(sshKeepaliveIntervalMs) || sshKeepaliveIntervalMs < 0) {
      throw new Error("ssh.upstreamKeepaliveIntervalMs must be an integer >= 0");
    }

    const sshKeepaliveCountMax =
      options.ssh?.upstreamKeepaliveCountMax ?? DEFAULT_SSH_UPSTREAM_KEEPALIVE_COUNT_MAX;
    if (!Number.isInteger(sshKeepaliveCountMax) || sshKeepaliveCountMax < 0) {
      throw new Error("ssh.upstreamKeepaliveCountMax must be an integer >= 0");
    }

    this.sshMaxUpstreamConnectionsPerTcpSession = sshMaxPerSession;
    this.sshMaxUpstreamConnectionsTotal = sshMaxTotal;
    this.sshUpstreamReadyTimeoutMs = sshReadyTimeoutMs;
    this.sshUpstreamKeepaliveIntervalMs = sshKeepaliveIntervalMs;
    this.sshUpstreamKeepaliveCountMax = sshKeepaliveCountMax;

    this.syntheticDnsHostMapping =
      options.dns?.syntheticHostMapping ??
      (this.sshAllowedTargets.length > 0 ? "per-host" : DEFAULT_SYNTHETIC_DNS_HOST_MAPPING);
    this.syntheticDnsHostMap =
      this.syntheticDnsHostMapping === "per-host" ? new SyntheticDnsHostMap() : null;

    if (this.sshAllowedTargets.length > 0 && this.dnsMode !== "synthetic") {
      throw new Error("ssh egress requires dns mode 'synthetic'");
    }
    if (this.sshAllowedTargets.length > 0 && this.syntheticDnsHostMapping !== "per-host") {
      throw new Error("ssh egress requires dns syntheticHostMapping='per-host'");
    }
    if (this.sshAllowedTargets.length > 0 && this.sshCredentials.length === 0 && !this.sshAgent) {
      throw new Error("ssh egress requires at least one credential or ssh agent (direct ssh is not supported)");
    }
    if (this.sshAllowedTargets.length > 0 && !this.sshHostVerifier) {
      throw new Error("ssh egress requires ssh.hostVerifier to validate upstream host keys");
    }
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
    this.closeSharedDispatchers();

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
    this.qemuRxPausedForHttpStreaming = false;
    this.waitingDrain = false;
    this.cleanupSessions();
    this.closeSharedDispatchers();
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
      sshPorts: this.sshSniffPorts,
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
          const allowed = this.isSshFlowAllowed(info.key, info.dstIP, info.dstPort);
          if (!allowed) {
            if (this.options.debug) {
              this.emitDebug(
                `tcp blocked ${info.srcIP}:${info.srcPort} -> ${info.dstIP}:${info.dstPort} (${info.protocol})`
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
              `tcp blocked ${info.srcIP}:${info.srcPort} -> ${info.dstIP}:${info.dstPort} (${info.protocol})`
            );
          }
          return false;
        }

        const session = this.tcpSessions.get(info.key);
        if (session) {
          session.protocol = info.protocol;
          if (info.protocol === "http" || info.protocol === "tls") {
            session.http = session.http ?? {
              buffer: new httpImpl.HttpReceiveBuffer(),
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
    this.stack.on("tx-drop", (info: { priority: string; bytes: number; reason: string; evictedBytes?: number }) => {
      if (!this.options.debug) return;
      const evicted = typeof info.evictedBytes === "number" ? ` evicted=${info.evictedBytes}` : "";
      this.emitDebug(`tx-drop priority=${info.priority} bytes=${info.bytes} reason=${info.reason}${evicted}`);
    });
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

  private flush() {
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
      this.closeSshProxySession(session.sshProxy);
    }
    this.tcpSessions.clear();
  }

  private pickTrustedDnsServer(): string {
    const servers = this.trustedDnsServers;
    if (servers.length === 0) {
      throw new Error(
        "dns mode 'trusted' requires at least one IPv4 resolver (none configured/found)"
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
        mappedIpv4 = this.syntheticDnsHostMap?.allocate(query.firstQuestion.name) ?? null;
      } catch (err) {
        // Treat mapping failures as untrusted input; fall back to the default synthetic IP.
        // This avoids guest-triggerable process-level crashes.
        mappedIpv4 = null;
        if (this.options.debug) {
          this.emitDebug(
            `dns synthetic hostmap failed name=${JSON.stringify(query.firstQuestion.name)} err=${formatError(err)}`
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
          `udp blocked ${message.srcIP}:${message.srcPort} -> ${message.dstIP}:${message.dstPort}`
        );
      }
      return;
    }

    if (this.dnsMode === "synthetic") {
      if (this.options.debug) {
        this.emitDebug(
          `dns synthetic ${message.srcIP}:${message.srcPort} -> ${message.dstIP}:${message.dstPort} (${message.payload.length} bytes)`
        );
      }
      this.handleSyntheticDns(message);
      return;
    }

    if (this.dnsMode === "trusted" && !parseDnsQuery(message.payload)) {
      if (this.options.debug) {
        this.emitDebug(
          `dns blocked (non-dns payload) ${message.srcIP}:${message.srcPort} -> ${message.dstIP}:${message.dstPort} (${message.payload.length} bytes)`
        );
      }
      return;
    }

    let session = this.udpSessions.get(message.key);
    if (!session) {
      const socket = this.options.udpSocketFactory
        ? this.options.udpSocketFactory()
        : dgram.createSocket("udp4");

      const upstreamIP = this.dnsMode === "trusted" ? this.pickTrustedDnsServer() : message.dstIP;
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
          const via = this.dnsMode === "trusted" ? ` via ${session!.upstreamIP}:${session!.upstreamPort}` : "";
          this.emitDebug(
            `dns recv ${rinfo.address}:${rinfo.port} -> ${session!.srcIP}:${session!.srcPort} (${data.length} bytes)${via}`
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
      const via = this.dnsMode === "trusted" ? ` via ${session.upstreamIP}:${session.upstreamPort}` : "";
      this.emitDebug(
        `dns send ${message.srcIP}:${message.srcPort} -> ${message.dstIP}:${message.dstPort} (${message.payload.length} bytes)${via}`
      );
    }

    session.socket.send(message.payload, session.upstreamPort, session.upstreamIP);
  }

  private resolveSshCredential(hostname: string, port: number): ResolvedSshCredential | null {
    const normalized = hostname.toLowerCase();
    for (const credential of this.sshCredentials) {
      if (credential.port !== port) continue;
      if (matchHostname(normalized, credential.pattern)) {
        return credential;
      }
    }
    return null;
  }

  private isSshFlowAllowed(key: string, dstIP: string, dstPort: number): boolean {
    if (this.sshAllowedTargets.length === 0) return false;

    const session = this.tcpSessions.get(key);
    const hostname =
      session?.syntheticHostname ?? this.syntheticDnsHostMap?.lookupHostByIp(dstIP) ?? null;
    if (!hostname) return false;

    const normalized = hostname.toLowerCase();
    const allowed = this.sshAllowedTargets.some(
      (target) => target.port === dstPort && matchHostname(normalized, target.pattern)
    );
    if (!allowed) return false;

    const credential = this.resolveSshCredential(hostname, dstPort);
    const canUseAgent = Boolean(this.sshAgent);

    // SSH egress is always proxied via the host; without a credential or agent we can't
    // authenticate upstream and must deny the flow.
    if (!credential && !canUseAgent) {
      return false;
    }

    if (session) {
      session.connectIP = hostname;
      session.syntheticHostname = hostname;
      session.sshCredential = credential;
    }

    return true;
  }

  private handleTcpConnect(message: TcpConnectMessage) {
    const syntheticHostname = this.syntheticDnsHostMap?.lookupHostByIp(message.dstIP) ?? null;
    let connectIP =
      message.dstIP === (this.options.gatewayIP ?? "192.168.127.1") ? "127.0.0.1" : message.dstIP;

    if (syntheticHostname && this.sshSniffPortsSet.has(message.dstPort)) {
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
      sshCredential: null,
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

  private abortTcpSession(key: string, session: TcpSession, reason: string) {
    if (this.options.debug) {
      this.emitDebug(
        `tcp session aborted ${session.srcIP}:${session.srcPort} -> ${session.dstIP}:${session.dstPort} reason=${reason}`
      );
    }

    try {
      session.socket?.destroy();
    } catch {
      // ignore
    }
    this.closeSshProxySession(session.sshProxy);
    session.sshProxy = undefined;

    session.pendingWrites = [];
    session.pendingWriteBytes = 0;
    session.flowControlPaused = false;
    this.resolveFlowResume(key);

    this.stack?.handleTcpError({ key });
    this.tcpSessions.delete(key);
  }

  private queueTcpPendingWrite(key: string, session: TcpSession, data: Buffer): boolean {
    const nextBytes = session.pendingWriteBytes + data.length;
    if (nextBytes > this.maxTcpPendingWriteBytes) {
      this.abortTcpSession(
        key,
        session,
        `pending-write-buffer-exceeded (${nextBytes} > ${this.maxTcpPendingWriteBytes})`
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
      this.handlePlainHttpData(message.key, session, message.data);
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
          `socket-write-buffer-exceeded (${nextWritable} > ${this.maxTcpPendingWriteBytes})`
        );
        return;
      }

      session.socket.write(message.data);
      return;
    }

    this.queueTcpPendingWrite(message.key, session, message.data);
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
        this.updateQemuRxPauseState();
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
      this.closeSshProxySession(session.sshProxy);
      session.sshProxy = undefined;

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

  private waitForFlowResume(key: string): Promise<void> {
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

  private resolveFlowResume(key: string) {
    const waiters = this.flowResumeWaiters.get(key);
    if (!waiters) return;
    this.flowResumeWaiters.delete(key);
    for (const resolve of waiters) {
      resolve();
    }
  }


  private updateQemuRxPauseState() {
    return httpImpl.updateQemuRxPauseState.call(this);
  }

  private closeSshProxySession(proxy?: SshProxySession) {
    if (!proxy) return;
    try {
      proxy.connection?.end();
    } catch {
      // ignore
    }

    // A guest SSH connection can spawn multiple exec channels concurrently.
    // Each exec uses its own upstream SshClient, so make sure we close all of them.
    for (const upstream of proxy.upstreams) {
      this.sshUpstreams.delete(upstream);
      try {
        upstream.end();
      } catch {
        // ignore
      }
    }
    proxy.upstreams.clear();

    try {
      proxy.server.close();
    } catch {
      // ignore
    }
    try {
      proxy.stream.destroy();
    } catch {
      // ignore
    }
  }

  private getOrCreateSshHostKey(): string {
    if (this.sshHostKey !== null) {
      return this.sshHostKey;
    }
    this.sshHostKey = generateSshHostKey();
    return this.sshHostKey;
  }

  private ensureSshProxySession(key: string, session: TcpSession): SshProxySession {
    const existing = session.sshProxy;
    if (existing) return existing;

    if (!session.syntheticHostname) {
      throw new Error("ssh proxy requires synthetic hostname");
    }
    if (!session.sshCredential && !this.sshAgent) {
      throw new Error("ssh proxy requires credential or ssh agent");
    }

    const stream = new GuestSshStream(
      async (chunk) => {
        this.stack?.handleTcpData({ key, data: chunk });
        this.flush();
        await this.waitForFlowResume(key);
      },
      async () => {
        this.stack?.handleTcpEnd({ key });
        this.flush();
      }
    );

    const server = new SshServer({
      hostKeys: [this.getOrCreateSshHostKey()],
      ident: "SSH-2.0-gondolin-ssh-proxy",
    });

    const proxy: SshProxySession = {
      stream,
      server,
      connection: null,
      upstreams: new Set(),
    };

    const onProxyError = (err: unknown) => {
      this.abortTcpSession(key, session, `ssh-proxy-error (${formatError(err)})`);
    };

    server.on("error", onProxyError);
    stream.on("error", onProxyError);

    server.on("connection", (connection) => {
      proxy.connection = connection;
      let guestUsername = "";

      connection.on("authentication", (context: SshAuthContext) => {
        guestUsername = context.username || guestUsername;
        context.accept();
      });

      connection.on("error", onProxyError);

      connection.on("ready", () => {
        connection.on("session", (acceptSession) => {
          const sshSession = acceptSession();
          this.attachSshSessionHandlers({
            key,
            session,
            proxy,
            sshSession,
            guestUsername,
          });
        });
      });
    });

    server.injectSocket(stream as any);
    session.sshProxy = proxy;

    if (this.options.debug) {
      this.emitDebug(`ssh proxy start ${session.srcIP}:${session.srcPort} -> ${session.syntheticHostname}:${session.dstPort}`);
    }

    return proxy;
  }

  private attachSshSessionHandlers(options: {
    key: string;
    session: TcpSession;
    proxy: SshProxySession;
    sshSession: SshServerSession;
    guestUsername: string;
  }) {
    const { key, session, proxy, sshSession, guestUsername } = options;

    sshSession.on("pty", (accept) => {
      if (typeof accept === "function") accept();
    });
    sshSession.on("window-change", (accept) => {
      if (typeof accept === "function") accept();
    });
    sshSession.on("env", (accept) => {
      if (typeof accept === "function") accept();
    });

    sshSession.on("shell", (accept) => {
      if (typeof accept !== "function") return;
      const ch = accept();
      ch.stderr.write("gondolin ssh proxy: interactive shells are not supported\n");
      ch.exit(1);
      ch.close();
    });

    sshSession.on("exec", (accept, _reject, info) => {
      if (typeof accept !== "function") return;
      const guestChannel = accept();
      this.bridgeSshExecChannel({
        key,
        session,
        proxy,
        guestChannel,
        command: info.command,
        guestUsername,
      }).catch((err) => {
        try {
          guestChannel.stderr.write(Buffer.from(`gondolin ssh proxy error: ${formatError(err)}\n`, "utf8"));
        } catch {
          // ignore
        }
        try {
          guestChannel.exit(255);
        } catch {
          // ignore
        }
        try {
          guestChannel.close();
        } catch {
          // ignore
        }
      });
    });

    sshSession.on("subsystem", (_accept, reject) => {
      reject();
    });
  }

  private async bridgeSshExecChannel(options: {
    key: string;
    session: TcpSession;
    proxy: SshProxySession;
    guestChannel: SshServerChannel;
    command: string;
    guestUsername: string;
  }) {
    const { key, session, proxy, guestChannel, command, guestUsername } = options;
    const hostname = session.syntheticHostname;
    const credential = session.sshCredential;
    if (!hostname) {
      throw new Error("missing ssh proxy hostname");
    }
    if (!credential && !this.sshAgent) {
      throw new Error("missing ssh proxy credential/agent");
    }

    if (this.sshExecPolicy) {
      const decision = await this.sshExecPolicy({
        hostname,
        port: session.dstPort,
        guestUsername,
        command,
        src: { ip: session.srcIP, port: session.srcPort },
      });

      if (!decision.allow) {
        const exitCode = decision.exitCode ?? 1;
        if (decision.message) {
          try {
            guestChannel.stderr.write(`${decision.message}\n`);
          } catch {
            // ignore
          }
        }
        try {
          guestChannel.exit(exitCode);
        } catch {
          // ignore
        }
        try {
          guestChannel.close();
        } catch {
          // ignore
        }
        if (this.options.debug) {
          this.emitDebug(`ssh proxy exec denied ${hostname}:${session.dstPort} ${JSON.stringify(command)}`);
        }
        return;
      }
    }

    if (proxy.upstreams.size >= this.sshMaxUpstreamConnectionsPerTcpSession) {
      throw new Error(
        `too many concurrent upstream ssh connections for this guest flow (limit ${this.sshMaxUpstreamConnectionsPerTcpSession})`
      );
    }
    if (this.sshUpstreams.size >= this.sshMaxUpstreamConnectionsTotal) {
      throw new Error(
        `too many concurrent upstream ssh connections on host (limit ${this.sshMaxUpstreamConnectionsTotal})`
      );
    }

    const upstream = new SshClient();
    proxy.upstreams.add(upstream);
    this.sshUpstreams.add(upstream);

    const removeUpstream = () => {
      proxy.upstreams.delete(upstream);
      this.sshUpstreams.delete(upstream);
    };

    // Ensure we don't retain references if the client closes unexpectedly.
    upstream.once("close", removeUpstream);

    const connectConfig: import("ssh2").ConnectConfig = {
      host: hostname,
      port: session.dstPort,
      username: credential ? (credential.username ?? "git") : guestUsername || "git",
      readyTimeout: this.sshUpstreamReadyTimeoutMs,
      keepaliveInterval: this.sshUpstreamKeepaliveIntervalMs,
      keepaliveCountMax: this.sshUpstreamKeepaliveCountMax,
    };

    if (credential) {
      connectConfig.privateKey = credential.privateKey;
      connectConfig.passphrase = credential.passphrase;
    } else if (this.sshAgent) {
      connectConfig.agent = this.sshAgent;
    }

    if (this.sshHostVerifier) {
      connectConfig.hostVerifier = (key: Buffer) => this.sshHostVerifier!(hostname, key, session.dstPort);
    }

    let upstreamChannel: SshClientChannel | null = null;

    // If the guest closes the channel early, tear down the upstream connection.
    guestChannel.once("close", () => {
      try {
        upstreamChannel?.close();
      } catch {
        // ignore
      }
      try {
        upstream.end();
      } catch {
        // ignore
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settleResolve = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const settleReject = (err: unknown) => {
          if (settled) return;
          settled = true;
          reject(err);
        };

        upstream.once("ready", settleResolve);
        upstream.once("error", settleReject);
        upstream.once("close", () => settleReject(new Error("upstream ssh closed before ready")));
        upstream.connect(connectConfig);
      });

      upstreamChannel = await new Promise<SshClientChannel>((resolve, reject) => {
        upstream.exec(command, (err, channel) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(channel);
        });
      });
    } catch (err) {
      removeUpstream();
      try {
        upstream.end();
      } catch {
        // ignore
      }
      throw err;
    }

    if (this.options.debug) {
      this.emitDebug(`ssh proxy exec ${hostname} ${JSON.stringify(command)}`);
    }

    upstreamChannel.on("data", (data: Buffer) => {
      guestChannel.write(data);
    });

    upstreamChannel.stderr.on("data", (data: Buffer) => {
      guestChannel.stderr.write(data);
    });

    upstreamChannel.on("exit", (code: number | null, signal?: string) => {
      if (typeof code === "number") {
        guestChannel.exit(code);
      } else if (signal) {
        guestChannel.exit(signal);
      }
    });

    upstreamChannel.on("close", () => {
      try {
        guestChannel.close();
      } catch {
        // ignore
      }
      removeUpstream();
      try {
        upstream.end();
      } catch {
        // ignore
      }
    });

    guestChannel.on("data", (data: Buffer) => {
      upstreamChannel!.write(data);
    });

    guestChannel.on("eof", () => {
      upstreamChannel!.end();
    });

    guestChannel.on("close", () => {
      upstreamChannel!.close();
    });

    guestChannel.on("signal", (signalName: string) => {
      try {
        upstreamChannel!.signal(signalName);
      } catch {
        // ignore
      }
    });

    upstreamChannel.on("error", (err: Error) => {
      this.abortTcpSession(key, session, `ssh-upstream-channel-error (${formatError(err)})`);
    });

    upstream.on("error", (err: Error) => {
      this.abortTcpSession(key, session, `ssh-upstream-error (${formatError(err)})`);
    });
  }

  private handleSshProxyData(key: string, session: TcpSession, data: Buffer) {
    try {
      const proxy = this.ensureSshProxySession(key, session);
      proxy.stream.pushFromGuest(data);
    } catch (err) {
      this.abortTcpSession(key, session, `ssh-proxy-init-error (${formatError(err)})`);
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
      this.closeSshProxySession(session.sshProxy);
      this.tcpSessions.delete(key);
    });

    socket.on("error", () => {
      this.stack?.handleTcpError({ key });
      this.resolveFlowResume(key);
      this.closeSshProxySession(session.sshProxy);
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
      this.handleTlsHttpData(key, session, Buffer.from(data));
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

  private async handlePlainHttpData(key: string, session: TcpSession, data: Buffer) {
    return httpImpl.handlePlainHttpData.call(this, key, session, data);
  }

  private async handleTlsHttpData(key: string, session: TcpSession, data: Buffer) {
    return httpImpl.handleTlsHttpData.call(this, key, session, data);
  }

  private handleTlsData(key: string, session: TcpSession, data: Buffer) {
    const tlsSession = this.ensureTlsSession(key, session);
    if (!tlsSession) return;
    tlsSession.stream.pushEncrypted(data);
  }

  private closeSharedDispatchers() {
    return httpImpl.closeSharedDispatchers.call(this);
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
      const oldestKey = this.tlsContexts.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.tlsContexts.delete(oldestKey);
    }
  }

  private async getTlsContextAsync(servername: string): Promise<tls.SecureContext> {
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

function caCertVerifiesLeaf(caCert: forge.pki.Certificate, leafCert: forge.pki.Certificate): boolean {
  try {
    return caCert.verify(leafCert);
  } catch {
    return false;
  }
}

function privateKeyMatchesLeafCert(keyPem: string, leafCert: forge.pki.Certificate): boolean {
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

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function normalizeHostnamePattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}

function matchHostname(hostname: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === "*") return true;

  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(hostname);
}

/** @internal */
// Expose internal helpers for unit tests. Not part of the public API.
export const __test = {
  createLookupGuard: httpImpl.createLookupGuard,
  normalizeLookupEntries: httpImpl.normalizeLookupEntries,
  normalizeLookupOptions: httpImpl.normalizeLookupOptions,
  normalizeLookupFailure: httpImpl.normalizeLookupFailure,
  getRedirectUrl: httpImpl.getRedirectUrl,
  applyRedirectRequest: httpImpl.applyRedirectRequest,
  MAX_HTTP_PIPELINE_BYTES: httpImpl.MAX_HTTP_PIPELINE_BYTES,
};

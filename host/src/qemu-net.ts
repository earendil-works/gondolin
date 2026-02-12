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

const MAX_HTTP_REDIRECTS = 10;
const MAX_HTTP_HEADER_BYTES = 64 * 1024;
const MAX_HTTP_PIPELINE_BYTES = 64 * 1024;
// Chunked framing (chunk-size lines + trailers) can add overhead on top of the decoded body.
// Keep this bounded separately from maxHttpBodyBytes.
const MAX_HTTP_CHUNKED_OVERHEAD_BYTES = 256 * 1024;

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
const DEFAULT_SHARED_UPSTREAM_CONNECTIONS_PER_ORIGIN = 16;
const DEFAULT_SHARED_UPSTREAM_MAX_ORIGINS = 512;
const DEFAULT_SHARED_UPSTREAM_IDLE_TTL_MS = 30 * 1000;

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

function normalizeSshCredentials(credentials?: Record<string, SshCredential>): ResolvedSshCredential[] {
  const entries: ResolvedSshCredential[] = [];
  for (const [pattern, credential] of Object.entries(credentials ?? {})) {
    const normalizedPattern = normalizeHostnamePattern(pattern);
    if (!normalizedPattern) continue;
    entries.push({
      pattern: normalizedPattern,
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

function hostMatchesOpenSshKnownHostsList(hostname: string, patterns: string[]): boolean {
  const candidates = [hostname, `[${hostname}]:22`];

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
): (hostname: string, key: Buffer) => boolean {
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

  return (hostname: string, key: Buffer) => {
    const host = hostname.trim().toLowerCase();
    if (!host) return false;

    for (const entry of entries) {
      if (!hostMatchesOpenSshKnownHostsList(host, entry.hostPatterns)) {
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

  /** destination ip as seen by the guest */
  dstIP: string;
  /** destination port as seen by the guest */
  dstPort: number;

  /** upstream destination ip used by the host (dns mode dependent) */
  upstreamIP: string;
  /** upstream destination port used by the host */
  upstreamPort: number;
};

type HttpRequestData = {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  body: Buffer;
};

class HttpReceiveBuffer {
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
    startOffset: number
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

  private commitState(state: { chunkIndex: number; chunkOffset: number; offset: number }) {
    this.chunkIndex = state.chunkIndex;
    this.chunkOffset = state.chunkOffset;
    this.offset = state.offset;
  }

  private readByteFrom(state: { chunkIndex: number; chunkOffset: number; offset: number }) {
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
      const slice = firstChunk.subarray(state.chunkOffset, state.chunkOffset + n);
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

type HttpSession = {
  buffer: HttpReceiveBuffer;
  processing: boolean;
  closed: boolean;
  /** whether we already sent an interim 100-continue response */
  sentContinue?: boolean;
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

type WebSocketState = {
  /** current websocket state */
  phase: "handshake" | "open";
  /** connected upstream socket (null until connected) */
  upstream: net.Socket | null;
  /** buffered guest->upstream bytes while the upstream socket is not yet connected */
  pending: Buffer[];
  /** bytes currently queued in `pending` in `bytes` */
  pendingBytes: number;
};

type ResolvedSshCredential = {
  /** matched host pattern */
  pattern: string;
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

export type SshOptions = {
  /** allowed ssh host patterns */
  allowedHosts: string[];
  /** host pattern -> upstream private-key credential */
  credentials?: Record<string, SshCredential>;
  /** ssh-agent socket path (e.g. $SSH_AUTH_SOCK) */
  agent?: string;
  /** OpenSSH known_hosts file path(s) used for default host key verification when `hostVerifier` is not set */
  knownHostsFile?: string | string[];
  /** guest-facing ssh host key */
  hostKey?: string | Buffer;
  /** upstream host key verifier callback (required when `allowedHosts` is non-empty unless `knownHostsFile`/default known_hosts is used) */
  hostVerifier?: (hostname: string, key: Buffer) => boolean;
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
  /** allow/deny callback for request content */
  isRequestAllowed?: (request: HttpHookRequest) => Promise<boolean> | boolean;
  /** allow/deny callback for resolved destination ip */
  isIpAllowed?: (info: HttpIpAllowInfo) => Promise<boolean> | boolean;
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
  private readonly sshAllowedHosts: string[];
  private readonly sshCredentials: ResolvedSshCredential[];
  private readonly sshAgent: string | null;
  private sshHostKey: string | null;
  private readonly sshHostVerifier: ((hostname: string, key: Buffer) => boolean) | null;

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

    this.sshAllowedHosts = uniqueHostPatterns(options.ssh?.allowedHosts ?? []);
    this.sshCredentials = normalizeSshCredentials(options.ssh?.credentials);
    this.sshAgent = options.ssh?.agent ?? null;
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
      this.sshAllowedHosts.length > 0 &&
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

    this.syntheticDnsHostMapping =
      options.dns?.syntheticHostMapping ??
      (this.sshAllowedHosts.length > 0 ? "per-host" : DEFAULT_SYNTHETIC_DNS_HOST_MAPPING);
    this.syntheticDnsHostMap =
      this.syntheticDnsHostMapping === "per-host" ? new SyntheticDnsHostMap() : null;

    if (this.sshAllowedHosts.length > 0 && this.dnsMode !== "synthetic") {
      throw new Error("ssh egress requires dns mode 'synthetic'");
    }
    if (this.sshAllowedHosts.length > 0 && this.syntheticDnsHostMapping !== "per-host") {
      throw new Error("ssh egress requires dns syntheticHostMapping='per-host'");
    }
    if (this.sshAllowedHosts.length > 0 && this.sshCredentials.length === 0 && !this.sshAgent) {
      throw new Error("ssh egress requires at least one credential or ssh agent (direct ssh is not supported)");
    }
    if (this.sshAllowedHosts.length > 0 && !this.sshHostVerifier) {
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

  private resolveSshCredential(hostname: string): ResolvedSshCredential | null {
    for (const credential of this.sshCredentials) {
      if (matchHostname(hostname, credential.pattern)) {
        return credential;
      }
    }
    return null;
  }

  private isSshFlowAllowed(key: string, dstIP: string, dstPort: number): boolean {
    if (dstPort !== 22) return false;
    if (this.sshAllowedHosts.length === 0) return false;

    const session = this.tcpSessions.get(key);
    const hostname = session?.syntheticHostname ?? this.syntheticDnsHostMap?.lookupHostByIp(dstIP) ?? null;
    if (!hostname) return false;
    if (!matchesAnyHost(hostname, this.sshAllowedHosts)) return false;

    const credential = this.resolveSshCredential(hostname);
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

    if (syntheticHostname && message.dstPort === 22) {
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
      this.emitDebug(`ssh proxy start ${session.srcIP}:${session.srcPort} -> ${session.syntheticHostname}:22`);
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

    const upstream = new SshClient();
    proxy.upstreams.add(upstream);

    const removeUpstream = () => {
      proxy.upstreams.delete(upstream);
    };

    // Ensure we don't retain references if the client closes unexpectedly.
    upstream.once("close", removeUpstream);

    const connectConfig: import("ssh2").ConnectConfig = {
      host: hostname,
      port: 22,
      username: credential ? (credential.username ?? "git") : guestUsername || "git",
    };

    if (credential) {
      connectConfig.privateKey = credential.privateKey;
      connectConfig.passphrase = credential.passphrase;
    } else if (this.sshAgent) {
      connectConfig.agent = this.sshAgent;
    }

    if (this.sshHostVerifier) {
      connectConfig.hostVerifier = (key: Buffer) => this.sshHostVerifier!(hostname, key);
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
    if (session.ws) {
      this.handleWebSocketClientData(key, session, data);
      return;
    }

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

    if (session.ws) {
      this.handleWebSocketClientData(key, session, data);
      return;
    }

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

  private abortWebSocketSession(key: string, session: TcpSession, reason: string) {
    if (this.options.debug) {
      this.emitDebug(
        `websocket session aborted ${session.srcIP}:${session.srcPort} -> ${session.dstIP}:${session.dstPort} reason=${reason}`
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
    this.abortTcpSession(key, session, reason);
  }

  private handleWebSocketClientData(key: string, session: TcpSession, data: Buffer) {
    const ws = session.ws;
    if (!ws) return;
    if (data.length === 0) return;

    const upstream = ws.upstream;

    if (upstream && upstream.writable) {
      const nextWritable = upstream.writableLength + data.length;
      if (nextWritable > this.maxTcpPendingWriteBytes) {
        this.abortWebSocketSession(
          key,
          session,
          `socket-write-buffer-exceeded (${nextWritable} > ${this.maxTcpPendingWriteBytes})`
        );
        return;
      }

      upstream.write(data);
      return;
    }

    // Handshake in progress (or upstream not yet connected): buffer until we have an upstream.
    const nextBytes = ws.pendingBytes + data.length;
    if (nextBytes > this.maxTcpPendingWriteBytes) {
      this.abortWebSocketSession(
        key,
        session,
        `pending-write-buffer-exceeded (${nextBytes} > ${this.maxTcpPendingWriteBytes})`
      );
      return;
    }

    ws.pending.push(data);
    ws.pendingBytes = nextBytes;
  }

  private maybeSend100ContinueFromHead(
    httpSession: HttpSession,
    head: { version: string; headers: Record<string, string>; bodyOffset: number },
    bufferedBodyBytes: number,
    write: (chunk: Buffer) => void
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

  private async handleHttpDataWithWriter(
    key: string,
    session: TcpSession,
    data: Buffer,
    options: { scheme: "http" | "https"; write: (chunk: Buffer) => void; finish: () => void }
  ) {
    const httpSession = session.http ?? {
      buffer: new HttpReceiveBuffer(),
      processing: false,
      closed: false,
      sentContinue: false,
    };
    session.http = httpSession;

    if (httpSession.closed) return;

    httpSession.buffer.append(data);
    if (httpSession.processing) return;

    let parsed: { request: HttpRequestData; remaining: Buffer } | null = null;
    try {
      const headerEnd = httpSession.buffer.findHeaderEnd(MAX_HTTP_HEADER_BYTES + 4);
      if (headerEnd === -1) {
        // No header terminator yet.
        if (httpSession.buffer.length > MAX_HTTP_HEADER_BYTES) {
          throw new HttpRequestBlockedError(
            `request headers exceed ${MAX_HTTP_HEADER_BYTES} bytes`,
            431,
            "Request Header Fields Too Large"
          );
        }
        return;
      }

      if (headerEnd > MAX_HTTP_HEADER_BYTES) {
        throw new HttpRequestBlockedError(
          `request headers exceed ${MAX_HTTP_HEADER_BYTES} bytes`,
          431,
          "Request Header Fields Too Large"
        );
      }

      // Parse headers using only the header region (avoid concatenating the full buffer).
      const headBuf = httpSession.buffer.prefix(headerEnd + 4);
      const head = this.parseHttpHead(headBuf);
      if (!head) return;

      const bufferedBodyBytes = Math.max(0, httpSession.buffer.length - head.bodyOffset);

      // Validate Expect early so we don't send 100-continue for requests we must reject.
      this.validateExpectHeader(head.version, head.headers);

      const transferEncodingHeader = head.headers["transfer-encoding"];
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

        // Enforce a strict cap on the raw buffered request bytes.
        const maxBuffered =
          head.bodyOffset +
          this.maxHttpBodyBytes +
          MAX_HTTP_CHUNKED_OVERHEAD_BYTES +
          MAX_HTTP_PIPELINE_BYTES;
        if (httpSession.buffer.length > maxBuffered) {
          throw new HttpRequestBlockedError(
            `request body exceeds ${this.maxHttpBodyBytes} bytes`,
            413,
            "Payload Too Large"
          );
        }

        const chunked = this.decodeChunkedBodyFromReceiveBuffer(
          httpSession.buffer,
          head.bodyOffset,
          this.maxHttpBodyBytes
        );
        if (!chunked.complete) {
          this.maybeSend100ContinueFromHead(httpSession, head, bufferedBodyBytes, options.write);
          return;
        }

        const sanitizedHeaders = { ...head.headers };
        delete sanitizedHeaders["transfer-encoding"];
        delete sanitizedHeaders["content-length"];
        sanitizedHeaders["content-length"] = chunked.body.length.toString();

        const remainingStart = head.bodyOffset + chunked.bytesConsumed;

        // Now that we know the exact end of the chunked body, strictly enforce how many
        // bytes we allow to be buffered past the chunked terminator.
        if (httpSession.buffer.length - remainingStart > MAX_HTTP_PIPELINE_BYTES) {
          throw new HttpRequestBlockedError(
            `request pipeline exceeds ${MAX_HTTP_PIPELINE_BYTES} bytes`,
            413,
            "Payload Too Large"
          );
        }

        parsed = {
          request: {
            method: head.method,
            target: head.target,
            version: head.version,
            headers: sanitizedHeaders,
            body: chunked.body,
          },
          remaining: httpSession.buffer.suffix(remainingStart),
        };
      } else {
        const contentLengthRaw = head.headers["content-length"];
        let contentLength = 0;
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

        if (Number.isFinite(this.maxHttpBodyBytes) && contentLength > this.maxHttpBodyBytes) {
          throw new HttpRequestBlockedError(
            `request body exceeds ${this.maxHttpBodyBytes} bytes`,
            413,
            "Payload Too Large"
          );
        }

        const maxBuffered = head.bodyOffset + contentLength + MAX_HTTP_PIPELINE_BYTES;
        if (httpSession.buffer.length > maxBuffered) {
          throw new HttpRequestBlockedError(
            `request exceeds ${contentLength} bytes`,
            413,
            "Payload Too Large"
          );
        }

        // If we know exactly how much body to expect, avoid attempting parse until complete.
        if (bufferedBodyBytes < contentLength) {
          this.maybeSend100ContinueFromHead(httpSession, head, bufferedBodyBytes, options.write);
          return;
        }

        this.maybeSend100ContinueFromHead(httpSession, head, bufferedBodyBytes, options.write);

        const fullBuffer = httpSession.buffer.toBuffer();
        const result = this.parseHttpRequest(fullBuffer);
        parsed = result
          ? {
              request: result.request,
              remaining: Buffer.from(result.remaining),
            }
          : null;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error instanceof HttpRequestBlockedError) {
        if (this.options.debug) {
          this.emitDebug(`http blocked ${error.message}`);
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

    const httpVersion: "HTTP/1.0" | "HTTP/1.1" =
      parsed.request.version === "HTTP/1.0" ? "HTTP/1.0" : "HTTP/1.1";

    httpSession.processing = true;
    httpSession.buffer.resetTo(parsed.remaining);

    let keepOpen = false;
    let releaseHttpConcurrency: (() => void) | null = null;

    try {
      if (this.allowWebSockets && this.isWebSocketUpgradeRequest(parsed.request)) {
        // Prevent further HTTP parsing on this TCP session; upgraded connections become opaque tunnels.
        httpSession.closed = true;

        // Initialize websocket state early so any subsequent guest bytes are buffered/forwarded
        // as websocket frames rather than being parsed as HTTP.
        session.ws = session.ws ?? {
          phase: "handshake",
          upstream: null,
          pending: [],
          pendingBytes: 0,
        };

        // Anything already buffered after the request head is treated as early websocket data.
        const early = httpSession.buffer.toBuffer();
        httpSession.buffer.resetTo(Buffer.alloc(0));
        if (early.length > 0) {
          this.handleWebSocketClientData(key, session, early);
        }

        keepOpen = await this.handleWebSocketUpgrade(key, parsed.request, session, options, httpVersion);
        return;
      }

      releaseHttpConcurrency = await this.httpConcurrency.acquire();
      await this.fetchAndRespond(parsed.request, options.scheme, options.write);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (error instanceof HttpRequestBlockedError) {
        if (this.options.debug) {
          this.emitDebug(`http blocked ${error.message}`);
        }
        this.respondWithError(options.write, error.status, error.statusText, httpVersion);
      } else {
        this.emit("error", error);
        this.respondWithError(options.write, 502, "Bad Gateway", httpVersion);
      }

      // Failed websocket upgrades should not leave the session in websocket mode.
      if (session.ws) {
        session.ws = undefined;
        if (session.socket) {
          try {
            session.socket.destroy();
          } catch {
            // ignore
          }
          session.socket = null;
          session.connected = false;
        }
      }
    } finally {
      releaseHttpConcurrency?.();
      httpSession.processing = false;

      if (!keepOpen) {
        httpSession.closed = true;
        options.finish();
        this.flush();
      }
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

  private validateExpectHeader(version: string, headers: Record<string, string>) {
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
        "Expectation Failed"
      );
    }
  }

  private parseHttpRequest(buffer: Buffer): { request: HttpRequestData; remaining: Buffer } | null {
    const head = this.parseHttpHead(buffer);
    if (!head) return null;

    const { method, target, version, headers, bodyOffset } = head;

    this.validateExpectHeader(version, headers);

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

  private decodeChunkedBodyFromReceiveBuffer(
    receiveBuffer: HttpReceiveBuffer,
    bodyOffset: number,
    maxBodyBytes: number
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
          "Payload Too Large"
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
          return {
            complete: true,
            body: Buffer.concat(chunks, totalBytes),
            bytesConsumed: chunkStart + 2,
          };
        }

        const trailerEnd = buffer.indexOf("\r\n\r\n", chunkStart);
        if (trailerEnd === -1) {
          return { complete: false, body: Buffer.alloc(0), bytesConsumed: 0 };
        }

        return {
          complete: true,
          body: Buffer.concat(chunks, totalBytes),
          bytesConsumed: trailerEnd + 4,
        };
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
      this.emitDebug(`http bridge ${request.method} ${url}`);
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

      const requestLabel = `${currentRequest.method} ${currentUrl.toString()}`;
      const responseStart = Date.now();

      await this.ensureRequestAllowed(currentRequest);
      await this.ensureIpAllowed(currentUrl, protocol, port);

      const useDefaultFetch = this.options.fetch === undefined;
      // The shared dispatcher re-checks IP policy whenever it opens
      // new upstream connections.
      const dispatcher = useDefaultFetch
        ? this.getCheckedDispatcher({
            hostname: currentUrl.hostname,
            port,
            protocol,
          })
        : null;

      let response: FetchResponse;
      try {
        response = await fetcher(currentUrl.toString(), {
          method: currentRequest.method,
          headers: currentRequest.headers,
          body: currentRequest.body ? new Uint8Array(currentRequest.body) : undefined,
          redirect: "manual",
          ...(dispatcher ? { dispatcher } : {}),
        });
      } catch (err) {
        if (this.options.debug) {
          const message = err instanceof Error ? err.message : String(err);
          this.emitDebug(`http bridge fetch failed ${currentRequest.method} ${currentUrl.toString()} (${message})`);
        }
        throw err;
      }

      const redirectUrl = getRedirectUrl(response, currentUrl);
        if (redirectUrl) {
          if (response.body) {
            await response.body.cancel();
          }

          if (redirectCount >= MAX_HTTP_REDIRECTS) {
            throw new HttpRequestBlockedError("too many redirects", 508, "Loop Detected");
          }

          pendingRequest = applyRedirectRequest(
            currentRequest,
            response.status,
            currentUrl,
            redirectUrl
          );
          continue;
        }

        if (this.options.debug) {
          this.emitDebug(`http bridge response ${response.status} ${response.statusText}`);
        }

        let responseHeaders = this.stripHopByHopHeaders(this.headersToRecord(response.headers));
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
          let streamedBytes = 0;

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
              streamedBytes = await this.sendChunkedBody(responseBodyStream, write);
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
              streamedBytes = await this.sendStreamBody(responseBodyStream, write);
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
            streamedBytes = await this.sendStreamBody(responseBodyStream, write);
          }

          if (this.options.debug) {
            const elapsed = Date.now() - responseStart;
            this.emitDebug(`http bridge body complete ${requestLabel} ${streamedBytes} bytes in ${elapsed}ms`);
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
        if (this.options.debug) {
          const elapsed = Date.now() - responseStart;
          this.emitDebug(`http bridge body complete ${requestLabel} ${hookResponse.body.length} bytes in ${elapsed}ms`);
        }
        return;
    }

  }

  private isWebSocketUpgradeRequest(request: HttpRequestData): boolean {
    const upgrade = request.headers["upgrade"]?.toLowerCase() ?? "";
    if (upgrade === "websocket") return true;

    // Some clients omit Upgrade/Connection but include the WebSocket-specific headers.
    if (request.headers["sec-websocket-key"] || request.headers["sec-websocket-version"]) return true;

    return false;
  }

  private stripHopByHopHeadersForWebSocket(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = { ...headers };

    // Unlike normal HTTP proxying, WebSocket handshakes require forwarding Connection/Upgrade.
    // Still strip proxy-only and framing hop-by-hop headers.
    delete out["keep-alive"];
    delete out["proxy-connection"];
    delete out["proxy-authenticate"];
    delete out["proxy-authorization"];

    // No request bodies for WebSocket handshake.
    delete out["content-length"];
    delete out["transfer-encoding"];
    delete out["expect"];

    // Avoid forwarding framed/trailer-related hop-by-hop headers.
    delete out["te"];
    delete out["trailer"];

    // Apply Connection: token stripping, but keep Upgrade + WebSocket-specific headers.
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

  private async handleWebSocketUpgrade(
    key: string,
    request: HttpRequestData,
    session: TcpSession,
    options: { scheme: "http" | "https"; write: (chunk: Buffer) => void; finish: () => void },
    httpVersion: "HTTP/1.0" | "HTTP/1.1"
  ): Promise<boolean> {
    if (request.version !== "HTTP/1.1") {
      throw new HttpRequestBlockedError("websocket upgrade requires HTTP/1.1", 501, "Not Implemented");
    }

    // WebSocket upgrades are always GET without a body.
    if (request.method.toUpperCase() !== "GET") {
      throw new HttpRequestBlockedError("websocket upgrade requires GET", 400, "Bad Request");
    }
    if (request.body.length > 0) {
      throw new HttpRequestBlockedError("websocket upgrade requests must not have a body", 400, "Bad Request");
    }

    const url = this.buildFetchUrl(request, options.scheme);
    if (!url) {
      throw new HttpRequestBlockedError("missing host", 400, "Bad Request");
    }

    let hookRequest: HttpHookRequest = {
      method: "GET",
      url,
      headers: this.stripHopByHopHeadersForWebSocket(request.headers),
      body: null,
    };

    hookRequest = await this.applyRequestHooks(hookRequest);

    const method = (hookRequest.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      throw new HttpRequestBlockedError("websocket upgrade requires GET", 400, "Bad Request");
    }

    if (hookRequest.body && hookRequest.body.length > 0) {
      throw new HttpRequestBlockedError("websocket upgrade requests must not have a body", 400, "Bad Request");
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(hookRequest.url);
    } catch {
      throw new HttpRequestBlockedError("invalid url", 400, "Bad Request");
    }

    const protocol = getUrlProtocol(parsedUrl);
    if (!protocol) {
      throw new HttpRequestBlockedError("unsupported protocol", 400, "Bad Request");
    }

    const port = getUrlPort(parsedUrl, protocol);
    if (!Number.isFinite(port) || port <= 0) {
      throw new HttpRequestBlockedError("invalid port", 400, "Bad Request");
    }

    // Resolve all A/AAAA records and pick the first IP allowed by policy.
    // This pins the websocket tunnel to an allowed address and avoids rejecting
    // a hostname just because the first DNS answer is blocked.
    const { address } = await this.resolveHostname(parsedUrl.hostname, { protocol, port });

    const ws = session.ws;
    if (!ws) {
      throw new Error("internal error: websocket state missing");
    }

    const upstream = await this.connectWebSocketUpstream({
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
      this.flush();
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
    const resp = await this.readUpstreamHttpResponseHead(upstream);

    let responseHeaders: HttpResponseHeaders = resp.headers;

    let hookResponse: HttpHookResponse = {
      status: resp.statusCode,
      statusText: resp.statusMessage || "OK",
      headers: responseHeaders,
      body: Buffer.alloc(0),
    };

    if (this.options.httpHooks?.onResponse) {
      const updated = await this.options.httpHooks.onResponse(hookResponse, hookRequest);
      if (updated) hookResponse = updated;
    }

    // If the hook injected a body, send it as a normal HTTP response and do not upgrade.
    if (hookResponse.body.length > 0) {
      const headers = { ...hookResponse.headers };
      delete headers["transfer-encoding"];
      headers["content-length"] = String(hookResponse.body.length);
      this.sendHttpResponse(guestWrite, { ...hookResponse, headers }, httpVersion);
      finishOnce();
      upstream.destroy();
      session.ws = undefined;
      return false;
    }

    this.sendHttpResponseHead(guestWrite, hookResponse, httpVersion);

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

    upstream.on("data", (chunk) => {
      guestWrite(Buffer.from(chunk));
    });

    upstream.on("end", () => {
      finishOnce();
    });

    upstream.on("error", (err) => {
      this.emit("error", err);
      this.abortWebSocketSession(key, session, "upstream-error");
    });

    upstream.on("close", () => {
      session.ws = undefined;

      // Some upstreams emit "close" without a prior "end".
      finishOnce();

      // For plain HTTP flows, closing the upstream socket should also close the guest TCP session.
      // For TLS flows, closing the guest TLS socket triggers stack.handleTcpClosed.
      if (options.scheme === "http") {
        // If the session was already aborted/removed, do not emit a second close.
        if (!this.tcpSessions.has(key)) return;
        this.stack?.handleTcpClosed({ key });
        this.resolveFlowResume(key);
        this.tcpSessions.delete(key);
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

  private async connectWebSocketUpstream(info: {
    protocol: "http" | "https";
    hostname: string;
    address: string;
    port: number;
  }): Promise<net.Socket> {
    const timeoutMs = this.webSocketUpstreamConnectTimeoutMs;

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
            const err = new Error(`websocket upstream connect timeout after ${timeoutMs}ms`);
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
          const err = new Error(`websocket upstream connect timeout after ${timeoutMs}ms`);
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

  private async readUpstreamHttpResponseHead(socket: net.Socket): Promise<{
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string | string[]>;
    rest: Buffer;
  }> {
    let buf = Buffer.alloc(0);

    return await new Promise((resolve, reject) => {
      const timeoutMs = this.webSocketUpstreamHeaderTimeoutMs;
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
          settleReject(new Error(`invalid http status line: ${JSON.stringify(statusLine)}`));
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
          settleReject(new Error(`websocket upstream header timeout after ${timeoutMs}ms`));
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

  private sendHttpResponseHead(
    write: (chunk: Buffer) => void,
    response: { status: number; statusText: string; headers: HttpResponseHeaders },
    httpVersion: "HTTP/1.0" | "HTTP/1.1" = "HTTP/1.1"
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

  private async sendChunkedBody(body: WebReadableStream<Uint8Array>, write: (chunk: Buffer) => void): Promise<number> {
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
      }
    } finally {
      reader.releaseLock();
    }

    write(Buffer.from("0\r\n\r\n"));
    return total;
  }

  private async sendStreamBody(body: WebReadableStream<Uint8Array>, write: (chunk: Buffer) => void): Promise<number> {
    const reader = body.getReader();
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        total += value.length;
        write(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return total;
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

  private async resolveHostname(
    hostname: string,
    policy?: { protocol: "http" | "https"; port: number }
  ): Promise<{ address: string; family: 4 | 6 }> {
    const ipFamily = net.isIP(hostname);

    const entries: LookupEntry[] =
      ipFamily === 4 || ipFamily === 6
        ? [{ address: hostname, family: ipFamily }]
        : normalizeLookupEntries(
            // Use all addresses so policy checks can pick the first allowed entry.
            await new Promise<dns.LookupAddress[]>((resolve, reject) => {
              const lookup = this.options.dnsLookup ?? dns.lookup.bind(dns);
              lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
                if (err) reject(err);
                else resolve(addresses as dns.LookupAddress[]);
              });
            })
          );

    if (entries.length === 0) {
      throw new Error("DNS lookup returned no addresses");
    }

    const isIpAllowed = this.options.httpHooks?.isIpAllowed;
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
      });
      if (allowed) {
        return { address: entry.address, family: entry.family };
      }
    }

    throw new HttpRequestBlockedError(`blocked by policy: ${hostname}`);
  }

  private async ensureRequestAllowed(request: HttpHookRequest) {
    if (!this.options.httpHooks?.isRequestAllowed) return;
    const allowed = await this.options.httpHooks.isRequestAllowed(request);
    if (!allowed) {
      throw new HttpRequestBlockedError("blocked by request policy");
    }
  }

  private async ensureIpAllowed(parsedUrl: URL, protocol: "http" | "https", port: number) {
    if (!this.options.httpHooks?.isIpAllowed) return;

    // Resolve all A/AAAA records and ensure at least one address is permitted.
    // When using the default fetch, the guarded undici lookup will additionally
    // pin the actual connect to an allowed IP.
    await this.resolveHostname(parsedUrl.hostname, { protocol, port });
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

  private closeSharedDispatchers() {
    for (const entry of this.sharedDispatchers.values()) {
      try {
        entry.dispatcher.close();
      } catch {
        // ignore
      }
    }
    this.sharedDispatchers.clear();
  }

  private pruneSharedDispatchers(now = Date.now()) {
    if (this.sharedDispatchers.size === 0) return;

    for (const [key, entry] of this.sharedDispatchers) {
      if (now - entry.lastUsedAt <= DEFAULT_SHARED_UPSTREAM_IDLE_TTL_MS) continue;
      this.sharedDispatchers.delete(key);
      try {
        entry.dispatcher.close();
      } catch {
        // ignore
      }
    }
  }

  private evictSharedDispatchersIfNeeded() {
    while (this.sharedDispatchers.size > DEFAULT_SHARED_UPSTREAM_MAX_ORIGINS) {
      const oldestKey = this.sharedDispatchers.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.sharedDispatchers.get(oldestKey);
      this.sharedDispatchers.delete(oldestKey);
      try {
        oldest?.dispatcher.close();
      } catch {
        // ignore
      }
    }
  }

  private getCheckedDispatcher(info: {
    hostname: string;
    port: number;
    protocol: "http" | "https";
  }): Agent | null {
    const isIpAllowed = this.options.httpHooks?.isIpAllowed;
    if (!isIpAllowed) return null;

    this.pruneSharedDispatchers();

    const key = `${info.protocol}://${info.hostname}:${info.port}`;
    const cached = this.sharedDispatchers.get(key);
    if (cached) {
      cached.lastUsedAt = Date.now();
      // LRU: move to map tail.
      this.sharedDispatchers.delete(key);
      this.sharedDispatchers.set(key, cached);
      return cached.dispatcher;
    }

    const lookupFn = createLookupGuard(
      {
        hostname: info.hostname,
        port: info.port,
        protocol: info.protocol,
      },
      isIpAllowed
    );

    const dispatcher = new Agent({
      connect: { lookup: lookupFn },
      connections: DEFAULT_SHARED_UPSTREAM_CONNECTIONS_PER_ORIGIN,
    });

    this.sharedDispatchers.set(key, {
      dispatcher,
      lastUsedAt: Date.now(),
    });
    this.evictSharedDispatchersIfNeeded();

    return dispatcher;
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

  private stripHopByHopHeaders(headers: Record<string, string>): Record<string, string>;
  private stripHopByHopHeaders(headers: HttpResponseHeaders): HttpResponseHeaders;
  private stripHopByHopHeaders(headers: Record<string, HeaderValue>): any {
    const connectionValue = headers["connection"];
    const connection = Array.isArray(connectionValue)
      ? connectionValue.join(",")
      : connectionValue ?? "";

    const connectionTokens = new Set<string>();
    if (connection) {
      for (const token of connection.split(",")) {
        const normalized = token.trim().toLowerCase();
        if (normalized) connectionTokens.add(normalized);
      }
    }

    const output: Record<string, HeaderValue> = {};
    for (const [name, value] of Object.entries(headers)) {
      const normalizedName = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(normalizedName)) continue;
      if (connectionTokens.has(normalizedName)) continue;
      output[normalizedName] = value;
    }
    return output;
  }

  private headersToRecord(headers: Headers): HttpResponseHeaders {
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
  info: {
    hostname: string;
    port: number;
    protocol: "http" | "https";
  },
  isIpAllowed: NonNullable<HttpHooks["isIpAllowed"]>,
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
          const allowed = await isIpAllowed({
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
  sourceUrl: URL,
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

  if (!isSameOrigin(sourceUrl, redirectUrl)) {
    // Do not forward credentials across origins.
    // This matches browser/fetch redirect behavior and avoids leaking registry
    // Bearer tokens into object-storage signed URLs.
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

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function uniqueHostPatterns(patterns: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of patterns) {
    const normalized = normalizeHostnamePattern(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeHostnamePattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}

function matchesAnyHost(hostname: string, patterns: string[]): boolean {
  const normalized = hostname.toLowerCase();
  return patterns.some((pattern) => matchHostname(normalized, pattern));
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

/** @internal */
// Expose internal helpers for unit tests. Not part of the public API.
export const __test = {
  createLookupGuard,
  normalizeLookupEntries,
  normalizeLookupOptions,
  normalizeLookupFailure,
  getRedirectUrl,
  applyRedirectRequest,
  MAX_HTTP_PIPELINE_BYTES,
};

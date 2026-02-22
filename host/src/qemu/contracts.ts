import type dns from "dns";
import type net from "net";
import type tls from "tls";
import type { Agent, fetch as undiciFetch } from "undici";

export type HttpFetch = typeof undiciFetch;

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

export type HttpHooks = {
  /** allow/deny callback for request content (request body is always `null`) */
  isRequestAllowed?: (request: Request) => Promise<boolean> | boolean;
  /** allow/deny callback for resolved destination ip */
  isIpAllowed?: (info: HttpIpAllowInfo) => Promise<boolean> | boolean;

  /** request hook for request head (may rewrite request or short-circuit with response) */
  onRequestHead?: (
    request: Request,
  ) => Promise<Request | Response | void> | Request | Response | void;

  /** request hook for buffered requests (may rewrite request or short-circuit with response) */
  onRequest?: (
    request: Request,
  ) => Promise<Request | Response | void> | Request | Response | void;

  /** response rewrite hook */
  onResponse?: (
    response: Response,
    request: Request,
  ) => Promise<Response | void> | Response | void;
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

export type SharedDispatcherEntry = {
  dispatcher: Agent;
  lastUsedAt: number;
};

export type QemuHttpInternalsLike = {
  maxHttpBodyBytes: number;
  maxHttpResponseBodyBytes: number;
  allowWebSockets: boolean;
  webSocketUpstreamConnectTimeoutMs: number;
  webSocketUpstreamHeaderTimeoutMs: number;
  httpConcurrency: {
    acquire(): Promise<() => void>;
  };
  sharedDispatchers: Map<string, SharedDispatcherEntry>;
  qemuRxPausedForHttpStreaming: boolean;
};

export type NetworkStackLike = {
  handleTcpData(message: { key: string; data: Buffer }): void;
  handleTcpEnd(message: { key: string }): void;
  handleTcpClosed(message: { key: string }): void;
};

export type TcpSession = {
  socket: net.Socket | null;
  srcIP: string;
  srcPort: number;
  dstIP: string;
  dstPort: number;
  connectIP: string;
  syntheticHostname: string | null;
  flowControlPaused: boolean;
  connected: boolean;
  pendingWrites: Buffer[];
  pendingWriteBytes: number;
  protocol: string | null;
  http?: any;
  tls?: {
    socket: tls.TLSSocket;
  };
  ws?: any;
  ssh?: any;
};

export type QemuNetworkBackend<
  TSession extends TcpSession = TcpSession,
  TSsh = unknown,
> = {
  options: {
    debug?: boolean;
    fetch?: HttpFetch;
    httpHooks?: HttpHooks;
    dnsLookup?: (
      hostname: string,
      options: dns.LookupAllOptions,
      callback: (
        err: NodeJS.ErrnoException | null,
        addresses: dns.LookupAddress[],
      ) => void,
    ) => void;
  };
  socket: net.Socket | null;
  stack: NetworkStackLike | null;
  tcpSessions: Map<string, TSession>;
  maxTcpPendingWriteBytes: number;
  http: QemuHttpInternalsLike;
  ssh: TSsh;
  emitDebug(message: string): void;
  emit(event: string | symbol, ...args: any[]): boolean;
  flush(): void;
  waitForFlowResume(key: string): Promise<void>;
  resolveFlowResume(key: string): void;
  abortTcpSession(key: string, session: TSession, reason: string): void;
};

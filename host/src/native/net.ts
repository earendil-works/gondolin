/**
 * Native engine networking: compiles `httpHooks` and network options into the
 * `configure.net` message and serves tier-3 hook calls (`hook_call`) from
 * gondolind with WHATWG `Request`/`Response` objects whose bodies are pulled
 * lazily from the daemon (`body_pull`).
 *
 * Wire shapes mirror `native/crates/gondolin-proto/src/net.rs`.
 */

import fs from "node:fs";
import tls from "node:tls";

import {
  NATIVE_HTTP_POLICY,
  type NativeHttpPolicyDescriptor,
  type NativeHttpRules,
} from "../http/hooks.ts";
import { djsHooksOf, type DjsHooksWire } from "../http/djs-hooks.ts";
import { HttpRequestBlockedError } from "../http/utils.ts";
import type { DnsOptions, HttpHooks, HttpIpAllowInfo } from "../net/types.ts";
import type { SshExecPolicy, SshOptions } from "../net/ssh.ts";
import {
  normalizeSshAllowedTargets,
  normalizeSshKnownHostsFiles,
} from "../ssh/utils.ts";
import {
  assertTcpDnsConfig,
  createTcpMappings,
  type TcpOptions,
} from "../net/tcp.ts";
import { normalizeIpv4Servers } from "../utils/dns.ts";

/** `configure.net.policy` */
export type NetPolicyWire = {
  rules?: NativeHttpRules;
  allow_websockets: boolean;
};

/** `configure.net.hooks` */
export type HookRegistrationsWire = {
  is_request_allowed: boolean;
  is_ip_allowed: boolean;
  on_request?: { body: boolean };
  on_response?: { body: boolean };
};

/** `configure.net.limits` (omitted fields use daemon defaults) */
export type NetLimitsWire = {
  max_request_body_bytes?: number;
  max_response_body_bytes?: number;
  max_concurrent_requests?: number;
  websocket_connect_timeout_ms?: number;
  websocket_header_timeout_ms?: number;
  tls_cache_max_entries?: number;
  tls_cache_ttl_ms?: number;
  guest_keep_alive?: boolean;
};

/** `configure.net` (DNS options are added by the netstack configuration) */
export type NetConfigWire = {
  policy: NetPolicyWire;
  hooks: HookRegistrationsWire;
  /** tier-2 policy (`createDjsHooks()`), run in the daemon */
  djs_hooks?: DjsHooksWire;
  limits: NetLimitsWire;
  mitm?: { cert_pem: string; key_pem: string };
  tcp_hosts?: Array<{
    host: string;
    port?: number;
    upstream_host: string;
    upstream_port: number;
  }>;
  ssh?: SshEgressConfigWire;
  upstream_ca_pems?: string[];
  use_system_roots?: boolean;
  use_webpki_roots?: boolean;
};

/** `configure.net.ssh` (gondolin-proto `SshEgressConfig`) */
export type SshEgressConfigWire = {
  ports: number[];
  allowed_hosts: string[];
  credentials: Array<{
    host: string;
    username?: string;
    private_key: string;
    passphrase?: string;
  }>;
  agent?: string;
  known_hosts_files: string[];
  /** known_hosts contents (remote daemons; replaces the files) */
  known_hosts?: string[];
  host_verifier_hook: boolean;
  exec_policy_hook: boolean;
  host_key?: string;
  max_upstream_connections_per_flow?: number;
  max_upstream_connections_total?: number;
  upstream_ready_timeout_ms?: number;
  upstream_keepalive_interval_ms?: number;
  upstream_keepalive_count_max?: number;
};

/** `ssh_hook_call` payload */
export type SshHookCallWire =
  | {
      phase: "exec_policy";
      request: {
        hostname: string;
        port: number;
        guest_username: string;
        command: string;
        src_ip: string;
        src_port: number;
      };
    }
  | { phase: "host_verify"; hostname: string; port: number; key: Uint8Array };

/** `ssh_hook_call_result` payload (besides `ok`) */
export type SshHookResultWire = {
  allow: boolean;
  exit_code?: number;
  message?: string;
};

export type WireRequestHead = {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  /** daemon body stream id */
  body?: number;
  /** start of the body, inline (pull the rest from offset `length`) */
  body_prefix?: Uint8Array;
  /** whether `body_prefix` is the whole body */
  body_complete?: boolean;
};

export type WireResponseHead = {
  status: number;
  status_text: string;
  headers: Array<[string, string]>;
  /** daemon body stream id */
  body?: number;
  /** start of the body, inline (pull the rest from offset `length`) */
  body_prefix?: Uint8Array;
  /** whether `body_prefix` is the whole body */
  body_complete?: boolean;
};

export type HookCallWire = {
  phase: "is_request_allowed" | "is_ip_allowed" | "on_request" | "on_response";
  request?: WireRequestHead;
  response?: WireResponseHead;
  ip?: {
    hostname: string;
    ip: string;
    family: number;
    port: number;
    protocol: string;
  };
};

export type WireBody =
  | { kind: "original" }
  | { kind: "none" }
  | { kind: "bytes"; data: Uint8Array }
  | { kind: "stream"; stream: number };

export type HookDecisionWire =
  | { action: "allowed"; allowed: boolean }
  | { action: "continue" }
  | {
      action: "request";
      request: Omit<WireRequestHead, "body">;
      body: WireBody;
    }
  | {
      action: "response";
      response: Omit<WireResponseHead, "body">;
      body: WireBody;
    }
  | { action: "block"; status: number; status_text: string; message: string };

/** Tier-3 callbacks (already bound to their `this`) */
export type TierThreeHooks = {
  isRequestAllowed?: (request: Request) => Promise<boolean> | boolean;
  isIpAllowed?: (info: HttpIpAllowInfo) => Promise<boolean> | boolean;
  onRequest?: (
    request: Request,
  ) => Promise<Request | Response | void> | Request | Response | void;
  onResponse?: (
    response: Response,
    request: Request,
  ) => Promise<Response | void> | Response | void;
};

export type CompileNetOptions = {
  httpHooks?: HttpHooks;
  /** default: true */
  allowWebSockets?: boolean;
  maxHttpBodyBytes?: number;
  maxHttpResponseBodyBytes?: number;
  /** MITM CA (PEM) */
  mitm?: { certPem: string; keyPem: string };
  /**
   * trusted upstream CA certificates (PEM); default: this process' default
   * store (`tls.getCACertificates("default")`), i.e. what node's fetch trusts
   */
  upstreamCaCerts?: string[];
};

function defaultCaCertificates(): string[] | undefined {
  const get = (tls as { getCACertificates?: (type: string) => string[] })
    .getCACertificates;
  return typeof get === "function" ? get("default") : undefined;
}

export type CompiledNet = {
  config: NetConfigWire;
  /** tier-3 callbacks, `null` when no phase is registered */
  hooks: TierThreeHooks | null;
  /** registers a listener for declarative policy changes (`policy_update`) */
  onPolicyUpdate(listener: (policy: NetPolicyWire) => void): () => void;
};

function declarativeDescriptor(
  hooks: HttpHooks | undefined,
): NativeHttpPolicyDescriptor | null {
  if (!hooks) return null;
  const descriptor = (hooks as Record<symbol, unknown>)[NATIVE_HTTP_POLICY] as
    | NativeHttpPolicyDescriptor
    | undefined;
  if (!descriptor) return null;
  const g = descriptor.generated;
  // A replaced method can do anything: fall back to calling all of them.
  if (
    hooks.isRequestAllowed !== g.isRequestAllowed ||
    hooks.isIpAllowed !== g.isIpAllowed ||
    hooks.onRequest !== g.onRequest ||
    hooks.onResponse !== g.onResponse
  ) {
    return null;
  }
  return descriptor;
}

/**
 * Splits `httpHooks` into declarative rules (evaluated natively) and tier-3
 * callbacks, and builds `configure.net`.
 */
export function compileNetConfig(options: CompileNetOptions): CompiledNet {
  const allowWebSockets = options.allowWebSockets ?? true;
  const descriptor = declarativeDescriptor(options.httpHooks);

  let tier3: TierThreeHooks = {};
  let rules: NativeHttpRules | undefined;
  if (descriptor) {
    rules = descriptor.rules();
    tier3 = { ...descriptor.user };
  } else if (options.httpHooks) {
    const hooks = options.httpHooks;
    tier3 = {
      isRequestAllowed: hooks.isRequestAllowed
        ? (request) => hooks.isRequestAllowed!.call(hooks, request)
        : undefined,
      isIpAllowed: hooks.isIpAllowed
        ? (info) => hooks.isIpAllowed!.call(hooks, info)
        : undefined,
      onRequest: hooks.onRequest
        ? (request) => hooks.onRequest!.call(hooks, request)
        : undefined,
      onResponse: hooks.onResponse
        ? (response, request) =>
            hooks.onResponse!.call(hooks, response, request)
        : undefined,
    };
  }

  // tier 2: functions from createDjsHooks() run in the daemon, not here
  let djsHooks: DjsHooksWire | undefined;
  for (const phase of [
    "isRequestAllowed",
    "isIpAllowed",
    "onRequest",
    "onResponse",
  ] as const) {
    const source =
      descriptor?.user[phase] ??
      (descriptor ? undefined : options.httpHooks?.[phase]);
    const djs = djsHooksOf(source);
    if (!djs) continue;
    if (djsHooks && djsHooks !== djs.config) {
      throw new Error(
        "httpHooks: only one createDjsHooks() policy is supported",
      );
    }
    djsHooks = djs.config;
    delete tier3[phase];
  }

  const registrations: HookRegistrationsWire = {
    is_request_allowed: Boolean(tier3.isRequestAllowed),
    is_ip_allowed: Boolean(tier3.isIpAllowed),
    ...(tier3.onRequest ? { on_request: { body: true } } : {}),
    ...(tier3.onResponse ? { on_response: { body: true } } : {}),
  };
  const anyHook =
    registrations.is_request_allowed ||
    registrations.is_ip_allowed ||
    Boolean(registrations.on_request) ||
    Boolean(registrations.on_response);

  const upstreamCaCerts = options.upstreamCaCerts ?? defaultCaCertificates();
  const limits: NetLimitsWire = {};
  if (options.maxHttpBodyBytes !== undefined) {
    limits.max_request_body_bytes = options.maxHttpBodyBytes;
  }
  if (options.maxHttpResponseBodyBytes !== undefined) {
    limits.max_response_body_bytes = options.maxHttpResponseBodyBytes;
  }

  const config: NetConfigWire = {
    policy: {
      ...(rules ? { rules } : {}),
      allow_websockets: allowWebSockets,
    },
    hooks: registrations,
    ...(djsHooks ? { djs_hooks: djsHooks } : {}),
    limits,
    ...(options.mitm
      ? {
          mitm: {
            cert_pem: options.mitm.certPem,
            key_pem: options.mitm.keyPem,
          },
        }
      : {}),
    ...(upstreamCaCerts
      ? {
          // match node: trust exactly the given store
          upstream_ca_pems: upstreamCaCerts,
          use_system_roots: false,
          use_webpki_roots: false,
        }
      : {}),
  };

  return {
    config,
    hooks: anyHook ? tier3 : null,
    onPolicyUpdate(listener) {
      if (!descriptor) return () => {};
      return descriptor.subscribe(() => {
        listener({
          rules: descriptor.rules(),
          allow_websockets: allowWebSockets,
        });
      });
    },
  };
}

/** `configure.net.stack` (netstack `NetConfig`; omitted fields use daemon defaults) */
export type StackConfigWire = {
  guest_mac?: string;
  /** guest NIC offloads TCP/UDP checksums (krun) */
  checksum_offload?: boolean;
  dns: {
    mode: "synthetic" | "trusted" | "open";
    trusted_servers?: string[];
    synthetic_ipv4?: string;
    synthetic_ipv6?: string;
    synthetic_ttl_seconds?: number;
    synthetic_host_mapping: "single" | "per-host";
  };
};

export type CompileNetworkOptions = {
  dns?: DnsOptions;
  ssh?: SshOptions;
  tcp?: TcpOptions;
  /** guest MAC (`aa:bb:cc:dd:ee:ff`) */
  netMac?: string;
  /** whether the guest NIC offloads checksums (krun's virtio-net) */
  checksumOffload?: boolean;
  /**
   * whether gondolind runs on this machine: then this process' resolvers
   * (`dns.getServers()`) are used; a remote daemon
   * uses its own host's resolvers unless servers are configured explicitly
   */
  daemonIsLocal: boolean;
};

export type CompiledNetwork = {
  stack: StackConfigWire;
  /** `configure.net.tcp_hosts` */
  tcpHosts: NonNullable<NetConfigWire["tcp_hosts"]>;
  /** `configure.net.ssh` */
  ssh?: SshEgressConfigWire;
  /** controller side of `ssh_hook_call` (only when `ssh` declares hooks) */
  sshHooks?: SshHookService;
  /** `configure.net.system_resolvers` */
  systemResolvers?: string[];
};

/**
 * Resolves the DNS/SSH/mapped-TCP options (validation, per-host mapping auto
 * default, trusted resolvers with fail-fast) into the stack part of
 * `configure.net`.
 */
export function compileNetworkOptions(
  options: CompileNetworkOptions,
): CompiledNetwork {
  const dns = options.dns;
  const mode = dns?.mode ?? "synthetic";
  // SSH credentials/known_hosts are validated (and loaded) by the daemon,
  // whose filesystem they live on; only the allowlist matters here.
  const sshTargets = normalizeSshAllowedTargets(options.ssh?.allowedHosts);
  const ssh = {
    enabled: sshTargets.length > 0,
    sniffPorts: Array.from(new Set(sshTargets.map((t) => t.port))),
  };
  const tcp = createTcpMappings(options.tcp);
  const syntheticHostMapping =
    dns?.syntheticHostMapping ??
    (ssh.enabled || tcp.enabled ? "per-host" : "single");

  if (ssh.enabled && mode !== "synthetic") {
    throw new Error("ssh egress requires dns mode 'synthetic'");
  }
  if (ssh.enabled && syntheticHostMapping !== "per-host") {
    throw new Error("ssh egress requires dns syntheticHostMapping='per-host'");
  }
  assertTcpDnsConfig({ tcp, dnsMode: mode, syntheticHostMapping });

  const explicitTrusted =
    dns?.trustedServers && dns.trustedServers.length > 0
      ? normalizeIpv4Servers(dns.trustedServers)
      : [];
  const localResolvers = options.daemonIsLocal
    ? normalizeIpv4Servers(undefined)
    : undefined;
  const trusted =
    explicitTrusted.length > 0 ? explicitTrusted : (localResolvers ?? []);
  if (mode === "trusted" && options.daemonIsLocal && trusted.length === 0) {
    throw new Error(
      "dns mode 'trusted' requires at least one IPv4 resolver (none found). Provide an IPv4 resolver via --dns-trusted-server or configure an IPv4 DNS server on the host",
    );
  }

  return {
    stack: {
      ...(options.netMac ? { guest_mac: options.netMac } : {}),
      ...(options.checksumOffload ? { checksum_offload: true } : {}),
      dns: {
        mode,
        ...(trusted.length > 0 ? { trusted_servers: trusted } : {}),
        ...(dns?.syntheticIPv4 ? { synthetic_ipv4: dns.syntheticIPv4 } : {}),
        ...(dns?.syntheticIPv6 ? { synthetic_ipv6: dns.syntheticIPv6 } : {}),
        ...(dns?.syntheticTtlSeconds !== undefined
          ? { synthetic_ttl_seconds: dns.syntheticTtlSeconds }
          : {}),
        synthetic_host_mapping: syntheticHostMapping,
      },
    },
    tcpHosts: tcp.rules.map((rule) => ({
      host: rule.hostname,
      ...(rule.port !== null ? { port: rule.port } : {}),
      upstream_host: rule.connectHost,
      upstream_port: rule.connectPort,
    })),
    ...(ssh.enabled && options.ssh
      ? {
          ssh: compileSshConfig(
            options.ssh,
            ssh.sniffPorts,
            options.daemonIsLocal,
          ),
          ...(options.ssh.execPolicy || options.ssh.hostVerifier
            ? { sshHooks: new SshHookService(options.ssh) }
            : {}),
        }
      : {}),
    ...(localResolvers ? { systemResolvers: localResolvers } : {}),
  };
}

function bytesToString(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

/**
 * Maps `VMOptions.ssh` onto `configure.net.ssh`. Paths are paths on the
 * daemon's machine; for a local daemon the controller resolves the default
 * known_hosts files.
 */
export function compileSshConfig(
  ssh: SshOptions,
  ports: number[],
  daemonIsLocal: boolean,
): SshEgressConfigWire {
  // known_hosts: the given files, else the defaults; a
  // local daemon reads the same paths, a remote one gets their contents
  const knownHostsPaths = normalizeSshKnownHostsFiles(ssh.knownHostsFile);
  let knownHostsFiles: string[] = [];
  let knownHosts: string[] = [];
  if (daemonIsLocal) {
    knownHostsFiles = knownHostsPaths;
  } else if (!ssh.hostVerifier) {
    for (const file of knownHostsPaths) {
      try {
        knownHosts.push(fs.readFileSync(file, "utf8"));
      } catch {
        // missing files are skipped
      }
    }
    if (knownHosts.length === 0) {
      throw new Error(
        `ssh egress requires ssh.hostVerifier to validate upstream host keys (failed to load known_hosts: no OpenSSH known_hosts files found (tried ${knownHostsPaths.join(", ")}))`,
      );
    }
  }
  if (!daemonIsLocal && ssh.agent) {
    throw new Error(
      "ssh.agent is not supported with a remote gondolind (the agent socket is on the controller); use ssh.credentials",
    );
  }
  knownHosts = knownHosts.filter((c) => c.trim().length > 0);
  return {
    ports,
    allowed_hosts: [...ssh.allowedHosts],
    credentials: Object.entries(ssh.credentials ?? {}).map(([host, c]) => ({
      host,
      ...(c.username !== undefined ? { username: c.username } : {}),
      private_key: bytesToString(c.privateKey),
      ...(c.passphrase !== undefined
        ? { passphrase: bytesToString(c.passphrase) }
        : {}),
    })),
    ...(ssh.agent ? { agent: ssh.agent } : {}),
    known_hosts_files: knownHostsFiles,
    ...(knownHosts.length > 0 ? { known_hosts: knownHosts } : {}),
    host_verifier_hook: Boolean(ssh.hostVerifier),
    exec_policy_hook: Boolean(ssh.execPolicy),
    ...(ssh.hostKey !== undefined
      ? { host_key: bytesToString(ssh.hostKey) }
      : {}),
    ...(ssh.maxUpstreamConnectionsPerTcpSession !== undefined
      ? {
          max_upstream_connections_per_flow:
            ssh.maxUpstreamConnectionsPerTcpSession,
        }
      : {}),
    ...(ssh.maxUpstreamConnectionsTotal !== undefined
      ? { max_upstream_connections_total: ssh.maxUpstreamConnectionsTotal }
      : {}),
    ...(ssh.upstreamReadyTimeoutMs !== undefined
      ? { upstream_ready_timeout_ms: ssh.upstreamReadyTimeoutMs }
      : {}),
    ...(ssh.upstreamKeepaliveIntervalMs !== undefined
      ? { upstream_keepalive_interval_ms: ssh.upstreamKeepaliveIntervalMs }
      : {}),
    ...(ssh.upstreamKeepaliveCountMax !== undefined
      ? { upstream_keepalive_count_max: ssh.upstreamKeepaliveCountMax }
      : {}),
  };
}

/** Serves `ssh_hook_call` with `ssh.execPolicy` / `ssh.hostVerifier`. */
export class SshHookService {
  private readonly execPolicy?: SshExecPolicy;
  private readonly hostVerifier?: SshOptions["hostVerifier"];

  constructor(ssh: Pick<SshOptions, "execPolicy" | "hostVerifier">) {
    this.execPolicy = ssh.execPolicy;
    this.hostVerifier = ssh.hostVerifier;
  }

  async handle(call: SshHookCallWire): Promise<SshHookResultWire> {
    if (call.phase === "host_verify") {
      if (!this.hostVerifier) return { allow: false };
      return {
        allow: Boolean(
          this.hostVerifier(call.hostname, Buffer.from(call.key), call.port),
        ),
      };
    }
    if (!this.execPolicy) return { allow: true };
    const r = call.request;
    const decision = await this.execPolicy({
      hostname: r.hostname,
      port: r.port,
      guestUsername: r.guest_username,
      command: r.command,
      src: { ip: r.src_ip, port: r.src_port },
    });
    if (decision.allow) return { allow: true };
    return {
      allow: false,
      ...(decision.exitCode !== undefined
        ? { exit_code: decision.exitCode }
        : {}),
      ...(decision.message !== undefined ? { message: decision.message } : {}),
    };
  }
}

/** Lazy body access to daemon-held streams. */
export type BodyTransport = {
  /**
   * `body_pull` at byte `offset` of the stream: next chunk (empty with `eof` at
   * the end). The daemon retains what it read, so several readers (clones) can
   * pull the same stream independently.
   */
  pull(
    stream: number,
    max: number,
    offset: number,
  ): Promise<{ data: Uint8Array; eof: boolean }>;
  /** `body_release`: the reader is done (a hint) */
  release(stream: number): void;
};

const PULL_CHUNK_BYTES = 256 * 1024;

/** A ReadableStream that pulls from a daemon body stream only when read. */
export function daemonBodyStream(
  transport: BodyTransport,
  stream: number,
  inline?: { prefix?: Uint8Array; complete?: boolean },
): ReadableStream<Uint8Array> {
  const prefix = inline?.prefix;
  let offset = 0;
  let done = false;
  let sentPrefix = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        // bytes the daemon sent inline with the hook call: no round trip
        if (!sentPrefix) {
          sentPrefix = true;
          if (prefix && prefix.length > 0) {
            offset = prefix.length;
            controller.enqueue(new Uint8Array(prefix));
          }
          if (inline?.complete) {
            done = true;
            controller.close();
          }
          if (offset > 0 || done) return;
        }
        const { data, eof } = await transport.pull(
          stream,
          PULL_CHUNK_BYTES,
          offset,
        );
        offset += data.length;
        if (data.length > 0) controller.enqueue(new Uint8Array(data));
        if (eof) {
          done = true;
          controller.close();
        }
      },
      cancel() {
        if (!done) {
          done = true;
          transport.release(stream);
        }
      },
    },
    { highWaterMark: 0 },
  );
}

type BodyFactory = () => ReadableStream<Uint8Array>;

type HeaderList = Array<[string, string]> | Headers;

/**
 * Request whose `clone()` opens an independent daemon reader instead of
 * teeing, so a hook reading a clone does not buffer a second copy here.
 */
function daemonRequest(
  url: string,
  init: { method: string; headers: HeaderList },
  makeBody: BodyFactory | null,
): Request {
  const body = makeBody ? makeBody() : null;
  const request = new Request(url, {
    method: init.method,
    headers: init.headers,
    ...(body ? { body, duplex: "half" } : {}),
  } as RequestInit);
  if (makeBody) {
    Object.defineProperty(request, "clone", {
      configurable: true,
      writable: true,
      value: (): Request => {
        if (request.bodyUsed) {
          throw new TypeError("Request.clone: Body has already been consumed.");
        }
        return daemonRequest(
          request.url,
          { method: request.method, headers: new Headers(request.headers) },
          makeBody,
        );
      },
    });
  }
  return request;
}

/** Response counterpart of {@link daemonRequest}. */
function daemonResponse(
  makeBody: BodyFactory | null,
  init: { status: number; statusText: string; headers: HeaderList },
): Response {
  const response = new Response(makeBody ? makeBody() : null, init);
  if (makeBody) {
    Object.defineProperty(response, "clone", {
      configurable: true,
      writable: true,
      value: (): Response => {
        if (response.bodyUsed) {
          throw new TypeError(
            "Response.clone: Body has already been consumed.",
          );
        }
        return daemonResponse(makeBody, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
        });
      },
    });
  }
  return response;
}

function headersToWire(headers: Headers): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  headers.forEach((value, key) => {
    out.push([key.toLowerCase(), value]);
  });
  // `forEach` combines set-cookie; split it back for responses
  const raw = headers as { getSetCookie?: () => string[] };
  if (typeof raw.getSetCookie === "function") {
    const cookies = raw.getSetCookie();
    if (cookies.length > 1) {
      return [
        ...out.filter(([k]) => k !== "set-cookie"),
        ...cookies.map((c): [string, string] => ["set-cookie", c]),
      ];
    }
  }
  return out;
}

function sameHead(
  a: Omit<WireRequestHead, "body">,
  b: Omit<WireRequestHead, "body">,
): boolean {
  if (a.method !== b.method || a.url !== b.url) return false;
  if (a.headers.length !== b.headers.length) return false;
  const map = new Map(a.headers);
  return b.headers.every(([k, v]) => map.get(k) === v);
}

function blockDecision(err: HttpRequestBlockedError): HookDecisionWire {
  return {
    action: "block",
    status: err.status,
    status_text: err.statusText,
    message: err.message,
  };
}

function isResponseLike(value: unknown): value is Response {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { status?: unknown }).status === "number" &&
    typeof (value as { headers?: { forEach?: unknown } }).headers?.forEach ===
      "function"
  );
}

function isRequestLike(value: unknown): value is Request {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { url?: unknown }).url === "string" &&
    typeof (value as { method?: unknown }).method === "string" &&
    typeof (value as { headers?: { forEach?: unknown } }).headers?.forEach ===
      "function"
  );
}

/** Replacement bodies up to this size in `bytes` are sent inline */
const INLINE_BODY_BYTES = 1024 * 1024;

type OutgoingStream = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /** chunks read but not yet pulled */
  pending: Uint8Array[];
  /** bytes read so far in `bytes` */
  total: number;
  max: number;
  overflow: () => HttpRequestBlockedError;
};

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Errors the stream once more than `max` bytes passed (`502`, like node) */
function limitStream(max: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.length;
      if (total > max) {
        controller.error(
          new HttpRequestBlockedError(
            `response body exceeds ${max} bytes`,
            502,
            "Bad Gateway",
          ),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

type DecodeFormat = "gzip" | "deflate" | "brotli";

let brotliSupported: boolean | undefined;

function supportsBrotli(): boolean {
  if (brotliSupported === undefined) {
    try {
      new DecompressionStream("brotli" as "gzip");
      brotliSupported = true;
    } catch {
      brotliSupported = false;
    }
  }
  return brotliSupported;
}

/** Decoder for a single content-encoding (the ones undici's fetch decodes) */
function decoderFor(encoding: string | null): DecodeFormat | null {
  switch (encoding?.trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return "gzip";
    case "deflate":
      return "deflate";
    case "br":
      return supportsBrotli() ? "brotli" : null;
    default:
      return null;
  }
}

/**
 * Serves `hook_call`s with the tier-3 callbacks (`onRequest`, `onResponse`,
 * `isRequestAllowed`, `isIpAllowed`).
 */
export class NativeHookService {
  private readonly hooks: TierThreeHooks;
  private readonly transport: BodyTransport;
  private readonly maxRequestBodyBytes: number;
  private readonly maxResponseBodyBytes: number;
  private readonly outgoing = new Map<number, OutgoingStream>();
  private nextStream = 1;

  constructor(
    hooks: TierThreeHooks,
    options: {
      transport: BodyTransport;
      maxRequestBodyBytes: number;
      maxResponseBodyBytes: number;
    },
  ) {
    this.hooks = hooks;
    this.transport = options.transport;
    this.maxRequestBodyBytes = options.maxRequestBodyBytes;
    this.maxResponseBodyBytes = options.maxResponseBodyBytes;
  }

  /**
   * Answers one call. `HttpRequestBlockedError`s become `block` decisions;
   * other errors reject (the daemon answers `502 Bad Gateway`).
   */
  async handle(call: HookCallWire): Promise<HookDecisionWire> {
    try {
      switch (call.phase) {
        case "is_request_allowed":
          return await this.isRequestAllowed(call);
        case "is_ip_allowed":
          return await this.isIpAllowed(call);
        case "on_request":
          return await this.onRequest(call);
        case "on_response":
          return await this.onResponse(call);
        default:
          throw new Error(`unknown hook phase: ${String(call.phase)}`);
      }
    } catch (err) {
      if (err instanceof HttpRequestBlockedError) return blockDecision(err);
      throw err;
    }
  }

  /**
   * Serves a daemon `body_pull` on a controller stream (replacement bodies
   * larger than {@link INLINE_BODY_BYTES}).
   */
  async serveBodyPull(pull: {
    stream: number;
    max: number;
  }): Promise<{ stream: number; data: Uint8Array; eof: boolean }> {
    const state = this.outgoing.get(pull.stream);
    if (!state) throw new Error(`unknown body stream ${pull.stream}`);
    const max = Math.max(1, Math.min(pull.max, 4 * 1024 * 1024 - 1024));
    for (;;) {
      const head = state.pending.shift();
      if (head) {
        if (head.length > max) state.pending.unshift(head.subarray(max));
        return { stream: pull.stream, data: head.subarray(0, max), eof: false };
      }
      const { done, value } = await state.reader.read();
      if (done) {
        this.outgoing.delete(pull.stream);
        return { stream: pull.stream, data: new Uint8Array(0), eof: true };
      }
      if (!value || value.length === 0) continue;
      state.total += value.length;
      if (state.total > state.max) {
        this.serveBodyRelease(pull.stream);
        throw state.overflow();
      }
      state.pending.push(value);
    }
  }

  /** Serves a daemon `body_release` on a controller stream. */
  serveBodyRelease(stream: number): void {
    const state = this.outgoing.get(stream);
    if (!state) return;
    this.outgoing.delete(stream);
    state.reader.cancel().catch(() => {});
  }

  /**
   * Body for a decision: inline bytes when small, else a controller stream the
   * daemon pulls (frames are limited to 4 MiB). The limit applies either way.
   */
  private async outgoingBody(
    body: ReadableStream<Uint8Array> | null,
    max: number,
    overflow: () => HttpRequestBlockedError,
  ): Promise<WireBody> {
    if (!body) return { kind: "bytes", data: new Uint8Array(0) };
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return { kind: "bytes", data: concatBytes(chunks, total) };
      }
      if (!value || value.length === 0) continue;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw overflow();
      }
      chunks.push(value);
      if (total > INLINE_BODY_BYTES) {
        const stream = this.nextStream++;
        this.outgoing.set(stream, {
          reader,
          pending: chunks,
          total,
          max,
          overflow,
        });
        return { kind: "stream", stream };
      }
    }
  }

  private headRequest(head: WireRequestHead): Request {
    return new Request(head.url, {
      method: head.method,
      headers: head.headers,
    });
  }

  private async isRequestAllowed(
    call: HookCallWire,
  ): Promise<HookDecisionWire> {
    const fn = this.hooks.isRequestAllowed;
    if (!fn || !call.request) return { action: "allowed", allowed: true };
    const allowed = await fn(this.headRequest(call.request));
    return { action: "allowed", allowed: Boolean(allowed) };
  }

  private async isIpAllowed(call: HookCallWire): Promise<HookDecisionWire> {
    const fn = this.hooks.isIpAllowed;
    if (!fn || !call.ip) return { action: "allowed", allowed: true };
    const allowed = await fn({
      hostname: call.ip.hostname,
      ip: call.ip.ip,
      family: call.ip.family === 6 ? 6 : 4,
      port: call.ip.port,
      protocol: call.ip.protocol === "https" ? "https" : "http",
    });
    return { action: "allowed", allowed: Boolean(allowed) };
  }

  private async onRequest(call: HookCallWire): Promise<HookDecisionWire> {
    const fn = this.hooks.onRequest;
    const head = call.request;
    if (!fn || !head) return { action: "continue" };

    const bodyId = head.body;
    const transport = this.transport;
    const original = daemonRequest(
      head.url,
      { method: head.method, headers: head.headers },
      bodyId !== undefined
        ? () =>
            daemonBodyStream(transport, bodyId, {
              prefix: head.body_prefix,
              complete: head.body_complete,
            })
        : null,
    );
    const releaseOriginal = () => {
      if (bodyId !== undefined) this.transport.release(bodyId);
    };

    let result: unknown;
    try {
      result = await fn(original);
    } catch (err) {
      releaseOriginal();
      throw err;
    }
    const next = result ?? original;

    if (isResponseLike(next)) {
      releaseOriginal();
      const body = await this.outgoingBody(
        next.body,
        this.maxResponseBodyBytes,
        () =>
          new HttpRequestBlockedError(
            `response body exceeds ${this.maxResponseBodyBytes} bytes`,
            502,
            "Bad Gateway",
          ),
      );
      return {
        action: "response",
        response: {
          status: next.status,
          status_text: next.statusText,
          headers: headersToWire(next.headers),
        },
        body,
      };
    }

    if (!isRequestLike(next)) {
      releaseOriginal();
      throw new TypeError(
        "onRequest must return Request, Response, or undefined",
      );
    }

    const nextHead = {
      method: next.method,
      url: next.url,
      headers: headersToWire(next.headers),
    };

    if (next.body === original.body) {
      if (original.bodyUsed) {
        releaseOriginal();
        throw new HttpRequestBlockedError(
          "onRequest consumed the request body; use request.clone() or return a new Request",
          400,
          "Bad Request",
        );
      }
      const unchanged = sameHead(
        { method: head.method, url: head.url, headers: head.headers },
        nextHead,
      );
      return unchanged
        ? { action: "continue" }
        : { action: "request", request: nextHead, body: { kind: "original" } };
    }

    releaseOriginal();
    if (next.body === null) {
      return { action: "request", request: nextHead, body: { kind: "none" } };
    }
    if (next.bodyUsed) {
      throw new HttpRequestBlockedError(
        "onRequest returned a consumed request body",
        400,
        "Bad Request",
      );
    }
    const body = await this.outgoingBody(
      next.body,
      this.maxRequestBodyBytes,
      () =>
        new HttpRequestBlockedError(
          `request body exceeds ${this.maxRequestBodyBytes} bytes`,
          413,
          "Payload Too Large",
        ),
    );
    return { action: "request", request: nextHead, body };
  }

  private async onResponse(call: HookCallWire): Promise<HookDecisionWire> {
    const fn = this.hooks.onResponse;
    const head = call.response;
    if (!fn || !head || !call.request) return { action: "continue" };

    const bodyId = head.body;
    const releaseOriginal = () => {
      if (bodyId !== undefined) this.transport.release(bodyId);
    };

    // Hooks see decoded bodies (like `fetch` responses) without
    // content-encoding/content-length.
    const headers = new Headers();
    for (const [k, v] of head.headers) headers.append(k, v);
    const encoding = headers.get("content-encoding");
    const format = decoderFor(encoding);
    const transport = this.transport;
    const hasBody =
      bodyId !== undefined && !NULL_BODY_STATUSES.has(head.status);
    const makeBody: BodyFactory | null = hasBody
      ? () => {
          const raw = daemonBodyStream(transport, bodyId!, {
            prefix: head.body_prefix,
            complete: head.body_complete,
          });
          return format
            ? raw
                .pipeThrough(
                  new DecompressionStream(
                    format as "gzip",
                  ) as unknown as TransformStream<Uint8Array, Uint8Array>,
                )
                // the daemon limits the encoded bytes; bound the decoded ones
                // too (decompression bombs), like node's buffered limit
                .pipeThrough(limitStream(this.maxResponseBodyBytes))
            : raw;
        }
      : null;
    if (makeBody && format) {
      headers.delete("content-encoding");
      headers.delete("content-length");
    }

    const response = daemonResponse(makeBody, {
      status: head.status,
      statusText: head.status_text,
      headers,
    });
    const request = this.headRequest(call.request);

    let updated: unknown;
    try {
      updated = await fn(response, request);
    } catch (err) {
      releaseOriginal();
      throw err;
    }
    if (!updated) {
      // the daemon forwards the original body (replaying pulled chunks)
      return { action: "continue" };
    }
    if (!isResponseLike(updated)) {
      releaseOriginal();
      throw new TypeError("onResponse must return Response or undefined");
    }

    const nextHead = {
      status: updated.status,
      status_text: updated.statusText,
      headers: headersToWire(updated.headers),
    };

    if (updated.body === response.body && response.body !== null) {
      if (updated.bodyUsed) {
        releaseOriginal();
        throw new HttpRequestBlockedError(
          "onResponse returned a consumed response body",
          502,
          "Bad Gateway",
        );
      }
      if (format) {
        // forwarding the original (still encoded) body: restore its framing
        nextHead.headers = nextHead.headers.filter(
          ([k]) => k !== "content-encoding" && k !== "content-length",
        );
        nextHead.headers.push(["content-encoding", encoding!]);
      }
      return {
        action: "response",
        response: nextHead,
        body: { kind: "original" },
      };
    }

    releaseOriginal();
    const body = await this.outgoingBody(
      updated.body,
      this.maxResponseBodyBytes,
      () =>
        new HttpRequestBlockedError(
          `response body exceeds ${this.maxResponseBodyBytes} bytes`,
          502,
          "Bad Gateway",
        ),
    );
    return { action: "response", response: nextHead, body };
  }
}

/** What {@link NativeNetwork} needs from the transport */
export type NativeNetTransport = {
  request(t: string, p?: unknown): Promise<any>;
  send(t: string, p?: unknown, id?: number): boolean;
  onMessage(t: string, handler: (payload: any) => void): void;
  handleRequest(
    t: string,
    handler: (
      payload: any,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): void;
};

export type NativeNetworkOptions = CompileNetOptions &
  Omit<CompileNetworkOptions, "daemonIsLocal"> & {
    /** MITM CA directory (shared cache, `GONDOLIN_MITM_CERT_DIR`) */
    mitmCertDir?: string;
    /** default: true */
    daemonIsLocal?: boolean;
  };

/**
 * The native engine's network: `configure.net` (`mode: "native"`) and the
 * controller side of hooks (`hook_call`, `body_pull`, `body_release`,
 * `ssh_hook_call`, `policy_update`). Option validation errors are thrown by
 * the constructor.
 */
export class NativeNetwork {
  private readonly options: NativeNetworkOptions;
  private readonly net: CompiledNet;
  private readonly network: CompiledNetwork;
  private unsubscribe: (() => void) | null = null;

  constructor(options: NativeNetworkOptions) {
    this.options = options;
    this.net = compileNetConfig(options);
    this.network = compileNetworkOptions({
      ...options,
      daemonIsLocal: options.daemonIsLocal ?? true,
    });
  }

  /**
   * `configure.net`. A local daemon gets the controller's cached MITM CA (the
   * one the guest trusts through `/etc/gondolin/mitm`); a remote daemon uses
   * its own cache (`mitm_ca`), so no controller paths or keys are sent.
   */
  async configure(): Promise<Record<string, unknown>> {
    let mitm: NetConfigWire["mitm"];
    if (this.options.daemonIsLocal ?? true) {
      const { loadOrCreateMitmCa, resolveMitmCertDir } = await import(
        "../mitm.ts"
      );
      const ca = await loadOrCreateMitmCa(
        resolveMitmCertDir(this.options.mitmCertDir),
      );
      mitm = { cert_pem: ca.certPem, key_pem: ca.keyPem };
    }
    const config: NetConfigWire = {
      ...this.net.config,
      ...(mitm ? { mitm } : {}),
      ...(this.network.tcpHosts.length > 0
        ? { tcp_hosts: this.network.tcpHosts }
        : {}),
      ...(this.network.ssh ? { ssh: this.network.ssh } : {}),
    };
    return {
      mode: "native",
      ...config,
      stack: this.network.stack,
      ...(this.network.systemResolvers
        ? { system_resolvers: this.network.systemResolvers }
        : {}),
    };
  }

  /** Registers the controller-side handlers on `transport` */
  install(transport: NativeNetTransport) {
    if (this.net.hooks) {
      const service = new NativeHookService(this.net.hooks, {
        transport: {
          pull: async (stream, max, offset) => {
            const r = await transport.request("body_pull", {
              stream,
              max,
              offset,
            });
            return {
              data: r.data instanceof Uint8Array ? r.data : new Uint8Array(0),
              eof: Boolean(r.eof),
            };
          },
          // daemon streams live until the hook call returns: no frame needed
          release: () => {},
        },
        maxRequestBodyBytes: this.options.maxHttpBodyBytes ?? 64 * 1024 * 1024,
        maxResponseBodyBytes:
          this.options.maxHttpResponseBodyBytes ??
          this.options.maxHttpBodyBytes ??
          64 * 1024 * 1024,
      });
      transport.handleRequest("hook_call", async (p) => ({
        ...(await service.handle(p as HookCallWire)),
      }));
      transport.handleRequest("body_pull", async (p) => ({
        ...(await service.serveBodyPull(p)),
      }));
      transport.onMessage("body_release", (p) => {
        service.serveBodyRelease(Number(p.stream));
      });
    }
    const sshHooks = this.network.sshHooks;
    if (sshHooks) {
      transport.handleRequest("ssh_hook_call", async (p) => ({
        ...(await sshHooks.handle(p as SshHookCallWire)),
      }));
    }
    this.unsubscribe = this.net.onPolicyUpdate((policy) => {
      transport.request("policy_update", { policy }).catch(() => {
        // the daemon may be gone; the next start sends the full policy
      });
    });
  }

  close() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

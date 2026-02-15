import { Duplex } from "stream";
import {
  Client as SshClient,
  Server as SshServer,
  type AuthContext as SshAuthContext,
  type ClientChannel as SshClientChannel,
  type Connection as SshServerConnection,
  type ServerChannel as SshServerChannel,
  type Session as SshServerSession,
} from "ssh2";

import {
  createOpenSshKnownHostsHostVerifier,
  generateSshHostKey,
  matchHostname,
  normalizeSshAllowedTargets,
  normalizeSshCredentials,
  normalizeSshKnownHostsFiles,
  type ResolvedSshCredential,
  type SshAllowedTarget,
} from "./ssh-utils";

import type {
  DnsMode,
  QemuNetworkBackend,
  SyntheticDnsHostMappingMode,
  TcpSession,
} from "./qemu-net";

const DEFAULT_SSH_MAX_UPSTREAM_CONNECTIONS_PER_TCP_SESSION = 4;
const DEFAULT_SSH_MAX_UPSTREAM_CONNECTIONS_TOTAL = 64;
const DEFAULT_SSH_UPSTREAM_READY_TIMEOUT_MS = 15_000;
const DEFAULT_SSH_UPSTREAM_KEEPALIVE_INTERVAL_MS = 10_000;
const DEFAULT_SSH_UPSTREAM_KEEPALIVE_COUNT_MAX = 3;

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

export type SshExecPolicy = (
  request: SshExecRequest,
) => SshExecDecision | Promise<SshExecDecision>;

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

class GuestSshStream extends Duplex {
  constructor(
    private readonly onServerWrite: (chunk: Buffer) => void | Promise<void>,
    private readonly onServerEnd: () => void | Promise<void>,
  ) {
    super();
  }

  pushFromGuest(data: Buffer) {
    this.push(data);
  }

  _read() {
    // data is pushed via pushFromGuest
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    Promise.resolve(this.onServerWrite(Buffer.from(chunk))).then(
      () => callback(),
      (err) => callback(err as Error),
    );
  }

  _final(callback: (error?: Error | null) => void) {
    Promise.resolve(this.onServerEnd()).then(
      () => callback(),
      (err) => callback(err as Error),
    );
  }
}

/** @internal */
export type SshProxySession = {
  /** guest-side injected transport stream */
  stream: GuestSshStream;
  /** per-flow ssh server */
  server: SshServer;
  /** guest-side ssh server connection */
  connection: SshServerConnection | null;
  /** active upstream ssh clients created for concurrent exec channels */
  upstreams: Set<SshClient>;
};

/** @internal */
export type SshTcpSessionState = {
  /** resolved upstream credential for ssh proxying */
  credential: ResolvedSshCredential | null;
  /** active ssh proxy state when host-side credentials are used */
  proxy?: SshProxySession;
};

/** @internal */
export type QemuSshInternals = {
  /** whether ssh egress is enabled */
  enabled: boolean;

  /** allowed ssh host targets */
  allowedTargets: SshAllowedTarget[];
  /** ports that should be sniffed as ssh */
  sniffPorts: number[];
  /** sniff port lookup set */
  sniffPortsSet: ReadonlySet<number>;

  /** resolved upstream credentials */
  credentials: ResolvedSshCredential[];
  /** ssh-agent socket path */
  agent: string | null;
  /** guest-facing ssh host key */
  hostKey: string | null;
  /** upstream host key verifier callback */
  hostVerifier: ((hostname: string, key: Buffer, port: number) => boolean) | null;
  /** allow/deny callback for guest ssh exec requests */
  execPolicy: SshExecPolicy | null;

  /** max concurrent upstream ssh connections per guest tcp flow */
  maxUpstreamConnectionsPerTcpSession: number;
  /** max concurrent upstream ssh connections across all guest flows */
  maxUpstreamConnectionsTotal: number;
  /** upstream ssh connect+handshake timeout in `ms` */
  upstreamReadyTimeoutMs: number;
  /** upstream ssh keepalive interval in `ms` */
  upstreamKeepaliveIntervalMs: number;
  /** upstream ssh keepalive probes before disconnect */
  upstreamKeepaliveCountMax: number;

  /** active upstream ssh clients across all guest flows */
  upstreams: Set<SshClient>;
};

/** @internal */
export function createQemuSshInternals(options?: SshOptions): QemuSshInternals {
  const allowedTargets = normalizeSshAllowedTargets(options?.allowedHosts);
  const sniffPorts = Array.from(new Set(allowedTargets.map((t) => t.port)));
  const sniffPortsSet = new Set(sniffPorts);

  const credentials = normalizeSshCredentials(options?.credentials);
  const agent = options?.agent ?? null;
  const execPolicy = options?.execPolicy ?? null;

  const hostKey =
    typeof options?.hostKey === "string"
      ? options.hostKey
      : options?.hostKey
        ? options.hostKey.toString("utf8")
        : null;

  let hostVerifier = options?.hostVerifier ?? null;

  // Default to OpenSSH host key verification via known_hosts unless an explicit verifier
  // is provided. This protects against DNS poisoning / MITM for both agent and raw key auth.
  if (
    allowedTargets.length > 0 &&
    !hostVerifier &&
    (agent || credentials.length > 0)
  ) {
    const knownHostsFiles = normalizeSshKnownHostsFiles(options?.knownHostsFile);
    try {
      hostVerifier = createOpenSshKnownHostsHostVerifier(knownHostsFiles);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err);
      throw new Error(
        `ssh egress requires ssh.hostVerifier to validate upstream host keys (failed to load known_hosts: ${message})`,
      );
    }
  }

  const maxPerSession =
    options?.maxUpstreamConnectionsPerTcpSession ??
    DEFAULT_SSH_MAX_UPSTREAM_CONNECTIONS_PER_TCP_SESSION;
  if (!Number.isInteger(maxPerSession) || maxPerSession <= 0) {
    throw new Error(
      "ssh.maxUpstreamConnectionsPerTcpSession must be an integer > 0",
    );
  }

  const maxTotal =
    options?.maxUpstreamConnectionsTotal ??
    DEFAULT_SSH_MAX_UPSTREAM_CONNECTIONS_TOTAL;
  if (!Number.isInteger(maxTotal) || maxTotal <= 0) {
    throw new Error("ssh.maxUpstreamConnectionsTotal must be an integer > 0");
  }

  const readyTimeoutMs =
    options?.upstreamReadyTimeoutMs ?? DEFAULT_SSH_UPSTREAM_READY_TIMEOUT_MS;
  if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs <= 0) {
    throw new Error("ssh.upstreamReadyTimeoutMs must be an integer > 0");
  }

  const keepaliveIntervalMs =
    options?.upstreamKeepaliveIntervalMs ??
    DEFAULT_SSH_UPSTREAM_KEEPALIVE_INTERVAL_MS;
  if (!Number.isInteger(keepaliveIntervalMs) || keepaliveIntervalMs < 0) {
    throw new Error(
      "ssh.upstreamKeepaliveIntervalMs must be an integer >= 0",
    );
  }

  const keepaliveCountMax =
    options?.upstreamKeepaliveCountMax ??
    DEFAULT_SSH_UPSTREAM_KEEPALIVE_COUNT_MAX;
  if (!Number.isInteger(keepaliveCountMax) || keepaliveCountMax < 0) {
    throw new Error("ssh.upstreamKeepaliveCountMax must be an integer >= 0");
  }

  const enabled = allowedTargets.length > 0;


  return {
    enabled,
    allowedTargets,
    sniffPorts,
    sniffPortsSet,
    credentials,
    agent,
    hostKey,
    hostVerifier,
    execPolicy,
    maxUpstreamConnectionsPerTcpSession: maxPerSession,
    maxUpstreamConnectionsTotal: maxTotal,
    upstreamReadyTimeoutMs: readyTimeoutMs,
    upstreamKeepaliveIntervalMs: keepaliveIntervalMs,
    upstreamKeepaliveCountMax: keepaliveCountMax,
    upstreams: new Set(),
  };
}

/** @internal */
export function assertSshDnsConfig(options: {
  ssh: QemuSshInternals;
  dnsMode: DnsMode;
  syntheticHostMapping: SyntheticDnsHostMappingMode;
}) {
  const { ssh, dnsMode, syntheticHostMapping } = options;
  if (!ssh.enabled) return;

  if (dnsMode !== "synthetic") {
    throw new Error("ssh egress requires dns mode 'synthetic'");
  }

  if (syntheticHostMapping !== "per-host") {
    throw new Error("ssh egress requires dns syntheticHostMapping='per-host'");
  }

  if (ssh.credentials.length === 0 && !ssh.agent) {
    throw new Error(
      "ssh egress requires at least one credential or ssh agent (direct ssh is not supported)",
    );
  }

  if (!ssh.hostVerifier) {
    throw new Error(
      "ssh egress requires ssh.hostVerifier to validate upstream host keys",
    );
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function resolveSshCredential(
  ssh: QemuSshInternals,
  hostname: string,
  port: number,
): ResolvedSshCredential | null {
  const normalized = hostname.toLowerCase();
  for (const credential of ssh.credentials) {
    if (credential.port !== port) continue;
    if (matchHostname(normalized, credential.pattern)) {
      return credential;
    }
  }
  return null;
}

/** @internal */
export function isSshFlowAllowed(
  backend: QemuNetworkBackend,
  key: string,
  _dstIP: string,
  dstPort: number,
): boolean {
  const ssh = backend.ssh;
  if (!ssh.enabled) return false;

  const session = backend.tcpSessions.get(key);
  const hostname = session?.syntheticHostname ?? null;
  if (!hostname) return false;

  const normalized = hostname.toLowerCase();
  const allowed = ssh.allowedTargets.some(
    (target) =>
      target.port === dstPort && matchHostname(normalized, target.pattern),
  );
  if (!allowed) return false;

  const credential = resolveSshCredential(ssh, hostname, dstPort);
  const canUseAgent = Boolean(ssh.agent);

  // SSH egress is always proxied via the host; without a credential or agent we can't
  // authenticate upstream and must deny the flow.
  if (!credential && !canUseAgent) {
    return false;
  }

  if (session) {
    session.connectIP = hostname;
    session.syntheticHostname = hostname;

    session.ssh = session.ssh ?? { credential: null };
    session.ssh.credential = credential;
  }

  return true;
}

function closeSshProxySession(backend: QemuNetworkBackend, proxy?: SshProxySession) {
  if (!proxy) return;
  try {
    proxy.connection?.end();
  } catch {
    // ignore
  }

  // A guest SSH connection can spawn multiple exec channels concurrently.
  // Each exec uses its own upstream SshClient, so make sure we close all of them.
  for (const upstream of proxy.upstreams) {
    backend.ssh.upstreams.delete(upstream);
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

/** @internal */
export function cleanupSshTcpSession(backend: QemuNetworkBackend, session: TcpSession) {
  if (!session.ssh) return;
  closeSshProxySession(backend, session.ssh.proxy);
  session.ssh = undefined;
}

function getOrCreateSshHostKey(backend: QemuNetworkBackend): string {
  if (backend.ssh.hostKey !== null) {
    return backend.ssh.hostKey;
  }
  backend.ssh.hostKey = generateSshHostKey();
  return backend.ssh.hostKey;
}

function ensureSshProxySession(
  backend: QemuNetworkBackend,
  key: string,
  session: TcpSession,
): SshProxySession {
  const existing = session.ssh?.proxy;
  if (existing) return existing;

  if (!session.syntheticHostname) {
    throw new Error("ssh proxy requires synthetic hostname");
  }

  const credential = session.ssh?.credential ?? null;
  if (!credential && !backend.ssh.agent) {
    throw new Error("ssh proxy requires credential or ssh agent");
  }

  const stream = new GuestSshStream(
    async (chunk) => {
      backend.stack?.handleTcpData({ key, data: chunk });
      backend.flush();
      await backend.waitForFlowResume(key);
    },
    async () => {
      backend.stack?.handleTcpEnd({ key });
      backend.flush();
    },
  );

  const server = new SshServer({
    hostKeys: [getOrCreateSshHostKey(backend)],
    ident: "SSH-2.0-gondolin-ssh-proxy",
  });

  const proxy: SshProxySession = {
    stream,
    server,
    connection: null,
    upstreams: new Set(),
  };

  const onProxyError = (err: unknown) => {
    backend.abortTcpSession(
      key,
      session,
      `ssh-proxy-error (${formatError(err)})`,
    );
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
        attachSshSessionHandlers({
          backend,
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

  session.ssh = session.ssh ?? { credential: null };
  session.ssh.proxy = proxy;

  if (backend.options.debug) {
    backend.emitDebug(
      `ssh proxy start ${session.srcIP}:${session.srcPort} -> ${session.syntheticHostname}:${session.dstPort}`,
    );
  }

  return proxy;
}

function attachSshSessionHandlers(options: {
  backend: QemuNetworkBackend;
  key: string;
  session: TcpSession;
  proxy: SshProxySession;
  sshSession: SshServerSession;
  guestUsername: string;
}) {
  const { backend, key, session, proxy, sshSession, guestUsername } = options;

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
    ch.stderr.write(
      "gondolin ssh proxy: interactive shells are not supported\n",
    );
    ch.exit(1);
    ch.close();
  });

  sshSession.on("exec", (accept, _reject, info) => {
    if (typeof accept !== "function") return;
    const guestChannel = accept();
    bridgeSshExecChannel({
      backend,
      key,
      session,
      proxy,
      guestChannel,
      command: info.command,
      guestUsername,
    }).catch((err) => {
      try {
        guestChannel.stderr.write(
          Buffer.from(`gondolin ssh proxy error: ${formatError(err)}\n`, "utf8"),
        );
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

/** @internal */
export async function bridgeSshExecChannel(options: {
  backend: QemuNetworkBackend;
  key: string;
  session: TcpSession;
  proxy: SshProxySession;
  guestChannel: SshServerChannel;
  command: string;
  guestUsername: string;
}) {
  const { backend, key, session, proxy, guestChannel, command, guestUsername } =
    options;
  const hostname = session.syntheticHostname;
  const credential = session.ssh?.credential ?? null;
  if (!hostname) {
    throw new Error("missing ssh proxy hostname");
  }
  if (!credential && !backend.ssh.agent) {
    throw new Error("missing ssh proxy credential/agent");
  }

  if (backend.ssh.execPolicy) {
    const decision = await backend.ssh.execPolicy({
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
      if (backend.options.debug) {
        backend.emitDebug(
          `ssh proxy exec denied ${hostname}:${session.dstPort} ${JSON.stringify(command)}`,
        );
      }
      return;
    }
  }

  if (proxy.upstreams.size >= backend.ssh.maxUpstreamConnectionsPerTcpSession) {
    throw new Error(
      `too many concurrent upstream ssh connections for this guest flow (limit ${backend.ssh.maxUpstreamConnectionsPerTcpSession})`,
    );
  }
  if (backend.ssh.upstreams.size >= backend.ssh.maxUpstreamConnectionsTotal) {
    throw new Error(
      `too many concurrent upstream ssh connections on host (limit ${backend.ssh.maxUpstreamConnectionsTotal})`,
    );
  }

  const upstream = new SshClient();
  proxy.upstreams.add(upstream);
  backend.ssh.upstreams.add(upstream);

  const removeUpstream = () => {
    proxy.upstreams.delete(upstream);
    backend.ssh.upstreams.delete(upstream);
  };

  // Ensure we don't retain references if the client closes unexpectedly.
  upstream.once("close", removeUpstream);

  const connectConfig: import("ssh2").ConnectConfig = {
    host: hostname,
    port: session.dstPort,
    username: credential
      ? (credential.username ?? "git")
      : guestUsername || "git",
    readyTimeout: backend.ssh.upstreamReadyTimeoutMs,
    keepaliveInterval: backend.ssh.upstreamKeepaliveIntervalMs,
    keepaliveCountMax: backend.ssh.upstreamKeepaliveCountMax,
  };

  if (credential) {
    connectConfig.privateKey = credential.privateKey;
    connectConfig.passphrase = credential.passphrase;
  } else if (backend.ssh.agent) {
    connectConfig.agent = backend.ssh.agent;
  }

  if (backend.ssh.hostVerifier) {
    connectConfig.hostVerifier = (key: Buffer) =>
      backend.ssh.hostVerifier!(hostname, key, session.dstPort);
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
      upstream.once("close", () =>
        settleReject(new Error("upstream ssh closed before ready")),
      );
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

  if (backend.options.debug) {
    backend.emitDebug(`ssh proxy exec ${hostname} ${JSON.stringify(command)}`);
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
    backend.abortTcpSession(
      key,
      session,
      `ssh-upstream-channel-error (${formatError(err)})`,
    );
  });

  upstream.on("error", (err: Error) => {
    backend.abortTcpSession(key, session, `ssh-upstream-error (${formatError(err)})`);
  });
}

/** @internal */
export function handleSshProxyData(
  backend: QemuNetworkBackend,
  key: string,
  session: TcpSession,
  data: Buffer,
) {
  try {
    const proxy = ensureSshProxySession(backend, key, session);
    proxy.stream.pushFromGuest(data);
  } catch (err) {
    backend.abortTcpSession(
      key,
      session,
      `ssh-proxy-init-error (${formatError(err)})`,
    );
  }
}

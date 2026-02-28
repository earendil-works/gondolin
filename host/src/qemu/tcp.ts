import net from "net";

import type { DnsMode, SyntheticDnsHostMappingMode } from "./contracts";

export type TcpOptions = {
  /** guest host[:port] -> upstream host:port mappings */
  hosts: Record<string, string>;
};

export type TcpMappedTarget = {
  /** guest hostname derived from synthetic dns */
  hostname: string;
  /** optional guest destination port match */
  port: number | null;
  /** upstream connect host */
  connectHost: string;
  /** upstream connect port */
  connectPort: number;
};

/** @internal */
export type QemuTcpInternals = {
  /** whether mapped tcp egress is enabled */
  enabled: boolean;
  /** normalized mapping rules */
  rules: TcpMappedTarget[];
  /** exact host:port mapping lookup */
  byHostPort: Map<string, TcpMappedTarget>;
  /** host-wide mapping lookup */
  byHost: Map<string, TcpMappedTarget>;
};

type ParsedHostPort = {
  host: string;
  port: number | null;
};

function normalizeHost(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) return "";

  const family = net.isIP(trimmed);
  if (family === 4 || family === 6) {
    return trimmed.toLowerCase();
  }

  return trimmed.toLowerCase().replace(/\.+$/, "");
}

function parseHostPort(
  raw: string,
  options: {
    requirePort: boolean;
    context: string;
  },
): ParsedHostPort {
  const input = raw.trim();
  if (!input) {
    throw new Error(`${options.context} must not be empty`);
  }

  let host = input;
  let port: number | null = null;

  if (input.startsWith("[")) {
    const end = input.indexOf("]");
    if (end === -1) {
      throw new Error(`${options.context} has invalid bracket syntax: ${raw}`);
    }

    host = input.slice(1, end);
    const rest = input.slice(end + 1);
    if (rest.length > 0) {
      if (!rest.startsWith(":")) {
        throw new Error(
          `${options.context} has invalid bracket syntax: ${raw}`,
        );
      }
      const portStr = rest.slice(1);
      if (!/^[0-9]+$/.test(portStr)) {
        throw new Error(`${options.context} has invalid port: ${raw}`);
      }
      port = Number.parseInt(portStr, 10);
    }
  } else {
    const idx = input.lastIndexOf(":");
    if (idx !== -1) {
      const maybePort = input.slice(idx + 1);
      if (/^[0-9]+$/.test(maybePort)) {
        host = input.slice(0, idx);
        port = Number.parseInt(maybePort, 10);
      }
    }
  }

  host = normalizeHost(host);
  if (!host) {
    throw new Error(`${options.context} host must not be empty: ${raw}`);
  }

  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    throw new Error(
      `${options.context} port must be in range 1..65535: ${raw}`,
    );
  }

  if (options.requirePort && port === null) {
    throw new Error(`${options.context} requires an explicit :PORT: ${raw}`);
  }

  return { host, port };
}

function parseMappingKey(raw: string): ParsedHostPort {
  const parsed = parseHostPort(raw, {
    requirePort: false,
    context: "tcp.hosts key",
  });

  if (parsed.host.includes("*")) {
    throw new Error(`tcp.hosts key does not support wildcard '*': ${raw}`);
  }

  return parsed;
}

function parseMappingTarget(raw: string): ParsedHostPort {
  const parsed = parseHostPort(raw, {
    requirePort: true,
    context: "tcp.hosts value",
  });

  if (parsed.host.includes("*")) {
    throw new Error(`tcp.hosts value does not support wildcard '*': ${raw}`);
  }

  return parsed;
}

/** @internal */
export function createQemuTcpInternals(options?: TcpOptions): QemuTcpInternals {
  const byHostPort = new Map<string, TcpMappedTarget>();
  const byHost = new Map<string, TcpMappedTarget>();
  const rules: TcpMappedTarget[] = [];

  const hosts = options?.hosts ?? {};

  for (const [rawKey, rawValue] of Object.entries(hosts)) {
    const match = parseMappingKey(rawKey);
    const target = parseMappingTarget(rawValue);

    const rule: TcpMappedTarget = {
      hostname: match.host,
      port: match.port,
      connectHost: target.host,
      connectPort: target.port!,
    };

    if (match.port !== null) {
      const key = `${match.host}:${match.port}`;
      if (byHostPort.has(key)) {
        throw new Error(`duplicate tcp.hosts mapping for ${key}`);
      }
      byHostPort.set(key, rule);
    } else {
      if (byHost.has(match.host)) {
        throw new Error(`duplicate tcp.hosts mapping for ${match.host}`);
      }
      byHost.set(match.host, rule);
    }

    rules.push(rule);
  }

  return {
    enabled: rules.length > 0,
    rules,
    byHostPort,
    byHost,
  };
}

/** @internal */
export function assertTcpDnsConfig(options: {
  tcp: QemuTcpInternals;
  dnsMode: DnsMode;
  syntheticHostMapping: SyntheticDnsHostMappingMode;
}) {
  const { tcp, dnsMode, syntheticHostMapping } = options;
  if (!tcp.enabled) return;

  if (dnsMode !== "synthetic") {
    throw new Error("tcp host mapping requires dns mode 'synthetic'");
  }

  if (syntheticHostMapping !== "per-host") {
    throw new Error(
      "tcp host mapping requires dns syntheticHostMapping='per-host'",
    );
  }
}

/** @internal */
export function resolveMappedTcpTarget(
  tcp: QemuTcpInternals,
  hostname: string | null,
  dstPort: number,
): TcpMappedTarget | null {
  if (!tcp.enabled || !hostname) return null;

  const normalizedHost = normalizeHost(hostname);
  if (!normalizedHost) return null;

  const exact = tcp.byHostPort.get(`${normalizedHost}:${dstPort}`);
  if (exact) return exact;

  return tcp.byHost.get(normalizedHost) ?? null;
}

import net from "net";

import type { DnsMode, SyntheticDnsHostMappingMode } from "./contracts.ts";

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

type TcpWildcardMappedTarget = TcpMappedTarget & {
  /** normalized suffix matched by a leading-label wildcard */
  wildcardSuffix: string;
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
  /** wildcard host:port mappings sorted by most-specific suffix first */
  wildcardHostPort: TcpWildcardMappedTarget[];
  /** wildcard host-wide mappings sorted by most-specific suffix first */
  wildcardHost: TcpWildcardMappedTarget[];
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

  if (parsed.host.includes("*") && !isValidWildcardHost(parsed.host)) {
    throw new Error(
      `tcp.hosts key wildcard must be a leading subdomain pattern like '*.example.com': ${raw}`,
    );
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

function isValidWildcardHost(host: string): boolean {
  if (!host.startsWith("*.")) return false;

  const suffix = host.slice(2);
  if (!suffix || suffix.includes("*")) return false;
  if (net.isIP(suffix)) return false;

  const labels = suffix.split(".");
  return labels.length >= 2 && labels.every((label) => label.length > 0);
}

function wildcardSuffix(host: string): string | null {
  return isValidWildcardHost(host) ? host.slice(2) : null;
}

function wildcardMatchesHost(hostname: string, suffix: string): boolean {
  return (
    hostname.length > suffix.length + 1 &&
    hostname.endsWith(`.${suffix}`)
  );
}

function sortWildcardTargets(
  targets: TcpWildcardMappedTarget[],
): TcpWildcardMappedTarget[] {
  return targets.sort(
    (a, b) => b.wildcardSuffix.length - a.wildcardSuffix.length,
  );
}

/** @internal */
export function createQemuTcpInternals(options?: TcpOptions): QemuTcpInternals {
  const byHostPort = new Map<string, TcpMappedTarget>();
  const byHost = new Map<string, TcpMappedTarget>();
  const wildcardHostPort: TcpWildcardMappedTarget[] = [];
  const wildcardHost: TcpWildcardMappedTarget[] = [];
  const wildcardKeys = new Set<string>();
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

    const suffix = wildcardSuffix(match.host);
    if (suffix) {
      const key = `${match.host}${match.port === null ? "" : `:${match.port}`}`;
      if (wildcardKeys.has(key)) {
        throw new Error(`duplicate tcp.hosts mapping for ${key}`);
      }
      wildcardKeys.add(key);

      const wildcardRule: TcpWildcardMappedTarget = {
        ...rule,
        wildcardSuffix: suffix,
      };
      if (match.port !== null) {
        wildcardHostPort.push(wildcardRule);
      } else {
        wildcardHost.push(wildcardRule);
      }
      rules.push(rule);
      continue;
    }

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
    wildcardHostPort: sortWildcardTargets(wildcardHostPort),
    wildcardHost: sortWildcardTargets(wildcardHost),
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

  const hostOnly = tcp.byHost.get(normalizedHost);
  if (hostOnly) return hostOnly;

  const wildcardExact = tcp.wildcardHostPort.find(
    (target) =>
      target.port === dstPort &&
      wildcardMatchesHost(normalizedHost, target.wildcardSuffix),
  );
  if (wildcardExact) return wildcardExact;

  return (
    tcp.wildcardHost.find((target) =>
      wildcardMatchesHost(normalizedHost, target.wildcardSuffix),
    ) ?? null
  );
}

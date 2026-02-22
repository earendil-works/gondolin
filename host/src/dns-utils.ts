import net from "net";
import dns from "dns";

const SYNTHETIC_DNS_HOSTMAP_PREFIX_A = 198;
const SYNTHETIC_DNS_HOSTMAP_PREFIX_B = 19;

export function normalizeIpv4Servers(servers?: string[]): string[] {
  const candidates = (
    servers && servers.length > 0 ? servers : dns.getServers()
  )
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

export class SyntheticDnsHostMap {
  private readonly hostToIp = new Map<string, string>();
  private readonly ipToHost = new Map<string, string>();
  private nextHostId = 1;

  /**
   * Allocate (or retrieve) a stable synthetic IPv4 for a hostname
   *
   * Returns null for invalid/unsupported hostnames or if the mapping space is exhausted
   * This method must be safe to call on untrusted guest input
   */
  allocate(hostname: string): string | null {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    // DNS names are limited to 253 chars in presentation format (without trailing dot)
    // Treat anything larger as invalid to avoid unbounded memory usage
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

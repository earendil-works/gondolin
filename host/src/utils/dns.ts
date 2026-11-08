import net from "node:net";
import dns from "node:dns";

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

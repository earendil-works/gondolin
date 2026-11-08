import net from "node:net";

/**
 * Parse an IPv4 address into bytes.
 *
 * Note: intentionally permissive (allows leading zeros) to match existing callers.
 */
export function parseIPv4Bytes(ip: string): Buffer | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => Number(p));
  if (!bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return null;
  }
  return Buffer.from(bytes);
}

/** Parse an IPv4 address into the two hextets used for embedded IPv4-in-IPv6 */
function parseIPv4ToHextets(ip: string): [number, number] | null {
  const buf = parseIPv4Bytes(ip);
  if (!buf) return null;
  return [buf.readUInt16BE(0), buf.readUInt16BE(2)];
}

/**
 * Parse an IPv6 address into 8 hextets.
 *
 * Supports :: compression and embedded IPv4.
 */
export function parseIPv6Hextets(ip: string): number[] | null {
  // Guard against malformed inputs (and keep semantics aligned with other parsers)
  if (net.isIP(ip) !== 6) return null;

  const normalized = ip.toLowerCase();
  const splitIndex = normalized.indexOf("::");

  if (splitIndex !== -1) {
    const leftPart = normalized.slice(0, splitIndex);
    const rightPart = normalized.slice(splitIndex + 2);
    const left = leftPart ? leftPart.split(":") : [];
    const right = rightPart ? rightPart.split(":") : [];

    const leftExpanded = expandIpv6Parts(left);
    const rightExpanded = expandIpv6Parts(right);
    if (!leftExpanded || !rightExpanded) return null;

    const missing = 8 - (leftExpanded.length + rightExpanded.length);
    if (missing < 0) return null;

    return [...leftExpanded, ...Array(missing).fill(0), ...rightExpanded];
  }

  const parts = normalized.split(":");
  const expanded = expandIpv6Parts(parts);
  if (expanded?.length !== 8) return null;
  return expanded;
}

function expandIpv6Parts(parts: string[]): number[] | null {
  const expanded: number[] = [];

  for (const part of parts) {
    if (part.includes(".")) {
      const v4 = parseIPv4ToHextets(part);
      if (!v4) return null;
      expanded.push(...v4);
      continue;
    }

    if (part.length === 0) continue;
    const value = parseInt(part, 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) return null;
    expanded.push(value);
  }

  return expanded;
}

/** Whether an ip address is in a loopback, private, link-local or otherwise internal range */
export function isInternalIpAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isInternalIPv4(ip);
  if (family === 6) return isInternalIPv6(ip);
  return false;
}

function isInternalIPv4(ip: string): boolean {
  const octets = ip.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [a, b] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 255) return true;
  return false;
}

function hextetsToIPv4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * IPv4 addresses embedded in IPv6 transition formats (NAT64 RFC 6052, 6to4,
 * Teredo, IPv4-mapped/-compatible): a destination like `64:ff9b::127.0.0.1`
 * reaches the embedded address through a translator.
 */
export function embeddedIPv4Addresses(hextets: number[]): string[] {
  if (hextets.length !== 8) return [];
  const h = hextets;
  const b: number[] = [];
  for (const x of h) b.push(x >> 8, x & 0xff);
  const out: string[] = [];
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
    out.push(hextetsToIPv4(h[6]!, h[7]!));
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
    out.push(hextetsToIPv4(h[6]!, h[7]!));
  }
  // NAT64 local-use prefix 64:ff9b:1::/48: the embedding depends on the
  // network's prefix length (/48../96, RFC 6052), so every candidate counts;
  // the zero candidates make this fail closed for the whole prefix
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) {
    out.push(`${b[6]}.${b[7]}.${b[9]}.${b[10]}`); // /48 (bits 64..71: "u" octet)
    out.push(`${b[7]}.${b[9]}.${b[10]}.${b[11]}`); // /56
    out.push(`${b[9]}.${b[10]}.${b[11]}.${b[12]}`); // /64
    out.push(hextetsToIPv4(h[6]!, h[7]!)); // /96
  }
  // 6to4 2002:a.b.c.d::/48
  if (h[0] === 0x2002) {
    out.push(hextetsToIPv4(h[1]!, h[2]!));
  }
  // Teredo 2001:0::/32: server address and the obfuscated client address
  if (h[0] === 0x2001 && h[1] === 0) {
    out.push(hextetsToIPv4(h[2]!, h[3]!));
    out.push(hextetsToIPv4(~h[6]! & 0xffff, ~h[7]! & 0xffff));
  }
  return out;
}

function isInternalIPv6(ip: string): boolean {
  const hextets = parseIPv6Hextets(ip);
  if (!hextets) return false;

  const isAllZero = hextets.every((value) => value === 0);
  const isLoopback =
    hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1;
  if (isAllZero || isLoopback) return true;

  if ((hextets[0]! & 0xfe00) === 0xfc00) return true;
  if ((hextets[0]! & 0xffc0) === 0xfe80) return true;

  return embeddedIPv4Addresses(hextets).some(isInternalIPv4);
}

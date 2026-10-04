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

function ipv6HextetsToBytes(hextets: number[]): Buffer | null {
  if (hextets.length !== 8) return null;
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    buf.writeUInt16BE(hextets[i]!, i * 2);
  }
  return buf;
}

export function parseIPv6Bytes(ip: string): Buffer | null {
  const hextets = parseIPv6Hextets(ip);
  if (!hextets) return null;
  return ipv6HextetsToBytes(hextets);
}

/** Extract an IPv4 address from an IPv4-mapped IPv6 address (e.g. ::ffff:1.2.3.4) */
export function extractIPv4Mapped(hextets: number[]): string | null {
  if (hextets.length !== 8) return null;
  const prefixZero = hextets.slice(0, 5).every((value) => value === 0);
  if (!prefixZero || hextets[5] !== 0xffff) return null;

  const a = hextets[6]! >> 8;
  const b = hextets[6]! & 0xff;
  const c = hextets[7]! >> 8;
  const d = hextets[7]! & 0xff;
  return `${a}.${b}.${c}.${d}`;
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

function isInternalIPv6(ip: string): boolean {
  const hextets = parseIPv6Hextets(ip);
  if (!hextets) return false;

  const isAllZero = hextets.every((value) => value === 0);
  const isLoopback =
    hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1;
  if (isAllZero || isLoopback) return true;

  if ((hextets[0]! & 0xfe00) === 0xfc00) return true;
  if ((hextets[0]! & 0xffc0) === 0xfe80) return true;

  const mapped = extractIPv4Mapped(hextets);
  if (mapped && isInternalIPv4(mapped)) return true;

  return false;
}

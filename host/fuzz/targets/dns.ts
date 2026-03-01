import {
  parseDnsQuery,
  buildSyntheticDnsResponse,
  DNS_TYPE_A,
  DNS_TYPE_AAAA,
  DNS_CLASS_IN,
} from "../../src/qemu/dns.ts";
import { XorShift32 } from "../rng.ts";
import type { FuzzTarget } from "./types.ts";

function seedQuery(name: string, type: number): Buffer {
  // Minimal DNS query with 1 question, no compression.
  // Header: id=0x1234, flags=0x0100 (RD), qdcount=1
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const labels = name.split(".").filter(Boolean);
  const parts: Buffer[] = [header];
  for (const label of labels) {
    const b = Buffer.from(label, "ascii");
    parts.push(Buffer.from([b.length & 0x3f]));
    parts.push(b);
  }
  parts.push(Buffer.from([0]));

  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0);
  q.writeUInt16BE(DNS_CLASS_IN, 2);
  parts.push(q);
  return Buffer.concat(parts);
}

export const dnsTarget: FuzzTarget = {
  name: "dns",
  description: "dns.parseDnsQuery + buildSyntheticDnsResponse",
  defaultMaxLen: 2048,
  seeds: [
    seedQuery("example.com", DNS_TYPE_A),
    seedQuery("example.com", DNS_TYPE_AAAA),
    seedQuery("localhost", DNS_TYPE_A),
  ],
  runOne(input: Buffer, _rng: XorShift32): boolean {
    // parseDnsQuery should never throw on untrusted input.
    const q = parseDnsQuery(input);
    if (!q) return false;

    // buildSyntheticDnsResponse should never throw for a ParsedDnsQuery returned by parseDnsQuery.
    const resp = buildSyntheticDnsResponse(q, {
      ipv4: "1.2.3.4",
      ipv6: "2001:db8::1",
      ttlSeconds: 30,
    });

    // Basic sanity: response must start with same transaction id.
    if (resp.length >= 2 && resp.readUInt16BE(0) !== q.id) {
      throw new Error("dns: response id mismatch");
    }
    return true;
  },
};

import { parseIPv4Bytes, parseIPv6Bytes } from "../utils/ip.ts";

/** DNS record type A */
export const DNS_TYPE_A = 1;
/** DNS record type AAAA */
export const DNS_TYPE_AAAA = 28;

/** DNS class IN */
export const DNS_CLASS_IN = 1;

export type ParsedDnsQuestion = {
  /** question name in presentation format */
  name: string;
  /** question type */
  type: number;
  /** question class */
  qclass: number;
};

export type ParsedDnsQuery = {
  /** transaction id */
  id: number;
  /** request flags */
  flags: number;
  /** raw wire bytes of the first question (for synthetic answers) */
  questionSection: Buffer;
  /** first question (used for synthetic answers) */
  firstQuestion: ParsedDnsQuestion;
};

export type SyntheticDnsResponseOptions = {
  /** synthetic ipv4 A response address */
  ipv4: string;
  /** synthetic ipv6 AAAA response address */
  ipv6: string;
  /** response ttl in `seconds` */
  ttlSeconds: number;
};

export function isProbablyDnsPacket(packet: Buffer): boolean {
  // DNS header is 12 bytes
  return packet.length >= 12;
}

function parseName(
  packet: Buffer,
  offset: number,
): { name: string; nextOffset: number } | null {
  const labels: string[] = [];
  let off = offset;
  let seen = 0;

  // This intentionally does NOT support compression pointers for queries.
  // For our purposes (synthetic responses) we only need typical stub resolver queries.
  while (true) {
    if (off >= packet.length) return null;
    const len = packet[off++]!;

    if (len === 0) break;

    // Compression pointer
    if ((len & 0xc0) === 0xc0) {
      // We intentionally do NOT support compression pointers for queries.
      // Reject them outright to avoid recursion/cycle hazards on untrusted input.
      return null;
    }

    if (len > 63) return null;
    if (off + len > packet.length) return null;
    const label = packet.subarray(off, off + len).toString("ascii");
    off += len;
    labels.push(label);
    if (++seen > 128) return null;
  }

  const name = labels
    .filter((part) => part.length > 0)
    .join(".")
    .toLowerCase();

  return { name, nextOffset: off };
}

export function parseDnsQuery(packet: Buffer): ParsedDnsQuery | null {
  if (packet.length < 12) return null;

  const id = packet.readUInt16BE(0);
  const flags = packet.readUInt16BE(2);
  const qdcount = packet.readUInt16BE(4);
  const ancount = packet.readUInt16BE(6);
  const nscount = packet.readUInt16BE(8);

  // Basic query sanity checks.
  // - QR must be 0 (query)
  // - opcode must be 0 (standard query)
  // - we don't expect answers/authority records in a query
  const qr = (flags & 0x8000) !== 0;
  const opcode = (flags >>> 11) & 0x0f;
  if (qr) return null;
  if (opcode !== 0) return null;
  if (ancount !== 0 || nscount !== 0) return null;

  // Only handle queries with at least one question.
  if (qdcount < 1) return null;

  // Cap to avoid pathological payloads.
  if (qdcount > 16) return null;

  let off = 12;
  let firstQuestion: ParsedDnsQuestion | null = null;
  let firstQuestionEnd: number | null = null;

  for (let i = 0; i < qdcount; i++) {
    const nameRes = parseName(packet, off);
    if (!nameRes) return null;
    off = nameRes.nextOffset;
    if (off + 4 > packet.length) return null;
    const type = packet.readUInt16BE(off);
    const qclass = packet.readUInt16BE(off + 2);
    off += 4;

    if (!firstQuestion) {
      firstQuestion = { name: nameRes.name, type, qclass };
      firstQuestionEnd = off;
    }
  }

  if (!firstQuestion || firstQuestionEnd === null) return null;

  // For synthetic responses we only ever answer the first question.
  // Preserve the exact wire bytes of that first question and always respond with QDCOUNT=1.
  const questionSection = packet.subarray(12, firstQuestionEnd);
  return {
    id,
    flags,
    questionSection: Buffer.from(questionSection),
    firstQuestion,
  };
}

/** RFC 6761 localhost name match */
export function isLocalhostDnsName(name: string): boolean {
  const n = name.toLowerCase();
  return n === "localhost" || n.endsWith(".localhost");
}

export function buildSyntheticDnsResponse(
  query: ParsedDnsQuery,
  options: SyntheticDnsResponseOptions,
): Buffer {
  // Copy RD bit from request, set QR + RA.
  const RD = query.flags & 0x0100;
  const flags = 0x8000 | RD | 0x0080; // QR=1, RD=?, RA=1

  const question = query.firstQuestion;

  const effectiveIpv4 = isLocalhostDnsName(question.name)
    ? "127.0.0.1"
    : options.ipv4;
  const effectiveIpv6 = isLocalhostDnsName(question.name)
    ? "::1"
    : options.ipv6;

  let answerType: number | null = null;
  let rdata: Buffer | null = null;

  if (question.qclass === DNS_CLASS_IN) {
    if (question.type === DNS_TYPE_A) {
      answerType = DNS_TYPE_A;
      rdata = parseIPv4Bytes(effectiveIpv4);
    } else if (question.type === DNS_TYPE_AAAA) {
      answerType = DNS_TYPE_AAAA;
      rdata = parseIPv6Bytes(effectiveIpv6);
    }
  }

  const hasAnswer = Boolean(answerType && rdata);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(hasAnswer ? 1 : 0, 6); // ancount
  header.writeUInt16BE(0, 8); // nscount
  header.writeUInt16BE(0, 10); // arcount

  const sections: Buffer[] = [header, query.questionSection];

  if (hasAnswer) {
    const rr = Buffer.alloc(2 + 2 + 2 + 4 + 2); // name ptr + type + class + ttl + rdlength
    rr.writeUInt16BE(0xc00c, 0); // pointer to qname at offset 12
    rr.writeUInt16BE(answerType!, 2);
    rr.writeUInt16BE(DNS_CLASS_IN, 4);
    rr.writeUInt32BE(Math.max(0, options.ttlSeconds) >>> 0, 6);
    rr.writeUInt16BE(rdata!.length, 10);
    sections.push(rr, rdata!);
  }

  return Buffer.concat(sections);
}

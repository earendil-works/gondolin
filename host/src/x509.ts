/**
 * Minimal X.509 certificate builder and parser on top of `node:crypto`.
 *
 * Node can generate keys, sign data and parse/verify certificates but cannot
 * create certificates, so this module implements just enough DER to build the
 * RSA/SHA-256 certificates used for TLS MITM and to inspect the extensions
 * that `X509Certificate` does not expose.
 */

import crypto from "node:crypto";
import net from "node:net";

/** Decoded DER tag-length-value element */
export type DerElement = {
  /** identifier octet (class, constructed bit and tag number) */
  tag: number;
  /** content octets */
  content: Buffer;
  /** full encoding including identifier and length octets */
  raw: Buffer;
};

/** X.509 v3 certificate extension */
export type CertificateExtension = {
  /** extension oid in dotted decimal notation */
  oid: string;
  critical: boolean;
  /** DER payload wrapped by the extnValue octet string */
  value: Buffer;
};

/** Fields of a certificate that `X509Certificate` does not expose */
export type ParsedCertificate = {
  /** content octets of the serialNumber integer (two's complement) */
  serialNumber: Buffer;
  /** DER encoded issuer name */
  issuer: Buffer;
  /** DER encoded subject name */
  subject: Buffer;
  extensions: CertificateExtension[];
};

export type CreateCertificateOptions = {
  /** public key certified by the certificate */
  publicKey: crypto.KeyObject;
  /** RSA key signing the certificate (the issuer key) */
  signingKey: crypto.KeyObject;
  /** content octets of the serialNumber integer (two's complement) */
  serialNumber: Buffer;
  notBefore: Date;
  notAfter: Date;
  /** DER encoded subject name */
  subject: Buffer;
  /** DER encoded issuer name */
  issuer: Buffer;
  extensions: CertificateExtension[];
};

export type KeyUsage = {
  digitalSignature?: boolean;
  keyEncipherment?: boolean;
  keyCertSign?: boolean;
  cRLSign?: boolean;
};

export const OID_SUBJECT_KEY_IDENTIFIER = "2.5.29.14";
export const OID_KEY_USAGE = "2.5.29.15";
export const OID_SUBJECT_ALT_NAME = "2.5.29.17";
export const OID_BASIC_CONSTRAINTS = "2.5.29.19";
export const OID_AUTHORITY_KEY_IDENTIFIER = "2.5.29.35";
export const OID_EXT_KEY_USAGE = "2.5.29.37";
export const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

const OID_COMMON_NAME = "2.5.4.3";
const OID_SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
const OID_ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";

const TAG_BOOLEAN = 0x01;
const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OCTET_STRING = 0x04;
const TAG_NULL = 0x05;
const TAG_OID = 0x06;
const TAG_UTF8_STRING = 0x0c;
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;

// ---------------------------------------------------------------------------
// DER encoding

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) {
    bytes.unshift(n & 0xff);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...contents: Buffer[]): Buffer {
  const content = Buffer.concat(contents);
  return Buffer.concat([
    Buffer.from([tag]),
    encodeLength(content.length),
    content,
  ]);
}

const sequence = (...contents: Buffer[]) => tlv(TAG_SEQUENCE, ...contents);

function encodeOid(oid: string): Buffer {
  const parts = oid.split(".").map((part) => Number(part));
  if (
    parts.length < 2 ||
    parts.some((p) => !Number.isSafeInteger(p) || p < 0)
  ) {
    throw new Error(`invalid oid: ${oid}`);
  }
  const arcs = [parts[0] * 40 + parts[1], ...parts.slice(2)];
  const bytes: number[] = [];
  for (const arc of arcs) {
    const chunk = [arc & 0x7f];
    for (let n = Math.floor(arc / 128); n > 0; n = Math.floor(n / 128)) {
      chunk.unshift(0x80 | (n & 0x7f));
    }
    bytes.push(...chunk);
  }
  return tlv(TAG_OID, Buffer.from(bytes));
}

function encodeTime(date: Date): Buffer {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const year = date.getUTCFullYear();
  const rest =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  // RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime afterwards
  if (year >= 1950 && year < 2050) {
    return tlv(TAG_UTC_TIME, Buffer.from(pad(year % 100) + rest, "ascii"));
  }
  return tlv(TAG_GENERALIZED_TIME, Buffer.from(pad(year, 4) + rest, "ascii"));
}

function encodeExtension(extension: CertificateExtension): Buffer {
  return sequence(
    encodeOid(extension.oid),
    // DER omits BOOLEAN fields equal to their DEFAULT (FALSE)
    extension.critical
      ? tlv(TAG_BOOLEAN, Buffer.from([0xff]))
      : Buffer.alloc(0),
    tlv(TAG_OCTET_STRING, extension.value),
  );
}

/** Encode a distinguished name consisting of a single common name */
export function encodeCommonNameName(commonName: string): Buffer {
  return sequence(
    tlv(
      TAG_SET,
      sequence(
        encodeOid(OID_COMMON_NAME),
        tlv(TAG_UTF8_STRING, Buffer.from(commonName, "utf8")),
      ),
    ),
  );
}

/** Create and sign a DER encoded X.509 v3 certificate */
export function createCertificate(options: CreateCertificateOptions): Buffer {
  const keyType = options.signingKey.asymmetricKeyType;
  if (keyType !== "rsa" && keyType !== "ec") {
    throw new Error("certificate signing key must be an RSA or ECDSA key");
  }
  if (options.serialNumber.length === 0) {
    throw new Error("certificate serial number must not be empty");
  }

  // RSA: sha256WithRSAEncryption (NULL parameters); ECDSA (CAs created by
  // gondolind): ecdsa-with-SHA256 (no parameters)
  const signatureAlgorithm =
    keyType === "rsa"
      ? sequence(encodeOid(OID_SHA256_WITH_RSA), tlv(TAG_NULL))
      : sequence(encodeOid(OID_ECDSA_WITH_SHA256));
  const spki = options.publicKey.export({ type: "spki", format: "der" });

  const tbsCertificate = sequence(
    // [0] EXPLICIT version: v3
    tlv(0xa0, tlv(TAG_INTEGER, Buffer.from([2]))),
    tlv(TAG_INTEGER, options.serialNumber),
    signatureAlgorithm,
    options.issuer,
    sequence(encodeTime(options.notBefore), encodeTime(options.notAfter)),
    options.subject,
    spki,
    options.extensions.length > 0
      ? tlv(0xa3, sequence(...options.extensions.map(encodeExtension)))
      : Buffer.alloc(0),
  );

  // RSA keys sign with PKCS#1 v1.5 padding, EC keys produce a DER
  // Ecdsa-Sig-Value (both the defaults)
  const signature = crypto.sign("sha256", tbsCertificate, options.signingKey);

  return sequence(
    tbsCertificate,
    signatureAlgorithm,
    tlv(TAG_BIT_STRING, Buffer.from([0]), signature),
  );
}

// ---------------------------------------------------------------------------
// Extension builders

export function basicConstraintsExtension(options: {
  ca: boolean;
  critical?: boolean;
}): CertificateExtension {
  return {
    oid: OID_BASIC_CONSTRAINTS,
    critical: options.critical ?? false,
    value: sequence(
      options.ca ? tlv(TAG_BOOLEAN, Buffer.from([0xff])) : Buffer.alloc(0),
    ),
  };
}

export function keyUsageExtension(
  usage: KeyUsage,
  critical = false,
): CertificateExtension {
  // RFC 5280 KeyUsage bit positions (bit 0 is the most significant bit)
  const bits = [
    usage.digitalSignature ? 0 : -1,
    usage.keyEncipherment ? 2 : -1,
    usage.keyCertSign ? 5 : -1,
    usage.cRLSign ? 6 : -1,
  ].filter((bit) => bit >= 0);
  if (bits.length === 0) {
    throw new Error("key usage must enable at least one bit");
  }

  const highestBit = Math.max(...bits);
  const bytes = Buffer.alloc(Math.floor(highestBit / 8) + 1);
  for (const bit of bits) {
    bytes[bit >> 3] |= 0x80 >> (bit & 7);
  }
  // DER named bit lists drop trailing zero bits
  const unusedBits = 7 - (highestBit % 8);

  return {
    oid: OID_KEY_USAGE,
    critical,
    value: tlv(TAG_BIT_STRING, Buffer.from([unusedBits]), bytes),
  };
}

export function extKeyUsageExtension(oids: string[]): CertificateExtension {
  return {
    oid: OID_EXT_KEY_USAGE,
    critical: false,
    value: sequence(...oids.map(encodeOid)),
  };
}

/** Encode an IPv4 or IPv6 address as network order bytes */
export function ipAddressToBytes(address: string): Buffer {
  if (net.isIPv4(address)) {
    return Buffer.from(address.split(".").map((part) => Number(part)));
  }
  if (!net.isIPv6(address)) {
    throw new Error(`invalid ip address: ${address}`);
  }

  let rest = address.split("%")[0];
  const groups: number[] = [];

  // Trailing embedded IPv4 address (e.g. ::ffff:192.0.2.1)
  const lastColon = rest.lastIndexOf(":");
  const lastPart = rest.slice(lastColon + 1);
  const embedded: number[] = [];
  if (lastPart.includes(".")) {
    const octets = lastPart.split(".").map((part) => Number(part));
    embedded.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    rest = rest.slice(0, lastColon + 1);
    if (!rest.endsWith("::")) rest = rest.slice(0, -1);
  }

  const parseGroups = (part: string) =>
    part === "" ? [] : part.split(":").map((group) => parseInt(group, 16));

  const gap = rest.indexOf("::");
  if (gap === -1) {
    groups.push(...parseGroups(rest), ...embedded);
  } else {
    const head = parseGroups(rest.slice(0, gap));
    const tail = [...parseGroups(rest.slice(gap + 2)), ...embedded];
    const zeros = 8 - head.length - tail.length;
    groups.push(...head, ...new Array<number>(zeros).fill(0), ...tail);
  }

  if (groups.length !== 8) {
    throw new Error(`invalid ip address: ${address}`);
  }
  const bytes = Buffer.alloc(16);
  for (const [index, group] of groups.entries()) {
    bytes.writeUInt16BE(group, index * 2);
  }
  return bytes;
}

/** Subject alternative name for a DNS name or an IP address literal */
export function subjectAltNameExtension(name: string): CertificateExtension {
  const generalName = net.isIP(name)
    ? tlv(0x87, ipAddressToBytes(name)) // [7] iPAddress
    : tlv(0x82, Buffer.from(name, "ascii")); // [2] dNSName
  return {
    oid: OID_SUBJECT_ALT_NAME,
    critical: false,
    value: sequence(generalName),
  };
}

export function subjectKeyIdentifierExtension(
  keyIdentifier: Buffer,
): CertificateExtension {
  return {
    oid: OID_SUBJECT_KEY_IDENTIFIER,
    critical: false,
    value: tlv(TAG_OCTET_STRING, keyIdentifier),
  };
}

export function authorityKeyIdentifierExtension(
  keyIdentifier: Buffer,
): CertificateExtension {
  return {
    oid: OID_AUTHORITY_KEY_IDENTIFIER,
    critical: false,
    // [0] IMPLICIT keyIdentifier
    value: sequence(tlv(0x80, keyIdentifier)),
  };
}

/**
 * RFC 5280 method 1 key identifier: SHA-1 of the subjectPublicKey bit string
 *
 * For RSA keys this is the hash of the PKCS#1 RSAPublicKey structure.
 */
export function computeKeyIdentifier(publicKey: crypto.KeyObject): Buffer {
  const spki = readDer(publicKey.export({ type: "spki", format: "der" }));
  const [, subjectPublicKey] = readDerChildren(spki);
  if (subjectPublicKey?.tag !== TAG_BIT_STRING) {
    throw new Error("invalid subject public key info");
  }
  return crypto
    .createHash("sha1")
    .update(subjectPublicKey.content.subarray(1))
    .digest();
}

// ---------------------------------------------------------------------------
// DER decoding

/** Decode the DER element starting at `offset` */
export function readDer(buffer: Buffer, offset = 0): DerElement {
  if (offset + 2 > buffer.length) {
    throw new Error("truncated der element");
  }
  const tag = buffer[offset];
  if ((tag & 0x1f) === 0x1f) {
    throw new Error("unsupported high tag number form");
  }

  let length = buffer[offset + 1];
  let contentStart = offset + 2;
  if (length & 0x80) {
    const lengthBytes = length & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4) {
      throw new Error("unsupported der length encoding");
    }
    if (contentStart + lengthBytes > buffer.length) {
      throw new Error("truncated der length");
    }
    length = 0;
    for (let i = 0; i < lengthBytes; i++) {
      length = length * 256 + buffer[contentStart + i];
    }
    contentStart += lengthBytes;
  }

  const end = contentStart + length;
  if (end > buffer.length) {
    throw new Error("truncated der content");
  }
  return {
    tag,
    content: buffer.subarray(contentStart, end),
    raw: buffer.subarray(offset, end),
  };
}

/** Decode all elements contained in a constructed element */
export function readDerChildren(element: DerElement): DerElement[] {
  const children: DerElement[] = [];
  let offset = 0;
  while (offset < element.content.length) {
    const child = readDer(element.content, offset);
    children.push(child);
    offset += child.raw.length;
  }
  return children;
}

export function decodeOid(content: Buffer): string {
  const arcs: number[] = [];
  let value = 0;
  for (const byte of content) {
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
    }
  }
  if (arcs.length === 0) throw new Error("empty oid");
  const first = Math.min(Math.floor(arcs[0] / 40), 2);
  return [first, arcs[0] - first * 40, ...arcs.slice(1)].join(".");
}

function expectTag(element: DerElement | undefined, tag: number): DerElement {
  if (!element || element.tag !== tag) {
    throw new Error(`unexpected der element in certificate`);
  }
  return element;
}

/** Parse the certificate fields not exposed by `X509Certificate` */
export function parseCertificate(der: Buffer): ParsedCertificate {
  const certificate = expectTag(readDer(der), TAG_SEQUENCE);
  const tbs = expectTag(readDerChildren(certificate)[0], TAG_SEQUENCE);
  const fields = readDerChildren(tbs);

  let index = fields[0]?.tag === 0xa0 ? 1 : 0;
  const serialNumber = expectTag(fields[index++], TAG_INTEGER).content;
  index++; // signature algorithm
  const issuer = expectTag(fields[index++], TAG_SEQUENCE).raw;
  index++; // validity
  const subject = expectTag(fields[index++], TAG_SEQUENCE).raw;
  index++; // subject public key info

  const extensions: CertificateExtension[] = [];
  for (const field of fields.slice(index)) {
    if (field.tag !== 0xa3) continue;
    const list = expectTag(readDer(field.content), TAG_SEQUENCE);
    for (const entry of readDerChildren(list)) {
      const parts = readDerChildren(expectTag(entry, TAG_SEQUENCE));
      const oid = decodeOid(expectTag(parts[0], TAG_OID).content);
      let critical = false;
      let valueIndex = 1;
      if (parts[1]?.tag === TAG_BOOLEAN) {
        critical = parts[1].content[0] !== 0;
        valueIndex = 2;
      }
      const value = expectTag(parts[valueIndex], TAG_OCTET_STRING).content;
      extensions.push({ oid, critical, value });
    }
  }

  return { serialNumber, issuer, subject, extensions };
}

/** Find an extension by oid */
export function getExtension(
  parsed: ParsedCertificate,
  oid: string,
): CertificateExtension | undefined {
  return parsed.extensions.find((extension) => extension.oid === oid);
}

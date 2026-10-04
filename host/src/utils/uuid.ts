import { createHash } from "node:crypto";

/** Format the first 16 bytes of a buffer as a canonical UUID string */
export function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes.subarray(0, 16)).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Turn a hash digest into a UUID with version 5 / RFC 4122 variant bits set.
 *
 * Only the first 16 bytes of the digest are used.
 */
export function digestToUuidV5(digest: Uint8Array): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  // Set version to 5 (0101)
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  // Set variant to RFC 4122 (10xx)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

/** Compute an RFC 4122 version 5 (SHA-1, name-based) UUID */
export function uuidv5(name: string, namespace: string): string {
  const hex = namespace.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`invalid uuid: ${namespace}`);
  const digest = createHash("sha1")
    .update(Buffer.from(hex, "hex"))
    .update(Buffer.from(name, "utf8"))
    .digest();
  return digestToUuidV5(digest);
}

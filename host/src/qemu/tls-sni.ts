/**
 * Minimal TLS ClientHello SNI extraction for the MITM path.
 *
 * Used when the host runtime cannot select a server certificate through
 * `tls.TLSSocket`'s `SNICallback` (Bun does not invoke it). Parsing is strictly
 * bounds-checked and only reads the first handshake record.
 */

/** max buffered guest bytes before giving up on SNI pre-parsing in `bytes` */
export const MAX_CLIENT_HELLO_PREPARSE_BYTES = 16 * 1024;

const TLS_RECORD_HANDSHAKE = 0x16;
const TLS_HANDSHAKE_CLIENT_HELLO = 0x01;
const TLS_EXTENSION_SERVER_NAME = 0x0000;
const SNI_HOST_NAME = 0x00;

/**
 * Extract the SNI host name from the start of a guest TLS stream.
 *
 * Returns `undefined` when more bytes are needed, `null` when the data is not a
 * ClientHello or carries no usable host name, or the host name.
 */
export function parseClientHelloSni(buf: Buffer): string | null | undefined {
  if (buf.length < 5) return undefined;
  if (buf[0] !== TLS_RECORD_HANDSHAKE) return null;

  const recordLength = buf.readUInt16BE(3);
  const recordEnd = 5 + recordLength;
  if (buf.length < recordEnd) return undefined;

  let offset = 5;
  if (offset + 4 > recordEnd) return null;
  if (buf[offset] !== TLS_HANDSHAKE_CLIENT_HELLO) return null;
  const helloLength =
    (buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!;
  // A ClientHello fragmented across records is legal but not used by common
  // clients; fall back to the caller's default name in that case.
  const end = offset + 4 + helloLength;
  if (end > recordEnd) return null;
  offset += 4;

  // legacy_version (2) + random (32)
  offset += 34;
  if (offset + 1 > end) return null;
  // legacy_session_id
  offset += 1 + buf[offset]!;
  if (offset + 2 > end) return null;
  // cipher_suites
  offset += 2 + buf.readUInt16BE(offset);
  if (offset + 1 > end) return null;
  // legacy_compression_methods
  offset += 1 + buf[offset]!;
  if (offset + 2 > end) return null;

  const extensionsEnd = offset + 2 + buf.readUInt16BE(offset);
  if (extensionsEnd > end) return null;
  offset += 2;

  while (offset + 4 <= extensionsEnd) {
    const type = buf.readUInt16BE(offset);
    const length = buf.readUInt16BE(offset + 2);
    offset += 4;
    const extensionEnd = offset + length;
    if (extensionEnd > extensionsEnd) return null;
    if (type === TLS_EXTENSION_SERVER_NAME) {
      if (offset + 2 > extensionEnd) return null;
      const listEnd = offset + 2 + buf.readUInt16BE(offset);
      if (listEnd > extensionEnd) return null;
      offset += 2;
      while (offset + 3 <= listEnd) {
        const nameType = buf[offset]!;
        const nameLength = buf.readUInt16BE(offset + 1);
        offset += 3;
        if (offset + nameLength > listEnd) return null;
        if (nameType === SNI_HOST_NAME) {
          const name = buf
            .subarray(offset, offset + nameLength)
            .toString("ascii");
          // RFC 6066 host names are ASCII DNS labels; reject anything else.
          return /^[A-Za-z0-9._-]{1,253}$/.test(name) ? name : null;
        }
        offset += nameLength;
      }
      return null;
    }
    offset = extensionEnd;
  }
  return null;
}

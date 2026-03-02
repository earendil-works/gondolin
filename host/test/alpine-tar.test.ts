import assert from "node:assert/strict";
import test from "node:test";

import { parseTar } from "../src/alpine/tar.ts";

interface TarBuildEntry {
  /** entry name stored in the tar header */
  name: string;
  /** tar type flag character */
  type?: string;
  /** file mode bits */
  mode?: number;
  /** link target for link entries */
  linkName?: string;
  /** payload bytes for the entry */
  body?: Buffer;
}

test("parseTar applies local PAX path to only the next entry", () => {
  const longPath =
    "usr/lib/node_modules/npm/node_modules/@sigstore/protobuf-specs/dist/__generated__/google/protobuf/timestamp.js";

  const tar = buildTar([
    {
      name: "pax-header",
      type: "x",
      body: Buffer.from(buildPaxRecord("path", longPath), "utf8"),
    },
    {
      name: "timestamp.js",
      type: "0",
      body: Buffer.from("one", "utf8"),
    },
    {
      name: "plain.txt",
      type: "0",
      body: Buffer.from("two", "utf8"),
    },
  ]);

  const entries = parseTar(tar);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.name, longPath);
  assert.equal(entries[0]?.content?.toString("utf8"), "one");
  assert.equal(entries[1]?.name, "plain.txt");
  assert.equal(entries[1]?.content?.toString("utf8"), "two");
});

test("parseTar applies GNU longname records", () => {
  const longPath =
    "usr/lib/node_modules/npm/node_modules/@sigstore/protobuf-specs/dist/__generated__/google/api/field_behavior.js";

  const tar = buildTar([
    {
      name: "././@LongLink",
      type: "L",
      body: Buffer.from(`${longPath}\0`, "utf8"),
    },
    {
      name: "field_behavior.js",
      type: "0",
      body: Buffer.from("ok", "utf8"),
    },
  ]);

  const entries = parseTar(tar);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, longPath);
  assert.equal(entries[0]?.content?.toString("utf8"), "ok");
});

function buildPaxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body, "utf8") + 3;

  while (true) {
    const record = `${length} ${body}`;
    const bytes = Buffer.byteLength(record, "utf8");
    if (bytes === length) {
      return record;
    }
    length = bytes;
  }
}

function buildTar(entries: TarBuildEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(buildTarEntry(entry));
  }

  // Tar EOF marker: two zero blocks
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function buildTarEntry(entry: TarBuildEntry): Buffer {
  const header = Buffer.alloc(512, 0);
  const body = entry.body ?? Buffer.alloc(0);
  const type = entry.type ?? "0";

  writeTarString(header, 0, 100, entry.name);
  writeTarOctal(header, 100, 8, entry.mode ?? 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, body.length);
  writeTarOctal(header, 136, 12, 0);

  // Checksum field must be spaces while checksumming
  header.fill(0x20, 148, 156);

  header[156] = type.charCodeAt(0);
  writeTarString(header, 157, 100, entry.linkName ?? "");
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const checksumField = `${checksum.toString(8).padStart(6, "0")}\0 `;
  writeTarRaw(header, 148, 8, checksumField);

  const padding = (512 - (body.length % 512)) % 512;
  return Buffer.concat([header, body, Buffer.alloc(padding, 0)]);
}

function writeTarString(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  writeTarRaw(target, offset, length, value);
}

function writeTarOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const octal = value.toString(8);
  const width = length - 1;
  if (octal.length > width) {
    throw new Error(`octal field overflow for ${value}`);
  }
  writeTarRaw(target, offset, length, `${octal.padStart(width, "0")}\0`);
}

function writeTarRaw(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) {
    throw new Error(`value '${value}' does not fit in ${length} bytes`);
  }
  encoded.copy(target, offset);
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  createChunkedBodyProgress,
  decodeChunkedBody,
} from "../src/http/chunked.ts";
import { HttpReceiveBuffer } from "../src/http/utils.ts";

const bytes = (...parts: string[]) => Buffer.from(parts.join(""), "latin1");

test("chunked body: decodes a complete body in one pass", () => {
  const buffer = new HttpReceiveBuffer();
  const payload = bytes("5\r\nhello\r\n", "6\r\n world\r\n", "0\r\n\r\n");
  buffer.append(payload);

  const progress = createChunkedBodyProgress(0);
  const result = decodeChunkedBody(buffer, 0, 1024, progress);

  assert.equal(result.complete, true);
  assert.equal(result.body.toString("latin1"), "hello world");
  assert.equal(result.bytesConsumed, payload.length);
});

test("chunked body: keeps what it decoded when a segment ends mid-body", () => {
  const buffer = new HttpReceiveBuffer();
  const progress = createChunkedBodyProgress(0);

  buffer.append(bytes("5\r\nhello\r\n"));
  let result = decodeChunkedBody(buffer, 0, 1024, progress);

  assert.equal(result.complete, false);
  // The decoded chunk is retained: a decoder that restarted from bodyOffset
  // would leave `chunks` empty here and re-read every byte on the next segment.
  assert.deepEqual(
    progress.chunks.map((chunk) => chunk.toString("latin1")),
    ["hello"],
  );
  assert.equal(progress.totalBytes, 5);
  assert.ok(progress.offset > 0);

  buffer.append(bytes("6\r\n world\r\n", "0\r\n\r\n"));
  result = decodeChunkedBody(buffer, 0, 1024, progress);

  assert.equal(result.complete, true);
  assert.equal(result.body.toString("latin1"), "hello world");
});

test("chunked body: rejects a body above the configured limit", () => {
  const buffer = new HttpReceiveBuffer();
  buffer.append(bytes("10\r\n0123456789abcdef\r\n", "0\r\n\r\n"));

  assert.throws(
    () => decodeChunkedBody(buffer, 0, 8, createChunkedBodyProgress(0)),
    /request body exceeds 8 bytes/,
  );
});

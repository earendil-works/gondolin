import assert from "node:assert/strict";
import test from "node:test";

import cbor from "cbor";

import {
  FrameReader,
  MAX_FRAME,
  buildExecRequest,
  buildPtyResize,
  buildStdinData,
  decodeMessage,
  encodeFrame,
  normalize,
} from "../src/sandbox/virtio-protocol.ts";

test("virtio-protocol: FrameReader reassembles frames from partial chunks", () => {
  const reader = new FrameReader();
  const msg = { v: 1, t: "vfs_ready", id: 123, p: {} };
  const framed = encodeFrame(msg);

  const frames: Buffer[] = [];
  // push 1 byte at a time to stress header/payload buffering
  for (let i = 0; i < framed.length; i += 1) {
    reader.push(framed.subarray(i, i + 1), (frame) => frames.push(frame));
  }

  assert.equal(frames.length, 1);
  assert.deepEqual(decodeMessage(frames[0]), msg);
});

test("virtio-protocol: FrameReader yields multiple frames in a single chunk", () => {
  const reader = new FrameReader();

  const msg1 = { v: 1, t: "vfs_ready", id: 1, p: {} };
  const msg2 = { v: 1, t: "vfs_error", id: 2, p: { message: "nope" } };

  const framed = Buffer.concat([encodeFrame(msg1), encodeFrame(msg2)]);
  const frames: Buffer[] = [];

  reader.push(framed, (frame) => frames.push(frame));

  assert.equal(frames.length, 2);
  assert.deepEqual(decodeMessage(frames[0]), msg1);
  assert.deepEqual(decodeMessage(frames[1]), msg2);
});

test("virtio-protocol: FrameReader enforces MAX_FRAME", () => {
  const reader = new FrameReader();

  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME + 1, 0);

  assert.throws(() => {
    reader.push(header, () => {
      // should never be called
    });
  }, /Frame too large/);
});

test("virtio-protocol: normalize converts Maps to plain objects and Uint8Array to Buffer", () => {
  const value = new Map<any, any>([
    [1, "one"],
    ["bin", new Uint8Array([1, 2, 3])],
    ["nested", new Map([["x", new Uint8Array([9])]])],
    ["arr", [new Map([["k", "v"]])]],
  ]);

  const normalized = normalize(value) as any;
  assert.equal(normalized["1"], "one");
  assert.ok(Buffer.isBuffer(normalized.bin));
  assert.equal(normalized.bin.toString("hex"), "010203");
  assert.ok(Buffer.isBuffer(normalized.nested.x));
  assert.equal(normalized.nested.x.toString("hex"), "09");
  assert.deepEqual(normalized.arr, [{ k: "v" }]);
});

test("virtio-protocol: decodeMessage normalizes CBOR decoded values", () => {
  // Force cbor.decodeFirstSync() to return a Map (not a plain object) by using
  // non-string keys. decodeMessage() should normalize Maps to objects and
  // Uint8Array byte strings to Buffers.
  const raw = new Map<any, any>([
    [
      1,
      new Map<any, any>([
        [2, new Uint8Array([7])],
        [3, [new Uint8Array([8, 9])]],
      ]),
    ],
  ]);

  const decoded = decodeMessage(cbor.encode(raw)) as any;
  assert.ok(decoded);
  assert.ok(decoded["1"]);
  assert.ok(Buffer.isBuffer(decoded["1"]["2"]));
  assert.equal(decoded["1"]["2"].toString("hex"), "07");
  assert.deepEqual(
    decoded["1"]["3"].map((b: Buffer) => b.toString("hex")),
    ["0809"],
  );
});

test("virtio-protocol: encodeFrame prefixes payload length and roundtrips", () => {
  const msg = { v: 1, t: "pty_resize", id: 7, p: { rows: 10, cols: 20 } };
  const framed = encodeFrame(msg);

  const len = framed.readUInt32BE(0);
  assert.equal(len, framed.length - 4);

  const payload = framed.subarray(4);
  assert.deepEqual(decodeMessage(payload), msg);
});

test("virtio-protocol: buildExecRequest drops undefined optional fields", () => {
  const req = buildExecRequest(5, {
    cmd: "sh",
    argv: undefined,
    env: undefined,
    cwd: undefined,
    stdin: undefined,
    pty: undefined,
  });

  assert.deepEqual(req, {
    v: 1,
    t: "exec_request",
    id: 5,
    p: { cmd: "sh" },
  });
});

test("virtio-protocol: buildStdinData and buildPtyResize shape", () => {
  const stdin = buildStdinData(1, Buffer.from("hi"));
  assert.deepEqual(stdin, {
    v: 1,
    t: "stdin_data",
    id: 1,
    p: { data: Buffer.from("hi") },
  });

  const eof = buildStdinData(2, Buffer.alloc(0), true);
  assert.deepEqual(eof, {
    v: 1,
    t: "stdin_data",
    id: 2,
    p: { data: Buffer.alloc(0), eof: true },
  });

  const resize = buildPtyResize(3, 24, 80);
  assert.deepEqual(resize, {
    v: 1,
    t: "pty_resize",
    id: 3,
    p: { rows: 24, cols: 80 },
  });
});

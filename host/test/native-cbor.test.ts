import assert from "node:assert/strict";
import test from "node:test";

import { TypeEncoderMap, decode, encode as cbor2Encode } from "cbor2";

import { fastDecode, fastEncode, normalize } from "../src/native/cbor.ts";
import {
  decodeNativeFrame,
  encodeNativeFrame,
  stripUndefined,
} from "../src/native/transport.ts";

// same Buffer handling as the transport
const types = new TypeEncoderMap();
types.registerEncoder(Buffer, (value) => [
  NaN,
  new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
]);
const encode = (value: unknown) => cbor2Encode(value, { types });

const samples: unknown[] = [
  { v: 1, t: "exec_window", id: 0, p: { client: 3, id: 7, stdout: 65536 } },
  {
    v: 1,
    t: "stdin",
    id: 0,
    p: { client: 1, id: 2, data: Buffer.from("hello"), eof: undefined },
  },
  {
    a: [1, -1, 23, 24, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32],
    b: [-24, -25, -256, -257, -(2 ** 32), Number.MAX_SAFE_INTEGER],
    c: [0.5, -1.25, 1e300, 1 / 3, 65504, 5.96e-8, -Infinity, true, false],
    c2: [null, undefined, Number.NaN],
    d: "",
    e: "ä€😀 non-ascii",
    f: "x".repeat(100),
    g: Buffer.alloc(70000, 7),
    h: { nested: { deeper: [{ k: "v" }] } },
    i: new Uint8Array([1, 2, 3]),
  },
];

test("fast CBOR encoding decodes to what cbor2 encodes", () => {
  for (const value of samples) {
    const fast = fastEncode(value);
    assert.ok(fast);
    const viaCbor2 = normalize(
      decode(Buffer.from(encode(stripUndefined(value)))),
    );
    assert.deepEqual(normalize(decode(fast)), viaCbor2);
  }
});

test("fast CBOR decoding matches cbor2", () => {
  for (const value of samples) {
    const bytes = Buffer.from(encode(stripUndefined(value)));
    assert.deepEqual(fastDecode(bytes), normalize(decode(bytes)));
  }
  // map keys named __proto__ stay own properties
  const evil = Buffer.from(encode(new Map([["__proto__", { x: 1 }]])));
  const out = fastDecode(evil) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.deepEqual(Object.keys(out), ["__proto__"]);
});

test("fast CBOR falls back outside its subset", () => {
  assert.equal(fastEncode({ m: new Map() }), undefined);
  assert.equal(fastEncode({ n: 10n }), undefined);
  // bigint, tag and truncated input go to cbor2
  for (const bytes of [
    Buffer.from(encode(2n ** 60n)),
    Buffer.from(encode(new Date(0))),
    Buffer.from([0x62, 0x61]),
    Buffer.from([0xa1, 0x01, 0x02]),
  ]) {
    assert.equal(fastDecode(bytes), undefined);
  }
  // frames still round trip through the fallback
  const frame = encodeNativeFrame({
    v: 1,
    t: "x",
    id: 1,
    p: { big: 2n ** 60n },
  });
  assert.equal(frame.readUInt32BE(0), frame.length - 4);
  const decoded = decodeNativeFrame(frame.subarray(4)) as {
    p: { big: bigint };
  };
  assert.equal(decoded.p.big, 2n ** 60n);
});

test("decoded small byte strings do not alias the frame", () => {
  const frame = encodeNativeFrame({
    v: 1,
    t: "exec_output",
    id: 0,
    p: { data: Buffer.from("abc") },
  });
  const decoded = decodeNativeFrame(frame.subarray(4)) as {
    p: { data: Buffer };
  };
  frame.fill(0);
  assert.equal(decoded.p.data.toString(), "abc");
});

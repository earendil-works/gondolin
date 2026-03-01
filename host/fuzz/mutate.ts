import { XorShift32 } from "./rng.ts";

export type MutateOptions = {
  maxLen: number;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function randByte(rng: XorShift32): number {
  return rng.nextU32() & 0xff;
}

export function mutateBuffer(
  base: Buffer,
  rng: XorShift32,
  opts: MutateOptions,
): Buffer {
  // Start from a copy.
  let buf = Buffer.from(base);

  const operations = rng.int(1, 8);
  for (let k = 0; k < operations; k++) {
    const op = rng.int(0, 7);

    if (op === 0) {
      // flip one bit
      if (buf.length === 0) continue;
      const i = rng.int(0, buf.length - 1);
      const bit = 1 << rng.int(0, 7);
      buf[i] = buf[i]! ^ bit;
    } else if (op === 1) {
      // set random byte
      if (buf.length === 0) continue;
      const i = rng.int(0, buf.length - 1);
      buf[i] = randByte(rng);
    } else if (op === 2) {
      // insert random bytes
      if (buf.length >= opts.maxLen) continue;
      const insertLen = clamp(rng.int(1, 32), 1, opts.maxLen - buf.length);
      const at = rng.int(0, buf.length);
      const ins = Buffer.alloc(insertLen);
      for (let j = 0; j < insertLen; j++) ins[j] = randByte(rng);
      buf = Buffer.concat([buf.subarray(0, at), ins, buf.subarray(at)]);
    } else if (op === 3) {
      // delete a slice
      if (buf.length === 0) continue;
      const at = rng.int(0, buf.length - 1);
      const delLen = rng.int(1, Math.min(32, buf.length - at));
      buf = Buffer.concat([buf.subarray(0, at), buf.subarray(at + delLen)]);
    } else if (op === 4) {
      // duplicate a slice
      if (buf.length === 0 || buf.length >= opts.maxLen) continue;
      const at = rng.int(0, buf.length - 1);
      const sliceLen = rng.int(1, Math.min(32, buf.length - at));
      const slice = buf.subarray(at, at + sliceLen);
      const cap = opts.maxLen - buf.length;
      const dup = slice.subarray(0, Math.min(slice.length, cap));
      buf = Buffer.concat([buf, dup]);
    } else if (op === 5) {
      // truncate
      if (buf.length === 0) continue;
      const newLen = rng.int(0, buf.length);
      buf = buf.subarray(0, newLen);
    } else if (op === 6) {
      // extend
      if (buf.length >= opts.maxLen) continue;
      const extra = clamp(rng.int(1, 64), 1, opts.maxLen - buf.length);
      const tail = Buffer.alloc(extra);
      for (let j = 0; j < extra; j++) tail[j] = randByte(rng);
      buf = Buffer.concat([buf, tail]);
    } else {
      // overwrite a small region
      if (buf.length === 0) continue;
      const at = rng.int(0, buf.length - 1);
      const len = rng.int(1, Math.min(32, buf.length - at));
      for (let j = 0; j < len; j++) buf[at + j] = randByte(rng);
    }

    if (buf.length > opts.maxLen) {
      buf = buf.subarray(0, opts.maxLen);
    }
  }

  return Buffer.from(buf);
}

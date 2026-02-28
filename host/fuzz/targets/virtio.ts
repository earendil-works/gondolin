import cbor from "cbor";
import {
  FrameReader,
  MAX_FRAME,
  decodeMessage,
  encodeFrame,
  buildExecRequest,
} from "../../src/sandbox/virtio-protocol.ts";
import { XorShift32 } from "../rng.ts";
import type { FuzzTarget } from "./types.ts";

function randChunking(input: Buffer, rng: XorShift32): Buffer[] {
  if (input.length === 0) return [Buffer.alloc(0)];
  const chunks: Buffer[] = [];
  let off = 0;
  while (off < input.length) {
    const remaining = input.length - off;
    const take = Math.min(remaining, rng.int(1, Math.min(128, remaining)));
    chunks.push(input.subarray(off, off + take));
    off += take;
  }
  return chunks;
}

export const virtioTarget: FuzzTarget = {
  name: "virtio",
  description: "virtio-protocol framing + CBOR decode (host side)",
  defaultMaxLen: 64 * 1024,
  seeds: [
    // A valid frame with a well-formed exec request
    encodeFrame(
      buildExecRequest(1, {
        cmd: "/bin/echo",
        argv: ["hello"],
        env: ["A=B"],
        stdin: false,
      }),
    ),
    // A frame with an arbitrary CBOR value
    encodeFrame({
      v: 1,
      t: "tcp_open",
      id: 1,
      p: { host: "127.0.0.1", port: 80 },
    }),
    // Some random-but-valid CBOR
    encodeFrame(cbor.encode({ hello: "world", n: 1 })),
  ],

  runOne(input: Buffer, rng: XorShift32): boolean {
    const reader = new FrameReader();

    let frames = 0;
    const chunks = randChunking(input, rng);
    for (const chunk of chunks) {
      try {
        reader.push(chunk, (frame) => {
          frames += 1;
          try {
            // decodeMessage is allowed to throw for invalid CBOR/message shape.
            decodeMessage(frame);
          } catch {
            // ignore
          }
        });
      } catch (err: any) {
        // The framing layer may reject oversized frames. This should be treated as a handled error,
        // not a fuzzer crash.
        const msg = String(err?.message ?? err);
        if (msg.includes("Frame too large")) return frames > 0;
        throw err;
      }
    }

    // Interesting if it produced at least one frame.
    return frames > 0;
  },
};

import { NetworkStack } from "../../src/qemu/network-stack.ts";
import { XorShift32 } from "../rng.ts";
import type { FuzzTarget } from "./types.ts";

function sanitizeQemuFramedStream(buf: Buffer, maxFrame: number) {
  // Match guest fuzz sanitizer: clamp u32be length prefixes to remaining size.
  let off = 0;
  while (off + 4 <= buf.length) {
    const remaining = buf.length - off;
    if (remaining <= 4) break;

    const len = buf.readUInt32BE(off);
    const maxAllowed = Math.min(maxFrame, remaining - 4);
    const newLen = Math.min(len, maxAllowed);
    buf.writeUInt32BE(newLen >>> 0, off);
    off += 4 + newLen;
  }
}

function randChunking(input: Buffer, rng: XorShift32): Buffer[] {
  if (input.length === 0) return [Buffer.alloc(0)];
  const chunks: Buffer[] = [];
  let off = 0;
  while (off < input.length) {
    const remaining = input.length - off;
    const take = Math.min(remaining, rng.int(1, Math.min(512, remaining)));
    chunks.push(input.subarray(off, off + take));
    off += take;
  }
  return chunks;
}

export const networkTarget: FuzzTarget = {
  name: "net",
  description: "network-stack: QEMU framed ethernet RX parsing",
  defaultMaxLen: 128 * 1024,
  seeds: [
    // A single empty frame (len=0)
    Buffer.from([0, 0, 0, 0]),
    // A tiny truncated frame
    Buffer.from([0, 0, 0, 1, 0x00]),
    // Two frames back-to-back
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
  ],

  runOne(input: Buffer, rng: XorShift32): boolean {
    const stack = new NetworkStack({
      dnsServers: ["8.8.8.8"],
      callbacks: {
        onUdpSend: () => {},
        onTcpConnect: () => {},
        onTcpSend: () => {},
        onTcpClose: () => {},
        onTcpPause: () => {},
        onTcpResume: () => {},
      },
      allowTcpFlow: () => true,
      txQueueMaxBytes: 256 * 1024,
    });

    const owned = Buffer.from(input);
    sanitizeQemuFramedStream(owned, 16 * 1024);

    let ok = true;
    for (const chunk of randChunking(owned, rng)) {
      // writeToNetwork should not throw even for garbage.
      stack.writeToNetwork(chunk);

      // Exercise TX dequeue paths a bit.
      // We don't care what we read back, but this helps cover queue handling.
      for (let i = 0; i < 4; i++) {
        const out = stack.readFromNetwork(rng.int(0, 4096));
        if (out && out.length > 0) ok = true;
      }
    }

    return ok;
  },
};

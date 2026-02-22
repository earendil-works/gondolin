import { parseTar } from "../../src/build/alpine";
import { XorShift32 } from "../rng";
import type { FuzzTarget } from "./types";

export const tarTarget: FuzzTarget = {
  name: "tar",
  description: "build-alpine: tar parser",
  defaultMaxLen: 256 * 1024,
  seeds: [
    // End-of-archive marker: one zero block
    Buffer.alloc(512),
    // Two zero blocks
    Buffer.alloc(1024),
  ],
  runOne(input: Buffer, _rng: XorShift32): boolean {
    const entries = parseTar(input);
    return entries.length > 0;
  },
};

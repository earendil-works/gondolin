import { getInfoFromSshExecRequest } from "../../src/ssh/exec.ts";
import { XorShift32 } from "../rng.ts";
import type { FuzzTarget } from "./types.ts";

function bytesToWeirdAscii(buf: Buffer): string {
  // Keep it mostly ASCII so the command parser sees quotes/backslashes etc.
  const out: string[] = [];
  for (const b of buf) {
    const c = b % 96;
    out.push(String.fromCharCode(32 + c));
  }
  return out.join("");
}

export const sshExecTarget: FuzzTarget = {
  name: "ssh-exec",
  description: "ssh-exec: git-over-ssh command parser",
  defaultMaxLen: 4096,
  seeds: [
    Buffer.from("git-upload-pack 'org/repo.git'", "utf8"),
    Buffer.from("/usr/bin/git-receive-pack 'org/repo'", "utf8"),
    Buffer.from('git-upload-pack "org/repo.git"', "utf8"),
  ],
  runOne(input: Buffer, _rng: XorShift32): boolean {
    const command = bytesToWeirdAscii(input);
    const info = getInfoFromSshExecRequest({ command } as any);
    return info !== null;
  },
};

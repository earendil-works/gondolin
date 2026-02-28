import type { FuzzTarget } from "./types.ts";
import { dnsTarget } from "./dns.ts";
import { virtioTarget } from "./virtio.ts";
import { networkTarget } from "./network.ts";
import { tarTarget } from "./tar.ts";
import { sshExecTarget } from "./ssh-exec.ts";

export const targets: Record<string, FuzzTarget> = {
  [dnsTarget.name]: dnsTarget,
  [virtioTarget.name]: virtioTarget,
  [networkTarget.name]: networkTarget,
  [tarTarget.name]: tarTarget,
  [sshExecTarget.name]: sshExecTarget,
};

import type { FuzzTarget } from "./types.ts";
import { tarTarget } from "./tar.ts";
import { sshExecTarget } from "./ssh-exec.ts";

export const targets: Record<string, FuzzTarget> = {
  [tarTarget.name]: tarTarget,
  [sshExecTarget.name]: sshExecTarget,
};

/**
 * macOS: the krun runner needs the `com.apple.security.hypervisor`
 * entitlement to use Hypervisor.framework; check it before booting so the
 * failure is a clear error instead of a VM that never starts.
 */

import child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function resolveExecutableForInspection(executable: string): string {
  if (path.isAbsolute(executable) || executable.includes(path.sep)) {
    return executable;
  }

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next PATH entry
    }
  }

  return executable;
}

function hasMacHypervisorEntitlement(executable: string): boolean {
  const inspectPath = resolveExecutableForInspection(executable);
  try {
    const entitlements = child_process.execFileSync(
      "/usr/bin/codesign",
      ["-d", "--entitlements", ":-", inspectPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return entitlements.includes("com.apple.security.hypervisor");
  } catch {
    return false;
  }
}

/** Throws when `executable` lacks the hypervisor entitlement (macOS only) */
export function assertMacHypervisorEntitlement(executable: string) {
  if (process.platform !== "darwin") return;
  if (hasMacHypervisorEntitlement(executable)) return;

  const inspectPath = resolveExecutableForInspection(executable);
  throw new Error(
    "krun runner is not signed with the macOS Hypervisor entitlement " +
      `(com.apple.security.hypervisor): ${inspectPath}\n` +
      "Fix: rebuild the local runner with `make krun-runner` or set " +
      "GONDOLIN_KRUN_RUNNER to a signed runner binary.",
  );
}

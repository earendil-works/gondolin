import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

export type ResolveQemuFamilyBinaryDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: typeof fs.existsSync;
  probeBinary?: (candidatePath: string) => boolean;
};

/** Check whether a qemu-family binary (qemu-system-*, qemu-img, ...) runs. */
export function probeQemuFamilyBinary(candidatePath: string): boolean {
  try {
    execFileSync(candidatePath, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the list of candidate paths for a qemu-family binary known by one or
 * more bare basenames (e.g. `["qemu-img"]` or
 * `["qemu-system-x86_64", "qemu-system-x86_64w"]`). Off Windows this is just
 * the first basename; on Windows it also searches `.exe` variants under the
 * `ProgramW6432`/`ProgramFiles` install roots, since qemu is commonly
 * installed outside PATH there.
 */
export function buildQemuFamilyCandidates(
  names: string[],
  deps: ResolveQemuFamilyBinaryDeps = {},
): string[] {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    return [names[0]!];
  }

  const env = deps.env ?? process.env;
  const candidates: string[] = [];
  for (const name of names) {
    candidates.push(name, `${name}.exe`);
  }

  const installRoots = [env.ProgramW6432, env.ProgramFiles].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const root of installRoots) {
    for (const name of names) {
      candidates.push(path.win32.join(root, "qemu", `${name}.exe`));
    }
  }

  return Array.from(new Set(candidates));
}

/**
 * Pick the first candidate that exists (when given as an explicit path) and
 * responds to a `--version` probe, falling back to the first candidate.
 */
export function resolveFromQemuFamilyCandidates(
  candidates: string[],
  deps: ResolveQemuFamilyBinaryDeps = {},
): string {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const probeBinary = deps.probeBinary ?? probeQemuFamilyBinary;

  for (const candidate of candidates) {
    const isExplicitPath = /[\\/]/.test(candidate);
    if (isExplicitPath && !existsSync(candidate)) {
      continue;
    }
    if (probeBinary(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
}

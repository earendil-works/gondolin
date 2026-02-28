import { execFile, execFileSync } from "node:child_process";

import type { Architecture } from "../build/config.ts";

let cachedHostNodeArch: NodeJS.Architecture = process.arch;

/**
 * Return the (cached) host node architecture.
 *
 * On Apple Silicon running under Rosetta, this will eventually become "arm64"
 * after a background sysctl probe completes.
 */
export function getHostNodeArchCached(): NodeJS.Architecture {
  return cachedHostNodeArch;
}

function nodeArchToArchitecture(arch: NodeJS.Architecture): Architecture {
  if (arch === "arm64") return "aarch64";
  return "x86_64";
}

/**
 * Synchronously detect the host node architecture.
 *
 * On macOS x64 under Rosetta, this runs a sysctl probe and may return "arm64".
 */
function detectHostNodeArchSync(): NodeJS.Architecture {
  let arch: NodeJS.Architecture = process.arch;

  if (process.platform === "darwin" && process.arch === "x64") {
    try {
      const result = execFileSync("sysctl", ["-n", "hw.optional.arm64"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.trim() === "1") {
        arch = "arm64";
      }
    } catch {
      // ignore
    }
  }

  return arch;
}

/**
 * Asynchronously detect the host node architecture.
 *
 * On macOS x64 under Rosetta, this runs a sysctl probe and may return "arm64".
 */
async function detectHostNodeArchAsync(): Promise<NodeJS.Architecture> {
  if (process.arch === "arm64") return "arm64";

  if (process.platform === "darwin" && process.arch === "x64") {
    try {
      const result = await new Promise<string>((resolve, reject) => {
        execFile("sysctl", ["-n", "hw.optional.arm64"], (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        });
      });
      if (result === "1") return "arm64";
    } catch {
      // ignore
    }
  }

  return process.arch;
}

export function detectHostArchitectureSync(): Architecture {
  return nodeArchToArchitecture(detectHostNodeArchSync());
}

// Start background Rosetta detection early so callers can get an updated value
// without paying a synchronous sysctl cost.
if (process.platform === "darwin" && process.arch === "x64") {
  void detectHostNodeArchAsync().then((arch) => {
    cachedHostNodeArch = arch;
  });
}

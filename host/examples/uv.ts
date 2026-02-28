/**
 * Run a Python script in Gondolin with uv and a persistent shared uv cache.
 *
 * This example:
 * - mounts the current host directory at `/workspace`
 * - rewrites path-like CLI args (e.g. `./script.py`, `hello.py`) to `/workspace/...`
 * - runs `uv run ...` in `/workspace`
 * - by default uses guest-local cache (`UV_CACHE_DIR=/tmp/.cache/uv`)
 * - optional host-shared cache: mount `~/.cache/gondolin-uv` at `/var/cache/uv`
 *   by setting `GONDOLIN_UV_SHARED_CACHE=1`
 *
 * Run with:
 *   cd host
 *   node examples/uv.ts script.py [args...]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RealFSProvider } from "../src/vfs/node/index.ts";
import { VM } from "../src/vm/core.ts";

const GUEST_WORKSPACE = "/workspace";

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function createDebugLogger(enabled: boolean) {
  const start = Date.now();
  return (message: string) => {
    if (!enabled) return;
    const elapsed = Date.now() - start;
    process.stderr.write(`[uv-example +${elapsed}ms] ${message}\n`);
  };
}

function printUsage() {
  console.log("Usage: node examples/uv.ts <script.py|module args...>");
  console.log();
  console.log("Examples:");
  console.log("  node examples/uv.ts hello.py");
  console.log(
    "  node examples/uv.ts --with requests scripts/fetch.py",
  );
  console.log();
  console.log("Debugging:");
  console.log(
    "  GONDOLIN_UV_DEBUG=1 node examples/uv.ts --with flask python -c \"import jinja2; print('ok')\"",
  );
  console.log(
    "  # Optional: add GONDOLIN_UV_DEBUG_GONDOLIN=1 for VM internals (very verbose)",
  );
  console.log(
    "  # Optional: set GONDOLIN_UV_HEARTBEAT_MS=2000 for periodic progress logs",
  );
  console.log(
    "  # Optional: set GONDOLIN_UV_SERIAL=1 to force uv concurrency to 1",
  );
  console.log("  # Default: guest-local cache at /tmp/.cache/uv");
  console.log(
    "  # Optional: set GONDOLIN_UV_SHARED_CACHE=1 to use host-shared ~/.cache/gondolin-uv",
  );
}

function toGuestWorkspacePath(
  workspaceHostPath: string,
  hostPath: string,
): string | null {
  const rel = path.relative(workspaceHostPath, hostPath);
  if (rel === "") return GUEST_WORKSPACE;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return path.posix.join(
    GUEST_WORKSPACE,
    rel.split(path.sep).join(path.posix.sep),
  );
}

function looksLikePathArg(arg: string): boolean {
  if (path.isAbsolute(arg)) return true;
  if (arg.startsWith(".")) return true;
  if (arg.includes("/") || arg.includes("\\")) return true;
  return arg.endsWith(".py");
}

function rewritePathArgsForGuest(
  args: string[],
  workspaceHostPath: string,
): string[] {
  return args.map((arg) => {
    if (!looksLikePathArg(arg)) return arg;

    const hostPath = path.isAbsolute(arg)
      ? arg
      : path.resolve(workspaceHostPath, arg);
    if (!fs.existsSync(hostPath)) return arg;

    const guestPath = toGuestWorkspacePath(workspaceHostPath, hostPath);
    return guestPath ?? arg;
  });
}

async function main(): Promise<number> {
  const forceDebug = parseBoolEnv(process.env.GONDOLIN_UV_DEBUG);
  const forceGondolinDebug = parseBoolEnv(
    process.env.GONDOLIN_UV_DEBUG_GONDOLIN,
  );
  const debugEnabled =
    forceDebug || forceGondolinDebug || Boolean(process.env.GONDOLIN_DEBUG);
  const debug = createDebugLogger(debugEnabled);

  const heartbeatMsRaw = Number(
    process.env.GONDOLIN_UV_HEARTBEAT_MS ?? "10000",
  );
  const heartbeatMs =
    Number.isFinite(heartbeatMsRaw) && heartbeatMsRaw > 0
      ? heartbeatMsRaw
      : 10000;
  const serialMode = parseBoolEnv(process.env.GONDOLIN_UV_SERIAL);
  const useSharedCache =
    process.env.GONDOLIN_UV_SHARED_CACHE === undefined
      ? false
      : parseBoolEnv(process.env.GONDOLIN_UV_SHARED_CACHE);

  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printUsage();
    return args.length === 0 ? 1 : 0;
  }

  debug(`argv: ${JSON.stringify(args)}`);

  const workspaceHostPath = process.cwd();
  const guestArgs = rewritePathArgsForGuest(args, workspaceHostPath);
  debug(`workspace host path: ${workspaceHostPath}`);
  debug(`workspace guest path: ${GUEST_WORKSPACE}`);
  debug(`rewritten guest args: ${JSON.stringify(guestArgs)}`);

  const uvCacheHostPath = path.join(os.homedir(), ".cache", "gondolin-uv");
  if (useSharedCache) {
    fs.mkdirSync(uvCacheHostPath, { recursive: true });
    debug(`uv cache host path: ${uvCacheHostPath}`);
    if (debugEnabled) {
      try {
        const topLevelCount = fs.readdirSync(uvCacheHostPath).length;
        debug(`uv cache top-level entries: ${topLevelCount}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debug(`failed to inspect uv cache dir: ${message}`);
      }
    }
  } else {
    debug("uv shared cache disabled; using guest-local /tmp/.cache/uv");
  }

  if (debugEnabled) {
    debug(`uv serial mode: ${serialMode ? "enabled" : "disabled"}`);
    debug(`uv shared cache: ${useSharedCache ? "enabled" : "disabled"}`);
  }

  const shouldForceGondolinDebug =
    forceGondolinDebug && !process.env.GONDOLIN_DEBUG;
  if (debugEnabled) {
    const effectiveDebug =
      process.env.GONDOLIN_DEBUG ??
      (shouldForceGondolinDebug ? "all" : "(disabled)");
    debug(`gondolin debug: ${effectiveDebug}`);
  }

  const vmEnv: Record<string, string> = {
    UV_CACHE_DIR: useSharedCache ? "/var/cache/uv" : "/tmp/.cache/uv",
  };
  if (process.env.UV_HTTP_TIMEOUT) {
    vmEnv.UV_HTTP_TIMEOUT = process.env.UV_HTTP_TIMEOUT;
  }
  if (serialMode) {
    vmEnv.UV_CONCURRENT_DOWNLOADS = "1";
    vmEnv.UV_CONCURRENT_BUILDS = "1";
    vmEnv.UV_CONCURRENT_INSTALLS = "1";
  }

  const mounts: Record<string, RealFSProvider> = {
    [GUEST_WORKSPACE]: new RealFSProvider(workspaceHostPath),
  };
  if (useSharedCache) {
    mounts["/var/cache/uv"] = new RealFSProvider(uvCacheHostPath);
  }

  debug("creating VM...");
  const vm = await VM.create({
    sandbox: shouldForceGondolinDebug ? { debug: true } : undefined,
    vfs: {
      mounts,
    },
    env: vmEnv,
    debugLog: debugEnabled
      ? (component, message) => {
          debug(`[${component}] ${message.replace(/\r?\n$/u, "")}`);
        }
      : undefined,
  });
  debug("VM created");

  let heartbeat: NodeJS.Timeout | undefined;
  try {
    const command = ["/usr/bin/uv", "run", ...guestArgs];
    debug(`starting command: ${JSON.stringify(command)}`);

    if (debugEnabled) {
      heartbeat = setInterval(() => {
        debug("still waiting for uv to finish...");
      }, heartbeatMs);
      heartbeat.unref();
    }

    const proc = vm.exec(command, {
      cwd: GUEST_WORKSPACE,
      stdout: "inherit",
      stderr: "inherit",
      stdin: process.stdin,
    });

    const result = await proc;
    debug(
      `uv finished with exitCode=${result.exitCode}${result.signal === undefined ? "" : ` signal=${result.signal}`}`,
    );

    if (result.signal !== undefined) {
      process.stderr.write(`uv exited via signal ${result.signal}\n`);
    }
    return result.exitCode;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    debug("closing VM...");
    await vm.close();
    debug("VM closed");
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });

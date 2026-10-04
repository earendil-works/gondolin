import type { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import type { SandboxLogStream } from "./controller.ts";

/** VMM child processes that must be killed when the host process exits */
const activeChildren = new Set<ChildProcess>();
let exitHookRegistered = false;

/** SIGKILL all tracked child processes (best-effort) */
export function killActiveChildren() {
  for (const child of activeChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

/** Number of currently tracked child processes */
export function getActiveChildrenCount(): number {
  return activeChildren.size;
}

function registerExitHook() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => {
    killActiveChildren();
  });
}

/** Track a child so it is killed when the host process exits */
export function trackChild(child: ChildProcess) {
  registerExitHook();
  activeChildren.add(child);
  const cleanup = () => {
    activeChildren.delete(child);
  };
  child.once("exit", cleanup);
  child.once("error", cleanup);
}

/** Re-emit child stdout/stderr chunks as `log` events on `emitter` */
export function forwardChildLogs(emitter: EventEmitter, child: ChildProcess) {
  child.stdout?.on("data", (chunk) => {
    emitter.emit("log", chunk.toString(), "stdout" satisfies SandboxLogStream);
  });
  child.stderr?.on("data", (chunk) => {
    emitter.emit("log", chunk.toString(), "stderr" satisfies SandboxLogStream);
  });
}

function bestEffort(fn: () => void) {
  try {
    fn();
  } catch {
    // ignore
  }
}

/**
 * Best-effort shutdown of a VMM child process.
 *
 * - SIGTERM first
 * - SIGKILL after a short grace period
 * - never hang forever waiting on an "exit" event
 *
 * CI runners (notably Linux/KVM) have occasionally exhibited situations where
 * the VMM does not terminate promptly and keeps Node alive via its stdio
 * pipes. In that case we fall back to destroying the pipes + unref'ing the
 * child so the process can still exit.
 */
export async function terminateChild(
  child: ChildProcess,
  options: {
    /** hard cap on waiting for exit in `ms` */
    closeTimeoutMs?: number;
    /** delay between SIGTERM and SIGKILL in `ms` */
    sigkillAfterMs?: number;
  } = {},
): Promise<void> {
  const closeTimeoutMs = options.closeTimeoutMs ?? 10_000;
  const sigkillAfterMs = options.sigkillAfterMs ?? 3000;

  let exited = false;
  let exitHandler: (() => void) | null = null;
  let errorHandler: ((err: Error) => void) | null = null;

  const waitForExit = new Promise<void>((resolve) => {
    // If the process is already gone, don't wait.
    // (ChildProcess.exitCode is `number | null`; treat `undefined` as "unknown" and keep waiting.)
    const exitCode = (child as any).exitCode as number | null | undefined;
    if (typeof exitCode === "number") {
      exited = true;
      resolve();
      return;
    }

    exitHandler = () => {
      exited = true;
      resolve();
    };

    errorHandler = () => {
      exited = true;
      resolve();
    };

    child.once("exit", exitHandler);
    child.once("error", errorHandler);
  });

  bestEffort(() => child.kill("SIGTERM"));

  const sigkillTimer = setTimeout(() => {
    bestEffort(() => child.kill("SIGKILL"));
  }, sigkillAfterMs);

  // Hard cap on waiting for the child to exit.
  let closeTimeoutTimer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      waitForExit,
      new Promise<void>((resolve) => {
        closeTimeoutTimer = setTimeout(resolve, closeTimeoutMs);
      }),
    ]);
  } finally {
    if (closeTimeoutTimer) {
      clearTimeout(closeTimeoutTimer);
    }
    clearTimeout(sigkillTimer);
  }

  if (exited) return;

  // The child is still around: do not keep the event loop alive waiting for it.
  bestEffort(() => child.kill("SIGKILL"));

  // Last resort: detach the child so it cannot keep Node alive.
  bestEffort(() => (child.stdin as any)?.destroy?.());
  bestEffort(() => (child.stdout as any)?.destroy?.());
  bestEffort(() => (child.stderr as any)?.destroy?.());
  bestEffort(() => child.unref());

  // Also SIGKILL any other tracked children (best-effort)
  killActiveChildren();

  // Remove our listeners to avoid leaks if the child exits later.
  if (exitHandler) child.off("exit", exitHandler);
  if (errorHandler) child.off("error", errorHandler);
}

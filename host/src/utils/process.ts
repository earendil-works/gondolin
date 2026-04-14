export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : null;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

export function signalProcess(
  pid: number,
  signal: NodeJS.Signals | number,
): "signaled" | "missing" {
  try {
    process.kill(pid, signal);
    return "signaled";
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : null;
    if (code === "ESRCH") {
      return "missing";
    }
    throw error;
  }
}

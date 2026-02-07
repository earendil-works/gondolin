export type DebugFlag = "net" | "exec" | "vfs" | "protocol";

/**
 * Debug configuration value
 *
 * - `true`: enable all debug components
 * - `false`: disable all debug components
 * - `string[]`: enable selected components
 */
export type DebugConfig = boolean | ReadonlyArray<DebugFlag>;

export const ALL_DEBUG_FLAGS: ReadonlyArray<DebugFlag> = ["net", "exec", "vfs", "protocol"];

/**
 * Component identifier passed to debug log callbacks
 */
export type DebugComponent = DebugFlag | "qemu" | "error";

/**
 * Debug log callback invoked with component + message
 */
export type DebugLogFn = (component: DebugComponent, message: string) => void;

export function defaultDebugLog(component: DebugComponent, message: string) {
  // Intentionally console.log (not stderr) so callers can easily intercept/redirect.
  console.log(formatDebugLine(component, message));
}

export function formatDebugLine(component: DebugComponent, message: string) {
  const trimmed = stripTrailingNewline(message);
  return `[${component}] ${trimmed}`;
}

export function stripTrailingNewline(value: string) {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

export function parseDebugEnv(value: string | undefined = process.env.GONDOLIN_DEBUG) {
  const flags = new Set<DebugFlag>();
  if (!value) return flags;

  // Allow: "net,exec" as well as "all" / "*".
  for (const entry of value.split(",")) {
    const raw = entry.trim();
    if (!raw) continue;

    if (raw === "*" || raw === "all" || raw === "1" || raw === "true") {
      for (const f of ALL_DEBUG_FLAGS) flags.add(f);
      continue;
    }

    const flag = raw === "fs" ? "vfs" : raw;
    if (flag === "net" || flag === "exec" || flag === "vfs" || flag === "protocol") {
      flags.add(flag);
    }
  }

  return flags;
}

export function resolveDebugFlags(config: DebugConfig | undefined, envFlags = parseDebugEnv()) {
  if (config === undefined) {
    return envFlags;
  }
  if (config === true) {
    return new Set<DebugFlag>(ALL_DEBUG_FLAGS);
  }
  if (config === false) {
    return new Set<DebugFlag>();
  }

  const out = new Set<DebugFlag>();
  for (const flag of config) {
    if (flag === "net" || flag === "exec" || flag === "vfs" || flag === "protocol") {
      out.add(flag);
    }
  }
  return out;
}

export function debugFlagsToArray(flags: Set<DebugFlag>): DebugFlag[] {
  return Array.from(flags).sort();
}

export type DebugFlag = "net";

export function parseDebugEnv(value: string | undefined = process.env.GONDOLIN_DEBUG) {
  const flags = new Set<DebugFlag>();
  if (!value) return flags;
  for (const entry of value.split(",")) {
    const flag = entry.trim();
    if (!flag) continue;
    if (flag === "net") flags.add("net");
  }
  return flags;
}

export type RootfsMode = "readonly" | "memory" | "cow";

export function isRootfsMode(value: unknown): value is RootfsMode {
  return value === "readonly" || value === "memory" || value === "cow";
}

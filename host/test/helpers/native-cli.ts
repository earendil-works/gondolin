import fs from "node:fs";
import path from "node:path";

const nativeTarget = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "native",
  "target",
);

/**
 * The static `gondolin` CLI for tests: `$GONDOLIN_CLI_BIN`, else the newest
 * of `native/target/{release,debug}/gondolin` (`null` when not built).
 */
export function resolveNativeCli(): string | null {
  const explicit = process.env.GONDOLIN_CLI_BIN?.trim();
  if (explicit) return explicit;
  let best: { file: string; mtime: number } | null = null;
  for (const profile of ["release", "debug"]) {
    const file = path.join(nativeTarget, profile, "gondolin");
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    } catch {
      // not built
    }
  }
  return best?.file ?? null;
}

/** Guest assets of the checkout (`guest/image/out`), if built */
export function checkoutGuestDir(): string | null {
  const dir = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "guest",
    "image",
    "out",
  );
  return fs.existsSync(path.join(dir, "manifest.json")) ? dir : null;
}

/**
 * Disk helpers that need no disk tooling: root disk preparation (overlays,
 * resizing, checkpoint rebasing) is done by the daemon (`gondolind`).
 */

/** The disk format for a path: `.qcow2`/`.qcow` is qcow2, everything else raw */
export function inferDiskFormatFromPath(diskPath: string): "raw" | "qcow2" {
  const lower = diskPath.toLowerCase();
  if (lower.endsWith(".qcow2") || lower.endsWith(".qcow")) return "qcow2";
  return "raw";
}

/** Parse a disk size string into `bytes`. */
export function parseDiskSizeToBytes(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `invalid disk size: ${String(value)} (expected a positive integer byte count)`,
      );
    }
    return value;
  }

  if (typeof value !== "string") {
    throw new Error(
      `invalid disk size: ${String(value)} (expected a string like "2G")`,
    );
  }

  const trimmed = value.trim();
  const match = /^(\d+)\s*([a-zA-Z]*)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `invalid disk size: ${JSON.stringify(value)} (expected a positive integer with optional K/M/G/T/P/E suffix)`,
    );
  }

  const amount = BigInt(match[1]!);
  if (amount <= 0n) {
    throw new Error(
      `invalid disk size: ${JSON.stringify(value)} (expected a positive integer)`,
    );
  }

  let suffix = match[2]!.toLowerCase();
  if (suffix.endsWith("ib")) {
    suffix = suffix.slice(0, -2);
  } else if (suffix.endsWith("b")) {
    suffix = suffix.slice(0, -1);
  }

  const exponents: Record<string, number> = {
    "": 0,
    byte: 0,
    bytes: 0,
    k: 1,
    m: 2,
    g: 3,
    t: 4,
    p: 5,
    e: 6,
  };
  const exponent = exponents[suffix];
  if (exponent === undefined) {
    throw new Error(
      `invalid disk size suffix: ${JSON.stringify(match[2])} (expected K/M/G/T/P/E)`,
    );
  }

  const bytes = amount * 1024n ** BigInt(exponent);
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`disk size is too large: ${JSON.stringify(value)}`);
  }
  return Number(bytes);
}

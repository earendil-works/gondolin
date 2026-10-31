import path from "node:path";

/** Options for a single guest tmpfs mount */
export type GuestTmpfsMountOptions = {
  /** max size (`bytes`, or `k`/`m`/`g` suffix, or `%` of guest memory; default: half of guest memory) */
  size?: string | number;
  /** octal permission mode of the mount root (default: "1777") */
  mode?: string;
};

/**
 * Guest tmpfs mounts created by `/init` (guest path -> options)
 *
 * Replaces the built-in set entirely.  An empty object disables all scratch
 * tmpfs mounts so those paths are backed by the root disk instead.
 */
export type GuestTmpfsMounts = Record<string, GuestTmpfsMountOptions>;

/** Built-in tmpfs mounts used by `/init` when no `tmpfs` option is given */
export const DEFAULT_GUEST_TMPFS: Readonly<GuestTmpfsMounts> = Object.freeze({
  "/tmp": {},
  "/root": { mode: "0700" },
  "/var/tmp": {},
  "/var/cache": {},
  "/var/log": {},
});

/** Kernel cmdline parameter carrying the tmpfs mount list to `/init` */
export const TMPFS_CMDLINE_PARAM = "gondolin.tmpfs";

/** Guest paths `/init` mounts itself, which no configurable mount may cover */
export const RESERVED_GUEST_MOUNT_PATHS = ["/proc", "/sys", "/dev", "/run"];
/** Characters that would split a path out of a kernel cmdline mount list, or glob */
export const UNSUPPORTED_GUEST_MOUNT_PATH_CHARS = /[\s,:"'\\*?[\]\0]/;
const SIZE_RE = /^[0-9]+[kKmMgG%]?$/;
const MODE_RE = /^[0-7]{3,4}$/;

/**
 * Validate and normalize a tmpfs mount map
 *
 * Paths end up on the kernel cmdline and are word-split by `/init`, so
 * characters that would split the argument or the encoded list (whitespace,
 * `,`, `:`, quotes, `\`) or glob are rejected.
 */
export function normalizeGuestTmpfs(value: GuestTmpfsMounts): GuestTmpfsMounts {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tmpfs must be an object mapping guest paths to options");
  }
  const result: GuestTmpfsMounts = {};
  for (const [rawPath, rawOptions] of Object.entries(value)) {
    const guestPath = normalizeTmpfsPath(rawPath);
    if (Object.hasOwn(result, guestPath)) {
      throw new Error(`tmpfs path specified more than once: ${guestPath}`);
    }
    const options = rawOptions ?? {};
    if (typeof options !== "object" || Array.isArray(options)) {
      throw new Error(`tmpfs options for ${guestPath} must be an object`);
    }
    const normalized: GuestTmpfsMountOptions = {};
    if (options.size !== undefined) {
      normalized.size = normalizeTmpfsSize(options.size, guestPath);
    }
    if (options.mode !== undefined) {
      if (typeof options.mode !== "string" || !MODE_RE.test(options.mode)) {
        throw new Error(
          `tmpfs mode for ${guestPath} must be an octal string (e.g. "1777")`,
        );
      }
      normalized.mode = options.mode;
    }
    result[guestPath] = normalized;
  }
  return result;
}

/**
 * Build the `gondolin.tmpfs=` kernel cmdline argument
 *
 * Format: `gondolin.tmpfs=/path[:opt=value...][,/path...]`, or
 * `gondolin.tmpfs=none` when no tmpfs mounts are wanted.
 */
export function buildTmpfsAppend(tmpfs: GuestTmpfsMounts): string {
  const entries = Object.entries(normalizeGuestTmpfs(tmpfs))
    // parents have to be mounted before their children
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([guestPath, options]) => {
      const parts = [guestPath];
      if (options.size !== undefined) parts.push(`size=${options.size}`);
      if (options.mode !== undefined) parts.push(`mode=${options.mode}`);
      return parts.join(":");
    });
  return `${TMPFS_CMDLINE_PARAM}=${entries.length > 0 ? entries.join(",") : "none"}`;
}

function normalizeTmpfsPath(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error(`tmpfs path must be absolute: ${String(value)}`);
  }
  let normalized = path.posix.normalize(value);
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized === "/") {
    throw new Error("tmpfs cannot be mounted over /");
  }
  if (UNSUPPORTED_GUEST_MOUNT_PATH_CHARS.test(normalized)) {
    throw new Error(
      `tmpfs path contains unsupported characters (whitespace, ',', ':', quotes, glob characters or '\\'): ${normalized}`,
    );
  }
  for (const reserved of RESERVED_GUEST_MOUNT_PATHS) {
    if (normalized === reserved || normalized.startsWith(`${reserved}/`)) {
      throw new Error(
        `tmpfs cannot be mounted at reserved path: ${normalized}`,
      );
    }
  }
  return normalized;
}

function normalizeTmpfsSize(value: string | number, guestPath: string) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `tmpfs size for ${guestPath} must be a positive integer number of bytes`,
      );
    }
    return String(value);
  }
  if (
    typeof value !== "string" ||
    !SIZE_RE.test(value) ||
    /^0+\D?$/.test(value)
  ) {
    throw new Error(
      `tmpfs size for ${guestPath} must be bytes, a k/m/g suffixed size or a percentage (e.g. "512m", "25%")`,
    );
  }
  return value;
}

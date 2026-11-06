/**
 * Locating `gondolind` binaries: for this machine (`resolveNativeBinary`) and
 * for other platforms, e.g. a remote Linux host that pi-env bootstraps
 * (`getNativeBinaryPath`, `ensureNativeBinary`).
 *
 * Binaries come from (in order):
 * 1. `GONDOLIN_NATIVE_BIN` (this machine only);
 * 2. a source checkout containing this package: for this machine the newer
 *    of `native/target/{release,debug}/gondolind`, for other platforms
 *    `native/target/dist/<rust-target>/gondolind` (`make native-release`);
 * 3. the installed platform package `@earendil-works/gondolin-native-<platform>-<arch>`;
 * 4. (`ensureNativeBinary` only) that package fetched from the npm registry
 *    into `~/.cache/gondolin/native/<version>/<platform>-<arch>/`. Package
 *    managers only install the optional dependency matching the host, so this
 *    is how a macOS controller gets the Linux binary for a remote machine.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { parseTar } from "../alpine/tar.ts";
import { getAssetVersion } from "../assets.ts";
import { gondolinCacheDir } from "../cache.ts";

/** Operating system of a `gondolind` binary */
export type NativePlatform = "darwin" | "linux";
/** CPU architecture of a `gondolind` binary (node naming) */
export type NativeArch = "arm64" | "x64";

export type NativeBinaryTarget = {
  /** target operating system */
  platform: NativePlatform;
  /** target cpu architecture */
  arch: NativeArch;
};

const RUST_TARGETS: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
};

const require = createRequire(import.meta.url);

function targetKey(target: NativeBinaryTarget): string {
  const key = `${target.platform}-${target.arch}`;
  if (!RUST_TARGETS[key]) {
    throw new Error(
      `unsupported gondolind platform ${key} (supported: ${Object.keys(RUST_TARGETS).join(", ")})`,
    );
  }
  return key;
}

/** npm package carrying `gondolind` for `target` */
export function nativePackageName(target: NativeBinaryTarget): string {
  return `@earendil-works/gondolin-native-${targetKey(target)}`;
}

/** Rust target triple of the `gondolind` build for `target` */
export function nativeRustTarget(target: NativeBinaryTarget): string {
  return RUST_TARGETS[targetKey(target)]!;
}

function hostTarget(): NativeBinaryTarget | null {
  const platform = process.platform;
  const arch = process.arch;
  if (
    (platform === "darwin" || platform === "linux") &&
    (arch === "arm64" || arch === "x64")
  ) {
    return { platform, arch };
  }
  return null;
}

/**
 * Platform and architecture of an executable from its ELF / Mach-O header
 * (`null` for anything else, e.g. the workspace placeholder script).
 */
export function describeNativeExecutable(
  file: string,
): NativeBinaryTarget | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(20);
    if (fs.readSync(fd, buf, 0, buf.length, 0) < buf.length) return null;
    if (buf.readUInt32BE(0) === 0x7f454c46) {
      const machine = buf.readUInt16LE(18);
      if (machine === 0xb7) return { platform: "linux", arch: "arm64" };
      if (machine === 0x3e) return { platform: "linux", arch: "x64" };
      return null;
    }
    if (buf.readUInt32LE(0) === 0xfeedfacf) {
      const cpu = buf.readUInt32LE(4);
      if (cpu === 0x0100000c) return { platform: "darwin", arch: "arm64" };
      if (cpu === 0x01000007) return { platform: "darwin", arch: "x64" };
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function matches(file: string, target: NativeBinaryTarget): boolean {
  const info = describeNativeExecutable(file);
  return info?.platform === target.platform && info.arch === target.arch;
}

/** The source checkout root (has `native/Cargo.toml`) above `start` */
function findCheckout(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, "native", "Cargo.toml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function newest(files: string[]): string | null {
  let best: { file: string; mtime: number } | null = null;
  for (const file of files) {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    } catch {
      // missing
    }
  }
  return best?.file ?? null;
}

/**
 * The checkout's build for `target`: for this machine the newer of
 * `native/target/{release,debug}/gondolind` (so a stale release build does not
 * shadow a fresh debug build or vice versa), for other platforms the static
 * build from `make native-release` in `native/target/dist/<rust-target>/`.
 */
function checkoutBinary(
  target: NativeBinaryTarget,
  start: string,
): string | null {
  const root = findCheckout(start);
  if (!root) return null;
  const native = path.join(root, "native", "target");
  const host = hostTarget();
  const isHost =
    host !== null &&
    host.platform === target.platform &&
    host.arch === target.arch;
  const candidates = isHost
    ? [
        path.join(native, "release", "gondolind"),
        path.join(native, "debug", "gondolind"),
      ]
    : [path.join(native, "dist", nativeRustTarget(target), "gondolind")];
  return newest(candidates.filter((f) => matches(f, target)));
}

function packagedBinary(target: NativeBinaryTarget): string | null {
  try {
    const pkgJson = require.resolve(
      `${nativePackageName(target)}/package.json`,
    );
    const file = path.join(path.dirname(pkgJson), "bin", "gondolind");
    return matches(file, target) ? file : null;
  } catch {
    return null;
  }
}

function cachedBinaryPath(target: NativeBinaryTarget, version: string): string {
  return gondolinCacheDir(
    "native",
    version.replace(/^v/, ""),
    targetKey(target),
    "gondolind",
  );
}

function packageVersion(): string {
  return getAssetVersion().replace(/^v/, "");
}

export type NativeBinaryLookupOptions = {
  /** where to start looking for a source checkout (default: this module) */
  start?: string;
  /** package version for the download cache (default: this package's version) */
  version?: string;
};

/**
 * Path of a `gondolind` for `target` available without downloading, or `null`
 * (see the module docs for the search order; `GONDOLIN_NATIVE_BIN` is not
 * consulted since it names a binary for this machine).
 */
export function getNativeBinaryPath(
  target: NativeBinaryTarget,
  options: NativeBinaryLookupOptions = {},
): string | null {
  const start = options.start ?? import.meta.dirname;
  const cached = cachedBinaryPath(target, options.version ?? packageVersion());
  return (
    checkoutBinary(target, start) ??
    packagedBinary(target) ??
    (matches(cached, target) ? cached : null)
  );
}

export type EnsureNativeBinaryOptions = NativeBinaryLookupOptions & {
  /** npm registry base URL (default: `$npm_config_registry` or registry.npmjs.org) */
  registry?: string;
  /** fetch implementation (tests) */
  fetch?: typeof fetch;
};

function verifyIntegrity(
  data: Buffer,
  integrity: string | undefined,
  shasum: string | undefined,
) {
  if (integrity?.startsWith("sha512-")) {
    const got = createHash("sha512").update(data).digest("base64");
    if (`sha512-${got}` !== integrity) {
      throw new Error(
        `gondolind package integrity mismatch (expected ${integrity})`,
      );
    }
    return;
  }
  if (shasum) {
    const got = createHash("sha1").update(data).digest("hex");
    if (got !== shasum) {
      throw new Error(
        `gondolind package shasum mismatch (expected ${shasum}, got ${got})`,
      );
    }
    return;
  }
  throw new Error("gondolind package metadata has no integrity hash");
}

/**
 * Like {@link getNativeBinaryPath}, but fetches the platform package from the
 * npm registry (integrity-checked) into the cache when nothing local exists.
 * Resolves to the binary path.
 */
export async function ensureNativeBinary(
  target: NativeBinaryTarget,
  options: EnsureNativeBinaryOptions = {},
): Promise<string> {
  const local = getNativeBinaryPath(target, options);
  if (local) return local;

  const version = (options.version ?? packageVersion()).replace(/^v/, "");
  const name = nativePackageName(target);
  const registry = (
    options.registry ??
    process.env.npm_config_registry ??
    "https://registry.npmjs.org"
  ).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  const metaUrl = `${registry}/${name.replace("/", "%2f")}/${version}`;
  const metaResponse = await doFetch(metaUrl, {
    headers: { accept: "application/json" },
  });
  if (!metaResponse.ok) {
    throw new Error(
      `failed to fetch ${name}@${version} metadata: ${metaResponse.status} ${metaResponse.statusText} (${metaUrl})`,
    );
  }
  const meta = (await metaResponse.json()) as {
    dist?: { tarball?: string; integrity?: string; shasum?: string };
  };
  const tarball = meta.dist?.tarball;
  if (!tarball) throw new Error(`${name}@${version} has no tarball`);
  const tgzResponse = await doFetch(tarball);
  if (!tgzResponse.ok) {
    throw new Error(
      `failed to download ${tarball}: ${tgzResponse.status} ${tgzResponse.statusText}`,
    );
  }
  const tgz = Buffer.from(await tgzResponse.arrayBuffer());
  verifyIntegrity(tgz, meta.dist?.integrity, meta.dist?.shasum);

  const entry = parseTar(gunzipSync(tgz)).find(
    (e) => e.name === "package/bin/gondolind" && e.content,
  );
  if (!entry?.content)
    throw new Error(`${name}@${version} contains no bin/gondolind`);

  const dest = cachedBinaryPath(target, version);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, entry.content, { mode: 0o755 });
  if (!matches(tmp, target)) {
    fs.rmSync(tmp, { force: true });
    throw new Error(
      `${name}@${version} does not contain a ${targetKey(target)} gondolind`,
    );
  }
  fs.renameSync(tmp, dest);
  return dest;
}

/**
 * Locate `gondolind` for this machine: `GONDOLIN_NATIVE_BIN`, else the newest
 * checkout build, else the installed platform package.
 */
export function resolveNativeBinary(
  env: NodeJS.ProcessEnv = process.env,
  start: string = import.meta.dirname,
): string {
  const explicit = env.GONDOLIN_NATIVE_BIN?.trim();
  if (explicit) return explicit;

  const host = hostTarget();
  if (host) {
    const found = checkoutBinary(host, start) ?? packagedBinary(host);
    if (found) return found;
  }

  throw new Error(
    host
      ? `gondolind binary not found (install ${nativePackageName(host)}, build it with \`make native\`, or set GONDOLIN_NATIVE_BIN)`
      : `gondolind is not available for ${process.platform}-${process.arch} (set GONDOLIN_NATIVE_BIN)`,
  );
}

import path from "node:path";
import type { Dirent } from "node:fs";

import { createErrnoError } from "./errors";
import type { VirtualFileHandle, VirtualProvider, VfsStatfs } from "./node";
import { delegateStatfsOrEnosys } from "./statfs";
import {
  ERRNO,
  isWriteFlag,
  normalizeVfsPath,
  VirtualProviderClass,
} from "./utils";
import { MemoryProvider } from "./node";

export type ShadowWriteMode =
  /** reject any write/mutation against shadowed paths */
  | "deny"
  /** route writes to an in-memory provider so the guest can create its own files */
  | "tmpfs";

export type ShadowContext = {
  /** operation name */
  op: string;
  /** absolute posix path */
  path: string;
  /** open flags (for open/create) */
  flags?: string;
  /** source path for rename */
  oldPath?: string;
  /** destination path for rename */
  newPath?: string;
};

export type ShadowPredicate = (ctx: ShadowContext) => boolean;

export type ShadowProviderOptions = {
  /** policy callback that returns true if a path should be shadowed */
  shouldShadow: ShadowPredicate;

  /** behavior for write operations targeting shadowed paths (default: "deny") */
  writeMode?: ShadowWriteMode;

  /** provider used for shadowed writes when writeMode is "tmpfs" (default: new MemoryProvider()) */
  tmpfs?: VirtualProvider;

  /**
   * If true, additionally consult `backend.realpath()` and apply shadow policy to the resolved path
   *
   * This blocks trivial symlink bypasses (e.g. `ln -s .envrc x; cat x`).
   *
   * Default: true
   */
  denySymlinkBypass?: boolean;

  /**
   * Errno used for denied write operations (default: EACCES)
   *
   * Read operations always behave like the path does not exist (ENOENT).
   */
  denyWriteErrno?: number;
};

/**
 * Convenience helper to turn a list of shadowed paths into a ShadowPredicate
 *
 * The provided paths are interpreted as absolute VFS paths within the provider (rooted at `/`).
 *
 * Note: inputs are normalized with `normalizeVfsPath()`, so a relative string like
 * `".env"` will be treated as `"/.env"` (it is not relative to the directory being accessed).
 */
export function createShadowPathPredicate(
  shadowPaths: string[],
): ShadowPredicate {
  const normalized = Array.from(
    new Set(
      shadowPaths.map((p) => normalizeVfsPath(p)).filter((p) => p !== "/"),
    ),
  ).sort((a, b) => b.length - a.length);

  return ({ path }) => {
    const p = normalizeVfsPath(path);
    for (const shadow of normalized) {
      if (p === shadow) return true;
      if (p.startsWith(shadow + "/")) return true;
    }
    return false;
  };
}

function isNoEntryError(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const error = err as NodeJS.ErrnoException;
  return (
    error.code === "ENOENT" ||
    error.code === "ERRNO_2" ||
    error.errno === ERRNO.ENOENT
  );
}

function getEntryName(entry: string | Dirent) {
  return typeof entry === "string" ? entry : entry.name;
}

/**
 * Wraps a provider and shadows any path for which `shouldShadow(...)` returns true.
 *
 * Semantics:
 * - Read-ish ops (stat, open for read, access, readdir) behave as if it doesn’t exist (ENOENT)
 * - Shadowed entries are omitted from directory listings (unless present in tmpfs upper layer)
 * - Write ops are either denied (default) or redirected to tmpfs
 */
export class ShadowProvider
  extends VirtualProviderClass
  implements VirtualProvider
{
  private readonly shouldShadow: ShadowPredicate;
  private readonly writeMode: ShadowWriteMode;
  private readonly tmpfs: VirtualProvider;
  private readonly denySymlinkBypass: boolean;
  private readonly denyWriteErrno: number;
  private readonly backend: VirtualProvider;

  constructor(backend: VirtualProvider, options: ShadowProviderOptions) {
    super();
    this.backend = backend;
    if (!options || typeof options.shouldShadow !== "function") {
      throw new Error("ShadowProvider requires options.shouldShadow callback");
    }
    this.shouldShadow = options.shouldShadow;
    this.writeMode = options.writeMode ?? "deny";
    this.tmpfs = options.tmpfs ?? new MemoryProvider();
    this.denySymlinkBypass = options.denySymlinkBypass ?? true;
    this.denyWriteErrno = options.denyWriteErrno ?? ERRNO.EACCES;
  }

  get readonly() {
    // Keep backend hint; shadow writes in tmpfs mode can still succeed.
    return this.backend.readonly;
  }

  get supportsSymlinks() {
    return this.backend.supportsSymlinks;
  }

  get supportsWatch() {
    return this.backend.supportsWatch;
  }

  // === core shadow checks ===

  private shadowedFor(op: string, entryPath: string, flags?: string) {
    const p = normalizeVfsPath(entryPath);
    return this.shouldShadow({ op, path: p, flags });
  }

  private shadowedForRename(op: string, oldPath: string, newPath: string) {
    const from = normalizeVfsPath(oldPath);
    const to = normalizeVfsPath(newPath);
    const fromShadow = this.shouldShadow({
      op,
      path: from,
      oldPath: from,
      newPath: to,
    });
    const toShadow = this.shouldShadow({
      op,
      path: to,
      oldPath: from,
      newPath: to,
    });
    return { from, to, fromShadow, toShadow };
  }

  private async resolvesToShadowed(
    op: string,
    entryPath: string,
    flags?: string,
  ) {
    if (!this.denySymlinkBypass || !this.backend.realpath) return false;
    try {
      const resolved = normalizeVfsPath(
        await this.backend.realpath(normalizeVfsPath(entryPath)),
      );
      return this.shouldShadow({ op, path: resolved, flags });
    } catch {
      return false;
    }
  }

  private resolvesToShadowedSync(
    op: string,
    entryPath: string,
    flags?: string,
  ) {
    if (!this.denySymlinkBypass || !this.backend.realpathSync) return false;
    try {
      const resolved = normalizeVfsPath(
        this.backend.realpathSync(normalizeVfsPath(entryPath)),
      );
      return this.shouldShadow({ op, path: resolved, flags });
    } catch {
      return false;
    }
  }

  // === provider API ===

  async open(
    entryPath: string,
    flags: string,
    mode?: number,
  ): Promise<VirtualFileHandle> {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("open", p, flags) ||
      (await this.resolvesToShadowed("open", p, flags))
    ) {
      return this.openShadowed(p, flags, mode);
    }

    return this.backend.open(p, flags, mode);
  }

  openSync(entryPath: string, flags: string, mode?: number): VirtualFileHandle {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("open", p, flags) ||
      this.resolvesToShadowedSync("open", p, flags)
    ) {
      return this.openShadowedSync(p, flags, mode);
    }

    return this.backend.openSync(p, flags, mode);
  }

  async stat(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("stat", p) ||
      (await this.resolvesToShadowed("stat", p))
    ) {
      return this.statShadowed(p, options);
    }

    return this.backend.stat(p, options);
  }

  statSync(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (this.shadowedFor("stat", p) || this.resolvesToShadowedSync("stat", p)) {
      return this.statShadowedSync(p, options);
    }

    return this.backend.statSync(p, options);
  }

  async lstat(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("lstat", p) ||
      (await this.resolvesToShadowed("lstat", p))
    ) {
      return this.lstatShadowed(p, options);
    }

    return this.backend.lstat(p, options);
  }

  lstatSync(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("lstat", p) ||
      this.resolvesToShadowedSync("lstat", p)
    ) {
      return this.lstatShadowedSync(p, options);
    }

    return this.backend.lstatSync(p, options);
  }

  async readdir(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    // If the directory itself is shadowed, it behaves as non-existent.
    if (
      this.shadowedFor("readdir", p) ||
      (await this.resolvesToShadowed("readdir", p))
    ) {
      return this.readdirShadowed(p, options);
    }

    const lower = (await this.backend.readdir(p, options)) as Array<
      string | Dirent
    >;
    const withTypes = Boolean(
      (options as { withFileTypes?: boolean } | undefined)?.withFileTypes,
    );

    // Filter lower entries by policy.
    const filteredLower = lower.filter((entry) => {
      const name = getEntryName(entry);
      const child = normalizeVfsPath(path.posix.join(p, name));
      return !this.shouldShadow({ op: "readdir", path: child });
    });

    if (this.writeMode !== "tmpfs") {
      return filteredLower;
    }

    // Merge tmpfs upper layer entries (these are visible even if shadowed).
    const upper = await this.tryReaddirUpper(p, options);
    if (upper.length === 0) return filteredLower;

    const merged: Array<string | Dirent> = [...filteredLower];
    const seen = new Set(merged.map(getEntryName));

    for (const entry of upper) {
      const name = getEntryName(entry);
      if (seen.has(name)) {
        if (withTypes) {
          const idx = merged.findIndex((e) => getEntryName(e) === name);
          if (idx !== -1) merged[idx] = entry;
        }
        continue;
      }
      seen.add(name);
      merged.push(entry);
    }

    return merged;
  }

  readdirSync(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("readdir", p) ||
      this.resolvesToShadowedSync("readdir", p)
    ) {
      return this.readdirShadowedSync(p, options);
    }

    const lower = this.backend.readdirSync(p, options) as Array<
      string | Dirent
    >;
    const withTypes = Boolean(
      (options as { withFileTypes?: boolean } | undefined)?.withFileTypes,
    );

    const filteredLower = lower.filter((entry) => {
      const name = getEntryName(entry);
      const child = normalizeVfsPath(path.posix.join(p, name));
      return !this.shouldShadow({ op: "readdir", path: child });
    });

    if (this.writeMode !== "tmpfs") {
      return filteredLower;
    }

    const upper = this.tryReaddirUpperSync(p, options);
    if (upper.length === 0) return filteredLower;

    const merged: Array<string | Dirent> = [...filteredLower];
    const seen = new Set(merged.map(getEntryName));

    for (const entry of upper) {
      const name = getEntryName(entry);
      if (seen.has(name)) {
        if (withTypes) {
          const idx = merged.findIndex((e) => getEntryName(e) === name);
          if (idx !== -1) merged[idx] = entry;
        }
        continue;
      }
      seen.add(name);
      merged.push(entry);
    }

    return merged;
  }

  async mkdir(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("mkdir", p) ||
      (await this.resolvesToShadowed("mkdir", p))
    ) {
      return this.writeShadowed("mkdir", p, () => this.tmpfs.mkdir(p, options));
    }

    return this.backend.mkdir(p, options);
  }

  mkdirSync(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("mkdir", p) ||
      this.resolvesToShadowedSync("mkdir", p)
    ) {
      return this.writeShadowedSync("mkdir", p, () =>
        this.tmpfs.mkdirSync(p, options),
      );
    }

    return this.backend.mkdirSync(p, options);
  }

  async rmdir(entryPath: string) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("rmdir", p) ||
      (await this.resolvesToShadowed("rmdir", p))
    ) {
      return this.writeShadowed("rmdir", p, async () => {
        try {
          await this.tmpfs.rmdir(p);
        } catch (err) {
          if (!isNoEntryError(err)) throw err;
        }
      });
    }

    return this.backend.rmdir(p);
  }

  rmdirSync(entryPath: string) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("rmdir", p) ||
      this.resolvesToShadowedSync("rmdir", p)
    ) {
      return this.writeShadowedSync("rmdir", p, () => {
        try {
          return this.tmpfs.rmdirSync(p);
        } catch (err) {
          if (!isNoEntryError(err)) throw err;
        }
      });
    }

    return this.backend.rmdirSync(p);
  }

  async unlink(entryPath: string) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("unlink", p) ||
      (await this.resolvesToShadowed("unlink", p))
    ) {
      return this.writeShadowed("unlink", p, async () => {
        try {
          await this.tmpfs.unlink(p);
        } catch (err) {
          if (!isNoEntryError(err)) throw err;
        }
      });
    }

    return this.backend.unlink(p);
  }

  unlinkSync(entryPath: string) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("unlink", p) ||
      this.resolvesToShadowedSync("unlink", p)
    ) {
      return this.writeShadowedSync("unlink", p, () => {
        try {
          return this.tmpfs.unlinkSync(p);
        } catch (err) {
          if (!isNoEntryError(err)) throw err;
        }
      });
    }

    return this.backend.unlinkSync(p);
  }

  async rename(oldPath: string, newPath: string) {
    const { from, to, fromShadow, toShadow } = this.shadowedForRename(
      "rename",
      oldPath,
      newPath,
    );

    const fromResolved = this.denySymlinkBypass
      ? await this.resolvesToShadowed("rename", from)
      : false;
    const toResolved = this.denySymlinkBypass
      ? await this.resolvesToShadowed("rename", to)
      : false;

    const shadow = fromShadow || toShadow || fromResolved || toResolved;

    if (shadow) {
      if (
        this.writeMode === "tmpfs" &&
        (fromShadow || fromResolved) &&
        (toShadow || toResolved)
      ) {
        return this.tmpfs.rename(from, to);
      }
      throw createErrnoError(ERRNO.EXDEV, "rename", `${from} -> ${to}`);
    }

    return this.backend.rename(from, to);
  }

  renameSync(oldPath: string, newPath: string) {
    const { from, to, fromShadow, toShadow } = this.shadowedForRename(
      "rename",
      oldPath,
      newPath,
    );

    const fromResolved = this.denySymlinkBypass
      ? this.resolvesToShadowedSync("rename", from)
      : false;
    const toResolved = this.denySymlinkBypass
      ? this.resolvesToShadowedSync("rename", to)
      : false;

    const shadow = fromShadow || toShadow || fromResolved || toResolved;

    if (shadow) {
      if (
        this.writeMode === "tmpfs" &&
        (fromShadow || fromResolved) &&
        (toShadow || toResolved)
      ) {
        return this.tmpfs.renameSync(from, to);
      }
      throw createErrnoError(ERRNO.EXDEV, "rename", `${from} -> ${to}`);
    }

    return this.backend.renameSync(from, to);
  }

  async readlink(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("readlink", p) ||
      (await this.resolvesToShadowed("readlink", p))
    ) {
      if (this.writeMode === "tmpfs" && this.tmpfs.readlink) {
        return this.tmpfs.readlink(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "readlink", p);
    }

    if (this.backend.readlink) {
      return this.backend.readlink(p, options);
    }
    return super.readlink(p, options);
  }

  readlinkSync(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("readlink", p) ||
      this.resolvesToShadowedSync("readlink", p)
    ) {
      if (this.writeMode === "tmpfs" && this.tmpfs.readlinkSync) {
        return this.tmpfs.readlinkSync(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "readlink", p);
    }

    if (this.backend.readlinkSync) {
      return this.backend.readlinkSync(p, options);
    }
    return super.readlinkSync(p, options);
  }

  async symlink(target: string, entryPath: string, type?: string) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("symlink", p) ||
      (await this.resolvesToShadowed("symlink", p))
    ) {
      return this.writeShadowed("symlink", p, () => {
        if (this.tmpfs.symlink) {
          return this.tmpfs.symlink(target, p, type);
        }
        return super.symlink(target, p, type);
      });
    }

    if (this.backend.symlink) {
      return this.backend.symlink(target, p, type);
    }
    return super.symlink(target, p, type);
  }

  symlinkSync(target: string, entryPath: string, type?: string) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("symlink", p) ||
      this.resolvesToShadowedSync("symlink", p)
    ) {
      return this.writeShadowedSync("symlink", p, () => {
        if (this.tmpfs.symlinkSync) {
          return this.tmpfs.symlinkSync(target, p, type);
        }
        return super.symlinkSync(target, p, type);
      });
    }

    if (this.backend.symlinkSync) {
      return this.backend.symlinkSync(target, p, type);
    }
    return super.symlinkSync(target, p, type);
  }

  async realpath(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("realpath", p) ||
      (await this.resolvesToShadowed("realpath", p))
    ) {
      if (this.writeMode === "tmpfs") {
        if (this.tmpfs.realpath) {
          return this.tmpfs.realpath(p, options);
        }
        return super.realpath(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "realpath", p);
    }

    if (this.backend.realpath) {
      return this.backend.realpath(p, options);
    }
    return super.realpath(p, options);
  }

  realpathSync(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("realpath", p) ||
      this.resolvesToShadowedSync("realpath", p)
    ) {
      if (this.writeMode === "tmpfs") {
        if (this.tmpfs.realpathSync) {
          return this.tmpfs.realpathSync(p, options);
        }
        return super.realpathSync(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "realpath", p);
    }

    if (this.backend.realpathSync) {
      return this.backend.realpathSync(p, options);
    }
    return super.realpathSync(p, options);
  }

  async access(entryPath: string, mode?: number) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("access", p) ||
      (await this.resolvesToShadowed("access", p))
    ) {
      if (this.writeMode === "tmpfs") {
        if (this.tmpfs.access) {
          return this.tmpfs.access(p, mode);
        }
        return super.access(p, mode);
      }
      throw createErrnoError(ERRNO.ENOENT, "access", p);
    }

    if (this.backend.access) {
      return this.backend.access(p, mode);
    }
    return super.access(p, mode);
  }

  accessSync(entryPath: string, mode?: number) {
    const p = normalizeVfsPath(entryPath);

    if (
      this.shadowedFor("access", p) ||
      this.resolvesToShadowedSync("access", p)
    ) {
      if (this.writeMode === "tmpfs") {
        if (this.tmpfs.accessSync) {
          return this.tmpfs.accessSync(p, mode);
        }
        return super.accessSync(p, mode);
      }
      throw createErrnoError(ERRNO.ENOENT, "access", p);
    }

    if (this.backend.accessSync) {
      return this.backend.accessSync(p, mode);
    }
    return super.accessSync(p, mode);
  }

  async statfs(entryPath: string): Promise<VfsStatfs> {
    const normalizedPath = normalizeVfsPath(entryPath);
    return delegateStatfsOrEnosys(this.backend, normalizedPath);
  }

  watch(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);
    return this.backend.watch?.(p, options) ?? super.watch(p, options);
  }

  watchAsync(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);
    return (
      this.backend.watchAsync?.(p, options) ?? super.watchAsync(p, options)
    );
  }

  watchFile(
    entryPath: string,
    options?: object,
    listener?: (...args: unknown[]) => void,
  ) {
    const p = normalizeVfsPath(entryPath);
    return (
      this.backend.watchFile?.(p, options, listener) ??
      super.watchFile(p, options, listener)
    );
  }

  unwatchFile(entryPath: string, listener?: (...args: unknown[]) => void) {
    const p = normalizeVfsPath(entryPath);
    if (this.backend.unwatchFile) {
      this.backend.unwatchFile(p, listener);
      return;
    }
    super.unwatchFile(p, listener);
  }

  async close() {
    const backend = this.backend as { close?: () => Promise<void> | void };
    if (backend.close) {
      await backend.close();
    }
    const tmp = this.tmpfs as { close?: () => Promise<void> | void };
    if (tmp.close) {
      await tmp.close();
    }
  }

  // === shadowed operation helpers ===

  private async openShadowed(
    entryPath: string,
    flags: string,
    mode?: number,
  ): Promise<VirtualFileHandle> {
    if (this.writeMode === "tmpfs") {
      return this.tmpfs.open(entryPath, flags, mode);
    }

    if (isWriteFlag(flags)) {
      throw createErrnoError(this.denyWriteErrno, "open", entryPath);
    }
    throw createErrnoError(ERRNO.ENOENT, "open", entryPath);
  }

  private openShadowedSync(
    entryPath: string,
    flags: string,
    mode?: number,
  ): VirtualFileHandle {
    if (this.writeMode === "tmpfs") {
      return this.tmpfs.openSync(entryPath, flags, mode);
    }

    if (isWriteFlag(flags)) {
      throw createErrnoError(this.denyWriteErrno, "open", entryPath);
    }
    throw createErrnoError(ERRNO.ENOENT, "open", entryPath);
  }

  private async statShadowed(entryPath: string, options?: object) {
    if (this.writeMode === "tmpfs") {
      return this.tmpfs.stat(entryPath, options);
    }
    throw createErrnoError(ERRNO.ENOENT, "stat", entryPath);
  }

  private statShadowedSync(entryPath: string, options?: object) {
    if (this.writeMode === "tmpfs") {
      return this.tmpfs.statSync(entryPath, options);
    }
    throw createErrnoError(ERRNO.ENOENT, "stat", entryPath);
  }

  private async lstatShadowed(entryPath: string, options?: object) {
    if (this.writeMode === "tmpfs") {
      return this.tmpfs.lstat(entryPath, options);
    }
    throw createErrnoError(ERRNO.ENOENT, "lstat", entryPath);
  }

  private lstatShadowedSync(entryPath: string, options?: object) {
    if (this.writeMode === "tmpfs") {
      return this.tmpfs.lstatSync(entryPath, options);
    }
    throw createErrnoError(ERRNO.ENOENT, "lstat", entryPath);
  }

  private async readdirShadowed(entryPath: string, options?: object) {
    if (this.writeMode === "tmpfs") {
      return this.tmpfs.readdir(entryPath, options);
    }
    throw createErrnoError(ERRNO.ENOENT, "readdir", entryPath);
  }

  private readdirShadowedSync(entryPath: string, options?: object) {
    if (this.writeMode === "tmpfs") {
      return this.tmpfs.readdirSync(entryPath, options);
    }
    throw createErrnoError(ERRNO.ENOENT, "readdir", entryPath);
  }

  private async tryReaddirUpper(entryPath: string, options?: object) {
    try {
      return (await this.tmpfs.readdir(entryPath, options)) as Array<
        string | Dirent
      >;
    } catch (err) {
      if (isNoEntryError(err)) return [];
      throw err;
    }
  }

  private tryReaddirUpperSync(entryPath: string, options?: object) {
    try {
      return this.tmpfs.readdirSync(entryPath, options) as Array<
        string | Dirent
      >;
    } catch (err) {
      if (isNoEntryError(err)) return [];
      throw err;
    }
  }

  private async writeShadowed<T>(
    op: string,
    entryPath: string,
    fn: () => Promise<T> | T,
  ) {
    if (this.writeMode === "deny") {
      throw createErrnoError(this.denyWriteErrno, op, entryPath);
    }
    return await fn();
  }

  private writeShadowedSync<T>(op: string, entryPath: string, fn: () => T) {
    if (this.writeMode === "deny") {
      throw createErrnoError(this.denyWriteErrno, op, entryPath);
    }
    return fn();
  }
}

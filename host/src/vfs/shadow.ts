import path from "node:path";
import type { Dirent } from "node:fs";

import { createErrnoError } from "./errors";
import type { VirtualProvider, VirtualFileHandle } from "./node";
import { ERRNO, isWriteFlag, normalizeVfsPath, VirtualProviderClass } from "./utils";
import { MemoryProvider } from "./node";

export type ShadowWriteMode =
  /** reject any write/mutation against shadowed paths */
  | "deny"
  /** route writes to an in-memory provider so the guest can create its own files */
  | "tmpfs";

export type ShadowProviderOptions = {
  /** paths (absolute, provider-relative) to shadow */
  shadowPaths: string[];

  /** behavior for write operations targeting shadowed paths (default: "deny") */
  writeMode?: ShadowWriteMode;

  /** provider used for shadowed writes when writeMode is "tmpfs" (default: new MemoryProvider()) */
  tmpfs?: VirtualProvider;

  /**
   * If true, block access to any path that resolves (via realpath) to a shadowed path
   *
   * This prevents trivial bypass via symlinks (e.g. `ln -s .envrc x; cat x`).
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

function isNoEntryError(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const error = err as NodeJS.ErrnoException;
  return error.code === "ENOENT" || error.code === "ERRNO_2" || error.errno === ERRNO.ENOENT;
}

function getEntryName(entry: string | Dirent) {
  return typeof entry === "string" ? entry : entry.name;
}

/**
 * Wraps a provider and "shadows" a list of paths.
 *
 * - Read-ish operations behave as if the shadowed path does not exist (ENOENT)
 * - Shadowed entries are omitted from parent directory listings
 * - Optionally, writes to shadowed paths can be redirected to an in-memory provider
 */
export class ShadowProvider extends VirtualProviderClass implements VirtualProvider {
  private readonly shadowPaths: string[];
  private readonly writeMode: ShadowWriteMode;
  private readonly tmpfs: VirtualProvider;
  private readonly denySymlinkBypass: boolean;
  private readonly denyWriteErrno: number;

  constructor(
    private readonly backend: VirtualProvider,
    options: ShadowProviderOptions
  ) {
    super();
    if (!options || !Array.isArray(options.shadowPaths) || options.shadowPaths.length === 0) {
      throw new Error("ShadowProvider requires non-empty shadowPaths");
    }

    this.shadowPaths = Array.from(
      new Set(
        options.shadowPaths
          .map((p) => normalizeVfsPath(p))
          .filter((p) => p !== "/")
      )
    ).sort((a, b) => b.length - a.length);

    if (this.shadowPaths.length === 0) {
      throw new Error("ShadowProvider shadowPaths cannot be just '/'");
    }

    this.writeMode = options.writeMode ?? "deny";
    this.tmpfs = options.tmpfs ?? new MemoryProvider();
    this.denySymlinkBypass = options.denySymlinkBypass ?? true;
    this.denyWriteErrno = options.denyWriteErrno ?? ERRNO.EACCES;
  }

  get readonly() {
    // If backend is readonly, we're readonly regardless.
    // If we're in deny mode, also readonly for shadowed paths but not globally.
    // Expose backend readonly since callers typically only use it as a hint.
    return this.backend.readonly;
  }

  get supportsSymlinks() {
    // We may block some symlink access via policy, but capability remains.
    return this.backend.supportsSymlinks;
  }

  get supportsWatch() {
    return this.backend.supportsWatch;
  }

  async open(entryPath: string, flags: string, mode?: number): Promise<VirtualFileHandle> {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p)) {
      if (isWriteFlag(flags)) {
        return this.openShadowed(p, flags, mode);
      }
      // read-only open: only succeeds if shadow tmpfs contains the entry
      return this.openShadowed(p, flags, mode);
    }

    if (this.denySymlinkBypass && (await this.resolvesToShadowed(p))) {
      throw createErrnoError(ERRNO.ENOENT, "open", p);
    }

    return this.backend.open(p, flags, mode);
  }

  openSync(entryPath: string, flags: string, mode?: number): VirtualFileHandle {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p)) {
      return this.openShadowedSync(p, flags, mode);
    }

    if (this.denySymlinkBypass && this.resolvesToShadowedSync(p)) {
      throw createErrnoError(ERRNO.ENOENT, "open", p);
    }

    return this.backend.openSync(p, flags, mode);
  }

  async stat(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p)) {
      if (this.writeMode === "tmpfs") {
        return this.tmpfs.stat(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "stat", p);
    }

    if (this.denySymlinkBypass && (await this.resolvesToShadowed(p))) {
      throw createErrnoError(ERRNO.ENOENT, "stat", p);
    }

    return this.backend.stat(p, options);
  }

  statSync(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p)) {
      if (this.writeMode === "tmpfs") {
        return this.tmpfs.statSync(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "stat", p);
    }

    if (this.denySymlinkBypass && this.resolvesToShadowedSync(p)) {
      throw createErrnoError(ERRNO.ENOENT, "stat", p);
    }

    return this.backend.statSync(p, options);
  }

  async lstat(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p)) {
      if (this.writeMode === "tmpfs") {
        return this.tmpfs.lstat(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "lstat", p);
    }

    // lstat does not follow symlinks, but we still want to hide the symlink itself
    // if it resolves to a shadowed path.
    if (this.denySymlinkBypass && (await this.resolvesToShadowed(p))) {
      throw createErrnoError(ERRNO.ENOENT, "lstat", p);
    }

    return this.backend.lstat(p, options);
  }

  lstatSync(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p)) {
      if (this.writeMode === "tmpfs") {
        return this.tmpfs.lstatSync(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "lstat", p);
    }

    if (this.denySymlinkBypass && this.resolvesToShadowedSync(p)) {
      throw createErrnoError(ERRNO.ENOENT, "lstat", p);
    }

    return this.backend.lstatSync(p, options);
  }

  async readdir(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p)) {
      if (this.writeMode === "tmpfs") {
        return this.tmpfs.readdir(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "readdir", p);
    }

    const lower = (await this.backend.readdir(p, options)) as Array<string | Dirent>;
    const withTypes = Boolean((options as { withFileTypes?: boolean } | undefined)?.withFileTypes);

    const upper = this.writeMode === "tmpfs" ? await this.tryReaddirUpper(p, options) : [];

    const blocked = this.directShadowedChildren(p);

    // Filter blocked entries from lower.
    const filteredLower = blocked.size
      ? lower.filter((e) => !blocked.has(getEntryName(e)))
      : lower;

    if (upper.length === 0) {
      return filteredLower;
    }

    // Merge, letting upper override duplicates.
    const seen = new Set<string>(filteredLower.map(getEntryName));
    const merged: Array<string | Dirent> = [...filteredLower];

    for (const entry of upper) {
      const name = getEntryName(entry);
      if (blocked.has(name)) {
        // ok: upper un-hides it
      }
      if (seen.has(name)) {
        // Replace lower entry with upper entry in-place when withTypes.
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

    if (this.isShadowed(p)) {
      if (this.writeMode === "tmpfs") {
        return this.tmpfs.readdirSync(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "readdir", p);
    }

    const lower = this.backend.readdirSync(p, options) as Array<string | Dirent>;
    const withTypes = Boolean((options as { withFileTypes?: boolean } | undefined)?.withFileTypes);
    const upper = this.writeMode === "tmpfs" ? this.tryReaddirUpperSync(p, options) : [];

    const blocked = this.directShadowedChildren(p);
    const filteredLower = blocked.size
      ? lower.filter((e) => !blocked.has(getEntryName(e)))
      : lower;

    if (upper.length === 0) {
      return filteredLower;
    }

    const seen = new Set<string>(filteredLower.map(getEntryName));
    const merged: Array<string | Dirent> = [...filteredLower];

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

    if (this.isShadowed(p) || (this.denySymlinkBypass && (await this.resolvesToShadowed(p)))) {
      return this.writeShadowed("mkdir", p, () => this.tmpfs.mkdir(p, options));
    }

    return this.backend.mkdir(p, options);
  }

  mkdirSync(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p) || (this.denySymlinkBypass && this.resolvesToShadowedSync(p))) {
      return this.writeShadowedSync("mkdir", p, () => this.tmpfs.mkdirSync(p, options));
    }

    return this.backend.mkdirSync(p, options);
  }

  async rmdir(entryPath: string) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p) || (this.denySymlinkBypass && (await this.resolvesToShadowed(p)))) {
      return this.writeShadowed("rmdir", p, async () => {
        try {
          await this.tmpfs.rmdir(p);
        } catch (err) {
          // If it only exists in the backend, treat this as a successful no-op.
          if (!isNoEntryError(err)) throw err;
        }
      });
    }

    return this.backend.rmdir(p);
  }

  rmdirSync(entryPath: string) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p) || (this.denySymlinkBypass && this.resolvesToShadowedSync(p))) {
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

    if (this.isShadowed(p) || (this.denySymlinkBypass && (await this.resolvesToShadowed(p)))) {
      return this.writeShadowed("unlink", p, async () => {
        try {
          await this.tmpfs.unlink(p);
        } catch (err) {
          // If it only exists in the backend, treat this as a successful no-op.
          if (!isNoEntryError(err)) throw err;
        }
      });
    }

    return this.backend.unlink(p);
  }

  unlinkSync(entryPath: string) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p) || (this.denySymlinkBypass && this.resolvesToShadowedSync(p))) {
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
    const from = normalizeVfsPath(oldPath);
    const to = normalizeVfsPath(newPath);

    const fromShadow = this.isShadowed(from);
    const toShadow = this.isShadowed(to);

    // Symlink bypass: resolve both ends if enabled.
    if (this.denySymlinkBypass) {
      const [fromResolves, toResolves] = await Promise.all([this.resolvesToShadowed(from), this.resolvesToShadowed(to)]);
      if (!fromShadow && fromResolves) {
        throw createErrnoError(ERRNO.ENOENT, "rename", from);
      }
      if (!toShadow && toResolves) {
        // rename-to into a shadowed target shouldn't be allowed unless both paths are shadowed
        throw createErrnoError(this.denyWriteErrno, "rename", to);
      }
    }

    if (fromShadow || toShadow) {
      if (fromShadow && toShadow && this.writeMode === "tmpfs") {
        return this.tmpfs.rename(from, to);
      }

      // Disallow cross-boundary renames.
      throw createErrnoError(ERRNO.EXDEV, "rename", `${from} -> ${to}`);
    }

    return this.backend.rename(from, to);
  }

  renameSync(oldPath: string, newPath: string) {
    const from = normalizeVfsPath(oldPath);
    const to = normalizeVfsPath(newPath);

    const fromShadow = this.isShadowed(from);
    const toShadow = this.isShadowed(to);

    if (this.denySymlinkBypass) {
      if (!fromShadow && this.resolvesToShadowedSync(from)) {
        throw createErrnoError(ERRNO.ENOENT, "rename", from);
      }
      if (!toShadow && this.resolvesToShadowedSync(to)) {
        throw createErrnoError(this.denyWriteErrno, "rename", to);
      }
    }

    if (fromShadow || toShadow) {
      if (fromShadow && toShadow && this.writeMode === "tmpfs") {
        return this.tmpfs.renameSync(from, to);
      }
      throw createErrnoError(ERRNO.EXDEV, "rename", `${from} -> ${to}`);
    }

    return this.backend.renameSync(from, to);
  }

  async readlink(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p)) {
      if (this.writeMode === "tmpfs" && this.tmpfs.readlink) {
        return this.tmpfs.readlink(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "readlink", p);
    }

    if (this.denySymlinkBypass && (await this.resolvesToShadowed(p))) {
      throw createErrnoError(ERRNO.ENOENT, "readlink", p);
    }

    if (this.backend.readlink) {
      return this.backend.readlink(p, options);
    }
    return super.readlink(p, options);
  }

  readlinkSync(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p)) {
      if (this.writeMode === "tmpfs" && this.tmpfs.readlinkSync) {
        return this.tmpfs.readlinkSync(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "readlink", p);
    }

    if (this.denySymlinkBypass && this.resolvesToShadowedSync(p)) {
      throw createErrnoError(ERRNO.ENOENT, "readlink", p);
    }

    if (this.backend.readlinkSync) {
      return this.backend.readlinkSync(p, options);
    }
    return super.readlinkSync(p, options);
  }

  async symlink(target: string, entryPath: string, type?: string) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p) || (this.denySymlinkBypass && (await this.resolvesToShadowed(p)))) {
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

    if (this.isShadowed(p) || (this.denySymlinkBypass && this.resolvesToShadowedSync(p))) {
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

    if (this.isShadowed(p)) {
      if (this.writeMode === "tmpfs") {
        if (this.tmpfs.realpath) {
          return this.tmpfs.realpath(p, options);
        }
        return super.realpath(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "realpath", p);
    }

    if (this.denySymlinkBypass && (await this.resolvesToShadowed(p))) {
      throw createErrnoError(ERRNO.ENOENT, "realpath", p);
    }

    if (this.backend.realpath) {
      return this.backend.realpath(p, options);
    }
    return super.realpath(p, options);
  }

  realpathSync(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p)) {
      if (this.writeMode === "tmpfs") {
        if (this.tmpfs.realpathSync) {
          return this.tmpfs.realpathSync(p, options);
        }
        return super.realpathSync(p, options);
      }
      throw createErrnoError(ERRNO.ENOENT, "realpath", p);
    }

    if (this.denySymlinkBypass && this.resolvesToShadowedSync(p)) {
      throw createErrnoError(ERRNO.ENOENT, "realpath", p);
    }

    if (this.backend.realpathSync) {
      return this.backend.realpathSync(p, options);
    }
    return super.realpathSync(p, options);
  }

  async access(entryPath: string, mode?: number) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p)) {
      if (this.writeMode === "tmpfs") {
        if (this.tmpfs.access) {
          return this.tmpfs.access(p, mode);
        }
        return super.access(p, mode);
      }
      throw createErrnoError(ERRNO.ENOENT, "access", p);
    }

    if (this.denySymlinkBypass && (await this.resolvesToShadowed(p))) {
      throw createErrnoError(ERRNO.ENOENT, "access", p);
    }

    if (this.backend.access) {
      return this.backend.access(p, mode);
    }
    return super.access(p, mode);
  }

  accessSync(entryPath: string, mode?: number) {
    const p = normalizeVfsPath(entryPath);

    if (this.isShadowed(p)) {
      if (this.writeMode === "tmpfs") {
        if (this.tmpfs.accessSync) {
          return this.tmpfs.accessSync(p, mode);
        }
        return super.accessSync(p, mode);
      }
      throw createErrnoError(ERRNO.ENOENT, "access", p);
    }

    if (this.denySymlinkBypass && this.resolvesToShadowedSync(p)) {
      throw createErrnoError(ERRNO.ENOENT, "access", p);
    }

    if (this.backend.accessSync) {
      return this.backend.accessSync(p, mode);
    }
    return super.accessSync(p, mode);
  }

  watch(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);
    return this.backend.watch?.(p, options) ?? super.watch(p, options);
  }

  watchAsync(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);
    return this.backend.watchAsync?.(p, options) ?? super.watchAsync(p, options);
  }

  watchFile(entryPath: string, options?: object, listener?: (...args: unknown[]) => void) {
    const p = normalizeVfsPath(entryPath);
    return this.backend.watchFile?.(p, options, listener) ?? super.watchFile(p, options, listener);
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

  private isShadowed(entryPath: string) {
    const p = normalizeVfsPath(entryPath);
    for (const shadow of this.shadowPaths) {
      if (p === shadow) return true;
      if (p.startsWith(shadow + "/")) return true;
    }
    return false;
  }

  private directShadowedChildren(dirPath: string) {
    const dir = normalizeVfsPath(dirPath);
    const blocked = new Set<string>();

    for (const shadow of this.shadowPaths) {
      const parent = path.posix.dirname(shadow);
      if (parent !== dir) continue;
      const base = path.posix.basename(shadow);
      if (base) blocked.add(base);
    }

    return blocked;
  }

  private async tryReaddirUpper(entryPath: string, options?: object) {
    try {
      return (await this.tmpfs.readdir(entryPath, options)) as Array<string | Dirent>;
    } catch (err) {
      if (isNoEntryError(err)) return [];
      throw err;
    }
  }

  private tryReaddirUpperSync(entryPath: string, options?: object) {
    try {
      return this.tmpfs.readdirSync(entryPath, options) as Array<string | Dirent>;
    } catch (err) {
      if (isNoEntryError(err)) return [];
      throw err;
    }
  }

  private async openShadowed(entryPath: string, flags: string, mode?: number): Promise<VirtualFileHandle> {
    if (this.writeMode === "tmpfs") {
      return this.tmpfs.open(entryPath, flags, mode);
    }

    if (isWriteFlag(flags)) {
      throw createErrnoError(this.denyWriteErrno, "open", entryPath);
    }
    throw createErrnoError(ERRNO.ENOENT, "open", entryPath);
  }

  private openShadowedSync(entryPath: string, flags: string, mode?: number): VirtualFileHandle {
    if (this.writeMode === "tmpfs") {
      return this.tmpfs.openSync(entryPath, flags, mode);
    }

    if (isWriteFlag(flags)) {
      throw createErrnoError(this.denyWriteErrno, "open", entryPath);
    }
    throw createErrnoError(ERRNO.ENOENT, "open", entryPath);
  }

  private async writeShadowed<T>(op: string, entryPath: string, fn: () => Promise<T> | T) {
    if (this.backend.readonly) {
      throw createErrnoError(ERRNO.EROFS, op, entryPath);
    }

    if (this.writeMode === "deny") {
      throw createErrnoError(this.denyWriteErrno, op, entryPath);
    }

    return await fn();
  }

  private writeShadowedSync<T>(op: string, entryPath: string, fn: () => T) {
    if (this.backend.readonly) {
      throw createErrnoError(ERRNO.EROFS, op, entryPath);
    }

    if (this.writeMode === "deny") {
      throw createErrnoError(this.denyWriteErrno, op, entryPath);
    }

    return fn();
  }

  private async resolvesToShadowed(entryPath: string) {
    if (!this.backend.realpath) return false;
    try {
      const resolved = normalizeVfsPath(await this.backend.realpath(entryPath));
      return this.isShadowed(resolved);
    } catch {
      return false;
    }
  }

  private resolvesToShadowedSync(entryPath: string) {
    if (!this.backend.realpathSync) return false;
    try {
      const resolved = normalizeVfsPath(this.backend.realpathSync(entryPath));
      return this.isShadowed(resolved);
    } catch {
      return false;
    }
  }
}

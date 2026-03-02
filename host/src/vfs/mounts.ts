import fs from "node:fs";

import { createErrnoError } from "./errors.ts";
import type {
  VirtualProvider,
  VirtualFileHandle,
  VfsStatfs,
} from "./node/index.ts";
import { cloneSyntheticStatfs, isStatfsProbeFallbackError } from "./statfs.ts";
import {
  createVirtualDirStats,
  ERRNO,
  formatVirtualEntries,
  normalizeVfsPath,
  VirtualDirent,
  VirtualProviderClass,
} from "./utils.ts";

export class MountRouterProvider
  extends VirtualProviderClass
  implements VirtualProvider
{
  private readonly mountMap: Map<string, VirtualProvider>;
  private readonly mountPaths: string[];
  private readonly allReadonly: boolean;
  private readonly allSymlinks: boolean;
  private readonly allWatch: boolean;

  constructor(
    mounts: Record<string, VirtualProvider> | Map<string, VirtualProvider>,
  ) {
    super();
    const normalized =
      mounts instanceof Map ? mounts : normalizeMountMap(mounts);
    if (normalized.size === 0) {
      throw new Error("mounts cannot be empty");
    }
    this.mountMap = normalized;
    this.mountPaths = Array.from(normalized.keys()).sort(
      (a, b) => b.length - a.length,
    );
    const providers = Array.from(normalized.values());
    this.allReadonly = providers.every((provider) => provider.readonly);
    this.allSymlinks = providers.every((provider) => provider.supportsSymlinks);
    this.allWatch = providers.every((provider) => provider.supportsWatch);
  }

  get readonly() {
    return this.allReadonly;
  }

  get supportsSymlinks() {
    return this.allSymlinks;
  }

  get supportsWatch() {
    return this.allWatch;
  }

  async open(
    entryPath: string,
    flags: string,
    mode?: number,
  ): Promise<VirtualFileHandle> {
    const mount = this.requireMount(entryPath, "open");
    return mount.provider.open(mount.relativePath, flags, mode);
  }

  openSync(entryPath: string, flags: string, mode?: number): VirtualFileHandle {
    const mount = this.requireMount(entryPath, "open");
    return mount.provider.openSync(mount.relativePath, flags, mode);
  }

  async stat(entryPath: string, options?: object) {
    const mount = this.resolveMount(entryPath);
    if (mount) {
      if (mount.mountPath === "/") {
        const children = this.virtualChildren(entryPath);
        if (children.length > 0) {
          try {
            return await mount.provider.stat(mount.relativePath, options);
          } catch (err) {
            if (isNoEntryError(err)) {
              return createVirtualDirStats();
            }
            throw err;
          }
        }
      }
      return mount.provider.stat(mount.relativePath, options);
    }
    this.ensureVirtualDir(entryPath, "stat");
    return createVirtualDirStats();
  }

  statSync(entryPath: string, options?: object) {
    const mount = this.resolveMount(entryPath);
    if (mount) {
      if (mount.mountPath === "/") {
        const children = this.virtualChildren(entryPath);
        if (children.length > 0) {
          try {
            return mount.provider.statSync(mount.relativePath, options);
          } catch (err) {
            if (isNoEntryError(err)) {
              return createVirtualDirStats();
            }
            throw err;
          }
        }
      }
      return mount.provider.statSync(mount.relativePath, options);
    }
    this.ensureVirtualDir(entryPath, "stat");
    return createVirtualDirStats();
  }

  async lstat(entryPath: string, options?: object) {
    const mount = this.resolveMount(entryPath);
    if (mount) {
      if (mount.mountPath === "/") {
        const children = this.virtualChildren(entryPath);
        if (children.length > 0) {
          try {
            return await mount.provider.lstat(mount.relativePath, options);
          } catch (err) {
            if (isNoEntryError(err)) {
              return createVirtualDirStats();
            }
            throw err;
          }
        }
      }
      return mount.provider.lstat(mount.relativePath, options);
    }
    this.ensureVirtualDir(entryPath, "lstat");
    return createVirtualDirStats();
  }

  lstatSync(entryPath: string, options?: object) {
    const mount = this.resolveMount(entryPath);
    if (mount) {
      if (mount.mountPath === "/") {
        const children = this.virtualChildren(entryPath);
        if (children.length > 0) {
          try {
            return mount.provider.lstatSync(mount.relativePath, options);
          } catch (err) {
            if (isNoEntryError(err)) {
              return createVirtualDirStats();
            }
            throw err;
          }
        }
      }
      return mount.provider.lstatSync(mount.relativePath, options);
    }
    this.ensureVirtualDir(entryPath, "lstat");
    return createVirtualDirStats();
  }

  async readdir(entryPath: string, options?: object) {
    const mount = this.resolveMount(entryPath);
    const children = this.virtualChildren(entryPath);
    const withTypes = Boolean(
      (options as { withFileTypes?: boolean } | undefined)?.withFileTypes,
    );

    if (!mount) {
      if (children.length === 0) {
        throw createErrnoError(ERRNO.ENOENT, "readdir", entryPath);
      }
      return formatVirtualEntries(children, withTypes);
    }

    if (mount.mountPath === "/" && children.length > 0) {
      try {
        const entries = (await mount.provider.readdir(
          mount.relativePath,
          options,
        )) as Array<string | fs.Dirent>;
        return mergeEntries(entries, children, withTypes);
      } catch (err) {
        if (isNoEntryError(err)) {
          return formatVirtualEntries(children, withTypes);
        }
        throw err;
      }
    }

    const entries = (await mount.provider.readdir(
      mount.relativePath,
      options,
    )) as Array<string | fs.Dirent>;
    return mergeEntries(entries, children, withTypes);
  }

  readdirSync(entryPath: string, options?: object) {
    const mount = this.resolveMount(entryPath);
    const children = this.virtualChildren(entryPath);
    const withTypes = Boolean(
      (options as { withFileTypes?: boolean } | undefined)?.withFileTypes,
    );

    if (!mount) {
      if (children.length === 0) {
        throw createErrnoError(ERRNO.ENOENT, "readdir", entryPath);
      }
      return formatVirtualEntries(children, withTypes);
    }

    if (mount.mountPath === "/" && children.length > 0) {
      try {
        const entries = mount.provider.readdirSync(
          mount.relativePath,
          options,
        ) as Array<string | fs.Dirent>;
        return mergeEntries(entries, children, withTypes);
      } catch (err) {
        if (isNoEntryError(err)) {
          return formatVirtualEntries(children, withTypes);
        }
        throw err;
      }
    }

    const entries = mount.provider.readdirSync(
      mount.relativePath,
      options,
    ) as Array<string | fs.Dirent>;
    return mergeEntries(entries, children, withTypes);
  }

  async mkdir(entryPath: string, options?: object) {
    const mount = this.requireMount(entryPath, "mkdir");
    return mount.provider.mkdir(mount.relativePath, options);
  }

  mkdirSync(entryPath: string, options?: object) {
    const mount = this.requireMount(entryPath, "mkdir");
    return mount.provider.mkdirSync(mount.relativePath, options);
  }

  async rmdir(entryPath: string) {
    const mount = this.requireMount(entryPath, "rmdir");
    return mount.provider.rmdir(mount.relativePath);
  }

  rmdirSync(entryPath: string) {
    const mount = this.requireMount(entryPath, "rmdir");
    return mount.provider.rmdirSync(mount.relativePath);
  }

  async unlink(entryPath: string) {
    const mount = this.requireMount(entryPath, "unlink");
    return mount.provider.unlink(mount.relativePath);
  }

  unlinkSync(entryPath: string) {
    const mount = this.requireMount(entryPath, "unlink");
    return mount.provider.unlinkSync(mount.relativePath);
  }

  async rename(oldPath: string, newPath: string) {
    const resolved = this.requireSameMount(oldPath, newPath, "rename");
    return resolved.provider.rename(resolved.fromPath, resolved.toPath);
  }

  renameSync(oldPath: string, newPath: string) {
    const resolved = this.requireSameMount(oldPath, newPath, "rename");
    return resolved.provider.renameSync(resolved.fromPath, resolved.toPath);
  }

  async link(existingPath: string, newPath: string) {
    const resolved = this.requireSameMount(existingPath, newPath, "link");
    if (resolved.provider.link) {
      return resolved.provider.link(resolved.fromPath, resolved.toPath);
    }
    throw createErrnoError(ERRNO.ENOSYS, "link", existingPath);
  }

  linkSync(existingPath: string, newPath: string) {
    const resolved = this.requireSameMount(existingPath, newPath, "link");
    if (resolved.provider.linkSync) {
      return resolved.provider.linkSync(resolved.fromPath, resolved.toPath);
    }
    throw createErrnoError(ERRNO.ENOSYS, "link", existingPath);
  }

  async readlink(entryPath: string, options?: object) {
    const mount = this.requireMount(entryPath, "readlink");
    if (mount.provider.readlink) {
      return mount.provider.readlink(mount.relativePath, options);
    }
    return super.readlink(mount.relativePath, options);
  }

  readlinkSync(entryPath: string, options?: object) {
    const mount = this.requireMount(entryPath, "readlink");
    if (mount.provider.readlinkSync) {
      return mount.provider.readlinkSync(mount.relativePath, options);
    }
    return super.readlinkSync(mount.relativePath, options);
  }

  async symlink(target: string, entryPath: string, type?: string) {
    const mount = this.requireMount(entryPath, "symlink");
    if (mount.provider.symlink) {
      return mount.provider.symlink(target, mount.relativePath, type);
    }
    return super.symlink(target, mount.relativePath, type);
  }

  symlinkSync(target: string, entryPath: string, type?: string) {
    const mount = this.requireMount(entryPath, "symlink");
    if (mount.provider.symlinkSync) {
      return mount.provider.symlinkSync(target, mount.relativePath, type);
    }
    return super.symlinkSync(target, mount.relativePath, type);
  }

  async realpath(entryPath: string, options?: object) {
    const mount = this.resolveMount(entryPath);
    if (mount) {
      if (mount.mountPath === "/") {
        const children = this.virtualChildren(entryPath);
        if (children.length > 0) {
          try {
            if (mount.provider.realpath) {
              return await mount.provider.realpath(mount.relativePath, options);
            }
            return await super.realpath(mount.relativePath, options);
          } catch (err) {
            if (isNoEntryError(err)) {
              return normalizeVfsPath(entryPath);
            }
            throw err;
          }
        }
      }
      if (mount.provider.realpath) {
        return mount.provider.realpath(mount.relativePath, options);
      }
      return super.realpath(mount.relativePath, options);
    }
    this.ensureVirtualDir(entryPath, "realpath");
    return normalizeVfsPath(entryPath);
  }

  realpathSync(entryPath: string, options?: object) {
    const mount = this.resolveMount(entryPath);
    if (mount) {
      if (mount.mountPath === "/") {
        const children = this.virtualChildren(entryPath);
        if (children.length > 0) {
          try {
            if (mount.provider.realpathSync) {
              return mount.provider.realpathSync(mount.relativePath, options);
            }
            return super.realpathSync(mount.relativePath, options);
          } catch (err) {
            if (isNoEntryError(err)) {
              return normalizeVfsPath(entryPath);
            }
            throw err;
          }
        }
      }
      if (mount.provider.realpathSync) {
        return mount.provider.realpathSync(mount.relativePath, options);
      }
      return super.realpathSync(mount.relativePath, options);
    }
    this.ensureVirtualDir(entryPath, "realpath");
    return normalizeVfsPath(entryPath);
  }

  async access(entryPath: string, mode?: number) {
    const mount = this.resolveMount(entryPath);
    if (mount) {
      if (mount.mountPath === "/") {
        const children = this.virtualChildren(entryPath);
        if (children.length > 0) {
          try {
            if (mount.provider.access) {
              return await mount.provider.access(mount.relativePath, mode);
            }
            return await super.access(mount.relativePath, mode);
          } catch (err) {
            if (isNoEntryError(err)) {
              return;
            }
            throw err;
          }
        }
      }
      if (mount.provider.access) {
        return mount.provider.access(mount.relativePath, mode);
      }
      return super.access(mount.relativePath, mode);
    }
    this.ensureVirtualDir(entryPath, "access");
  }

  accessSync(entryPath: string, mode?: number) {
    const mount = this.resolveMount(entryPath);
    if (mount) {
      if (mount.mountPath === "/") {
        const children = this.virtualChildren(entryPath);
        if (children.length > 0) {
          try {
            if (mount.provider.accessSync) {
              return mount.provider.accessSync(mount.relativePath, mode);
            }
            return super.accessSync(mount.relativePath, mode);
          } catch (err) {
            if (isNoEntryError(err)) {
              return;
            }
            throw err;
          }
        }
      }
      if (mount.provider.accessSync) {
        return mount.provider.accessSync(mount.relativePath, mode);
      }
      return super.accessSync(mount.relativePath, mode);
    }
    this.ensureVirtualDir(entryPath, "access");
  }

  async statfs(entryPath: string): Promise<VfsStatfs> {
    const mount = this.resolveMount(entryPath);
    if (mount) {
      const provider = mount.provider as {
        statfs?: (p: string) => Promise<VfsStatfs>;
      };
      if (typeof provider.statfs === "function") {
        return provider.statfs(mount.relativePath);
      }
    }

    // For virtual dirs like "/", prefer a real mounted provider's root stats
    // so tools like `df` (which often resolve bind-mounted paths back to the
    // backing superblock mount) can report meaningful values.
    const normalized = normalizeVfsPath(entryPath);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    for (const mountPath of this.mountPaths) {
      if (!mountPath.startsWith(prefix)) continue;
      const provider = this.mountMap.get(mountPath);
      if (!provider) continue;
      const withStatfs = provider as {
        statfs?: (p: string) => Promise<VfsStatfs>;
      };
      if (typeof withStatfs.statfs !== "function") continue;
      try {
        return await withStatfs.statfs("/");
      } catch (error) {
        if (!isStatfsProbeFallbackError(error)) {
          throw error;
        }
        // Keep searching for another mounted provider that can supply stats.
      }
    }
    return cloneSyntheticStatfs();
  }

  watch(entryPath: string, options?: object) {
    const mount = this.requireMount(entryPath, "watch");
    if (mount.provider.watch) {
      return mount.provider.watch(mount.relativePath, options);
    }
    return super.watch(mount.relativePath, options);
  }

  watchAsync(entryPath: string, options?: object) {
    const mount = this.requireMount(entryPath, "watch");
    if (mount.provider.watchAsync) {
      return mount.provider.watchAsync(mount.relativePath, options);
    }
    return super.watchAsync(mount.relativePath, options);
  }

  watchFile(
    entryPath: string,
    options?: object,
    listener?: (...args: unknown[]) => void,
  ) {
    const mount = this.requireMount(entryPath, "watchFile");
    if (mount.provider.watchFile) {
      return mount.provider.watchFile(mount.relativePath, options, listener);
    }
    return super.watchFile(mount.relativePath, options);
  }

  unwatchFile(entryPath: string, listener?: (...args: unknown[]) => void) {
    const mount = this.requireMount(entryPath, "unwatchFile");
    if (mount.provider.unwatchFile) {
      return mount.provider.unwatchFile(mount.relativePath, listener);
    }
    return super.unwatchFile(mount.relativePath, listener);
  }

  private resolveMount(entryPath: string) {
    const normalized = normalizeVfsPath(entryPath);
    for (const mountPath of this.mountPaths) {
      if (isUnderMountPoint(normalized, mountPath)) {
        const provider = this.mountMap.get(mountPath)!;
        return {
          mountPath,
          provider,
          relativePath: getRelativePath(normalized, mountPath),
        };
      }
    }
    return null;
  }

  private virtualChildren(entryPath: string) {
    const normalized = normalizeVfsPath(entryPath);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const children = new Set<string>();

    for (const mountPath of this.mountPaths) {
      if (mountPath === normalized) continue;
      if (!mountPath.startsWith(prefix)) continue;
      const remainder = mountPath.slice(prefix.length);
      const segment = remainder.split("/")[0];
      if (segment) children.add(segment);
    }

    return Array.from(children).sort();
  }

  private ensureVirtualDir(entryPath: string, op: string) {
    if (this.virtualChildren(entryPath).length === 0) {
      throw createErrnoError(ERRNO.ENOENT, op, entryPath);
    }
  }

  private requireMount(entryPath: string, op: string) {
    const mount = this.resolveMount(entryPath);
    if (!mount) {
      throw createErrnoError(ERRNO.ENOENT, op, entryPath);
    }
    return mount;
  }

  private requireSameMount(oldPath: string, newPath: string, op: string) {
    const from = this.requireMount(oldPath, op);
    const to = this.requireMount(newPath, op);
    if (from.mountPath !== to.mountPath) {
      throw createErrnoError(ERRNO.EXDEV, op, oldPath);
    }
    return {
      provider: from.provider,
      fromPath: from.relativePath,
      toPath: to.relativePath,
    };
  }
}

function mergeEntries(
  entries: Array<string | fs.Dirent>,
  children: string[],
  withTypes: boolean,
) {
  if (children.length === 0) return entries;
  const childSet = new Set(children);
  const filtered = entries.filter(
    (entry) => !childSet.has(getEntryName(entry)),
  );
  if (!withTypes) {
    return [...filtered, ...children];
  }

  const dirents = filtered as Array<fs.Dirent>;
  for (const child of children) {
    dirents.push(new VirtualDirent(child) as unknown as fs.Dirent);
  }
  return dirents;
}

function getEntryName(entry: string | fs.Dirent) {
  return typeof entry === "string" ? entry : entry.name;
}

/** @internal */
export function isNoEntryError(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const error = err as NodeJS.ErrnoException;
  return (
    error.code === "ENOENT" ||
    error.code === "ERRNO_2" ||
    error.errno === ERRNO.ENOENT ||
    error.errno === -ERRNO.ENOENT ||
    error.errno === 2 ||
    error.errno === -2
  );
}

/** @internal */
export function isUnderMountPoint(normalizedPath: string, mountPoint: string) {
  if (normalizedPath === mountPoint) return true;
  if (mountPoint === "/") return normalizedPath.startsWith("/");
  return normalizedPath.startsWith(mountPoint + "/");
}

/** @internal */
export function getRelativePath(normalizedPath: string, mountPoint: string) {
  if (normalizedPath === mountPoint) return "/";
  if (mountPoint === "/") return normalizedPath;
  return normalizedPath.slice(mountPoint.length);
}

export function normalizeMountPath(inputPath: string) {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("mount path must be a non-empty string");
  }
  if (!inputPath.startsWith("/")) {
    throw new Error(`mount path must be absolute: ${inputPath}`);
  }
  if (inputPath.includes("\0")) {
    throw new Error("mount path contains null bytes");
  }
  return normalizeVfsPath(inputPath);
}

export function normalizeMountMap(mounts: Record<string, VirtualProvider>) {
  const map = new Map<string, VirtualProvider>();
  for (const [mountPath, provider] of Object.entries(mounts)) {
    if (!provider || typeof provider.open !== "function") {
      throw new Error(`mount provider for ${mountPath} is invalid`);
    }
    const normalized = normalizeMountPath(mountPath);
    if (map.has(normalized)) {
      throw new Error(`duplicate mount path: ${normalized}`);
    }
    map.set(normalized, provider);
  }
  return map;
}

export function listMountPaths(mounts?: Record<string, VirtualProvider>) {
  if (!mounts) return [];
  return Array.from(normalizeMountMap(mounts).keys()).sort();
}

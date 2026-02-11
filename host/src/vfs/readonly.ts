import { createErrnoError } from "./errors";
import type { VirtualProvider, VfsStatfs } from "./node";
import { delegateStatfsOrEnosys } from "./statfs";
import { ERRNO, isWriteFlag, VirtualProviderClass } from "./utils";

/**
 * Wraps a VirtualProvider and makes it read-only by blocking all write operations.
 * Useful for mounting host directories in read-only mode.
 */
export class ReadonlyProvider extends VirtualProviderClass implements VirtualProvider {
  constructor(private readonly backend: VirtualProvider) {
    super();
  }

  get readonly() {
    return true;
  }

  get supportsSymlinks() {
    return this.backend.supportsSymlinks;
  }

  get supportsWatch() {
    return this.backend.supportsWatch;
  }

  async open(path: string, flags: string, mode?: number) {
    if (isWriteFlag(flags)) {
      throw createErrnoError(ERRNO.EROFS, "open", path);
    }
    return this.backend.open(path, flags, mode);
  }

  openSync(path: string, flags: string, mode?: number) {
    if (isWriteFlag(flags)) {
      throw createErrnoError(ERRNO.EROFS, "open", path);
    }
    return this.backend.openSync(path, flags, mode);
  }

  async stat(path: string, options?: object) {
    return this.backend.stat(path, options);
  }

  statSync(path: string, options?: object) {
    return this.backend.statSync(path, options);
  }

  async lstat(path: string, options?: object) {
    return this.backend.lstat(path, options);
  }

  lstatSync(path: string, options?: object) {
    return this.backend.lstatSync(path, options);
  }

  async readdir(path: string, options?: object) {
    return this.backend.readdir(path, options);
  }

  readdirSync(path: string, options?: object) {
    return this.backend.readdirSync(path, options);
  }

  async mkdir(path: string, _options?: object): Promise<void | string> {
    throw createErrnoError(ERRNO.EROFS, "mkdir", path);
  }

  mkdirSync(path: string, _options?: object): void | string {
    throw createErrnoError(ERRNO.EROFS, "mkdir", path);
  }

  async rmdir(path: string): Promise<void> {
    throw createErrnoError(ERRNO.EROFS, "rmdir", path);
  }

  rmdirSync(path: string): void {
    throw createErrnoError(ERRNO.EROFS, "rmdir", path);
  }

  async unlink(path: string): Promise<void> {
    throw createErrnoError(ERRNO.EROFS, "unlink", path);
  }

  unlinkSync(path: string): void {
    throw createErrnoError(ERRNO.EROFS, "unlink", path);
  }

  async rename(oldPath: string, _newPath: string): Promise<void> {
    throw createErrnoError(ERRNO.EROFS, "rename", oldPath);
  }

  renameSync(oldPath: string, _newPath: string): void {
    throw createErrnoError(ERRNO.EROFS, "rename", oldPath);
  }

  async readlink(path: string, options?: object): Promise<string> {
    if (this.backend.readlink) {
      return this.backend.readlink(path, options);
    }
    return super.readlink(path, options);
  }

  readlinkSync(path: string, options?: object): string {
    if (this.backend.readlinkSync) {
      return this.backend.readlinkSync(path, options);
    }
    return super.readlinkSync(path, options);
  }

  async symlink(_target: string, path: string, _type?: string): Promise<void> {
    throw createErrnoError(ERRNO.EROFS, "symlink", path);
  }

  symlinkSync(_target: string, path: string, _type?: string): void {
    throw createErrnoError(ERRNO.EROFS, "symlink", path);
  }

  async realpath(path: string, options?: object): Promise<string> {
    if (this.backend.realpath) {
      return this.backend.realpath(path, options);
    }
    return super.realpath(path, options);
  }

  realpathSync(path: string, options?: object): string {
    if (this.backend.realpathSync) {
      return this.backend.realpathSync(path, options);
    }
    return super.realpathSync(path, options);
  }

  async access(path: string, mode?: number): Promise<void> {
    if (this.backend.access) {
      return this.backend.access(path, mode);
    }
    return super.access(path, mode);
  }

  accessSync(path: string, mode?: number): void {
    if (this.backend.accessSync) {
      return this.backend.accessSync(path, mode);
    }
    return super.accessSync(path, mode);
  }

  async statfs(path: string): Promise<VfsStatfs> {
    return delegateStatfsOrEnosys(this.backend, path);
  }

  watch(path: string, options?: object) {
    return this.backend.watch?.(path, options) ?? super.watch(path, options);
  }

  watchAsync(path: string, options?: object) {
    return this.backend.watchAsync?.(path, options) ?? super.watchAsync(path, options);
  }

  watchFile(path: string, options?: object, listener?: (...args: unknown[]) => void) {
    return this.backend.watchFile?.(path, options, listener) ?? super.watchFile(path, options);
  }

  unwatchFile(path: string, listener?: (...args: unknown[]) => void) {
    if (this.backend.unwatchFile) {
      this.backend.unwatchFile(path, listener);
      return;
    }
    super.unwatchFile(path, listener);
  }

  async close() {
    const backend = this.backend as { close?: () => Promise<void> | void };
    if (backend.close) {
      await backend.close();
    }
  }
}

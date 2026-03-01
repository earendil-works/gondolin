import fs from "node:fs";

import { createErrnoError } from "./errors.ts";
import type { VirtualFileHandle, VirtualProvider } from "./node/index.ts";
import { ERRNO, isWriteFlag, VirtualProviderClass } from "./utils.ts";

/**
 * Small helper base-class for implementing a synchronous, read-only VFS provider.
 *
 * Most custom providers in examples are sync-first (they call into local code,
 * spawn processes, or consult in-memory caches). This class:
 *
 * - Implements async methods by delegating to their sync counterparts
 * - Rejects any write operation with `EROFS`
 * - Rejects `open(..., flags)` that imply writing with `EROFS`
 */
export abstract class ReadonlyVirtualProvider
  extends VirtualProviderClass
  implements VirtualProvider
{
  get readonly() {
    return true;
  }

  get supportsSymlinks() {
    return false;
  }

  get supportsWatch() {
    return false;
  }

  async open(entryPath: string, flags: string, mode?: number) {
    return this.openSync(entryPath, flags, mode);
  }

  openSync(entryPath: string, flags: string, mode?: number): VirtualFileHandle {
    if (isWriteFlag(flags)) {
      throw createErrnoError(ERRNO.EROFS, "open", entryPath);
    }
    return this.openReadonlySync(entryPath, flags, mode);
  }

  /** Sync open implementation for read-only use-cases */
  protected abstract openReadonlySync(
    entryPath: string,
    flags: string,
    mode?: number,
  ): VirtualFileHandle;

  async stat(entryPath: string, options?: object) {
    return this.statSync(entryPath, options);
  }

  abstract statSync(entryPath: string, options?: object): fs.Stats;

  async lstat(entryPath: string, options?: object) {
    return this.lstatSync(entryPath, options);
  }

  abstract lstatSync(entryPath: string, options?: object): fs.Stats;

  async readdir(entryPath: string, options?: object) {
    return this.readdirSync(entryPath, options);
  }

  abstract readdirSync(
    entryPath: string,
    options?: object,
  ): Array<string | fs.Dirent>;

  async mkdir(entryPath: string, options?: object) {
    return this.mkdirSync(entryPath, options);
  }

  mkdirSync(entryPath: string, _options?: object): void | string {
    throw createErrnoError(ERRNO.EROFS, "mkdir", entryPath);
  }

  async rmdir(entryPath: string) {
    return this.rmdirSync(entryPath);
  }

  rmdirSync(entryPath: string): void {
    throw createErrnoError(ERRNO.EROFS, "rmdir", entryPath);
  }

  async unlink(entryPath: string) {
    return this.unlinkSync(entryPath);
  }

  unlinkSync(entryPath: string): void {
    throw createErrnoError(ERRNO.EROFS, "unlink", entryPath);
  }

  async rename(oldPath: string, newPath: string) {
    return this.renameSync(oldPath, newPath);
  }

  renameSync(oldPath: string, _newPath: string): void {
    throw createErrnoError(ERRNO.EROFS, "rename", oldPath);
  }

  async symlink(target: string, entryPath: string, type?: string) {
    return this.symlinkSync(target, entryPath, type);
  }

  symlinkSync(_target: string, entryPath: string, _type?: string): void {
    throw createErrnoError(ERRNO.EROFS, "symlink", entryPath);
  }

  // Convenience async wrappers for optional sync overrides
  async realpath(entryPath: string, options?: object): Promise<string> {
    return this.realpathSync(entryPath, options);
  }

  async access(entryPath: string, mode?: number): Promise<void> {
    return this.accessSync(entryPath, mode);
  }

  async readlink(entryPath: string, options?: object): Promise<string> {
    return this.readlinkSync(entryPath, options);
  }
}

import { createErrnoError } from "./errors";
import type { VirtualProvider, VirtualFileHandle, VfsStatfs } from "./node";
import { delegateStatfsOrEnosys } from "./statfs";
import { ERRNO, VirtualProviderClass } from "./utils";

export type VfsHookContext = {
  /** operation name */
  op: string;
  /** primary path */
  path?: string;
  /** source path for rename/link */
  oldPath?: string;
  /** destination path for rename/link */
  newPath?: string;
  /** open flags */
  flags?: string | number;
  /** file mode bits */
  mode?: number;
  /** file handle id */
  fh?: number;
  /** file offset in `bytes` */
  offset?: number;
  /** length in `bytes` */
  length?: number;
  /** size in `bytes` */
  size?: number;
  /** payload bytes */
  data?: Buffer;
  /** operation result */
  result?: unknown;
};

export type VfsHooks = {
  /** hook called before the operation */
  before?: (context: VfsHookContext) => void | Promise<void>;
  /** hook called after the operation */
  after?: (context: VfsHookContext) => void | Promise<void>;
};

class HookedHandle implements VirtualFileHandle {
  private readonly inner: VirtualFileHandle;
  private readonly hooks: VfsHooks;
  private readonly handlePath: string;

  constructor(inner: VirtualFileHandle, hooks: VfsHooks, handlePath: string) {
    this.inner = inner;
    this.hooks = hooks;
    this.handlePath = handlePath;
  }

  get path() {
    // Always report the path that was used to open the handle.
    //
    // Many backend providers expose a handle-local `path` property that is
    // relative to the provider's mount root (e.g. "/listeners" for a mount
    // at "/etc/gondolin").  VFS hooks, however, operate on the *guest-visible*
    // paths that flow through the mounted provider (e.g. "/etc/gondolin/listeners").
    //
    // Using the backend handle's `path` here breaks path-based hooks like the
    // /etc/gondolin/listeners reload logic.
    return this.handlePath;
  }

  get flags() {
    return this.inner.flags;
  }

  get mode() {
    return this.inner.mode;
  }

  get position() {
    return this.inner.position;
  }

  get closed() {
    return this.inner.closed;
  }

  async read(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ) {
    await this.runBefore({
      op: "read",
      path: this.path,
      offset: position ?? undefined,
      length,
    });
    const result = await this.inner.read(buffer, offset, length, position);
    await this.runAfter({
      op: "read",
      path: this.path,
      offset: position ?? undefined,
      length,
      result,
    });
    return result;
  }

  readSync(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ) {
    this.runBeforeSync({
      op: "read",
      path: this.path,
      offset: position ?? undefined,
      length,
    });
    const bytesRead = this.inner.readSync(buffer, offset, length, position);
    this.runAfterSync({
      op: "read",
      path: this.path,
      offset: position ?? undefined,
      length,
      result: bytesRead,
    });
    return bytesRead;
  }

  async write(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ) {
    await this.runBefore({
      op: "write",
      path: this.path,
      offset: position ?? undefined,
      length,
    });
    const result = await this.inner.write(buffer, offset, length, position);
    await this.runAfter({
      op: "write",
      path: this.path,
      offset: position ?? undefined,
      length,
      result,
    });
    return result;
  }

  writeSync(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ) {
    this.runBeforeSync({
      op: "write",
      path: this.path,
      offset: position ?? undefined,
      length,
    });
    const bytesWritten = this.inner.writeSync(buffer, offset, length, position);
    this.runAfterSync({
      op: "write",
      path: this.path,
      offset: position ?? undefined,
      length,
      result: bytesWritten,
    });
    return bytesWritten;
  }

  async readFile(options?: { encoding?: BufferEncoding } | BufferEncoding) {
    await this.runBefore({ op: "readFile", path: this.path });
    const result = await this.inner.readFile(options);
    await this.runAfter({ op: "readFile", path: this.path, result });
    return result;
  }

  readFileSync(options?: { encoding?: BufferEncoding } | BufferEncoding) {
    this.runBeforeSync({ op: "readFile", path: this.path });
    const result = this.inner.readFileSync(options);
    this.runAfterSync({ op: "readFile", path: this.path, result });
    return result;
  }

  async writeFile(
    data: Buffer | string,
    options?: { encoding?: BufferEncoding },
  ) {
    await this.runBefore({
      op: "writeFile",
      path: this.path,
      data: Buffer.isBuffer(data) ? data : Buffer.from(data),
    });
    await this.inner.writeFile(data, options);
    await this.runAfter({ op: "writeFile", path: this.path });
  }

  writeFileSync(
    data: Buffer | string,
    options?: { encoding?: BufferEncoding },
  ) {
    this.runBeforeSync({
      op: "writeFile",
      path: this.path,
      data: Buffer.isBuffer(data) ? data : Buffer.from(data),
    });
    this.inner.writeFileSync(data, options);
    this.runAfterSync({ op: "writeFile", path: this.path });
  }

  async stat(options?: object) {
    await this.runBefore({ op: "stat", path: this.path });
    const result = await this.inner.stat(options);
    await this.runAfter({ op: "stat", path: this.path, result });
    return result;
  }

  statSync(options?: object) {
    this.runBeforeSync({ op: "stat", path: this.path });
    const result = this.inner.statSync(options);
    this.runAfterSync({ op: "stat", path: this.path, result });
    return result;
  }

  async truncate(len?: number) {
    await this.runBefore({ op: "truncate", path: this.path, size: len });
    await this.inner.truncate(len);
    await this.runAfter({ op: "truncate", path: this.path, size: len });
  }

  truncateSync(len?: number) {
    this.runBeforeSync({ op: "truncate", path: this.path, size: len });
    this.inner.truncateSync(len);
    this.runAfterSync({ op: "truncate", path: this.path, size: len });
  }

  async close() {
    await this.runBefore({ op: "release", path: this.path });
    await this.inner.close();
    await this.runAfter({ op: "release", path: this.path });
  }

  closeSync() {
    this.runBeforeSync({ op: "release", path: this.path });
    this.inner.closeSync();
    this.runAfterSync({ op: "release", path: this.path });
  }

  private async runBefore(context: VfsHookContext) {
    if (this.hooks.before) {
      await this.hooks.before(context);
    }
  }

  private async runAfter(context: VfsHookContext) {
    if (this.hooks.after) {
      await this.hooks.after(context);
    }
  }

  private runBeforeSync(context: VfsHookContext) {
    if (this.hooks.before) {
      const result = this.hooks.before(context);
      if (result && typeof (result as Promise<void>).then === "function") {
        throw new Error("async hook used in sync operation");
      }
    }
  }

  private runAfterSync(context: VfsHookContext) {
    if (this.hooks.after) {
      const result = this.hooks.after(context);
      if (result && typeof (result as Promise<void>).then === "function") {
        throw new Error("async hook used in sync operation");
      }
    }
  }
}

export class SandboxVfsProvider
  extends VirtualProviderClass
  implements VirtualProvider
{
  private readonly backend: VirtualProvider;
  private readonly hooks: VfsHooks;

  constructor(backend: VirtualProvider, hooks: VfsHooks = {}) {
    super();
    this.backend = backend;
    this.hooks = hooks;
  }

  get readonly() {
    return this.backend.readonly;
  }

  get supportsSymlinks() {
    return this.backend.supportsSymlinks;
  }

  get supportsWatch() {
    return this.backend.supportsWatch;
  }

  async open(path: string, flags: string, mode?: number) {
    await this.runBefore({ op: "open", path, flags, mode });
    const handle = this.wrapHandle(
      path,
      await this.backend.open(path, flags, mode),
    );
    await this.runAfter({ op: "open", path, flags, mode, result: handle });
    return handle;
  }

  openSync(path: string, flags: string, mode?: number) {
    this.runBeforeSync({ op: "open", path, flags, mode });
    const handle = this.wrapHandle(
      path,
      this.backend.openSync(path, flags, mode),
    );
    this.runAfterSync({ op: "open", path, flags, mode, result: handle });
    return handle;
  }

  async stat(path: string, options?: object) {
    await this.runBefore({ op: "stat", path });
    const stats = await this.backend.stat(path, options);
    await this.runAfter({ op: "stat", path, result: stats });
    return stats;
  }

  statSync(path: string, options?: object) {
    this.runBeforeSync({ op: "stat", path });
    const stats = this.backend.statSync(path, options);
    this.runAfterSync({ op: "stat", path, result: stats });
    return stats;
  }

  async lstat(path: string, options?: object) {
    await this.runBefore({ op: "lstat", path });
    const stats = await this.backend.lstat(path, options);
    await this.runAfter({ op: "lstat", path, result: stats });
    return stats;
  }

  lstatSync(path: string, options?: object) {
    this.runBeforeSync({ op: "lstat", path });
    const stats = this.backend.lstatSync(path, options);
    this.runAfterSync({ op: "lstat", path, result: stats });
    return stats;
  }

  async readdir(path: string, options?: object) {
    await this.runBefore({ op: "readdir", path });
    const entries = await this.backend.readdir(path, options);
    await this.runAfter({ op: "readdir", path, result: entries });
    return entries;
  }

  readdirSync(path: string, options?: object) {
    this.runBeforeSync({ op: "readdir", path });
    const entries = this.backend.readdirSync(path, options);
    this.runAfterSync({ op: "readdir", path, result: entries });
    return entries;
  }

  async mkdir(path: string, options?: object) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "mkdir", path);
    }
    await this.runBefore({
      op: "mkdir",
      path,
      mode: (options as { mode?: number })?.mode,
    });
    const result = await this.backend.mkdir(path, options);
    await this.runAfter({ op: "mkdir", path, result });
    return result;
  }

  mkdirSync(path: string, options?: object) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "mkdir", path);
    }
    this.runBeforeSync({
      op: "mkdir",
      path,
      mode: (options as { mode?: number })?.mode,
    });
    const result = this.backend.mkdirSync(path, options);
    this.runAfterSync({ op: "mkdir", path, result });
    return result;
  }

  async rmdir(path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "rmdir", path);
    }
    await this.runBefore({ op: "rmdir", path });
    await this.backend.rmdir(path);
    await this.runAfter({ op: "rmdir", path });
  }

  rmdirSync(path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "rmdir", path);
    }
    this.runBeforeSync({ op: "rmdir", path });
    this.backend.rmdirSync(path);
    this.runAfterSync({ op: "rmdir", path });
  }

  async unlink(path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "unlink", path);
    }
    await this.runBefore({ op: "unlink", path });
    await this.backend.unlink(path);
    await this.runAfter({ op: "unlink", path });
  }

  unlinkSync(path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "unlink", path);
    }
    this.runBeforeSync({ op: "unlink", path });
    this.backend.unlinkSync(path);
    this.runAfterSync({ op: "unlink", path });
  }

  async rename(oldPath: string, newPath: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "rename", oldPath);
    }
    await this.runBefore({ op: "rename", oldPath, newPath });
    await this.backend.rename(oldPath, newPath);
    await this.runAfter({ op: "rename", oldPath, newPath });
  }

  renameSync(oldPath: string, newPath: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "rename", oldPath);
    }
    this.runBeforeSync({ op: "rename", oldPath, newPath });
    this.backend.renameSync(oldPath, newPath);
    this.runAfterSync({ op: "rename", oldPath, newPath });
  }

  async link(oldPath: string, newPath: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "link", newPath);
    }
    await this.runBefore({ op: "link", oldPath, newPath });
    if (this.backend.link) {
      await this.backend.link(oldPath, newPath);
      await this.runAfter({ op: "link", oldPath, newPath });
      return;
    }
    throw createErrnoError(ERRNO.ENOSYS, "link", oldPath);
  }

  linkSync(oldPath: string, newPath: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "link", newPath);
    }
    this.runBeforeSync({ op: "link", oldPath, newPath });
    if (this.backend.linkSync) {
      this.backend.linkSync(oldPath, newPath);
      this.runAfterSync({ op: "link", oldPath, newPath });
      return;
    }
    throw createErrnoError(ERRNO.ENOSYS, "link", oldPath);
  }

  async readlink(path: string, options?: object) {
    if (this.backend.readlink) {
      return this.backend.readlink(path, options);
    }
    return super.readlink(path, options);
  }

  readlinkSync(path: string, options?: object) {
    if (this.backend.readlinkSync) {
      return this.backend.readlinkSync(path, options);
    }
    return super.readlinkSync(path, options);
  }

  async symlink(target: string, path: string, type?: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "symlink", path);
    }
    if (this.backend.symlink) {
      return this.backend.symlink(target, path, type);
    }
    return super.symlink(target, path, type);
  }

  symlinkSync(target: string, path: string, type?: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "symlink", path);
    }
    if (this.backend.symlinkSync) {
      return this.backend.symlinkSync(target, path, type);
    }
    return super.symlinkSync(target, path, type);
  }

  async realpath(path: string, options?: object) {
    if (this.backend.realpath) {
      return this.backend.realpath(path, options);
    }
    return super.realpath(path, options);
  }

  realpathSync(path: string, options?: object) {
    if (this.backend.realpathSync) {
      return this.backend.realpathSync(path, options);
    }
    return super.realpathSync(path, options);
  }

  async access(path: string, mode?: number) {
    if (this.backend.access) {
      return this.backend.access(path, mode);
    }
    return super.access(path, mode);
  }

  accessSync(path: string, mode?: number) {
    if (this.backend.accessSync) {
      return this.backend.accessSync(path, mode);
    }
    return super.accessSync(path, mode);
  }

  watch(path: string, options?: object) {
    return this.backend.watch?.(path, options) ?? super.watch(path, options);
  }

  watchAsync(path: string, options?: object) {
    return (
      this.backend.watchAsync?.(path, options) ??
      super.watchAsync(path, options)
    );
  }

  watchFile(
    path: string,
    options?: object,
    listener?: (...args: unknown[]) => void,
  ) {
    return (
      this.backend.watchFile?.(path, options, listener) ??
      super.watchFile(path, options)
    );
  }

  unwatchFile(path: string, listener?: (...args: unknown[]) => void) {
    if (this.backend.unwatchFile) {
      this.backend.unwatchFile(path, listener);
      return;
    }
    super.unwatchFile(path, listener);
  }

  async truncate(path: string, length: number) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "truncate", path);
    }
    await this.runBefore({ op: "truncate", path, size: length });
    const backendWithTruncate = this.backend as unknown as {
      truncate?: (entryPath: string, length: number) => Promise<void>;
    };
    if (typeof backendWithTruncate.truncate === "function") {
      await backendWithTruncate.truncate(path, length);
    } else {
      const handle = await this.backend.open(path, "r+");
      try {
        await handle.truncate(length);
      } finally {
        await handle.close();
      }
    }
    await this.runAfter({ op: "truncate", path, size: length });
  }

  truncateSync(path: string, length: number) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "truncate", path);
    }
    this.runBeforeSync({ op: "truncate", path, size: length });
    const backendWithTruncate = this.backend as unknown as {
      truncateSync?: (entryPath: string, length: number) => void;
    };
    if (typeof backendWithTruncate.truncateSync === "function") {
      backendWithTruncate.truncateSync(path, length);
    } else {
      const handle = this.backend.openSync(path, "r+");
      try {
        handle.truncateSync(length);
      } finally {
        handle.closeSync();
      }
    }
    this.runAfterSync({ op: "truncate", path, size: length });
  }

  async statfs(path: string): Promise<VfsStatfs> {
    await this.runBefore({ op: "statfs", path });
    const result = await delegateStatfsOrEnosys(this.backend, path);
    await this.runAfter({ op: "statfs", path, result });
    return result;
  }

  async close() {
    const backend = this.backend as { close?: () => Promise<void> | void };
    if (backend.close) {
      await backend.close();
    }
  }

  private wrapHandle(path: string, handle: VirtualFileHandle) {
    if (!this.hooks.before && !this.hooks.after) {
      return handle;
    }
    return new HookedHandle(handle, this.hooks, path);
  }

  private async runBefore(context: VfsHookContext) {
    if (this.hooks.before) {
      await this.hooks.before(context);
    }
  }

  private async runAfter(context: VfsHookContext) {
    if (this.hooks.after) {
      await this.hooks.after(context);
    }
  }

  private runBeforeSync(context: VfsHookContext) {
    if (this.hooks.before) {
      const result = this.hooks.before(context);
      if (result && typeof (result as Promise<void>).then === "function") {
        throw new Error("async hook used in sync operation");
      }
    }
  }

  private runAfterSync(context: VfsHookContext) {
    if (this.hooks.after) {
      const result = this.hooks.after(context);
      if (result && typeof (result as Promise<void>).then === "function") {
        throw new Error("async hook used in sync operation");
      }
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as any)?.then === "function";
}

/** @internal */
export function composeVfsHooks(a?: VfsHooks, b?: VfsHooks): VfsHooks {
  if (!a || (!a.before && !a.after)) return b ?? {};
  if (!b || (!b.before && !b.after)) return a;

  return {
    before: (ctx) => {
      const ra = a.before?.(ctx);
      if (isPromiseLike(ra)) {
        return Promise.resolve(ra).then(() => b.before?.(ctx));
      }
      return b.before?.(ctx);
    },
    after: (ctx) => {
      const ra = a.after?.(ctx);
      if (isPromiseLike(ra)) {
        return Promise.resolve(ra).then(() => b.after?.(ctx));
      }
      return b.after?.(ctx);
    },
  };
}

/** @internal */
export function wrapProvider(
  provider: VirtualProvider,
  hooks: VfsHooks,
): SandboxVfsProvider {
  if (provider instanceof SandboxVfsProvider) return provider;
  return new SandboxVfsProvider(provider, hooks);
}

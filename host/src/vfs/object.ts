/**
 * Whole-file ("object") providers: the interface of the native engine's
 * object tier (`native/DESIGN.md`, "Filesystem tiers"), plus a
 * `VirtualProvider` view of such a provider for host-side use.
 *
 * `gondolind` serves every per-operation semantic (handles, offsets,
 * attributes) from its own cache and only calls these whole-file
 * operations. {@link ObjectVirtualProvider} buffers each open file and writes
 * it back on close.
 */

import fs from "node:fs";

import { createErrnoError } from "./errors.ts";
import type { VirtualFileHandle, VirtualProvider } from "./node/index.ts";
import { markNativeMount } from "./native-marks.ts";
import { ERRNO, normalizeVfsPath, VirtualProviderClass } from "./utils.ts";

/** Kind of an object-tier entry */
export type ObjectEntryKind = "file" | "dir" | "symlink";

/** Metadata of an object-tier entry */
export type ObjectStat = {
  /** entry kind */
  kind: ObjectEntryKind;
  /** file size in `bytes` */
  size: number;
  /** permission bits (`0o7777` mask) */
  mode?: number;
  /** modification time in `ms` since the epoch */
  mtimeMs?: number;
  /** status change time in `ms` since the epoch */
  ctimeMs?: number;
  /** access time in `ms` since the epoch */
  atimeMs?: number;
  /** hard link count */
  nlink?: number;
  /** owner user id */
  uid?: number;
  /** owner group id */
  gid?: number;
};

/** One directory entry of an object-tier provider */
export type ObjectDirEntry = {
  /** entry name */
  name: string;
  /** entry kind */
  kind: ObjectEntryKind;
};

/**
 * Whole-file provider. Paths are absolute and relative to the mount. Failures
 * are errors with an errno `code` (`ENOENT`, `EACCES`, ...). Optional
 * operations that are missing behave as `ENOSYS` (or `EROFS` for writes on a
 * read-only mount).
 */
export interface ObjectProvider {
  /** metadata (without following a final symlink) */
  stat(path: string): Promise<ObjectStat>;
  /** directory listing */
  readDir(path: string): Promise<ObjectDirEntry[]>;
  /** file contents, optionally a byte range */
  readFile?(
    path: string,
    range?: { offset: number; length?: number },
  ): Promise<Uint8Array>;
  /** replace a whole file (creating it with `mode` when missing) */
  writeFile?(
    path: string,
    data: Uint8Array,
    options?: { mode?: number },
  ): Promise<void>;
  /** positional write into an existing file (used with `commit: "write"`) */
  write?(path: string, offset: number, data: Uint8Array): Promise<void>;
  truncate?(path: string, size: number): Promise<void>;
  unlink?(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  mkdir?(path: string, options?: { mode?: number }): Promise<void>;
  rmdir?(path: string): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
  symlink?(target: string, path: string): Promise<void>;
  readlink?(path: string): Promise<string>;
  link?(from: string, to: string): Promise<void>;
}

/** Options of an object mount */
export type ObjectMountOptions = {
  /** allow mutations (default: `true` when the provider has `writeFile`) */
  writable?: boolean;
  /** listing behavior: forwarded, only entries seen by the guest, or empty (default `list`) */
  enumeration?: "list" | "materialized" | "none";
  /** when guest writes reach the provider: whole file on close or every write (default `close`) */
  commit?: "close" | "write";
  /** validity of cached metadata and contents in `ms` (default 1000; 0 revalidates on every access) */
  cacheTtlMs?: number;
  /** budget for cached clean contents in `bytes` */
  maxCacheBytes?: number;
  /** re-stat on every open and refetch contents whose size or mtime changed (default `false`) */
  revalidateOnOpen?: boolean;
  /** largest file the guest may create or grow in `bytes` */
  maxFileBytes?: number;
  /**
   * files up to this size in `bytes` are fetched together with their `stat`
   * (one round trip instead of two per small file; costs a `readFile` per
   * stat of such a file, default 0 = off)
   */
  inlineMaxBytes?: number;
};

function makeStats(st: ObjectStat): fs.Stats {
  const now = Date.now();
  const kindBits =
    st.kind === "dir" ? 0o040000 : st.kind === "symlink" ? 0o120000 : 0o100000;
  const perm = st.mode ?? (st.kind === "dir" ? 0o755 : 0o644);
  const stats = Object.create(fs.Stats.prototype) as fs.Stats;
  const mtimeMs = st.mtimeMs ?? now;
  Object.assign(stats, {
    dev: 0,
    mode: kindBits | (perm & 0o7777),
    nlink: st.nlink ?? 1,
    uid: st.uid ?? 0,
    gid: st.gid ?? 0,
    rdev: 0,
    blksize: 4096,
    ino: 0,
    size: st.kind === "dir" ? 4096 : st.size,
    blocks: Math.ceil(st.size / 512),
    atimeMs: st.atimeMs ?? mtimeMs,
    mtimeMs,
    ctimeMs: st.ctimeMs ?? mtimeMs,
    birthtimeMs: mtimeMs,
    atime: new Date(st.atimeMs ?? mtimeMs),
    mtime: new Date(mtimeMs),
    ctime: new Date(st.ctimeMs ?? mtimeMs),
    birthtime: new Date(mtimeMs),
  });
  return stats;
}

class ObjectDirent {
  readonly name: string;
  private readonly kind: ObjectEntryKind;

  constructor(name: string, kind: ObjectEntryKind) {
    this.name = name;
    this.kind = kind;
  }

  isFile() {
    return this.kind === "file";
  }
  isDirectory() {
    return this.kind === "dir";
  }
  isSymbolicLink() {
    return this.kind === "symlink";
  }
  isBlockDevice() {
    return false;
  }
  isCharacterDevice() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
}

/** Turns `{ code: "ENOENT" }` style errors into node errno errors */
function toErrnoError(err: unknown, op: string, entryPath: string): unknown {
  const e = err as NodeJS.ErrnoException | null;
  if (e && typeof e === "object" && typeof e.errno === "number") return err;
  const code = e && typeof e === "object" ? e.code : undefined;
  if (typeof code === "string" && code in ERRNO) {
    const out = createErrnoError(
      ERRNO[code as keyof typeof ERRNO],
      op,
      entryPath,
    );
    if (err instanceof Error) out.message = err.message;
    return out;
  }
  return err;
}

/** Wraps a provider so failures carry node errno numbers */
function errnoProvider(provider: ObjectProvider): ObjectProvider {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } catch (err) {
          throw toErrnoError(err, String(prop), String(args[0] ?? ""));
        }
      };
    },
  });
}

function isNoEntry(err: unknown) {
  const e = err as NodeJS.ErrnoException | undefined;
  return (
    e?.code === "ENOENT" ||
    e?.code === "ERRNO_2" ||
    Math.abs(e?.errno ?? 0) === 2
  );
}

/**
 * `VirtualProvider` view of an {@link ObjectProvider} (host-side use): files are
 * read whole on open and written back whole on close when modified.
 */
export class ObjectVirtualProvider
  extends VirtualProviderClass
  implements VirtualProvider
{
  readonly objectProvider: ObjectProvider;
  readonly objectOptions: ObjectMountOptions;

  constructor(provider: ObjectProvider, options: ObjectMountOptions = {}) {
    super();
    this.objectProvider = errnoProvider(provider);
    this.objectOptions = options;
  }

  get writable() {
    return (
      this.objectOptions.writable ??
      typeof this.objectProvider.writeFile === "function"
    );
  }

  get readonly() {
    return !this.writable;
  }

  get supportsSymlinks() {
    return typeof this.objectProvider.symlink === "function";
  }

  get supportsWatch() {
    return false;
  }

  private assertWritable(op: string, entryPath: string) {
    if (!this.writable) throw createErrnoError(ERRNO.EROFS, op, entryPath);
  }

  private method<K extends keyof ObjectProvider>(
    name: K,
    entryPath: string,
  ): NonNullable<ObjectProvider[K]> {
    const fn = this.objectProvider[name];
    if (typeof fn !== "function") {
      throw createErrnoError(ERRNO.ENOSYS, String(name), entryPath);
    }
    return (fn as (...args: unknown[]) => unknown).bind(
      this.objectProvider,
    ) as NonNullable<ObjectProvider[K]>;
  }

  async stat(entryPath: string) {
    return makeStats(
      await this.objectProvider.stat(normalizeVfsPath(entryPath)),
    );
  }

  async lstat(entryPath: string) {
    return this.stat(entryPath);
  }

  statSync(entryPath: string): never {
    throw createErrnoError(ERRNO.ENOSYS, "statSync", entryPath);
  }

  lstatSync(entryPath: string): never {
    throw createErrnoError(ERRNO.ENOSYS, "lstatSync", entryPath);
  }

  async readdir(entryPath: string, options?: object) {
    const p = normalizeVfsPath(entryPath);
    const enumeration = this.objectOptions.enumeration ?? "list";
    const entries =
      enumeration === "list" ? await this.objectProvider.readDir(p) : [];
    if ((options as { withFileTypes?: boolean } | undefined)?.withFileTypes) {
      return entries.map(
        (e) => new ObjectDirent(e.name, e.kind) as unknown as fs.Dirent,
      );
    }
    return entries.map((e) => e.name);
  }

  readdirSync(entryPath: string): never {
    throw createErrnoError(ERRNO.ENOSYS, "readdirSync", entryPath);
  }

  async mkdir(entryPath: string, options?: { mode?: number }) {
    this.assertWritable("mkdir", entryPath);
    await this.method("mkdir", entryPath)(normalizeVfsPath(entryPath), {
      mode: options?.mode,
    });
  }

  mkdirSync(entryPath: string): never {
    throw createErrnoError(ERRNO.ENOSYS, "mkdirSync", entryPath);
  }

  async rmdir(entryPath: string) {
    this.assertWritable("rmdir", entryPath);
    await this.method("rmdir", entryPath)(normalizeVfsPath(entryPath));
  }

  rmdirSync(entryPath: string): never {
    throw createErrnoError(ERRNO.ENOSYS, "rmdirSync", entryPath);
  }

  async unlink(entryPath: string) {
    this.assertWritable("unlink", entryPath);
    await this.method("unlink", entryPath)(normalizeVfsPath(entryPath));
  }

  unlinkSync(entryPath: string): never {
    throw createErrnoError(ERRNO.ENOSYS, "unlinkSync", entryPath);
  }

  async rename(oldPath: string, newPath: string) {
    this.assertWritable("rename", oldPath);
    await this.method("rename", oldPath)(
      normalizeVfsPath(oldPath),
      normalizeVfsPath(newPath),
    );
  }

  renameSync(oldPath: string): never {
    throw createErrnoError(ERRNO.ENOSYS, "renameSync", oldPath);
  }

  async chmod(entryPath: string, mode: number) {
    this.assertWritable("chmod", entryPath);
    await this.method("chmod", entryPath)(normalizeVfsPath(entryPath), mode);
  }

  async symlink(target: string, entryPath: string) {
    this.assertWritable("symlink", entryPath);
    await this.method("symlink", entryPath)(
      target,
      normalizeVfsPath(entryPath),
    );
  }

  async readlink(entryPath: string) {
    return this.method("readlink", entryPath)(normalizeVfsPath(entryPath));
  }

  async link(from: string, to: string) {
    this.assertWritable("link", to);
    await this.method("link", from)(
      normalizeVfsPath(from),
      normalizeVfsPath(to),
    );
  }

  async truncate(entryPath: string, size: number) {
    this.assertWritable("truncate", entryPath);
    const p = normalizeVfsPath(entryPath);
    if (typeof this.objectProvider.truncate === "function") {
      await this.objectProvider.truncate(p, size);
      return;
    }
    const handle = await this.open(p, "r+");
    try {
      await handle.truncate(size);
    } finally {
      await handle.close();
    }
  }

  async realpath(entryPath: string) {
    return normalizeVfsPath(entryPath);
  }

  async access(entryPath: string, mode?: number) {
    await this.stat(entryPath);
    if (mode !== undefined && (mode & fs.constants.W_OK) !== 0) {
      this.assertWritable("access", entryPath);
    }
  }

  openSync(entryPath: string): never {
    throw createErrnoError(ERRNO.ENOSYS, "openSync", entryPath);
  }

  async open(
    entryPath: string,
    flags = "r",
    mode?: number,
  ): Promise<VirtualFileHandle> {
    const p = normalizeVfsPath(entryPath);
    const append = flags.startsWith("a");
    const truncateOnOpen = flags.startsWith("w");
    const writeRequested = /[wa+]/.test(flags);
    if (writeRequested) this.assertWritable("open", p);

    let exists = false;
    try {
      const st = await this.objectProvider.stat(p);
      if (st.kind === "dir") throw createErrnoError(ERRNO.EISDIR, "open", p);
      exists = true;
    } catch (err) {
      if (!isNoEntry(err)) throw err;
    }
    if (!exists && !(append || truncateOnOpen)) {
      throw createErrnoError(ERRNO.ENOENT, "open", p);
    }
    let content = Buffer.alloc(0);
    if (exists && !truncateOnOpen) {
      content = Buffer.from(await this.method("readFile", p)(p));
    }
    let dirty = truncateOnOpen || !exists;
    let position = append ? content.length : 0;
    let closed = false;
    const provider = this;
    const check = (op: string) => {
      if (closed) throw createErrnoError(ERRNO.EBADF, op, p);
    };
    const maxFileBytes = this.objectOptions.maxFileBytes;
    const grow = (size: number) => {
      if (maxFileBytes !== undefined && size > maxFileBytes) {
        throw createErrnoError(ERRNO.EFBIG, "write", p);
      }
    };

    const handle = {
      path: p,
      flags,
      mode,
      get position() {
        return position;
      },
      set position(next: number) {
        position = next;
      },
      get closed() {
        return closed;
      },
      async read(
        buffer: Buffer,
        offset: number,
        length: number,
        readPosition: number | null = null,
      ) {
        check("read");
        const start = readPosition ?? position;
        const n = Math.max(0, Math.min(length, content.length - start));
        if (n > 0) content.copy(buffer, offset, start, start + n);
        if (readPosition === null) position = start + n;
        return { bytesRead: n, buffer };
      },
      async write(
        buffer: Buffer,
        offset: number,
        length: number,
        writePosition: number | null = null,
      ) {
        check("write");
        if (!writeRequested) throw createErrnoError(ERRNO.EBADF, "write", p);
        const start = append ? content.length : (writePosition ?? position);
        const end = start + length;
        grow(end);
        if (end > content.length) {
          const next = Buffer.alloc(Math.max(end, content.length * 2));
          content.copy(next);
          content = next.subarray(0, end);
        }
        buffer.copy(content, start, offset, offset + length);
        position = end;
        dirty = true;
        return { bytesWritten: length, buffer };
      },
      async readFile(options?: { encoding?: BufferEncoding } | BufferEncoding) {
        check("readFile");
        const encoding =
          typeof options === "string" ? options : options?.encoding;
        return encoding ? content.toString(encoding) : Buffer.from(content);
      },
      async writeFile(data: Buffer | string) {
        check("writeFile");
        const next = Buffer.from(data);
        grow(next.length);
        content = next;
        position = content.length;
        dirty = true;
      },
      async stat() {
        check("fstat");
        return makeStats({ kind: "file", size: content.length, mode });
      },
      async truncate(len = 0) {
        check("truncate");
        grow(len);
        const next = Buffer.alloc(len);
        content.copy(next, 0, 0, Math.min(len, content.length));
        content = next;
        dirty = true;
      },
      async close() {
        if (closed) return;
        closed = true;
        if (dirty) {
          await provider.method("writeFile", p)(p, new Uint8Array(content), {
            mode,
          });
        }
      },
      readSync(): never {
        throw createErrnoError(ERRNO.ENOSYS, "readSync", p);
      },
      writeSync(): never {
        throw createErrnoError(ERRNO.ENOSYS, "writeSync", p);
      },
      readFileSync(): never {
        throw createErrnoError(ERRNO.ENOSYS, "readFileSync", p);
      },
      writeFileSync(): never {
        throw createErrnoError(ERRNO.ENOSYS, "writeFileSync", p);
      },
      statSync(): never {
        throw createErrnoError(ERRNO.ENOSYS, "statSync", p);
      },
      truncateSync(): never {
        throw createErrnoError(ERRNO.ENOSYS, "truncateSync", p);
      },
      closeSync(): never {
        throw createErrnoError(ERRNO.ENOSYS, "closeSync", p);
      },
    };
    return handle as unknown as VirtualFileHandle;
  }
}

/**
 * Mount an {@link ObjectProvider}: served by the native engine's object tier
 * (with a daemon-side cache); the returned {@link ObjectVirtualProvider}
 * carries the mount mark and serves host-side access.
 */
export function createObjectMount(
  provider: ObjectProvider,
  options: ObjectMountOptions = {},
): VirtualProvider {
  return markNativeMount(new ObjectVirtualProvider(provider, options), {
    kind: "object",
    provider,
    options,
  });
}

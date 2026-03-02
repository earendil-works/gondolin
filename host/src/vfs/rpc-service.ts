import os from "os";
import path from "path";
import type { Dirent, Stats } from "node:fs";

import { createErrnoError } from "./errors.ts";
import { LINUX_ERRNO, toLinuxErrno } from "./linux-errno.ts";
import type {
  VirtualFileHandle,
  VirtualProvider,
  VfsStatfs,
} from "./node/index.ts";
import {
  cloneSyntheticStatfs,
  isErrnoValue,
  normalizeStatfs,
} from "./statfs.ts";
import type { FsRequest, FsResponse } from "../sandbox/virtio-protocol.ts";

const { errno: ERRNO } = os.constants;

const DEFAULT_ENTRY_TTL_MS = 1000;
const DEFAULT_ATTR_TTL_MS = 1000;
const DEFAULT_NEGATIVE_TTL_MS = 250;
const READDIR_CACHE_TTL_MS = 5000;
const READDIR_CACHE_MAX_DIRS = 128;

const DT_REG = 8;
const DT_DIR = 4;
const DT_LNK = 10;

export const MAX_RPC_DATA = 60 * 1024;

const LINUX_OPEN_FLAGS = {
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 0x40,
  O_TRUNC: 0x200,
  O_APPEND: 0x400,
};

const ACCESS_MASK = {
  X_OK: 0x1,
  W_OK: 0x2,
  R_OK: 0x4,
};

const ACCESS_KNOWN_MASK =
  ACCESS_MASK.R_OK | ACCESS_MASK.W_OK | ACCESS_MASK.X_OK;

export type FsRpcMetrics = {
  /** total request count */
  requests: number;
  /** total error count */
  errors: number;
  /** total bytes read in `bytes` */
  bytesRead: number;
  /** total bytes written in `bytes` */
  bytesWritten: number;
  /** per-op request counts */
  ops: Record<string, number>;
};

export type FsRpcServiceOptions = {
  /** optional log sink */
  logger?: (message: string) => void;
};

type HandleEntry = {
  handle: VirtualFileHandle;
  ino: number;
  path: string;
  append: boolean;
};

type ReaddirCacheEntry = {
  entries: Array<string | Dirent>;
  expiresAt: number;
};

export class FsRpcService {
  private nextIno = 2;
  private nextHandle = 1;
  private readonly pathToIno = new Map<string, number>();
  private readonly inoToPaths = new Map<number, Set<string>>();
  private readonly handles = new Map<number, HandleEntry>();
  private readonly readdirCache = new Map<string, ReaddirCacheEntry>();
  private readonly readdirInFlight = new Map<
    string,
    Promise<Array<string | Dirent>>
  >();
  private readdirCacheVersion = 0;
  private readonly logger?: (message: string) => void;
  private readonly provider: VirtualProvider;
  readonly metrics: FsRpcMetrics = {
    requests: 0,
    errors: 0,
    bytesRead: 0,
    bytesWritten: 0,
    ops: {},
  };

  constructor(provider: VirtualProvider, options: FsRpcServiceOptions = {}) {
    this.provider = provider;
    this.logger = options.logger;
    this.pathToIno.set("/", 1);
    this.inoToPaths.set(1, new Set(["/"]));
  }

  async handleRequest(message: FsRequest): Promise<FsResponse> {
    const start = Date.now();
    const op = message.p.op;
    let err = 0;
    let res: Record<string, unknown> | undefined;
    let messageText: string | undefined;

    try {
      res = await this.dispatch(op, message.p.req);
    } catch (error) {
      const normalized = normalizeError(error);
      err = normalized.errno;
      messageText = normalized.message;
      if (op === "lookup" && err === ERRNO.ENOENT) {
        res = { entry_ttl_ms: DEFAULT_NEGATIVE_TTL_MS };
      }
    }

    this.record(op, err, res, Date.now() - start);

    return {
      v: 1,
      t: "fs_response",
      id: message.id,
      p: {
        op,
        err,
        ...(res ? { res } : {}),
        ...(messageText && err !== 0 ? { message: messageText } : {}),
      },
    };
  }

  async close() {
    const handles = Array.from(this.handles.values());
    this.handles.clear();
    this.readdirCache.clear();
    this.readdirInFlight.clear();
    this.readdirCacheVersion += 1;
    await Promise.all(
      handles.map(async (entry) => {
        try {
          await entry.handle.close();
        } catch {
          // ignore
        }
      }),
    );
  }

  private async dispatch(op: string, req: Record<string, unknown>) {
    switch (op) {
      case "lookup":
        return this.handleLookup(req);
      case "getattr":
        return this.handleGetattr(req);
      case "readlink":
        return this.handleReadlink(req);
      case "readdir":
        return this.handleReaddir(req);
      case "open":
        return this.handleOpen(req);
      case "read":
        return this.handleRead(req);
      case "write":
        return this.handleWrite(req);
      case "create":
        return this.handleCreate(req);
      case "mkdir":
        return this.handleMkdir(req);
      case "symlink":
        return this.handleSymlink(req);
      case "unlink":
        return this.handleUnlink(req);
      case "rmdir":
        return this.handleRmdir(req);
      case "rename":
        return this.handleRename(req);
      case "link":
        return this.handleLink(req);
      case "access":
        return this.handleAccess(req);
      case "truncate":
        return this.handleTruncate(req);
      case "fallocate":
        return this.handleFallocate(req);
      case "copy_file_range":
        return this.handleCopyFileRange(req);
      case "release":
        return this.handleRelease(req);
      case "statfs":
        return this.handleStatfs(req);
      default:
        throw createErrnoError(ERRNO.ENOSYS, op);
    }
  }

  private async handleLookup(req: Record<string, unknown>) {
    const parentIno = requireUint(req.parent_ino, "lookup", "parent_ino");
    const name = requireString(req.name, "lookup", "name");
    validateName(name, "lookup");
    const parentPath = this.requirePath(parentIno, "lookup");
    const entryPath = normalizePath(path.posix.join(parentPath, name));
    const stats = await this.provider.lstat(entryPath);
    const ino = this.ensureIno(entryPath);
    const attr = statsToAttr(ino, stats);
    return {
      entry: {
        ino,
        attr,
        attr_ttl_ms: DEFAULT_ATTR_TTL_MS,
        entry_ttl_ms: DEFAULT_ENTRY_TTL_MS,
      },
    };
  }

  private async handleGetattr(req: Record<string, unknown>) {
    const ino = requireUint(req.ino, "getattr", "ino");
    const entryPath = this.requirePath(ino, "getattr");
    const stats = await this.provider.lstat(entryPath);
    return {
      attr: statsToAttr(ino, stats),
      attr_ttl_ms: DEFAULT_ATTR_TTL_MS,
    };
  }

  private async handleReadlink(req: Record<string, unknown>) {
    const ino = requireUint(req.ino, "readlink", "ino");
    const entryPath = this.requirePath(ino, "readlink");
    const provider = this.provider as {
      readlink?: (path: string, options?: object) => Promise<string>;
    };
    if (typeof provider.readlink !== "function") {
      throw createErrnoError(ERRNO.ENOSYS, "readlink", entryPath);
    }

    const target = await provider.readlink(entryPath);
    return { target };
  }

  private async handleReaddir(req: Record<string, unknown>) {
    const ino = requireUint(req.ino, "readdir", "ino");
    const entryPath = this.requirePath(ino, "readdir");
    const offset = requireUint(req.offset ?? 0, "readdir", "offset");
    const maxEntries = Math.max(
      1,
      Math.min(
        4096,
        requireUint(req.max_entries ?? 1024, "readdir", "max_entries"),
      ),
    );
    const entries = await this.readCachedDirEntries(entryPath);
    const start = Math.min(offset, entries.length);

    const responseEntries: Array<Record<string, unknown>> = [];
    for (
      let index = start;
      index < entries.length && responseEntries.length < maxEntries;
      index += 1
    ) {
      const entry = entries[index];
      const name = typeof entry === "string" ? entry : entry.name;
      if (!name || name.includes("/") || name.includes("\0")) {
        continue;
      }
      const childPath = normalizePath(path.posix.join(entryPath, name));
      const childIno = this.ensureIno(childPath);
      const type = await direntType(entry, childPath, this.provider);
      responseEntries.push({
        ino: childIno,
        name,
        type,
        offset: index + 1,
      });
    }

    const nextOffset =
      start + responseEntries.length >= entries.length
        ? 0
        : start + responseEntries.length;

    return {
      entries: responseEntries,
      next_offset: nextOffset,
      entry_ttl_ms: DEFAULT_ENTRY_TTL_MS,
    };
  }

  private async handleOpen(req: Record<string, unknown>) {
    const ino = requireUint(req.ino, "open", "ino");
    const flags = requireUint(req.flags, "open", "flags");
    const entryPath = this.requirePath(ino, "open");
    const { openFlags, truncate, append } = parseOpenFlagsForOpen(flags);
    const handle = await this.provider.open(entryPath, openFlags);
    if (truncate) {
      // Truncate via the opened handle so providers that snapshot file state on open
      // still observe the truncation (MemoryProvider behaves this way).
      await handle.truncate(0);
    }
    const fh = this.allocateHandle(handle, ino, entryPath, append);
    return { fh, open_flags: 0 };
  }

  private async handleRead(req: Record<string, unknown>) {
    const fh = requireUint(req.fh, "read", "fh");
    const offset = requireUint(req.offset ?? 0, "read", "offset");
    const size = requireUint(req.size ?? 0, "read", "size");
    if (size > MAX_RPC_DATA) {
      throw createErrnoError(ERRNO.EINVAL, "read");
    }

    const handle = this.getHandle(fh, "read");

    // node:fs FileHandle.read() is allowed to return short reads even for
    // regular files.  Treating a short read as EOF would silently truncate
    // large guest reads, so loop until we fill the buffer or hit true EOF.
    const buffer = Buffer.alloc(size);
    let total = 0;
    while (total < size) {
      const { bytesRead } = await handle.handle.read(
        buffer,
        total,
        size - total,
        offset + total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }

    const data = buffer.subarray(0, total);
    this.metrics.bytesRead += total;
    return { data };
  }

  private async handleWrite(req: Record<string, unknown>) {
    const fh = requireUint(req.fh, "write", "fh");
    const offset = requireUint(req.offset ?? 0, "write", "offset");
    const data = requireBuffer(req.data, "write");
    if (data.length > MAX_RPC_DATA) {
      throw createErrnoError(ERRNO.EINVAL, "write");
    }
    const handle = this.getHandle(fh, "write");
    const position = handle.append ? null : offset;
    const { bytesWritten } = await handle.handle.write(
      data,
      0,
      data.length,
      position,
    );
    this.metrics.bytesWritten += bytesWritten;
    return { size: bytesWritten };
  }

  private async handleCreate(req: Record<string, unknown>) {
    const parentIno = requireUint(req.parent_ino, "create", "parent_ino");
    const name = requireString(req.name, "create", "name");
    const mode = requireUint(req.mode ?? 0o644, "create", "mode");
    const flags = requireUint(req.flags ?? 0, "create", "flags");
    validateName(name, "create");

    const parentPath = this.requirePath(parentIno, "create");
    const entryPath = normalizePath(path.posix.join(parentPath, name));
    const append = (flags & LINUX_OPEN_FLAGS.O_APPEND) !== 0;
    const handle = await this.provider.open(
      entryPath,
      openFlagsToString(flags, true),
      mode,
    );
    const stats = await handle.stat();
    const ino = this.ensureIno(entryPath);
    const fh = this.allocateHandle(handle, ino, entryPath, append);
    this.invalidateReaddirCacheEntries([parentPath]);

    return {
      entry: {
        ino,
        attr: statsToAttr(ino, stats),
        attr_ttl_ms: DEFAULT_ATTR_TTL_MS,
        entry_ttl_ms: DEFAULT_ENTRY_TTL_MS,
      },
      fh,
      open_flags: 0,
    };
  }

  private async handleMkdir(req: Record<string, unknown>) {
    const parentIno = requireUint(req.parent_ino, "mkdir", "parent_ino");
    const name = requireString(req.name, "mkdir", "name");
    const mode = requireUint(req.mode ?? 0o755, "mkdir", "mode");
    validateName(name, "mkdir");

    const parentPath = this.requirePath(parentIno, "mkdir");
    const entryPath = normalizePath(path.posix.join(parentPath, name));
    await this.provider.mkdir(entryPath, { mode });
    const stats = await this.provider.stat(entryPath);
    const ino = this.ensureIno(entryPath);
    this.invalidateReaddirCacheEntries([parentPath]);

    return {
      entry: {
        ino,
        attr: statsToAttr(ino, stats),
        attr_ttl_ms: DEFAULT_ATTR_TTL_MS,
        entry_ttl_ms: DEFAULT_ENTRY_TTL_MS,
      },
    };
  }

  private async handleSymlink(req: Record<string, unknown>) {
    const parentIno = requireUint(req.parent_ino, "symlink", "parent_ino");
    const name = requireString(req.name, "symlink", "name");
    const target = requireString(req.target, "symlink", "target");
    validateName(name, "symlink");

    const parentPath = this.requirePath(parentIno, "symlink");
    const entryPath = normalizePath(path.posix.join(parentPath, name));

    const provider = this.provider as {
      symlink?: (target: string, path: string, type?: string) => Promise<void>;
    };
    if (typeof provider.symlink !== "function") {
      throw createErrnoError(ERRNO.ENOSYS, "symlink", entryPath);
    }

    await provider.symlink(target, entryPath);
    const stats = await this.provider.lstat(entryPath);
    const ino = this.ensureIno(entryPath);
    this.invalidateReaddirCacheEntries([parentPath]);

    return {
      entry: {
        ino,
        attr: statsToAttr(ino, stats),
        attr_ttl_ms: DEFAULT_ATTR_TTL_MS,
        entry_ttl_ms: DEFAULT_ENTRY_TTL_MS,
      },
    };
  }

  private async handleUnlink(req: Record<string, unknown>) {
    const parentIno = requireUint(req.parent_ino, "unlink", "parent_ino");
    const name = requireString(req.name, "unlink", "name");
    validateName(name, "unlink");

    const parentPath = this.requirePath(parentIno, "unlink");
    const entryPath = normalizePath(path.posix.join(parentPath, name));
    await this.provider.unlink(entryPath);
    this.removeMapping(entryPath);
    this.invalidateReaddirCacheEntries([parentPath]);
    return {};
  }

  private async handleRmdir(req: Record<string, unknown>) {
    const parentIno = requireUint(req.parent_ino, "rmdir", "parent_ino");
    const name = requireString(req.name, "rmdir", "name");
    validateName(name, "rmdir");

    const parentPath = this.requirePath(parentIno, "rmdir");
    const entryPath = normalizePath(path.posix.join(parentPath, name));
    await this.provider.rmdir(entryPath);
    this.removeMapping(entryPath);
    this.invalidateReaddirCacheEntries([parentPath, entryPath], true);
    return {};
  }

  private async handleRename(req: Record<string, unknown>) {
    const oldParentIno = requireUint(
      req.old_parent_ino,
      "rename",
      "old_parent_ino",
    );
    const oldName = requireString(req.old_name, "rename", "old_name");
    const newParentIno = requireUint(
      req.new_parent_ino,
      "rename",
      "new_parent_ino",
    );
    const newName = requireString(req.new_name, "rename", "new_name");
    const flags = requireUint(req.flags ?? 0, "rename", "flags");
    if (flags !== 0) {
      throw createErrnoError(ERRNO.EINVAL, "rename");
    }
    validateName(oldName, "rename");
    validateName(newName, "rename");

    const oldParentPath = this.requirePath(oldParentIno, "rename");
    const newParentPath = this.requirePath(newParentIno, "rename");
    const oldPath = normalizePath(path.posix.join(oldParentPath, oldName));
    const newPath = normalizePath(path.posix.join(newParentPath, newName));
    await this.provider.rename(oldPath, newPath);
    this.renameMapping(oldPath, newPath);
    this.invalidateReaddirCacheEntries([oldParentPath, newParentPath]);
    this.invalidateReaddirCacheEntries([oldPath, newPath], true);
    return {};
  }

  private async handleLink(req: Record<string, unknown>) {
    const oldIno = requireUint(req.old_ino, "link", "old_ino");
    const newParentIno = requireUint(
      req.new_parent_ino,
      "link",
      "new_parent_ino",
    );
    const newName = requireString(req.new_name, "link", "new_name");
    validateName(newName, "link");

    const oldPath = this.requirePath(oldIno, "link");
    const newParentPath = this.requirePath(newParentIno, "link");
    const newPath = normalizePath(path.posix.join(newParentPath, newName));

    const provider = this.provider as {
      link?: (existingPath: string, newPath: string) => Promise<void>;
    };
    if (typeof provider.link !== "function") {
      throw createErrnoError(ERRNO.ENOSYS, "link", oldPath);
    }

    await provider.link(oldPath, newPath);
    const stats = await this.provider.lstat(newPath);
    const ino = this.ensureIno(newPath, oldIno);
    this.invalidateReaddirCacheEntries([newParentPath]);

    return {
      entry: {
        ino,
        attr: statsToAttr(ino, stats),
        attr_ttl_ms: DEFAULT_ATTR_TTL_MS,
        entry_ttl_ms: DEFAULT_ENTRY_TTL_MS,
      },
    };
  }

  private async handleAccess(req: Record<string, unknown>) {
    const ino = requireUint(req.ino, "access", "ino");
    const mask = requireUint(req.mask ?? 0, "access", "mask");
    const uid = requireUint(req.uid ?? 0, "access", "uid");
    const gid = requireUint(req.gid ?? 0, "access", "gid");
    if ((mask & ~ACCESS_KNOWN_MASK) !== 0) {
      throw createErrnoError(ERRNO.EINVAL, "access");
    }

    const entryPath = this.requirePath(ino, "access");
    const provider = this.provider as {
      access?: (path: string, mode?: number) => Promise<void>;
    };
    if (typeof provider.access === "function") {
      try {
        await provider.access(entryPath, mask);
        return {};
      } catch (error) {
        if (!isErrnoValue(error, ERRNO.ENOSYS)) {
          throw error;
        }
      }
    }

    await checkAccessByStat(this.provider, entryPath, mask, uid, gid);
    return {};
  }

  private async handleTruncate(req: Record<string, unknown>) {
    const ino = requireUint(req.ino, "truncate", "ino");
    const size = requireUint(req.size ?? 0, "truncate", "size");
    const entryPath = this.requirePath(ino, "truncate");
    await this.truncatePath(entryPath, size);
    return {};
  }

  private async handleFallocate(req: Record<string, unknown>) {
    const fh = requireUint(req.fh, "fallocate", "fh");
    const offset = requireUint(req.offset ?? 0, "fallocate", "offset");
    const length = requireUint(req.length ?? 0, "fallocate", "length");
    const mode = requireUint(req.mode ?? 0, "fallocate", "mode");
    if (mode !== 0) {
      throw createErrnoError(ERRNO.EOPNOTSUPP, "fallocate");
    }

    const entry = this.getHandle(fh, "fallocate");
    const endOffset = checkedAdd(offset, length, "fallocate");
    const stats = await entry.handle.stat();
    const currentSize = Number(stats.size);
    if (!Number.isFinite(currentSize) || currentSize < 0) {
      throw createErrnoError(ERRNO.EIO, "fallocate");
    }
    if (endOffset > currentSize) {
      await entry.handle.truncate(endOffset);
    }
    return {};
  }

  private async handleCopyFileRange(req: Record<string, unknown>) {
    const srcFh = requireUint(req.fh_in, "copy_file_range", "fh_in");
    const srcOffset = requireUint(req.off_in ?? 0, "copy_file_range", "off_in");
    const dstFh = requireUint(req.fh_out, "copy_file_range", "fh_out");
    const dstOffset = requireUint(
      req.off_out ?? 0,
      "copy_file_range",
      "off_out",
    );
    const length = requireUint(req.len ?? 0, "copy_file_range", "len");
    const flags = requireUint(req.flags ?? 0, "copy_file_range", "flags");
    if (flags !== 0 || length > 0xffffffff) {
      throw createErrnoError(ERRNO.EINVAL, "copy_file_range");
    }

    const source = this.getHandle(srcFh, "copy_file_range");
    const target = this.getHandle(dstFh, "copy_file_range");
    if (length === 0) {
      return { size: 0 };
    }

    const srcEnd = checkedAdd(srcOffset, length, "copy_file_range");
    const dstEnd = checkedAdd(dstOffset, length, "copy_file_range");
    const samePath = source.path === target.path;
    const overlaps = srcOffset < dstEnd && dstOffset < srcEnd;
    if (samePath && overlaps) {
      throw createErrnoError(ERRNO.EINVAL, "copy_file_range");
    }

    const chunkLimit = Math.max(1, Math.min(MAX_RPC_DATA, length));
    const buffer = Buffer.alloc(chunkLimit);
    let copied = 0;
    while (copied < length) {
      const chunk = Math.min(chunkLimit, length - copied);
      const srcPosition = checkedAdd(srcOffset, copied, "copy_file_range");
      const { bytesRead } = await source.handle.read(
        buffer,
        0,
        chunk,
        srcPosition,
      );
      if (bytesRead === 0) break;

      let writtenTotal = 0;
      while (writtenTotal < bytesRead) {
        const dstPosition = checkedAdd(
          checkedAdd(dstOffset, copied, "copy_file_range"),
          writtenTotal,
          "copy_file_range",
        );
        const { bytesWritten } = await target.handle.write(
          buffer,
          writtenTotal,
          bytesRead - writtenTotal,
          dstPosition,
        );
        if (bytesWritten === 0) {
          throw createErrnoError(ERRNO.EIO, "copy_file_range");
        }
        writtenTotal += bytesWritten;
      }

      copied += writtenTotal;
      this.metrics.bytesRead += bytesRead;
      this.metrics.bytesWritten += writtenTotal;
      if (bytesRead < chunk) break;
    }

    return { size: copied };
  }

  private async handleRelease(req: Record<string, unknown>) {
    const fh = requireUint(req.fh, "release", "fh");
    const entry = this.handles.get(fh);
    if (!entry) {
      throw createErrnoError(ERRNO.EBADF, "release");
    }
    this.handles.delete(fh);
    await entry.handle.close();
    return {};
  }

  private async handleStatfs(req: Record<string, unknown>) {
    const ino = requireUint(req.ino, "statfs", "ino");
    const entryPath = this.requirePath(ino, "statfs");
    const provider = this.provider as {
      statfs?: (path: string) => Promise<VfsStatfs>;
    };
    if (typeof provider.statfs === "function") {
      try {
        const raw = await provider.statfs(entryPath);
        return { statfs: normalizeStatfs(raw) };
      } catch (error) {
        if (isErrnoValue(error, ERRNO.ENOSYS)) {
          return { statfs: cloneSyntheticStatfs() };
        }
        throw error;
      }
    }
    return { statfs: cloneSyntheticStatfs() };
  }

  private async truncatePath(entryPath: string, size: number) {
    const provider = this.provider as {
      truncate?: (path: string, size: number) => Promise<void>;
    };
    if (provider.truncate) {
      await provider.truncate(entryPath, size);
      return;
    }
    const handle = await this.provider.open(entryPath, "r+");
    try {
      await handle.truncate(size);
    } finally {
      await handle.close();
    }
  }

  private record(
    op: string,
    err: number,
    res: Record<string, unknown> | undefined,
    durationMs: number,
  ) {
    this.metrics.requests += 1;
    this.metrics.ops[op] = (this.metrics.ops[op] ?? 0) + 1;
    if (err !== 0) this.metrics.errors += 1;

    if (this.logger) {
      const extra =
        op === "read" && Buffer.isBuffer(res?.data)
          ? ` bytes=${res.data.length}`
          : (op === "write" || op === "copy_file_range") &&
              typeof res?.size === "number"
            ? ` bytes=${res.size}`
            : "";
      this.logger(`op=${op} err=${err} dur=${durationMs}ms${extra}`);
    }
  }

  private async readCachedDirEntries(entryPath: string) {
    const normalized = normalizePath(entryPath);
    const now = Date.now();
    const cached = this.readdirCache.get(normalized);
    if (cached && cached.expiresAt > now) {
      // Sliding TTL: keep active pagination streams warm.
      this.setReaddirCacheEntry(
        normalized,
        cached.entries,
        now + READDIR_CACHE_TTL_MS,
      );
      return cached.entries;
    }

    if (cached) {
      this.readdirCache.delete(normalized);
    }

    const inFlight = this.readdirInFlight.get(normalized);
    if (inFlight) {
      return inFlight;
    }

    const startVersion = this.readdirCacheVersion;
    const load = (async () => {
      const entries = (await this.provider.readdir(normalized, {
        withFileTypes: true,
      })) as Array<string | Dirent>;

      // Ignore stale in-flight fills that raced with a mutation invalidation.
      if (startVersion === this.readdirCacheVersion) {
        this.setReaddirCacheEntry(
          normalized,
          entries,
          Date.now() + READDIR_CACHE_TTL_MS,
        );
      }

      return entries;
    })();

    this.readdirInFlight.set(normalized, load);
    try {
      return await load;
    } finally {
      if (this.readdirInFlight.get(normalized) === load) {
        this.readdirInFlight.delete(normalized);
      }
    }
  }

  private setReaddirCacheEntry(
    entryPath: string,
    entries: Array<string | Dirent>,
    expiresAt: number,
  ) {
    if (this.readdirCache.has(entryPath)) {
      this.readdirCache.delete(entryPath);
    }

    if (this.readdirCache.size >= READDIR_CACHE_MAX_DIRS) {
      const oldestKey = this.readdirCache.keys().next().value as
        | string
        | undefined;
      if (oldestKey) {
        this.readdirCache.delete(oldestKey);
      }
    }

    this.readdirCache.set(entryPath, { entries, expiresAt });
  }

  private invalidateReaddirCacheEntries(
    entryPaths: Iterable<string>,
    includeDescendants = false,
  ) {
    const targets = new Set<string>();
    for (const entryPath of entryPaths) {
      targets.add(normalizePath(entryPath));
    }
    if (targets.size === 0) {
      return;
    }

    this.readdirCacheVersion += 1;

    for (const cachePath of this.readdirCache.keys()) {
      if (matchesAnyTarget(cachePath, targets, includeDescendants)) {
        this.readdirCache.delete(cachePath);
      }
    }

    for (const cachePath of this.readdirInFlight.keys()) {
      if (matchesAnyTarget(cachePath, targets, includeDescendants)) {
        this.readdirInFlight.delete(cachePath);
      }
    }
  }

  private ensureIno(entryPath: string, preferredIno?: number) {
    const normalized = normalizePath(entryPath);
    const existing = this.pathToIno.get(normalized);
    if (existing) return existing;

    const ino = preferredIno ?? this.nextIno++;
    this.pathToIno.set(normalized, ino);

    let paths = this.inoToPaths.get(ino);
    if (!paths) {
      paths = new Set();
      this.inoToPaths.set(ino, paths);
    }
    paths.add(normalized);
    return ino;
  }

  private requirePath(ino: number, op: string) {
    const paths = this.inoToPaths.get(ino);
    const entryPath = paths?.values().next().value as string | undefined;
    if (!entryPath) {
      throw createErrnoError(ERRNO.ENOENT, op);
    }
    return entryPath;
  }

  private allocateHandle(
    handle: VirtualFileHandle,
    ino: number,
    entryPath: string,
    append: boolean,
  ) {
    const fh = this.nextHandle++;
    this.handles.set(fh, { handle, ino, path: entryPath, append });
    return fh;
  }

  private getHandle(fh: number, op: string) {
    const entry = this.handles.get(fh);
    if (!entry) {
      throw createErrnoError(ERRNO.EBADF, op);
    }
    return entry;
  }

  private removeMapping(entryPath: string) {
    const normalized = normalizePath(entryPath);
    for (const [pathKey, ino] of this.pathToIno.entries()) {
      if (pathKey === normalized || pathKey.startsWith(normalized + "/")) {
        this.pathToIno.delete(pathKey);
        const paths = this.inoToPaths.get(ino);
        if (paths) {
          paths.delete(pathKey);
          if (paths.size === 0) {
            this.inoToPaths.delete(ino);
          }
        }
      }
    }
  }

  private renameMapping(oldPath: string, newPath: string) {
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);
    const updates: Array<{ oldPath: string; newPath: string; ino: number }> =
      [];

    for (const [pathKey, ino] of this.pathToIno.entries()) {
      if (
        pathKey === normalizedOld ||
        pathKey.startsWith(normalizedOld + "/")
      ) {
        const suffix = pathKey.slice(normalizedOld.length);
        updates.push({
          oldPath: pathKey,
          newPath: normalizedNew + suffix,
          ino,
        });
      }
    }

    for (const [pathKey, ino] of this.pathToIno.entries()) {
      const overlapsDestination =
        pathKey === normalizedNew || pathKey.startsWith(normalizedNew + "/");
      const isMovedSource =
        pathKey === normalizedOld || pathKey.startsWith(normalizedOld + "/");
      if (!overlapsDestination || isMovedSource) {
        continue;
      }

      this.pathToIno.delete(pathKey);
      const paths = this.inoToPaths.get(ino);
      if (paths) {
        paths.delete(pathKey);
        if (paths.size === 0) {
          this.inoToPaths.delete(ino);
        }
      }
    }

    for (const update of updates) {
      this.pathToIno.delete(update.oldPath);
      this.pathToIno.set(update.newPath, update.ino);

      const paths = this.inoToPaths.get(update.ino);
      if (paths) {
        paths.delete(update.oldPath);
        paths.add(update.newPath);
      } else {
        this.inoToPaths.set(update.ino, new Set([update.newPath]));
      }
    }

    for (const handleEntry of this.handles.values()) {
      if (
        handleEntry.path === normalizedOld ||
        handleEntry.path.startsWith(normalizedOld + "/")
      ) {
        const suffix = handleEntry.path.slice(normalizedOld.length);
        handleEntry.path = normalizedNew + suffix;
      }
    }
  }
}

function normalizePath(entryPath: string) {
  let normalized = path.posix.normalize(entryPath);
  if (!normalized.startsWith("/")) {
    normalized = "/" + normalized;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function matchesAnyTarget(
  cachePath: string,
  targets: Set<string>,
  includeDescendants: boolean,
) {
  for (const target of targets) {
    if (cachePath === target) {
      return true;
    }
    if (includeDescendants && cachePath.startsWith(target + "/")) {
      return true;
    }
  }
  return false;
}

function validateName(name: string, op: string) {
  if (!name || name.includes("/") || name.includes("\0")) {
    throw createErrnoError(ERRNO.EINVAL, op, name);
  }
}

function requireUint(value: unknown, op: string, field: string) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    throw createErrnoError(ERRNO.EINVAL, op, field);
  }
  return value;
}

function requireString(value: unknown, op: string, field: string) {
  if (typeof value !== "string") {
    throw createErrnoError(ERRNO.EINVAL, op, field);
  }
  return value;
}

function requireBuffer(value: unknown, op: string) {
  if (!Buffer.isBuffer(value)) {
    throw createErrnoError(ERRNO.EINVAL, op);
  }
  return value;
}

function statsToAttr(ino: number, stats: Stats) {
  return {
    ino,
    mode: stats.mode,
    nlink: stats.nlink,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime_ms: Math.round(stats.atimeMs),
    mtime_ms: Math.round(stats.mtimeMs),
    ctime_ms: Math.round(stats.ctimeMs),
  };
}

function openFlagsToString(flags: number, forceCreate: boolean) {
  const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } =
    LINUX_OPEN_FLAGS;
  const access = flags & (O_RDONLY | O_WRONLY | O_RDWR);
  const append = (flags & O_APPEND) !== 0;
  const trunc = (flags & O_TRUNC) !== 0;
  const create = (flags & O_CREAT) !== 0 || forceCreate;

  if (append) {
    return access === O_RDWR ? "a+" : "a";
  }

  if (create || trunc) {
    return access === O_RDWR ? "w+" : "w";
  }

  if (access === O_RDWR) return "r+";
  if (access === O_WRONLY) return "r+";
  return "r";
}

function parseOpenFlagsForOpen(flags: number) {
  const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } =
    LINUX_OPEN_FLAGS;
  if ((flags & O_CREAT) !== 0) {
    throw createErrnoError(ERRNO.EINVAL, "open");
  }
  const truncate = (flags & O_TRUNC) !== 0;
  const access = flags & (O_RDONLY | O_WRONLY | O_RDWR);
  const append = (flags & O_APPEND) !== 0;

  let openFlags: string;
  const appendEnabled = append && access !== O_RDONLY;
  if (appendEnabled) {
    openFlags = access === O_RDWR ? "a+" : "a";
  } else {
    openFlags = access === O_RDWR || access === O_WRONLY ? "r+" : "r";
  }

  return { openFlags, truncate, append: appendEnabled };
}

type DirentLike = {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

function isDirentLike(entry: unknown): entry is DirentLike {
  return Boolean(
    entry &&
    typeof entry === "object" &&
    "isDirectory" in entry &&
    typeof (entry as { isDirectory: () => boolean }).isDirectory ===
      "function" &&
    "isSymbolicLink" in entry &&
    typeof (entry as { isSymbolicLink: () => boolean }).isSymbolicLink ===
      "function",
  );
}

async function direntType(
  entry: string | Dirent,
  entryPath: string,
  provider: VirtualProvider,
) {
  if (isDirentLike(entry)) {
    if (entry.isDirectory()) return DT_DIR;
    if (entry.isSymbolicLink()) return DT_LNK;
    return DT_REG;
  }

  try {
    const stats = await provider.lstat(entryPath);
    if (stats.isDirectory()) return DT_DIR;
    if (stats.isSymbolicLink()) return DT_LNK;
    return DT_REG;
  } catch {
    return DT_REG;
  }
}

function checkedAdd(left: number, right: number, op: string) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw createErrnoError(ERRNO.EINVAL, op);
  }
  return sum;
}

async function checkAccessByStat(
  provider: VirtualProvider,
  entryPath: string,
  mask: number,
  uid: number,
  gid: number,
) {
  const stats = await provider.stat(entryPath);
  if (mask === 0) {
    return;
  }

  if ((mask & ACCESS_MASK.W_OK) !== 0 && provider.readonly) {
    throw createErrnoError(ERRNO.EROFS, "access", entryPath);
  }

  const modeBits = Number(stats.mode) & 0o777;
  if (!Number.isInteger(modeBits)) {
    throw createErrnoError(ERRNO.EIO, "access", entryPath);
  }

  if (uid === 0) {
    if ((mask & ACCESS_MASK.X_OK) !== 0 && (modeBits & 0o111) === 0) {
      throw createErrnoError(ERRNO.EACCES, "access", entryPath);
    }
    return;
  }

  const ownerUid = Number.isInteger(stats.uid) ? Number(stats.uid) : -1;
  const ownerGid = Number.isInteger(stats.gid) ? Number(stats.gid) : -1;
  const shift = uid === ownerUid ? 6 : gid === ownerGid ? 3 : 0;
  const granted = (modeBits >> shift) & 0o7;

  if ((mask & ACCESS_MASK.R_OK) !== 0 && (granted & 0o4) === 0) {
    throw createErrnoError(ERRNO.EACCES, "access", entryPath);
  }
  if ((mask & ACCESS_MASK.W_OK) !== 0 && (granted & 0o2) === 0) {
    throw createErrnoError(ERRNO.EACCES, "access", entryPath);
  }
  if ((mask & ACCESS_MASK.X_OK) !== 0 && (granted & 0o1) === 0) {
    throw createErrnoError(ERRNO.EACCES, "access", entryPath);
  }
}

type ErrnoResult = {
  errno: number;
  message: string;
};

function normalizeError(error: unknown): ErrnoResult {
  if (isErrnoError(error)) {
    return {
      errno: toLinuxErrno(error, LINUX_ERRNO.EIO),
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return { errno: LINUX_ERRNO.EIO, message: error.message };
  }
  return { errno: LINUX_ERRNO.EIO, message: "unknown error" };
}

function isErrnoError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
    typeof error === "object" &&
    "errno" in error &&
    "message" in error,
  );
}

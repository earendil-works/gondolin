import os from "os";
import path from "path";
import type { Dirent, Stats } from "node:fs";

import { createErrnoError } from "./errors";
import type { VirtualFileHandle, VirtualProvider } from "./node";
import type { FsRequest, FsResponse } from "../virtio-protocol";

const { errno: ERRNO } = os.constants;

const DEFAULT_ENTRY_TTL_MS = 1000;
const DEFAULT_ATTR_TTL_MS = 1000;
const DEFAULT_NEGATIVE_TTL_MS = 250;

const DT_REG = 1;
const DT_DIR = 2;
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

export class FsRpcService {
  private nextIno = 2;
  private nextHandle = 1;
  private readonly pathToIno = new Map<string, number>();
  private readonly inoToPath = new Map<number, string>();
  private readonly handles = new Map<number, HandleEntry>();
  private readonly logger?: (message: string) => void;
  readonly metrics: FsRpcMetrics = {
    requests: 0,
    errors: 0,
    bytesRead: 0,
    bytesWritten: 0,
    ops: {},
  };

  constructor(private readonly provider: VirtualProvider, options: FsRpcServiceOptions = {}) {
    this.logger = options.logger;
    this.pathToIno.set("/", 1);
    this.inoToPath.set(1, "/");
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
    await Promise.all(
      handles.map(async (entry) => {
        try {
          await entry.handle.close();
        } catch {
          // ignore
        }
      })
    );
  }

  private async dispatch(op: string, req: Record<string, unknown>) {
    switch (op) {
      case "lookup":
        return this.handleLookup(req);
      case "getattr":
        return this.handleGetattr(req);
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
      case "unlink":
        return this.handleUnlink(req);
      case "rename":
        return this.handleRename(req);
      case "truncate":
        return this.handleTruncate(req);
      case "release":
        return this.handleRelease(req);
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
    const stats = await this.provider.stat(entryPath);
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
    const stats = await this.provider.stat(entryPath);
    return {
      attr: statsToAttr(ino, stats),
      attr_ttl_ms: DEFAULT_ATTR_TTL_MS,
    };
  }

  private async handleReaddir(req: Record<string, unknown>) {
    const ino = requireUint(req.ino, "readdir", "ino");
    const entryPath = this.requirePath(ino, "readdir");
    const offset = requireUint(req.offset ?? 0, "readdir", "offset");
    const maxEntries = Math.max(1, Math.min(4096, requireUint(req.max_entries ?? 1024, "readdir", "max_entries")));
    const entries = (await this.provider.readdir(entryPath, { withFileTypes: true })) as Array<
      string | Dirent
    >;
    const start = Math.min(offset, entries.length);

    const responseEntries: Array<Record<string, unknown>> = [];
    for (let index = start; index < entries.length && responseEntries.length < maxEntries; index += 1) {
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

    const nextOffset = start + responseEntries.length >= entries.length ? 0 : start + responseEntries.length;

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
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.handle.read(buffer, 0, size, offset);
    const data = buffer.subarray(0, bytesRead);
    this.metrics.bytesRead += bytesRead;
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
    const { bytesWritten } = await handle.handle.write(data, 0, data.length, position);
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
    const handle = await this.provider.open(entryPath, openFlagsToString(flags, true), mode);
    const stats = await handle.stat();
    const ino = this.ensureIno(entryPath);
    const fh = this.allocateHandle(handle, ino, entryPath, append);

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
    return {};
  }

  private async handleRename(req: Record<string, unknown>) {
    const oldParentIno = requireUint(req.old_parent_ino, "rename", "old_parent_ino");
    const oldName = requireString(req.old_name, "rename", "old_name");
    const newParentIno = requireUint(req.new_parent_ino, "rename", "new_parent_ino");
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
    return {};
  }

  private async handleTruncate(req: Record<string, unknown>) {
    const ino = requireUint(req.ino, "truncate", "ino");
    const size = requireUint(req.size ?? 0, "truncate", "size");
    const entryPath = this.requirePath(ino, "truncate");
    await this.truncatePath(entryPath, size);
    return {};
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

  private async truncatePath(entryPath: string, size: number) {
    const provider = this.provider as { truncate?: (path: string, size: number) => Promise<void> };
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

  private record(op: string, err: number, res: Record<string, unknown> | undefined, durationMs: number) {
    this.metrics.requests += 1;
    this.metrics.ops[op] = (this.metrics.ops[op] ?? 0) + 1;
    if (err !== 0) this.metrics.errors += 1;

    if (this.logger) {
      const extra = op === "read" && Buffer.isBuffer(res?.data)
        ? ` bytes=${res.data.length}`
        : op === "write" && typeof res?.size === "number"
          ? ` bytes=${res.size}`
          : "";
      this.logger(`op=${op} err=${err} dur=${durationMs}ms${extra}`);
    }
  }

  private ensureIno(entryPath: string) {
    const normalized = normalizePath(entryPath);
    const existing = this.pathToIno.get(normalized);
    if (existing) return existing;
    const ino = this.nextIno++;
    this.pathToIno.set(normalized, ino);
    this.inoToPath.set(ino, normalized);
    return ino;
  }

  private requirePath(ino: number, op: string) {
    const entryPath = this.inoToPath.get(ino);
    if (!entryPath) {
      throw createErrnoError(ERRNO.ENOENT, op);
    }
    return entryPath;
  }

  private allocateHandle(
    handle: VirtualFileHandle,
    ino: number,
    entryPath: string,
    append: boolean
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
        this.inoToPath.delete(ino);
      }
    }
  }

  private renameMapping(oldPath: string, newPath: string) {
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);
    const updates: Array<{ oldPath: string; newPath: string; ino: number }> = [];

    for (const [pathKey, ino] of this.pathToIno.entries()) {
      if (pathKey === normalizedOld || pathKey.startsWith(normalizedOld + "/")) {
        const suffix = pathKey.slice(normalizedOld.length);
        updates.push({ oldPath: pathKey, newPath: normalizedNew + suffix, ino });
      }
    }

    for (const update of updates) {
      this.pathToIno.delete(update.oldPath);
      this.pathToIno.set(update.newPath, update.ino);
      this.inoToPath.set(update.ino, update.newPath);
    }

    for (const handleEntry of this.handles.values()) {
      if (handleEntry.path === normalizedOld || handleEntry.path.startsWith(normalizedOld + "/")) {
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

function validateName(name: string, op: string) {
  if (!name || name.includes("/") || name.includes("\0")) {
    throw createErrnoError(ERRNO.EINVAL, op, name);
  }
}

function requireUint(value: unknown, op: string, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
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
  const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = LINUX_OPEN_FLAGS;
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
  const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = LINUX_OPEN_FLAGS;
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

type DirentLike = { name: string; isDirectory(): boolean; isSymbolicLink(): boolean };

function isDirentLike(entry: unknown): entry is DirentLike {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      "isDirectory" in entry &&
      typeof (entry as { isDirectory: () => boolean }).isDirectory === "function" &&
      "isSymbolicLink" in entry &&
      typeof (entry as { isSymbolicLink: () => boolean }).isSymbolicLink === "function"
  );
}

async function direntType(entry: string | Dirent, entryPath: string, provider: VirtualProvider) {
  if (isDirentLike(entry)) {
    if (entry.isDirectory()) return DT_DIR;
    if (entry.isSymbolicLink()) return DT_LNK;
    return DT_REG;
  }

  try {
    const stats = await provider.stat(entryPath);
    if (stats.isDirectory()) return DT_DIR;
    if (stats.isSymbolicLink()) return DT_LNK;
    return DT_REG;
  } catch {
    return DT_REG;
  }
}

type ErrnoResult = {
  errno: number;
  message: string;
};

function normalizeError(error: unknown): ErrnoResult {
  if (isErrnoError(error)) {
    let errno = typeof error.errno === "number" ? error.errno : ERRNO.EIO;
    // Some providers (and some syscall layers) use negative errno values.
    // Normalize to a positive errno for the RPC protocol.
    if (errno < 0) errno = -errno;
    return {
      errno,
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return { errno: ERRNO.EIO, message: error.message };
  }
  return { errno: ERRNO.EIO, message: "unknown error" };
}

function isErrnoError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "errno" in error && "message" in error);
}

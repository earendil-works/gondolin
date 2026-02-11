/**
 * RPC client for guest FUSE filesystem operations.
 *
 * ## Protocol Conventions
 * - Paths: UTF-8, absolute, normalized with forward slashes, no trailing slash (except "/")
 * - Names: single path component (no "/" or NUL)
 * - Errors: responses include `err` (POSIX errno, 0 = success) and optional `message`
 * - Payload limit: read/write data capped at 60 KiB per request to keep frames under 64 KiB
 * - Handles: host returns opaque `fh` (u64) for open/create; guest passes back for read/write/release
 *
 * ## Caching
 * Host may provide `entry_ttl_ms` and `attr_ttl_ms` in responses. Guest caches entries
 * for the specified duration (default 1000ms). Negative lookups (ENOENT) cache for
 * `entry_ttl_ms` (default 250ms) to avoid repeated failed lookups.
 *
 * Root inode is always 1 and implicitly known at mount time.
 */

import net from "net";
import path from "path";
import fs from "node:fs";
import os from "os";
import cbor from "cbor";
import type { Dirent, Stats } from "node:fs";

import { FrameReader, encodeFrame, normalize } from "../virtio-protocol";
import { createErrnoError } from "./errors";
import { VirtualProvider as VirtualProviderBase } from "./node";
import type { VirtualProvider, VirtualFileHandle } from "./node";

const { errno: ERRNO } = os.constants;
const VirtualProviderClass = VirtualProviderBase as unknown as { new (...args: any[]): any };

export type FsRequestMessage = {
  /** protocol version */
  v: number;
  /** message type */
  t: "fs_request";
  /** request id */
  id: number;
  /** payload */
  p: {
    /** operation name */
    op: string;
    /** operation fields */
    req: Record<string, unknown>;
  };
};

export type FsResponseMessage = {
  /** protocol version */
  v: number;
  /** message type */
  t: "fs_response";
  /** request id */
  id: number;
  /** payload */
  p: {
    /** operation name */
    op: string;
    /** posix errno (0 = success) */
    err: number;
    /** operation result fields */
    res?: Record<string, unknown>;
    /** optional error detail */
    message?: string;
  };
};

type FsErrorMessage = {
  /** protocol version */
  v: number;
  /** message type */
  t: "error";
  /** request id */
  id: number;
  /** payload */
  p: {
    /** stable error code */
    code: string;
    /** human-readable error message */
    message: string;
  };
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REQUEST_ID = 0xffffffff;
const MAX_DATA_SIZE = 60 * 1024;

export class FsRpcClient {
  private socket: net.Socket | null = null;
  private readonly reader = new FrameReader();
  private readonly inflight = new Map<number, {
    resolve: (message: FsResponseMessage) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
  }>();
  private nextId = 1;

  constructor(private readonly socketPath: string, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async request(op: string, req: Record<string, unknown>): Promise<FsResponseMessage> {
    const id = this.allocateId();
    const message: FsRequestMessage = { v: 1, t: "fs_request", id, p: { op, req } };
    const frame = encodeFrame(message);
    await this.ensureSocket();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        reject(new Error(`fs request ${op} timed out`));
      }, this.timeoutMs);
      this.inflight.set(id, { resolve, reject, timer });
      void this.writeFrame(frame).catch((err) => {
        this.inflight.delete(id);
        if (timer) clearTimeout(timer);
        reject(err instanceof Error ? err : new Error("fs write failed"));
      });
    });
  }

  requestSync(_op: string, _req: Record<string, unknown>): FsResponseMessage {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "fs_request");
  }

  close() {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }

  private allocateId() {
    for (let i = 0; i <= MAX_REQUEST_ID; i += 1) {
      const id = this.nextId;
      this.nextId = this.nextId + 1;
      if (this.nextId > MAX_REQUEST_ID) this.nextId = 1;
      if (!this.inflight.has(id)) return id;
    }
    throw new Error("no available request ids");
  }

  private async ensureSocket() {
    if (this.socket && !this.socket.destroyed) return;

    this.socket = net.createConnection({ path: this.socketPath });

    this.socket.on("data", (chunk) => {
      this.reader.push(chunk, (frame) => {
        try {
          const raw = cbor.decodeFirstSync(frame);
          const message = normalize(raw) as FsResponseMessage | FsErrorMessage;
          this.handleMessage(message);
        } catch (err) {
          this.failInflight(err instanceof Error ? err : new Error("fs decode error"));
        }
      });
    });

    this.socket.on("error", (err) => {
      this.failInflight(err instanceof Error ? err : new Error("fs socket error"));
    });

    this.socket.on("close", () => {
      this.failInflight(new Error("fs socket closed"));
    });
  }

  private async writeFrame(frame: Buffer) {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error("fs socket not connected");
    }
    const ok = socket.write(frame);
    if (!ok) {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          cleanup();
          reject(new Error("fs socket closed"));
        };
        const cleanup = () => {
          socket.off("error", onError);
          socket.off("drain", onDrain);
          socket.off("close", onClose);
        };
        socket.once("error", onError);
        socket.once("drain", onDrain);
        socket.once("close", onClose);
      });
    }
  }

  private handleMessage(message: FsResponseMessage | FsErrorMessage) {
    if (message.t === "error") {
      const inflight = this.inflight.get(message.id);
      if (!inflight) return;
      this.inflight.delete(message.id);
      if (inflight.timer) clearTimeout(inflight.timer);
      inflight.reject(new Error(`fs error ${message.p.code}: ${message.p.message}`));
      return;
    }

    const inflight = this.inflight.get(message.id);
    if (!inflight) return;
    this.inflight.delete(message.id);
    if (inflight.timer) clearTimeout(inflight.timer);
    inflight.resolve(message);
  }

  private failInflight(error: Error) {
    for (const [id, inflight] of this.inflight.entries()) {
      this.inflight.delete(id);
      if (inflight.timer) clearTimeout(inflight.timer);
      inflight.reject(error);
    }
  }
}

export class RpcFileHandle implements VirtualFileHandle {
  private isClosed = false;
  private cursor = 0;

  constructor(
    private readonly client: FsRpcClient,
    private readonly ino: number,
    private readonly fh: number,
    public readonly path: string,
    public readonly flags: string
  ) {}

  get position() {
    return this.cursor;
  }

  set position(value: number) {
    this.cursor = value;
  }

  get closed() {
    return this.isClosed;
  }

  readSync(_buffer: Buffer, _offset: number, _length: number, _position?: number | null): number {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "read");
  }

  async read(buffer: Buffer, offset: number, length: number, position?: number | null) {
    this.ensureOpen();
    const size = Math.min(length, MAX_DATA_SIZE);
    const readOffset = position ?? this.position;
    const response = await this.client.request("read", {
      fh: this.fh,
      offset: readOffset,
      size,
    });
    assertOk(response, "read");
    const data = Buffer.from((response.p.res?.data as Buffer) ?? []);
    data.copy(buffer, offset);
    if (position === null || position === undefined) {
      this.position = readOffset + data.length;
    }
    return { bytesRead: data.length, buffer } as const;
  }

  writeSync(_buffer: Buffer, _offset: number, _length: number, _position?: number | null): number {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "write");
  }

  async write(buffer: Buffer, offset: number, length: number, position?: number | null) {
    this.ensureOpen();
    const data = buffer.subarray(offset, offset + Math.min(length, MAX_DATA_SIZE));
    const writeOffset = position ?? this.position;
    const response = await this.client.request("write", {
      fh: this.fh,
      offset: writeOffset,
      data,
    });
    assertOk(response, "write");
    const written = (response.p.res?.size as number) ?? data.length;
    if (position === null || position === undefined) {
      this.position = writeOffset + written;
    }
    return { bytesWritten: written, buffer } as const;
  }

  readFileSync(_options?: { encoding?: BufferEncoding } | BufferEncoding): Buffer | string {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "readFile");
  }

  async readFile(options?: { encoding?: BufferEncoding } | BufferEncoding) {
    this.ensureOpen();
    const encoding = typeof options === "string" ? options : options?.encoding;
    let offset = 0;
    const chunks: Buffer[] = [];
    while (true) {
      const response = await this.client.request("read", {
        fh: this.fh,
        offset,
        size: MAX_DATA_SIZE,
      });
      assertOk(response, "read");
      const data = Buffer.from((response.p.res?.data as Buffer) ?? []);
      if (data.length === 0) break;
      chunks.push(data);
      offset += data.length;
    }
    const content = Buffer.concat(chunks);
    return encoding ? content.toString(encoding) : content;
  }

  writeFileSync(_data: Buffer | string, _options?: { encoding?: BufferEncoding }) {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "writeFile");
  }

  async writeFile(data: Buffer | string, options?: { encoding?: BufferEncoding }) {
    this.ensureOpen();
    const buffer = typeof data === "string" ? Buffer.from(data, options?.encoding) : Buffer.from(data);
    const truncateResponse = await this.client.request("truncate", { ino: this.ino, size: 0 });
    assertOk(truncateResponse, "truncate");
    let offset = 0;
    while (offset < buffer.length) {
      const slice = buffer.subarray(offset, offset + MAX_DATA_SIZE);
      const response = await this.client.request("write", {
        fh: this.fh,
        offset,
        data: slice,
      });
      assertOk(response, "write");
      const written = (response.p.res?.size as number) ?? slice.length;
      offset += written;
      if (written === 0) break;
    }
    this.position = buffer.length;
  }

  statSync(): Stats {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "stat");
  }

  async stat() {
    this.ensureOpen();
    const response = await this.client.request("getattr", { ino: this.ino });
    assertOk(response, "getattr");
    return statsFromAttr(response.p.res?.attr as RpcAttr);
  }

  truncateSync(_length = 0) {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "truncate");
  }

  async truncate(length?: number) {
    this.ensureOpen();
    const response = await this.client.request("truncate", { ino: this.ino, size: length ?? 0 });
    assertOk(response, "truncate");
  }

  closeSync() {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "close");
  }

  async close() {
    if (this.isClosed) return;
    const response = await this.client.request("release", { fh: this.fh });
    assertOk(response, "release");
    this.isClosed = true;
  }

  private ensureOpen() {
    if (this.isClosed) {
      throw createErrnoError(ERRNO.EBADF, "read");
    }
  }
}

class RpcDirent {
  readonly parentPath: string;
  readonly path: string;

  constructor(
    public readonly name: string,
    private readonly entryType: "file" | "dir" | "symlink",
    parentPath = ""
  ) {
    this.parentPath = parentPath;
    this.path = parentPath;
  }

  isFile() {
    return this.entryType === "file";
  }

  isDirectory() {
    return this.entryType === "dir";
  }

  isSymbolicLink() {
    return this.entryType === "symlink";
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

type RpcAttr = {
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  size: number;
  atime_ms: number;
  mtime_ms: number;
  ctime_ms: number;
  blocks?: number;
  blksize?: number;
  rdev?: number;
};

export class RpcFsBackend extends VirtualProviderClass implements VirtualProvider {
  private readonly cache = new Map<string, CachedEntry>();

  constructor(private readonly client: FsRpcClient) {
    super();
    const now = Date.now();
    this.cache.set("/", {
      ino: 1,
      attr: {
        ino: 1,
        mode: fs.constants.S_IFDIR | 0o755,
        nlink: 1,
        uid: 0,
        gid: 0,
        size: 0,
        atime_ms: now,
        mtime_ms: now,
        ctime_ms: now,
      },
      expiresAt: now + 1000,
      attrExpiresAt: now + 1000,
      negative: false,
    });
  }

  get readonly() {
    return false;
  }

  get supportsSymlinks() {
    return false;
  }

  get supportsWatch() {
    return false;
  }

  openSync(_entryPath: string, _flags: string, _mode?: number): VirtualFileHandle {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "open");
  }

  async open(entryPath: string, flags: string, mode?: number) {
    const normalized = normalizePath(entryPath);
    const flagInfo = parseOpenFlags(flags);
    let entry = await this.lookupPath(normalized);
    if (!entry && flagInfo.create) {
      const { parent, name } = await this.lookupParent(normalized);
      const response = await this.client.request("create", {
        parent_ino: parent.ino,
        name,
        mode: mode ?? 0o644,
        flags: flagInfo.numeric,
      });
      assertOk(response, "create", entryPath);
      const created = response.p.res?.entry as { ino: number; attr: RpcAttr; entry_ttl_ms?: number; attr_ttl_ms?: number };
      entry = this.cacheEntry(normalized, created);
      const fh = response.p.res?.fh as number;
      return new RpcFileHandle(this.client, entry.ino, fh, normalized, flags);
    }
    if (!entry) {
      throw createErrnoError(ERRNO.ENOENT, "open", entryPath);
    }
    const openFlags = flagInfo.numeric & ~fs.constants.O_CREAT;
    const response = await this.client.request("open", { ino: entry.ino, flags: openFlags });
    assertOk(response, "open", entryPath);
    const fh = response.p.res?.fh as number;
    if (flagInfo.truncate) {
      await this.client.request("truncate", { ino: entry.ino, size: 0 });
    }
    return new RpcFileHandle(this.client, entry.ino, fh, normalized, flags);
  }

  statSync(_entryPath: string, _options?: object): Stats {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "stat");
  }

  async stat(entryPath: string, _options?: object) {
    const entry = await this.ensureEntry(entryPath);
    const response = await this.client.request("getattr", { ino: entry.ino });
    assertOk(response, "getattr", entryPath);
    const attr = response.p.res?.attr as RpcAttr;
    const attrTtl = (response.p.res?.attr_ttl_ms as number) ?? 1000;
    this.updateAttr(entryPath, attr, attrTtl);
    return statsFromAttr(attr);
  }

  lstatSync(_entryPath: string, _options?: object): Stats {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "lstat");
  }

  async lstat(entryPath: string, options?: object) {
    return this.stat(entryPath, options);
  }

  readdirSync(_entryPath: string, _options?: { withFileTypes?: boolean }): Array<string | Dirent> {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "readdir");
  }

  async readdir(entryPath: string, options?: { withFileTypes?: boolean }) {
    const entry = await this.ensureEntry(entryPath);
    const names: Array<string | Dirent> = [];
    let offset = 0;
    while (true) {
      const response = await this.client.request("readdir", {
        ino: entry.ino,
        offset,
        max_entries: 1024,
      });
      assertOk(response, "readdir", entryPath);
      const entries = (response.p.res?.entries as Array<{ name: string; type: number; offset?: number }> | undefined) ?? [];
      for (const dirent of entries) {
        if (options?.withFileTypes) {
          const type = dirent.type === 2 ? "dir" : dirent.type === 10 ? "symlink" : "file";
          names.push(new RpcDirent(dirent.name, type));
        } else {
          names.push(dirent.name);
        }
      }
      const nextOffset = (response.p.res?.next_offset as number) ?? 0;
      if (!nextOffset) break;
      offset = nextOffset;
    }
    return names;
  }

  mkdirSync(_entryPath: string, _options?: { recursive?: boolean; mode?: number }): void | string {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "mkdir");
  }

  async mkdir(entryPath: string, options?: { recursive?: boolean; mode?: number }) {
    const normalized = normalizePath(entryPath);
    if (normalized === "/") return;
    if (options?.recursive) {
      await this.mkdirRecursive(normalized, options?.mode);
      return;
    }
    const { parent, name } = await this.lookupParent(normalized);
    const response = await this.client.request("mkdir", {
      parent_ino: parent.ino,
      name,
      mode: options?.mode ?? 0o755,
    });
    assertOk(response, "mkdir", entryPath);
    const entry = response.p.res?.entry as { ino: number; attr: RpcAttr; entry_ttl_ms?: number; attr_ttl_ms?: number };
    this.cacheEntry(normalized, entry);
  }

  rmdirSync(_entryPath: string) {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "rmdir");
  }

  async rmdir(entryPath: string) {
    const normalized = normalizePath(entryPath);
    const { parent, name } = await this.lookupParent(normalized);
    const response = await this.client.request("rmdir", { parent_ino: parent.ino, name });
    assertOk(response, "rmdir", entryPath);
    this.cache.delete(normalized);
  }

  unlinkSync(_entryPath: string) {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "unlink");
  }

  async unlink(entryPath: string) {
    const normalized = normalizePath(entryPath);
    const { parent, name } = await this.lookupParent(normalized);
    const response = await this.client.request("unlink", { parent_ino: parent.ino, name });
    assertOk(response, "unlink", entryPath);
    this.cache.delete(normalized);
  }

  renameSync(_oldPath: string, _newPath: string) {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "rename");
  }

  async rename(oldPath: string, newPath: string) {
    const source = normalizePath(oldPath);
    const target = normalizePath(newPath);
    const oldParent = await this.lookupParent(source);
    const newParent = await this.lookupParent(target);
    const response = await this.client.request("rename", {
      old_parent_ino: oldParent.parent.ino,
      old_name: oldParent.name,
      new_parent_ino: newParent.parent.ino,
      new_name: newParent.name,
      flags: 0,
    });
    assertOk(response, "rename", oldPath);
    this.cache.delete(source);
  }

  truncateSync(_entryPath: string, _length: number) {
    // XXX: Sync RPC would deadlock the event loop; use async APIs or move RPC to a worker.
    throw createErrnoError(ERRNO.ENOSYS, "truncate");
  }

  async truncate(entryPath: string, length: number) {
    const entry = await this.ensureEntry(entryPath);
    const response = await this.client.request("truncate", { ino: entry.ino, size: length });
    assertOk(response, "truncate", entryPath);
  }

  private async lookupPath(entryPath: string): Promise<CachedEntry | null> {
    const normalized = normalizePath(entryPath);
    if (normalized === "/") {
      return this.cache.get("/") ?? null;
    }
    const cached = this.getCached(normalized);
    if (cached) {
      return cached.negative ? null : cached;
    }
    const segments = normalized.split("/").filter(Boolean);
    let currentPath = "";
    let parent = this.cache.get("/")!;
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : `/${segment}`;
      const cachedEntry = this.getCached(currentPath);
      if (cachedEntry) {
        if (cachedEntry.negative) {
          return null;
        }
        parent = cachedEntry;
        continue;
      }
      const response = await this.client.request("lookup", {
        parent_ino: parent.ino,
        name: segment,
      });
      if (response.p.err !== 0) {
        if (response.p.err === ERRNO.ENOENT) {
          const ttl = (response.p.res?.entry_ttl_ms as number) ?? 250;
          this.cache.set(currentPath, {
            ino: 0,
            attr: null,
            expiresAt: Date.now() + ttl,
            attrExpiresAt: 0,
            negative: true,
          });
          return null;
        }
        throw createErrnoError(response.p.err, "lookup", currentPath);
      }
      const entry = response.p.res?.entry as { ino: number; attr: RpcAttr; entry_ttl_ms?: number; attr_ttl_ms?: number };
      parent = this.cacheEntry(currentPath, entry);
    }
    return parent;
  }

  private async lookupParent(entryPath: string) {
    const parentPath = path.posix.dirname(entryPath);
    const name = path.posix.basename(entryPath);
    const parent = await this.ensureEntry(parentPath);
    return { parent, name };
  }

  private async ensureEntry(entryPath: string) {
    const entry = await this.lookupPath(entryPath);
    if (!entry) {
      throw createErrnoError(ERRNO.ENOENT, "stat", entryPath);
    }
    return entry;
  }

  private getCached(entryPath: string) {
    const entry = this.cache.get(entryPath);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.cache.delete(entryPath);
      return null;
    }
    return entry;
  }

  private cacheEntry(entryPath: string, entry: { ino: number; attr: RpcAttr; entry_ttl_ms?: number; attr_ttl_ms?: number }) {
    const now = Date.now();
    const entryTtl = entry.entry_ttl_ms ?? 1000;
    const attrTtl = entry.attr_ttl_ms ?? 1000;
    const cached: CachedEntry = {
      ino: entry.ino,
      attr: entry.attr,
      expiresAt: now + entryTtl,
      attrExpiresAt: now + attrTtl,
      negative: false,
    };
    this.cache.set(entryPath, cached);
    return cached;
  }

  private updateAttr(entryPath: string, attr: RpcAttr, ttlMs: number) {
    const now = Date.now();
    const cached = this.cache.get(entryPath);
    if (cached) {
      cached.attr = attr;
      cached.attrExpiresAt = now + ttlMs;
    }
  }

  private async mkdirRecursive(entryPath: string, mode?: number) {
    if (entryPath === "/") return;
    const parentPath = path.posix.dirname(entryPath);
    if (parentPath !== "/") {
      await this.mkdirRecursive(parentPath, mode);
    }
    const existing = await this.lookupPath(entryPath);
    if (existing) return;
    const { parent, name } = await this.lookupParent(entryPath);
    const response = await this.client.request("mkdir", {
      parent_ino: parent.ino,
      name,
      mode: mode ?? 0o755,
    });
    assertOk(response, "mkdir", entryPath);
    const entry = response.p.res?.entry as { ino: number; attr: RpcAttr; entry_ttl_ms?: number; attr_ttl_ms?: number };
    this.cacheEntry(entryPath, entry);
  }
}

type CachedEntry = {
  ino: number;
  attr: RpcAttr | null;
  expiresAt: number;
  attrExpiresAt: number;
  negative: boolean;
};

function statsFromAttr(attr: RpcAttr): Stats {
  const stats = Object.create(fs.Stats.prototype) as Stats;
  stats.dev = 0;
  stats.mode = attr.mode;
  stats.nlink = attr.nlink;
  stats.uid = attr.uid;
  stats.gid = attr.gid;
  stats.rdev = attr.rdev ?? 0;
  stats.blksize = attr.blksize ?? 4096;
  stats.ino = attr.ino;
  stats.size = attr.size;
  stats.blocks = attr.blocks ?? Math.ceil(attr.size / 512);
  stats.atimeMs = attr.atime_ms;
  stats.mtimeMs = attr.mtime_ms;
  stats.ctimeMs = attr.ctime_ms;
  stats.birthtimeMs = attr.ctime_ms;
  stats.atime = new Date(stats.atimeMs);
  stats.mtime = new Date(stats.mtimeMs);
  stats.ctime = new Date(stats.ctimeMs);
  stats.birthtime = new Date(stats.birthtimeMs);
  return stats;
}

function assertOk(message: FsResponseMessage, syscall: string, entryPath?: string) {
  if (message.p.err !== 0) {
    throw createErrnoError(message.p.err, syscall, entryPath);
  }
}

function parseOpenFlags(flags: string) {
  switch (flags) {
    case "r":
      return { numeric: fs.constants.O_RDONLY, create: false, truncate: false };
    case "r+":
      return { numeric: fs.constants.O_RDWR, create: false, truncate: false };
    case "w":
      return { numeric: fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_CREAT, create: true, truncate: true };
    case "w+":
      return { numeric: fs.constants.O_RDWR | fs.constants.O_TRUNC | fs.constants.O_CREAT, create: true, truncate: true };
    case "a":
      return { numeric: fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, create: true, truncate: false };
    case "a+":
      return { numeric: fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT, create: true, truncate: false };
    default:
      throw createErrnoError(ERRNO.EINVAL, "open");
  }
}

function normalizePath(entryPath: string) {
  const normalized = path.posix.normalize(entryPath);
  if (!normalized.startsWith("/")) {
    return "/" + normalized;
  }
  return normalized === "" ? "/" : normalized;
}

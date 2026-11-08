/**
 * Native VFS for the native engine (`native/DESIGN.md`, "Filesystem tiers"):
 *
 * - translates the VM's mounts into `configure.vfs` (`mode: "native"`):
 *   `RealFSProvider` → `host`, `ReadonlyProvider` → read-only layer,
 *   `ShadowProvider` with a `createShadowPathPredicate` predicate → hide layer,
 *   marked providers (`nativeMounts`, the MITM CA) → `memory`/`static`/`host`/
 *   `object`, everything else → `object` through an adapter onto the JS
 *   provider, which stays the source of truth;
 * - serves the daemon's object-tier calls (`vfs_call`), blocking `before`
 *   hooks (`vfs_hook`) and `after` notifications (`vfs_event`);
 * - provides the `vm.fs` view of the native mount table (`fs_call`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSystemErrorName } from "node:util";

import { createErrnoError } from "../vfs/errors.ts";
import { LINUX_ERRNO } from "../vfs/linux-errno.ts";
import { normalizeMountMap } from "../vfs/mounts.ts";
import {
  getNativeMountMark,
  getProviderInternals,
  kShadowPaths,
  markNativeMount,
} from "../vfs/native-marks.ts";
import {
  MemoryProvider,
  RealFSProvider,
  type VirtualFileHandle,
  type VirtualProvider,
} from "../vfs/node/index.ts";
import {
  createObjectMount,
  type ObjectMountOptions,
  type ObjectProvider,
} from "../vfs/object.ts";
import type { VfsHookContext, VfsHooks } from "../vfs/provider.ts";
import { ReadonlyProvider } from "../vfs/readonly.ts";
import {
  createShadowPathPredicate,
  ShadowProvider,
  type ShadowWriteMode,
} from "../vfs/shadow.ts";
import type { NativeTransport } from "./transport.ts";

/** Largest `/etc/gondolin/listeners` file in `bytes` */
const MAX_LISTENERS_FILE_BYTES = 64 * 1024;

/**
 * Guest transport of the tree: virtio-fs when the VMM supports it (`auto`),
 * or forced with `GONDOLIN_VIRTIOFS=0|1`.
 */
export function resolveVfsTransport(): "auto" | "sandboxfs" | "virtiofs" {
  const value = process.env.GONDOLIN_VIRTIOFS?.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "off") return "sandboxfs";
  if (value === "1" || value === "true" || value === "on") return "virtiofs";
  return "auto";
}

/** Hidden accessor of a `static` mount's current files */
const kStaticFiles = Symbol("staticFiles");

/**
 * Cache of `VirtualProvider` adapters: metadata for 1 s (what the guest
 * kernel caches anyway), contents revalidated on every open, so host-side
 * changes are seen.
 */
const ADAPTER_CACHE = { cacheTtlMs: 1000, revalidateOnOpen: true };

/** Files sent along with their stat for in-process memory providers in `bytes` */
const INLINE_SMALL_FILES = 64 * 1024;

/** Default budget of the daemon's object cache per mount in `bytes` */
const DEFAULT_OBJECT_CACHE_BYTES = 256 * 1024 * 1024;

/** What the VM hands to the native VFS */
export type NativeVfsSpec = {
  /** mounts of the sandboxfs tree, keyed by mount path */
  mounts: Record<string, VirtualProvider>;
  /** user hooks (`VMOptions.vfs.hooks`) */
  hooks?: VfsHooks;
  /** guest mount point of the sandboxfs tree */
  fuseMount: string;
  /** guest bind mounts out of the tree */
  fuseBinds: string[];
  /** the internal `/etc/gondolin` provider and its listeners file */
  gondolinEtc?: {
    provider: VirtualProvider;
    listeners: { notifyDirty(): void };
  };
};

/** Errno name of an error (`code` when it is an errno, else `EIO`) */
export function errnoCode(err: unknown): string {
  const e = err as { code?: unknown; errno?: unknown } | null;
  if (e && typeof e.code === "string") {
    if (e.code in LINUX_ERRNO || /^ERRNO_\d+$/.test(e.code)) return e.code;
    if (e.code === "ERR_METHOD_NOT_IMPLEMENTED") return "ENOSYS";
  }
  if (e && typeof e.errno === "number" && e.errno !== 0) {
    try {
      const name = getSystemErrorName(-Math.abs(e.errno));
      if (name in LINUX_ERRNO) return name;
    } catch {
      // unknown errno
    }
  }
  return "EIO";
}

/** Rethrows `err` with an errno name as `code` */
function wireError(err: unknown): Error {
  const code = errnoCode(err);
  const message = err instanceof Error ? err.message : String(err);
  const out = new Error(message) as Error & { code: string };
  out.code = code;
  return out;
}

function enosys(op: string, p: string) {
  return createErrnoError(os.constants.errno.ENOSYS, op, p);
}

type WireKind = "file" | "dir" | "symlink";

function int(value: unknown, fallback?: number): number | undefined {
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(value);
}

function statsKind(st: { isDirectory(): boolean; isSymbolicLink(): boolean }) {
  if (st.isDirectory()) return "dir" as const;
  if (st.isSymbolicLink()) return "symlink" as const;
  return "file" as const;
}

function wireStat(st: fs.Stats) {
  return {
    kind: statsKind(st),
    size: Math.max(0, int(st.size, 0)!),
    mode: (int(st.mode, 0)! & 0o7777) >>> 0,
    mtime_ms: int(st.mtimeMs),
    ctime_ms: int(st.ctimeMs),
    atime_ms: int(st.atimeMs),
    nlink: int(st.nlink),
    uid: int(st.uid) !== undefined && st.uid >= 0 ? int(st.uid) : undefined,
    gid: int(st.gid) !== undefined && st.gid >= 0 ? int(st.gid) : undefined,
  };
}

/** Server side of one object mount (`vfs_call` for a `mount_id`) */
abstract class ObjectHandler {
  /** `write_file` chunks not yet committed, by path */
  private readonly pending = new Map<string, Buffer[]>();
  /** paths changed by the guest */
  onChange?: (entryPath: string) => void;

  async call(p: any): Promise<Record<string, unknown>> {
    const op = String(p.op ?? "");
    const target = typeof p.path === "string" ? p.path : String(p.from ?? "");
    try {
      const result = await this.dispatch(op, p);
      if (this.onChange && MUTATING_OPS.has(op)) {
        this.onChange(target);
        if (typeof p.to === "string") this.onChange(p.to);
      }
      return result;
    } catch (err) {
      throw wireError(err);
    }
  }

  private async dispatch(op: string, p: any): Promise<Record<string, unknown>> {
    switch (op) {
      case "stat": {
        const stat = await this.stat(p.path);
        const max = int(p.inline_max);
        // small files travel with their stat (saves a round trip per open)
        if (max && stat.kind === "file" && Number(stat.size) <= max) {
          const data = await this.readFile(p.path, 0, Number(stat.size));
          if (data.length === Number(stat.size)) return { stat, data };
        }
        return { stat };
      }
      case "readdir":
        return { entries: await this.readdir(p.path) };
      case "read_file":
        return {
          data: await this.readFile(
            p.path,
            int(p.offset, 0)!,
            p.length === undefined ? undefined : int(p.length),
          ),
        };
      case "write_file": {
        const data = Buffer.from(p.data ?? []);
        const offset = int(p.offset, 0)!;
        const last = p.last !== false;
        if (offset === 0 && last) {
          this.pending.delete(p.path);
          await this.writeFile(p.path, data, int(p.mode));
          return {};
        }
        const chunks = offset === 0 ? [] : (this.pending.get(p.path) ?? []);
        chunks.push(data);
        if (!last) {
          this.pending.set(p.path, chunks);
          return {};
        }
        this.pending.delete(p.path);
        await this.writeFile(p.path, Buffer.concat(chunks), int(p.mode));
        return {};
      }
      case "write":
        await this.write(p.path, int(p.offset, 0)!, Buffer.from(p.data ?? []));
        return {};
      case "truncate":
        await this.truncate(p.path, int(p.size, 0)!);
        return {};
      case "unlink":
        await this.unlink(p.path);
        return {};
      case "rename":
        await this.rename(p.from, p.to);
        return {};
      case "mkdir":
        await this.mkdir(p.path, int(p.mode));
        return {};
      case "rmdir":
        await this.rmdir(p.path);
        return {};
      case "chmod":
        await this.chmod(p.path, int(p.mode, 0)!);
        return {};
      case "symlink":
        await this.symlink(p.target, p.path);
        return {};
      case "readlink":
        return { target: await this.readlink(p.path) };
      case "link":
        await this.link(p.from, p.to);
        return {};
      default:
        throw enosys(op, String(p.path ?? ""));
    }
  }

  abstract stat(p: string): Promise<Record<string, unknown>>;
  abstract readdir(p: string): Promise<Array<{ name: string; kind: WireKind }>>;
  abstract readFile(
    p: string,
    offset: number,
    length?: number,
  ): Promise<Buffer>;
  abstract writeFile(p: string, data: Buffer, mode?: number): Promise<void>;
  abstract write(p: string, offset: number, data: Buffer): Promise<void>;
  abstract truncate(p: string, size: number): Promise<void>;
  abstract unlink(p: string): Promise<void>;
  abstract rename(from: string, to: string): Promise<void>;
  abstract mkdir(p: string, mode?: number): Promise<void>;
  abstract rmdir(p: string): Promise<void>;
  abstract chmod(p: string, mode: number): Promise<void>;
  abstract symlink(target: string, p: string): Promise<void>;
  abstract readlink(p: string): Promise<string>;
  abstract link(from: string, to: string): Promise<void>;
}

const MUTATING_OPS = new Set([
  "write_file",
  "write",
  "truncate",
  "unlink",
  "rename",
  "mkdir",
  "rmdir",
  "chmod",
  "symlink",
  "link",
]);

/** Whole-file operations mapped onto a JS `VirtualProvider` */
class VirtualObjectHandler extends ObjectHandler {
  private readonly provider: VirtualProvider;

  constructor(provider: VirtualProvider) {
    super();
    this.provider = provider;
  }

  async stat(p: string) {
    return wireStat(await this.provider.lstat(p));
  }

  async readdir(p: string) {
    const entries = (await this.provider.readdir(p, {
      withFileTypes: true,
    })) as Array<string | fs.Dirent>;
    const out: Array<{ name: string; kind: WireKind }> = [];
    for (const entry of entries) {
      if (typeof entry === "string") {
        let kind: WireKind = "file";
        try {
          kind = statsKind(
            await this.provider.lstat(path.posix.join(p, entry)),
          );
        } catch {
          // keep "file"
        }
        out.push({ name: entry, kind });
      } else {
        out.push({ name: entry.name, kind: statsKind(entry) });
      }
    }
    return out;
  }

  async readFile(p: string, offset: number, length?: number) {
    const handle = await this.provider.open(p, "r");
    try {
      const want =
        length ?? Math.max(0, Number((await handle.stat()).size) - offset);
      const buffer = Buffer.alloc(want);
      let total = 0;
      while (total < want) {
        const { bytesRead } = await handle.read(
          buffer,
          total,
          want - total,
          offset + total,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      return buffer.subarray(0, total);
    } finally {
      await handle.close();
    }
  }

  private async writeAll(handle: VirtualFileHandle, data: Buffer, at: number) {
    let done = 0;
    while (done < data.length) {
      const { bytesWritten } = await handle.write(
        data,
        done,
        data.length - done,
        at + done,
      );
      if (bytesWritten <= 0) throw new Error("short write");
      done += bytesWritten;
    }
  }

  async writeFile(p: string, data: Buffer, mode?: number) {
    const handle = await this.provider.open(p, "w", mode);
    try {
      await this.writeAll(handle, data, 0);
    } finally {
      await handle.close();
    }
  }

  async write(p: string, offset: number, data: Buffer) {
    const handle = await this.provider.open(p, "r+");
    try {
      await this.writeAll(handle, data, offset);
    } finally {
      await handle.close();
    }
  }

  async truncate(p: string, size: number) {
    const provider = this.provider as {
      truncate?: (p: string, size: number) => Promise<void>;
    };
    if (typeof provider.truncate === "function") {
      await provider.truncate(p, size);
      return;
    }
    const handle = await this.provider.open(p, "r+");
    try {
      await handle.truncate(size);
    } finally {
      await handle.close();
    }
  }

  async unlink(p: string) {
    await this.provider.unlink(p);
  }

  async rename(from: string, to: string) {
    await this.provider.rename(from, to);
  }

  async mkdir(p: string, mode?: number) {
    await this.provider.mkdir(p, mode === undefined ? undefined : { mode });
  }

  async rmdir(p: string) {
    await this.provider.rmdir(p);
  }

  async chmod(p: string, mode: number) {
    if (!this.provider.chmod) throw enosys("chmod", p);
    await this.provider.chmod(p, mode);
  }

  async symlink(target: string, p: string) {
    if (!this.provider.symlink) throw enosys("symlink", p);
    await this.provider.symlink(target, p);
  }

  async readlink(p: string) {
    if (!this.provider.readlink) throw enosys("readlink", p);
    return String(await this.provider.readlink(p));
  }

  async link(from: string, to: string) {
    if (!this.provider.link) throw enosys("link", from);
    await this.provider.link(from, to);
  }
}

/** Whole-file operations of a user {@link ObjectProvider} */
class ObjectProviderHandler extends ObjectHandler {
  private readonly provider: ObjectProvider;

  constructor(provider: ObjectProvider) {
    super();
    this.provider = provider;
  }

  private method<K extends keyof ObjectProvider>(name: K, p: string) {
    const fn = this.provider[name];
    if (typeof fn !== "function") throw enosys(String(name), p);
    return (fn as (...args: unknown[]) => unknown).bind(
      this.provider,
    ) as NonNullable<ObjectProvider[K]>;
  }

  async stat(p: string) {
    const st = await this.provider.stat(p);
    return {
      kind: st.kind,
      size: Math.max(0, int(st.size, 0)!),
      mode: st.mode === undefined ? undefined : st.mode & 0o7777,
      mtime_ms: int(st.mtimeMs),
      ctime_ms: int(st.ctimeMs),
      atime_ms: int(st.atimeMs),
      nlink: int(st.nlink),
      uid: int(st.uid),
      gid: int(st.gid),
    };
  }

  async readdir(p: string) {
    return (await this.provider.readDir(p)).map((e) => ({
      name: e.name,
      kind: e.kind,
    }));
  }

  async readFile(p: string, offset: number, length?: number) {
    const raw = await this.method("readFile", p)(p, { offset, length });
    // a view, not a copy (large reads arrive in 1–3 MiB ranges)
    const data = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    // providers may ignore the range and return the whole file (the daemon
    // always asks for a bounded range)
    if (length !== undefined && data.length > length) {
      return data.subarray(offset, offset + length);
    }
    return data;
  }

  async writeFile(p: string, data: Buffer, mode?: number) {
    await this.method("writeFile", p)(p, new Uint8Array(data), { mode });
  }

  async write(p: string, offset: number, data: Buffer) {
    if (typeof this.provider.write === "function") {
      await this.provider.write(p, offset, new Uint8Array(data));
      return;
    }
    const current = Buffer.from(await this.method("readFile", p)(p));
    const next = Buffer.alloc(Math.max(current.length, offset + data.length));
    current.copy(next);
    data.copy(next, offset);
    await this.writeFile(p, next);
  }

  async truncate(p: string, size: number) {
    if (typeof this.provider.truncate === "function") {
      await this.provider.truncate(p, size);
      return;
    }
    const current = Buffer.from(await this.method("readFile", p)(p));
    const next = Buffer.alloc(size);
    current.copy(next, 0, 0, Math.min(size, current.length));
    await this.writeFile(p, next);
  }

  async unlink(p: string) {
    await this.method("unlink", p)(p);
  }
  async rename(from: string, to: string) {
    await this.method("rename", from)(from, to);
  }
  async mkdir(p: string, mode?: number) {
    await this.method("mkdir", p)(p, { mode });
  }
  async rmdir(p: string) {
    await this.method("rmdir", p)(p);
  }
  async chmod(p: string, mode: number) {
    await this.method("chmod", p)(p, mode);
  }
  async symlink(target: string, p: string) {
    await this.method("symlink", p)(target, p);
  }
  async readlink(p: string) {
    return this.method("readlink", p)(p);
  }
  async link(from: string, to: string) {
    await this.method("link", from)(from, to);
  }
}

type MountSource = Record<string, unknown> & { kind: string };
type Layer = Record<string, unknown> & { kind: string };

/** A translatable provider: its native source plus wrapper layers */
type Translation = { source: MountSource; layers: Layer[] };

function errnoName(errno: number): string | undefined {
  try {
    const name = getSystemErrorName(-Math.abs(errno));
    return name in LINUX_ERRNO ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Options for {@link NativeVfs} */
export type NativeVfsOptions = {
  /** the daemon runs on another machine (no controller-local host paths) */
  remote?: boolean;
};

/**
 * The native VFS of one VM: `configure.vfs` plus the controller side of the
 * object tier and hooks.
 */
export class NativeVfs {
  /** mounts whose root is a daemon-side path named explicitly by the user */
  readonly daemonPaths: string[] = [];
  private readonly spec: NativeVfsSpec;
  private readonly remote: boolean;
  private readonly objects = new Map<number, ObjectHandler>();
  private readonly mounts: Array<Record<string, unknown>> = [];
  /** mount paths whose contents only the daemon has (or caches) */
  private readonly daemonMounts = new Set<string>();
  private nextMountId = 1;

  constructor(spec: NativeVfsSpec, options: NativeVfsOptions = {}) {
    this.spec = spec;
    this.remote = options.remote ?? false;
    const normalized =
      Object.keys(spec.mounts).length === 0
        ? new Map<string, VirtualProvider>([
            ["/", markNativeMount(new MemoryProvider(), { kind: "memory" })],
          ])
        : normalizeMountMap(spec.mounts);
    for (const [mountPath, provider] of normalized) {
      const mount = { path: mountPath, ...this.translateMount(provider) };
      this.mounts.push(mount);
      if (this.isDaemonOwned(provider)) this.daemonMounts.add(mountPath);
    }
  }

  /**
   * Whether the daemon is the only (or caching) holder of a mount's contents:
   * native memory, daemon-side host paths of a remote daemon, and object
   * providers with a daemon cache. Everything else can be read and written
   * through the JS provider directly.
   */
  private isDaemonOwned(provider: unknown): boolean {
    const mark = getNativeMountMark(provider);
    if (mark) {
      return (
        mark.kind === "memory" ||
        mark.kind === "object" ||
        (mark.kind === "host" && this.remote)
      );
    }
    const internals = getProviderInternals(provider);
    if (internals?.kind === "readonly" || internals?.kind === "shadow") {
      return this.isDaemonOwned(internals.backend);
    }
    if (
      provider instanceof
      (RealFSProvider as unknown as new (
        ...args: never[]
      ) => unknown)
    ) {
      return this.remote;
    }
    return false;
  }

  /** Whether `vm.fs` must use the daemon (`fs_call`) for a tree path */
  servedByDaemon(entryPath: string): boolean {
    const p = path.posix.normalize(entryPath);
    let best: string | null = null;
    for (const m of this.mounts) {
      const mp = m.path as string;
      const under = mp === "/" || p === mp || p.startsWith(`${mp}/`);
      if (under && (best === null || mp.length > best.length)) best = mp;
    }
    return best !== null && this.daemonMounts.has(best);
  }

  /** `configure.vfs` */
  get config(): Record<string, unknown> {
    return {
      mode: "native",
      fuse_mount: this.spec.fuseMount,
      binds: this.spec.fuseBinds,
      mounts: this.mounts.map((m) => {
        const files = (m as Record<symbol, unknown>)[kStaticFiles];
        return typeof files === "function" ? { ...m, files: files() } : m;
      }),
      hooks: {
        before: typeof this.spec.hooks?.before === "function",
        events: typeof this.spec.hooks?.after === "function",
      },
      transport: resolveVfsTransport(),
    };
  }

  /** Object mount ids in use */
  get objectMountIds(): number[] {
    return Array.from(this.objects.keys());
  }

  private translateMount(provider: VirtualProvider): Record<string, unknown> {
    if (provider === this.spec.gondolinEtc?.provider) {
      const listeners = this.spec.gondolinEtc.listeners;
      return this.objectMount(new VirtualObjectHandler(provider), {
        writable: true,
        commit: "write",
        ...ADAPTER_CACHE,
        maxFileBytes: MAX_LISTENERS_FILE_BYTES,
        onChange: (p) => {
          if (p === "/listeners") listeners.notifyDirty();
        },
      });
    }
    const mark = getNativeMountMark(provider);
    if (mark?.kind === "object") {
      const options = mark.options as ObjectMountOptions;
      const objectProvider = mark.provider as ObjectProvider;
      return this.objectMount(new ObjectProviderHandler(objectProvider), {
        ...options,
        writable:
          options.writable ?? typeof objectProvider.writeFile === "function",
      });
    }
    const translated = this.translate(provider);
    if (translated) {
      return { ...translated.source, layers: translated.layers };
    }
    // the JS provider stays the source of truth; every write goes through
    return this.objectMount(new VirtualObjectHandler(provider), {
      writable: !provider.readonly,
      commit: "write",
      ...ADAPTER_CACHE,
      // in-process memory files are cheap to send along with their stat
      inlineMaxBytes:
        provider instanceof (MemoryProvider as unknown as new () => unknown)
          ? INLINE_SMALL_FILES
          : 0,
    });
  }

  private objectMount(
    handler: ObjectHandler,
    options: ObjectMountOptions & { onChange?: (p: string) => void },
  ): Record<string, unknown> {
    const mountId = this.nextMountId++;
    handler.onChange = options.onChange;
    this.objects.set(mountId, handler);
    return {
      kind: "object",
      mount_id: mountId,
      writable: options.writable ?? true,
      enumeration: options.enumeration ?? "list",
      commit: options.commit ?? "close",
      cache: {
        ttl_ms: Math.max(0, Math.round(options.cacheTtlMs ?? 1000)),
        max_bytes: Math.max(
          0,
          Math.round(options.maxCacheBytes ?? DEFAULT_OBJECT_CACHE_BYTES),
        ),
        revalidate_open: options.revalidateOnOpen ?? false,
        inline_max_bytes: Math.max(0, Math.round(options.inlineMaxBytes ?? 0)),
      },
      max_file_bytes:
        options.maxFileBytes === undefined
          ? undefined
          : Math.max(0, Math.round(options.maxFileBytes)),
      layers: [],
    };
  }

  /** Native source and layers of a provider, or `null` for the object tier */
  private translate(provider: unknown): Translation | null {
    const mark = getNativeMountMark(provider);
    if (mark) {
      switch (mark.kind) {
        case "memory":
          return { source: { kind: "memory" }, layers: [] };
        case "static":
          // contents are read when `configure` is built (the MITM CA can be
          // replaced by the daemon's before that)
          return {
            source: {
              kind: "static",
              [kStaticFiles]: () => ({ ...mark.files }),
            },
            layers: [],
          };
        case "host":
          this.daemonPaths.push(mark.root);
          return { source: { kind: "host", root: mark.root }, layers: [] };
        default:
          return null;
      }
    }
    const internals = getProviderInternals(provider);
    if (internals?.kind === "readonly") {
      const inner = this.translate(internals.backend);
      if (!inner) return null;
      inner.layers.push({ kind: "readonly" });
      return inner;
    }
    if (internals?.kind === "shadow") {
      const paths = (internals.shouldShadow as Record<symbol, unknown>)?.[
        kShadowPaths
      ];
      if (!Array.isArray(paths) || internals.customTmpfs) return null;
      const inner = this.translate(internals.backend);
      if (!inner) return null;
      inner.layers.push({
        kind: "hide",
        paths,
        write_mode: internals.writeMode,
        deny_write_errno: errnoName(internals.denyWriteErrno),
        deny_symlink_bypass: internals.denySymlinkBypass,
      });
      return inner;
    }
    if (internals) return null;
    if (
      provider instanceof
      (RealFSProvider as unknown as new (
        ...args: never[]
      ) => unknown)
    ) {
      if (this.remote) return null;
      return {
        source: {
          kind: "host",
          root: (provider as { rootPath: string }).rootPath,
        },
        layers: [],
      };
    }
    return null;
  }

  /** Register the daemon→controller handlers */
  install(transport: NativeTransport, onError?: (err: Error) => void) {
    transport.handleRequest("vfs_call", async (p) => {
      const handler = this.objects.get(Number(p.mount_id));
      if (!handler) {
        throw Object.assign(new Error(`unknown object mount ${p.mount_id}`), {
          code: "ENOENT",
        });
      }
      return handler.call(p);
    });
    const hooks = this.spec.hooks;
    if (hooks?.before) {
      const before = hooks.before;
      transport.handleRequest("vfs_hook", async (p) => {
        try {
          await before(hookContext(p));
        } catch (err) {
          throw wireError(err);
        }
        return {};
      });
    }
    if (hooks?.after) {
      const after = hooks.after;
      transport.onMessage("vfs_event", (p) => {
        const ctx = hookContext(p);
        if (typeof p.error === "string") {
          ctx.result = createErrnoError(
            os.constants.errno[p.error as keyof typeof os.constants.errno] ??
              os.constants.errno.EIO,
            ctx.op,
            ctx.path,
          );
        } else if (typeof p.bytes === "number") {
          ctx.result = p.bytes;
        }
        try {
          const r = after(ctx);
          if (r && typeof (r as Promise<void>).catch === "function") {
            (r as Promise<void>).catch((err) =>
              onError?.(err instanceof Error ? err : new Error(String(err))),
            );
          }
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      });
    }
  }
}

function hookContext(p: any): VfsHookContext {
  const ctx: VfsHookContext = { op: String(p.op ?? "") };
  if (typeof p.path === "string") ctx.path = p.path;
  if (typeof p.old_path === "string") ctx.oldPath = p.old_path;
  if (typeof p.new_path === "string") ctx.newPath = p.new_path;
  if (typeof p.flags === "string") ctx.flags = p.flags;
  if (p.mode !== undefined) ctx.mode = int(p.mode);
  if (p.offset !== undefined) ctx.offset = int(p.offset);
  if (p.length !== undefined) ctx.length = int(p.length);
  if (p.size !== undefined) ctx.size = int(p.size);
  return ctx;
}

/** Native mount descriptors (see `native/DESIGN.md`, "Filesystem tiers") */
export type NativeHostMountOptions = {
  /** reject writes */
  readonly?: boolean;
  /** paths hidden from the guest (`ShadowProvider` semantics) */
  hide?: string[];
  /** writes to hidden paths: denied (default) or kept in memory */
  hideWriteMode?: ShadowWriteMode;
};

export const nativeMounts = {
  /**
   * A memory filesystem kept in the daemon (reach it with `vm.fs`; the
   * returned provider is only a stand-in carrying the mount mark).
   */
  memory(): VirtualProvider {
    return markNativeMount(new MemoryProvider(), { kind: "memory" });
  },

  /**
   * A directory on the daemon's machine (for remote daemons: a path there),
   * hardened like `RealFSProvider`.
   */
  host(root: string, options: NativeHostMountOptions = {}): VirtualProvider {
    let provider: VirtualProvider = markNativeMount(
      new RealFSProvider(root) as unknown as VirtualProvider,
      { kind: "host", root },
    );
    if (options.hide && options.hide.length > 0) {
      provider = new ShadowProvider(provider, {
        shouldShadow: createShadowPathPredicate(options.hide),
        writeMode: options.hideWriteMode ?? "deny",
      }) as VirtualProvider;
    }
    if (options.readonly) {
      provider = new ReadonlyProvider(provider) as VirtualProvider;
    }
    return provider;
  },

  /** A whole-file provider served through the daemon's object cache */
  object(provider: ObjectProvider, options: ObjectMountOptions = {}) {
    return createObjectMount(provider, options);
  },
};

/** Error of an `fs_call`, shaped like a node errno error */
function fsCallError(err: unknown, op: string, p: string): Error {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && code in os.constants.errno) {
    return createErrnoError(
      os.constants.errno[code as keyof typeof os.constants.errno],
      op,
      p,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

class NativeFsDirent {
  readonly name: string;
  private readonly kind: WireKind;

  constructor(name: string, kind: WireKind) {
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
}

function toStats(st: Record<string, any>): fs.Stats {
  const stats = Object.create(fs.Stats.prototype) as fs.Stats;
  const n = (v: unknown) => Number(v ?? 0);
  Object.assign(stats, {
    dev: 0,
    ino: 0,
    mode: n(st.mode),
    nlink: n(st.nlink),
    uid: n(st.uid),
    gid: n(st.gid),
    rdev: 0,
    size: n(st.size),
    blksize: 4096,
    blocks: Math.ceil(n(st.size) / 512),
    atimeMs: n(st.atime_ms),
    mtimeMs: n(st.mtime_ms),
    ctimeMs: n(st.ctime_ms),
    birthtimeMs: n(st.ctime_ms),
    atime: new Date(n(st.atime_ms)),
    mtime: new Date(n(st.mtime_ms)),
    ctime: new Date(n(st.ctime_ms)),
    birthtime: new Date(n(st.ctime_ms)),
  });
  return stats;
}

/** Largest `fs_call` read in `bytes` (frames are limited to 4 MiB) */
const FS_CALL_READ_MAX = 1024 * 1024;

/**
 * The subset of `VirtualProvider` that `vm.fs` uses, served by the daemon's
 * mount table (`fs_call`). Every operation first makes sure the VM runs.
 */
export class NativeFsClient {
  private readonly call: (p: Record<string, unknown>) => Promise<any>;
  private readonly ready: () => Promise<void>;

  constructor(
    call: (p: Record<string, unknown>) => Promise<any>,
    ready: () => Promise<void>,
  ) {
    this.call = call;
    this.ready = ready;
  }

  /**
   * `vm.fs` provider for a VM: paths of daemon-owned mounts go through
   * `fs_call`, everything else through the JS providers (no VM start needed,
   * VFS hooks run in-process).
   */
  static forVm(
    vfs: NativeVfs,
    local: VirtualProvider,
    call: (p: Record<string, unknown>) => Promise<any>,
    ready: () => Promise<void>,
  ): VirtualProvider {
    const remote = new NativeFsClient(call, ready);
    const pick = (p: string): any => (vfs.servedByDaemon(p) ? remote : local);
    return {
      access: (p: string, mode?: number) => pick(p).access(p, mode),
      mkdir: (p: string, options?: object) => pick(p).mkdir(p, options),
      readdir: (p: string, options?: object) => pick(p).readdir(p, options),
      stat: (p: string) => pick(p).stat(p),
      lstat: (p: string) => pick(p).lstat(p),
      rename: (a: string, b: string) =>
        vfs.servedByDaemon(a) || vfs.servedByDaemon(b)
          ? remote.rename(a, b)
          : local.rename(a, b),
      unlink: (p: string) => pick(p).unlink(p),
      rmdir: (p: string) => pick(p).rmdir(p),
      chmod: (p: string, mode: number) => pick(p).chmod(p, mode),
      open: (p: string, flags: string, mode?: number) =>
        pick(p).open(p, flags, mode),
      close: () => (local as { close?: () => unknown }).close?.(),
    } as unknown as VirtualProvider;
  }

  private async run(op: string, p: string, payload: Record<string, unknown>) {
    await this.ready();
    try {
      return await this.call({ op, ...payload });
    } catch (err) {
      throw fsCallError(err, op, p);
    }
  }

  async access(p: string, mode?: number) {
    await this.run("access", p, { path: p, mask: mode ?? 0 });
  }

  async mkdir(p: string, options?: { recursive?: boolean; mode?: number }) {
    await this.run("mkdir", p, {
      path: p,
      mode: options?.mode,
      recursive: options?.recursive ?? false,
    });
  }

  async readdir(p: string, options?: { withFileTypes?: boolean }) {
    const r = await this.run("readdir", p, { path: p });
    const entries = (r.entries ?? []) as Array<{
      name: string;
      kind: WireKind;
    }>;
    if (options?.withFileTypes) {
      return entries.map((e) => new NativeFsDirent(e.name, e.kind));
    }
    return entries.map((e) => e.name);
  }

  async stat(p: string) {
    return toStats((await this.run("stat", p, { path: p, follow: true })).stat);
  }

  async lstat(p: string) {
    return toStats(
      (await this.run("stat", p, { path: p, follow: false })).stat,
    );
  }

  async rename(from: string, to: string) {
    await this.run("rename", from, { from, to });
  }

  async unlink(p: string) {
    await this.run("unlink", p, { path: p });
  }

  async rmdir(p: string) {
    await this.run("rmdir", p, { path: p });
  }

  async chmod(p: string, mode: number) {
    await this.run("chmod", p, { path: p, mode });
  }

  async open(p: string, flags = "r", mode?: number) {
    const r = await this.run("open", p, { path: p, flags, mode });
    const fh = Number(r.fh);
    const client = this;
    let closed = false;
    return {
      async read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null = null,
      ) {
        let total = 0;
        const start = position ?? 0;
        while (total < length) {
          const want = Math.min(FS_CALL_READ_MAX, length - total);
          const res = await client.run("read", p, {
            fh,
            offset: start + total,
            length: want,
          });
          const data = Buffer.from(res.data ?? []);
          data.copy(buffer, offset + total);
          total += data.length;
          if (data.length < want) break;
        }
        return { bytesRead: total, buffer };
      },
      async write(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null = null,
      ) {
        let total = 0;
        const start = position ?? 0;
        while (total < length) {
          const n = Math.min(FS_CALL_READ_MAX, length - total);
          await client.run("write", p, {
            fh,
            offset: start + total,
            data: buffer.subarray(offset + total, offset + total + n),
          });
          total += n;
        }
        return { bytesWritten: total, buffer };
      },
      async close() {
        if (closed) return;
        closed = true;
        await client.run("close", p, { fh });
      },
    };
  }

  async close() {
    // the daemon owns the mounts
  }
}

import path from "node:path";

import type {
  ObjectDirEntry,
  ObjectProvider,
  ObjectStat,
} from "../../src/vfs/object.ts";

type Entry = {
  kind: "file" | "dir";
  data: Uint8Array;
  mode: number;
  mtimeMs: number;
  /** child names of a directory */
  children: Set<string>;
};

function errno(code: string, p: string): Error {
  return Object.assign(new Error(`${code}: ${p}`), { code });
}

/**
 * In-memory whole-file `ObjectProvider` (a stand-in for an object store) used
 * by the vfs suite's `object-mount` kind.
 */
export class MapObjectProvider implements ObjectProvider {
  private readonly entries = new Map<string, Entry>([
    ["/", this.make("dir", 0o755)],
  ]);

  private make(kind: Entry["kind"], mode: number): Entry {
    return {
      kind,
      data: new Uint8Array(0),
      mode,
      mtimeMs: Date.now(),
      children: new Set(),
    };
  }

  private get(p: string): Entry {
    const entry = this.entries.get(p);
    if (!entry) throw errno("ENOENT", p);
    return entry;
  }

  private parent(p: string): Entry {
    const parent = this.get(path.posix.dirname(p));
    if (parent.kind !== "dir") throw errno("ENOTDIR", p);
    return parent;
  }

  async stat(p: string): Promise<ObjectStat> {
    const e = this.get(p);
    return {
      kind: e.kind,
      size: e.data.length,
      mode: e.mode,
      mtimeMs: e.mtimeMs,
    };
  }

  async readDir(p: string): Promise<ObjectDirEntry[]> {
    const e = this.get(p);
    if (e.kind !== "dir") throw errno("ENOTDIR", p);
    return [...e.children].map((name) => ({
      name,
      kind: this.get(path.posix.join(p, name)).kind,
    }));
  }

  async readFile(
    p: string,
    range?: { offset: number; length?: number },
  ): Promise<Uint8Array> {
    const e = this.get(p);
    if (e.kind !== "file") throw errno("EISDIR", p);
    if (!range) return e.data;
    const end =
      range.length === undefined ? undefined : range.offset + range.length;
    return e.data.subarray(range.offset, end);
  }

  async writeFile(
    p: string,
    data: Uint8Array,
    options?: { mode?: number },
  ): Promise<void> {
    const existing = this.entries.get(p);
    if (existing?.kind === "dir") throw errno("EISDIR", p);
    const entry = existing ?? this.make("file", options?.mode ?? 0o644);
    entry.data = new Uint8Array(data);
    entry.mtimeMs = Date.now();
    if (!existing) {
      this.parent(p).children.add(path.posix.basename(p));
      this.entries.set(p, entry);
    }
  }

  async truncate(p: string, size: number): Promise<void> {
    const e = this.get(p);
    const data = new Uint8Array(size);
    data.set(e.data.subarray(0, size));
    e.data = data;
    e.mtimeMs = Date.now();
  }

  async mkdir(p: string, options?: { mode?: number }): Promise<void> {
    if (this.entries.has(p)) throw errno("EEXIST", p);
    this.parent(p).children.add(path.posix.basename(p));
    this.entries.set(p, this.make("dir", options?.mode ?? 0o755));
  }

  async unlink(p: string): Promise<void> {
    if (this.get(p).kind === "dir") throw errno("EISDIR", p);
    this.parent(p).children.delete(path.posix.basename(p));
    this.entries.delete(p);
  }

  async rmdir(p: string): Promise<void> {
    const e = this.get(p);
    if (e.kind !== "dir") throw errno("ENOTDIR", p);
    if (e.children.size > 0) throw errno("ENOTEMPTY", p);
    this.parent(p).children.delete(path.posix.basename(p));
    this.entries.delete(p);
  }

  async rename(from: string, to: string): Promise<void> {
    this.get(from);
    const target = this.entries.get(to);
    if (target?.kind === "dir" && target.children.size > 0) {
      throw errno("ENOTEMPTY", to);
    }
    this.parent(from).children.delete(path.posix.basename(from));
    this.parent(to).children.add(path.posix.basename(to));
    for (const key of [...this.entries.keys()]) {
      if (key === from || key.startsWith(`${from}/`)) {
        this.entries.set(to + key.slice(from.length), this.entries.get(key)!);
        this.entries.delete(key);
      }
    }
  }

  async chmod(p: string, mode: number): Promise<void> {
    this.get(p).mode = mode & 0o7777;
  }
}

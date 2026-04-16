import fs from "fs";
import path from "path";
import { Writable } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";

import { hasSymlinkComponent } from "./rootfs.ts";
import type { TarEntry } from "./types.ts";

const TAR_TYPE_FILE = 0x30;
const TAR_TYPE_DIRECTORY = 0x35;
const TAR_TYPE_SYMLINK = 0x32;
const TAR_TYPE_HARDLINK = 0x31;
const TAR_TYPE_PAX_LOCAL = 0x78;
const TAR_TYPE_PAX_GLOBAL = 0x67;
const TAR_TYPE_GNU_LONGNAME = 0x4c;
const TAR_TYPE_GNU_LONGLINK = 0x4b;

type TarHeader = {
  /** resolved tar entry name from header/prefix */
  name: string;
  /** raw tar mode bits */
  mode: number;
  /** entry payload size in `bytes` */
  size: number;
  /** tar type flag byte */
  typeFlag: number;
  /** raw tar link target from header */
  linkName: string;
};

type TarMetadataState = {
  /** global PAX headers that apply to subsequent entries */
  globalPaxHeaders: Record<string, string>;
  /** one-shot PAX headers for the next non-meta entry */
  nextPaxHeaders: Record<string, string> | null;
  /** one-shot GNU long path for the next non-meta entry */
  nextLongName: string | null;
  /** one-shot GNU long link target for the next non-meta entry */
  nextLongLink: string | null;
};

type TarMetaEntryKind =
  | "pax-local"
  | "pax-global"
  | "gnu-longname"
  | "gnu-longlink";

type StreamingTarEntry =
  | {
      /** buffered metadata record kind */
      kind: "meta";
      /** metadata interpretation for the buffered payload */
      metaType: TarMetaEntryKind;
      /** content bytes left to read */
      remaining: number;
      /** tar padding bytes left to skip */
      padding: number;
      /** buffered metadata chunks */
      chunks: Buffer[];
    }
  | {
      /** regular file being streamed to disk */
      kind: "file";
      /** content bytes left to read */
      remaining: number;
      /** tar padding bytes left to skip */
      padding: number;
      /** open file descriptor for the destination file */
      fd: number | null;
      /** destination path for post-write chmod */
      targetPath: string | null;
      /** file mode bits from the tar header */
      mode: number;
    }
  | {
      /** skipped entry payload */
      kind: "skip";
      /** content bytes left to skip */
      remaining: number;
      /** tar padding bytes left to skip */
      padding: number;
    };

/** Parse a raw tar archive buffer into entries */
export function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  const metadata = createTarMetadataState();

  while (offset + 512 <= buf.length) {
    const header = parseTarHeader(buf.subarray(offset, offset + 512));
    if (!header) {
      break;
    }
    offset += 512;

    let content: Buffer | null = null;
    if (header.size > 0) {
      content = Buffer.from(buf.subarray(offset, offset + header.size));
      offset += header.size;
    }

    const padding = tarPaddingBytes(header.size);
    offset += padding;

    const metaType = tarMetaEntryKind(header.typeFlag);
    if (metaType) {
      applyTarMetaEntry(metaType, content, metadata);
      continue;
    }

    const entry = materializeTarEntry(header, metadata);
    if (entry.type === 0 && content === null) {
      entry.content = Buffer.alloc(0);
    } else {
      entry.content = content;
    }
    entries.push(entry);
    clearPendingTarEntryMetadata(metadata);
  }

  return entries;
}

function createTarMetadataState(): TarMetadataState {
  return {
    globalPaxHeaders: {},
    nextPaxHeaders: null,
    nextLongName: null,
    nextLongLink: null,
  };
}

function tarPaddingBytes(size: number): number {
  return (512 - (size % 512)) % 512;
}

function parseTarHeader(header: Buffer): TarHeader | null {
  if (header.length !== 512) {
    throw new Error(`invalid tar header length: ${header.length}`);
  }

  if (header.every((byte) => byte === 0)) {
    return null;
  }

  const name = readTarString(header, 0, 100);
  const mode = parseInt(readTarString(header, 100, 8), 8) || 0;
  const size = parseInt(readTarString(header, 124, 12), 8) || 0;
  const typeFlag = header[156];
  const headerLinkName = readTarString(header, 157, 100);

  const magic = readTarString(header, 257, 6);
  let fullName = name;
  if (magic === "ustar" || magic === "ustar\0") {
    const prefix = readTarString(header, 345, 155);
    if (prefix) {
      fullName = `${prefix}/${name}`;
    }
  }

  return {
    name: fullName,
    mode,
    size,
    typeFlag,
    linkName: headerLinkName,
  };
}

function materializeTarEntry(
  header: TarHeader,
  metadata: TarMetadataState,
): TarEntry {
  const effectivePaxHeaders = metadata.nextPaxHeaders
    ? { ...metadata.globalPaxHeaders, ...metadata.nextPaxHeaders }
    : metadata.globalPaxHeaders;

  const name = metadata.nextLongName ?? effectivePaxHeaders.path ?? header.name;
  const linkName =
    metadata.nextLongLink ?? effectivePaxHeaders.linkpath ?? header.linkName;

  const type =
    header.typeFlag === 0 || header.typeFlag === TAR_TYPE_FILE
      ? 0
      : header.typeFlag === TAR_TYPE_DIRECTORY
        ? 5
        : header.typeFlag === TAR_TYPE_SYMLINK
          ? 2
          : header.typeFlag === TAR_TYPE_HARDLINK
            ? 1
            : header.typeFlag;

  return {
    name,
    type,
    mode: header.mode,
    size: header.size,
    linkName,
    content: null,
  };
}

function clearPendingTarEntryMetadata(metadata: TarMetadataState): void {
  metadata.nextPaxHeaders = null;
  metadata.nextLongName = null;
  metadata.nextLongLink = null;
}

function tarMetaEntryKind(typeFlag: number): TarMetaEntryKind | null {
  if (typeFlag === TAR_TYPE_PAX_LOCAL) {
    return "pax-local";
  }
  if (typeFlag === TAR_TYPE_PAX_GLOBAL) {
    return "pax-global";
  }
  if (typeFlag === TAR_TYPE_GNU_LONGNAME) {
    return "gnu-longname";
  }
  if (typeFlag === TAR_TYPE_GNU_LONGLINK) {
    return "gnu-longlink";
  }
  return null;
}

function applyTarMetaEntry(
  metaType: TarMetaEntryKind,
  content: Buffer | null,
  metadata: TarMetadataState,
): void {
  if (metaType === "pax-global") {
    metadata.globalPaxHeaders = {
      ...metadata.globalPaxHeaders,
      ...parsePaxHeaders(content),
    };
    return;
  }

  if (metaType === "pax-local") {
    metadata.nextPaxHeaders = parsePaxHeaders(content);
    return;
  }

  if (metaType === "gnu-longname") {
    metadata.nextLongName = readLongTarString(content);
    return;
  }

  metadata.nextLongLink = readLongTarString(content);
}

function parsePaxHeaders(content: Buffer | null): Record<string, string> {
  if (!content || content.length === 0) {
    return {};
  }

  const out: Record<string, string> = {};
  let offset = 0;

  while (offset < content.length) {
    const spaceIdx = content.indexOf(0x20, offset);
    if (spaceIdx === -1) {
      break;
    }

    const lenStr = content.subarray(offset, spaceIdx).toString("utf8").trim();
    const recordLen = Number.parseInt(lenStr, 10);
    if (!Number.isFinite(recordLen) || recordLen <= 0) {
      break;
    }

    const recordEnd = offset + recordLen;
    if (recordEnd > content.length) {
      break;
    }

    const record = content.subarray(spaceIdx + 1, recordEnd).toString("utf8");
    const newline = record.endsWith("\n") ? record.slice(0, -1) : record;
    const eqIdx = newline.indexOf("=");
    if (eqIdx !== -1) {
      const key = newline.slice(0, eqIdx);
      const value = newline.slice(eqIdx + 1);
      if (key) {
        out[key] = value;
      }
    }

    offset = recordEnd;
  }

  return out;
}

function readLongTarString(content: Buffer | null): string {
  if (!content || content.length === 0) {
    return "";
  }

  let end = content.length;
  while (end > 0 && (content[end - 1] === 0 || content[end - 1] === 0x0a)) {
    end -= 1;
  }
  return content.subarray(0, end).toString("utf8");
}

function readTarString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nullIdx = slice.indexOf(0);
  const end = nullIdx === -1 ? length : nullIdx;
  return slice.subarray(0, end).toString("utf8");
}

/** Decompress a .tar.gz file and return the raw tar buffer */
export async function decompressTarGz(filePath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const input = fs.createReadStream(filePath);
  const gunzip = createGunzip();
  const collector = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, cb: () => void) {
      chunks.push(chunk);
      cb();
    },
  });
  await pipeline(input, gunzip, collector);
  return Buffer.concat(chunks);
}

/** Extract a .tar.gz file into a directory (safe against symlink traversal) */
export async function extractTarGz(
  tarGzPath: string,
  destDir: string,
): Promise<void> {
  const input = fs.createReadStream(tarGzPath);
  const gunzip = createGunzip();
  const extractor = new StreamingTarExtractor(destDir);
  await pipeline(input, gunzip, extractor);
}

/** Extract tar entries into a directory with symlink-safety checks */
export function extractEntries(entries: TarEntry[], destDir: string): void {
  const absRoot = path.resolve(destDir);

  for (const entry of entries) {
    extractPreparedTarEntry(entry, absRoot, destDir);
  }
}

function extractPreparedTarEntry(
  entry: TarEntry,
  absRoot: string,
  destDir: string,
): void {
  const target = resolveSafeTarTarget(absRoot, destDir, entry.name);
  if (!target) {
    return;
  }

  if (entry.type === 5) {
    prepareTarget(target, true);
    fs.mkdirSync(target, { recursive: true });
    return;
  }

  if (entry.type === 2) {
    prepareTarget(target, false);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.symlinkSync(entry.linkName, target);
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
    }
    return;
  }

  if (entry.type === 1) {
    const linkTarget = resolveSafeTarLinkTarget(absRoot, destDir, entry.linkName);
    if (!linkTarget || !fs.existsSync(linkTarget)) {
      return;
    }

    prepareTarget(target, false);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.linkSync(linkTarget, target);
    } catch {
      if (fs.existsSync(linkTarget)) {
        fs.copyFileSync(linkTarget, target);
      }
    }
    return;
  }

  if (entry.type === 0 && entry.content) {
    writeTarFile(target, entry.content, entry.mode);
  }
}

function resolveSafeTarTarget(
  absRoot: string,
  destDir: string,
  entryName: string,
): string | null {
  if (entryName.startsWith(".") && !entryName.startsWith("./")) {
    return null;
  }

  const target = path.resolve(destDir, entryName);
  if (!isPathInsideRoot(target, absRoot)) {
    return null;
  }

  if (hasSymlinkComponent(target, absRoot)) {
    process.stderr.write(`skipping symlinked path ${entryName}\n`);
    return null;
  }

  return target;
}

function resolveSafeTarLinkTarget(
  absRoot: string,
  destDir: string,
  linkName: string,
): string | null {
  const target = path.resolve(destDir, linkName);
  return isPathInsideRoot(target, absRoot) ? target : null;
}

function isPathInsideRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function writeTarFile(target: string, content: Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  prepareTarget(target, false);
  fs.writeFileSync(target, content);
  applyTarMode(target, mode);
}

function openTarFile(target: string): number {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  prepareTarget(target, false);
  return fs.openSync(target, "w");
}

function applyTarMode(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode & 0o7777);
  } catch {
    // chmod may fail on some platforms; ignore
  }
}

class StreamingTarExtractor extends Writable {
  private buffer = Buffer.alloc(0);
  private current: StreamingTarEntry | null = null;
  private readonly absRoot: string;
  private readonly destDir: string;
  private readonly metadata = createTarMetadataState();
  private ended = false;

  constructor(destDir: string) {
    super();
    this.destDir = destDir;
    this.absRoot = path.resolve(destDir);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      if (!this.ended) {
        this.buffer =
          this.buffer.length === 0
            ? Buffer.from(chunk)
            : Buffer.concat([this.buffer, chunk]);
        this.processBuffer();
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    try {
      this.processBuffer();
      if (!this.ended || this.current) {
        throw new Error("truncated tar archive");
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.closeCurrentFile();
    callback(error);
  }

  private processBuffer(): void {
    while (true) {
      if (this.current) {
        if (!this.processCurrentEntry()) {
          return;
        }
        continue;
      }

      if (this.ended) {
        this.buffer = Buffer.alloc(0);
        return;
      }

      if (this.buffer.length < 512) {
        return;
      }

      const header = parseTarHeader(this.consume(512));
      if (!header) {
        this.ended = true;
        this.buffer = Buffer.alloc(0);
        return;
      }

      this.startEntry(header);
    }
  }

  private processCurrentEntry(): boolean {
    const current = this.current;
    if (!current) {
      return true;
    }

    if (current.remaining > 0) {
      if (this.buffer.length === 0) {
        return false;
      }

      const take = Math.min(this.buffer.length, current.remaining);
      const chunk = this.consume(take);
      current.remaining -= take;

      if (current.kind === "meta") {
        current.chunks.push(Buffer.from(chunk));
      } else if (current.kind === "file" && current.fd !== null) {
        fs.writeSync(current.fd, chunk);
      }
    }

    if (current.remaining > 0) {
      return false;
    }

    if (current.padding > 0) {
      if (this.buffer.length === 0) {
        return false;
      }
      const skip = Math.min(this.buffer.length, current.padding);
      this.consume(skip);
      current.padding -= skip;
      if (current.padding > 0) {
        return false;
      }
    }

    this.finishCurrentEntry(current);
    this.current = null;
    return true;
  }

  private startEntry(header: TarHeader): void {
    const padding = tarPaddingBytes(header.size);
    const metaType = tarMetaEntryKind(header.typeFlag);
    if (metaType) {
      if (header.size === 0) {
        applyTarMetaEntry(metaType, null, this.metadata);
        return;
      }

      this.current = {
        kind: "meta",
        metaType,
        remaining: header.size,
        padding,
        chunks: [],
      };
      return;
    }

    const entry = materializeTarEntry(header, this.metadata);
    clearPendingTarEntryMetadata(this.metadata);

    if (entry.type === 5) {
      const target = resolveSafeTarTarget(this.absRoot, this.destDir, entry.name);
      if (target) {
        prepareTarget(target, true);
        fs.mkdirSync(target, { recursive: true });
      }
      if (header.size > 0 || padding > 0) {
        this.current = {
          kind: "skip",
          remaining: header.size,
          padding,
        };
      }
      return;
    }

    if (entry.type === 2) {
      const target = resolveSafeTarTarget(this.absRoot, this.destDir, entry.name);
      if (target) {
        prepareTarget(target, false);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try {
          fs.symlinkSync(entry.linkName, target);
        } catch (err: any) {
          if (err.code !== "EEXIST") {
            throw err;
          }
        }
      }
      if (header.size > 0 || padding > 0) {
        this.current = {
          kind: "skip",
          remaining: header.size,
          padding,
        };
      }
      return;
    }

    if (entry.type === 1) {
      const target = resolveSafeTarTarget(this.absRoot, this.destDir, entry.name);
      const linkTarget = resolveSafeTarLinkTarget(
        this.absRoot,
        this.destDir,
        entry.linkName,
      );
      if (target && linkTarget && fs.existsSync(linkTarget)) {
        prepareTarget(target, false);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try {
          fs.linkSync(linkTarget, target);
        } catch {
          if (fs.existsSync(linkTarget)) {
            fs.copyFileSync(linkTarget, target);
          }
        }
      }
      if (header.size > 0 || padding > 0) {
        this.current = {
          kind: "skip",
          remaining: header.size,
          padding,
        };
      }
      return;
    }

    if (entry.type !== 0) {
      this.current = {
        kind: "skip",
        remaining: header.size,
        padding,
      };
      return;
    }

    const target = resolveSafeTarTarget(this.absRoot, this.destDir, entry.name);
    if (header.size === 0) {
      if (target) {
        writeTarFile(target, Buffer.alloc(0), entry.mode);
      }
      if (padding > 0) {
        this.current = {
          kind: "skip",
          remaining: 0,
          padding,
        };
      }
      return;
    }

    if (!target) {
      this.current = {
        kind: "skip",
        remaining: header.size,
        padding,
      };
      return;
    }

    this.current = {
      kind: "file",
      remaining: header.size,
      padding,
      fd: openTarFile(target),
      targetPath: target,
      mode: entry.mode,
    };
  }

  private finishCurrentEntry(current: StreamingTarEntry): void {
    if (current.kind === "meta") {
      const content =
        current.chunks.length === 0 ? null : Buffer.concat(current.chunks);
      applyTarMetaEntry(current.metaType, content, this.metadata);
      return;
    }

    if (current.kind === "file") {
      this.closeCurrentFile(current);
    }
  }

  private closeCurrentFile(current = this.current): void {
    if (!current || current.kind !== "file" || current.fd === null) {
      return;
    }

    const fd = current.fd;
    current.fd = null;
    fs.closeSync(fd);
    if (current.targetPath) {
      applyTarMode(current.targetPath, current.mode);
    }
  }

  private consume(length: number): Buffer {
    const chunk = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return chunk;
  }
}

/** Prepare a target path for extraction: remove existing entries that conflict */
function prepareTarget(target: string, isDir: boolean): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }

  if (isDir && stat.isDirectory()) return;

  try {
    if (stat.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      fs.unlinkSync(target);
    }
  } catch {
    try {
      fs.chmodSync(target, 0o700);
    } catch {
      // ignore
    }
    try {
      if (stat.isDirectory()) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.unlinkSync(target);
      }
    } catch {
      // Last resort: ignore
    }
  }
}

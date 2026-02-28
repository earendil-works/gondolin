"use strict";

import type { Dirent, Stats } from "node:fs";
import { createRequire } from "node:module";

/** Filesystem-level statistics returned by the optional `statfs` provider method. */
export type VfsStatfs = {
  /** total data blocks in filesystem */
  blocks: number;
  /** free blocks in filesystem */
  bfree: number;
  /** free blocks available to unprivileged user */
  bavail: number;
  /** total file nodes (inodes) */
  files: number;
  /** free file nodes */
  ffree: number;
  /** filesystem block size in bytes */
  bsize: number;
  /** fragment size in bytes */
  frsize: number;
  /** maximum length of filenames */
  namelen: number;
};

export type VirtualFileHandle = {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ): Promise<{ bytesRead: number; buffer: Buffer }>;
  readSync(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ): number;
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ): Promise<{ bytesWritten: number; buffer: Buffer }>;
  writeSync(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ): number;
  readFile(
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<Buffer | string>;
  readFileSync(
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Buffer | string;
  writeFile(
    data: Buffer | string,
    options?: { encoding?: BufferEncoding },
  ): Promise<void>;
  writeFileSync(
    data: Buffer | string,
    options?: { encoding?: BufferEncoding },
  ): void;
  stat(options?: object): Promise<Stats>;
  statSync(options?: object): Stats;
  truncate(len?: number): Promise<void>;
  truncateSync(len?: number): void;
  close(): Promise<void>;
  closeSync(): void;
  path?: string;
  flags?: string;
  mode?: number;
  position?: number;
  closed?: boolean;
};

export type VirtualProvider = {
  readonly: boolean;
  supportsSymlinks: boolean;
  supportsWatch: boolean;
  open(path: string, flags: string, mode?: number): Promise<VirtualFileHandle>;
  openSync(path: string, flags: string, mode?: number): VirtualFileHandle;
  stat(path: string, options?: object): Promise<Stats>;
  statSync(path: string, options?: object): Stats;
  lstat(path: string, options?: object): Promise<Stats>;
  lstatSync(path: string, options?: object): Stats;
  readdir(path: string, options?: object): Promise<Array<string | Dirent>>;
  readdirSync(path: string, options?: object): Array<string | Dirent>;
  mkdir(path: string, options?: object): Promise<void | string>;
  mkdirSync(path: string, options?: object): void | string;
  rmdir(path: string): Promise<void>;
  rmdirSync(path: string): void;
  unlink(path: string): Promise<void>;
  unlinkSync(path: string): void;
  rename(oldPath: string, newPath: string): Promise<void>;
  renameSync(oldPath: string, newPath: string): void;
  link?(existingPath: string, newPath: string): Promise<void>;
  linkSync?(existingPath: string, newPath: string): void;
  readFile?(
    path: string,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<Buffer | string>;
  readFileSync?(
    path: string,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Buffer | string;
  writeFile?(
    path: string,
    data: Buffer | string,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): Promise<void>;
  writeFileSync?(
    path: string,
    data: Buffer | string,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): void;
  appendFile?(
    path: string,
    data: Buffer | string,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): Promise<void>;
  appendFileSync?(
    path: string,
    data: Buffer | string,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): void;
  exists?(path: string): Promise<boolean>;
  existsSync?(path: string): boolean;
  copyFile?(src: string, dest: string, mode?: number): Promise<void>;
  copyFileSync?(src: string, dest: string, mode?: number): void;
  internalModuleStat?(path: string): number;
  realpath?(path: string, options?: object): Promise<string>;
  realpathSync?(path: string, options?: object): string;
  access?(path: string, mode?: number): Promise<void>;
  accessSync?(path: string, mode?: number): void;
  readlink?(path: string, options?: object): Promise<string>;
  readlinkSync?(path: string, options?: object): string;
  symlink?(target: string, path: string, type?: string): Promise<void>;
  symlinkSync?(target: string, path: string, type?: string): void;
  statfs?(path: string): Promise<VfsStatfs>;
  watch?(path: string, options?: object): unknown;
  watchAsync?(path: string, options?: object): unknown;
  watchFile?(
    path: string,
    options?: object,
    listener?: (...args: unknown[]) => void,
  ): unknown;
  unwatchFile?(path: string, listener?: (...args: unknown[]) => void): void;
};

export type MemoryProvider = VirtualProvider & {
  setReadOnly(): void;
};

export type RealFSProvider = VirtualProvider & {
  readonly rootPath: string;
};

export type VirtualFileSystemOptions = {
  /** enable require/import module hooks */
  moduleHooks?: boolean;
  /** enable process.cwd/process.chdir virtualization */
  virtualCwd?: boolean;
  /** intercept only paths that exist in the provider */
  overlay?: boolean;
};

export type VirtualFileSystem = {
  readonly provider: VirtualProvider;
  readonly mountPoint: string | null;
  readonly mounted: boolean;
  readonly readonly: boolean;
  readonly overlay: boolean;
  readonly virtualCwdEnabled: boolean;
  mount(prefix: string): VirtualFileSystem;
  unmount(): void;
  cwd(): string | null;
  chdir(path: string): void;
  resolvePath(inputPath: string): string;
  existsSync(path: string): boolean;
  statSync(path: string, options?: object): Stats;
  lstatSync(path: string, options?: object): Stats;
  readFileSync(
    path: string,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Buffer | string;
  writeFileSync(
    path: string,
    data: Buffer | string,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): void;
  appendFileSync(
    path: string,
    data: Buffer | string,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): void;
  readdirSync(path: string, options?: object): Array<string | Dirent>;
  mkdirSync(path: string, options?: object): string | undefined;
  rmdirSync(path: string): void;
  unlinkSync(path: string): void;
  renameSync(oldPath: string, newPath: string): void;
  copyFileSync(src: string, dest: string, mode?: number): void;
  realpathSync(path: string, options?: object): string;
  readlinkSync(path: string, options?: object): string;
  symlinkSync(target: string, path: string, type?: string): void;
  accessSync(path: string, mode?: number): void;
  internalModuleStat(path: string): number;
  openSync(path: string, flags?: string, mode?: number): number;
  closeSync(fd: number): void;
  readSync(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ): number;
  fstatSync(fd: number, options?: object): Stats;
  readFile(
    path: string,
    options:
      | object
      | string
      | ((err: Error | null, data?: Buffer | string) => void),
    callback?: (err: Error | null, data?: Buffer | string) => void,
  ): void;
  writeFile(
    path: string,
    data: Buffer | string,
    options: object | ((err: Error | null) => void),
    callback?: (err: Error | null) => void,
  ): void;
  stat(
    path: string,
    options: object | ((err: Error | null, stats?: Stats) => void),
    callback?: (err: Error | null, stats?: Stats) => void,
  ): void;
  lstat(
    path: string,
    options: object | ((err: Error | null, stats?: Stats) => void),
    callback?: (err: Error | null, stats?: Stats) => void,
  ): void;
  readdir(
    path: string,
    options:
      | object
      | ((err: Error | null, entries?: Array<string | Dirent>) => void),
    callback?: (err: Error | null, entries?: Array<string | Dirent>) => void,
  ): void;
  realpath(
    path: string,
    options: object | ((err: Error | null, resolved?: string) => void),
    callback?: (err: Error | null, resolved?: string) => void,
  ): void;
  readlink(
    path: string,
    options: object | ((err: Error | null, target?: string) => void),
    callback?: (err: Error | null, target?: string) => void,
  ): void;
  access(
    path: string,
    mode: number | ((err: Error | null) => void),
    callback?: (err: Error | null) => void,
  ): void;
  open(
    path: string,
    flags: string | ((err: Error | null, fd?: number) => void),
    mode?: number | ((err: Error | null, fd?: number) => void),
    callback?: (err: Error | null, fd?: number) => void,
  ): void;
  close(fd: number, callback: (err: Error | null) => void): void;
  read(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
    callback: (err: Error | null, bytesRead?: number, buffer?: Buffer) => void,
  ): void;
  fstat(
    fd: number,
    options: object | ((err: Error | null, stats?: Stats) => void),
    callback?: (err: Error | null, stats?: Stats) => void,
  ): void;
  createReadStream(path: string, options?: object): unknown;
  watch(
    path: string,
    options?: object,
    listener?: (...args: unknown[]) => void,
  ): unknown;
  watchFile(
    path: string,
    options?: object,
    listener?: (...args: unknown[]) => void,
  ): unknown;
  unwatchFile(path: string, listener?: (...args: unknown[]) => void): void;
  readonly promises: {
    readFile(
      path: string,
      options?: { encoding?: BufferEncoding } | BufferEncoding,
    ): Promise<Buffer | string>;
    writeFile(
      path: string,
      data: Buffer | string,
      options?: { encoding?: BufferEncoding; mode?: number },
    ): Promise<void>;
    appendFile(
      path: string,
      data: Buffer | string,
      options?: { encoding?: BufferEncoding; mode?: number },
    ): Promise<void>;
    stat(path: string, options?: object): Promise<Stats>;
    lstat(path: string, options?: object): Promise<Stats>;
    readdir(path: string, options?: object): Promise<Array<string | Dirent>>;
    mkdir(path: string, options?: object): Promise<string | undefined>;
    rmdir(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    copyFile(src: string, dest: string, mode?: number): Promise<void>;
    realpath(path: string, options?: object): Promise<string>;
    readlink(path: string, options?: object): Promise<string>;
    symlink(target: string, path: string, type?: string): Promise<void>;
    access(path: string, mode?: number): Promise<void>;
    watch(
      path: string,
      options?: object,
    ): AsyncIterable<{ eventType: string; filename: string }>;
  };
};

export type VirtualProviderConstructor = new () => VirtualProvider;
export type MemoryProviderConstructor = new () => MemoryProvider;
export type RealFSProviderConstructor = new (
  rootPath: string,
) => RealFSProvider;
export interface VirtualFileSystemConstructor {
  new (): VirtualFileSystem;
  new (options: VirtualFileSystemOptions): VirtualFileSystem;
  new (
    provider: VirtualProvider,
    options?: VirtualFileSystemOptions,
  ): VirtualFileSystem;
}

interface NodeVfsModule {
  VirtualFileSystem: VirtualFileSystemConstructor;
  VirtualProvider: VirtualProviderConstructor;
  MemoryProvider: MemoryProviderConstructor;
  RealFSProvider: RealFSProviderConstructor;
}

// GONDOLIN_VENDORED_NODE_VFS_PATCH_BEGIN
const require = createRequire(import.meta.url);
const nodeVfs = require("./vendored-node-vfs/lib/vfs.js") as NodeVfsModule;
// GONDOLIN_VENDORED_NODE_VFS_PATCH_END

const { VirtualFileSystem, VirtualProvider, MemoryProvider, RealFSProvider } =
  nodeVfs;

function isVirtualProvider(value: unknown): value is VirtualProvider {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { openSync?: unknown }).openSync === "function"
  );
}

function create(): VirtualFileSystem;
function create(options: VirtualFileSystemOptions): VirtualFileSystem;
function create(
  provider: VirtualProvider,
  options?: VirtualFileSystemOptions,
): VirtualFileSystem;
function create(
  providerOrOptions?: VirtualProvider | VirtualFileSystemOptions,
  options?: VirtualFileSystemOptions,
) {
  if (isVirtualProvider(providerOrOptions)) {
    return new VirtualFileSystem(providerOrOptions, options);
  }
  if (providerOrOptions === undefined) {
    return new VirtualFileSystem();
  }
  return new VirtualFileSystem(providerOrOptions);
}

export {
  create,
  VirtualFileSystem,
  VirtualProvider,
  MemoryProvider,
  RealFSProvider,
};

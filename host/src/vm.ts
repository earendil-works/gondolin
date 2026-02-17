import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { Duplex, Readable } from "stream";

import { toBufferIterable } from "./buffer-iter";
import { AsyncSingleflight } from "./async-utils";

import {
  createTempQcow2Overlay,
  ensureQemuImgAvailable,
  inferDiskFormatFromPath,
  moveFile,
} from "./qemu-img";
import { VmCheckpoint, type VmCheckpointData } from "./checkpoint";
import { loadAssetManifest } from "./assets";

import {
  ErrorMessage,
  ExecResponseMessage,
  StatusMessage,
  decodeOutputFrame,
  type ClientMessage,
} from "./control-protocol";
import {
  SandboxServer,
  SandboxServerOptions,
  resolveSandboxServerOptions,
  resolveSandboxServerOptionsAsync,
  type ResolvedSandboxServerOptions,
  type SandboxConnection,
} from "./sandbox-server";
import type { SandboxState } from "./sandbox-controller";
import {
  SessionIpcServer,
  gcSessions,
  registerSession,
  unregisterSession,
} from "./session-registry";
import type { DnsOptions, HttpFetch, HttpHooks } from "./qemu-net";
import type { SshOptions } from "./qemu-ssh";
import { createMitmCaProvider, resolveMitmMounts } from "./mitm-vfs";
import {
  buildShellEnv,
  envInputToEntries,
  mapToEnvArray,
  mergeEnvInputs,
  parseEnvEntry,
  resolveEnvNumber,
} from "./env-utils";
import {
  defaultDebugLog,
  resolveDebugFlags,
  type DebugComponent,
  type DebugLogFn,
} from "./debug";
import {
  IngressGateway,
  type EnableIngressOptions,
  type IngressAccess,
  type IngressRoute,
  createGondolinEtcHooks,
  createGondolinEtcMount,
} from "./ingress";
import { MemoryProvider, type VirtualProvider } from "./vfs/node";
import { normalizeVfsPath } from "./vfs/utils";
import {
  SandboxVfsProvider,
  type VfsHooks,
  composeVfsHooks,
  wrapProvider,
} from "./vfs/provider";
import {
  MountRouterProvider,
  getRelativePath,
  isNoEntryError,
  isUnderMountPoint,
  listMountPaths,
  normalizeMountMap,
  normalizeMountPath,
} from "./vfs/mounts";
import {
  ExecProcess,
  ExecResult,
  ExecOptions,
  ExecSession,
  createExecSession,
  finishExecSession,
  rejectExecSession,
  resolveOutputMode,
  applyOutputChunk,
  normalizeCommand,
  toAsyncIterable,
} from "./exec";

const MAX_REQUEST_ID = 0xffffffff;
const DEFAULT_STDIN_CHUNK = 32 * 1024;
const DEFAULT_VFS_FILE_CHUNK_SIZE = 64 * 1024;
const DEFAULT_VFS_READY_TIMEOUT_MS = 30000;
const VFS_READY_SLEEP_SECONDS = resolveEnvNumber(
  "GONDOLIN_VFS_READY_SLEEP_SECONDS",
  0.1,
);
const VFS_READY_TIMEOUT_MS = resolveEnvNumber(
  "GONDOLIN_VFS_READY_TIMEOUT_MS",
  DEFAULT_VFS_READY_TIMEOUT_MS,
);
const VFS_READY_ATTEMPTS = Math.max(
  1,
  Math.ceil(VFS_READY_TIMEOUT_MS / (VFS_READY_SLEEP_SECONDS * 1000)),
);

type ExecInput = string | string[];

type EnvInput = string[] | Record<string, string>;

type ExecStdin = boolean | string | Buffer | Readable | AsyncIterable<Buffer>;

export type VmVfsOptions = {
  /** mount map (guest path -> provider) */
  mounts?: Record<string, VirtualProvider>;
  /** vfs hook callbacks */
  hooks?: VfsHooks;
  /** guest path for the fuse mount (default: "/data") */
  fuseMount?: string;
};

export type VMOptions = {
  /** sandbox controller options */
  sandbox?: SandboxServerOptions;
  /** whether to boot the vm immediately (default: true) */
  autoStart?: boolean;
  /** http fetch implementation for asset downloads */
  fetch?: HttpFetch;
  /** http interception hooks */
  httpHooks?: HttpHooks;

  /** dns configuration */
  dns?: DnsOptions;
  /** ssh egress configuration */
  ssh?: SshOptions;
  /** max intercepted http request body size in `bytes` */
  maxHttpBodyBytes?: number;
  /** max buffered upstream http response body size in `bytes` */
  maxHttpResponseBodyBytes?: number;
  /** whether to allow WebSocket upgrades for guest egress (default: true) */
  allowWebSockets?: boolean;
  /** vfs configuration (null disables vfs integration) */
  vfs?: VmVfsOptions | null;
  /** default environment variables */
  env?: EnvInput;
  /** vm memory size (qemu syntax, default: "1G") */
  memory?: string;
  /** vm cpu count (default: 2) */
  cpus?: number;
  /** session label for `gondolin list` */
  sessionLabel?: string;

  /**
   * Debug log callback.
   *
   * If any debug mode is enabled (via `sandbox.debug` or `GONDOLIN_DEBUG`),
   * debug messages are delivered here.
   *
   * - `undefined`: defaults to `console.log` with `[component]` prefix
   * - `null`: disable debug output even if debug modes are enabled
   */
  debugLog?: DebugLogFn | null;
};

export type ShellOptions = {
  /** command to run (default: /bin/bash) */
  command?: string | string[];
  /** environment variables */
  env?: EnvInput;
  /** working directory */
  cwd?: string;
  /** abort signal */
  signal?: AbortSignal;
  /** whether to attach to stdin/stdout/stderr (default: true in a tty) */
  attach?: boolean;
};

export type EnableSshOptions = {
  /** ssh username (default: "root") */
  user?: string;
  /** local listen host (default: 127.0.0.1) */
  listenHost?: string;
  /** local listen port (0 picks an ephemeral port) */
  listenPort?: number;
};

export type SshAccess = {
  /** local host to connect to */
  host: string;
  /** local port to connect to */
  port: number;
  /** ssh username */
  user: string;
  /** path to a temporary private key file */
  identityFile: string;
  /** ready-to-run ssh command */
  command: string;
  /** close the local forwarder and remove temporary key material */
  close(): Promise<void>;
};

export type VmReadFileBufferOptions = {
  /** decoded output disabled (returns Buffer) */
  encoding?: null;
  /** working directory for relative paths */
  cwd?: string;
  /** preferred chunk size in `bytes` */
  chunkSize?: number;
  /** abort signal for the read command */
  signal?: AbortSignal;
};

export type VmReadFileTextOptions = {
  /** text encoding for returned data */
  encoding: BufferEncoding;
  /** working directory for relative paths */
  cwd?: string;
  /** preferred chunk size in `bytes` */
  chunkSize?: number;
  /** abort signal for the read command */
  signal?: AbortSignal;
};

export type VmReadFileStreamOptions = {
  /** working directory for relative paths */
  cwd?: string;
  /** preferred chunk size in `bytes` */
  chunkSize?: number;
  /** stream highWaterMark in `bytes` */
  highWaterMark?: number;
  /** abort signal for the read request */
  signal?: AbortSignal;
};

export type VmReadFileOptions = VmReadFileBufferOptions | VmReadFileTextOptions;

export type VmWriteFileInput =
  | string
  | Buffer
  | Uint8Array
  | Readable
  | AsyncIterable<Buffer | Uint8Array>;

export type VmWriteFileOptions = {
  /** string encoding for top-level text input */
  encoding?: BufferEncoding;
  /** working directory for relative paths */
  cwd?: string;
  /** abort signal for the write command */
  signal?: AbortSignal;
};

export type VmDeleteFileOptions = {
  /** ignore missing path errors */
  force?: boolean;
  /** allow recursive directory deletion */
  recursive?: boolean;
  /** working directory for relative paths */
  cwd?: string;
  /** abort signal for the delete command */
  signal?: AbortSignal;
};

export type VMState = SandboxState | "unknown";

type RootDiskState = {
  /** root disk image path */
  path: string;
  /** qemu disk format */
  format: "raw" | "qcow2";
  /** qemu snapshot mode (discard writes) */
  snapshot: boolean;
  /** delete the disk file on vm.close() */
  deleteOnClose: boolean;
};

export class VM {
  /**
   * Replace the debug log callback.
   *
   * Passing `null` disables debug output.
   */
  setDebugLog(callback: DebugLogFn | null) {
    this.debugLog = callback;
  }
  /** vm session identifier */
  readonly id: string;
  private readonly autoStart: boolean;
  private readonly sessionLabel: string | undefined;
  private server: SandboxServer | null;
  private readonly resolvedSandboxOptions: ResolvedSandboxServerOptions;
  private rootDisk: RootDiskState | null = null;
  private checkpointed = false;
  private readonly baseOptionsForClone: VMOptions;
  private readonly defaultEnv: EnvInput | undefined;
  private connection: SandboxConnection | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly startSingleflight = new AsyncSingleflight<void>();
  private readonly closeSingleflight = new AsyncSingleflight<void>();
  private statusPromise: Promise<SandboxState> | null = null;
  private statusResolve: ((state: SandboxState) => void) | null = null;
  private statusReject: ((error: Error) => void) | null = null;
  private state: SandboxState | "unknown" = "unknown";
  private stateWaiters: Array<{
    state: SandboxState;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private sessions = new Map<number, ExecSession>();
  private nextId = 1;
  private vfs: SandboxVfsProvider | null;
  private readonly fuseMount: string;
  private readonly fuseBinds: string[];
  private readonly shortcutBindMounts: string[];
  private bootSent = false;
  private vfsReadyPromise: Promise<void> | null = null;
  private qemuChecked = false;
  private debugLog: DebugLogFn | null = null;
  private debugListener:
    | ((component: DebugComponent, message: string) => void)
    | null = null;
  private sshAccess: SshAccess | null = null;
  private gondolinEtc: ReturnType<typeof createGondolinEtcMount> | null = null;
  private ingressAccess: IngressAccess | null = null;
  private sessionIpc: SessionIpcServer | null = null;

  /**
   * Create a VM instance, downloading guest assets if needed.
   *
   * This is the recommended way to create a VM in production, as it will
   * automatically download the guest image if it's not available locally.
   *
   * @param options VM configuration options
   * @returns A configured VM instance
   */
  static async create(options: VMOptions = {}): Promise<VM> {
    // Resolve sandbox options with async asset fetching
    const sandboxOptions: SandboxServerOptions = { ...options.sandbox };

    // Build the combined sandbox options
    if (options.fetch && sandboxOptions.fetch === undefined) {
      sandboxOptions.fetch = options.fetch;
    }
    if (options.httpHooks && sandboxOptions.httpHooks === undefined) {
      sandboxOptions.httpHooks = options.httpHooks;
    }
    if (options.dns && sandboxOptions.dns === undefined) {
      sandboxOptions.dns = options.dns;
    }
    if (options.ssh && sandboxOptions.ssh === undefined) {
      sandboxOptions.ssh = options.ssh;
    }
    if (
      options.maxHttpBodyBytes !== undefined &&
      sandboxOptions.maxHttpBodyBytes === undefined
    ) {
      sandboxOptions.maxHttpBodyBytes = options.maxHttpBodyBytes;
    }
    if (
      options.maxHttpResponseBodyBytes !== undefined &&
      (sandboxOptions as any).maxHttpResponseBodyBytes === undefined
    ) {
      (sandboxOptions as any).maxHttpResponseBodyBytes =
        options.maxHttpResponseBodyBytes;
    }
    if (
      options.allowWebSockets !== undefined &&
      sandboxOptions.allowWebSockets === undefined
    ) {
      sandboxOptions.allowWebSockets = options.allowWebSockets;
    }
    if (options.memory && sandboxOptions.memory === undefined) {
      sandboxOptions.memory = options.memory;
    }
    if (options.cpus && sandboxOptions.cpus === undefined) {
      sandboxOptions.cpus = options.cpus;
    }

    // Resolve options with asset fetching
    const resolvedSandboxOptions =
      await resolveSandboxServerOptionsAsync(sandboxOptions);

    // Create VM with pre-resolved options
    return new VM(options, resolvedSandboxOptions);
  }

  /**
   * Create a VM instance synchronously.
   *
   * This constructor requires that guest assets are available locally (either
   * in a development checkout or via GONDOLIN_GUEST_DIR). For automatic asset
   * downloading, use the async `VM.create()` factory instead.
   *
   * @param options VM configuration options
   * @param resolvedSandboxOptions Optional pre-resolved sandbox options (from VM.create())
   */
  constructor(
    options: VMOptions = {},
    resolvedSandboxOptions?: ResolvedSandboxServerOptions,
  ) {
    this.id = randomUUID();
    this.baseOptionsForClone = { ...options };
    this.autoStart = options.autoStart ?? true;
    this.sessionLabel = options.sessionLabel ?? process.argv.join(" ");
    const mitmMounts = resolveMitmMounts(
      options.vfs,
      options.sandbox?.mitmCertDir,
      options.sandbox?.netEnabled ?? true,
    );

    // Inject a guarded /etc/gondolin mount (host-authoritative ingress configuration)
    let gondolinMounts: Record<string, VirtualProvider> = {};
    let gondolinHooks: VfsHooks = {};
    if (options.vfs !== null) {
      const mountPaths = listMountPaths(options.vfs?.mounts);
      if (!mountPaths.includes("/etc/gondolin")) {
        const etcProvider = new MemoryProvider();
        this.gondolinEtc = createGondolinEtcMount(etcProvider);
        gondolinMounts = {
          "/etc/gondolin": etcProvider,
        };
        gondolinHooks = createGondolinEtcHooks(
          this.gondolinEtc.listeners,
          etcProvider,
        ) as VfsHooks;
      }
    }

    const mergedHooks = composeVfsHooks(options.vfs?.hooks, gondolinHooks);
    const vfsOptions =
      options.vfs === null
        ? null
        : {
            ...(options.vfs ?? {}),
            hooks: mergedHooks,
          };

    const resolvedVfs = resolveVmVfs(vfsOptions, {
      ...mitmMounts,
      ...gondolinMounts,
    });
    this.vfs = resolvedVfs.provider;
    this.defaultEnv = options.env;
    let fuseMounts = resolvedVfs.mounts;
    let fuseConfig = resolveFuseConfig(options.vfs, fuseMounts);
    this.fuseMount = fuseConfig.fuseMount;
    this.fuseBinds = fuseConfig.fuseBinds;

    const sandboxOptions: SandboxServerOptions = { ...options.sandbox };
    if (sandboxOptions.vfsProvider && options.vfs) {
      throw new Error("VM cannot specify both vfs and sandbox.vfsProvider");
    }
    if (sandboxOptions.vfsProvider) {
      const injectedMounts = resolveMitmMounts(
        undefined,
        sandboxOptions.mitmCertDir,
        sandboxOptions.netEnabled ?? true,
      );
      if (Object.keys(injectedMounts).length > 0) {
        const normalized = normalizeMountMap({
          "/": sandboxOptions.vfsProvider,
          ...injectedMounts,
        });
        this.vfs = wrapProvider(new MountRouterProvider(normalized), {});
        fuseMounts = { "/": sandboxOptions.vfsProvider, ...injectedMounts };
      } else {
        this.vfs = wrapProvider(sandboxOptions.vfsProvider, {});
        fuseMounts = { "/": sandboxOptions.vfsProvider };
      }
      fuseConfig = resolveFuseConfig(options.vfs, fuseMounts);
      this.fuseMount = fuseConfig.fuseMount;
      this.fuseBinds = fuseConfig.fuseBinds;
      sandboxOptions.vfsProvider = this.vfs;
    }
    this.shortcutBindMounts = this.fuseBinds
      .filter((mountPath) => mountPath !== this.fuseMount)
      .sort((a, b) => b.length - a.length);

    if (options.fetch && sandboxOptions.fetch === undefined) {
      sandboxOptions.fetch = options.fetch;
    }
    if (options.httpHooks && sandboxOptions.httpHooks === undefined) {
      sandboxOptions.httpHooks = options.httpHooks;
    }
    if (options.dns && sandboxOptions.dns === undefined) {
      sandboxOptions.dns = options.dns;
    }
    if (options.ssh && sandboxOptions.ssh === undefined) {
      sandboxOptions.ssh = options.ssh;
    }
    if (
      options.maxHttpBodyBytes !== undefined &&
      sandboxOptions.maxHttpBodyBytes === undefined
    ) {
      sandboxOptions.maxHttpBodyBytes = options.maxHttpBodyBytes;
    }
    if (
      options.maxHttpResponseBodyBytes !== undefined &&
      (sandboxOptions as any).maxHttpResponseBodyBytes === undefined
    ) {
      (sandboxOptions as any).maxHttpResponseBodyBytes =
        options.maxHttpResponseBodyBytes;
    }
    if (
      options.allowWebSockets !== undefined &&
      sandboxOptions.allowWebSockets === undefined
    ) {
      sandboxOptions.allowWebSockets = options.allowWebSockets;
    }
    if (this.vfs && sandboxOptions.vfsProvider === undefined) {
      sandboxOptions.vfsProvider = this.vfs;
    }
    if (options.memory && sandboxOptions.memory === undefined) {
      sandboxOptions.memory = options.memory;
    }
    if (options.cpus && sandboxOptions.cpus === undefined) {
      sandboxOptions.cpus = options.cpus;
    }

    // Resolve sandbox options (sync) if needed so we can prepare the root disk.
    const resolved = resolvedSandboxOptions
      ? ({ ...resolvedSandboxOptions } as ResolvedSandboxServerOptions)
      : resolveSandboxServerOptions(sandboxOptions);

    // Merge VFS provider into resolved options
    if (this.vfs) {
      (resolved as any).vfsProvider = this.vfs;
    }

    // Prepare root disk:
    // - If the caller provided sandbox.rootDiskPath, use it as-is.
    // - Otherwise create an ephemeral qcow2 overlay backed by the base rootfs.
    const userRootDiskPath = sandboxOptions.rootDiskPath;
    if (userRootDiskPath) {
      const format =
        sandboxOptions.rootDiskFormat ??
        resolved.rootDiskFormat ??
        inferDiskFormatFromPath(userRootDiskPath);
      const snapshot =
        sandboxOptions.rootDiskSnapshot ?? resolved.rootDiskSnapshot ?? false;
      const deleteOnClose = sandboxOptions.rootDiskDeleteOnClose ?? false;

      resolved.rootDiskPath = userRootDiskPath;
      resolved.rootDiskFormat = format;
      resolved.rootDiskSnapshot = snapshot;

      this.rootDisk = {
        path: userRootDiskPath,
        format,
        snapshot,
        deleteOnClose,
      };
    } else {
      ensureQemuImgAvailable();
      const backingFormat = inferDiskFormatFromPath(resolved.rootfsPath);
      const overlayPath = createTempQcow2Overlay(
        resolved.rootfsPath,
        backingFormat,
      );

      resolved.rootDiskPath = overlayPath;
      resolved.rootDiskFormat = "qcow2";
      resolved.rootDiskSnapshot = false;

      this.rootDisk = {
        path: overlayPath,
        format: "qcow2",
        snapshot: false,
        deleteOnClose: true,
      };
    }

    this.resolvedSandboxOptions = resolved;
    this.server = new SandboxServer(resolved);

    const effectiveDebugFlags = resolvedSandboxOptions
      ? new Set(resolvedSandboxOptions.debug ?? [])
      : resolveDebugFlags(sandboxOptions.debug);

    const anyDebug = effectiveDebugFlags.size > 0;

    if (anyDebug) {
      // If the user didn't provide a debug sink, default to console.log
      this.debugLog =
        options.debugLog === undefined ? defaultDebugLog : options.debugLog;

      // Always attach the listener so `vm.setDebugLog()` can enable logging later.
      this.debugListener = (component, message) => {
        const logger = this.debugLog;
        if (!logger) return;
        try {
          logger(component, message);
        } catch {
          // ignore logger errors
        }
      };
      this.server.on("debug", this.debugListener);
    }
  }

  /**
   * Start the VM.
   *
   * If VFS is configured, this also waits for the VFS mount(s) to be ready.
   */
  async start() {
    return this.startSingleflight.run(() => this.startInternal());
  }

  /**
   * Close the VM and release associated resources.
   */
  async close() {
    return this.closeSingleflight.run(() => this.closeInternal());
  }

  /**
   * Execute a command in the sandbox.
   *
   * Returns an ExecProcess which can be:
   * - awaited for a buffered result with strings
   * - iterated for streaming output (requires stdout: "pipe")
   * - used with stdin via write()/end()
   *
   * @example
   * ```typescript
   * // String form runs via `/bin/sh -lc "..."`
   * const r1 = await vm.exec("echo hello");
   * console.log(r1.stdout); // 'hello\n'
   *
   * // Array form executes an executable directly (does not search `$PATH`)
   * const r2 = await vm.exec(["/bin/echo", "hello"]);
   * console.log(r2.stdout); // 'hello\n'
   *
   * // Streaming output (piped stdout)
   * for await (const line of vm.exec(["/bin/tail", "-f", "/var/log/syslog"], { stdout: "pipe" })) {
   *   console.log(line);
   * }
   *
   * // Interactive with stdin
   * const proc = vm.exec(["/bin/cat"], { stdin: true });
   * proc.write("hello\n");
   * proc.end();
   * const result = await proc;
   * ```
   */
  exec(command: ExecInput, options: ExecOptions = {}): ExecProcess {
    const proc = this.execInternal(command, options);
    return proc;
  }

  /**
   * Create a readable stream for a guest file.
   */
  async readFileStream(
    filePath: string,
    options: VmReadFileStreamOptions = {},
  ): Promise<Readable> {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("filePath must be a non-empty string");
    }

    const vfsPath = this.resolveVfsShortcutPath(filePath, options.cwd);
    if (vfsPath) {
      try {
        return this.readFileStreamFromVfs(vfsPath, options);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`failed to stream guest file '${filePath}': ${detail}`);
      }
    }

    await this.start();

    const server = this.server;
    if (!server) {
      throw new Error("sandbox server is not available");
    }

    try {
      return await server.readGuestFileStream(filePath, {
        cwd: options.cwd,
        chunkSize: options.chunkSize,
        highWaterMark: options.highWaterMark,
        signal: options.signal,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to stream guest file '${filePath}': ${detail}`);
    }
  }

  /**
   * Read a file from inside the running guest.
   */
  readFile(filePath: string, options: VmReadFileTextOptions): Promise<string>;
  readFile(
    filePath: string,
    options?: VmReadFileBufferOptions,
  ): Promise<Buffer>;
  async readFile(
    filePath: string,
    options: VmReadFileOptions = {},
  ): Promise<string | Buffer> {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("filePath must be a non-empty string");
    }

    const vfsPath = this.resolveVfsShortcutPath(filePath, options.cwd);
    let data: Buffer;
    if (vfsPath) {
      try {
        data = await this.readFileFromVfs(vfsPath, {
          chunkSize: options.chunkSize,
          signal: options.signal,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`failed to read guest file '${filePath}': ${detail}`);
      }
    } else {
      await this.start();

      const server = this.server;
      if (!server) {
        throw new Error("sandbox server is not available");
      }

      try {
        data = await server.readGuestFile(filePath, {
          cwd: options.cwd,
          chunkSize: options.chunkSize,
          signal: options.signal,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`failed to read guest file '${filePath}': ${detail}`);
      }
    }

    if ("encoding" in options && options.encoding) {
      return data.toString(options.encoding);
    }

    return data;
  }

  /**
   * Write file content inside the running guest.
   *
   * Existing files are truncated.
   */
  async writeFile(
    filePath: string,
    data: VmWriteFileInput,
    options: VmWriteFileOptions = {},
  ): Promise<void> {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("filePath must be a non-empty string");
    }

    const vfsPath = this.resolveVfsShortcutPath(filePath, options.cwd);
    const payload =
      typeof data === "string"
        ? Buffer.from(data, options.encoding ?? "utf-8")
        : data;

    if (vfsPath) {
      try {
        await this.writeFileToVfs(vfsPath, payload, options.signal);
        return;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`failed to write guest file '${filePath}': ${detail}`);
      }
    }

    await this.start();

    const server = this.server;
    if (!server) {
      throw new Error("sandbox server is not available");
    }

    try {
      await server.writeGuestFile(filePath, payload, {
        cwd: options.cwd,
        signal: options.signal,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to write guest file '${filePath}': ${detail}`);
    }
  }

  /**
   * Delete a file or directory inside the running guest.
   */
  async deleteFile(
    filePath: string,
    options: VmDeleteFileOptions = {},
  ): Promise<void> {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("filePath must be a non-empty string");
    }

    const vfsPath = this.resolveVfsShortcutPath(filePath, options.cwd);
    if (vfsPath) {
      try {
        await this.deleteVfsPath(vfsPath, {
          force: options.force,
          recursive: options.recursive,
          signal: options.signal,
        });
        return;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`failed to delete guest file '${filePath}': ${detail}`);
      }
    }

    await this.start();

    const server = this.server;
    if (!server) {
      throw new Error("sandbox server is not available");
    }

    try {
      await server.deleteGuestFile(filePath, {
        force: options.force,
        recursive: options.recursive,
        cwd: options.cwd,
        signal: options.signal,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to delete guest file '${filePath}': ${detail}`);
    }
  }

  private resolveVfsShortcutPath(
    filePath: string,
    cwd?: string,
  ): string | null {
    if (!this.vfs) return null;

    const absolutePath = resolveAbsoluteGuestPath(filePath, cwd);
    if (!absolutePath) return null;

    for (const mountPath of this.shortcutBindMounts) {
      if (isUnderMountPoint(absolutePath, mountPath)) {
        return absolutePath;
      }
    }

    if (isUnderMountPoint(absolutePath, this.fuseMount)) {
      return getRelativePath(absolutePath, this.fuseMount);
    }

    return null;
  }

  private readFileStreamFromVfs(
    filePath: string,
    options: VmReadFileStreamOptions,
  ): Readable {
    assertNotAborted(options.signal, "file read aborted");
    const chunkSize =
      normalizePositiveInt(options.chunkSize, DEFAULT_VFS_FILE_CHUNK_SIZE) ??
      DEFAULT_VFS_FILE_CHUNK_SIZE;
    const highWaterMark = normalizePositiveInt(options.highWaterMark);
    const stream = Readable.from(
      this.iterateVfsFileChunks(filePath, chunkSize, options.signal),
      highWaterMark
        ? { objectMode: false, highWaterMark }
        : { objectMode: false },
    );
    stream.on("error", () => {
      // keep process alive if caller does not attach an error handler
    });
    return stream;
  }

  private async readFileFromVfs(
    filePath: string,
    options: { chunkSize?: number; signal?: AbortSignal },
  ): Promise<Buffer> {
    const chunkSize =
      normalizePositiveInt(options.chunkSize, DEFAULT_VFS_FILE_CHUNK_SIZE) ??
      DEFAULT_VFS_FILE_CHUNK_SIZE;
    const chunks: Buffer[] = [];
    for await (const chunk of this.iterateVfsFileChunks(
      filePath,
      chunkSize,
      options.signal,
    )) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  private async *iterateVfsFileChunks(
    filePath: string,
    chunkSize: number,
    signal?: AbortSignal,
  ): AsyncIterable<Buffer> {
    const vfs = this.vfs;
    if (!vfs) {
      throw new Error("vfs provider is not available");
    }

    assertNotAborted(signal, "file read aborted");
    const handle = await vfs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(chunkSize);
      let offset = 0;

      while (true) {
        assertNotAborted(signal, "file read aborted");
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          offset,
        );
        if (bytesRead === 0) {
          return;
        }

        offset += bytesRead;
        yield Buffer.from(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
  }

  private async writeFileToVfs(
    filePath: string,
    input: VmWriteFileInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const vfs = this.vfs;
    if (!vfs) {
      throw new Error("vfs provider is not available");
    }

    assertNotAborted(signal, "file write aborted");
    const handle = await vfs.open(filePath, "w");
    try {
      let position = 0;
      for await (const chunk of toBufferIterable(input)) {
        assertNotAborted(signal, "file write aborted");

        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(
            chunk,
            offset,
            chunk.length - offset,
            position + offset,
          );
          if (bytesWritten <= 0) {
            throw new Error("short write");
          }
          offset += bytesWritten;
        }

        position += chunk.length;
      }
    } finally {
      await handle.close();
    }
  }

  private async deleteVfsPath(
    filePath: string,
    options: { force?: boolean; recursive?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    const vfs = this.vfs;
    if (!vfs) {
      throw new Error("vfs provider is not available");
    }

    try {
      assertNotAborted(options.signal, "file delete aborted");
      if (!options.recursive) {
        await vfs.unlink(filePath);
        return;
      }

      const stats = await vfs.lstat(filePath);
      if (stats.isDirectory()) {
        await this.deleteVfsTree(filePath, options.signal);
      } else {
        await vfs.unlink(filePath);
      }
    } catch (err) {
      if (options.force && isNoEntryError(err)) {
        return;
      }
      throw err;
    }
  }

  private async deleteVfsTree(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const vfs = this.vfs;
    if (!vfs) {
      throw new Error("vfs provider is not available");
    }

    assertNotAborted(signal, "file delete aborted");
    const entries = await vfs.readdir(filePath, { withFileTypes: true });

    for (const entry of entries) {
      assertNotAborted(signal, "file delete aborted");
      const name = typeof entry === "string" ? entry : entry.name;
      if (!name || name === "." || name === "..") {
        continue;
      }

      const childPath = path.posix.join(filePath, name);
      const isDir =
        typeof entry === "string"
          ? (await vfs.lstat(childPath)).isDirectory()
          : entry.isDirectory() && !entry.isSymbolicLink();

      if (isDir) {
        await this.deleteVfsTree(childPath, signal);
      } else {
        await vfs.unlink(childPath);
      }
    }

    await vfs.rmdir(filePath);
  }

  /**
   * Start an interactive shell session.
   *
   * By default, attaches to process.stdin/stdout/stderr when running in a TTY.
   *
   * @example
   * ```typescript
   * // Simple interactive shell
   * const result = await vm.shell();
   * process.exit(result.exitCode);
   *
   * // Custom command (absolute path required)
   * const result = await vm.shell({ command: "/bin/sh" });
   *
   * // Manual control
   * const proc = vm.shell({ attach: false });
   * proc.write('ls\n');
   * for await (const chunk of proc) {
   *   process.stdout.write(chunk);
   * }
   * ```
   */
  shell(options: ShellOptions = {}): ExecProcess {
    const command = options.command ?? ["/bin/bash", "-i"];
    const shouldAttach = options.attach ?? process.stdin.isTTY;

    const env = buildShellEnv(this.defaultEnv, options.env);

    const proc = this.exec(command, {
      env,
      cwd: options.cwd,
      stdin: true,
      pty: true,
      signal: options.signal,
      ...(shouldAttach
        ? {
            stdout: "inherit" as const,
            stderr: "inherit" as const,
          }
        : {
            stdout: "pipe" as const,
            stderr: "pipe" as const,
          }),
    });

    if (shouldAttach) {
      proc.attach(
        process.stdin as NodeJS.ReadStream,
        process.stdout as NodeJS.WriteStream,
        process.stderr as NodeJS.WriteStream,
      );
    }

    return proc;
  }

  /**
   * Enable SSH access to the VM by starting `sshd` in the guest (bound to loopback)
   * and creating a host-local TCP forwarder.
   */
  async enableSsh(options: EnableSshOptions = {}): Promise<SshAccess> {
    if (this.sshAccess) return this.sshAccess;

    await this.start();

    const user = options.user ?? "root";
    const listenHost = options.listenHost ?? "127.0.0.1";
    const listenPort = options.listenPort ?? 0;

    // Generate ephemeral client keypair
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-ssh-"));
    const keyPath = path.join(tmpDir, "id_ed25519");

    try {
      execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath], {
        stdio: "ignore",
      });
    } catch (err) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      throw new Error(
        `failed to run ssh-keygen (needed for vm.enableSsh): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const pubKey = fs.readFileSync(keyPath + ".pub", "utf8").trim();

    const shQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const sshUser = shQuote(user);

    // Install authorized_keys + start sandboxssh + start sshd
    const setupScript = `set -eu
SSH_USER=${sshUser}
if ! command -v sshd >/dev/null 2>&1; then
  echo "sshd not found in guest image" 1>&2
  exit 127
fi

if ! command -v sandboxssh >/dev/null 2>&1; then
  echo "sandboxssh not found in guest image" 1>&2
  exit 126
fi

if ! id "$SSH_USER" >/dev/null 2>&1; then
  echo "ssh user '$SSH_USER' does not exist in guest image" 1>&2
  exit 125
fi

SSH_UID=$(id -u "$SSH_USER")
SSH_GID=$(id -g "$SSH_USER")

SSH_HOME=""
if command -v getent >/dev/null 2>&1; then
  SSH_HOME=$(getent passwd "$SSH_USER" | cut -d: -f6 || true)
fi
if [ -z "$SSH_HOME" ] && [ -r /etc/passwd ]; then
  SSH_HOME=$(awk -F: -v u="$SSH_USER" '$1==u{print $6;exit}' /etc/passwd || true)
fi
if [ -z "$SSH_HOME" ]; then
  if [ "$SSH_UID" = "0" ]; then
    SSH_HOME=/root
  else
    SSH_HOME="/home/$SSH_USER"
  fi
fi

# Ensure loopback is up (needed for ListenAddress=127.0.0.1 and tcp forwarding)
if command -v ip >/dev/null 2>&1; then
  ip link set lo up || true
else
  ifconfig lo up || true
fi

# sshd on Alpine wants /var/empty to be root-owned
mkdir -p /var/empty
chown root:root /var/empty || true
chmod 755 /var/empty || true

mkdir -p "$SSH_HOME" "$SSH_HOME/.ssh" /run/sshd /etc/ssh

chown "$SSH_UID:$SSH_GID" "$SSH_HOME" "$SSH_HOME/.ssh" || true
if [ "$SSH_UID" = "0" ]; then
  chmod 700 "$SSH_HOME" || true
else
  chmod 755 "$SSH_HOME" || true
fi
chmod 700 "$SSH_HOME/.ssh" || true

cat > "$SSH_HOME/.ssh/authorized_keys" <<'EOF'
${pubKey}
EOF
chown "$SSH_UID:$SSH_GID" "$SSH_HOME/.ssh/authorized_keys" || true
chmod 600 "$SSH_HOME/.ssh/authorized_keys"

# Generate host keys if missing
ssh-keygen -A >/dev/null 2>&1 || true

# Start sandboxssh if it's not already running (required for host-side TCP forwarding)
if ! ps | grep -q '[s]andboxssh'; then
  sandboxssh >/tmp/sandboxssh.log 2>&1 &
fi

# Start sshd bound to loopback only
#
# Don't try to be clever about whether it's already running; it's easy to
# accidentally match our own command line. Starting twice is harmless (it will fail
# to bind), and we validate by probing the port from the host.
/usr/sbin/sshd -D -e -p 22 \
  -o ListenAddress=127.0.0.1 \
  -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no \
  -o ChallengeResponseAuthentication=no \
  -o PubkeyAuthentication=yes \
  -o AllowUsers=$SSH_USER \
  -o AllowAgentForwarding=no \
  -o AllowTcpForwarding=no \
  -o X11Forwarding=no \
  -o PermitTunnel=no \
  -o PermitRootLogin=prohibit-password \
  -o PidFile=/run/sshd.pid \
  >/tmp/sshd.log 2>&1 &
`;

    const setupResult = await this.exec(["/bin/sh", "-lc", setupScript]);
    if (
      setupResult.exitCode !== 0 &&
      setupResult.exitCode !== 127 &&
      setupResult.exitCode !== 126 &&
      setupResult.exitCode !== 125
    ) {
      throw new Error(
        `failed to configure ssh in guest (exit ${setupResult.exitCode}): ${setupResult.stderr.trim()}`,
      );
    }
    if (setupResult.exitCode === 127) {
      throw new Error(
        "sshd not available in guest image. Rebuild guest assets with openssh installed (default images should include it).",
      );
    }
    if (setupResult.exitCode === 126) {
      throw new Error(
        "sandboxssh not available in guest image. Rebuild guest assets to include sandboxssh.",
      );
    }
    if (setupResult.exitCode === 125) {
      throw new Error(
        `ssh user '${user}' does not exist in guest image (vm.enableSsh({ user }))`,
      );
    }

    // Verify that the virtio tcp-forwarder is working and that sshd is reachable.
    const server = this.server;
    if (!server) {
      throw new Error("sandbox server is not available");
    }

    const deadline = Date.now() + 10_000;
    let lastErr: unknown = null;

    while (Date.now() < deadline) {
      let probe: Duplex | null = null;
      try {
        const stream = await server.openTcpStream({
          host: "127.0.0.1",
          port: 22,
          timeoutMs: 2000,
        });
        probe = stream;

        // sshd sends its banner immediately after accepting a TCP connection.
        // Waiting for it makes enableSsh more reliable on slow boots.
        const banner = await new Promise<string>((resolve, reject) => {
          const onData = (chunk: Buffer) => {
            cleanup();
            resolve(chunk.toString("utf8"));
          };
          const onError = (err: Error) => {
            cleanup();
            reject(err);
          };
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("ssh banner timeout"));
          }, 1000);

          const cleanup = () => {
            clearTimeout(timeout);
            stream.off("data", onData);
            stream.off("error", onError);
          };

          stream.on("data", onData);
          stream.on("error", onError);
        });

        if (!banner.startsWith("SSH-")) {
          throw new Error(
            `unexpected ssh banner: ${JSON.stringify(banner.slice(0, 32))}`,
          );
        }

        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        probe?.destroy();
      }
    }

    if (lastErr) {
      const detail =
        lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new Error(`ssh port-forward is not available: ${detail}`);
    }

    // Create local forwarder
    const forwardServer = net.createServer((socket) => {
      socket.setNoDelay(true);
      // Ensure we always have an error handler; otherwise socket.destroy(err)
      // can turn into an uncaught exception.
      socket.on("error", () => {
        // ignore
      });

      void (async () => {
        const server = this.server;
        if (!server) {
          socket.destroy();
          return;
        }
        try {
          const tunnel = await server.openTcpStream({
            host: "127.0.0.1",
            port: 22,
          });
          tunnel.on("error", () => socket.destroy());
          socket.on("error", (err) => tunnel.destroy(err));
          socket.pipe(tunnel).pipe(socket);
        } catch {
          socket.destroy();
        }
      })();
    });

    await new Promise<void>((resolve, reject) => {
      forwardServer.once("error", reject);
      forwardServer.listen({ host: listenHost, port: listenPort }, () => {
        forwardServer.off("error", reject);
        resolve();
      });
    });

    const addr = forwardServer.address();
    if (!addr || typeof addr === "string") {
      forwardServer.close();
      throw new Error("unexpected local forward server address");
    }

    const host = listenHost;
    const port = addr.port;

    const access: SshAccess = {
      host,
      port,
      user,
      identityFile: keyPath,
      command:
        `ssh -p ${port} -i ${keyPath} ` +
        `-o ForwardAgent=no -o ClearAllForwardings=yes -o IdentitiesOnly=yes ` +
        `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${user}@${host}`,
      close: async () => {
        await new Promise<void>((resolve) =>
          forwardServer.close(() => resolve()),
        );
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        if (this.sshAccess === access) {
          this.sshAccess = null;
        }
      },
    };

    this.sshAccess = access;
    return access;
  }

  /**
   * Get the current ingress routes (parsed from /etc/gondolin/listeners).
   */
  getIngressRoutes(): IngressRoute[] {
    if (!this.gondolinEtc) return [];
    return this.gondolinEtc.listeners.getRoutes();
  }

  /**
   * Replace ingress routes and write the canonical /etc/gondolin/listeners file.
   */
  setIngressRoutes(routes: IngressRoute[]): void {
    if (!this.gondolinEtc) {
      throw new Error("/etc/gondolin mount is not available");
    }
    this.gondolinEtc.listeners.setRoutes(routes);
  }

  /**
   * Enable the host-side ingress gateway.
   *
   * The gateway listens on a single host port and routes requests to guest-local
   * HTTP servers as configured by /etc/gondolin/listeners.
   */
  async enableIngress(
    options: EnableIngressOptions = {},
  ): Promise<IngressAccess> {
    if (this.ingressAccess) return this.ingressAccess;

    await this.start();

    if (!this.gondolinEtc) {
      throw new Error(
        "ingress requires the /etc/gondolin mount. Ensure VFS is enabled and that /etc/gondolin is not overridden by a custom mount.",
      );
    }

    if (!this.server) {
      throw new Error("sandbox server is not available");
    }

    const gateway = new IngressGateway(this.server, this.gondolinEtc.listeners);
    const access = await gateway.listen(options);

    this.ingressAccess = access;

    return access;
  }

  private execInternal(command: ExecInput, options: ExecOptions): ExecProcess {
    const { cmd, argv } = normalizeCommand(command, options);
    const id = this.allocateId();

    const stdinSetting = options.stdin;
    const stdinEnabled = stdinSetting !== undefined && stdinSetting !== false;

    const stdout = resolveOutputMode(options.stdout, options.buffer, "stdout");
    const stderr = resolveOutputMode(options.stderr, options.buffer, "stderr");

    const session = createExecSession(id, {
      stdinEnabled,
      encoding: options.encoding,
      signal: options.signal,
      stdout,
      stderr,
      windowBytes: options.windowBytes,
    });

    // Setup abort handling
    if (options.signal) {
      const onAbort = () => {
        rejectExecSession(session, new Error("exec aborted"));
        this.sessions.delete(id);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      session.signalListener = onAbort;
    }

    this.sessions.set(id, session);

    // Wire up credit-based flow control
    session.sendWindowUpdate = (stdoutBytes, stderrBytes) => {
      if (stdoutBytes <= 0 && stderrBytes <= 0) return;
      try {
        this.sendJson({
          type: "exec_window",
          id,
          stdout: stdoutBytes > 0 ? stdoutBytes : undefined,
          stderr: stderrBytes > 0 ? stderrBytes : undefined,
        });
      } catch {
        // ignore (e.g. connection closed)
      }
    };

    // Create the process handle
    const proc = new ExecProcess(session, {
      sendStdin: (id, data) => this.sendStdinData(id, data),
      sendStdinEof: (id) => this.sendStdinEof(id),
      sendResize: (id, rows, cols) => this.sendPtyResize(id, rows, cols),
      cleanup: (id) => this.sessions.delete(id),
    });

    // Start the command asynchronously
    this.startExec(id, cmd, argv, options, session, stdinSetting);

    return proc;
  }

  private async startExec(
    id: number,
    cmd: string,
    argv: string[],
    options: ExecOptions,
    session: ExecSession,
    stdinSetting: ExecStdin | undefined,
  ) {
    try {
      await this.start();

      const mergedEnv = mergeEnvInputs(this.defaultEnv, options.env);

      const message = {
        type: "exec" as const,
        id,
        cmd,
        argv: argv.length ? argv : undefined,
        env: mergedEnv && mergedEnv.length ? mergedEnv : undefined,
        cwd: options.cwd,
        stdin: session.stdinEnabled ? true : undefined,
        pty: options.pty ? true : undefined,
        stdout_window: session.windowBytes,
        stderr_window: session.windowBytes,
      };

      this.sendJson(message);
      this.markSessionReady(session);

      // Pipe stdin if provided (and not just `true`)
      if (
        session.stdinEnabled &&
        stdinSetting !== true &&
        stdinSetting !== undefined
      ) {
        void this.pipeStdin(id, stdinSetting, session);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      rejectExecSession(session, error);
      this.sessions.delete(id);
    }
  }

  private ensureQemuAvailable() {
    if (this.qemuChecked) return;

    const server = this.server;
    if (!server) {
      throw new Error("sandbox server is not available");
    }

    execFileSync(server.getQemuPath(), ["--version"], { stdio: "ignore" });
    this.qemuChecked = true;
  }

  private async startInternal() {
    if (this.checkpointed) {
      throw new Error(
        "vm was checkpointed and cannot be restarted; resume the checkpoint instead",
      );
    }

    this.ensureQemuAvailable();

    if (this.server) {
      await this.server.start();
    }

    await this.ensureConnection();
    await this.ensureRunning();
    // If VFS is configured, also wait for mounts to be ready.
    await this.ensureVfsReady();
    await this.ensureSessionIpc();
  }

  private async ensureSessionIpc() {
    if (this.sessionIpc) return;

    await gcSessions().catch(() => {
      // ignore gc failures
    });

    const { socketPath } = registerSession({
      id: this.id,
      label: this.sessionLabel,
    });

    try {
      this.sessionIpc = new SessionIpcServer(
        socketPath,
        (onMessage, onClose) => {
          const server = this.server;
          if (!server) {
            throw new Error("sandbox server is not available");
          }
          return server.connect(onMessage, onClose);
        },
      );
      this.sessionIpc.start();
    } catch (err) {
      unregisterSession(this.id);
      throw err;
    }
  }

  private async closeInternal() {
    if (this.sessionIpc) {
      try {
        await this.sessionIpc.close();
      } catch {
        // ignore
      } finally {
        this.sessionIpc = null;
      }
    }

    unregisterSession(this.id);

    if (this.ingressAccess) {
      try {
        await this.ingressAccess.close();
      } catch {
        // ignore
      } finally {
        this.ingressAccess = null;
      }
    }
    if (this.sshAccess) {
      try {
        await this.sshAccess.close();
      } catch {
        // ignore
      }
    }
    if (this.server) {
      await this.server.close();
    }
    if (this.vfs) {
      await this.vfs.close();
    }
    await this.disconnect();
    this.vfsReadyPromise = null;

    // Cleanup ephemeral root disk
    if (this.rootDisk && this.rootDisk.deleteOnClose) {
      try {
        fs.rmSync(this.rootDisk.path, { force: true });
      } catch {
        // ignore
      }
    }
  }

  private allocateId(): number {
    for (let i = 0; i <= MAX_REQUEST_ID; i += 1) {
      const id = this.nextId;
      this.nextId = this.nextId + 1;
      if (this.nextId > MAX_REQUEST_ID) this.nextId = 1;
      if (!this.sessions.has(id)) return id;
    }
    throw new Error("no available request ids");
  }

  private async pipeStdin(id: number, input: ExecStdin, session: ExecSession) {
    if (!session.stdinEnabled) return;
    try {
      if (typeof input === "string" || Buffer.isBuffer(input)) {
        this.sendStdinData(id, input);
        this.sendStdinEof(id);
      } else if (typeof input === "boolean") {
        // no-op for `true`
      } else {
        for await (const chunk of toAsyncIterable(input)) {
          if (!this.sessions.has(id)) return;
          this.sendStdinData(id, chunk);
        }
        if (this.sessions.has(id)) {
          this.sendStdinEof(id);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      rejectExecSession(session, error);
      this.sessions.delete(id);
    }
  }

  private markSessionReady(session: ExecSession) {
    if (session.requestReady) return;
    session.requestReady = true;

    if (session.pendingResize) {
      const { rows, cols } = session.pendingResize;
      session.pendingResize = null;
      this.sendPtyResizeNow(session.id, rows, cols);
    }

    if (session.pendingStdin.length > 0) {
      const pending = session.pendingStdin;
      session.pendingStdin = [];
      for (const item of pending) {
        if (item.type === "data") {
          this.sendStdinDataNow(session.id, item.data);
        } else {
          this.sendStdinEofNow(session.id);
        }
      }
    }
  }

  private sendStdinData(id: number, data: Buffer | string) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (!session.requestReady) {
      session.pendingStdin.push({ type: "data", data });
      return;
    }
    this.sendStdinDataNow(id, data);
  }

  private sendStdinEof(id: number) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (!session.requestReady) {
      session.pendingStdin.push({ type: "eof" });
      return;
    }
    this.sendStdinEofNow(id);
  }

  private sendStdinDataNow(id: number, data: Buffer | string) {
    const payload =
      typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    for (
      let offset = 0;
      offset < payload.length;
      offset += DEFAULT_STDIN_CHUNK
    ) {
      const slice = payload.subarray(offset, offset + DEFAULT_STDIN_CHUNK);
      this.sendJson({
        type: "stdin",
        id,
        data: slice.toString("base64"),
      });
    }
  }

  private sendStdinEofNow(id: number) {
    this.sendJson({
      type: "stdin",
      id,
      eof: true,
    });
  }

  private sendPtyResize(id: number, rows: number, cols: number) {
    if (!Number.isFinite(rows) || !Number.isFinite(cols)) return;
    const session = this.sessions.get(id);
    if (!session) return;
    const safeRows = Math.max(1, Math.trunc(rows));
    const safeCols = Math.max(1, Math.trunc(cols));
    if (!session.requestReady) {
      session.pendingResize = { rows: safeRows, cols: safeCols };
      return;
    }
    this.sendPtyResizeNow(id, safeRows, safeCols);
  }

  private sendPtyResizeNow(id: number, rows: number, cols: number) {
    if (!this.connection) return;
    this.sendJson({
      type: "pty_resize",
      id,
      rows,
      cols,
    });
  }

  private async ensureConnection() {
    if (this.connection) return;
    if (this.connectPromise) return this.connectPromise;
    const server = this.server;
    if (!server) {
      throw new Error("sandbox server is not available");
    }

    this.resetConnectionState();

    this.connectPromise = (async () => {
      await server.start();
      this.connection = server.connect(
        (data, isBinary) => {
          this.handleMessage(data, isBinary);
        },
        () => {
          this.handleDisconnect(new Error("sandbox connection closed"));
        },
      );
    })().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private resetConnectionState() {
    this.state = "unknown";
    this.bootSent = false;
    this.vfsReadyPromise = null;
    this.initStatusPromise();
  }

  private initStatusPromise() {
    this.statusPromise = new Promise((resolve, reject) => {
      this.statusResolve = resolve;
      this.statusReject = reject;
    });
  }

  private ensureBoot() {
    if (this.bootSent) return;
    this.bootSent = true;
    this.state = "unknown";
    this.initStatusPromise();
    this.sendJson({
      type: "boot",
      fuseMount: this.fuseMount,
      fuseBinds: this.fuseBinds,
    });
  }

  private async ensureRunning() {
    const state = await this.waitForStatus();
    if (state === "stopped" && !this.autoStart) {
      throw new Error("sandbox is stopped");
    }

    this.ensureBoot();

    const nextState = await this.waitForStatus();
    if (nextState === "running") return;

    await this.waitForState("running");
  }

  private async ensureVfsReady() {
    if (!this.vfs) return;
    if (!this.vfsReadyPromise) {
      this.vfsReadyPromise = this.waitForVfsReadyInternal().catch((error) => {
        this.vfsReadyPromise = null;
        throw error;
      });
    }
    await this.vfsReadyPromise;
  }

  private async waitForVfsReadyInternal() {
    await this.waitForMount(this.fuseMount, "fuse.sandboxfs");
    for (const mountPoint of this.fuseBinds) {
      await this.waitForBindMount(mountPoint);
    }
  }

  private async waitForMount(mountPoint: string, fsType?: string) {
    const mountCheck = fsType
      ? `grep -q " $1 ${fsType} " /proc/mounts`
      : `grep -q " $1 " /proc/mounts`;
    const script = `for i in $(seq 1 ${VFS_READY_ATTEMPTS}); do ${mountCheck} && exit 0; sleep ${VFS_READY_SLEEP_SECONDS}; done; exit 1`;

    // Use internal exec that bypasses VFS check
    const result = await this.execInternalNoVfsWait([
      "/bin/sh",
      "-c",
      script,
      "sh",
      mountPoint,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `vfs mount ${mountPoint} not ready (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  private async waitForBindMount(mountPoint: string) {
    if (mountPoint === this.fuseMount) return;
    if (this.fuseMount === "/") {
      await this.waitForPath(mountPoint);
      return;
    }

    const source = `${this.fuseMount}${mountPoint}`;
    const script = `for i in $(seq 1 ${VFS_READY_ATTEMPTS}); do if grep -q " $1 " /proc/mounts; then exit 0; fi; mkdir -p "$1"; mount --bind "$2" "$1" > /dev/null 2>&1 || true; sleep ${VFS_READY_SLEEP_SECONDS}; done; exit 1`;

    const result = await this.execInternalNoVfsWait([
      "/bin/sh",
      "-c",
      script,
      "sh",
      mountPoint,
      source,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `vfs mount ${mountPoint} not ready (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  private async waitForPath(entryPath: string) {
    const script = `for i in $(seq 1 ${VFS_READY_ATTEMPTS}); do [ -e "$1" ] && exit 0; sleep ${VFS_READY_SLEEP_SECONDS}; done; exit 1`;
    const result = await this.execInternalNoVfsWait([
      "/bin/sh",
      "-c",
      script,
      "sh",
      entryPath,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `vfs path ${entryPath} not ready (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  private async execInternalNoVfsWait(command: ExecInput): Promise<ExecResult> {
    const { cmd, argv } = normalizeCommand(command, {});
    const id = this.allocateId();

    const session = createExecSession(id, {
      stdinEnabled: false,
      stdout: { mode: "buffer" },
      stderr: { mode: "buffer" },
    });

    this.sessions.set(id, session);
    session.sendWindowUpdate = (stdoutBytes, stderrBytes) => {
      if (stdoutBytes <= 0 && stderrBytes <= 0) return;
      try {
        this.sendJson({
          type: "exec_window",
          id,
          stdout: stdoutBytes > 0 ? stdoutBytes : undefined,
          stderr: stderrBytes > 0 ? stderrBytes : undefined,
        });
      } catch {
        // ignore
      }
    };

    const message = {
      type: "exec" as const,
      id,
      cmd,
      argv: argv.length ? argv : undefined,
      stdout_window: session.windowBytes,
      stderr_window: session.windowBytes,
    };

    try {
      this.sendJson(message);
      this.markSessionReady(session);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.sessions.delete(id);
      rejectExecSession(session, error);
    }

    return session.resultPromise;
  }

  private async waitForStatus(): Promise<SandboxState> {
    if (this.state !== "unknown") return this.state;
    if (!this.statusPromise) {
      this.initStatusPromise();
    }
    return this.statusPromise!;
  }

  private waitForState(state: SandboxState): Promise<void> {
    if (this.state === state) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.stateWaiters.push({ state, resolve, reject });
    });
  }

  private handleMessage(data: Buffer | string, isBinary: boolean) {
    if (isBinary) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const frame = decodeOutputFrame(buffer);
      const session = this.sessions.get(frame.id);
      if (!session) return;
      applyOutputChunk(session, frame.stream, frame.data);
      return;
    }

    let message: StatusMessage | ExecResponseMessage | ErrorMessage;
    try {
      message = JSON.parse(
        typeof data === "string" ? data : data.toString(),
      ) as StatusMessage | ExecResponseMessage | ErrorMessage;
    } catch {
      return;
    }

    if (message.type === "status") {
      this.updateState(message.state);
      return;
    }

    if (message.type === "exec_response") {
      this.handleExecResponse(message);
      return;
    }

    if (message.type === "error") {
      this.handleError(message);
    }
  }

  private updateState(state: SandboxState) {
    this.state = state;

    if (this.statusResolve) {
      this.statusResolve(state);
      this.statusResolve = null;
      this.statusReject = null;
      this.statusPromise = null;
    }

    if (this.stateWaiters.length > 0) {
      const remaining: typeof this.stateWaiters = [];
      for (const waiter of this.stateWaiters) {
        if (waiter.state === state) {
          waiter.resolve();
        } else {
          remaining.push(waiter);
        }
      }
      this.stateWaiters = remaining;
    }
  }

  private handleExecResponse(message: ExecResponseMessage) {
    const session = this.sessions.get(message.id);
    if (!session) return;
    this.sessions.delete(message.id);
    finishExecSession(session, message.exit_code ?? 1, message.signal);
  }

  private handleError(message: ErrorMessage) {
    const error = new Error(`error ${message.code}: ${message.message}`);
    if (message.id === undefined) {
      this.rejectAll(error);
      return;
    }
    const session = this.sessions.get(message.id);
    if (session) {
      this.sessions.delete(message.id);
      rejectExecSession(session, error);
    }
  }

  private rejectAll(error: Error) {
    for (const session of this.sessions.values()) {
      rejectExecSession(session, error);
    }
    this.sessions.clear();
  }

  private handleDisconnect(error?: Error) {
    this.connection = null;
    const disconnectError =
      error ?? new Error("sandbox connection disconnected");
    if (this.statusReject) {
      this.statusReject(disconnectError);
      this.statusReject = null;
      this.statusResolve = null;
      this.statusPromise = null;
    }
    if (this.stateWaiters.length > 0) {
      for (const waiter of this.stateWaiters) {
        waiter.reject(disconnectError);
      }
      this.stateWaiters = [];
    }
    this.rejectAll(disconnectError);
  }

  private async disconnect() {
    if (!this.connection) return;

    const connection = this.connection;
    this.connection = null;
    connection.close();
  }

  /**
   * Create a disk-only checkpoint of the VM root disk.
   *
   * This stops the VM and materializes its writable qcow2 overlay at
   * `checkpointPath`.
   *
   * The checkpoint metadata is stored as a JSON trailer appended to the qcow2
   * file so the checkpoint is a single file.
   */
  async checkpoint(checkpointPath: string): Promise<VmCheckpoint> {
    if (!checkpointPath) {
      throw new Error("checkpointPath is required");
    }
    if (!path.isAbsolute(checkpointPath)) {
      throw new Error(
        `checkpointPath must be an absolute path (got: ${checkpointPath})`,
      );
    }

    const rootDisk = this.rootDisk;
    if (!rootDisk) {
      throw new Error("vm has no root disk");
    }
    if (rootDisk.snapshot) {
      throw new Error(
        "cannot checkpoint: root disk is running in qemu snapshot mode",
      );
    }
    if (rootDisk.format !== "qcow2") {
      throw new Error(
        `cannot checkpoint: root disk must be qcow2 (got ${rootDisk.format})`,
      );
    }

    // Ensure the disk isn't deleted by close().
    rootDisk.deleteOnClose = false;

    // Best-effort flush of guest filesystem buffers so the checkpoint captures
    // recent writes even though we currently stop QEMU abruptly.
    if (this.server && this.server.getState() === "running") {
      try {
        await this.exec(["/bin/sh", "-c", "sync; sync"]);
      } catch {
        // ignore
      }
    }

    await this.close();

    const resolvedCheckpointPath = path.resolve(checkpointPath);
    fs.mkdirSync(path.dirname(resolvedCheckpointPath), { recursive: true });
    fs.rmSync(resolvedCheckpointPath, { force: true });

    moveFile(rootDisk.path, resolvedCheckpointPath);

    const checkpointName = path.basename(
      resolvedCheckpointPath,
      path.extname(resolvedCheckpointPath),
    );

    const guestAssets = {
      kernelPath: this.resolvedSandboxOptions.kernelPath,
      initrdPath: this.resolvedSandboxOptions.initrdPath,
      rootfsPath: this.resolvedSandboxOptions.rootfsPath,
    };

    const commonDir =
      path.dirname(guestAssets.kernelPath) ===
        path.dirname(guestAssets.initrdPath) &&
      path.dirname(guestAssets.kernelPath) ===
        path.dirname(guestAssets.rootfsPath)
        ? path.dirname(guestAssets.kernelPath)
        : null;

    const manifest = commonDir ? loadAssetManifest(commonDir) : null;
    const guestAssetBuildId = manifest?.buildId;

    if (!guestAssetBuildId) {
      throw new Error(
        "cannot checkpoint: guest assets are missing manifest buildId (rebuild guest assets with a newer gondolin build)",
      );
    }

    const data: VmCheckpointData = {
      version: 1,
      name: checkpointName,
      createdAt: new Date().toISOString(),
      // Kept for schema compatibility (ignored for single-file checkpoints)
      diskFile: path.basename(resolvedCheckpointPath),
      guestAssetBuildId,
    };

    VmCheckpoint.writeTrailer(resolvedCheckpointPath, data);

    // Mark this VM as consumed.
    this.rootDisk = null;
    this.checkpointed = true;

    return new VmCheckpoint(
      resolvedCheckpointPath,
      data,
      this.baseOptionsForClone,
      { isDirectory: false },
    );
  }

  private sendJson(message: ClientMessage) {
    if (!this.connection) {
      throw new Error("sandbox connection is not available");
    }
    this.connection.send(message);
  }
}

function resolveAbsoluteGuestPath(
  filePath: string,
  cwd?: string,
): string | null {
  if (filePath.startsWith("/")) {
    return normalizeVfsPath(filePath);
  }
  if (!cwd || !cwd.startsWith("/")) {
    return null;
  }
  return normalizeVfsPath(path.posix.join(cwd, filePath));
}

function normalizePositiveInt(
  value: number | undefined,
  fallback?: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function assertNotAborted(
  signal: AbortSignal | undefined,
  message: string,
): void {
  if (signal?.aborted) {
    throw new Error(message);
  }
}

type ResolvedVfs = {
  provider: SandboxVfsProvider | null;
  mounts: Record<string, VirtualProvider>;
};

function resolveVmVfs(
  options?: VmVfsOptions | null,
  injectedMounts?: Record<string, VirtualProvider>,
): ResolvedVfs {
  if (options === null) {
    return { provider: null, mounts: {} };
  }
  const hooks = options?.hooks ?? {};
  const mounts: Record<string, VirtualProvider> = {
    ...(options?.mounts ?? {}),
  };

  if (injectedMounts) {
    for (const [mountPath, provider] of Object.entries(injectedMounts)) {
      if (!(mountPath in mounts)) {
        mounts[mountPath] = provider;
      }
    }
  }

  const mountKeys = Object.keys(mounts);
  if (mountKeys.length === 0) {
    return { provider: wrapProvider(new MemoryProvider(), hooks), mounts };
  }

  const normalized = normalizeMountMap(mounts);
  let provider: VirtualProvider;
  if (normalized.size === 1 && normalized.has("/")) {
    provider = normalized.get("/")!;
  } else {
    provider = new MountRouterProvider(normalized);
  }

  return { provider: wrapProvider(provider, hooks), mounts };
}

function resolveFuseConfig(
  options?: VmVfsOptions | null,
  mounts?: Record<string, VirtualProvider>,
) {
  const fuseMount = normalizeMountPath(options?.fuseMount ?? "/data");
  const mountPaths = listMountPaths(mounts ?? options?.mounts);
  const fuseBinds = mountPaths.filter((mountPath) => mountPath !== "/");
  return { fuseMount, fuseBinds };
}

/** @internal */
// Expose internal helpers for unit tests. Not part of the public API.
export const __test = {
  normalizeCommand,
  resolveVmVfs,
  resolveFuseConfig,
  resolveMitmMounts,
  createMitmCaProvider,
  composeVfsHooks,
  buildShellEnv,
  mergeEnvInputs,
  envInputToEntries,
  parseEnvEntry,
  mapToEnvArray,
};

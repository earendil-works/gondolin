import { Readable } from "stream";

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
  resolveSandboxServerOptionsAsync,
  type ResolvedSandboxServerOptions,
  type SandboxConnection,
} from "./sandbox-server";
import type { SandboxState } from "./sandbox-controller";
import type { HttpFetch, HttpHooks } from "./qemu-net";
import {
  MemoryProvider,
  SandboxVfsProvider,
  VirtualProvider,
  type VfsHooks,
} from "./vfs";
import { loadOrCreateMitmCaSync, resolveMitmCertDir } from "./mitm";
import { parseDebugEnv } from "./debug";
import {
  MountRouterProvider,
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
} from "./exec";

const MAX_REQUEST_ID = 0xffffffff;
const DEFAULT_STDIN_CHUNK = 32 * 1024;
const DEFAULT_VFS_READY_TIMEOUT_MS = 30000;
const VFS_READY_SLEEP_SECONDS = resolveEnvNumber(
  "GONDOLIN_VFS_READY_SLEEP_SECONDS",
  0.1
);
const VFS_READY_TIMEOUT_MS = resolveEnvNumber(
  "GONDOLIN_VFS_READY_TIMEOUT_MS",
  DEFAULT_VFS_READY_TIMEOUT_MS
);
const VFS_READY_ATTEMPTS = Math.max(
  1,
  Math.ceil(VFS_READY_TIMEOUT_MS / (VFS_READY_SLEEP_SECONDS * 1000))
);

function formatLog(message: string) {
  if (message.endsWith("\n")) return message;
  return `${message}\n`;
}

function resolveEnvNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

type ExecInput = string | string[];

type EnvInput = string[] | Record<string, string>;

type ExecStdin = boolean | string | Buffer | Readable | AsyncIterable<Buffer>;

export type VmVfsOptions = {
  mounts?: Record<string, VirtualProvider>;
  hooks?: VfsHooks;
  fuseMount?: string;
};

export type VMOptions = {
  server?: SandboxServerOptions;
  autoStart?: boolean;
  fetch?: HttpFetch;
  httpHooks?: HttpHooks;
  maxHttpBodyBytes?: number;
  vfs?: VmVfsOptions | null;
  env?: EnvInput;
  /** Maximum memory for the VM (e.g., "1G", "512M"). Default: "1G" */
  memory?: string;
  /** Number of CPU cores for the VM. Default: 2 */
  cpus?: number;
};

export type ShellOptions = {
  /** Command to run (default: bash) */
  command?: string | string[];
  /** Environment variables */
  env?: EnvInput;
  /** Working directory */
  cwd?: string;
  /** Abort signal */
  signal?: AbortSignal;
  /** 
   * Auto-attach to process stdin/stdout/stderr.
   * Default: true when running in a TTY
   */
  attach?: boolean;
};

// Re-export types from exec.ts
export { ExecProcess, ExecResult, ExecOptions } from "./exec";

export type VMState = SandboxState | "unknown";

export class VM {
  private readonly autoStart: boolean;
  private server: SandboxServer | null;
  private readonly defaultEnv: EnvInput | undefined;
  private connection: SandboxConnection | null = null;
  private connectPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
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
  private bootSent = false;
  private vfsReadyPromise: Promise<void> | null = null;

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
    // Resolve server options with async asset fetching
    const serverOptions: SandboxServerOptions = { ...options.server };

    // Build the combined server options
    if (options.fetch && serverOptions.fetch === undefined) {
      serverOptions.fetch = options.fetch;
    }
    if (options.httpHooks && serverOptions.httpHooks === undefined) {
      serverOptions.httpHooks = options.httpHooks;
    }
    if (options.maxHttpBodyBytes !== undefined && serverOptions.maxHttpBodyBytes === undefined) {
      serverOptions.maxHttpBodyBytes = options.maxHttpBodyBytes;
    }
    if (options.memory && serverOptions.memory === undefined) {
      serverOptions.memory = options.memory;
    }
    if (options.cpus && serverOptions.cpus === undefined) {
      serverOptions.cpus = options.cpus;
    }

    // Resolve options with asset fetching
    const resolvedServerOptions = await resolveSandboxServerOptionsAsync(serverOptions);

    // Create VM with pre-resolved options
    return new VM(options, resolvedServerOptions);
  }

  /**
   * Create a VM instance synchronously.
   *
   * This constructor requires that guest assets are available locally (either
   * in a development checkout or via GONDOLIN_GUEST_DIR). For automatic asset
   * downloading, use the async `VM.create()` factory instead.
   *
   * @param options VM configuration options
   * @param resolvedServerOptions Optional pre-resolved server options (from VM.create())
   */
  constructor(options: VMOptions = {}, resolvedServerOptions?: ResolvedSandboxServerOptions) {
    this.autoStart = options.autoStart ?? true;
    const mitmMounts = resolveMitmMounts(
      options.vfs,
      options.server?.mitmCertDir,
      options.server?.netEnabled ?? true
    );
    const resolvedVfs = resolveVmVfs(options.vfs, mitmMounts);
    this.vfs = resolvedVfs.provider;
    this.defaultEnv = options.env;
    let fuseMounts = resolvedVfs.mounts;
    let fuseConfig = resolveFuseConfig(options.vfs, fuseMounts);
    this.fuseMount = fuseConfig.fuseMount;
    this.fuseBinds = fuseConfig.fuseBinds;

    const serverOptions: SandboxServerOptions = { ...options.server };
    if (serverOptions.vfsProvider && options.vfs) {
      throw new Error("VM cannot specify both vfs and server.vfsProvider");
    }
    if (serverOptions.vfsProvider) {
      const injectedMounts = resolveMitmMounts(
        undefined,
        serverOptions.mitmCertDir,
        serverOptions.netEnabled ?? true
      );
      if (Object.keys(injectedMounts).length > 0) {
        const normalized = normalizeMountMap({
          "/": serverOptions.vfsProvider,
          ...injectedMounts,
        });
        this.vfs = wrapProvider(new MountRouterProvider(normalized), {});
        fuseMounts = { "/": serverOptions.vfsProvider, ...injectedMounts };
      } else {
        this.vfs = wrapProvider(serverOptions.vfsProvider, {});
        fuseMounts = { "/": serverOptions.vfsProvider };
      }
      fuseConfig = resolveFuseConfig(options.vfs, fuseMounts);
      this.fuseMount = fuseConfig.fuseMount;
      this.fuseBinds = fuseConfig.fuseBinds;
      serverOptions.vfsProvider = this.vfs;
    }
    if (options.fetch && serverOptions.fetch === undefined) {
      serverOptions.fetch = options.fetch;
    }
    if (options.httpHooks && serverOptions.httpHooks === undefined) {
      serverOptions.httpHooks = options.httpHooks;
    }
    if (options.maxHttpBodyBytes !== undefined && serverOptions.maxHttpBodyBytes === undefined) {
      serverOptions.maxHttpBodyBytes = options.maxHttpBodyBytes;
    }
    if (this.vfs && serverOptions.vfsProvider === undefined) {
      serverOptions.vfsProvider = this.vfs;
    }
    if (options.memory && serverOptions.memory === undefined) {
      serverOptions.memory = options.memory;
    }
    if (options.cpus && serverOptions.cpus === undefined) {
      serverOptions.cpus = options.cpus;
    }

    const debugFlags = parseDebugEnv();
    const netDebug = serverOptions.netDebug ?? debugFlags.has("net");
    if (netDebug !== undefined) {
      serverOptions.netDebug = netDebug;
    }

    // Handle VFS in resolved options
    if (resolvedServerOptions) {
      // Merge VFS provider into resolved options
      if (this.vfs) {
        (resolvedServerOptions as any).vfsProvider = this.vfs;
      }
      this.server = new SandboxServer(resolvedServerOptions);
    } else {
      this.server = new SandboxServer(serverOptions);
    }
    if (netDebug) {
      this.server.on("log", (message: string) => {
        process.stderr.write(formatLog(message));
      });
      this.server.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(formatLog(message));
      });
    }
  }

  /**
   * Start the VM.
   *
   * If VFS is configured, this also waits for the VFS mount(s) to be ready.
   */
  async start() {
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  /**
   * Close the VM and release associated resources.
   */
  async close() {
    if (this.closePromise) return this.closePromise;

    this.closePromise = this.closeInternal().finally(() => {
      this.closePromise = null;
    });

    return this.closePromise;
  }

  /**
   * Execute a command in the sandbox.
   * 
   * Returns an ExecProcess which can be:
   * - awaited for a buffered result with strings
   * - iterated for streaming output
   * - used with stdin via write()/end()
   * 
   * @example
   * ```typescript
   * // Simple command - await for result
   * const result = await vm.exec(['echo', 'hello']);
   * console.log(result.stdout); // 'hello\n'
   * 
   * // Streaming output
   * for await (const line of vm.exec(['tail', '-f', '/var/log/syslog'])) {
   *   console.log(line);
   * }
   * 
   * // Interactive with stdin
   * const proc = vm.exec(['cat'], { stdin: true });
   * proc.write('hello\n');
   * proc.end();
   * const result = await proc;
   * ```
   */
  exec(command: ExecInput, options: ExecOptions = {}): ExecProcess {
    const proc = this.execInternal(command, options);
    return proc;
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
   * // Custom command
   * const result = await vm.shell({ command: 'python3' });
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
    const command = options.command ?? ["bash", "-i"];
    const shouldAttach = options.attach ?? process.stdin.isTTY;

    const env = buildShellEnv(this.defaultEnv, options.env);

    const proc = this.exec(command, {
      env,
      cwd: options.cwd,
      stdin: true,
      pty: true,
      signal: options.signal,
    });

    if (shouldAttach) {
      proc.attach(
        process.stdin as NodeJS.ReadStream,
        process.stdout as NodeJS.WriteStream,
        process.stderr as NodeJS.WriteStream
      );
    }

    return proc;
  }

  private execInternal(command: ExecInput, options: ExecOptions): ExecProcess {
    const { cmd, argv } = normalizeCommand(command, options);
    const id = this.allocateId();

    const stdinSetting = options.stdin;
    const stdinEnabled = stdinSetting !== undefined && stdinSetting !== false;

    const session = createExecSession(id, {
      stdinEnabled,
      encoding: options.encoding,
      signal: options.signal,
      buffer: options.buffer,
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
    stdinSetting: ExecStdin | undefined
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
      };

      this.sendJson(message);
      this.markSessionReady(session);

      // Pipe stdin if provided (and not just `true`)
      if (session.stdinEnabled && stdinSetting !== true && stdinSetting !== undefined) {
        void this.pipeStdin(id, stdinSetting, session);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      rejectExecSession(session, error);
      this.sessions.delete(id);
    }
  }

  private async startInternal() {
    if (this.server) {
      await this.server.start();
    }

    await this.ensureConnection();
    await this.ensureRunning();
    // If VFS is configured, also wait for mounts to be ready.
    await this.ensureVfsReady();
  }

  private async closeInternal() {
    if (this.server) {
      await this.server.close();
    }
    if (this.vfs) {
      await this.vfs.close();
    }
    await this.disconnect();
    this.vfsReadyPromise = null;
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
    const payload = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    for (let offset = 0; offset < payload.length; offset += DEFAULT_STDIN_CHUNK) {
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
        }
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
    const result = await this.execInternalNoVfsWait(["sh", "-c", script, "sh", mountPoint]);
    if (result.exitCode !== 0) {
      throw new Error(
        `vfs mount ${mountPoint} not ready (exit ${result.exitCode}): ${result.stderr.trim()}`
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
      "sh",
      "-c",
      script,
      "sh",
      mountPoint,
      source,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `vfs mount ${mountPoint} not ready (exit ${result.exitCode}): ${result.stderr.trim()}`
      );
    }
  }

  private async waitForPath(entryPath: string) {
    const script = `for i in $(seq 1 ${VFS_READY_ATTEMPTS}); do [ -e "$1" ] && exit 0; sleep ${VFS_READY_SLEEP_SECONDS}; done; exit 1`;
    const result = await this.execInternalNoVfsWait(["sh", "-c", script, "sh", entryPath]);
    if (result.exitCode !== 0) {
      throw new Error(
        `vfs path ${entryPath} not ready (exit ${result.exitCode}): ${result.stderr.trim()}`
      );
    }
  }

  private async execInternalNoVfsWait(command: ExecInput): Promise<ExecResult> {
    const { cmd, argv } = normalizeCommand(command, {});
    const id = this.allocateId();

    const session = createExecSession(id, {
      stdinEnabled: false,
    });

    this.sessions.set(id, session);

    const message = {
      type: "exec" as const,
      id,
      cmd,
      argv: argv.length ? argv : undefined,
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
      if (frame.stream === "stdout") {
        if (session.buffer && !session.iterating) {
          session.stdoutChunks.push(frame.data);
        }
        session.stdout.write(frame.data);
      } else {
        if (session.buffer && !session.iterating) {
          session.stderrChunks.push(frame.data);
        }
        session.stderr.write(frame.data);
      }
      return;
    }

    let message: StatusMessage | ExecResponseMessage | ErrorMessage;
    try {
      message = JSON.parse(typeof data === "string" ? data : data.toString()) as
        | StatusMessage
        | ExecResponseMessage
        | ErrorMessage;
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
    const disconnectError = error ?? new Error("sandbox connection disconnected");
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

  private sendJson(message: ClientMessage) {
    if (!this.connection) {
      throw new Error("sandbox connection is not available");
    }
    this.connection.send(message);
  }
}

function normalizeCommand(command: ExecInput, options: ExecOptions): {
  cmd: string;
  argv: string[];
} {
  if (Array.isArray(command)) {
    if (command.length === 0) {
      throw new Error("command array must include the executable");
    }
    return { cmd: command[0], argv: command.slice(1) };
  }

  return { cmd: command, argv: options.argv ?? [] };
}

type ResolvedVfs = {
  provider: SandboxVfsProvider | null;
  mounts: Record<string, VirtualProvider>;
};

function resolveVmVfs(
  options?: VmVfsOptions | null,
  injectedMounts?: Record<string, VirtualProvider>
): ResolvedVfs {
  if (options === null) {
    return { provider: null, mounts: {} };
  }
  const hooks = options?.hooks ?? {};
  const mounts: Record<string, VirtualProvider> = { ...(options?.mounts ?? {}) };

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

function wrapProvider(provider: VirtualProvider, hooks: VfsHooks) {
  if (provider instanceof SandboxVfsProvider) return provider;
  return new SandboxVfsProvider(provider, hooks);
}

function resolveFuseConfig(
  options?: VmVfsOptions | null,
  mounts?: Record<string, VirtualProvider>
) {
  const fuseMount = normalizeMountPath(options?.fuseMount ?? "/data");
  const mountPaths = listMountPaths(mounts ?? options?.mounts);
  const fuseBinds = mountPaths.filter((mountPath) => mountPath !== "/");
  return { fuseMount, fuseBinds };
}

function resolveMitmMounts(
  options?: VmVfsOptions | null,
  mitmCertDir?: string,
  netEnabled = true
): Record<string, VirtualProvider> {
  if (options === null || !netEnabled) return {};

  const mountPaths = listMountPaths(options?.mounts);
  if (mountPaths.includes("/etc/ssl/certs")) {
    return {};
  }

  return {
    "/etc/ssl/certs": createMitmCaProvider(mitmCertDir),
  };
}

function createMitmCaProvider(mitmCertDir?: string): VirtualProvider {
  const resolvedDir = resolveMitmCertDir(mitmCertDir);
  const ca = loadOrCreateMitmCaSync(resolvedDir);
  const provider = new MemoryProvider();
  const certPem = ca.certPem.endsWith("\n") ? ca.certPem : `${ca.certPem}\n`;
  const handle = provider.openSync("/ca-certificates.crt", "w");
  try {
    handle.writeFileSync(certPem);
  } finally {
    handle.closeSync();
  }
  provider.setReadOnly();
  return provider;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Buffer> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<Buffer>)[Symbol.asyncIterator] === "function"
  );
}

async function* toAsyncIterable(value: ExecStdin): AsyncIterable<Buffer> {
  if (typeof value === "string" || Buffer.isBuffer(value) || typeof value === "boolean") {
    return;
  }

  if (isAsyncIterable(value)) {
    for await (const chunk of value) {
      yield Buffer.from(chunk);
    }
    return;
  }

  if (value instanceof Readable) {
    for await (const chunk of value) {
      yield Buffer.from(chunk as Buffer);
    }
    return;
  }

  throw new Error("unsupported stdin type");
}

function buildShellEnv(baseEnv?: EnvInput, extraEnv?: EnvInput): string[] | undefined {
  const envMap = mergeEnvMap(baseEnv, extraEnv);
  if (envMap.size === 0) {
    const term = resolveTermValue();
    return term ? [`TERM=${term}`] : undefined;
  }

  if (!envMap.has("TERM")) {
    const term = resolveTermValue();
    if (term) envMap.set("TERM", term);
  }

  return mapToEnvArray(envMap);
}

function resolveTermValue(): string | null {
  const term = process.env.TERM;
  if (!term || term === "xterm-ghostty") {
    return "xterm-256color";
  }
  return term;
}

function mergeEnvInputs(baseEnv?: EnvInput, extraEnv?: EnvInput): string[] | undefined {
  const envMap = mergeEnvMap(baseEnv, extraEnv);
  return envMap.size > 0 ? mapToEnvArray(envMap) : undefined;
}

function mergeEnvMap(baseEnv?: EnvInput, extraEnv?: EnvInput): Map<string, string> {
  const envMap = new Map<string, string>();
  for (const [key, value] of envInputToEntries(baseEnv)) {
    envMap.set(key, value);
  }
  for (const [key, value] of envInputToEntries(extraEnv)) {
    envMap.set(key, value);
  }
  return envMap;
}

function envInputToEntries(env?: EnvInput): Array<[string, string]> {
  if (!env) return [];
  if (Array.isArray(env)) {
    return env.map(parseEnvEntry);
  }
  return Object.entries(env);
}

function parseEnvEntry(entry: string): [string, string] {
  const idx = entry.indexOf("=");
  if (idx === -1) return [entry, ""];
  return [entry.slice(0, idx), entry.slice(idx + 1)];
}

function mapToEnvArray(envMap: Map<string, string>): string[] {
  return Array.from(envMap.entries(), ([key, value]) => `${key}=${value}`);
}

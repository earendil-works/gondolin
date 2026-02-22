import os from "os";
import { EventEmitter } from "events";
import { Duplex, PassThrough, Readable } from "stream";

import { getHostNodeArchCached } from "../host/arch";
import { AsyncSingleflight } from "../async-utils";
import { toBufferIterable } from "../buffer-iter";
import {
  buildExecRequest,
  buildPtyResize,
  buildStdinData,
  buildExecWindow,
  buildFileDeleteRequest,
  buildFileReadRequest,
  buildFileWriteData,
  buildFileWriteRequest,
} from "../virtio-protocol";
import {
  BootCommandMessage,
  ClientMessage,
  ExecCommandMessage,
  ExecWindowCommandMessage,
  PtyResizeCommandMessage,
  StdinCommandMessage,
  encodeOutputFrame,
} from "../control-protocol";
import {
  SandboxController,
  SandboxConfig,
  SandboxState,
  type SandboxLogStream,
} from "./controller";
import { QemuNetworkBackend } from "../qemu/net";
import { FsRpcService } from "../vfs/rpc-service";
import { SandboxVfsProvider } from "../vfs/provider";
import {
  stripTrailingNewline,
  type DebugComponent,
  type DebugFlag,
} from "../debug";
import {
  type GuestFileDeleteOptions,
  type GuestFileReadOptions,
  type GuestFileWriteOptions,
  type ResolvedSandboxServerOptions,
  type SandboxServerOptions,
  resolveSandboxServerOptions,
  resolveSandboxServerOptionsAsync,
} from "./server-options";
import {
  MAX_REQUEST_ID,
  TcpForwardStream,
  VirtioBridge,
  estimateBase64Bytes,
  isValidRequestId,
  parseMac,
} from "./server-transport";
import {
  type SandboxClient,
  type SandboxConnection,
  LocalSandboxClient,
  sendBinary,
  sendError,
  sendJson,
} from "./client";
import {
  buildSandboxfsAppend,
  isSameSandboxFsConfig,
  normalizeSandboxFsConfig,
  type SandboxFsConfig,
} from "./server-boot-config";
import { SandboxServerOps, installSandboxServerOps } from "./server-ops";

const DEFAULT_MAX_STDIN_BYTES = 64 * 1024;
const { errno: ERRNO } = os.constants;

type FileReadOperation = {
  /** file operation kind */
  kind: "read";
  /** output stream for read chunks */
  stream: PassThrough;
  /** resolve callback for completion */
  resolve: () => void;
  /** reject callback for errors */
  reject: (err: Error) => void;
};

type FileDoneOperation = {
  /** file operation kind */
  kind: "write" | "delete";
  /** resolve callback for completion */
  resolve: () => void;
  /** reject callback for errors */
  reject: (err: Error) => void;
};

type FileOperation = FileReadOperation | FileDoneOperation;

type BridgeWritableWaiter = {
  /** resolve callback when the bridge accepts more data */
  resolve: () => void;
  /** reject callback when waiting is aborted */
  reject: (err: Error) => void;
  /** abort listener cleanup */
  cleanup?: () => void;
};

export class SandboxServer extends EventEmitter {
  private emitDebug(component: DebugComponent, message: string) {
    const normalized = stripTrailingNewline(message);
    this.emit("debug", component, normalized);
    // Legacy string log event
    this.emit(
      "log",
      `[${component}] ${normalized}` + (message.endsWith("\n") ? "\n" : ""),
    );
  }

  private normalizeQemuHintLine(line: string): string | null {
    let normalized = stripTrailingNewline(line).trimEnd();
    if (!normalized) return null;

    // Avoid leaking control sequences / non-printable bytes into client-visible
    // error messages. This is especially important when QEMU is configured with
    // -serial stdio, where stdout may contain untrusted guest console output.
    normalized = normalized
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // ANSI CSI
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "") // ANSI OSC
      // Strip C0 control characters (except TAB) + DEL
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .replace(/\r/g, "");

    normalized = normalized.trimEnd();
    if (!normalized) return null;
    return normalized;
  }

  private recordQemuLogLine(line: string) {
    const normalized = this.normalizeQemuHintLine(line);
    if (!normalized) return;
    this.qemuLogTail.push(normalized);
    // Keep a small tail so error messages can include likely root causes.
    if (this.qemuLogTail.length > 50) {
      this.qemuLogTail.splice(0, this.qemuLogTail.length - 50);
    }
  }

  private formatQemuLogHint(): string {
    if (this.qemuLogTail.length === 0) return "";
    const last = this.qemuLogTail[this.qemuLogTail.length - 1]!;
    const truncated = last.length > 300 ? last.slice(0, 300) + "…" : last;
    return ` (qemu: ${truncated})`;
  }

  private readonly debugFlags: ReadonlySet<DebugFlag>;

  private hasDebug(flag: DebugFlag) {
    return this.debugFlags.has(flag);
  }

  private readonly options: ResolvedSandboxServerOptions;
  private readonly controller: SandboxController;
  private readonly bridge: VirtioBridge;
  private readonly fsBridge: VirtioBridge;
  private readonly sshBridge: VirtioBridge;
  private readonly ingressBridge: VirtioBridge;
  private readonly network: QemuNetworkBackend | null;

  private tcpStreams = new Map<number, TcpForwardStream>();
  private tcpOpenWaiters = new Map<
    number,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  private nextTcpStreamId = 1;

  private ingressTcpStreams = new Map<number, TcpForwardStream>();
  private ingressTcpOpenWaiters = new Map<
    number,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  private nextIngressTcpStreamId = 1;
  private readonly baseAppend: string;
  private vfsProvider: SandboxVfsProvider | null;
  private fsService: FsRpcService | null = null;
  private clients = new Set<SandboxClient>();
  private inflight = new Map<number, SandboxClient>();
  private stdinAllowed = new Set<number>();

  // Exec requests that are accepted by the host API but not yet started on the
  // guest control channel (currently only used while a file operation is active)
  private execQueue: Array<{
    client: SandboxClient;
    message: ExecCommandMessage;
    payload: any;
  }> = [];
  /** exec ids whose exec_request frame has been sent to sandboxd */
  private startedExecs = new Set<number>();
  private queuedStdin = new Map<
    number,
    Array<{ data: Buffer; eof: boolean }>
  >();
  private queuedStdinBytes = new Map<number, number>();
  /** total bytes buffered in queuedStdin across all queued exec ids in `bytes` */
  private queuedStdinBytesTotal = 0;
  /** stdin credits available to send to sandboxd, tracked in `bytes` */
  private stdinCredits = new Map<number, number>();
  private queuedPtyResize = new Map<number, { rows: number; cols: number }>();

  // Pending exec_window credits that could not be sent due to virtio queue pressure
  private pendingExecWindows = new Map<
    number,
    { stdout: number; stderr: number }
  >();
  private nextFileOpId = 1;
  private activeFileOpId: number | null = null;
  private fileOps = new Map<number, FileOperation>();
  private bridgeWritableWaiters: BridgeWritableWaiter[] = [];
  private execWindowFlushScheduled = false;
  private execIoFlushScheduled = false;
  private readonly startSingleflight = new AsyncSingleflight<void>();
  private readonly closeSingleflight = new AsyncSingleflight<void>();
  private started = false;
  private qemuStdoutBuffer = "";
  private qemuStderrBuffer = "";
  /** recent QEMU stderr log lines, used to enrich error messages */
  private qemuLogTail: string[] = [];
  private status: SandboxState = "stopped";
  private vfsReady = false;
  private vfsReadyTimer: NodeJS.Timeout | null = null;
  private bootConfig: SandboxFsConfig | null = null;

  /** @internal resolved qemu binary path */
  getQemuPath(): string {
    return this.options.qemuPath;
  }

  /**
   * Create a SandboxServer, downloading guest assets if needed.
   *
   * This is the recommended way to create a server in production, as it will
   * automatically download the guest image if it's not available locally.
   *
   * @param options Server configuration options
   * @returns A configured SandboxServer instance
   */
  static async create(
    options: SandboxServerOptions = {},
  ): Promise<SandboxServer> {
    const resolvedOptions = await resolveSandboxServerOptionsAsync(options);
    return new SandboxServer(resolvedOptions);
  }

  /**
   * Create a SandboxServer synchronously.
   *
   * This constructor requires that guest assets are available locally (either
   * in a development checkout or via GONDOLIN_GUEST_DIR). For automatic asset
   * downloading, use the async `SandboxServer.create()` factory instead.
   *
   * @param options Server configuration options (or pre-resolved options)
   */
  constructor(
    options: SandboxServerOptions | ResolvedSandboxServerOptions = {},
  ) {
    super();
    this.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emitDebug("error", message);
    });
    // Detect if we received pre-resolved options (from static create())
    // by checking for fields that only exist on resolved options.
    const isResolved =
      "kernelPath" in options &&
      "initrdPath" in options &&
      "rootfsPath" in options &&
      typeof (options as any).kernelPath === "string" &&
      typeof (options as any).initrdPath === "string" &&
      typeof (options as any).rootfsPath === "string";
    const resolvedOptions = isResolved
      ? (options as ResolvedSandboxServerOptions)
      : resolveSandboxServerOptions(options as SandboxServerOptions);

    this.options = resolvedOptions;

    this.debugFlags = new Set(this.options.debug ?? []);
    this.vfsProvider = this.options.vfsProvider
      ? this.options.vfsProvider instanceof SandboxVfsProvider
        ? this.options.vfsProvider
        : new SandboxVfsProvider(this.options.vfsProvider)
      : null;

    const hostArch = getHostNodeArchCached();
    const consoleDevice = hostArch === "arm64" ? "ttyAMA0" : "ttyS0";

    const baseAppend = (
      this.options.append ?? `console=${consoleDevice} initramfs_async=1`
    ).trim();
    this.baseAppend = baseAppend;

    const sandboxConfig: SandboxConfig = {
      qemuPath: this.options.qemuPath,
      kernelPath: this.options.kernelPath,
      initrdPath: this.options.initrdPath,
      rootDiskPath: this.options.rootDiskPath,
      rootDiskFormat: this.options.rootDiskFormat,
      rootDiskSnapshot: this.options.rootDiskSnapshot,
      rootDiskReadOnly: this.options.rootDiskReadOnly,
      memory: this.options.memory,
      cpus: this.options.cpus,
      virtioSocketPath: this.options.virtioSocketPath,
      virtioFsSocketPath: this.options.virtioFsSocketPath,
      virtioSshSocketPath: this.options.virtioSshSocketPath,
      virtioIngressSocketPath: this.options.virtioIngressSocketPath,
      netSocketPath: this.options.netEnabled
        ? this.options.netSocketPath
        : undefined,
      netMac: this.options.netMac,
      append: this.baseAppend,
      machineType: this.options.machineType,
      accel: this.options.accel,
      cpu: this.options.cpu,
      console: this.options.console,
      autoRestart: this.options.autoRestart,
    };

    this.controller = new SandboxController(sandboxConfig);

    // The virtio control channel can briefly accumulate a lot of data (notably
    // when streaming large stdin payloads). The default 8MiB buffer is too
    // small for our guest-tests (which can push multi-megabyte binaries), and
    // can cause spurious queue_full errors under slower virtio transport.
    const maxPendingBytes = Math.max(
      8 * 1024 * 1024,
      (this.options.maxStdinBytes ?? DEFAULT_MAX_STDIN_BYTES) * 2,
    );

    this.bridge = new VirtioBridge(
      this.options.virtioSocketPath,
      maxPendingBytes,
    );
    this.bridge.onWritable = () => {
      this.scheduleExecWindowFlush();
      this.scheduleExecIoFlush();
      this.flushBridgeWritableWaiters();
    };
    this.fsBridge = new VirtioBridge(this.options.virtioFsSocketPath);
    // SSH/tcp-forward stream can be long-lived and high-throughput; allow a larger queue.
    this.sshBridge = new VirtioBridge(
      this.options.virtioSshSocketPath,
      Math.max(maxPendingBytes, 64 * 1024 * 1024),
    );
    // Ingress proxy streams can also be long-lived and high-throughput.
    this.ingressBridge = new VirtioBridge(
      this.options.virtioIngressSocketPath,
      Math.max(maxPendingBytes, 64 * 1024 * 1024),
    );
    this.fsService = this.vfsProvider
      ? new FsRpcService(this.vfsProvider, {
          logger: this.hasDebug("vfs")
            ? (message) => this.emitDebug("vfs", message)
            : undefined,
        })
      : null;

    const mac =
      parseMac(this.options.netMac) ??
      Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
    this.network = this.options.netEnabled
      ? new QemuNetworkBackend({
          socketPath: this.options.netSocketPath,
          vmMac: mac,
          debug: this.hasDebug("net"),
          fetch: this.options.fetch,
          httpHooks: this.options.httpHooks,
          dns: this.options.dns,
          ssh: this.options.ssh,
          mitmCertDir: this.options.mitmCertDir,
          maxHttpBodyBytes: this.options.maxHttpBodyBytes,
          maxHttpResponseBodyBytes: this.options.maxHttpResponseBodyBytes,
          allowWebSockets: this.options.allowWebSockets,
        })
      : null;

    if (this.network) {
      this.network.on("debug", (component: DebugComponent, message: string) => {
        this.emitDebug(component, message);
      });
      this.network.on("error", (err) => {
        this.emit("error", err);
      });
    }

    this.controller.on("state", (state) => {
      if (state === "running") {
        this.bridge.connect();
        this.fsBridge.connect();
        this.sshBridge.connect();
        this.ingressBridge.connect();
      }
      if (state === "stopped") {
        // The controller emits state="stopped" before emitting "exit".
        // Defer failing inflight requests so the exit handler can include the
        // exit code/signal and (sanitized) QEMU stderr hint.
        queueMicrotask(() => {
          if (this.controller.getState() !== "stopped") return;
          if (this.inflight.size === 0) return;
          this.failInflight("sandbox_stopped", "sandbox is not running");
        });
      }

      if (state === "starting") {
        // Clear previous run's logs so hints stay scoped to the current VM.
        this.qemuStdoutBuffer = "";
        this.qemuStderrBuffer = "";
        this.qemuLogTail = [];

        this.vfsReady = false;
        this.clearVfsReadyTimer();
        this.status = "starting";
      } else if (state === "running") {
        // Consider the sandbox "running" once QEMU has spawned.
        //
        // VFS readiness is verified separately (e.g. via `await VM.start()`).
        // Relying on the guest's one-shot vfs_ready message can lead to
        // deadlocks/timeouts if it is missed.
        this.clearVfsReadyTimer();
        this.status = "running";
      } else {
        this.vfsReady = false;
        this.clearVfsReadyTimer();
        this.status = "stopped";
      }

      this.broadcastStatus(this.status);
    });

    this.controller.on("exit", (info) => {
      // Flush any unterminated chunks so exit diagnostics have a chance to
      // include the last stderr line.
      if (this.qemuStderrBuffer.length > 0) {
        this.recordQemuLogLine(this.qemuStderrBuffer);
        if (this.hasDebug("protocol")) {
          const normalized = this.normalizeQemuHintLine(this.qemuStderrBuffer);
          if (normalized) this.emitDebug("qemu", normalized);
        }
        this.qemuStderrBuffer = "";
      }
      if (this.qemuStdoutBuffer.length > 0) {
        if (this.hasDebug("protocol")) {
          const normalized = this.normalizeQemuHintLine(this.qemuStdoutBuffer);
          if (normalized) this.emitDebug("qemu", `stdout: ${normalized}`);
        }
        this.qemuStdoutBuffer = "";
      }

      const detail =
        info.code !== null
          ? `code=${info.code}`
          : info.signal
            ? `signal=${info.signal}`
            : "";
      const base = detail ? `sandbox exited (${detail})` : "sandbox exited";
      this.failInflight("sandbox_stopped", base + this.formatQemuLogHint());
      this.emit("exit", info);
    });

    this.controller.on(
      "log",
      (chunkOrEntry: string | any, streamArg?: SandboxLogStream) => {
        // Backwards/forwards compatibility: accept either (chunk, stream) or an
        // object payload.
        let stream: SandboxLogStream = "stderr";
        let chunk: string;

        if (typeof chunkOrEntry === "string") {
          chunk = chunkOrEntry;
          if (streamArg === "stdout" || streamArg === "stderr") {
            stream = streamArg;
          }
        } else {
          chunk =
            typeof chunkOrEntry?.chunk === "string"
              ? chunkOrEntry.chunk
              : String(chunkOrEntry ?? "");
          if (
            chunkOrEntry?.stream === "stdout" ||
            chunkOrEntry?.stream === "stderr"
          ) {
            stream = chunkOrEntry.stream;
          }
        }

        let buffer =
          stream === "stdout" ? this.qemuStdoutBuffer : this.qemuStderrBuffer;
        buffer += chunk;

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex + 1);
          buffer = buffer.slice(newlineIndex + 1);

          // Only use stderr for client-visible error hints to avoid leaking
          // untrusted guest console output from -serial stdio.
          if (stream === "stderr") {
            this.recordQemuLogLine(line);
          }

          if (this.hasDebug("protocol")) {
            const normalized = this.normalizeQemuHintLine(line);
            if (normalized) {
              this.emitDebug(
                "qemu",
                stream === "stderr" ? normalized : `stdout: ${normalized}`,
              );
            }
          }

          newlineIndex = buffer.indexOf("\n");
        }

        if (stream === "stdout") {
          this.qemuStdoutBuffer = buffer;
        } else {
          this.qemuStderrBuffer = buffer;
        }
      },
    );

    this.bridge.onMessage = (message) => {
      if (this.hasDebug("protocol")) {
        const id = isValidRequestId(message.id) ? message.id : "?";
        const extra =
          message.t === "exec_output"
            ? ` stream=${(message as any).p?.stream} bytes=${Buffer.isBuffer((message as any).p?.data) ? (message as any).p.data.length : 0}`
            : message.t === "exec_response"
              ? ` exit=${(message as any).p?.exit_code}`
              : message.t === "file_read_data"
                ? ` bytes=${Buffer.isBuffer((message as any).p?.data) ? (message as any).p.data.length : 0}`
                : "";
        this.emitDebug("protocol", `virtio rx t=${message.t} id=${id}${extra}`);
      }
      if (!isValidRequestId(message.id)) {
        return;
      }

      if (message.t === "exec_output") {
        const client = this.inflight.get(message.id);
        if (!client) return;
        const data = message.p.data;
        try {
          if (
            !sendBinary(
              client,
              encodeOutputFrame(message.id, message.p.stream, data),
            )
          ) {
            this.inflight.delete(message.id);
            this.stdinAllowed.delete(message.id);
            this.stdinCredits.delete(message.id);
          }
        } catch {
          this.inflight.delete(message.id);
          this.stdinAllowed.delete(message.id);
          this.stdinCredits.delete(message.id);
        }
      } else if (message.t === "exec_response") {
        if (this.hasDebug("exec")) {
          this.emitDebug(
            "exec",
            `exec done id=${message.id} exit=${message.p.exit_code}${message.p.signal ? ` signal=${message.p.signal}` : ""}`,
          );
        }
        const client = this.inflight.get(message.id);
        if (client) {
          sendJson(client, {
            type: "exec_response",
            id: message.id,
            exit_code: message.p.exit_code,
            signal: message.p.signal,
          });
        }
        this.inflight.delete(message.id);
        this.startedExecs.delete(message.id);
        this.stdinAllowed.delete(message.id);
        this.stdinCredits.delete(message.id);
        this.pendingExecWindows.delete(message.id);
        this.clearQueuedStdin(message.id);
        this.queuedPtyResize.delete(message.id);
      } else if (message.t === "stdin_window") {
        const stdin = (message as any).p?.stdin;
        const credits = Number(stdin);
        if (!Number.isFinite(credits) || credits <= 0) return;
        // Ignore credits for unknown exec ids.
        if (!this.inflight.has(message.id)) return;

        const prev = this.stdinCredits.get(message.id) ?? 0;
        const next = Math.min(0xffffffff, prev + Math.trunc(credits));
        this.stdinCredits.set(message.id, next);

        if (!this.flushQueuedStdinFor(message.id)) {
          this.scheduleExecIoFlush();
        }
      } else if (message.t === "file_read_data") {
        const op = this.fileOps.get(message.id);
        if (!op || op.kind !== "read") return;

        const data = message.p.data;
        if (!Buffer.isBuffer(data)) {
          this.rejectFileOperation(
            message.id,
            new Error("invalid file_read_data payload"),
          );
          return;
        }

        op.stream.write(data);
      } else if (message.t === "file_read_done") {
        this.resolveFileOperation(message.id);
      } else if (message.t === "file_write_done") {
        this.resolveFileOperation(message.id);
      } else if (message.t === "file_delete_done") {
        this.resolveFileOperation(message.id);
      } else if (message.t === "error") {
        const code = String(message.p.code ?? "");
        const client = this.inflight.get(message.id);
        const isExecLifecycleTracked =
          this.startedExecs.has(message.id) || this.inflight.has(message.id);
        const nonTerminalExecError =
          isExecLifecycleTracked && this.isNonTerminalExecErrorCode(code);

        if (nonTerminalExecError) {
          // Backpressure validation errors are advisory; the exec session keeps
          // running and must retain id/lifecycle ownership without surfacing a
          // terminal client error.
          return;
        }

        if (client) {
          sendError(client, {
            type: "error",
            id: message.id,
            code: message.p.code,
            message: message.p.message,
          });
        }

        if (client) {
          this.inflight.delete(message.id);
          this.startedExecs.delete(message.id);
          this.stdinAllowed.delete(message.id);
          this.stdinCredits.delete(message.id);
          this.pendingExecWindows.delete(message.id);
          this.clearQueuedStdin(message.id);
          this.queuedPtyResize.delete(message.id);
        } else if (this.fileOps.has(message.id)) {
          this.rejectFileOperation(
            message.id,
            new Error(`${message.p.code}: ${message.p.message}`),
          );
        } else if (this.startedExecs.has(message.id)) {
          // Orphaned exec (client disconnected): still clear guest-side lifecycle
          // tracking when sandboxd reports terminal failure.
          this.startedExecs.delete(message.id);
          this.stdinAllowed.delete(message.id);
          this.stdinCredits.delete(message.id);
          this.pendingExecWindows.delete(message.id);
          this.clearQueuedStdin(message.id);
          this.queuedPtyResize.delete(message.id);
        } else if (message.id === 0 && this.activeFileOpId !== null) {
          this.rejectFileOperation(
            this.activeFileOpId,
            new Error(`${message.p.code}: ${message.p.message}`),
          );
        }
      } else if (message.t === "vfs_ready") {
        this.handleVfsReady();
      } else if (message.t === "vfs_error") {
        this.handleVfsError(message.p.message);
      }
    };

    this.fsBridge.onMessage = (message) => {
      if (this.hasDebug("protocol")) {
        const id = isValidRequestId(message.id) ? message.id : "?";
        const extra =
          message.t === "fs_request" ? ` op=${(message as any).p?.op}` : "";
        this.emitDebug(
          "protocol",
          `virtiofs rx t=${message.t} id=${id}${extra}`,
        );
      }
      if (!isValidRequestId(message.id)) {
        return;
      }
      if (message.t !== "fs_request") {
        return;
      }
      if (!this.fsService) {
        this.fsBridge.send({
          v: 1,
          t: "fs_response",
          id: message.id,
          p: {
            op: message.p.op,
            err: ERRNO.ENOSYS,
            message: "filesystem service unavailable",
          },
        });
        return;
      }

      void this.fsService
        .handleRequest(message)
        .then((response) => {
          if (!this.fsBridge.send(response)) {
            this.emit("error", new Error("[fs] virtio bridge queue exceeded"));
          }
        })
        .catch((err) => {
          const detail =
            err instanceof Error ? err.message : "fs handler error";
          this.fsBridge.send({
            v: 1,
            t: "fs_response",
            id: message.id,
            p: {
              op: message.p.op,
              err: ERRNO.EIO,
              message: detail,
            },
          });
          this.emit("error", err instanceof Error ? err : new Error(detail));
        });
    };

    this.sshBridge.onMessage = (message: any) => {
      if (this.hasDebug("protocol")) {
        const id = isValidRequestId(message.id) ? message.id : "?";
        const extra =
          message.t === "tcp_data"
            ? ` bytes=${Buffer.isBuffer((message as any).p?.data) ? (message as any).p.data.length : 0}`
            : message.t === "tcp_opened"
              ? ` ok=${Boolean((message as any).p?.ok)}`
              : "";
        this.emitDebug(
          "protocol",
          `virtiossh rx t=${message.t} id=${id}${extra}`,
        );
      }

      if (!isValidRequestId(message.id)) return;

      if (message.t === "tcp_opened") {
        const waiter = this.tcpOpenWaiters.get(message.id);
        if (!waiter) return;
        this.tcpOpenWaiters.delete(message.id);

        const ok = Boolean((message as any).p?.ok);
        const msg =
          typeof (message as any).p?.message === "string"
            ? (message as any).p.message
            : "tcp_open failed";

        if (ok) {
          waiter.resolve();
        } else {
          const stream = this.tcpStreams.get(message.id);
          stream?.openFailed(msg);
          this.tcpStreams.delete(message.id);
          waiter.reject(new Error(msg));
        }
        return;
      }

      if (message.t === "tcp_data") {
        const stream = this.tcpStreams.get(message.id);
        if (!stream) return;
        const data = (message as any).p?.data;
        if (!Buffer.isBuffer(data)) return;
        stream.pushRemote(data);
        return;
      }

      if (message.t === "tcp_close") {
        const stream = this.tcpStreams.get(message.id);
        if (!stream) return;
        this.tcpStreams.delete(message.id);
        const waiter = this.tcpOpenWaiters.get(message.id);
        if (waiter) {
          this.tcpOpenWaiters.delete(message.id);
          waiter.reject(new Error("tcp stream closed"));
        }
        stream.remoteClose();
        return;
      }
    };

    this.sshBridge.onError = (err) => {
      const message = err instanceof Error ? err.message : "unknown error";
      this.emit("error", new Error(`[ssh] virtio bridge error: ${message}`));
      // Fail any pending opens.
      for (const [id, waiter] of this.tcpOpenWaiters.entries()) {
        waiter.reject(new Error("ssh virtio bridge error"));
        this.tcpOpenWaiters.delete(id);
      }
      for (const stream of this.tcpStreams.values()) {
        stream.destroy(new Error("ssh virtio bridge error"));
      }
      this.tcpStreams.clear();
    };

    this.ingressBridge.onMessage = (message: any) => {
      if (this.hasDebug("protocol")) {
        const id = isValidRequestId(message.id) ? message.id : "?";
        const extra =
          message.t === "tcp_data"
            ? ` bytes=${Buffer.isBuffer((message as any).p?.data) ? (message as any).p.data.length : 0}`
            : message.t === "tcp_opened"
              ? ` ok=${Boolean((message as any).p?.ok)}`
              : "";
        this.emitDebug(
          "protocol",
          `virtioingress rx t=${message.t} id=${id}${extra}`,
        );
      }

      if (!isValidRequestId(message.id)) return;

      if (message.t === "tcp_opened") {
        const waiter = this.ingressTcpOpenWaiters.get(message.id);
        if (!waiter) return;
        this.ingressTcpOpenWaiters.delete(message.id);

        const ok = Boolean((message as any).p?.ok);
        const msg =
          typeof (message as any).p?.message === "string"
            ? (message as any).p.message
            : "tcp_open failed";

        if (ok) {
          waiter.resolve();
        } else {
          const stream = this.ingressTcpStreams.get(message.id);
          stream?.openFailed(msg);
          this.ingressTcpStreams.delete(message.id);
          waiter.reject(new Error(msg));
        }
        return;
      }

      if (message.t === "tcp_data") {
        const stream = this.ingressTcpStreams.get(message.id);
        if (!stream) return;
        const data = (message as any).p?.data;
        if (!Buffer.isBuffer(data)) return;
        stream.pushRemote(data);
        return;
      }

      if (message.t === "tcp_close") {
        const stream = this.ingressTcpStreams.get(message.id);
        if (!stream) return;
        this.ingressTcpStreams.delete(message.id);
        const waiter = this.ingressTcpOpenWaiters.get(message.id);
        if (waiter) {
          this.ingressTcpOpenWaiters.delete(message.id);
          waiter.reject(new Error("tcp stream closed"));
        }
        stream.remoteClose();
        return;
      }
    };

    this.ingressBridge.onError = (err) => {
      const message = err instanceof Error ? err.message : "unknown error";
      this.emit(
        "error",
        new Error(`[ingress] virtio decode error: ${message}`),
      );
      // Fail any pending opens.
      for (const [id, waiter] of this.ingressTcpOpenWaiters.entries()) {
        waiter.reject(new Error("ingress virtio bridge error"));
        this.ingressTcpOpenWaiters.delete(id);
      }
      for (const stream of this.ingressTcpStreams.values()) {
        stream.destroy(new Error("ingress virtio bridge error"));
      }
      this.ingressTcpStreams.clear();
    };

    this.bridge.onError = (err) => {
      const message = err instanceof Error ? err.message : "unknown error";
      this.emit("error", new Error(`[virtio] bridge error: ${message}`));
      this.failInflight(
        "protocol_error",
        `virtio bridge error: ${message}` + this.formatQemuLogHint(),
      );
    };

    this.fsBridge.onError = (err) => {
      const message = err instanceof Error ? err.message : "unknown error";
      this.emit("error", new Error(`[fs] virtio bridge error: ${message}`));
    };
  }
}

export interface SandboxServer extends SandboxServerOps {}

installSandboxServerOps(SandboxServer);

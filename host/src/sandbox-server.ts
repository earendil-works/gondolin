import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { EventEmitter } from "events";


import {
  FrameReader,
  IncomingMessage,
  buildExecRequest,
  buildPtyResize,
  buildStdinData,
  decodeMessage,
  encodeFrame,
} from "./virtio-protocol";
import {
  BootCommandMessage,
  ClientMessage,
  ErrorMessage,
  ExecCommandMessage,
  PtyResizeCommandMessage,
  StdinCommandMessage,
  encodeOutputFrame,
  ServerMessage,
} from "./ws-protocol";
import { SandboxController, SandboxConfig, SandboxState } from "./sandbox-controller";
import { QemuNetworkBackend, DEFAULT_MAX_HTTP_BODY_BYTES } from "./qemu-net";
import type { HttpFetch, HttpHooks } from "./qemu-net";
import { FsRpcService, SandboxVfsProvider, type VirtualProvider } from "./vfs";
import { parseDebugEnv } from "./debug";
import { ensureGuestAssets, hasGuestAssets, type GuestAssets } from "./assets";

const MAX_REQUEST_ID = 0xffffffff;
const DEFAULT_MAX_STDIN_BYTES = 64 * 1024;
const DEFAULT_VFS_READY_TIMEOUT_MS = 30000;
const VFS_READY_TIMEOUT_MS = resolveEnvNumber(
  "GONDOLIN_VFS_READY_TIMEOUT_MS",
  DEFAULT_VFS_READY_TIMEOUT_MS
);
const { errno: ERRNO } = os.constants;

function resolveEnvNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export type SandboxServerOptions = {
  qemuPath?: string;
  kernelPath?: string;
  initrdPath?: string;
  rootfsPath?: string;
  memory?: string;
  cpus?: number;
  virtioSocketPath?: string;
  virtioFsSocketPath?: string;
  netSocketPath?: string;
  netMac?: string;
  netEnabled?: boolean;
  netDebug?: boolean;
  machineType?: string;
  accel?: string;
  cpu?: string;
  console?: "stdio" | "none";
  autoRestart?: boolean;
  append?: string;
  maxStdinBytes?: number;
  fetch?: HttpFetch;
  httpHooks?: HttpHooks;
  maxHttpBodyBytes?: number;
  mitmCertDir?: string;
  vfsProvider?: VirtualProvider;
};

type SandboxFsConfig = {
  fuseMount: string;
  fuseBinds: string[];
};

export type ResolvedSandboxServerOptions = {
  qemuPath: string;
  kernelPath: string;
  initrdPath: string;
  rootfsPath: string;
  memory: string;
  cpus: number;
  virtioSocketPath: string;
  virtioFsSocketPath: string;
  netSocketPath: string;
  netMac: string;
  netEnabled: boolean;
  netDebug: boolean;
  machineType?: string;
  accel?: string;
  cpu?: string;
  console?: "stdio" | "none";
  autoRestart: boolean;
  append?: string;
  maxStdinBytes: number;
  maxHttpBodyBytes: number;
  fetch?: HttpFetch;
  httpHooks?: HttpHooks;
  mitmCertDir?: string;
  vfsProvider: VirtualProvider | null;
};

/**
 * Get default guest asset paths from local development checkout.
 * Returns undefined for each path if not found locally.
 */
function getLocalGuestAssets(): Partial<GuestAssets> {
  // Handle both source (src/) and compiled (dist/src/) paths
  // We need to find the repo root where guest/ lives
  const possibleRepoRoots = [
    path.resolve(__dirname, "../.."),      // from src/: -> host/ -> gondolin/
    path.resolve(__dirname, "../../.."),   // from dist/src/: -> dist/ -> host/ -> gondolin/
  ];
  
  for (const repoRoot of possibleRepoRoots) {
    const devPath = path.join(repoRoot, "guest", "image", "out");
    const kernelPath = path.join(devPath, "vmlinuz-virt");
    const initrdPath = path.join(devPath, "initramfs.cpio.lz4");
    const rootfsPath = path.join(devPath, "rootfs.ext4");

    // Check if local dev paths exist
    if (
      fs.existsSync(kernelPath) &&
      fs.existsSync(initrdPath) &&
      fs.existsSync(rootfsPath)
    ) {
      return { kernelPath, initrdPath, rootfsPath };
    }
  }

  return {};
}

/**
 * Resolve server options synchronously.
 *
 * This version uses local development paths if available. For production use,
 * prefer `resolveSandboxServerOptionsAsync` which will download assets if needed.
 *
 * @param options User-provided options
 * @param assets Optional pre-resolved guest assets (from ensureGuestAssets)
 */
export function resolveSandboxServerOptions(
  options: SandboxServerOptions = {},
  assets?: GuestAssets
): ResolvedSandboxServerOptions {
  // Try local dev paths if no assets provided
  const localAssets = assets ?? getLocalGuestAssets();
  const defaultKernel = localAssets.kernelPath;
  const defaultInitrd = localAssets.initrdPath;
  const defaultRootfs = localAssets.rootfsPath;

  // we are running into length limits on macos on the default temp dir
  const tmpDir = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const defaultVirtio = path.resolve(
    tmpDir,
    `gondolin-virtio-${randomUUID().slice(0, 8)}.sock`
  );
  const defaultVirtioFs = path.resolve(
    tmpDir,
    `gondolin-virtio-fs-${randomUUID().slice(0, 8)}.sock`
  );
  const defaultNetSock = path.resolve(
    tmpDir,
    `gondolin-net-${randomUUID().slice(0, 8)}.sock`
  );
  const defaultNetMac = "02:00:00:00:00:01";

  const hostArch = detectHostArch();
  const defaultQemu = hostArch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
  const defaultMemory = "1G";
  const debugFlags = parseDebugEnv();

  // If no kernel path can be determined, we'll need to fetch assets later
  const kernelPath = options.kernelPath ?? defaultKernel;
  const initrdPath = options.initrdPath ?? defaultInitrd;
  const rootfsPath = options.rootfsPath ?? defaultRootfs;

  if (!kernelPath || !initrdPath || !rootfsPath) {
    throw new Error(
      "Guest assets not found. Either:\n" +
      "  1. Run from the gondolin repository with built guest images\n" +
      "  2. Use SandboxServer.create() to auto-download assets\n" +
      "  3. Explicitly provide kernelPath, initrdPath, and rootfsPath options\n" +
      "  4. Set GONDOLIN_GUEST_DIR to a directory containing the assets"
    );
  }

  return {
    qemuPath: options.qemuPath ?? defaultQemu,
    kernelPath,
    initrdPath,
    rootfsPath,
    memory: options.memory ?? defaultMemory,
    cpus: options.cpus ?? 2,
    virtioSocketPath: options.virtioSocketPath ?? defaultVirtio,
    virtioFsSocketPath: options.virtioFsSocketPath ?? defaultVirtioFs,
    netSocketPath: options.netSocketPath ?? defaultNetSock,
    netMac: options.netMac ?? defaultNetMac,
    netEnabled: options.netEnabled ?? true,
    netDebug: options.netDebug ?? debugFlags.has("net"),
    machineType: options.machineType,
    accel: options.accel,
    cpu: options.cpu,
    console: options.console,
    autoRestart: options.autoRestart ?? false,
    append: options.append,
    maxStdinBytes: options.maxStdinBytes ?? DEFAULT_MAX_STDIN_BYTES,
    maxHttpBodyBytes: options.maxHttpBodyBytes ?? DEFAULT_MAX_HTTP_BODY_BYTES,
    fetch: options.fetch,
    httpHooks: options.httpHooks,
    mitmCertDir: options.mitmCertDir,
    vfsProvider: options.vfsProvider ?? null,
  };
}

/**
 * Resolve server options asynchronously, downloading guest assets if needed.
 *
 * This is the recommended way to get resolved options for production use.
 */
export async function resolveSandboxServerOptionsAsync(
  options: SandboxServerOptions = {}
): Promise<ResolvedSandboxServerOptions> {
  // If all paths are explicitly provided, use sync version
  if (options.kernelPath && options.initrdPath && options.rootfsPath) {
    return resolveSandboxServerOptions(options);
  }

  // Check for local dev paths first
  const localAssets = getLocalGuestAssets();
  if (localAssets.kernelPath && localAssets.initrdPath && localAssets.rootfsPath) {
    return resolveSandboxServerOptions(options, localAssets as GuestAssets);
  }

  // Download assets if needed
  const assets = await ensureGuestAssets();
  return resolveSandboxServerOptions(options, assets);
}

let cachedHostArch: string | null = null;

function detectHostArch(): string {
  if (cachedHostArch !== null) return cachedHostArch;

  // Synchronous fallback for first call - will be replaced by async result
  if (process.arch === "arm64") {
    cachedHostArch = "arm64";
    return cachedHostArch;
  }

  // For macOS x64, we need async detection for Rosetta - return x64 for now
  // and let the async detection update it if needed
  cachedHostArch = process.arch;
  return cachedHostArch;
}

// Async detection that runs at module load
async function detectHostArchAsync(): Promise<string> {
  if (process.arch === "arm64") return "arm64";

  if (process.platform === "darwin" && process.arch === "x64") {
    try {
      const result = await new Promise<string>((resolve, reject) => {
        execFile("sysctl", ["-n", "hw.optional.arm64"], (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        });
      });
      if (result === "1") return "arm64";
    } catch {
      // ignore
    }
  }

  return process.arch;
}

// Start async detection immediately and cache result
detectHostArchAsync().then((arch) => {
  cachedHostArch = arch;
});

class VirtioBridge {
  private socket: net.Socket | null = null;
  private server: net.Server | null = null;
  private readonly reader = new FrameReader();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private waitingDrain = false;
  private allowReconnect = true;

  constructor(
    private readonly socketPath: string,
    private readonly maxPendingBytes: number = 8 * 1024 * 1024
  ) {}

  connect() {
    if (this.server) return;
    this.allowReconnect = true;
    if (!fs.existsSync(path.dirname(this.socketPath))) {
      fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    }
    fs.rmSync(this.socketPath, { force: true });

    const server = net.createServer((socket) => {
      this.attachSocket(socket);
    });
    this.server = server;

    server.on("error", (err) => {
      this.onError?.(err);
      server.close();
    });

    server.on("close", () => {
      this.server = null;
      this.scheduleReconnect();
    });

    server.listen(this.socketPath);
  }

  disconnect() {
    this.allowReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.waitingDrain = false;
  }

  send(message: object): boolean {
    if (!this.socket) {
      this.connect();
    }
    const frame = encodeFrame(message);
    if (this.pending.length === 0 && !this.waitingDrain) {
      return this.writeFrame(frame);
    }
    const queued = this.queueFrame(frame);
    if (queued && this.socket && this.socket.writable && !this.waitingDrain) {
      this.flushPending();
    }
    return queued;
  }

  onMessage?: (message: IncomingMessage) => void;
  onError?: (error: unknown) => void;

  private writeFrame(frame: Buffer): boolean {
    if (!this.socket || !this.socket.writable) {
      return this.queueFrame(frame);
    }
    const ok = this.socket.write(frame);
    if (!ok) {
      this.waitingDrain = true;
      this.socket.once("drain", () => {
        this.waitingDrain = false;
        this.flushPending();
      });
    }
    return true;
  }

  private queueFrame(frame: Buffer): boolean {
    if (this.pendingBytes + frame.length > this.maxPendingBytes) {
      return false;
    }
    this.pending.push(frame);
    this.pendingBytes += frame.length;
    return true;
  }

  private flushPending() {
    if (!this.socket || this.waitingDrain || !this.socket.writable) return;
    while (this.pending.length > 0) {
      const frame = this.pending.shift()!;
      this.pendingBytes -= frame.length;
      const ok = this.writeFrame(frame);
      if (!ok || this.waitingDrain) return;
    }
  }

  private attachSocket(socket: net.Socket) {
    if (this.socket) {
      this.socket.destroy();
    }
    this.socket = socket;
    this.waitingDrain = false;

    socket.on("data", (chunk) => {
      this.reader.push(chunk, (frame) => {
        try {
          const message = decodeMessage(frame) as IncomingMessage;
          this.onMessage?.(message);
        } catch (err) {
          this.onError?.(err);
          this.handleDisconnect();
        }
      });
    });

    socket.on("error", (err) => {
      this.onError?.(err);
      this.handleDisconnect();
    });

    socket.on("end", () => {
      this.handleDisconnect();
    });

    socket.on("close", () => {
      this.handleDisconnect();
    });

    this.flushPending();
  }

  private handleDisconnect() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.waitingDrain = false;
  }

  private scheduleReconnect() {
    if (!this.allowReconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.allowReconnect) {
        this.connect();
      }
    }, 500);
  }
}

function parseMac(value: string): Buffer | null {
  const parts = value.split(":");
  if (parts.length !== 6) return null;
  const bytes = parts.map((part) => Number.parseInt(part, 16));
  if (bytes.some((byte) => !Number.isFinite(byte) || byte < 0 || byte > 255)) return null;
  return Buffer.from(bytes);
}

function isValidRequestId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_REQUEST_ID
  );
}

function estimateBase64Bytes(value: string) {
  const len = value.length;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

type SandboxClient = {
  sendJson: (message: ServerMessage) => boolean;
  sendBinary: (data: Buffer) => boolean;
  close: () => void;
};

export type SandboxConnection = {
  send: (message: ClientMessage) => void;
  close: () => void;
};

class LocalSandboxClient implements SandboxClient {
  private closed = false;

  constructor(
    private readonly onMessage: (data: Buffer | string, isBinary: boolean) => void,
    private readonly onClose?: () => void
  ) {}

  sendJson(message: ServerMessage): boolean {
    if (this.closed) return false;
    this.onMessage(JSON.stringify(message), false);
    return true;
  }

  sendBinary(data: Buffer): boolean {
    if (this.closed) return false;
    this.onMessage(data, true);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }
}

function sendJson(client: SandboxClient, message: ServerMessage): boolean {
  return client.sendJson(message);
}

function sendBinary(client: SandboxClient, data: Buffer): boolean {
  return client.sendBinary(data);
}

function sendError(client: SandboxClient, error: ErrorMessage): boolean {
  return sendJson(client, error);
}

export class SandboxServer extends EventEmitter {
  private readonly options: ResolvedSandboxServerOptions;
  private readonly controller: SandboxController;
  private readonly bridge: VirtioBridge;
  private readonly fsBridge: VirtioBridge;
  private readonly network: QemuNetworkBackend | null;
  private readonly baseAppend: string;
  private vfsProvider: SandboxVfsProvider | null;
  private fsService: FsRpcService | null = null;
  private clients = new Set<SandboxClient>();
  private inflight = new Map<number, SandboxClient>();
  private stdinAllowed = new Set<number>();
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private started = false;
  private qemuLogBuffer = "";
  private status: SandboxState = "stopped";
  private vfsReady = false;
  private vfsReadyTimer: NodeJS.Timeout | null = null;
  private bootConfig: SandboxFsConfig | null = null;
  private activeClient: SandboxClient | null = null;

  /**
   * Create a SandboxServer, downloading guest assets if needed.
   *
   * This is the recommended way to create a server in production, as it will
   * automatically download the guest image if it's not available locally.
   *
   * @param options Server configuration options
   * @returns A configured SandboxServer instance
   */
  static async create(options: SandboxServerOptions = {}): Promise<SandboxServer> {
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
  constructor(options: SandboxServerOptions | ResolvedSandboxServerOptions = {}) {
    super();
    this.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("log", `[error] ${message}`);
    });
    // Detect if we received pre-resolved options (from static create())
    // by checking for a field that's required in resolved but computed in unresolved
    const isResolved =
      "maxStdinBytes" in options &&
      "maxHttpBodyBytes" in options &&
      typeof options.maxStdinBytes === "number" &&
      typeof options.maxHttpBodyBytes === "number";
    this.options = isResolved
      ? (options as ResolvedSandboxServerOptions)
      : resolveSandboxServerOptions(options as SandboxServerOptions);
    this.vfsProvider = this.options.vfsProvider
      ? this.options.vfsProvider instanceof SandboxVfsProvider
        ? this.options.vfsProvider
        : new SandboxVfsProvider(this.options.vfsProvider)
      : null;

    const hostArch = detectHostArch();
    const consoleDevice = hostArch === "arm64" ? "ttyAMA0" : "ttyS0";
    this.baseAppend = this.options.append ?? `console=${consoleDevice} initramfs_async=1`;

    const sandboxConfig: SandboxConfig = {
      qemuPath: this.options.qemuPath,
      kernelPath: this.options.kernelPath,
      initrdPath: this.options.initrdPath,
      rootfsPath: this.options.rootfsPath,
      memory: this.options.memory,
      cpus: this.options.cpus,
      virtioSocketPath: this.options.virtioSocketPath,
      virtioFsSocketPath: this.options.virtioFsSocketPath,
      netSocketPath: this.options.netEnabled ? this.options.netSocketPath : undefined,
      netMac: this.options.netMac,
      append: this.baseAppend,
      machineType: this.options.machineType,
      accel: this.options.accel,
      cpu: this.options.cpu,
      console: this.options.console,
      autoRestart: this.options.autoRestart,
    };

    this.controller = new SandboxController(sandboxConfig);
    this.bridge = new VirtioBridge(this.options.virtioSocketPath);
    this.fsBridge = new VirtioBridge(this.options.virtioFsSocketPath);
    this.fsService = this.vfsProvider
      ? new FsRpcService(this.vfsProvider, {
          logger: (message) => this.emit("log", message),
        })
      : null;

    const mac = parseMac(this.options.netMac) ?? Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
    this.network = this.options.netEnabled
      ? new QemuNetworkBackend({
          socketPath: this.options.netSocketPath,
          vmMac: mac,
          debug: this.options.netDebug,
          fetch: this.options.fetch,
          httpHooks: this.options.httpHooks,
          mitmCertDir: this.options.mitmCertDir,
          maxHttpBodyBytes: this.options.maxHttpBodyBytes,
        })
      : null;

    if (this.network) {
      this.network.on("log", (message: string) => {
        this.emit("log", message);
      });
      this.network.on("error", (err) => {
        this.emit("error", err);
      });
    }

    this.controller.on("state", (state) => {
      if (state === "running") {
        this.bridge.connect();
        this.fsBridge.connect();
      }
      if (state === "stopped") {
        this.failInflight("sandbox_stopped", "sandbox is not running");
      }

      if (state === "starting") {
        this.vfsReady = false;
        this.clearVfsReadyTimer();
        this.status = "starting";
      } else if (state === "running") {
        if (this.vfsReady) {
          this.clearVfsReadyTimer();
          this.status = "running";
        } else {
          this.startVfsReadyTimer();
          this.status = "starting";
        }
      } else {
        this.vfsReady = false;
        this.clearVfsReadyTimer();
        this.status = "stopped";
      }

      this.broadcastStatus(this.status);
    });

    this.controller.on("exit", (info) => {
      if (this.qemuLogBuffer.length > 0) {
        this.emit("log", `[qemu] ${this.qemuLogBuffer}`);
        this.qemuLogBuffer = "";
      }
      this.failInflight("sandbox_stopped", "sandbox exited");
      this.emit("exit", info);
    });

    this.controller.on("log", (chunk: string) => {
      this.qemuLogBuffer += chunk;
      let newlineIndex = this.qemuLogBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = this.qemuLogBuffer.slice(0, newlineIndex + 1);
        this.qemuLogBuffer = this.qemuLogBuffer.slice(newlineIndex + 1);
        this.emit("log", `[qemu] ${line}`);
        newlineIndex = this.qemuLogBuffer.indexOf("\n");
      }
    });

    this.bridge.onMessage = (message) => {
      if (!isValidRequestId(message.id)) {
        return;
      }

      if (message.t === "exec_output") {
        const client = this.inflight.get(message.id);
        if (!client) return;
        const data = message.p.data;
        try {
          if (!sendBinary(client, encodeOutputFrame(message.id, message.p.stream, data))) {
            this.inflight.delete(message.id);
            this.stdinAllowed.delete(message.id);
          }
        } catch {
          this.inflight.delete(message.id);
          this.stdinAllowed.delete(message.id);
        }
      } else if (message.t === "exec_response") {
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
        this.stdinAllowed.delete(message.id);
      } else if (message.t === "error") {
        const client = this.inflight.get(message.id);
        if (client) {
          sendError(client, {
            type: "error",
            id: message.id,
            code: message.p.code,
            message: message.p.message,
          });
        }
        this.inflight.delete(message.id);
        this.stdinAllowed.delete(message.id);
      } else if (message.t === "vfs_ready") {
        this.handleVfsReady();
      } else if (message.t === "vfs_error") {
        this.handleVfsError(message.p.message);
      }
    };

    this.fsBridge.onMessage = (message) => {
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
          const detail = err instanceof Error ? err.message : "fs handler error";
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

    this.bridge.onError = (err) => {
      const message = err instanceof Error ? err.message : "unknown error";
      this.emit("error", new Error(`[virtio] decode error: ${message}`));
      this.failInflight("protocol_error", "virtio decode error");
    };

    this.fsBridge.onError = (err) => {
      const message = err instanceof Error ? err.message : "unknown error";
      this.emit("error", new Error(`[fs] decode error: ${message}`));
    };
  }

  getState() {
    return this.status;
  }

  getVfsProvider() {
    return this.vfsProvider;
  }

  getFsMetrics() {
    return this.fsService?.metrics ?? null;
  }

  connect(
    onMessage: (data: Buffer | string, isBinary: boolean) => void,
    onClose?: () => void
  ): SandboxConnection {
    const client = new LocalSandboxClient(onMessage, onClose);
    this.attachClient(client);
    return {
      send: (message) => this.handleClientMessage(client, message),
      close: () => this.closeClient(client),
    };
  }

  private broadcastStatus(state: SandboxState) {
    for (const client of this.clients) {
      sendJson(client, { type: "status", state });
    }
    this.emit("state", state);
  }

  private startVfsReadyTimer() {
    if (VFS_READY_TIMEOUT_MS <= 0 || this.vfsReadyTimer) return;
    this.vfsReadyTimer = setTimeout(() => {
      this.vfsReadyTimer = null;
      this.handleVfsReadyTimeout();
    }, VFS_READY_TIMEOUT_MS);
  }

  private clearVfsReadyTimer() {
    if (!this.vfsReadyTimer) return;
    clearTimeout(this.vfsReadyTimer);
    this.vfsReadyTimer = null;
  }

  private handleVfsReady() {
    if (this.vfsReady) return;
    this.vfsReady = true;
    this.clearVfsReadyTimer();
    if (this.controller.getState() === "running" && this.status !== "running") {
      this.status = "running";
      this.broadcastStatus(this.status);
    }
  }

  private handleVfsError(message: string, code = "vfs_error") {
    this.vfsReady = false;
    this.clearVfsReadyTimer();
    const trimmed = message.trim();
    const detail = trimmed.length > 0 ? trimmed : "vfs not ready";
    this.emit("error", new Error(`[vfs] ${detail}`));
    if (this.activeClient) {
      sendError(this.activeClient, {
        type: "error",
        code,
        message: detail,
      });
      this.closeClient(this.activeClient);
    }
  }

  private handleVfsReadyTimeout() {
    this.handleVfsError(
      `vfs not ready after ${VFS_READY_TIMEOUT_MS}ms`,
      "vfs_timeout"
    );
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = null;
    });

    return this.stopPromise;
  }

  private async startInternal(): Promise<void> {
    if (this.started) return;

    this.started = true;
    this.network?.start();
    this.bridge.connect();
    this.fsBridge.connect();
  }

  private async stopInternal() {
    this.failInflight("server_shutdown", "server is shutting down");
    this.closeAllClients();
    await this.controller.stop();
    this.bridge.disconnect();
    this.fsBridge.disconnect();
    await this.fsService?.close();
    this.network?.stop();
    this.started = false;
  }

  private attachClient(client: SandboxClient) {
    if (this.activeClient && this.activeClient !== client) {
      this.closeClient(this.activeClient);
    }

    this.clients.add(client);
    this.activeClient = client;
    sendJson(client, { type: "status", state: this.status });
  }

  private closeClient(client: SandboxClient) {
    this.disconnectClient(client);
    client.close();
  }

  private closeAllClients() {
    for (const client of Array.from(this.clients)) {
      this.closeClient(client);
    }
  }

  private disconnectClient(client: SandboxClient) {
    if (this.activeClient === client) {
      this.activeClient = null;
    }

    this.clients.delete(client);
    for (const [id, entry] of this.inflight.entries()) {
      if (entry === client) {
        this.inflight.delete(id);
        this.stdinAllowed.delete(id);
      }
    }
  }

  private handleClientMessage(client: SandboxClient, message: ClientMessage) {
    if (message.type === "boot") {
      void this.handleBoot(client, message);
      return;
    }

    if (!this.bootConfig) {
      sendError(client, {
        type: "error",
        code: "missing_boot",
        message: "boot configuration required before commands",
      });
      return;
    }

    if (message.type === "exec") {
      this.handleExec(client, message);
    } else if (message.type === "stdin") {
      this.handleStdin(client, message);
    } else if (message.type === "pty_resize") {
      this.handlePtyResize(client, message);
    } else if (message.type === "lifecycle") {
      if (message.action === "restart") {
        void this.controller.restart();
      } else if (message.action === "shutdown") {
        void this.controller.stop();
      }
    } else {
      sendError(client, {
        type: "error",
        code: "unknown_type",
        message: "unsupported message type",
      });
    }
  }

  private async handleBoot(client: SandboxClient, message: BootCommandMessage) {
    let config: SandboxFsConfig;
    try {
      config = normalizeSandboxFsConfig(message);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      sendError(client, {
        type: "error",
        code: "invalid_request",
        message: error,
      });
      return;
    }

    const changed = !this.bootConfig || !isSameSandboxFsConfig(this.bootConfig, config);
    this.bootConfig = config;

    const append = buildSandboxfsAppend(this.baseAppend, config);
    this.controller.setAppend(append);

    const state = this.controller.getState();
    if (changed) {
      if (state === "running" || state === "starting") {
        await this.controller.restart();
        return;
      }
    }

    if (state === "stopped") {
      await this.controller.start();
    }

    sendJson(client, { type: "status", state: this.status });
  }

  private handleExec(client: SandboxClient, message: ExecCommandMessage) {
    if (!isValidRequestId(message.id) || !message.cmd) {
      sendError(client, {
        type: "error",
        code: "invalid_request",
        message: "exec requires uint32 id and cmd",
      });
      return;
    }

    if (this.inflight.has(message.id)) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "duplicate_id",
        message: "request id already in use",
      });
      return;
    }

    this.inflight.set(message.id, client);
    if (message.stdin) this.stdinAllowed.add(message.id);

    const payload = {
      cmd: message.cmd,
      argv: message.argv ?? [],
      env: message.env ?? [],
      cwd: message.cwd,
      stdin: message.stdin ?? false,
      pty: message.pty ?? false,
    };

    if (!this.bridge.send(buildExecRequest(message.id, payload))) {
      this.inflight.delete(message.id);
      this.stdinAllowed.delete(message.id);
      sendError(client, {
        type: "error",
        id: message.id,
        code: "queue_full",
        message: "virtio bridge queue exceeded",
      });
    }
  }

  private handleStdin(client: SandboxClient, message: StdinCommandMessage) {
    if (!isValidRequestId(message.id)) {
      sendError(client, {
        type: "error",
        code: "invalid_request",
        message: "stdin requires a uint32 id",
      });
      return;
    }

    if (!this.inflight.has(message.id)) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "unknown_id",
        message: "request id not found",
      });
      return;
    }

    if (!this.stdinAllowed.has(message.id)) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "stdin_disabled",
        message: "stdin was not enabled for this request",
      });
      return;
    }

    const base64 = message.data ?? "";
    if (base64 && estimateBase64Bytes(base64) > this.options.maxStdinBytes) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "payload_too_large",
        message: "stdin chunk exceeds size limit",
      });
      return;
    }

    const data = base64 ? Buffer.from(base64, "base64") : Buffer.alloc(0);
    if (data.length > this.options.maxStdinBytes) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "payload_too_large",
        message: "stdin chunk exceeds size limit",
      });
      return;
    }

    if (!this.bridge.send(buildStdinData(message.id, data, message.eof))) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "queue_full",
        message: "virtio bridge queue exceeded",
      });
    }
  }

  private handlePtyResize(client: SandboxClient, message: PtyResizeCommandMessage) {
    if (!isValidRequestId(message.id)) {
      sendError(client, {
        type: "error",
        code: "invalid_request",
        message: "pty_resize requires a uint32 id",
      });
      return;
    }

    if (!this.inflight.has(message.id)) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "unknown_id",
        message: "request id not found",
      });
      return;
    }

    const rows = Number(message.rows);
    const cols = Number(message.cols);
    if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 1 || cols < 1) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "invalid_request",
        message: "pty_resize requires positive rows and cols",
      });
      return;
    }

    if (!this.bridge.send(buildPtyResize(message.id, Math.trunc(rows), Math.trunc(cols)))) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "queue_full",
        message: "virtio bridge queue exceeded",
      });
    }
  }

  private failInflight(code: string, message: string) {
    for (const [id, client] of this.inflight.entries()) {
      sendError(client, {
        type: "error",
        id,
        code,
        message,
      });
    }
    this.inflight.clear();
    this.stdinAllowed.clear();
  }
}

function normalizeSandboxFsConfig(message: BootCommandMessage): SandboxFsConfig {
  const fuseMount = normalizeMountPath(message.fuseMount ?? "/data", "fuseMount");
  const fuseBinds = normalizeBindList(message.fuseBinds ?? []);
  return {
    fuseMount,
    fuseBinds,
  };
}

function normalizeMountPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  let normalized = path.posix.normalize(value);
  if (!normalized.startsWith("/")) {
    throw new Error(`${field} must be an absolute path`);
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.includes("\0")) {
    throw new Error(`${field} contains null bytes`);
  }
  return normalized;
}

function normalizeBindList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("fuseBinds must be an array of absolute paths");
  }
  const seen = new Set<string>();
  const binds: string[] = [];
  for (const entry of value) {
    const normalized = normalizeMountPath(entry, "fuseBinds");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    binds.push(normalized);
  }
  binds.sort();
  return binds;
}

function isSameSandboxFsConfig(left: SandboxFsConfig, right: SandboxFsConfig) {
  if (left.fuseMount !== right.fuseMount) return false;
  if (left.fuseBinds.length !== right.fuseBinds.length) return false;
  for (let i = 0; i < left.fuseBinds.length; i += 1) {
    if (left.fuseBinds[i] !== right.fuseBinds[i]) return false;
  }
  return true;
}

function buildSandboxfsAppend(baseAppend: string, config: SandboxFsConfig) {
  const pieces = [baseAppend.trim(), `sandboxfs.mount=${config.fuseMount}`];
  if (config.fuseBinds.length > 0) {
    pieces.push(`sandboxfs.bind=${config.fuseBinds.join(",")}`);
  }
  return pieces.filter((piece) => piece.length > 0).join(" ").trim();
}

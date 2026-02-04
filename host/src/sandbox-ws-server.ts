import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { EventEmitter } from "events";

import { WebSocketServer, WebSocket } from "ws";

import {
  FrameReader,
  IncomingMessage,
  buildExecRequest,
  buildStdinData,
  decodeMessage,
  encodeFrame,
} from "./virtio-protocol";
import {
  BootCommandMessage,
  ClientMessage,
  ErrorMessage,
  ExecCommandMessage,
  StdinCommandMessage,
  encodeOutputFrame,
  ServerMessage,
} from "./ws-protocol";
import { SandboxController, SandboxConfig, SandboxState } from "./sandbox-controller";
import { QemuNetworkBackend } from "./qemu-net";
import type { HttpFetch, HttpHooks } from "./qemu-net";
import type { SandboxPolicy } from "./policy";
import { FsRpcService, SandboxVfsProvider, type VirtualProvider } from "./vfs";
import { parseDebugEnv } from "./debug";

const MAX_REQUEST_ID = 0xffffffff;
const DEFAULT_MAX_JSON_BYTES = 256 * 1024;
const DEFAULT_MAX_STDIN_BYTES = 64 * 1024;
const { errno: ERRNO } = os.constants;

export type SandboxWsServerOptions = {
  host?: string;
  port?: number;
  qemuPath?: string;
  kernelPath?: string;
  initrdPath?: string;
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
  token?: string;
  autoRestart?: boolean;
  append?: string;
  maxJsonBytes?: number;
  maxStdinBytes?: number;
  policy?: SandboxPolicy;
  fetch?: HttpFetch;
  httpHooks?: HttpHooks;
  vfsProvider?: VirtualProvider;
};

export type SandboxWsServerAddress = {
  host: string;
  port: number;
  url: string;
};

type SandboxFsConfig = {
  fuseMount: string;
  fuseBinds: string[];
};

type ResolvedServerOptions = {
  host: string;
  port: number;
  qemuPath: string;
  kernelPath: string;
  initrdPath: string;
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
  token?: string;
  autoRestart: boolean;
  append?: string;
  maxJsonBytes: number;
  maxStdinBytes: number;
  policy: SandboxPolicy | null;
  fetch?: HttpFetch;
  httpHooks?: HttpHooks;
  vfsProvider: VirtualProvider | null;
};

export function resolveSandboxWsServerOptions(
  options: SandboxWsServerOptions = {}
): ResolvedServerOptions {
  const repoRoot = path.resolve(__dirname, "../..");
  const defaultKernel = path.resolve(repoRoot, "guest/image/out/vmlinuz-virt");
  const defaultInitrd = path.resolve(repoRoot, "guest/image/out/initramfs.cpio.gz");
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
  const defaultMemory = hostArch === "arm64" ? "512M" : "256M";
  const debugFlags = parseDebugEnv();

  return {
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 8080,
    qemuPath: options.qemuPath ?? defaultQemu,
    kernelPath: options.kernelPath ?? defaultKernel,
    initrdPath: options.initrdPath ?? defaultInitrd,
    memory: options.memory ?? defaultMemory,
    cpus: options.cpus ?? 1,
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
    token: options.token ?? process.env.ELWING_TOKEN ?? process.env.SANDBOX_WS_TOKEN,
    autoRestart: options.autoRestart ?? true,
    append: options.append,
    maxJsonBytes: options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES,
    maxStdinBytes: options.maxStdinBytes ?? DEFAULT_MAX_STDIN_BYTES,
    policy: options.policy ?? null,
    fetch: options.fetch,
    httpHooks: options.httpHooks,
    vfsProvider: options.vfsProvider ?? null,
  };
}

function detectHostArch(): string {
  if (process.arch === "arm64") return "arm64";
  if (process.platform === "darwin" && process.arch === "x64") {
    try {
      const result = execSync("sysctl -n hw.optional.arm64", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (result === "1") return "arm64";
    } catch {
      // ignore
    }
  }
  return process.arch;
}

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

function validateToken(headers: Record<string, string | string[] | undefined>, token?: string) {
  if (!token) return true;
  const headerToken = headers["x-elwing-token"] ?? headers["x-sandbox-token"];
  if (typeof headerToken === "string" && headerToken === token) return true;
  if (Array.isArray(headerToken) && headerToken.includes(token)) return true;
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length) === token;
  }
  return false;
}

function safeSend(ws: WebSocket, data: string | Buffer, options?: { binary?: boolean }): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    if (options) {
      ws.send(data, options);
    } else {
      ws.send(data);
    }
    return true;
  } catch {
    return false;
  }
}

function sendJson(ws: WebSocket, message: ServerMessage): boolean {
  return safeSend(ws, JSON.stringify(message));
}

function sendBinary(ws: WebSocket, data: Buffer): boolean {
  return safeSend(ws, data, { binary: true });
}

function sendError(ws: WebSocket, error: ErrorMessage): boolean {
  return sendJson(ws, error);
}

function formatHost(host: string) {
  return host.includes(":") ? `[${host}]` : host;
}

function resolveAddress(host: string, address: net.AddressInfo | string | null): SandboxWsServerAddress {
  if (!address || typeof address === "string") {
    const formattedHost = formatHost(host);
    return {
      host,
      port: 0,
      url: `ws://${formattedHost}`,
    };
  }

  const formattedHost = formatHost(host);
  return {
    host,
    port: address.port,
    url: `ws://${formattedHost}:${address.port}`,
  };
}

export class SandboxWsServer extends EventEmitter {
  private readonly options: ResolvedServerOptions;
  private readonly controller: SandboxController;
  private readonly bridge: VirtioBridge;
  private readonly fsBridge: VirtioBridge;
  private readonly network: QemuNetworkBackend | null;
  private readonly baseAppend: string;
  private wss: WebSocketServer | null = null;
  private vfsProvider: SandboxVfsProvider | null;
  private fsService: FsRpcService | null = null;
  private inflight = new Map<number, WebSocket>();
  private stdinAllowed = new Set<number>();
  private startPromise: Promise<SandboxWsServerAddress> | null = null;
  private stopPromise: Promise<void> | null = null;
  private address: SandboxWsServerAddress | null = null;
  private policy: SandboxPolicy | null;
  private qemuLogBuffer = "";
  private status: SandboxState = "stopped";
  private bootConfig: SandboxFsConfig | null = null;
  private activeClient: WebSocket | null = null;

  constructor(options: SandboxWsServerOptions = {}) {
    super();
    this.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("log", `[error] ${message}`);
    });
    this.options = resolveSandboxWsServerOptions(options);
    this.policy = this.options.policy;
    this.vfsProvider = this.options.vfsProvider
      ? this.options.vfsProvider instanceof SandboxVfsProvider
        ? this.options.vfsProvider
        : new SandboxVfsProvider(this.options.vfsProvider)
      : null;

    const hostArch = detectHostArch();
    const consoleDevice = hostArch === "arm64" ? "ttyAMA0" : "ttyS0";
    this.baseAppend = this.options.append ?? `console=${consoleDevice}`;

    const sandboxConfig: SandboxConfig = {
      qemuPath: this.options.qemuPath,
      kernelPath: this.options.kernelPath,
      initrdPath: this.options.initrdPath,
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
          policy: this.policy ?? undefined,
          fetch: this.options.fetch,
          httpHooks: this.options.httpHooks,
        })
      : null;

    if (this.network) {
      this.network.on("log", (message: string) => {
        this.emit("log", message);
      });
      this.network.on("error", (err) => {
        this.emit("error", err);
      });
      this.network.on("policy", (policy) => {
        this.emit("policy", policy);
      });
    }

    this.controller.on("state", (state) => {
      this.status = state;
      if (state === "running") {
        this.bridge.connect();
        this.fsBridge.connect();
      }
      if (state === "stopped") {
        this.failInflight("sandbox_stopped", "sandbox is not running");
      }

      if (!this.wss) return;
      for (const client of this.wss.clients) {
        sendJson(client, { type: "status", state });
      }
      this.emit("state", state);
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

  getAddress() {
    return this.address;
  }

  getUrl() {
    return this.address?.url ?? null;
  }

  getState() {
    return this.status;
  }

  getPolicy() {
    return this.policy;
  }

  getVfsProvider() {
    return this.vfsProvider;
  }

  getFsMetrics() {
    return this.fsService?.metrics ?? null;
  }

  setPolicy(policy: SandboxPolicy | null) {
    this.policy = policy;
    this.network?.setPolicy(policy);
    this.emit("policy", policy);
  }

  async start(): Promise<SandboxWsServerAddress> {
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

  private async startInternal(): Promise<SandboxWsServerAddress> {
    if (this.wss) {
      return this.address ?? resolveAddress(this.options.host, this.wss.address());
    }

    this.wss = new WebSocketServer({
      host: this.options.host,
      port: this.options.port,
      maxPayload: this.options.maxJsonBytes,
      verifyClient: (info, done) => {
        if (!validateToken(info.req.headers, this.options.token)) {
          done(false, 401, "Unauthorized");
          return;
        }
        done(true);
      },
    });

    this.wss.on("connection", (ws) => this.handleConnection(ws));

    this.wss.on("close", () => {
      this.wss = null;
      this.address = null;
    });

    this.network?.start();
    this.bridge.connect();
    this.fsBridge.connect();

    const address = await new Promise<SandboxWsServerAddress>((resolve, reject) => {
      const handleError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const handleListening = () => {
        cleanup();
        const resolved = resolveAddress(this.options.host, this.wss?.address() ?? null);
        this.address = resolved;
        resolve(resolved);
      };

      const cleanup = () => {
        this.wss?.off("error", handleError);
        this.wss?.off("listening", handleListening);
      };

      this.wss?.once("error", handleError);
      this.wss?.once("listening", handleListening);
    });

    return address;
  }

  private async stopInternal() {
    this.failInflight("server_shutdown", "server is shutting down");
    await this.controller.stop();
    this.bridge.disconnect();
    this.fsBridge.disconnect();
    await this.fsService?.close();
    this.network?.stop();

    if (this.wss) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          resolve();
        };

        const timeout = setTimeout(() => {
          finish();
        }, 1000);

        this.wss?.close(() => finish());
      });
    }
    this.wss = null;
    this.address = null;
  }

  private handleConnection(ws: WebSocket) {
    if (this.activeClient) {
      sendError(ws, {
        type: "error",
        code: "client_busy",
        message: "only one client connection is allowed",
      });
      ws.close();
      return;
    }

    if (!sendJson(ws, { type: "status", state: this.controller.getState() })) {
      ws.close();
      return;
    }

    this.activeClient = ws;

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        sendError(ws, {
          type: "error",
          code: "invalid_message",
          message: "binary input frames are not supported",
        });
        return;
      }

      const size =
        typeof data === "string"
          ? Buffer.byteLength(data)
          : Buffer.isBuffer(data)
            ? data.length
            : Array.isArray(data)
              ? data.reduce((total, chunk) => total + chunk.length, 0)
              : data.byteLength;
      if (size > this.options.maxJsonBytes) {
        sendError(ws, {
          type: "error",
          code: "payload_too_large",
          message: "message exceeds size limit",
        });
        return;
      }

      let message: ClientMessage;
      try {
        message = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        sendError(ws, {
          type: "error",
          code: "invalid_json",
          message: "failed to parse JSON",
        });
        return;
      }

      if (message.type === "boot") {
        void this.handleBoot(ws, message);
        return;
      }

      if (!this.bootConfig && message.type !== "policy") {
        sendError(ws, {
          type: "error",
          code: "missing_boot",
          message: "boot configuration required before commands",
        });
        return;
      }

      if (message.type === "exec") {
        this.handleExec(ws, message);
      } else if (message.type === "stdin") {
        this.handleStdin(ws, message);
      } else if (message.type === "lifecycle") {
        if (message.action === "restart") {
          void this.controller.restart();
        } else if (message.action === "shutdown") {
          void this.controller.stop();
        }
      } else if (message.type === "policy") {
        this.handlePolicy(ws, message);
      } else {
        sendError(ws, {
          type: "error",
          code: "unknown_type",
          message: "unsupported message type",
        });
      }
    });

    ws.on("close", () => {
      if (this.activeClient === ws) {
        this.activeClient = null;
      }
      for (const [id, client] of this.inflight.entries()) {
        if (client === ws) {
          this.inflight.delete(id);
          this.stdinAllowed.delete(id);
        }
      }
    });
  }

  private async handleBoot(ws: WebSocket, message: BootCommandMessage) {
    let config: SandboxFsConfig;
    try {
      config = normalizeSandboxFsConfig(message);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      sendError(ws, {
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

    sendJson(ws, { type: "status", state: this.controller.getState() });
  }

  private handleExec(ws: WebSocket, message: ExecCommandMessage) {
    if (!isValidRequestId(message.id) || !message.cmd) {
      sendError(ws, {
        type: "error",
        code: "invalid_request",
        message: "exec requires uint32 id and cmd",
      });
      return;
    }

    if (this.inflight.has(message.id)) {
      sendError(ws, {
        type: "error",
        id: message.id,
        code: "duplicate_id",
        message: "request id already in use",
      });
      return;
    }

    this.inflight.set(message.id, ws);
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
      sendError(ws, {
        type: "error",
        id: message.id,
        code: "queue_full",
        message: "virtio bridge queue exceeded",
      });
    }
  }

  private handleStdin(ws: WebSocket, message: StdinCommandMessage) {
    if (!isValidRequestId(message.id)) {
      sendError(ws, {
        type: "error",
        code: "invalid_request",
        message: "stdin requires a uint32 id",
      });
      return;
    }

    if (!this.inflight.has(message.id)) {
      sendError(ws, {
        type: "error",
        id: message.id,
        code: "unknown_id",
        message: "request id not found",
      });
      return;
    }

    if (!this.stdinAllowed.has(message.id)) {
      sendError(ws, {
        type: "error",
        id: message.id,
        code: "stdin_disabled",
        message: "stdin was not enabled for this request",
      });
      return;
    }

    const base64 = message.data ?? "";
    if (base64 && estimateBase64Bytes(base64) > this.options.maxStdinBytes) {
      sendError(ws, {
        type: "error",
        id: message.id,
        code: "payload_too_large",
        message: "stdin chunk exceeds size limit",
      });
      return;
    }

    const data = base64 ? Buffer.from(base64, "base64") : Buffer.alloc(0);
    if (data.length > this.options.maxStdinBytes) {
      sendError(ws, {
        type: "error",
        id: message.id,
        code: "payload_too_large",
        message: "stdin chunk exceeds size limit",
      });
      return;
    }

    if (!this.bridge.send(buildStdinData(message.id, data, message.eof))) {
      sendError(ws, {
        type: "error",
        id: message.id,
        code: "queue_full",
        message: "virtio bridge queue exceeded",
      });
    }
  }

  private handlePolicy(_ws: WebSocket, message: { policy: SandboxPolicy }) {
    this.setPolicy(message.policy);
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

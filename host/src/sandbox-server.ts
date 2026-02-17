import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { Duplex, PassThrough, Readable } from "stream";

import { getHostNodeArchCached } from "./host-arch";
import { AsyncSingleflight } from "./async-utils";
import { toBufferIterable } from "./buffer-iter";

import {
  FrameReader,
  IncomingMessage,
  buildExecRequest,
  buildPtyResize,
  buildStdinData,
  buildExecWindow,
  buildFileDeleteRequest,
  buildFileReadRequest,
  buildFileWriteData,
  buildFileWriteRequest,
  decodeMessage,
  encodeFrame,
} from "./virtio-protocol";
import {
  BootCommandMessage,
  ClientMessage,
  ErrorMessage,
  ExecCommandMessage,
  ExecWindowCommandMessage,
  PtyResizeCommandMessage,
  StdinCommandMessage,
  encodeOutputFrame,
  ServerMessage,
} from "./control-protocol";
import {
  SandboxController,
  SandboxConfig,
  SandboxState,
  type SandboxLogStream,
} from "./sandbox-controller";
import {
  QemuNetworkBackend,
  DEFAULT_MAX_HTTP_BODY_BYTES,
  DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES,
} from "./qemu-net";
import type { DnsOptions, HttpFetch, HttpHooks } from "./qemu-net";
import type { SshOptions } from "./qemu-ssh";
import { FsRpcService } from "./vfs/rpc-service";
import { SandboxVfsProvider } from "./vfs/provider";
import type { VirtualProvider } from "./vfs/node";
import {
  debugFlagsToArray,
  parseDebugEnv,
  resolveDebugFlags,
  stripTrailingNewline,
  type DebugComponent,
  type DebugConfig,
  type DebugFlag,
} from "./debug";
import {
  ensureGuestAssets,
  loadAssetManifest,
  loadGuestAssets,
  resolveGuestAssetsSync,
  type GuestAssets,
} from "./assets";

/**
 * Path to guest image assets.
 *
 * Can be either:
 * - A string path to a directory containing the assets (vmlinuz-virt, initramfs.cpio.lz4, rootfs.ext4)
 * - An object with explicit paths to each asset file
 */
export type ImagePath = string | GuestAssets;

const MAX_REQUEST_ID = 0xffffffff;
const DEFAULT_MAX_STDIN_BYTES = 64 * 1024;
const DEFAULT_MAX_QUEUED_STDIN_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_QUEUED_STDIN_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_EXECS = 64;
const { errno: ERRNO } = os.constants;

/**
 * sandbox server options
 *
 * imagePath can be either:
 * - a directory containing the guest assets (kernel/initrd/rootfs)
 * - an object with explicit asset paths
 */
export type SandboxServerOptions = {
  /** qemu binary path */
  qemuPath?: string;
  /** guest asset directory or explicit asset paths */
  imagePath?: ImagePath;
  /** vm memory size (qemu syntax, e.g. "1G") */
  memory?: string;
  /** vm cpu count */
  cpus?: number;
  /** virtio-serial control socket path */
  virtioSocketPath?: string;
  /** virtiofs/vfs socket path */
  virtioFsSocketPath?: string;
  /** virtio-serial ssh socket path */
  virtioSshSocketPath?: string;

  /** virtio-serial ingress socket path */
  virtioIngressSocketPath?: string;
  /** qemu net socket path */
  netSocketPath?: string;
  /** guest mac address */
  netMac?: string;
  /** whether to enable networking */
  netEnabled?: boolean;
  /** whether to allow WebSocket upgrades for guest egress (default: true) */
  allowWebSockets?: boolean;

  /**
   * Root disk image path (attached as `/dev/vda`)
   *
   * If omitted, uses the base rootfs image from the guest assets.
   */
  rootDiskPath?: string;

  /** root disk image format */
  rootDiskFormat?: "raw" | "qcow2";

  /** qemu snapshot mode for the root disk (discard writes) */
  rootDiskSnapshot?: boolean;

  /**
   * Delete the root disk image on VM close
   *
   * This is a host-side lifecycle hint. It is currently only honored by the
   * higher-level {@link VM} wrapper.
   */
  rootDiskDeleteOnClose?: boolean;

  /**
   * Debug configuration
   *
   * - `true`: enable all debug components
   * - `false`: disable all debug components
   * - `string[]`: enable selected components (e.g. `["net", "exec"]`)
   *
   * If omitted, defaults to `GONDOLIN_DEBUG`.
   */
  debug?: DebugConfig;
  /** qemu machine type */
  machineType?: string;
  /** qemu acceleration backend (e.g. kvm, hvf) */
  accel?: string;
  /** qemu cpu model */
  cpu?: string;
  /** guest console mode */
  console?: "stdio" | "none";
  /** whether to restart the vm automatically on exit */
  autoRestart?: boolean;
  /** kernel cmdline append string */
  append?: string;

  /** max stdin buffered per process in `bytes` */
  maxStdinBytes?: number;
  /** max stdin buffered for a single queued (not yet active) exec in `bytes` */
  maxQueuedStdinBytes?: number;
  /** max total stdin buffered across all queued (not yet active) execs in `bytes` */
  maxTotalQueuedStdinBytes?: number;
  /** max total exec pressure (running + queued-to-start) */
  maxQueuedExecs?: number;
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
  /** mitm ca directory path */
  mitmCertDir?: string;
  /** vfs provider to expose under the fuse mount */
  vfsProvider?: VirtualProvider;
};

type SandboxFsConfig = {
  fuseMount: string;
  fuseBinds: string[];
};

export type ResolvedSandboxServerOptions = {
  /** qemu binary path */
  qemuPath: string;
  /** kernel image path */
  kernelPath: string;
  /** initrd/initramfs image path */
  initrdPath: string;
  /** rootfs image path */
  rootfsPath: string;

  /** root disk image path (attached as `/dev/vda`) */
  rootDiskPath: string;
  /** root disk image format */
  rootDiskFormat: "raw" | "qcow2";
  /** qemu snapshot mode for the root disk (discard writes) */
  rootDiskSnapshot: boolean;

  /** vm memory size (qemu syntax, e.g. "1G") */
  memory: string;
  /** vm cpu count */
  cpus: number;
  /** virtio-serial control socket path */
  virtioSocketPath: string;
  /** virtiofs/vfs socket path */
  virtioFsSocketPath: string;
  /** virtio-serial ssh socket path */
  virtioSshSocketPath: string;

  /** virtio-serial ingress socket path */
  virtioIngressSocketPath: string;
  /** qemu net socket path */
  netSocketPath: string;
  /** guest mac address */
  netMac: string;
  /** whether networking is enabled */
  netEnabled: boolean;
  /** whether to allow WebSocket upgrades for guest egress */
  allowWebSockets: boolean;

  /** enabled debug components */
  debug: DebugFlag[];
  /** qemu machine type */
  machineType?: string;
  /** qemu acceleration backend (e.g. kvm, hvf) */
  accel?: string;
  /** qemu cpu model */
  cpu?: string;
  /** guest console mode */
  console?: "stdio" | "none";
  /** whether to restart the vm automatically on exit */
  autoRestart: boolean;
  /** kernel cmdline append string */
  append?: string;

  /** max stdin buffered per process in `bytes` */
  maxStdinBytes: number;
  /** max stdin buffered for a single queued (not yet active) exec in `bytes` */
  maxQueuedStdinBytes: number;
  /** max total stdin buffered across all queued (not yet active) execs in `bytes` */
  maxTotalQueuedStdinBytes: number;
  /** max total exec pressure (running + queued-to-start) */
  maxQueuedExecs: number;
  /** max intercepted http request body size in `bytes` */
  maxHttpBodyBytes: number;
  /** max buffered upstream http response body size in `bytes` */
  maxHttpResponseBodyBytes: number;
  /** http fetch implementation for asset downloads */
  fetch?: HttpFetch;
  /** http interception hooks */
  httpHooks?: HttpHooks;

  /** dns configuration */
  dns?: DnsOptions;

  /** ssh egress configuration */
  ssh?: SshOptions;

  /** mitm ca directory path */
  mitmCertDir?: string;
  /** vfs provider to expose under the fuse mount */
  vfsProvider: VirtualProvider | null;
};

export type GuestFileReadOptions = {
  /** working directory for relative paths */
  cwd?: string;
  /** preferred chunk size in `bytes` */
  chunkSize?: number;
  /** abort signal for the read request */
  signal?: AbortSignal;
  /** stream highWaterMark in `bytes` */
  highWaterMark?: number;
};

export type GuestFileWriteOptions = {
  /** working directory for relative paths */
  cwd?: string;
  /** abort signal for the write request */
  signal?: AbortSignal;
};

export type GuestFileDeleteOptions = {
  /** ignore missing paths */
  force?: boolean;
  /** recursive delete for directories */
  recursive?: boolean;
  /** working directory for relative paths */
  cwd?: string;
  /** abort signal for the delete request */
  signal?: AbortSignal;
};

/**
 * Resolve imagePath to GuestAssets.
 */
function resolveImagePath(imagePath: ImagePath): GuestAssets {
  if (typeof imagePath === "string") {
    return loadGuestAssets(imagePath);
  }
  return imagePath;
}

function normalizeArch(
  value: string | null | undefined,
): "arm64" | "x64" | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === "arm64" || lower === "aarch64") return "arm64";
  if (lower === "x64" || lower === "x86_64" || lower === "amd64") return "x64";
  return null;
}

function detectQemuArch(qemuPath: string): "arm64" | "x64" | null {
  const lower = qemuPath.toLowerCase();
  if (lower.includes("aarch64") || lower.includes("arm64")) return "arm64";
  if (
    lower.includes("x86_64") ||
    lower.includes("x64") ||
    lower.includes("amd64")
  )
    return "x64";
  return null;
}

function findCommonAssetDir(assets: Partial<GuestAssets>): string | null {
  const kernelDir = assets.kernelPath ? path.dirname(assets.kernelPath) : null;
  const initrdDir = assets.initrdPath ? path.dirname(assets.initrdPath) : null;
  const rootfsDir = assets.rootfsPath ? path.dirname(assets.rootfsPath) : null;

  if (!kernelDir || !initrdDir || !rootfsDir) return null;
  if (kernelDir !== initrdDir || kernelDir !== rootfsDir) return null;
  return kernelDir;
}

function detectGuestArchFromManifest(assets: Partial<GuestAssets>): {
  arch: "arm64" | "x64";
  manifestPath: string;
} | null {
  const dir = findCommonAssetDir(assets);
  if (!dir) return null;

  const manifest = loadAssetManifest(dir);
  const arch = normalizeArch(manifest?.config?.arch);
  if (!manifest || !arch) return null;

  return { arch, manifestPath: path.join(dir, "manifest.json") };
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
  assets?: GuestAssets,
): ResolvedSandboxServerOptions {
  // Resolve image paths: explicit imagePath > assets parameter > local dev paths
  let resolvedAssets: Partial<GuestAssets>;
  if (options.imagePath !== undefined) {
    resolvedAssets = resolveImagePath(options.imagePath);
  } else if (assets) {
    resolvedAssets = assets;
  } else {
    resolvedAssets = resolveGuestAssetsSync() ?? {};
  }

  const kernelPath = resolvedAssets.kernelPath;
  const initrdPath = resolvedAssets.initrdPath;
  const rootfsPath = resolvedAssets.rootfsPath;

  // we are running into length limits on macos on the default temp dir
  const tmpDir = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const defaultVirtio = path.resolve(
    tmpDir,
    `gondolin-virtio-${randomUUID().slice(0, 8)}.sock`,
  );
  const defaultVirtioFs = path.resolve(
    tmpDir,
    `gondolin-virtio-fs-${randomUUID().slice(0, 8)}.sock`,
  );
  const defaultVirtioSsh = path.resolve(
    tmpDir,
    `gondolin-virtio-ssh-${randomUUID().slice(0, 8)}.sock`,
  );
  const defaultVirtioIngress = path.resolve(
    tmpDir,
    `gondolin-virtio-ingress-${randomUUID().slice(0, 8)}.sock`,
  );
  const defaultNetSock = path.resolve(
    tmpDir,
    `gondolin-net-${randomUUID().slice(0, 8)}.sock`,
  );
  const defaultNetMac = "02:00:00:00:00:01";

  const hostArch = getHostNodeArchCached();
  const defaultQemu =
    hostArch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
  const defaultMemory = "1G";
  const envDebugFlags = parseDebugEnv();
  const resolvedDebugFlags = resolveDebugFlags(options.debug, envDebugFlags);
  const debug = debugFlagsToArray(resolvedDebugFlags);

  if (!kernelPath || !initrdPath || !rootfsPath) {
    throw new Error(
      "Guest assets not found. Either:\n" +
        "  1. Run from the gondolin repository with built guest images\n" +
        "  2. Use SandboxServer.create() to auto-download assets\n" +
        "  3. Provide imagePath option (directory path or explicit paths)\n" +
        "  4. Set GONDOLIN_GUEST_DIR to a directory containing the assets",
    );
  }

  const qemuPath = options.qemuPath ?? defaultQemu;

  // Fail fast if we can detect that the guest image doesn't match the QEMU target.
  // Without this, the VM often just "hangs" until some higher-level timeout.
  const guestFromManifest = detectGuestArchFromManifest({
    kernelPath,
    initrdPath,
    rootfsPath,
  });
  const qemuArch = detectQemuArch(qemuPath);

  if (guestFromManifest && qemuArch && guestFromManifest.arch !== qemuArch) {
    const host = normalizeArch(hostArch) ?? hostArch;
    throw new Error(
      "Guest image architecture mismatch.\n" +
        `  guest assets: ${guestFromManifest.arch} (from ${guestFromManifest.manifestPath})\n` +
        `  qemu binary:  ${qemuArch} (${qemuPath})\n` +
        `  host arch:    ${host}\n\n` +
        "Fix: use a matching qemuPath (e.g. qemu-system-aarch64 vs qemu-system-x86_64) " +
        "or rebuild/download guest assets for the correct architecture.",
    );
  }

  const rootDiskPath = options.rootDiskPath ?? rootfsPath;
  const rootDiskFormat =
    options.rootDiskFormat ?? (options.rootDiskPath ? "qcow2" : "raw");
  const rootDiskSnapshot =
    options.rootDiskSnapshot ?? (options.rootDiskPath ? false : true);

  const maxStdinBytes = options.maxStdinBytes ?? DEFAULT_MAX_STDIN_BYTES;
  const maxQueuedStdinBytes = Math.max(
    options.maxQueuedStdinBytes ?? DEFAULT_MAX_QUEUED_STDIN_BYTES,
    maxStdinBytes,
  );
  const maxTotalQueuedStdinBytes = Math.max(
    options.maxTotalQueuedStdinBytes ?? DEFAULT_MAX_TOTAL_QUEUED_STDIN_BYTES,
    maxQueuedStdinBytes,
  );

  return {
    qemuPath,
    kernelPath,
    initrdPath,
    rootfsPath,
    rootDiskPath,
    rootDiskFormat,
    rootDiskSnapshot,
    memory: options.memory ?? defaultMemory,
    cpus: options.cpus ?? 2,
    virtioSocketPath: options.virtioSocketPath ?? defaultVirtio,
    virtioFsSocketPath: options.virtioFsSocketPath ?? defaultVirtioFs,
    virtioSshSocketPath: options.virtioSshSocketPath ?? defaultVirtioSsh,
    virtioIngressSocketPath:
      options.virtioIngressSocketPath ?? defaultVirtioIngress,
    netSocketPath: options.netSocketPath ?? defaultNetSock,
    netMac: options.netMac ?? defaultNetMac,
    netEnabled: options.netEnabled ?? true,
    allowWebSockets: options.allowWebSockets ?? true,
    debug,
    machineType: options.machineType,
    accel: options.accel,
    cpu: options.cpu,
    console: options.console,
    autoRestart: options.autoRestart ?? false,
    append: options.append,
    maxStdinBytes,
    maxQueuedStdinBytes,
    maxTotalQueuedStdinBytes,
    maxQueuedExecs: options.maxQueuedExecs ?? DEFAULT_MAX_QUEUED_EXECS,
    maxHttpBodyBytes: options.maxHttpBodyBytes ?? DEFAULT_MAX_HTTP_BODY_BYTES,
    maxHttpResponseBodyBytes:
      options.maxHttpResponseBodyBytes ?? DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES,
    fetch: options.fetch,
    httpHooks: options.httpHooks,
    dns: options.dns,
    ssh: options.ssh,
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
  options: SandboxServerOptions = {},
): Promise<ResolvedSandboxServerOptions> {
  // If imagePath is explicitly provided, use sync version (no download needed)
  if (options.imagePath !== undefined) {
    return resolveSandboxServerOptions(options);
  }

  const assets = await ensureGuestAssets();
  return resolveSandboxServerOptions(options, assets);
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
  private closed = false;

  constructor(
    private readonly socketPath: string,
    private readonly maxPendingBytes: number = 8 * 1024 * 1024,
  ) {}

  connect() {
    if (this.closed) return;
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

  async disconnect(): Promise<void> {
    this.closed = true;
    this.allowReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Always hard-destroy the active socket so `server.close()` can complete
    // immediately. Using `.end()` can keep the connection (and therefore the
    // net.Server handle) alive indefinitely if the peer never responds.
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // ignore
      }
      this.socket = null;
    }

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    this.waitingDrain = false;

    // Drop any queued frames; after disconnect the bridge is permanently closed.
    this.pending = [];
    this.pendingBytes = 0;
  }

  send(message: object): boolean {
    if (this.closed) {
      return false;
    }
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

  /** Called when the bridge may be able to accept more queued messages */
  onWritable?: () => void;

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
    let freed = false;
    while (this.pending.length > 0) {
      const frame = this.pending.shift()!;
      this.pendingBytes -= frame.length;
      freed = true;
      const ok = this.writeFrame(frame);
      if (!ok || this.waitingDrain) {
        if (freed) this.onWritable?.();
        return;
      }
    }
    if (freed) this.onWritable?.();
  }

  private attachSocket(socket: net.Socket) {
    if (this.socket) {
      this.socket.destroy();
    }
    this.socket = socket;
    this.waitingDrain = false;

    socket.on("data", (chunk) => {
      try {
        this.reader.push(chunk, (frame) => {
          try {
            const message = decodeMessage(frame) as IncomingMessage;
            this.onMessage?.(message);
          } catch (err) {
            this.onError?.(err);
            this.handleDisconnect();
          }
        });
      } catch (err) {
        // Malformed framing (e.g. oversized length prefix) should not crash the host.
        this.onError?.(err);
        this.handleDisconnect();
      }
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

class TcpForwardStream extends Duplex {
  private closedByRemote = false;
  private closeSent = false;

  constructor(
    readonly id: number,
    private readonly sendFrame: (message: object) => boolean,
    private readonly onDispose: () => void,
  ) {
    super();
    this.on("close", () => {
      this.onDispose();
    });
  }

  _read(_size: number): void {
    // no-op; data is pushed from the virtio handler
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.closedByRemote) {
      callback(new Error("tcp stream closed"));
      return;
    }

    const ok = this.sendFrame({
      v: 1,
      t: "tcp_data",
      id: this.id,
      p: { data: chunk },
    });

    if (!ok) {
      callback(new Error("virtio tcp queue exceeded"));
      return;
    }

    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.closedByRemote) {
      callback();
      return;
    }

    // half-close
    this.sendFrame({ v: 1, t: "tcp_eof", id: this.id, p: {} });
    callback();
  }

  _destroy(
    _error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.closedByRemote && !this.closeSent) {
      this.closeSent = true;
      this.sendFrame({ v: 1, t: "tcp_close", id: this.id, p: {} });
    }
    callback();
  }

  pushRemote(data: Buffer): void {
    if (this.closedByRemote) return;
    this.push(data);
  }

  remoteClose(): void {
    if (this.closedByRemote) return;
    this.closedByRemote = true;
    this.push(null);
    // Don't send tcp_close back; remote already closed.
    this.destroy();
  }

  openFailed(message: string): void {
    this.closedByRemote = true;
    this.destroy(new Error(message));
  }
}

function parseMac(value: string): Buffer | null {
  const parts = value.split(":");
  if (parts.length !== 6) return null;
  const bytes = parts.map((part) => Number.parseInt(part, 16));
  if (bytes.some((byte) => !Number.isFinite(byte) || byte < 0 || byte > 255))
    return null;
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
  /** send a control message to the guest */
  send: (message: ClientMessage) => void;
  /** close the underlying connection */
  close: () => void;
};

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

class LocalSandboxClient implements SandboxClient {
  private closed = false;

  constructor(
    private readonly onMessage: (
      data: Buffer | string,
      isBinary: boolean,
    ) => void,
    private readonly onClose?: () => void,
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
    onClose?: () => void,
  ): SandboxConnection {
    const client = new LocalSandboxClient(onMessage, onClose);
    this.attachClient(client);
    return {
      send: (message) => this.handleClientMessage(client, message),
      close: () => this.closeClient(client),
    };
  }

  /**
   * Create a readable stream for a guest file.
   */
  async readGuestFileStream(
    filePath: string,
    options: GuestFileReadOptions = {},
  ): Promise<Readable> {
    this.assertGuestPath(filePath, "filePath");
    await this.start();
    await this.waitForExecIdle(options.signal);

    const id = this.allocateFileOpId();
    const highWaterMark =
      typeof options.highWaterMark === "number" &&
      Number.isFinite(options.highWaterMark) &&
      options.highWaterMark > 0
        ? Math.trunc(options.highWaterMark)
        : undefined;

    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    void done.catch(() => {});

    const stream = new PassThrough(
      highWaterMark ? { highWaterMark } : undefined,
    );
    stream.on("error", () => {
      // keep process alive if caller does not attach an error handler
    });

    this.fileOps.set(id, {
      kind: "read",
      stream,
      resolve: resolveDone,
      reject: rejectDone,
    });
    this.activeFileOpId = id;

    let abortCleanup: (() => void) | null = null;
    if (options.signal) {
      const onAbort = () => {
        const err = new Error("file read aborted");
        this.rejectFileOperation(id, err);
      };
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () =>
          options.signal!.removeEventListener("abort", onAbort);
      }
    }

    void done.then(
      () => {
        abortCleanup?.();
      },
      () => {
        abortCleanup?.();
      },
    );

    try {
      await this.sendControlMessage(
        buildFileReadRequest(id, {
          path: filePath,
          cwd: options.cwd,
          chunk_size: options.chunkSize,
        }),
        options.signal,
      );

      // The guest may reject unsupported requests immediately (e.g. older
      // sandboxd versions). Surface that as a direct throw instead of returning
      // a dead stream.
      if (!this.fileOps.has(id)) {
        await done;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectFileOperation(id, error);
      throw error;
    }

    return stream;
  }

  /**
   * Read an entire guest file into a Buffer.
   */
  async readGuestFile(
    filePath: string,
    options: GuestFileReadOptions = {},
  ): Promise<Buffer> {
    const stream = await this.readGuestFileStream(filePath, options);
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.once("end", resolve);
      stream.once("error", reject);
    });

    return Buffer.concat(chunks);
  }

  /**
   * Write file content to the guest.
   */
  async writeGuestFile(
    filePath: string,
    input:
      | Buffer
      | Uint8Array
      | string
      | Readable
      | AsyncIterable<Buffer | Uint8Array | string>,
    options: GuestFileWriteOptions = {},
  ): Promise<void> {
    this.assertGuestPath(filePath, "filePath");
    await this.start();
    await this.waitForExecIdle(options.signal);

    const id = this.allocateFileOpId();

    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    this.fileOps.set(id, {
      kind: "write",
      resolve: resolveDone,
      reject: rejectDone,
    });
    this.activeFileOpId = id;

    const CHUNK = 64 * 1024;
    let requestStarted = false;
    let eofSent = false;

    try {
      await this.sendControlMessage(
        buildFileWriteRequest(id, {
          path: filePath,
          cwd: options.cwd,
          truncate: true,
        }),
        options.signal,
      );
      requestStarted = true;

      for await (const chunk of toBufferIterable(input)) {
        for (let offset = 0; offset < chunk.length; offset += CHUNK) {
          const slice = chunk.subarray(offset, offset + CHUNK);
          await this.sendControlMessage(
            buildFileWriteData(id, slice),
            options.signal,
          );
        }
      }

      await this.sendControlMessage(
        buildFileWriteData(id, Buffer.alloc(0), true),
        options.signal,
      );
      eofSent = true;

      await done;
    } catch (err) {
      if (requestStarted && !eofSent) {
        try {
          await this.sendControlMessage(
            buildFileWriteData(id, Buffer.alloc(0), true),
            undefined,
          );
        } catch {
          // ignore
        }
      }
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectFileOperation(id, error);
      throw error;
    }
  }

  /**
   * Delete a guest file or directory.
   */
  async deleteGuestFile(
    filePath: string,
    options: GuestFileDeleteOptions = {},
  ): Promise<void> {
    this.assertGuestPath(filePath, "filePath");
    await this.start();
    await this.waitForExecIdle(options.signal);

    const id = this.allocateFileOpId();

    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    this.fileOps.set(id, {
      kind: "delete",
      resolve: resolveDone,
      reject: rejectDone,
    });
    this.activeFileOpId = id;

    try {
      await this.sendControlMessage(
        buildFileDeleteRequest(id, {
          path: filePath,
          cwd: options.cwd,
          force: options.force,
          recursive: options.recursive,
        }),
        options.signal,
      );

      await done;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectFileOperation(id, error);
      throw error;
    }
  }

  /**
   * Open a TCP stream to a loopback service inside the guest.
   *
   * This is implemented via a dedicated virtio-serial port and does not use the
   * guest network stack.
   */
  async openTcpStream(target: {
    host: string;
    port: number;
    timeoutMs?: number;
  }): Promise<Duplex> {
    const host = target.host;
    const port = target.port;
    const timeoutMs = target.timeoutMs ?? 5000;

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`invalid guest port: ${port}`);
    }

    // Allocate stream id
    let id = this.nextTcpStreamId;
    for (let i = 0; i < 0xffffffff; i++) {
      if (!this.tcpStreams.has(id) && !this.tcpOpenWaiters.has(id)) break;
      id = (id + 1) >>> 0;
      if (id === 0) id = 1;
    }
    this.nextTcpStreamId = (id + 1) >>> 0;
    if (this.nextTcpStreamId === 0) this.nextTcpStreamId = 1;

    const stream = new TcpForwardStream(
      id,
      (m) => this.sshBridge.send(m),
      () => {
        this.tcpStreams.delete(id);
        const waiter = this.tcpOpenWaiters.get(id);
        if (waiter) {
          this.tcpOpenWaiters.delete(id);
          waiter.reject(new Error("tcp stream closed"));
        }
      },
    );

    this.tcpStreams.set(id, stream);

    const openedPromise = new Promise<void>((resolve, reject) => {
      this.tcpOpenWaiters.set(id, { resolve, reject });
    });

    const ok = this.sshBridge.send({
      v: 1,
      t: "tcp_open",
      id,
      p: {
        host,
        port,
      },
    });

    if (!ok) {
      this.tcpStreams.delete(id);
      this.tcpOpenWaiters.delete(id);
      stream.destroy();
      throw new Error("virtio tcp queue exceeded");
    }

    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        openedPromise,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("tcp_open timeout")),
            timeoutMs,
          );
        }),
      ]);
      return stream;
    } catch (err) {
      stream.destroy(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Open a TCP stream to a loopback service inside the guest via the ingress connector.
   *
   * This is intended for the host-side ingress gateway and should not be exposed
   * as a generic port-forwarding primitive.
   */
  async openIngressStream(target: {
    host: string;
    port: number;
    timeoutMs?: number;
  }): Promise<Duplex> {
    const host = target.host;
    const port = target.port;
    const timeoutMs = target.timeoutMs ?? 5000;

    if (host !== "127.0.0.1" && host !== "localhost") {
      throw new Error(`invalid ingress host: ${host}`);
    }

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`invalid guest port: ${port}`);
    }

    // Allocate stream id
    let id = this.nextIngressTcpStreamId;
    for (let i = 0; i < 0xffffffff; i++) {
      if (
        !this.ingressTcpStreams.has(id) &&
        !this.ingressTcpOpenWaiters.has(id)
      )
        break;
      id = (id + 1) >>> 0;
      if (id === 0) id = 1;
    }
    this.nextIngressTcpStreamId = (id + 1) >>> 0;
    if (this.nextIngressTcpStreamId === 0) this.nextIngressTcpStreamId = 1;

    const stream = new TcpForwardStream(
      id,
      (m) => this.ingressBridge.send(m),
      () => {
        this.ingressTcpStreams.delete(id);
        const waiter = this.ingressTcpOpenWaiters.get(id);
        if (waiter) {
          this.ingressTcpOpenWaiters.delete(id);
          waiter.reject(new Error("tcp stream closed"));
        }
      },
    );

    this.ingressTcpStreams.set(id, stream);

    const openedPromise = new Promise<void>((resolve, reject) => {
      this.ingressTcpOpenWaiters.set(id, { resolve, reject });
    });

    const ok = this.ingressBridge.send({
      v: 1,
      t: "tcp_open",
      id,
      p: {
        host,
        port,
      },
    });

    if (!ok) {
      this.ingressTcpStreams.delete(id);
      this.ingressTcpOpenWaiters.delete(id);
      stream.destroy();
      throw new Error("virtio tcp queue exceeded");
    }

    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        openedPromise,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("tcp_open timeout")),
            timeoutMs,
          );
        }),
      ]);
      return stream;
    } catch (err) {
      stream.destroy(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private broadcastStatus(state: SandboxState) {
    for (const client of this.clients) {
      sendJson(client, { type: "status", state });
    }
    this.emit("state", state);
  }

  private clearVfsReadyTimer() {
    if (!this.vfsReadyTimer) return;
    clearTimeout(this.vfsReadyTimer);
    this.vfsReadyTimer = null;
  }

  private handleVfsReady() {
    if (this.hasDebug("vfs")) {
      this.emitDebug("vfs", "vfs_ready");
    }
    if (this.vfsReady) return;
    this.vfsReady = true;
    this.clearVfsReadyTimer();
    if (this.controller.getState() === "running" && this.status !== "running") {
      this.status = "running";
      this.broadcastStatus(this.status);
    }
  }

  private handleVfsError(message: string, code = "vfs_error") {
    if (this.hasDebug("vfs")) {
      this.emitDebug(
        "vfs",
        `vfs_error code=${code} message=${stripTrailingNewline(message)}`,
      );
    }
    this.vfsReady = false;
    this.clearVfsReadyTimer();
    const trimmed = message.trim();
    const detail = trimmed.length > 0 ? trimmed : "vfs not ready";
    this.emit("error", new Error(`[vfs] ${detail}`));
    for (const client of Array.from(this.clients)) {
      sendError(client, {
        type: "error",
        code,
        message: detail,
      });
      this.closeClient(client);
    }
  }

  async start(): Promise<void> {
    return this.startSingleflight.run(() => this.startInternal());
  }

  async close(): Promise<void> {
    return this.closeSingleflight.run(() => this.closeInternal());
  }

  private async startInternal(): Promise<void> {
    if (this.started) return;

    this.started = true;
    this.network?.start();
    this.bridge.connect();
    this.fsBridge.connect();
    this.sshBridge.connect();
    this.ingressBridge.connect();
  }

  private async closeInternal() {
    this.failInflight("server_shutdown", "server is shutting down");
    this.closeAllClients();

    // Stop accepting new virtio connections immediately and prevent reconnect
    // timers from keeping the event loop alive while we wait for QEMU to exit.
    await Promise.all([
      this.bridge.disconnect(),
      this.fsBridge.disconnect(),
      this.sshBridge.disconnect(),
      this.ingressBridge.disconnect(),
    ]);

    // Tear down host-side network + streams promptly. QEMU may still be running
    // for a short grace period while SandboxController.close() tries SIGTERM.
    await this.network?.close();

    for (const stream of this.tcpStreams.values()) {
      stream.destroy();
    }
    this.tcpStreams.clear();
    this.tcpOpenWaiters.clear();

    for (const stream of this.ingressTcpStreams.values()) {
      stream.destroy();
    }
    this.ingressTcpStreams.clear();
    this.ingressTcpOpenWaiters.clear();

    await this.controller.close();
    await this.fsService?.close();

    this.started = false;
  }

  private attachClient(client: SandboxClient) {
    this.clients.add(client);
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

  private assertGuestPath(value: string, field: string): void {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${field} must be a non-empty string`);
    }
    if (value.includes("\0")) {
      throw new Error(`${field} contains null bytes`);
    }
  }

  private allocateFileOpId(): number {
    let id = this.nextFileOpId;
    for (let i = 0; i <= MAX_REQUEST_ID; i += 1) {
      if (
        !this.inflight.has(id) &&
        !this.startedExecs.has(id) &&
        !this.fileOps.has(id)
      ) {
        this.nextFileOpId = id + 1;
        if (this.nextFileOpId > MAX_REQUEST_ID) this.nextFileOpId = 1;
        return id;
      }
      id += 1;
      if (id > MAX_REQUEST_ID) id = 1;
    }
    throw new Error("no available request ids for file operations");
  }

  private async waitForExecIdle(signal?: AbortSignal): Promise<void> {
    while (
      this.startedExecs.size > 0 ||
      this.activeFileOpId !== null ||
      this.execQueue.length > 0
    ) {
      if (signal?.aborted) {
        throw new Error("operation aborted");
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 10);
        t.unref?.();
      });
    }
  }

  private isNonTerminalExecErrorCode(code: string): boolean {
    return code === "stdin_backpressure" || code === "stdin_chunk_too_large";
  }

  private flushBridgeWritableWaiters() {
    if (this.bridgeWritableWaiters.length === 0) return;
    const waiters = this.bridgeWritableWaiters;
    this.bridgeWritableWaiters = [];
    for (const waiter of waiters) {
      try {
        waiter.cleanup?.();
      } catch {
        // ignore
      }
      waiter.resolve();
    }
  }

  private async waitForBridgeWritable(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error("operation aborted");
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: BridgeWritableWaiter = {
        resolve: () => resolve(),
        reject,
      };

      if (signal) {
        const onAbort = () => {
          this.bridgeWritableWaiters = this.bridgeWritableWaiters.filter(
            (entry) => entry !== waiter,
          );
          reject(new Error("operation aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }

      this.bridgeWritableWaiters.push(waiter);
    });
  }

  private async sendControlMessage(
    message: object,
    signal?: AbortSignal,
  ): Promise<void> {
    while (!this.bridge.send(message)) {
      await this.waitForBridgeWritable(signal);
    }
  }

  private resolveFileOperation(id: number): void {
    const op = this.fileOps.get(id);
    if (!op) return;
    this.fileOps.delete(id);

    if (op.kind === "read") {
      op.stream.end();
    }

    op.resolve();

    if (this.activeFileOpId === id) {
      this.activeFileOpId = null;
      this.pumpExecQueue();
    }
  }

  private rejectFileOperation(id: number, err: Error): void {
    const op = this.fileOps.get(id);
    if (!op) return;
    this.fileOps.delete(id);

    if (op.kind === "read") {
      queueMicrotask(() => {
        op.stream.destroy(err);
      });
    }

    op.reject(err);

    if (this.activeFileOpId === id) {
      this.activeFileOpId = null;
      this.pumpExecQueue();
    }
  }

  private failFileOperations(message: string): void {
    const err = new Error(message);
    for (const id of Array.from(this.fileOps.keys())) {
      this.rejectFileOperation(id, err);
    }
  }

  private disconnectClient(client: SandboxClient) {
    this.clients.delete(client);

    for (const [id, entry] of this.inflight.entries()) {
      if (entry === client) {
        this.inflight.delete(id);
        this.stdinAllowed.delete(id);
        this.stdinCredits.delete(id);
        this.pendingExecWindows.delete(id);
        this.clearQueuedStdin(id);
        this.queuedPtyResize.delete(id);
      }
    }

    // Remove any queued exec requests owned by this client.
    if (this.execQueue.length > 0) {
      this.execQueue = this.execQueue.filter(
        (entry) => entry.client !== client,
      );
    }
  }

  private clearQueuedStdin(id: number) {
    const bytes = this.queuedStdinBytes.get(id) ?? 0;
    if (bytes > 0) {
      this.queuedStdinBytesTotal = Math.max(
        0,
        this.queuedStdinBytesTotal - bytes,
      );
    }
    this.queuedStdin.delete(id);
    this.queuedStdinBytes.delete(id);
  }

  private handleClientMessage(client: SandboxClient, message: ClientMessage) {
    if (this.hasDebug("protocol")) {
      const extra =
        message.type === "exec"
          ? ` id=${message.id} cmd=${message.cmd}`
          : message.type === "stdin"
            ? ` id=${message.id} bytes=${message.data ? Math.floor((message.data.length * 3) / 4) : 0}${message.eof ? " eof" : ""}`
            : message.type === "pty_resize"
              ? ` id=${message.id} rows=${message.rows} cols=${message.cols}`
              : message.type === "boot"
                ? ` fuseMount=${(message as any).fuseMount ?? ""} binds=${Array.isArray((message as any).fuseBinds) ? (message as any).fuseBinds.length : 0}`
                : message.type === "lifecycle"
                  ? ` action=${(message as any).action}`
                  : "";
      this.emitDebug("protocol", `client rx type=${message.type}${extra}`);
    }
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
    } else if (message.type === "exec_window") {
      this.handleExecWindow(client, message);
    } else if (message.type === "lifecycle") {
      if (message.action === "restart") {
        void this.controller.restart();
      } else if (message.action === "shutdown") {
        void this.controller.close();
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

    const changed =
      !this.bootConfig || !isSameSandboxFsConfig(this.bootConfig, config);
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

  private startExecNow(entry: {
    client: SandboxClient;
    message: ExecCommandMessage;
    payload: any;
  }): void {
    const id = entry.message.id;

    if (!this.bridge.send(buildExecRequest(id, entry.payload))) {
      this.inflight.delete(id);
      this.startedExecs.delete(id);
      this.stdinAllowed.delete(id);
      this.stdinCredits.delete(id);
      this.pendingExecWindows.delete(id);
      this.clearQueuedStdin(id);
      this.queuedPtyResize.delete(id);
      sendError(entry.client, {
        type: "error",
        id,
        code: "queue_full",
        message: "virtio bridge queue exceeded",
      });
      return;
    }

    this.startedExecs.add(id);

    this.flushQueuedPtyResizeFor(id);
    this.flushQueuedStdinFor(id);
    this.flushPendingExecWindowsFor(id);

    if (
      (this.queuedStdin.get(id)?.length ?? 0) > 0 ||
      this.queuedPtyResize.has(id)
    ) {
      this.scheduleExecIoFlush();
    }
  }

  private pumpExecQueue(): void {
    if (this.activeFileOpId !== null) return;

    while (this.execQueue.length > 0) {
      const next = this.execQueue.shift()!;
      const id = next.message.id;

      // The client may have disconnected while queued.
      if (!this.inflight.has(id)) {
        this.startedExecs.delete(id);
        this.stdinAllowed.delete(id);
        this.stdinCredits.delete(id);
        this.pendingExecWindows.delete(id);
        this.clearQueuedStdin(id);
        this.queuedPtyResize.delete(id);
        continue;
      }

      this.startExecNow(next);
    }
  }

  private handleExec(client: SandboxClient, message: ExecCommandMessage) {
    if (this.hasDebug("exec")) {
      const envKeys = (message.env ?? [])
        .map((entry) => String(entry).split("=", 1)[0])
        .filter((k) => k && k.length > 0);
      const cwd = message.cwd ? ` cwd=${message.cwd}` : "";
      const argv =
        (message.argv ?? []).length > 0
          ? ` argv=${JSON.stringify(message.argv)}`
          : "";
      const env =
        envKeys.length > 0 ? ` envKeys=${JSON.stringify(envKeys)}` : "";
      const stdin = message.stdin ? " stdin" : "";
      const pty = message.pty ? " pty" : "";
      this.emitDebug(
        "exec",
        `exec start id=${message.id} cmd=${message.cmd}${cwd}${argv}${env}${stdin}${pty}`,
      );
    }
    if (!isValidRequestId(message.id) || !message.cmd) {
      sendError(client, {
        type: "error",
        code: "invalid_request",
        message: "exec requires uint32 id and cmd",
      });
      return;
    }

    if (this.inflight.has(message.id) || this.startedExecs.has(message.id)) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "duplicate_id",
        message: "request id already in use",
      });
      return;
    }

    const validWindow = (v: unknown) =>
      v === undefined ||
      (typeof v === "number" &&
        Number.isInteger(v) &&
        v >= 0 &&
        v <= 0xffffffff);

    if (
      !validWindow(message.stdout_window) ||
      !validWindow(message.stderr_window)
    ) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "invalid_request",
        message:
          "stdout_window/stderr_window must be uint32 byte counts (0 = default)",
      });
      return;
    }

    const execPressure = this.startedExecs.size + this.execQueue.length;
    if (execPressure >= this.options.maxQueuedExecs) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "queue_full",
        message: `too many concurrent exec requests (limit ${this.options.maxQueuedExecs})`,
      });
      return;
    }

    this.inflight.set(message.id, client);
    if (message.stdin) {
      this.stdinAllowed.add(message.id);
      this.stdinCredits.set(message.id, 0);
    }

    const payload = {
      cmd: message.cmd,
      argv: message.argv ?? [],
      env: message.env ?? [],
      cwd: message.cwd,
      stdin: message.stdin ?? false,
      pty: message.pty ?? false,
      stdout_window: message.stdout_window,
      stderr_window: message.stderr_window,
    };

    const entry = { client, message, payload };

    // Keep file operations mutually exclusive with exec start. Once the file
    // operation completes, queued execs are started concurrently.
    if (this.activeFileOpId !== null) {
      this.execQueue.push(entry);
      return;
    }

    this.startExecNow(entry);
  }

  private handleStdin(client: SandboxClient, message: StdinCommandMessage) {
    if (this.hasDebug("exec")) {
      const bytes = message.data ? estimateBase64Bytes(message.data) : 0;
      this.emitDebug(
        "exec",
        `stdin id=${message.id} bytes=${bytes}${message.eof ? " eof" : ""}`,
      );
    }
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

    const queueStdinChunk = (
      cancelNotStartedExecOnOverflow: boolean,
    ): boolean => {
      const queuedBytes = this.queuedStdinBytes.get(message.id) ?? 0;
      const nextBytes = queuedBytes + data.length;
      const nextTotal = this.queuedStdinBytesTotal + data.length;

      const overflowMessage =
        nextBytes > this.options.maxQueuedStdinBytes
          ? `queued stdin exceeds limit (${this.options.maxQueuedStdinBytes} bytes)`
          : nextTotal > this.options.maxTotalQueuedStdinBytes
            ? `total queued stdin exceeds limit (${this.options.maxTotalQueuedStdinBytes} bytes)`
            : null;

      if (overflowMessage) {
        sendError(client, {
          type: "error",
          id: message.id,
          code: "payload_too_large",
          message: overflowMessage,
        });

        if (
          cancelNotStartedExecOnOverflow &&
          !this.startedExecs.has(message.id)
        ) {
          // Cancel queued execs on stdin overflow to avoid running with partial
          // stdin once file-operation gating is lifted.
          this.inflight.delete(message.id);
          this.startedExecs.delete(message.id);
          this.stdinAllowed.delete(message.id);
          this.stdinCredits.delete(message.id);
          this.pendingExecWindows.delete(message.id);
          this.clearQueuedStdin(message.id);
          this.queuedPtyResize.delete(message.id);
          this.execQueue = this.execQueue.filter(
            (entry) => entry.message.id !== message.id,
          );
        }

        return false;
      }

      const list = this.queuedStdin.get(message.id) ?? [];
      list.push({ data, eof: Boolean(message.eof) });
      this.queuedStdin.set(message.id, list);
      this.queuedStdinBytes.set(message.id, nextBytes);
      this.queuedStdinBytesTotal = nextTotal;
      return true;
    };

    if (!this.startedExecs.has(message.id)) {
      queueStdinChunk(true);
      return;
    }

    if (data.length === 0 && !message.eof) {
      return;
    }

    // Always enqueue then flush. This lets us apply both virtio backpressure
    // and guest-advertised stdin credits consistently.
    if (!queueStdinChunk(false)) {
      return;
    }

    if (!this.flushQueuedStdinFor(message.id)) {
      this.scheduleExecIoFlush();
    }
  }

  private handlePtyResize(
    client: SandboxClient,
    message: PtyResizeCommandMessage,
  ) {
    if (this.hasDebug("exec")) {
      this.emitDebug(
        "exec",
        `pty_resize id=${message.id} rows=${message.rows} cols=${message.cols}`,
      );
    }
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
    if (
      !Number.isFinite(rows) ||
      !Number.isFinite(cols) ||
      rows < 1 ||
      cols < 1
    ) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "invalid_request",
        message: "pty_resize requires positive rows and cols",
      });
      return;
    }

    const safeRows = Math.trunc(rows);
    const safeCols = Math.trunc(cols);

    if (!this.startedExecs.has(message.id)) {
      this.queuedPtyResize.set(message.id, { rows: safeRows, cols: safeCols });
      return;
    }

    if (!this.bridge.send(buildPtyResize(message.id, safeRows, safeCols))) {
      // Keep queued to retry once the virtio bridge becomes writable again.
      this.queuedPtyResize.set(message.id, { rows: safeRows, cols: safeCols });
      this.scheduleExecIoFlush();
    }
  }

  private scheduleExecWindowFlush() {
    if (this.execWindowFlushScheduled) return;
    this.execWindowFlushScheduled = true;
    setImmediate(() => {
      this.execWindowFlushScheduled = false;
      this.flushPendingExecWindows();
    });
  }

  private scheduleExecIoFlush() {
    if (this.execIoFlushScheduled) return;
    this.execIoFlushScheduled = true;
    setImmediate(() => {
      this.execIoFlushScheduled = false;
      this.flushQueuedPtyResize();
      this.flushQueuedStdin();
    });
  }

  private flushQueuedPtyResizeFor(id: number): boolean {
    const resize = this.queuedPtyResize.get(id);
    if (!resize) return true;

    if (!this.inflight.has(id)) {
      this.queuedPtyResize.delete(id);
      return true;
    }

    if (!this.startedExecs.has(id)) {
      return true;
    }

    if (!this.bridge.send(buildPtyResize(id, resize.rows, resize.cols))) {
      // Queue still full; wait for bridge.onWritable to retry.
      return false;
    }

    this.queuedPtyResize.delete(id);
    return true;
  }

  private flushQueuedPtyResize() {
    for (const id of Array.from(this.queuedPtyResize.keys())) {
      if (!this.flushQueuedPtyResizeFor(id)) {
        return;
      }
    }
  }

  private flushQueuedStdinFor(id: number): boolean {
    const list = this.queuedStdin.get(id);
    if (!list || list.length === 0) return true;

    if (!this.inflight.has(id)) {
      this.clearQueuedStdin(id);
      return true;
    }

    if (!this.startedExecs.has(id)) {
      return true;
    }

    let remainingBytes = this.queuedStdinBytes.get(id) ?? 0;
    let credit = this.stdinCredits.get(id) ?? 0;

    let progressed = false;
    let removed = 0;

    // Send as much as we can, constrained by:
    // - virtio bridge queue capacity
    // - guest-advertised stdin credits (stdin_window)
    while (removed < list.length) {
      const chunk = list[removed]!;

      // Allow EOF with an empty payload even when out of credit.
      if (chunk.data.length === 0) {
        if (chunk.eof) {
          if (!this.bridge.send(buildStdinData(id, chunk.data, true))) {
            break;
          }
          progressed = true;
        }
        removed += 1;
        continue;
      }

      if (credit <= 0) {
        break;
      }

      const toSend = Math.min(chunk.data.length, credit);
      const part = chunk.data.subarray(0, toSend);
      const eof = chunk.eof && toSend === chunk.data.length ? true : undefined;

      if (!this.bridge.send(buildStdinData(id, part, eof))) {
        // Queue still full; wait for bridge.onWritable to retry.
        break;
      }

      progressed = true;
      credit -= toSend;
      this.stdinCredits.set(id, credit);

      remainingBytes = Math.max(0, remainingBytes - toSend);
      this.queuedStdinBytesTotal = Math.max(
        0,
        this.queuedStdinBytesTotal - toSend,
      );

      if (toSend < chunk.data.length) {
        // Partial send: keep the remaining tail queued.
        chunk.data = chunk.data.subarray(toSend);
        break;
      }

      // Entire chunk sent, pop it.
      removed += 1;
    }

    if (!progressed) return false;

    if (removed >= list.length) {
      this.queuedStdin.delete(id);
      this.queuedStdinBytes.delete(id);
      return true;
    }

    if (removed > 0) {
      this.queuedStdin.set(id, list.slice(removed));
    }

    this.queuedStdinBytes.set(id, remainingBytes);
    return false;
  }

  private flushQueuedStdin() {
    for (const id of Array.from(this.queuedStdin.keys())) {
      if (!this.flushQueuedStdinFor(id)) {
        return;
      }
    }
  }

  private flushPendingExecWindowsFor(id: number): boolean {
    const win = this.pendingExecWindows.get(id);
    if (!win) return true;

    if (!this.inflight.has(id)) {
      this.pendingExecWindows.delete(id);
      return true;
    }

    if (!this.startedExecs.has(id)) {
      return true;
    }

    const stdout = win.stdout > 0 ? win.stdout : undefined;
    const stderr = win.stderr > 0 ? win.stderr : undefined;

    if (!stdout && !stderr) {
      this.pendingExecWindows.delete(id);
      return true;
    }

    if (!this.bridge.send(buildExecWindow(id, stdout, stderr))) {
      // Queue still full; wait for bridge.onWritable to retry.
      return false;
    }

    this.pendingExecWindows.delete(id);
    return true;
  }

  private flushPendingExecWindows() {
    for (const id of Array.from(this.pendingExecWindows.keys())) {
      if (!this.flushPendingExecWindowsFor(id)) {
        return;
      }
    }
  }

  private handleExecWindow(
    client: SandboxClient,
    message: ExecWindowCommandMessage,
  ) {
    if (!isValidRequestId(message.id)) {
      sendError(client, {
        type: "error",
        code: "invalid_request",
        message: "exec_window requires a uint32 id",
      });
      return;
    }

    const owner = this.inflight.get(message.id);
    if (!owner) {
      // ignore (the exec may have exited)
      return;
    }
    if (owner !== client) {
      // ignore (credits must come from the client that started the exec)
      return;
    }

    const stdout = message.stdout;
    const stderr = message.stderr;

    const valid = (v: unknown) =>
      v === undefined ||
      (typeof v === "number" &&
        Number.isInteger(v) &&
        v > 0 &&
        v <= 0xffffffff);

    if (!valid(stdout) || !valid(stderr)) {
      sendError(client, {
        type: "error",
        id: message.id,
        code: "invalid_request",
        message: "exec_window requires positive integer credits",
      });
      return;
    }

    const out = stdout ?? 0;
    const err = stderr ?? 0;
    if (out <= 0 && err <= 0) return;

    const existing = this.pendingExecWindows.get(message.id);
    if (existing) {
      existing.stdout = Math.min(0xffffffff, existing.stdout + out);
      existing.stderr = Math.min(0xffffffff, existing.stderr + err);
    } else {
      this.pendingExecWindows.set(message.id, {
        stdout: Math.min(0xffffffff, out),
        stderr: Math.min(0xffffffff, err),
      });
    }

    // Try sending immediately; if the bridge is congested we'll retry later.
    this.flushPendingExecWindows();
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
    this.startedExecs.clear();
    this.stdinAllowed.clear();
    this.pendingExecWindows.clear();
    this.execQueue = [];
    this.queuedStdin.clear();
    this.queuedStdinBytes.clear();
    this.queuedStdinBytesTotal = 0;
    this.queuedPtyResize.clear();

    this.failFileOperations(message);

    if (this.bridgeWritableWaiters.length > 0) {
      const waiters = this.bridgeWritableWaiters;
      this.bridgeWritableWaiters = [];
      for (const waiter of waiters) {
        try {
          waiter.cleanup?.();
        } catch {
          // ignore
        }
        waiter.reject(new Error(message));
      }
    }
  }
}

function normalizeSandboxFsConfig(
  message: BootCommandMessage,
): SandboxFsConfig {
  const fuseMount = normalizeMountPath(
    message.fuseMount ?? "/data",
    "fuseMount",
  );
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
  return pieces
    .filter((piece) => piece.length > 0)
    .join(" ")
    .trim();
}

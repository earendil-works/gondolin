import { Duplex, PassThrough, Readable } from "stream";

import { toBufferIterable } from "../utils/buffer-iter.ts";
import {
  buildExecRequest,
  buildExecWindow,
  buildFileDeleteRequest,
  buildFileReadRequest,
  buildFileWriteData,
  buildFileWriteRequest,
  buildPtyResize,
  buildStdinData,
} from "./virtio-protocol.ts";
import {
  type BootCommandMessage,
  type ClientMessage,
  type ExecCommandMessage,
  type ExecWindowCommandMessage,
  type PtyResizeCommandMessage,
  type StdinCommandMessage,
} from "./control-protocol.ts";
import type { SandboxState } from "./controller.ts";
import {
  type GuestFileDeleteOptions,
  type GuestFileReadOptions,
  type GuestFileWriteOptions,
} from "./server-options.ts";
import {
  MAX_REQUEST_ID,
  TcpForwardStream,
  estimateBase64Bytes,
  isValidRequestId,
} from "./server-transport.ts";
import {
  type SandboxClient,
  type SandboxConnection,
  LocalSandboxClient,
  sendError,
  sendJson,
} from "./client.ts";
import {
  buildSandboxfsAppend,
  isSameSandboxFsConfig,
  normalizeSandboxFsConfig,
  type SandboxFsConfig,
} from "./server-boot-config.ts";
import { stripTrailingNewline } from "../debug.ts";

type BridgeWritableWaiter = {
  resolve: () => void;
  reject: (err: Error) => void;
  cleanup?: () => void;
};

type FileReadOperation = {
  kind: "read";
  stream: PassThrough;
  resolve: () => void;
  reject: (err: Error) => void;
};

type FileDoneOperation = {
  kind: "write" | "delete";
  resolve: () => void;
  reject: (err: Error) => void;
};

export class SandboxServerOps {
  [key: string]: any;

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

  broadcastStatus(state: SandboxState) {
    for (const client of this.clients) {
      sendJson(client, { type: "status", state });
    }
    this.emit("state", state);
  }

  clearVfsReadyTimer() {
    if (!this.vfsReadyTimer) return;
    clearTimeout(this.vfsReadyTimer);
    this.vfsReadyTimer = null;
  }

  handleVfsReady() {
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

  handleVfsError(message: string, code = "vfs_error") {
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
    for (const client of Array.from(this.clients as Set<SandboxClient>)) {
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

  async startInternal(): Promise<void> {
    if (this.started) return;

    this.started = true;
    this.network?.start();
    this.bridge.connect();
    this.fsBridge.connect();
    this.sshBridge.connect();
    this.ingressBridge.connect();
  }

  async closeInternal() {
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

  attachClient(client: SandboxClient) {
    this.clients.add(client);
    sendJson(client, { type: "status", state: this.status });
  }

  closeClient(client: SandboxClient) {
    this.disconnectClient(client);
    client.close();
  }

  closeAllClients() {
    for (const client of Array.from(this.clients as Set<SandboxClient>)) {
      this.closeClient(client);
    }
  }

  assertGuestPath(value: string, field: string): void {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${field} must be a non-empty string`);
    }
    if (value.includes("\0")) {
      throw new Error(`${field} contains null bytes`);
    }
  }

  allocateFileOpId(): number {
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

  async waitForExecIdle(signal?: AbortSignal): Promise<void> {
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

  isNonTerminalExecErrorCode(code: string): boolean {
    return code === "stdin_backpressure" || code === "stdin_chunk_too_large";
  }

  flushBridgeWritableWaiters() {
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

  async waitForBridgeWritable(signal?: AbortSignal): Promise<void> {
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
            (entry: BridgeWritableWaiter) => entry !== waiter,
          );
          reject(new Error("operation aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }

      this.bridgeWritableWaiters.push(waiter);
    });
  }

  async sendControlMessage(
    message: object,
    signal?: AbortSignal,
  ): Promise<void> {
    while (!this.bridge.send(message)) {
      await this.waitForBridgeWritable(signal);
    }
  }

  resolveFileOperation(id: number): void {
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

  rejectFileOperation(id: number, err: Error): void {
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

  failFileOperations(message: string): void {
    const err = new Error(message);
    for (const id of Array.from(this.fileOps.keys() as Iterable<number>)) {
      this.rejectFileOperation(id, err);
    }
  }

  disconnectClient(client: SandboxClient) {
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
        (entry: { client: SandboxClient }) => entry.client !== client,
      );
    }
  }

  clearQueuedStdin(id: number) {
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

  handleClientMessage(client: SandboxClient, message: ClientMessage) {
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

  async handleBoot(client: SandboxClient, message: BootCommandMessage) {
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

  startExecNow(entry: {
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

  pumpExecQueue(): void {
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

  handleExec(client: SandboxClient, message: ExecCommandMessage) {
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

  handleStdin(client: SandboxClient, message: StdinCommandMessage) {
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
            (entry: { message: { id: number } }) =>
              entry.message.id !== message.id,
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

  handlePtyResize(client: SandboxClient, message: PtyResizeCommandMessage) {
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

  scheduleExecWindowFlush() {
    if (this.execWindowFlushScheduled) return;
    this.execWindowFlushScheduled = true;
    setImmediate(() => {
      this.execWindowFlushScheduled = false;
      this.flushPendingExecWindows();
    });
  }

  scheduleExecIoFlush() {
    if (this.execIoFlushScheduled) return;
    this.execIoFlushScheduled = true;
    setImmediate(() => {
      this.execIoFlushScheduled = false;
      this.flushQueuedPtyResize();
      this.flushQueuedStdin();
    });
  }

  flushQueuedPtyResizeFor(id: number): boolean {
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

  flushQueuedPtyResize() {
    for (const id of Array.from(
      this.queuedPtyResize.keys() as Iterable<number>,
    )) {
      if (!this.flushQueuedPtyResizeFor(id)) {
        return;
      }
    }
  }

  flushQueuedStdinFor(id: number): boolean {
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

  flushQueuedStdin() {
    for (const id of Array.from(this.queuedStdin.keys() as Iterable<number>)) {
      if (!this.flushQueuedStdinFor(id)) {
        return;
      }
    }
  }

  flushPendingExecWindowsFor(id: number): boolean {
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

  flushPendingExecWindows() {
    for (const id of Array.from(
      this.pendingExecWindows.keys() as Iterable<number>,
    )) {
      if (!this.flushPendingExecWindowsFor(id)) {
        return;
      }
    }
  }

  handleExecWindow(client: SandboxClient, message: ExecWindowCommandMessage) {
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

  failInflight(code: string, message: string) {
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

export function installSandboxServerOps(target: { prototype: object }): void {
  const source = SandboxServerOps.prototype as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(source)) {
    if (name === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    if (!descriptor) continue;
    Object.defineProperty(target.prototype, name, descriptor);
  }
}

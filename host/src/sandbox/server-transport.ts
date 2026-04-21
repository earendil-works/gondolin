import fs from "fs";
import net from "net";
import path from "path";
import { Duplex } from "stream";
import { EventEmitter } from "events";

import {
  FrameReader,
  type IncomingMessage,
  decodeMessage,
  encodeFrame,
} from "./virtio-protocol.ts";
import { getProcessProfiler } from "../utils/profile.ts";

export const MAX_REQUEST_ID = 0xffffffff;

const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;
const profile = getProcessProfiler("wasm-host");

type FramedWritable = {
  /** writable state flag when available */
  writable?: boolean;
  /** frame write entrypoint */
  write(chunk: Buffer): boolean;
  /** one-shot drain listener */
  once(event: "drain", listener: () => void): unknown;
};

function isWritableStream(
  writable: FramedWritable | null,
): writable is FramedWritable {
  if (!writable) return false;
  return writable.writable !== false;
}

class FramedWriteQueue {
  private writable: FramedWritable | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private waitingDrain = false;
  private drainSource: FramedWritable | null = null;
  private readonly maxPendingBytes: number;
  private readonly onWritable: () => void;
  private readonly handleDrain = () => {
    if (!this.waitingDrain) return;
    this.waitingDrain = false;
    this.drainSource = null;
    this.flush();
  };

  constructor(maxPendingBytes: number, onWritable: () => void) {
    this.maxPendingBytes = maxPendingBytes;
    this.onWritable = onWritable;
  }

  attachWritable(writable: FramedWritable): void {
    this.writable = writable;
    this.waitingDrain = false;
    this.drainSource = null;
    this.flush();
  }

  detachWritable(): void {
    this.writable = null;
    this.waitingDrain = false;
    this.drainSource = null;
  }

  clearPending(): void {
    this.pending = [];
    this.pendingBytes = 0;
    this.waitingDrain = false;
    this.drainSource = null;
  }

  send(message: object): boolean {
    const frame = encodeFrame(message);
    if (this.pending.length === 0 && !this.waitingDrain) {
      return this.writeFrame(frame);
    }

    const queued = this.queueFrame(frame);
    if (queued && isWritableStream(this.writable) && !this.waitingDrain) {
      this.flush();
    }
    return queued;
  }

  private writeFrame(frame: Buffer): boolean {
    if (!isWritableStream(this.writable)) {
      return this.queueFrame(frame);
    }

    const writable = this.writable;
    const ok = writable.write(frame);
    if (!ok) {
      this.waitingDrain = true;
      this.drainSource = writable;
      writable.once("drain", this.handleDrain);
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

  private flush(): void {
    if (!isWritableStream(this.writable) || this.waitingDrain) return;

    let freed = false;
    while (this.pending.length > 0) {
      const frame = this.pending.shift()!;
      this.pendingBytes -= frame.length;
      freed = true;

      const ok = this.writeFrame(frame);
      if (!ok || this.waitingDrain) {
        if (freed) this.onWritable();
        return;
      }
    }

    if (freed) this.onWritable();
  }
}

export interface ServerTransport {
  /** connect transport endpoint */
  connect(): void;
  /** disconnect transport endpoint */
  disconnect(): Promise<void>;
  /** send framed message over transport */
  send(message: object): boolean;
  /** decoded inbound message callback */
  onMessage?: (message: IncomingMessage) => void;
  /** transport error callback */
  onError?: (error: unknown) => void;
  /** callback when queued writes may resume */
  onWritable?: () => void;
}

function removeEventListenerCompat(
  stream: NodeJS.EventEmitter,
  event: string,
  listener: (...args: any[]) => void,
): void {
  if (typeof (stream as any).off === "function") {
    (stream as any).off(event, listener);
    return;
  }
  if (typeof (stream as any).removeListener === "function") {
    (stream as any).removeListener(event, listener);
  }
}

export class UnixSocketTransport implements ServerTransport {
  private socket: net.Socket | null = null;
  private server: net.Server | null = null;
  private readonly reader = new FrameReader();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private allowReconnect = true;
  private closed = false;
  private readonly socketPath: string;
  private readonly queue: FramedWriteQueue;

  constructor(
    socketPath: string,
    maxPendingBytes: number = DEFAULT_MAX_PENDING_BYTES,
  ) {
    this.socketPath = socketPath;
    this.queue = new FramedWriteQueue(maxPendingBytes, () => {
      this.onWritable?.();
    });
  }

  connect(): void {
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

    this.queue.clearPending();
  }

  send(message: object): boolean {
    if (this.closed) return false;
    if (!this.socket) {
      this.connect();
    }
    return this.queue.send(message);
  }

  onMessage?: (message: IncomingMessage) => void;
  onError?: (error: unknown) => void;
  onWritable?: () => void;

  private attachSocket(socket: net.Socket): void {
    if (this.socket) {
      this.socket.destroy();
    }

    this.socket = socket;
    this.queue.attachWritable(socket);

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
  }

  private handleDisconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.queue.detachWritable();
  }

  private scheduleReconnect(): void {
    if (!this.allowReconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.allowReconnect) {
        this.connect();
      }
    }, 500);
  }
}

export type StreamTransportOptions = {
  /** stream that provides inbound framed bytes */
  input: NodeJS.ReadableStream;
  /** stream that receives outbound framed bytes */
  output: NodeJS.WritableStream;
};

export class StreamTransport implements ServerTransport {
  private readonly reader = new FrameReader();
  private readonly queue: FramedWriteQueue;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private connected = false;
  private closed = false;

  private readonly onInputData = (chunk: Buffer | string) => {
    if (typeof chunk === "string") {
      this.onError?.(new Error("stream transport expects binary input"));
      return;
    }

    try {
      this.reader.push(chunk, (frame) => {
        try {
          const message = decodeMessage(frame) as IncomingMessage;
          this.onMessage?.(message);
        } catch (err) {
          this.onError?.(err);
        }
      });
    } catch (err) {
      this.onError?.(err);
    }
  };

  private readonly onInputError = (err: unknown) => {
    this.onError?.(err);
  };

  private readonly onInputEnd = () => {
    this.handleDisconnect();
  };

  private readonly onOutputError = (err: unknown) => {
    this.onError?.(err);
  };

  constructor(
    options: StreamTransportOptions,
    maxPendingBytes: number = DEFAULT_MAX_PENDING_BYTES,
  ) {
    this.input = options.input;
    this.output = options.output;
    this.queue = new FramedWriteQueue(maxPendingBytes, () => {
      this.onWritable?.();
    });
  }

  connect(): void {
    if (this.closed || this.connected) return;
    this.connected = true;

    this.input.on("data", this.onInputData);
    this.input.on("error", this.onInputError as (...args: any[]) => void);
    this.input.on("end", this.onInputEnd);
    this.input.on("close", this.onInputEnd);

    this.output.on("error", this.onOutputError as (...args: any[]) => void);

    this.queue.attachWritable(this.output as unknown as FramedWritable);
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.handleDisconnect();
    this.queue.clearPending();
  }

  send(message: object): boolean {
    if (this.closed) return false;
    if (!this.connected) {
      this.connect();
    }
    return this.queue.send(message);
  }

  onMessage?: (message: IncomingMessage) => void;
  onError?: (error: unknown) => void;
  onWritable?: () => void;

  private handleDisconnect(): void {
    if (!this.connected) return;
    this.connected = false;

    removeEventListenerCompat(
      this.input as unknown as NodeJS.EventEmitter,
      "data",
      this.onInputData as (...args: any[]) => void,
    );
    removeEventListenerCompat(
      this.input as unknown as NodeJS.EventEmitter,
      "error",
      this.onInputError as (...args: any[]) => void,
    );
    removeEventListenerCompat(
      this.input as unknown as NodeJS.EventEmitter,
      "end",
      this.onInputEnd,
    );
    removeEventListenerCompat(
      this.input as unknown as NodeJS.EventEmitter,
      "close",
      this.onInputEnd,
    );

    removeEventListenerCompat(
      this.output as unknown as NodeJS.EventEmitter,
      "error",
      this.onOutputError as (...args: any[]) => void,
    );

    this.queue.detachWritable();
  }
}

export type FunctionBridgeTransportOptions = {
  /** framed write callback to the runtime bridge */
  sendFrame: (frame: Buffer) => boolean;
  /** framed read subscription from the runtime bridge */
  subscribeFrame: (listener: (frame: Buffer | Uint8Array) => void) =>
    | (() => void)
    | void;
  /** writable subscription from the runtime bridge */
  subscribeWritable?: (listener: () => void) => (() => void) | void;
  /** connect hook for runtime bridge setup */
  connect?: () => void;
  /** disconnect hook for runtime bridge teardown */
  disconnect?: () => void | Promise<void>;
};

class CallbackWritable extends EventEmitter implements FramedWritable {
  writable = true;
  private readonly sendFrame: (frame: Buffer) => boolean;

  constructor(sendFrame: (frame: Buffer) => boolean) {
    super();
    this.sendFrame = sendFrame;
  }

  write(chunk: Buffer): boolean {
    return this.sendFrame(chunk);
  }

  close(): void {
    this.writable = false;
  }

  markWritable(): void {
    this.emit("drain");
  }
}

export class FunctionBridgeTransport implements ServerTransport {
  private readonly reader = new FrameReader();
  private readonly queue: FramedWriteQueue;
  private readonly options: FunctionBridgeTransportOptions;
  private readonly writableSink: CallbackWritable;
  private connected = false;
  private closed = false;
  private unsubscribeFrame: (() => void) | null = null;
  private unsubscribeWritable: (() => void) | null = null;

  onMessage?: (message: IncomingMessage) => void;
  onError?: (error: unknown) => void;
  onWritable?: () => void;

  constructor(
    options: FunctionBridgeTransportOptions,
    maxPendingBytes: number = DEFAULT_MAX_PENDING_BYTES,
  ) {
    this.options = options;
    this.writableSink = new CallbackWritable((frame) =>
      this.options.sendFrame(frame),
    );
    this.queue = new FramedWriteQueue(maxPendingBytes, () => {
      this.onWritable?.();
    });
  }

  connect(): void {
    if (this.closed || this.connected) return;
    this.connected = true;

    try {
      this.options.connect?.();
    } catch (err) {
      this.onError?.(err);
    }

    const unsubscribeFrame = this.options.subscribeFrame((frame) => {
      this.handleIncomingFrame(frame);
    });
    this.unsubscribeFrame =
      typeof unsubscribeFrame === "function" ? unsubscribeFrame : null;

    if (this.options.subscribeWritable) {
      const unsubscribeWritable = this.options.subscribeWritable(() => {
        this.writableSink.markWritable();
      });
      this.unsubscribeWritable =
        typeof unsubscribeWritable === "function" ? unsubscribeWritable : null;
    }

    this.queue.attachWritable(this.writableSink);
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.handleDisconnect();
    this.queue.clearPending();

    try {
      await this.options.disconnect?.();
    } catch (err) {
      this.onError?.(err);
    }
  }

  send(message: object): boolean {
    if (this.closed) return false;
    if (!this.connected) {
      this.connect();
    }
    profile.count("bridge.transport.send_calls");
    return this.queue.send(message);
  }

  private handleIncomingFrame(frame: Buffer | Uint8Array): void {
    const chunk = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
    profile.observe("bridge.transport.recv_chunk_bytes", chunk.length);

    try {
      this.reader.push(chunk, (payload) => {
        try {
          const endDecode = profile.startSpan("bridge.transport.decode_message");
          const message = decodeMessage(payload) as IncomingMessage;
          endDecode();
          this.onMessage?.(message);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          this.onError?.(new Error(`decode failed: ${detail}`));
        }
      });
    } catch (err) {
      this.onError?.(err);
    }
  }

  private handleDisconnect(): void {
    if (!this.connected) return;
    this.connected = false;

    try {
      this.unsubscribeFrame?.();
    } catch {
      // ignore
    }
    this.unsubscribeFrame = null;

    try {
      this.unsubscribeWritable?.();
    } catch {
      // ignore
    }
    this.unsubscribeWritable = null;

    this.writableSink.close();
    this.queue.detachWritable();
  }
}

export class NoopTransport implements ServerTransport {
  onMessage?: (message: IncomingMessage) => void;
  onError?: (error: unknown) => void;
  onWritable?: () => void;

  connect(): void {}

  async disconnect(): Promise<void> {}

  send(_message: object): boolean {
    return true;
  }
}

/**
 * Backwards-compatible alias for legacy call sites
 */
export class VirtioBridge extends UnixSocketTransport {}

export class TcpForwardStream extends Duplex {
  private closedByRemote = false;
  private closeSent = false;
  readonly id: number;
  private readonly sendFrame: (message: object) => boolean;
  private readonly onDispose: () => void;

  constructor(
    id: number,
    sendFrame: (message: object) => boolean,
    onDispose: () => void,
  ) {
    super();
    this.id = id;
    this.sendFrame = sendFrame;
    this.onDispose = onDispose;
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

export function parseMac(value: string): Buffer | null {
  const parts = value.split(":");
  if (parts.length !== 6) return null;
  const bytes = parts.map((part) => Number.parseInt(part, 16));
  if (bytes.some((byte) => !Number.isFinite(byte) || byte < 0 || byte > 255))
    return null;
  return Buffer.from(bytes);
}

export function isValidRequestId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_REQUEST_ID
  );
}

export function estimateBase64Bytes(value: string) {
  const len = value.length;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

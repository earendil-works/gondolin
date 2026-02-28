import fs from "fs";
import net from "net";
import path from "path";
import { Duplex } from "stream";

import {
  FrameReader,
  type IncomingMessage,
  decodeMessage,
  encodeFrame,
} from "./virtio-protocol.ts";

export const MAX_REQUEST_ID = 0xffffffff;

export class VirtioBridge {
  private socket: net.Socket | null = null;
  private server: net.Server | null = null;
  private readonly reader = new FrameReader();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private waitingDrain = false;
  private allowReconnect = true;
  private closed = false;
  private readonly socketPath: string;
  private readonly maxPendingBytes: number;

  constructor(socketPath: string, maxPendingBytes: number = 8 * 1024 * 1024) {
    this.socketPath = socketPath;
    this.maxPendingBytes = maxPendingBytes;
  }

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

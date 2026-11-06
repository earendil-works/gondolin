/**
 * Controller side of gondolind's interim `relay` network mode (remote
 * sessions): QEMU's netdev stream arrives as `netdev_data` and is fed to the
 * node engine's `QemuNetworkBackend` through a duplex standing in for the
 * unix socket it normally accepts. Writes towards QEMU are limited by the
 * daemon's credit window (`netdev_window`).
 */

import { Duplex } from "node:stream";

import type { QemuNetworkBackend } from "../qemu/net.ts";
import type { NativeTransport } from "./transport.ts";

/** Controller→QEMU bytes in flight (`RELAY_WINDOW` in `net_relay.rs`) */
const RELAY_WINDOW = 1024 * 1024;

class NetdevRelayStream extends Duplex {
  private credit = RELAY_WINDOW;
  private waiting: {
    chunk: Buffer;
    callback: (err?: Error | null) => void;
  } | null = null;
  private readonly transport: NativeTransport;
  readonly conn: number;

  constructor(transport: NativeTransport, conn: number) {
    super();
    this.transport = transport;
    this.conn = conn;
  }

  _read(): void {
    // data is pushed as it arrives from the daemon
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (err?: Error | null) => void,
  ) {
    this.trySend(chunk, callback);
  }

  private trySend(chunk: Buffer, callback: (err?: Error | null) => void) {
    if (this.destroyed || this.transport.isClosed) {
      callback(new Error("netdev relay closed"));
      return;
    }
    if (chunk.length > this.credit && this.credit < RELAY_WINDOW) {
      // wait for the daemon to write what is in flight
      this.waiting = { chunk, callback };
      return;
    }
    this.credit -= chunk.length;
    if (this.transport.send("netdev_data", { conn: this.conn, data: chunk })) {
      callback();
    } else {
      this.transport.waitDrain().then(
        () => callback(),
        (err: Error) => callback(err),
      );
    }
  }

  window(bytes: number) {
    this.credit = Math.min(RELAY_WINDOW, this.credit + bytes);
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      this.trySend(waiting.chunk, waiting.callback);
    }
  }

  remoteData(data: Buffer) {
    this.push(data);
  }

  _destroy(err: Error | null, callback: (err?: Error | null) => void) {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.callback(err ?? new Error("netdev relay closed"));
    callback(err);
  }
}

/** Wires `netdev_*` messages to a network backend */
export function attachNetdevRelay(
  transport: NativeTransport,
  backend: QemuNetworkBackend,
) {
  let current: NetdevRelayStream | null = null;
  const attach = (
    backend as unknown as { attachSocket(socket: Duplex): void }
  ).attachSocket.bind(backend);
  transport.onMessage("netdev_open", (p) => {
    current?.destroy();
    current = new NetdevRelayStream(transport, p.conn);
    current.on("error", () => {});
    attach(current);
  });
  transport.onMessage("netdev_data", (p) => {
    if (current && current.conn === p.conn && Buffer.isBuffer(p.data)) {
      current.remoteData(p.data);
    }
  });
  transport.onMessage("netdev_window", (p) => {
    if (current && current.conn === p.conn)
      current.window(Number(p.bytes) || 0);
  });
  transport.onMessage("netdev_close", (p) => {
    if (current && current.conn === p.conn) {
      const closing = current;
      current = null;
      closing.push(null);
      closing.destroy();
    }
  });
  transport.on("closed", () => {
    current?.destroy();
    current = null;
  });
}

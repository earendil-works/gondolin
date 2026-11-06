/**
 * Guest TCP streams of the native engine (`vm.enableSsh()`, ingress): the
 * controller side of gondolind's `fwd_*` messages, which relay the guest's
 * `virtio-ssh` / `virtio-ingress` TCP forwarders.
 *
 * Output from the guest is credit based: consumed bytes are returned with
 * `fwd_window` once the readable side has room again, so a slow consumer
 * backs up into the guest instead of buffering in memory.
 */

import { Duplex } from "node:stream";

import type { NativeTransport } from "./transport.ts";

/** Forwarder channel */
export type NativeTcpChannel = "ssh" | "ingress";

type OpenWaiter = {
  resolve: () => void;
  reject: (err: Error) => void;
};

/** One guest TCP stream */
export class NativeTcpStream extends Duplex {
  readonly id: number;
  private readonly transport: NativeTransport;
  private readonly channel: NativeTcpChannel;
  private closedByRemote = false;
  private closeSent = false;
  /** received bytes not yet returned as credit */
  private unacked = 0;

  constructor(
    transport: NativeTransport,
    channel: NativeTcpChannel,
    id: number,
    onDispose: () => void,
  ) {
    super();
    this.transport = transport;
    this.channel = channel;
    this.id = id;
    this.on("close", onDispose);
  }

  private sendMessage(t: string, p: Record<string, unknown> = {}): boolean {
    return this.transport.send(t, {
      channel: this.channel,
      stream: this.id,
      ...p,
    });
  }

  private ack() {
    if (this.unacked <= 0 || this.closedByRemote) return;
    const bytes = this.unacked;
    this.unacked = 0;
    this.sendMessage("fwd_window", { bytes });
  }

  _read(_size: number): void {
    this.ack();
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
    if (this.transport.isClosed) {
      callback(new Error("gondolind connection closed"));
      return;
    }
    if (this.sendMessage("fwd_data", { data: chunk })) {
      callback();
      return;
    }
    this.transport.waitDrain().then(
      () => callback(),
      (err: Error) => callback(err),
    );
  }

  _final(callback: (error?: Error | null) => void): void {
    if (!this.closedByRemote) this.sendMessage("fwd_eof");
    callback();
  }

  _destroy(
    _error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.closedByRemote && !this.closeSent) {
      this.closeSent = true;
      this.sendMessage("fwd_close");
    }
    callback();
  }

  /** Data from the guest */
  pushRemote(data: Buffer): void {
    if (this.closedByRemote) return;
    this.unacked += data.length;
    if (this.push(data)) this.ack();
  }

  /** The guest (or the daemon) closed the stream */
  remoteClose(message?: string): void {
    if (this.closedByRemote) return;
    this.closedByRemote = true;
    if (message) {
      this.destroy(new Error(message));
      return;
    }
    this.push(null);
    this.destroy();
  }

  /** `fwd_opened` with `ok: false` */
  openFailed(message: string): void {
    this.closedByRemote = true;
    this.destroy(new Error(message));
  }
}

/** Streams of one forwarder channel (`tcpStreams`/`ingressTcpStreams`) */
export class NativeTcpChannelState {
  readonly channel: NativeTcpChannel;
  readonly streams = new Map<number, NativeTcpStream>();
  readonly openWaiters = new Map<number, OpenWaiter>();
  private nextId = 1;

  constructor(channel: NativeTcpChannel) {
    this.channel = channel;
  }

  allocateId(): number {
    let id = this.nextId;
    for (let i = 0; i < 0xffffffff; i++) {
      if (!this.streams.has(id) && !this.openWaiters.has(id)) break;
      id = (id + 1) >>> 0;
      if (id === 0) id = 1;
    }
    this.nextId = (id + 1) >>> 0;
    if (this.nextId === 0) this.nextId = 1;
    return id;
  }

  handleOpened(p: any) {
    const waiter = this.openWaiters.get(p.stream);
    if (!waiter) return;
    this.openWaiters.delete(p.stream);
    if (p.ok) {
      waiter.resolve();
      return;
    }
    const message =
      typeof p.message === "string" ? p.message : "tcp_open failed";
    const stream = this.streams.get(p.stream);
    this.streams.delete(p.stream);
    stream?.openFailed(message);
    waiter.reject(new Error(message));
  }

  handleData(p: any) {
    const stream = this.streams.get(p.stream);
    if (!stream || !Buffer.isBuffer(p.data)) return;
    stream.pushRemote(p.data);
  }

  handleClose(p: any) {
    const stream = this.streams.get(p.stream);
    if (!stream) return;
    this.streams.delete(p.stream);
    const waiter = this.openWaiters.get(p.stream);
    if (waiter) {
      this.openWaiters.delete(p.stream);
      waiter.reject(
        new Error(
          typeof p.message === "string" ? p.message : "tcp stream closed",
        ),
      );
    }
    stream.remoteClose(typeof p.message === "string" ? p.message : undefined);
  }

  /** Fail everything (daemon gone or server closing) */
  destroyAll(err?: Error) {
    for (const [id, waiter] of this.openWaiters) {
      waiter.reject(err ?? new Error("tcp stream closed"));
      this.openWaiters.delete(id);
    }
    for (const stream of this.streams.values()) {
      stream.destroy(err);
    }
    this.streams.clear();
  }

  /** `openTcpStream` / `openIngressStream` */
  async open(
    transport: NativeTransport,
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<Duplex> {
    const id = this.allocateId();
    const stream = new NativeTcpStream(transport, this.channel, id, () => {
      this.streams.delete(id);
      const waiter = this.openWaiters.get(id);
      if (waiter) {
        this.openWaiters.delete(id);
        waiter.reject(new Error("tcp stream closed"));
      }
    });
    this.streams.set(id, stream);
    const opened = new Promise<void>((resolve, reject) => {
      this.openWaiters.set(id, { resolve, reject });
    });
    if (
      !transport.send("fwd_open", {
        channel: this.channel,
        stream: id,
        host,
        port,
      })
    ) {
      // the frame is queued; only a closed transport is fatal
      if (transport.isClosed) {
        this.streams.delete(id);
        this.openWaiters.delete(id);
        stream.destroy();
        throw new Error("virtio tcp queue exceeded");
      }
    }
    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        opened,
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
}

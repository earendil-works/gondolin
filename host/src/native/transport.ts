/**
 * Native engine transport: spawns `gondolind` and speaks the controller
 * protocol over its stdio (see `native/DESIGN.md`).
 *
 * Frames are a `u32` big-endian length followed by one CBOR map
 * `{ v, t, id, p }`. Requests carry a non-zero `id` and are answered with
 * `<t>_result` (`{ ok: true, ... }` or `{ ok: false, code, message }`).
 *
 * The transport offers:
 * - `request()` for controller→daemon requests, with an optional callback for
 *   events the daemon sends with the same id before the result (streams)
 * - `onMessage()` for unsolicited daemon messages, keyed by type
 * - `handleRequest()` for daemon→controller requests, keyed by type (used by
 *   the VFS and network integration)
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { TypeEncoderMap, decode, encode } from "cbor2";

import { nativeDaemonCommand } from "./binary.ts";
import { fastDecode, fastEncode, normalize } from "./cbor.ts";

/** Maximum frame payload in `bytes` (same as the guest protocols) */
export const NATIVE_MAX_FRAME = 4 * 1024 * 1024;

/** Controller protocol version */
export const NATIVE_PROTOCOL_VERSION = 1;

const RESULT_SUFFIX = "_result";

const cborEncoderTypes = new TypeEncoderMap();
cborEncoderTypes.registerEncoder(Buffer, (value) => [
  NaN,
  new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
]);

/** One decoded controller protocol message */
export type NativeEnvelope = {
  /** protocol version */
  v: number;
  /** message type */
  t: string;
  /** correlation id (`0` for unsolicited messages) */
  id: number;
  /** payload */
  p: any;
};

/** Daemon `hello` payload */
export type NativeHello = {
  /** controller protocol version */
  protocol: number;
  /** daemon version */
  version: string;
  /** optional features */
  features: string[];
  /** daemon pid */
  pid: number;
};

/** A failed request (`ok: false`) */
export class NativeRequestError extends Error {
  /** stable error code */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeRequestError";
    this.code = code;
  }
}

/** Handler for unsolicited daemon messages */
export type NativeMessageHandler = (
  payload: any,
  message: NativeEnvelope,
) => void;

/** Handler for daemon→controller requests; resolves to the result fields */
export type NativeRequestHandler = (
  payload: any,
  message: NativeEnvelope,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

type PendingRequest = {
  /** request type */
  t: string;
  resolve: (payload: any) => void;
  reject: (err: Error) => void;
  /** events with the same id before the result */
  onEvent?: (t: string, payload: any) => void;
};

/** Removes `undefined` values (CBOR has no `undefined` in our subset) */
export function stripUndefined(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry === undefined ? null : stripUndefined(entry),
    );
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array) &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = stripUndefined(entry);
    }
    return out;
  }
  return value;
}

/** Encodes one framed message */
export function encodeNativeFrame(message: NativeEnvelope): Buffer {
  let frame = fastEncode(message, 4);
  if (!frame) {
    const payload = encode(stripUndefined(message), {
      types: cborEncoderTypes,
    });
    frame = Buffer.allocUnsafe(4 + payload.length);
    frame.set(payload, 4);
  }
  const length = frame.length - 4;
  if (length > NATIVE_MAX_FRAME) {
    throw new Error(`native frame too large: ${length} bytes`);
  }
  frame.writeUInt32BE(length, 0);
  return frame;
}

/** Decodes one frame payload */
export function decodeNativeFrame(frame: Buffer): unknown {
  return fastDecode(frame) ?? normalize(decode(frame));
}

/** Incremental frame decoder without quadratic buffer copies */
export class NativeFrameReader {
  private chunks: Buffer[] = [];
  private buffered = 0;

  push(chunk: Buffer, onFrame: (frame: Buffer) => void) {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    for (;;) {
      if (this.buffered < 4) return;
      const header = this.peek(4);
      const length = header.readUInt32BE(0);
      if (length > NATIVE_MAX_FRAME) {
        throw new Error(`native frame too large: ${length} bytes`);
      }
      if (this.buffered < 4 + length) return;
      this.take(4);
      onFrame(this.take(length));
    }
  }

  private peek(n: number): Buffer {
    if (this.chunks[0]!.length >= n) return this.chunks[0]!.subarray(0, n);
    return Buffer.concat(this.chunks).subarray(0, n);
  }

  private take(n: number): Buffer {
    const first = this.chunks[0];
    if (first && first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return out;
    }
    const all = Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.buffered -= n;
    return out;
  }
}

export { resolveNativeBinary } from "./binary.ts";

/**
 * A byte channel to a `gondolind` process: a local child, `ssh host
 * gondolind`, or pi-env's `openProcess` (which provides exactly this shape).
 */
export type NativeConnection = {
  /** write bytes to the daemon's stdin; `false` or a pending promise means "buffer full" */
  write(data: Buffer): boolean | void | Promise<unknown>;
  /** daemon stdout */
  onStdout(listener: (data: Buffer) => void): void;
  /** daemon stderr (diagnostics) */
  onStderr?(listener: (data: Buffer | string) => void): void;
  /** close the daemon's stdin (it stops the VM and exits) */
  close(): void | Promise<unknown>;
  /** forcefully terminate the daemon */
  kill?(): void;
  /** resolves once the daemon process exited */
  exited: Promise<{ code: number | null; signal?: string | null }>;
  /** resolves once the write side accepts more data (for `write()` returning `false`) */
  waitDrain?(): Promise<void>;
  /** local process id (local children only) */
  pid?: number | null;
};

/** Spawn `command[0] command[1..]` as the daemon (local binary or e.g. `ssh host gondolind`) */
export function spawnNativeConnection(
  command: string[],
  options: {
    /** environment of the spawned process */
    env?: NodeJS.ProcessEnv;
    /** working directory of the spawned process */
    cwd?: string;
  } = {},
): NativeConnection {
  if (command.length === 0) throw new Error("empty gondolind command");
  const child = spawn(command[0]!, command.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env,
    cwd: options.cwd,
  });
  const exited = new Promise<{ code: number | null; signal?: string | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", (err) => {
        spawnError = err;
        resolve({ code: null, signal: null });
      });
    },
  );
  let spawnError: Error | null = null;
  child.stdin!.on("error", () => {
    // reported through `exited`
  });
  return {
    write: (data) => child.stdin!.write(data),
    onStdout: (listener) => child.stdout!.on("data", listener),
    onStderr: (listener) => child.stderr!.on("data", listener),
    close: () => {
      child.stdin!.end();
    },
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    },
    exited: exited.then((r) => {
      if (spawnError)
        throw new Error(`gondolind failed to start: ${spawnError.message}`);
      return r;
    }),
    waitDrain: () =>
      child.stdin!.writableNeedDrain
        ? new Promise<void>((resolve) => {
            const done = () => {
              child.stdin!.off("drain", done);
              child.stdin!.off("close", done);
              resolve();
            };
            child.stdin!.on("drain", done);
            child.stdin!.on("close", done);
          })
        : Promise.resolve(),
    get pid() {
      return child.pid ?? null;
    },
  };
}

/** Bytes of pending asynchronous writes before `send()` reports a full buffer */
const ASYNC_WRITE_HIGH_WATER = 1024 * 1024;

/** Connection to one `gondolind` process */
export class NativeTransport extends EventEmitter {
  readonly connection: NativeConnection;
  /** resolves with the daemon's `hello` */
  readonly hello: Promise<NativeHello>;
  /** resolves once the daemon process exited */
  readonly exited: Promise<{ code: number | null; signal?: string | null }>;

  private readonly reader = new NativeFrameReader();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly messageHandlers = new Map<string, NativeMessageHandler>();
  private readonly requestHandlers = new Map<string, NativeRequestHandler>();
  private nextId = 1;
  private closed = false;
  private processExited = false;
  private stderrTail: string[] = [];
  private helloResolve!: (hello: NativeHello) => void;
  private helloReject!: (err: Error) => void;
  /** bytes of asynchronous writes not yet completed */
  private asyncPending = 0;
  private asyncDrainWaiters: Array<() => void> = [];

  /**
   * @param target a local binary path (`gondolin` is started as `gondolin
   *   daemon`, a `gondolind` as is; then `args` follow) or a connection
   */
  constructor(target: string | NativeConnection, args: string[] = []) {
    super();
    this.hello = new Promise((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
    });
    void this.hello.catch(() => {});

    this.connection =
      typeof target === "string"
        ? spawnNativeConnection([...nativeDaemonCommand(target), ...args])
        : target;
    const exited = this.connection.exited.then(
      (r) => r,
      (err: Error) => {
        this.fail(err);
        return { code: null, signal: null };
      },
    );
    this.exited = exited;
    void exited.then(({ code, signal }) => {
      this.processExited = true;
      const detail = code !== null ? `code=${code}` : `signal=${signal ?? "?"}`;
      const tail = this.stderrTail.at(-1);
      this.fail(
        new Error(`gondolind exited (${detail})${tail ? ` (${tail})` : ""}`),
      );
    });
    this.connection.onStdout((chunk: Buffer) => {
      try {
        this.reader.push(Buffer.from(chunk), (frame) =>
          this.handleFrame(frame),
        );
      } catch (err) {
        this.emit("protocol-error", err);
        this.kill();
      }
    });
    let partial = "";
    this.connection.onStderr?.((chunk: Buffer | string) => {
      partial += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newline = partial.indexOf("\n");
      while (newline !== -1) {
        const line = partial.slice(0, newline).trimEnd();
        partial = partial.slice(newline + 1);
        if (line) {
          this.stderrTail.push(line);
          if (this.stderrTail.length > 20) this.stderrTail.shift();
          this.emit("stderr", line);
        }
        newline = partial.indexOf("\n");
      }
      if (partial.length > 64 * 1024) partial = "";
    });
  }

  /** local process id of the daemon (`null` for remote connections) */
  get pid(): number | null {
    return this.connection.pid ?? null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Register a handler for unsolicited messages of type `t` */
  onMessage(t: string, handler: NativeMessageHandler) {
    this.messageHandlers.set(t, handler);
  }

  /** Register a handler for daemon→controller requests of type `t` */
  handleRequest(t: string, handler: NativeRequestHandler) {
    this.requestHandlers.set(t, handler);
  }

  /**
   * Send a message. Returns `false` when the pipe's buffer is full (see
   * {@link waitDrain}) or the transport is closed.
   */
  send(t: string, p: unknown = {}, id = 0): boolean {
    if (this.closed) return false;
    const frame = encodeNativeFrame({
      v: NATIVE_PROTOCOL_VERSION,
      t,
      id,
      p: p ?? {},
    });
    return this.write(frame);
  }

  private write(frame: Buffer): boolean {
    let result: boolean | void | Promise<unknown>;
    try {
      result = this.connection.write(frame);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
    if (result instanceof Promise) {
      this.asyncPending += frame.length;
      const done = () => {
        this.asyncPending -= frame.length;
        if (this.asyncPending < ASYNC_WRITE_HIGH_WATER) {
          const waiters = this.asyncDrainWaiters;
          this.asyncDrainWaiters = [];
          for (const w of waiters) w();
        }
      };
      result.then(done, (err: unknown) => {
        done();
        this.fail(err instanceof Error ? err : new Error(String(err)));
      });
      return this.asyncPending < ASYNC_WRITE_HIGH_WATER;
    }
    return result !== false;
  }

  /** Wait until the pipe accepts more data */
  async waitDrain(): Promise<void> {
    if (this.closed) throw new Error("gondolind connection closed");
    const waits: Promise<void>[] = [];
    if (this.asyncPending >= ASYNC_WRITE_HIGH_WATER) {
      waits.push(
        new Promise<void>((resolve) => this.asyncDrainWaiters.push(resolve)),
      );
    }
    if (this.connection.waitDrain) waits.push(this.connection.waitDrain());
    if (waits.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const onClose = () => reject(new Error("gondolind connection closed"));
      this.once("closed", onClose);
      Promise.all(waits).then(
        () => {
          this.off("closed", onClose);
          resolve();
        },
        (err) => {
          this.off("closed", onClose);
          reject(err);
        },
      );
    });
  }

  /** Allocate a request id (for {@link sendRequest}) */
  allocateId(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1;
    return id;
  }

  /**
   * Send a request and wait for its result. `onEvent` receives other messages
   * the daemon sends with the same id before the result.
   */
  request<T = any>(
    t: string,
    p: unknown = {},
    options: {
      /** stream events correlated with the request */
      onEvent?: (t: string, payload: any) => void;
      /** request id (from {@link allocateId}) */
      id?: number;
    } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("gondolind connection closed"));
    }
    const id = options.id ?? this.allocateId();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { t, resolve, reject, onEvent: options.onEvent });
      this.send(t, p, id);
    });
  }

  /** Forcefully terminate the daemon (local children; remote: close the connection) */
  kill() {
    try {
      if (this.connection.kill) this.connection.kill();
      else void this.connection.close();
    } catch {
      // ignore
    }
  }

  /** Close stdin (the daemon stops the VM and exits) and wait for the exit */
  async close(timeoutMs = 5000): Promise<void> {
    if (!this.processExited) {
      try {
        await Promise.resolve(this.connection.close()).catch(() => {});
      } catch {
        // ignore
      }
      let timer: NodeJS.Timeout | null = null;
      await Promise.race([
        this.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.kill();
            resolve();
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    this.fail(new Error("gondolind connection closed"));
  }

  private fail(err: Error) {
    if (this.closed) return;
    this.closed = true;
    this.helloReject(err);
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
    this.emit("closed", err);
  }

  private handleFrame(frame: Buffer) {
    let message: NativeEnvelope;
    try {
      message = decodeNativeFrame(frame) as NativeEnvelope;
    } catch (err) {
      this.emit("protocol-error", err);
      return;
    }
    if (!message || typeof message.t !== "string") return;
    const id =
      typeof message.id === "number" ? message.id : Number(message.id ?? 0);
    const payload = message.p ?? {};

    if (message.t === "hello") {
      this.helloResolve(payload as NativeHello);
      return;
    }

    const requestHandler = this.requestHandlers.get(message.t);
    if (requestHandler && id !== 0) {
      void this.runRequestHandler(requestHandler, message, id);
      return;
    }

    if (id !== 0) {
      const pending = this.pending.get(id);
      if (pending) {
        if (message.t === `${pending.t}${RESULT_SUFFIX}`) {
          this.pending.delete(id);
          if (payload.ok === true) {
            pending.resolve(payload);
          } else {
            pending.reject(
              new NativeRequestError(
                String(payload.code ?? "error"),
                String(payload.message ?? "request failed"),
              ),
            );
          }
        } else {
          pending.onEvent?.(message.t, payload);
        }
        return;
      }
    }

    const handler = this.messageHandlers.get(message.t);
    if (handler) {
      handler(payload, message);
    } else {
      this.emit("unhandled", message);
    }
  }

  private async runRequestHandler(
    handler: NativeRequestHandler,
    message: NativeEnvelope,
    id: number,
  ) {
    let result: Record<string, unknown>;
    try {
      result = { ...(await handler(message.p ?? {}, message)), ok: true };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      result = {
        ok: false,
        code: (error as { code?: unknown }).code ?? "error",
        message: error.message,
      };
      if (typeof result.code !== "string") result.code = "error";
    }
    this.send(`${message.t}${RESULT_SUFFIX}`, result, id);
  }
}

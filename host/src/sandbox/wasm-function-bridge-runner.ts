import { EventEmitter } from "events";
import child_process from "child_process";
import type { ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

import { FunctionBridgeTransport } from "./server-transport.ts";
import { getProcessProfiler } from "../utils/profile.ts";

const profile = getProcessProfiler("wasm-host");

export type WasmFunctionBridgeRunnerMode = "harness" | "wasi-stdio";

export type WasmFunctionBridgePreopen = {
  /** host directory path */
  hostPath: string;
  /** guest-visible mount path */
  guestPath: string;
  /** whether writes must be denied */
  readOnly?: boolean;
};

export type WasmFunctionBridgeChannel =
  | "control"
  | "fs"
  | "ssh"
  | "ingress";

const DEFAULT_CHANNEL: WasmFunctionBridgeChannel = "control";
const ALL_CHANNELS: readonly WasmFunctionBridgeChannel[] = [
  "control",
  "fs",
  "ssh",
  "ingress",
];

type RunnerInboundMessage =
  | {
      /** child runner readiness signal */
      t: "ready";
    }
  | {
      /** framed guest payload encoded as base64 */
      t: "frame";
      /** frame bytes encoded as base64 */
      frame: string;
      /** logical bridge channel */
      channel?: WasmFunctionBridgeChannel;
    }
  | {
      /** optional structured runner log */
      t: "log";
      /** log stream name */
      stream: "stdout" | "stderr";
      /** log chunk */
      chunk: string;
    }
  | {
      /** writable notification for outbound flow-control */
      t: "writable";
    }
  | {
      /** structured runner-side error */
      t: "error";
      /** human-readable error message */
      message: string;
    };

type RunnerOutboundMessage =
  | {
      /** outbound framed payload encoded as base64 */
      t: "frame";
      /** frame bytes encoded as base64 */
      frame: string;
      /** logical bridge channel */
      channel?: WasmFunctionBridgeChannel;
    }
  | {
      /** graceful runner shutdown */
      t: "close";
    };

export type WasmFunctionBridgeRunnerConfig = {
  /** node executable used to start the runner child */
  nodePath?: string;
  /** runner entrypoint path */
  entryPath?: string;
  /** runner behavior mode */
  mode?: WasmFunctionBridgeRunnerMode;
  /** guest wasm module path (required for `mode=wasi-stdio`) */
  wasmPath?: string;
  /** qemu-network backend unix socket path for wasm guest networking */
  netSocketPath?: string;
  /** wasi preopened host directories */
  preopens?: WasmFunctionBridgePreopen[];
  /** extra argv entries forwarded to the wasm module */
  wasmArgs?: string[];
  /** startup timeout in `ms` */
  startupTimeoutMs?: number;
};

export class WasmFunctionBridgeRunner extends EventEmitter {
  private readonly config: Required<WasmFunctionBridgeRunnerConfig>;
  private child: ChildProcess | null = null;
  private readonly frameListeners = new Map<
    WasmFunctionBridgeChannel,
    Set<(frame: Buffer) => void>
  >();
  private readonly writableListeners = new Set<() => void>();
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private startupSpanEnd: (() => void) | null = null;

  constructor(config: WasmFunctionBridgeRunnerConfig = {}) {
    super();

    for (const channel of ALL_CHANNELS) {
      this.frameListeners.set(channel, new Set());
    }

    this.config = {
      nodePath: config.nodePath ?? process.execPath,
      entryPath:
        config.entryPath ?? resolveDefaultWasmFunctionBridgeRunnerEntryPath(),
      mode: config.mode ?? "harness",
      wasmPath: config.wasmPath ?? "",
      netSocketPath: config.netSocketPath ?? "",
      preopens: config.preopens ?? [],
      wasmArgs: config.wasmArgs ?? [],
      startupTimeoutMs: config.startupTimeoutMs ?? 5_000,
    };
  }

  async start(): Promise<void> {
    if (this.child) {
      return this.readyPromise ?? Promise.resolve();
    }

    if (!fs.existsSync(this.config.entryPath)) {
      throw new Error(
        `wasm bridge runner entrypoint not found: ${this.config.entryPath}`,
      );
    }

    const childArgs = [this.config.entryPath, "--mode", this.config.mode];
    if (this.config.wasmPath.length > 0) {
      childArgs.push("--wasm", this.config.wasmPath);
    }
    if (this.config.netSocketPath.length > 0) {
      childArgs.push("--net-socket", this.config.netSocketPath);
    }
    for (const preopen of this.config.preopens) {
      const flag = preopen.readOnly ? "--preopen-ro" : "--preopen";
      childArgs.push(
        flag,
        `${preopen.hostPath}::${preopen.guestPath}`,
      );
    }
    for (const wasmArg of this.config.wasmArgs) {
      childArgs.push("--wasm-arg", wasmArg);
    }

    const child = child_process.spawn(
      this.config.nodePath,
      childArgs,
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    this.child = child;
    this.startupSpanEnd = profile.startSpan("bridge.runner.start");

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      const error = new Error(
        `timed out waiting for wasm bridge runner readiness after ${this.config.startupTimeoutMs}ms`,
      );
      this.rejectReady?.(error);
      this.rejectReady = null;
      this.resolveReady = null;
      this.emit("error", error);
      try {
        this.child?.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, this.config.startupTimeoutMs);
    this.startupTimer.unref?.();

    child.on("message", (raw) => {
      this.handleRunnerMessage(raw);
    });

    child.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectReady?.(error);
      this.rejectReady = null;
      this.resolveReady = null;
      this.emit("error", error);
    });

    child.on("exit", (code, signal) => {
      if (this.startupTimer) {
        clearTimeout(this.startupTimer);
        this.startupTimer = null;
      }
      this.child = null;

      if (this.rejectReady) {
        this.rejectReady(
          new Error(
            `wasm bridge runner exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          ),
        );
        this.rejectReady = null;
        this.resolveReady = null;
      }

      this.readyPromise = null;
      this.startupSpanEnd?.();
      this.startupSpanEnd = null;
      this.emit("exit", { code, signal });
    });

    return this.readyPromise;
  }

  setWasmArgs(args: string[]): void {
    this.config.wasmArgs = [...args];
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;

    this.child = null;

    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    const done = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });

    try {
      const delivered = child.send({ t: "close" } satisfies RunnerOutboundMessage);
      if (delivered === false) {
        child.kill("SIGTERM");
      }
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }

    const forceKillTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 2_000);
    forceKillTimer.unref?.();

    await done;

    clearTimeout(forceKillTimer);

    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
  }

  sendFrame(
    frame: Buffer,
    channel: WasmFunctionBridgeChannel = DEFAULT_CHANNEL,
  ): boolean {
    const child = this.child;
    if (!child || !child.connected) {
      return false;
    }

    try {
      profile.observe("bridge.host.send_frame_bytes", frame.length);

      const endEncode = profile.startSpan("bridge.host.send_frame.base64_encode", {
        channel,
      });
      const encoded = frame.toString("base64");
      endEncode();

      const endSend = profile.startSpan("bridge.host.send_frame.ipc_send", {
        channel,
      });
      const sent = child.send({
        t: "frame",
        frame: encoded,
        channel,
      } satisfies RunnerOutboundMessage);
      endSend();
      return sent;
    } catch {
      return false;
    }
  }

  subscribeFrame(
    channel: WasmFunctionBridgeChannel,
    listener: (frame: Buffer) => void,
  ): () => void {
    const listeners = this.frameListeners.get(channel);
    if (!listeners) {
      throw new Error(`unsupported wasm bridge channel: ${channel}`);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  subscribeWritable(listener: () => void): () => void {
    this.writableListeners.add(listener);
    return () => {
      this.writableListeners.delete(listener);
    };
  }

  createChannelTransport(
    channel: WasmFunctionBridgeChannel,
    maxPendingBytes?: number,
  ): FunctionBridgeTransport {
    return new FunctionBridgeTransport(
      {
        sendFrame: (frame) => this.sendFrame(frame, channel),
        subscribeFrame: (listener) => this.subscribeFrame(channel, listener),
        subscribeWritable: (listener) => this.subscribeWritable(listener),
      },
      maxPendingBytes,
    );
  }

  createControlTransport(maxPendingBytes?: number): FunctionBridgeTransport {
    return this.createChannelTransport("control", maxPendingBytes);
  }

  private handleRunnerMessage(raw: unknown): void {
    const message = this.normalizeRunnerMessage(raw);
    if (!message) {
      this.emit("error", new Error("received invalid wasm bridge runner message"));
      return;
    }

    if (message.t === "ready") {
      if (this.startupTimer) {
        clearTimeout(this.startupTimer);
        this.startupTimer = null;
      }
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      this.startupSpanEnd?.();
      this.startupSpanEnd = null;
      return;
    }

    if (message.t === "frame") {
      let frame: Buffer;
      try {
        const endDecode = profile.startSpan("bridge.host.recv_frame.base64_decode", {
          channel: message.channel ?? DEFAULT_CHANNEL,
        });
        frame = Buffer.from(message.frame, "base64");
        endDecode();
        profile.observe("bridge.host.recv_frame_bytes", frame.length);
      } catch {
        this.emit("error", new Error("runner frame payload is not valid base64"));
        return;
      }
      const channel = message.channel ?? DEFAULT_CHANNEL;
      const listeners = this.frameListeners.get(channel);
      if (!listeners) {
        this.emit(
          "error",
          new Error(`runner frame payload used unknown channel: ${channel}`),
        );
        return;
      }
      for (const listener of listeners) {
        listener(frame);
      }
      return;
    }

    if (message.t === "writable") {
      for (const listener of this.writableListeners) {
        listener();
      }
      return;
    }

    if (message.t === "log") {
      this.emit("log", message.chunk, message.stream);
      return;
    }

    const error = new Error(message.message);
    if (this.rejectReady) {
      this.rejectReady(error);
      this.rejectReady = null;
      this.resolveReady = null;
    }
    this.emit("error", error);
  }

  private normalizeRunnerMessage(raw: unknown): RunnerInboundMessage | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const t = value.t;
    if (typeof t !== "string") return null;

    if (t === "ready") {
      return { t: "ready" };
    }

    if (t === "frame" && typeof value.frame === "string") {
      const channelRaw = value.channel;
      const channel =
        channelRaw === undefined
          ? DEFAULT_CHANNEL
          : this.normalizeChannel(channelRaw);
      if (!channel) return null;
      return {
        t: "frame",
        frame: value.frame,
        channel,
      };
    }

    if (
      t === "log" &&
      (value.stream === "stdout" || value.stream === "stderr") &&
      typeof value.chunk === "string"
    ) {
      return {
        t: "log",
        stream: value.stream,
        chunk: value.chunk,
      };
    }

    if (t === "writable") {
      return { t: "writable" };
    }

    if (t === "error" && typeof value.message === "string") {
      return {
        t: "error",
        message: value.message,
      };
    }

    return null;
  }

  private normalizeChannel(value: unknown): WasmFunctionBridgeChannel | null {
    if (typeof value !== "string") return null;
    if ((ALL_CHANNELS as readonly string[]).includes(value)) {
      return value as WasmFunctionBridgeChannel;
    }
    return null;
  }
}

export function resolveDefaultWasmFunctionBridgeRunnerEntryPath(): string {
  const localJs = path.resolve(
    import.meta.dirname,
    "wasm-function-bridge-runner-entry.js",
  );
  if (fs.existsSync(localJs)) {
    return localJs;
  }
  return path.resolve(import.meta.dirname, "wasm-function-bridge-runner-entry.ts");
}

export const __test = {
  resolveDefaultWasmFunctionBridgeRunnerEntryPath,
};

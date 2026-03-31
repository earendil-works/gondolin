import { EventEmitter } from "events";

import type { SandboxLogStream, SandboxState } from "./controller.ts";
import {
  type WasmFunctionBridgeRunner,
  type WasmFunctionBridgeRunnerConfig,
} from "./wasm-function-bridge-runner.ts";

export type WasmFunctionBridgeControllerConfig = WasmFunctionBridgeRunnerConfig & {
  /** runner instance used for transport + lifecycle */
  runner: WasmFunctionBridgeRunner;
  /** whether to restart automatically on unexpected runner exit */
  autoRestart: boolean;
  /** kernel append string (kept for config parity) */
  append: string;
};

export class WasmFunctionBridgeController extends EventEmitter {
  private state: SandboxState = "stopped";
  private readonly config: WasmFunctionBridgeControllerConfig;
  private restartTimer: NodeJS.Timeout | null = null;
  private manualStop = false;

  constructor(config: WasmFunctionBridgeControllerConfig) {
    super();
    this.config = config;

    this.config.runner.on("log", (chunk: string, stream: SandboxLogStream) => {
      this.emit("log", chunk, stream);
    });

    this.config.runner.on("error", (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.state !== "stopped") {
        this.setState("stopped");
      }
      this.emit("exit", {
        code: null,
        signal: null,
        error,
      });
    });

    this.config.runner.on(
      "exit",
      (info: { code: number | null; signal: NodeJS.Signals | null }) => {
        if (this.state !== "stopped") {
          this.setState("stopped");
        }

        this.emit("exit", {
          code: info.code,
          signal: info.signal,
        });

        if (this.manualStop) {
          this.manualStop = false;
          return;
        }

        if (this.config.autoRestart) {
          this.scheduleRestart();
        }
      },
    );
  }

  setAppend(append: string): void {
    this.config.append = append;
  }

  getState(): SandboxState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      return;
    }

    this.manualStop = false;
    this.setState("starting");

    try {
      await this.config.runner.start();
      this.setState("running");
    } catch (err) {
      this.setState("stopped");
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.state === "stopped") {
      return;
    }

    this.manualStop = true;

    try {
      await this.config.runner.stop();
    } finally {
      this.setState("stopped");
    }
  }

  async restart(): Promise<void> {
    await this.close();
    await this.start();
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, 1_000);
    this.restartTimer.unref?.();
  }

  private setState(state: SandboxState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }
}

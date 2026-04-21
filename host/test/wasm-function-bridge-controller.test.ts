import assert from "node:assert/strict";
import EventEmitter from "node:events";
import test from "node:test";

import { WasmFunctionBridgeController } from "../src/sandbox/wasm-function-bridge-controller.ts";

class FakeRunner extends EventEmitter {
  wasmArgs: string[] = [];

  setWasmArgs(args: string[]): void {
    this.wasmArgs = [...args];
  }

  async start(): Promise<void> {
    // no-op
  }

  async stop(): Promise<void> {
    // no-op
  }
}

test("WasmFunctionBridgeController derives sandboxfs env args from append", () => {
  const runner = new FakeRunner();

  const controller = new WasmFunctionBridgeController({
    runner: runner as any,
    mode: "wasi-stdio",
    autoRestart: false,
    append: "sandboxfs.mount=/data sandboxfs.bind=/workspace,/tmp",
  });

  assert.deepEqual(runner.wasmArgs, [
    "gondolin-sandboxfs-config",
    "/data",
    "/workspace,/tmp",
  ]);

  controller.setAppend("sandboxfs.mount=/mnt/custom sandboxfs.bind=/workdir");
  assert.deepEqual(runner.wasmArgs, [
    "gondolin-sandboxfs-config",
    "/mnt/custom",
    "/workdir",
  ]);
});

test("WasmFunctionBridgeController clears wasm args outside wasi-stdio mode", () => {
  const runner = new FakeRunner();

  const controller = new WasmFunctionBridgeController({
    runner: runner as any,
    mode: "harness",
    autoRestart: false,
    append: "sandboxfs.mount=/data sandboxfs.bind=/workspace",
  });

  assert.deepEqual(runner.wasmArgs, []);

  controller.setAppend("sandboxfs.mount=/other sandboxfs.bind=/x");
  assert.deepEqual(runner.wasmArgs, []);
});

import assert from "node:assert/strict";
import test from "node:test";

import { WasmFunctionBridgeRunner } from "../src/sandbox/wasm-function-bridge-runner.ts";

type Incoming = {
  t: string;
  id?: number;
  p?: Record<string, unknown>;
};

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5);
      t.unref?.();
    });
  }
  throw new Error(`timeout waiting for ${label}`);
}

test("WasmFunctionBridgeRunner harness round-trips PTY exec control frames", async () => {
  const runner = new WasmFunctionBridgeRunner({
    mode: "harness",
    startupTimeoutMs: 1_000,
  });

  const transport = runner.createControlTransport();
  const messages: Incoming[] = [];

  transport.onMessage = (message) => {
    messages.push(message as Incoming);
  };

  await runner.start();
  transport.connect();

  await waitFor(
    () => messages.some((message) => message.t === "vfs_ready"),
    1_000,
    "vfs_ready",
  );

  assert.equal(
    transport.send({
      v: 1,
      t: "exec_request",
      id: 77,
      p: {
        cmd: "/bin/bash",
        argv: ["-i"],
        stdin: true,
        pty: true,
      },
    }),
    true,
  );

  assert.equal(
    transport.send({
      v: 1,
      t: "pty_resize",
      id: 77,
      p: {
        rows: 40,
        cols: 120,
      },
    }),
    true,
  );

  assert.equal(
    transport.send({
      v: 1,
      t: "stdin_data",
      id: 77,
      p: {
        data: Buffer.from("echo gondolin\n", "utf8"),
      },
    }),
    true,
  );
  assert.equal(
    transport.send({
      v: 1,
      t: "stdin_data",
      id: 77,
      p: {
        data: Buffer.alloc(0),
        eof: true,
      },
    }),
    true,
  );

  await waitFor(
    () =>
      messages.some(
        (message) =>
          message.t === "exec_response" &&
          message.id === 77 &&
          message.p?.exit_code === 0,
      ),
    1_000,
    "exec_response",
  );

  const outputs = messages.filter(
    (message) => message.t === "exec_output" && message.id === 77,
  );
  assert.ok(outputs.length >= 3);

  const outputText = outputs
    .map((message) => message.p?.data)
    .filter((value): value is Buffer => Buffer.isBuffer(value))
    .map((value) => value.toString("utf8"))
    .join("");

  assert.match(outputText, /pty=1/);
  assert.match(outputText, /resize=40x120/);
  assert.match(outputText, /echo gondolin/);

  const stdinWindow = messages.find(
    (message) => message.t === "stdin_window" && message.id === 77,
  );
  assert.ok(stdinWindow);

  await transport.disconnect();
  await runner.stop();
});

test("WasmFunctionBridgeRunner rejects wasi-stdio mode without wasmPath", async () => {
  const runner = new WasmFunctionBridgeRunner({
    mode: "wasi-stdio",
    startupTimeoutMs: 500,
  });
  runner.on("error", () => {
    // swallow expected startup error for this test
  });

  await assert.rejects(
    () => runner.start(),
    /--wasm is required when --mode wasi-stdio/,
  );
});

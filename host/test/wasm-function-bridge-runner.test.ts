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

test("WasmFunctionBridgeRunner routes control and ssh channels independently", async () => {
  const runner = new WasmFunctionBridgeRunner({
    mode: "harness",
    startupTimeoutMs: 1_000,
  });

  const control = runner.createControlTransport();
  const ssh = runner.createChannelTransport("ssh");

  const controlMessages: Incoming[] = [];
  const sshMessages: Incoming[] = [];

  control.onMessage = (message) => {
    controlMessages.push(message as Incoming);
  };
  ssh.onMessage = (message) => {
    sshMessages.push(message as Incoming);
  };

  await runner.start();
  control.connect();
  ssh.connect();

  await waitFor(
    () => controlMessages.some((message) => message.t === "vfs_ready"),
    1_000,
    "control vfs_ready",
  );

  assert.equal(
    control.send({
      v: 1,
      t: "exec_request",
      id: 5,
      p: {
        cmd: "/bin/sh",
        argv: ["-lc", "echo hello"],
      },
    }),
    true,
  );

  assert.equal(
    ssh.send({
      v: 1,
      t: "tcp_open",
      id: 19,
      p: {
        host: "127.0.0.1",
        port: 8080,
      },
    }),
    true,
  );

  assert.equal(
    ssh.send({
      v: 1,
      t: "tcp_data",
      id: 19,
      p: {
        data: Buffer.from("ping", "utf8"),
      },
    }),
    true,
  );

  assert.equal(
    ssh.send({
      v: 1,
      t: "tcp_close",
      id: 19,
      p: {},
    }),
    true,
  );

  await waitFor(
    () =>
      controlMessages.some(
        (message) =>
          message.t === "exec_response" &&
          message.id === 5 &&
          message.p?.exit_code === 0,
      ),
    1_000,
    "control exec_response",
  );

  await waitFor(
    () =>
      sshMessages.some(
        (message) => message.t === "tcp_opened" && message.id === 19,
      ),
    1_000,
    "ssh tcp_opened",
  );

  await waitFor(
    () =>
      sshMessages.some(
        (message) =>
          message.t === "tcp_data" &&
          message.id === 19 &&
          Buffer.isBuffer(message.p?.data) &&
          message.p.data.toString("utf8") === "ping",
      ),
    1_000,
    "ssh tcp_data",
  );

  await waitFor(
    () =>
      sshMessages.some(
        (message) => message.t === "tcp_closed" && message.id === 19,
      ),
    1_000,
    "ssh tcp_closed",
  );

  assert.equal(
    controlMessages.some((message) => message.t.startsWith("tcp_")),
    false,
  );
  assert.equal(
    sshMessages.some((message) => message.t.startsWith("exec_")),
    false,
  );

  await control.disconnect();
  await ssh.disconnect();
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

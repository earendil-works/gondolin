import assert from "node:assert/strict";
import test from "node:test";

import { decodeOutputFrame } from "../src/sandbox/control-protocol.ts";
import { SandboxServer } from "../src/sandbox/server.ts";
import { resolveSandboxServerOptions } from "../src/sandbox/server-options.ts";

type Captured = {
  json: any[];
  binary: Buffer[];
  closed: boolean;
};

function makeClient(): { client: any; captured: Captured } {
  const captured: Captured = { json: [], binary: [], closed: false };
  const client = {
    sendJson: (message: any) => {
      captured.json.push(message);
      return true;
    },
    sendBinary: (data: Buffer) => {
      captured.binary.push(data);
      return true;
    },
    close: () => {
      captured.closed = true;
    },
  };
  return { client, captured };
}

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

test("SandboxServer vmm=wasm-node executes PTY request through function bridge harness", async () => {
  const resolved = resolveSandboxServerOptions({
    vmm: "wasm-node",
    netEnabled: false,
    autoRestart: false,
  });

  const server = new SandboxServer(resolved);
  const { client, captured } = makeClient();

  await server.start();

  await (server as any).handleBoot(client, {
    type: "boot",
  });

  (server as any).handleExec(client, {
    type: "exec",
    id: 31,
    cmd: "/bin/bash",
    argv: ["-i"],
    stdin: true,
    pty: true,
  });

  await waitFor(
    () =>
      captured.json.some(
        (message) =>
          message?.type === "exec_response" &&
          message?.id === 31 &&
          message?.exit_code === 0,
      ),
    2_000,
    "exec response",
  );

  const outputText = captured.binary
    .map((frame) => decodeOutputFrame(frame).data.toString("utf8"))
    .join("");

  assert.match(outputText, /\[wasm-harness\] cmd=\/bin\/bash pty=1/);

  await server.close();
});

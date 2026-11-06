import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  type ClientMessage,
  type ServerMessage,
} from "../src/sandbox/control-protocol.ts";
import type { SandboxConnection } from "../src/sandbox/client.ts";
import { SessionIpcServer } from "../src/session-registry.ts";

/** Client to server: a 4-byte big-endian length, then the JSON payload. */
function encodeRequest(message: ClientMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Drive one request against a session IPC server and return the first reply.
 *
 * A `secret_env` request is answered from the handler without touching the
 * guest, so the sandbox connection is never used and a stub suffices.
 */
async function request(
  message: ClientMessage,
  handlers: { onSecretEnv?: () => Record<string, string> },
): Promise<ServerMessage> {
  // Short, because a unix socket path is capped near 104 bytes on macOS.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-"));
  const sockPath = path.join(dir, "s.sock");

  const stubConnection = {
    send: () => {},
    close: () => {},
  } as unknown as SandboxConnection;

  const server = new SessionIpcServer(sockPath, () => stubConnection, handlers);
  server.start();

  try {
    return await new Promise<ServerMessage>((resolve, reject) => {
      const socket = net.createConnection({ path: sockPath }, () => {
        socket.write(encodeRequest(message));
      });

      // Server to client adds a leading frame-type byte before the length.
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 5) return;
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 5 + length) return;
        const payload = buffer.subarray(5, 5 + length);
        socket.destroy();
        resolve(JSON.parse(payload.toString("utf8")) as ServerMessage);
      });

      socket.on("error", reject);
      setTimeout(() => reject(new Error("timed out")), 5000).unref();
    });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a session serves its secret placeholders over the socket", async () => {
  const reply = await request(
    { type: "secret_env", id: 7 },
    {
      onSecretEnv: () => ({
        GITHUB_TOKEN: "placeholder-github",
        NPM_TOKEN: "placeholder-npm",
      }),
    },
  );

  assert.deepEqual(reply, {
    type: "secret_env_response",
    id: 7,
    env: { GITHUB_TOKEN: "placeholder-github", NPM_TOKEN: "placeholder-npm" },
  });
});

test("a session with no secrets answers with an empty environment", async () => {
  const reply = await request({ type: "secret_env", id: 1 }, {});

  // An empty map rather than an error, so attach stays usable on a session
  // that simply has no secrets configured.
  assert.deepEqual(reply, { type: "secret_env_response", id: 1, env: {} });
});

test("a secret_env request with a bad id is rejected", async () => {
  const reply = await request(
    { type: "secret_env", id: -1 },
    { onSecretEnv: () => ({ GITHUB_TOKEN: "placeholder-github" }) },
  );

  assert.equal(reply.type, "error");
  assert.equal(reply.code, "invalid_request");
});

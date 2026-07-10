import assert from "node:assert/strict";
import test from "node:test";

import type { ClientMessage } from "../src/sandbox/control-protocol.ts";
import {
  SessionIpcServer,
  connectToSession,
} from "../src/session-registry.ts";

test("SessionIpcServer accepts tcp endpoints for attach IPC", async () => {
  const endpoint = {
    transport: "tcp" as const,
    host: "127.0.0.1",
    port: 0,
  };

  const server = new SessionIpcServer(endpoint, (onMessage) => ({
    send(message: ClientMessage) {
      if (message.type !== "exec") return;
      onMessage(
        JSON.stringify({
          type: "exec_response",
          id: message.id,
          exit_code: 0,
        }),
        false,
      );
    },
    close() {},
  }));

  await server.start();
  assert.ok(endpoint.port > 0);

  const response = await new Promise<any>((resolve, reject) => {
    const client = connectToSession(endpoint, {
      onJson(message) {
        resolve(message);
        client.close();
      },
      onBinary() {
        reject(new Error("unexpected binary frame"));
      },
      onClose(error) {
        if (error) reject(error);
      },
    });

    client.send({
      type: "exec",
      id: 7,
      cmd: "/bin/true",
    });
  });

  assert.equal(response.type, "exec_response");
  assert.equal(response.id, 7);
  assert.equal(response.exit_code, 0);

  await server.close();
});

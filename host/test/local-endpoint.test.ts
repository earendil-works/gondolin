import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  createDefaultLocalEndpoint,
  createNetConnectOptions,
  listenOnLocalEndpoint,
  normalizeLocalEndpoint,
} from "../src/local-endpoint.ts";

test("createDefaultLocalEndpoint uses loopback tcp on Windows", () => {
  const endpoint = createDefaultLocalEndpoint("gondolin-test", {
    platform: "win32",
  });

  assert.deepEqual(endpoint, {
    transport: "tcp",
    host: "127.0.0.1",
    port: 0,
  });
});

test("normalizeLocalEndpoint rejects legacy string paths on Windows", () => {
  assert.throws(
    () =>
      normalizeLocalEndpoint("C:/tmp/gondolin.sock", "sandbox.netSocketPath", {
        platform: "win32",
      }),
    /explicit \{ transport: "tcp", host, port \} endpoint on Windows/,
  );
});

test("normalizeLocalEndpoint rejects unix endpoints on Windows", () => {
  assert.throws(
    () =>
      normalizeLocalEndpoint(
        { transport: "unix", path: "C:/tmp/gondolin.sock" },
        "sandbox.netSocketPath",
        { platform: "win32" },
      ),
    /must use transport "tcp" on Windows/,
  );
});

test("normalizeLocalEndpoint rejects non-loopback tcp hosts", () => {
  assert.throws(
    () =>
      normalizeLocalEndpoint(
        { transport: "tcp", host: "0.0.0.0", port: 9000 },
        "sandbox.netSocketPath",
        { platform: "win32" },
      ),
    /must be a loopback host/,
  );
});

test("listenOnLocalEndpoint binds ephemeral tcp ports and updates the endpoint", async () => {
  const endpoint = {
    transport: "tcp" as const,
    host: "127.0.0.1",
    port: 0,
  };

  const server = net.createServer((socket) => {
    socket.end("ok");
  });

  await listenOnLocalEndpoint(server, endpoint);
  assert.ok(endpoint.port > 0);

  const payload = await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(createNetConnectOptions(endpoint));
    let data = "";

    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });

  assert.equal(payload, "ok");

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

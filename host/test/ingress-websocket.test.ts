import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { once } from "node:events";

import { IngressGateway } from "../src/ingress";

test("ingress: websocket upgrades are tunneled", async () => {
  const backend = net.createServer();

  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendAddr = backend.address();
  assert.ok(backendAddr && typeof backendAddr !== "string");

  const backendPort = backendAddr.port;

  backend.on("connection", (sock) => {
    let buf = Buffer.alloc(0);
    let upgraded = false;

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (!upgraded) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const rest = buf.subarray(idx + 4);
        upgraded = true;
        buf = Buffer.alloc(0);

        sock.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "\r\n"
        );

        sock.write(Buffer.from("welcome"));

        if (rest.length > 0) {
          sock.write(Buffer.from("echo:"));
          sock.write(rest);
        }

        return;
      }

      if (chunk.length > 0) {
        sock.write(Buffer.from("echo:"));
        sock.write(chunk);
      }
    });
  });

  const sandbox = {
    openIngressStream: async ({ host, port }: { host: string; port: number }) => {
      const sock = net.connect(port, host);
      await once(sock, "connect");
      return sock;
    },
  } as any;

  const listeners = {
    getRoutes: () => [{ prefix: "/", port: backendPort, stripPrefix: true }],
  } as any;

  const gateway = new IngressGateway(sandbox, listeners);
  const access = await gateway.listen({ listenHost: "127.0.0.1", listenPort: 0, allowWebSockets: true });

  const client = net.connect(access.port, access.host);
  await once(client, "connect");

  client.write(
    "GET / HTTP/1.1\r\n" +
      "Host: example.local\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Key: x\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "\r\n" +
      "hello"
  );

  let received = Buffer.alloc(0);
  client.on("data", (chunk) => {
    received = Buffer.concat([received, chunk]);
  });

  // Wait for the handshake response + initial tunnel bytes.
  await new Promise((r) => setTimeout(r, 100));

  // Send a post-upgrade payload.
  client.write(Buffer.from("ping"));

  await new Promise((r) => setTimeout(r, 100));

  const out = received.toString("utf8");
  assert.match(out, /^HTTP\/1\.1 101 /);
  assert.ok(out.includes("welcome"));
  assert.ok(out.includes("echo:hello"));
  assert.ok(out.includes("echo:ping"));

  client.destroy();
  await access.close();
  backend.close();
});

import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { Duplex } from "node:stream";

import { IngressGateway } from "../src/ingress";

class CaptureSocket extends EventEmitter {
  remoteAddress = "203.0.113.1";
  destroyed = false;
  readonly writes: Buffer[] = [];

  write(chunk: Buffer | string) {
    this.writes.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

class RequestCaptureDuplex extends Duplex {
  readonly written: Buffer[] = [];
  private responded = false;

  _read() {
    // no-op
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.written.push(Buffer.from(chunk));

    if (!this.responded && Buffer.concat(this.written).includes(Buffer.from("\r\n\r\n"))) {
      this.responded = true;
      this.push(Buffer.from("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n", "latin1"));
      this.push(null);
    }

    callback();
  }
}

test("ingress: websocket upgrades are tunneled", async () => {
  const backendSockets: net.Socket[] = [];
  const backend = net.createServer((sock) => {
    backendSockets.push(sock);

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

  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendAddr = backend.address();
  assert.ok(backendAddr && typeof backendAddr !== "string");

  const backendPort = backendAddr.port;

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

  for (const s of backendSockets) {
    try {
      s.destroy();
    } catch {
      // ignore
    }
  }

  await new Promise<void>((resolve) => backend.close(() => resolve()));
});

test("ingress: websocket upgrade rejects non-GET methods", async () => {
  let opened = false;
  const sandbox = {
    openIngressStream: async () => {
      opened = true;
      throw new Error("should not be called");
    },
  } as any;

  const listeners = {
    getRoutes: () => [{ prefix: "/", port: 80, stripPrefix: true }],
  } as any;

  const gateway = new IngressGateway(sandbox, listeners);

  const req = new EventEmitter() as any;
  req.method = "POST";
  req.url = "/";
  req.headers = {
    host: "example.local",
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": "x",
    "sec-websocket-version": "13",
  };

  const socket = new CaptureSocket();
  await (gateway as any).handleUpgrade(req, socket, Buffer.alloc(0));

  const raw = Buffer.concat(socket.writes).toString("utf8");
  assert.match(raw, /^HTTP\/1\.1 400 /);
  assert.ok(raw.includes("websocket upgrade requires GET"));
  assert.equal(opened, false);
});

test("ingress: websocket hooks cannot rewrite upgrade method away from GET", async () => {
  let opened = false;
  const sandbox = {
    openIngressStream: async () => {
      opened = true;
      throw new Error("should not be called");
    },
  } as any;

  const listeners = {
    getRoutes: () => [{ prefix: "/", port: 80, stripPrefix: true }],
  } as any;

  const gateway = new IngressGateway(sandbox, listeners, {
    hooks: {
      onRequest: () => ({ method: "POST" }),
    },
  });

  const req = new EventEmitter() as any;
  req.method = "GET";
  req.url = "/";
  req.headers = {
    host: "example.local",
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": "x",
    "sec-websocket-version": "13",
  };

  const socket = new CaptureSocket();
  await (gateway as any).handleUpgrade(req, socket, Buffer.alloc(0));

  const raw = Buffer.concat(socket.writes).toString("utf8");
  assert.match(raw, /^HTTP\/1\.1 400 /);
  assert.ok(raw.includes("websocket upgrade requires GET"));
  assert.equal(opened, false);
});

test("ingress: malformed websocket upgrade URLs return 400", async () => {
  const sandbox = {
    openIngressStream: async () => {
      throw new Error("should not be called");
    },
  } as any;

  const listeners = {
    getRoutes: () => [{ prefix: "/", port: 80, stripPrefix: true }],
  } as any;

  const gateway = new IngressGateway(sandbox, listeners);

  const req = new EventEmitter() as any;
  req.method = "GET";
  req.url = "http://%";
  req.headers = {
    host: "example.local",
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": "x",
    "sec-websocket-version": "13",
  };

  const socket = new CaptureSocket();
  await (gateway as any).handleUpgrade(req, socket, Buffer.alloc(0));

  const raw = Buffer.concat(socket.writes).toString("utf8");
  assert.match(raw, /^HTTP\/1\.1 400 /);
  assert.ok(raw.includes("bad request"));
});

test("ingress: websocket upgrade forwards joined host header values", async () => {
  const upstream = new RequestCaptureDuplex();

  const sandbox = {
    openIngressStream: async () => upstream,
  } as any;

  const listeners = {
    getRoutes: () => [{ prefix: "/", port: 8080, stripPrefix: true }],
  } as any;

  const gateway = new IngressGateway(sandbox, listeners);

  const req = new EventEmitter() as any;
  req.method = "GET";
  req.url = "/";
  req.headers = {
    host: ["first.example", "second.example"],
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": "x",
    "sec-websocket-version": "13",
  };

  const socket = new CaptureSocket();
  await (gateway as any).handleUpgrade(req, socket, Buffer.alloc(0));

  const forwarded = Buffer.concat(upstream.written).toString("latin1").toLowerCase();
  assert.match(forwarded, /\r\nhost: first\.example,second\.example\r\n/);
  assert.doesNotMatch(forwarded, /\r\nhost: localhost\r\n/);
});

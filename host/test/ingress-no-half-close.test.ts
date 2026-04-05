import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { createServer } from "node:http";
import { Writable } from "node:stream";
import test from "node:test";

import { GondolinListeners, IngressGateway } from "../src/ingress.ts";
import { MemoryProvider } from "../src/vfs/node/index.ts";

class CaptureResponse extends Writable {
  statusCode = 0;
  statusMessage = "";
  headersSent = false;
  readonly headers: Record<string, string | string[]> = {};
  readonly bodyChunks: Buffer[] = [];

  setHeader(name: string, value: any) {
    this.headers[name.toLowerCase()] = value;
  }

  writeHead(statusCode: number, statusMessage?: string, headers?: any) {
    if (typeof statusMessage === "object" && statusMessage !== null) {
      headers = statusMessage;
      statusMessage = "";
    }
    this.statusCode = statusCode;
    this.statusMessage = statusMessage ?? "";
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.setHeader(k, v);
      }
    }
    this.headersSent = true;
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    cb: (error?: Error | null) => void,
  ) {
    this.bodyChunks.push(Buffer.from(chunk));
    cb();
  }
}

// Integration test using a real HTTP server to verify that the ingress
// gateway does not send TCP FIN (via upstream.end()) before the backend
// has responded. This reproduces the 502 bug with Kestrel and other async
// HTTP servers (see #69).
//
// Unlike the unit tests which use mock Duplex streams, this test uses a
// real net.Server + net.Socket pair so that TCP half-close semantics are
// exercised through the kernel, not simulated.
test("IngressGateway: does not 502 with async HTTP backend (real sockets, #69)", async () => {
  // Start a real HTTP server that responds asynchronously
  const server = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello from backend");
    }, 50);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const backendPort = (server.address() as net.AddressInfo).port;

  const listeners = new GondolinListeners(new MemoryProvider());
  listeners.setRoutes([
    { prefix: "/", port: backendPort, stripPrefix: true },
  ]);

  // The sandbox returns a real TCP connection to the backend
  const sandbox = {
    openIngressStream: async () => {
      return net.createConnection({ port: backendPort, host: "127.0.0.1" });
    },
  } as any;

  const gateway = new IngressGateway(sandbox, listeners);

  const { Readable } = await import("node:stream");
  const req = Readable.from([]) as any;
  req.method = "GET";
  req.url = "/";
  req.headers = { host: `127.0.0.1:${backendPort}` };
  req.socket = { remoteAddress: "127.0.0.1" };

  const res = new CaptureResponse() as any;

  await (gateway as any).handleRequest(req, res);
  try {
    await once(res, "finish");

    assert.equal(
      res.statusCode,
      200,
      `Expected 200 but got ${res.statusCode}. ` +
        "If this returns 502, the gateway is sending TCP FIN to the backend " +
        "before the response arrives (see #69).",
    );
    assert.equal(
      Buffer.concat(res.bodyChunks).toString("utf8"),
      "hello from backend",
    );
  } finally {
    server.close();
  }
});

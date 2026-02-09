import assert from "node:assert/strict";
import { once } from "node:events";
import { Duplex, Readable, Writable } from "node:stream";
import test from "node:test";

import { GondolinListeners, IngressGateway } from "../src/ingress";
import { MemoryProvider } from "../src/vfs";

class CaptureDuplex extends Duplex {
  readonly written: Buffer[] = [];

  _read(_size: number) {
    // driven by push() from the test
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, cb: (error?: Error | null) => void) {
    this.written.push(Buffer.from(chunk));
    cb();
  }
}

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

  _write(chunk: Buffer, _encoding: BufferEncoding, cb: (error?: Error | null) => void) {
    this.bodyChunks.push(Buffer.from(chunk));
    cb();
  }
}

test("IngressGateway hooks: isAllowed can deny", async () => {
  const listeners = new GondolinListeners(new MemoryProvider());
  listeners.setRoutes([{ prefix: "/", port: 1234, stripPrefix: true }]);

  let opened = 0;
  const sandbox = {
    openIngressStream: async () => {
      opened += 1;
      return new CaptureDuplex();
    },
  } as any;

  const gateway = new IngressGateway(sandbox, listeners, {
    hooks: {
      isAllowed: async () => false,
    },
  });

  const req = Readable.from([]) as any;
  req.method = "GET";
  req.url = "/";
  req.headers = { host: "example" };
  req.socket = { remoteAddress: "203.0.113.1" };

  const res = new CaptureResponse() as any;

  await (gateway as any).handleRequest(req, res);
  await once(res, "finish");

  assert.equal(opened, 0);
  assert.equal(res.statusCode, 403);
  assert.equal(Buffer.concat(res.bodyChunks).toString("utf8"), "forbidden\n");
});

test("IngressGateway hooks: onRequest can rewrite target and headers", async () => {
  const listeners = new GondolinListeners(new MemoryProvider());
  listeners.setRoutes([{ prefix: "/", port: 1234, stripPrefix: true }]);

  let upstream: CaptureDuplex | null = null;
  const sandbox = {
    openIngressStream: async () => {
      upstream = new CaptureDuplex();
      upstream.once("finish", () => {
        upstream!.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        upstream!.push(null);
      });
      return upstream;
    },
  } as any;

  const gateway = new IngressGateway(sandbox, listeners, {
    hooks: {
      onRequest: (request) => {
        return {
          backendTarget: "/rewritten",
          headers: {
            "x-added": "1",
            "x-remove": null,
          },
        };
      },
    },
  });

  const req = Readable.from([]) as any;
  req.method = "GET";
  req.url = "/orig";
  req.headers = { host: "example", "x-remove": "bye" };
  req.socket = { remoteAddress: "203.0.113.1" };

  const res = new CaptureResponse() as any;

  await (gateway as any).handleRequest(req, res);
  await once(res, "finish");

  assert.ok(upstream);
  const upstreamBytes = Buffer.concat(upstream.written).toString("utf8");
  const headEnd = upstreamBytes.indexOf("\r\n\r\n");
  assert.ok(headEnd !== -1);
  const head = upstreamBytes.slice(0, headEnd);

  assert.match(head, /^GET \/rewritten HTTP\/1\.1\r\n/i);
  assert.match(head, /\r\nx-added: 1\r\n/i);
  assert.doesNotMatch(head, /\r\nx-remove:/i);
});

test("IngressGateway hooks: onResponse can rewrite status and headers without buffering", async () => {
  const listeners = new GondolinListeners(new MemoryProvider());
  listeners.setRoutes([{ prefix: "/", port: 1234, stripPrefix: true }]);

  const sandbox = {
    openIngressStream: async () => {
      const upstream = new CaptureDuplex();
      upstream.once("finish", () => {
        upstream.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        upstream.push(null);
      });
      return upstream;
    },
  } as any;

  const gateway = new IngressGateway(sandbox, listeners, {
    hooks: {
      onResponse: () => {
        return {
          statusCode: 201,
          headers: {
            "x-hooked": "yes",
          },
        };
      },
    },
  });

  const req = Readable.from([]) as any;
  req.method = "GET";
  req.url = "/";
  req.headers = { host: "example" };
  req.socket = { remoteAddress: "203.0.113.1" };

  const res = new CaptureResponse() as any;

  await (gateway as any).handleRequest(req, res);
  await once(res, "finish");

  assert.equal(res.statusCode, 201);
  assert.equal(res.headers["x-hooked"], "yes");
  assert.equal(Buffer.concat(res.bodyChunks).toString("utf8"), "ok");
});

test("IngressGateway hooks: bufferResponseBody enables body rewrites", async () => {
  const listeners = new GondolinListeners(new MemoryProvider());
  listeners.setRoutes([{ prefix: "/", port: 1234, stripPrefix: true }]);

  const sandbox = {
    openIngressStream: async () => {
      const upstream = new CaptureDuplex();
      upstream.once("finish", () => {
        upstream.push(
          "HTTP/1.1 200 OK\r\n" +
            "Transfer-Encoding: chunked\r\n" +
            "\r\n" +
            "5\r\nhello\r\n" +
            "0\r\n\r\n"
        );
        upstream.push(null);
      });
      return upstream;
    },
  } as any;

  const gateway = new IngressGateway(sandbox, listeners, {
    hooks: {
      onRequest: () => ({ bufferResponseBody: true }),
      onResponse: (response) => {
        assert.ok(response.body);
        return {
          body: Buffer.from(response.body.toString("utf8").toUpperCase()),
        };
      },
    },
  });

  const req = Readable.from([]) as any;
  req.method = "GET";
  req.url = "/";
  req.headers = { host: "example" };
  req.socket = { remoteAddress: "203.0.113.1" };

  const res = new CaptureResponse() as any;

  await (gateway as any).handleRequest(req, res);
  await once(res, "finish");

  assert.equal(res.statusCode, 200);
  assert.equal(Buffer.concat(res.bodyChunks).toString("utf8"), "HELLO");
  assert.equal(res.headers["content-length"], "5");
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { Duplex, Readable, Writable } from "node:stream";
import test from "node:test";

import { GondolinListeners, IngressGateway } from "../src/ingress.ts";
import { MemoryProvider } from "../src/vfs/node/index.ts";

class CaptureDuplex extends Duplex {
  readonly written: Buffer[] = [];
  private firstWriteFired = false;

  _read(_size: number) {
    // driven by push() from the test
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    cb: (error?: Error | null) => void,
  ) {
    this.written.push(Buffer.from(chunk));
    if (!this.firstWriteFired) {
      this.firstWriteFired = true;
      this.emit("first_write");
    }
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

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    cb: (error?: Error | null) => void,
  ) {
    this.bodyChunks.push(Buffer.from(chunk));
    cb();
  }
}

test("IngressGateway: ignores client Content-Length when transfer-encoding is present", async () => {
  const listeners = new GondolinListeners(new MemoryProvider());
  listeners.setRoutes([{ prefix: "/", port: 1234, stripPrefix: true }]);

  let upstream: CaptureDuplex | null = null;

  const sandbox = {
    openIngressStream: async () => {
      upstream = new CaptureDuplex();
      upstream.once("first_write", () => {
        // Duplicate TE header lines to ensure the gateway handles string[] values.
        const response =
          "HTTP/1.1 200 OK\r\n" +
          "Transfer-Encoding: chunked\r\n" +
          "Transfer-Encoding: chunked\r\n" +
          "Connection: bar\r\n" +
          "Bar: should-not-forward\r\n" +
          "\r\n" +
          "2\r\nok\r\n" +
          "0\r\n\r\n";
        upstream!.push(response);
        upstream!.push(null);
      });
      return upstream;
    },
  } as any;

  const gateway = new IngressGateway(sandbox, listeners);

  // Model what Node hands to request handlers:
  // - body stream is already de-chunked
  // - headers may still contain both TE and CL (depending on parser settings)
  const req = Readable.from([Buffer.from("TEST")]) as any;
  req.method = "POST";
  req.url = "/";
  req.headers = {
    host: "example",
    connection: "foo",
    foo: "should-not-forward",
    "content-length": "4",
    "transfer-encoding": "chunked",
  };
  req.socket = { remoteAddress: "203.0.113.1" };

  const res = new CaptureResponse() as any;

  await (gateway as any).handleRequest(req, res);
  await once(res, "finish");

  assert.equal(res.statusCode, 200);
  assert.equal(Buffer.concat(res.bodyChunks).toString("utf8"), "ok");

  // Hop-by-hop removal honors Connection: bar
  assert.equal(res.headers["bar"], undefined);

  assert.ok(upstream);
  const upstreamBytes = Buffer.concat(upstream.written).toString("utf8");
  const headEnd = upstreamBytes.indexOf("\r\n\r\n");
  assert.ok(headEnd !== -1);

  const head = upstreamBytes.slice(0, headEnd);
  const body = upstreamBytes.slice(headEnd + 4);

  assert.match(head, /transfer-encoding: chunked/i);
  assert.doesNotMatch(head, /\r\ncontent-length:/i);

  // Hop-by-hop removal honors Connection: foo
  assert.doesNotMatch(head, /\r\nfoo:/i);

  // Body should be chunked (re-encoded)
  assert.match(body, /^4\r\nTEST\r\n0\r\n\r\n$/);
});

test("IngressGateway: rejects non-upgrade HTTP requests that carry upgrade intent headers", async () => {
  const listeners = new GondolinListeners(new MemoryProvider());
  listeners.setRoutes([{ prefix: "/", port: 1234, stripPrefix: true }]);

  let opened = 0;
  const sandbox = {
    openIngressStream: async () => {
      opened += 1;
      return new CaptureDuplex();
    },
  } as any;

  const gateway = new IngressGateway(sandbox, listeners);

  const req = Readable.from([]) as any;
  req.method = "GET";
  req.url = "/";
  req.headers = {
    host: "example",
    connection: "upgrade",
  };
  req.socket = { remoteAddress: "203.0.113.1" };

  const res = new CaptureResponse() as any;

  await (gateway as any).handleRequest(req, res);
  await once(res, "finish");

  assert.equal(opened, 0);
  assert.equal(res.statusCode, 426);
  assert.equal(
    Buffer.concat(res.bodyChunks).toString("utf8"),
    "use websocket upgrade\n",
  );
});

test("IngressGateway: returns 502 on upstream response header timeout", async () => {
  const listeners = new GondolinListeners(new MemoryProvider());
  listeners.setRoutes([{ prefix: "/", port: 1234, stripPrefix: true }]);

  let upstream: CaptureDuplex | null = null;
  const sandbox = {
    openIngressStream: async () => {
      upstream = new CaptureDuplex();
      return upstream;
    },
  } as any;

  const gateway = new IngressGateway(sandbox, listeners, {
    upstreamHeaderTimeoutMs: 10,
  });

  const req = Readable.from([]) as any;
  req.method = "GET";
  req.url = "/";
  req.headers = { host: "example" };
  req.socket = { remoteAddress: "203.0.113.1" };

  const res = new CaptureResponse() as any;

  await (gateway as any).handleRequest(req, res);
  await once(res, "finish");

  assert.equal(res.statusCode, 502);
  assert.equal(Buffer.concat(res.bodyChunks).toString("utf8"), "bad gateway\n");
  assert.equal(upstream?.destroyed, true);
});

test("IngressGateway: returns 502 on upstream response body timeout while buffering", async () => {
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
            "5\r\nhello\r\n",
        );
      });
      return upstream;
    },
  } as any;

  const gateway = new IngressGateway(sandbox, listeners, {
    hooks: {
      onRequest: () => ({ bufferResponseBody: true }),
      onResponse: () => undefined,
    },
    upstreamResponseTimeoutMs: 10,
  });

  const req = Readable.from([]) as any;
  req.method = "GET";
  req.url = "/";
  req.headers = { host: "example" };
  req.socket = { remoteAddress: "203.0.113.1" };

  const res = new CaptureResponse() as any;

  await (gateway as any).handleRequest(req, res);
  await once(res, "finish");

  assert.equal(res.statusCode, 502);
  assert.equal(Buffer.concat(res.bodyChunks).toString("utf8"), "bad gateway\n");
});

test("IngressGateway: does not half-close upstream before response arrives", async () => {
  const listeners = new GondolinListeners(new MemoryProvider());
  listeners.setRoutes([{ prefix: "/", port: 1234, stripPrefix: true }]);

  let upstream: CaptureDuplex | null = null;
  let upstreamEndCalls = 0;

  const sandbox = {
    openIngressStream: async () => {
      upstream = new CaptureDuplex();

      // Model backends (for example Kestrel) that treat an incoming FIN as
      // a client disconnect and abort without sending a response.
      upstream.end = ((..._args: any[]) => {
        upstreamEndCalls += 1;
        upstream!.destroy(new Error("backend aborted on client half-close"));
        return upstream!;
      }) as any;

      upstream.once("first_write", () => {
        setTimeout(() => {
          if (!upstream || upstream.destroyed) return;
          upstream.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
          upstream.push(null);
        }, 20);
      });

      return upstream;
    },
  } as any;

  const gateway = new IngressGateway(sandbox, listeners);

  const req = Readable.from([]) as any;
  req.method = "GET";
  req.url = "/";
  req.headers = { host: "example" };
  req.socket = { remoteAddress: "203.0.113.1" };

  const res = new CaptureResponse() as any;

  await (gateway as any).handleRequest(req, res);
  await once(res, "finish");

  assert.equal(upstreamEndCalls, 0);
  assert.equal(res.statusCode, 200);
  assert.equal(Buffer.concat(res.bodyChunks).toString("utf8"), "ok");
});

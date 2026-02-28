import assert from "node:assert/strict";
import { once } from "node:events";
import { Duplex, Readable, Writable } from "node:stream";
import test from "node:test";

import { GondolinListeners, IngressGateway } from "../src/ingress.ts";
import { MemoryProvider } from "../src/vfs/node/index.ts";

class CaptureDuplex extends Duplex {
  readonly written: Buffer[] = [];

  _read(_size: number) {
    // driven by push() from the test
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    cb: (error?: Error | null) => void,
  ) {
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
      upstream.once("finish", () => {
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

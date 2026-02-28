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

class EmittingResponse extends Writable {
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
    const b = Buffer.from(chunk);
    this.bodyChunks.push(b);
    this.emit("chunk", b);
    cb();
  }
}

test("IngressGateway: streams chunked response without buffering whole chunk", async () => {
  const listeners = new GondolinListeners(new MemoryProvider());
  listeners.setRoutes([{ prefix: "/", port: 1234, stripPrefix: true }]);

  let upstream: CaptureDuplex | null = null;
  let pushedRemainder = false;

  const sandbox = {
    openIngressStream: async () => {
      upstream = new CaptureDuplex();
      upstream.once("finish", () => {
        // Chunk size = 0x10 = 16, but only send 10 bytes first.
        upstream!.push(
          "HTTP/1.1 200 OK\r\n" +
            "Transfer-Encoding: chunked\r\n" +
            "\r\n" +
            "10\r\n" +
            "0123456789",
        );

        // Send the remaining 6 bytes on the next turn of the event loop.
        setImmediate(() => {
          pushedRemainder = true;
          upstream!.push("ABCDEF\r\n0\r\n\r\n");
          upstream!.push(null);
        });
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

  const res = new EmittingResponse() as any;

  const handlerPromise = (gateway as any).handleRequest(req, res);

  const [firstChunk] = (await once(res, "chunk")) as [Buffer];
  assert.equal(pushedRemainder, false);
  assert.equal(firstChunk.toString("ascii"), "0123456789");

  await handlerPromise;
  await once(res, "finish");

  assert.equal(res.statusCode, 200);
  assert.equal(
    Buffer.concat(res.bodyChunks).toString("ascii"),
    "0123456789ABCDEF",
  );
});

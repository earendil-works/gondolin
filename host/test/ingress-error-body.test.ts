import assert from "node:assert/strict";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { GondolinListeners, IngressGateway } from "../src/ingress.ts";
import { MemoryProvider } from "../src/vfs/node/index.ts";

class CaptureResponse extends Writable {
  statusCode = 0;
  headersSent = false;
  readonly headers: Record<string, string | string[]> = {};
  readonly bodyChunks: Buffer[] = [];

  setHeader(name: string, value: any) {
    this.headers[name.toLowerCase()] = value;
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

test("IngressGateway: 502 body is generic and does not reflect internal errors", async () => {
  const listeners = new GondolinListeners(new MemoryProvider());
  listeners.setRoutes([{ prefix: "/", port: 1234, stripPrefix: true }]);

  const sandbox = {
    openIngressStream: async () => {
      throw new Error("secret-internal-detail: virtio queue exceeded");
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

  const body = Buffer.concat(res.bodyChunks).toString("utf8");
  assert.equal(res.statusCode, 502);
  assert.equal(body, "bad gateway\n");
  assert.doesNotMatch(body, /secret-internal-detail/);
});

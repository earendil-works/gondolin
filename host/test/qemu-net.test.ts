import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import tls from "node:tls";

import forge from "node-forge";

import { HttpRequestBlockedError, QemuNetworkBackend, __test } from "../src/qemu-net";

function makeBackend(options?: Partial<ConstructorParameters<typeof QemuNetworkBackend>[0]>) {
  return new QemuNetworkBackend({
    socketPath: path.join(
      os.tmpdir(),
      `gondolin-net-test-${process.pid}-${crypto.randomUUID()}.sock`
    ),
    ...options,
  });
}

test("qemu-net: parseHttpRequest parses content-length and preserves remaining", () => {
  const backend = makeBackend({ maxHttpBodyBytes: 1024 });
  const buf = Buffer.from(
    "POST /path HTTP/1.1\r\n" +
      "Host: example.com\r\n" +
      "Content-Length: 5\r\n" +
      "X-Test: a\r\n" +
      "X-Test: b\r\n" +
      "\r\n" +
      "hello" +
      "EXTRA"
  );

  const parsed = (backend as any).parseHttpRequest(buf) as
    | { request: any; remaining: Buffer }
    | null;
  assert.ok(parsed);
  assert.equal(parsed.request.method, "POST");
  assert.equal(parsed.request.target, "/path");
  assert.equal(parsed.request.version, "HTTP/1.1");
  assert.equal(parsed.request.headers.host, "example.com");
  // duplicated headers are joined
  assert.equal(parsed.request.headers["x-test"], "a, b");
  assert.equal(parsed.request.body.toString("utf8"), "hello");
  assert.equal(parsed.remaining.toString("utf8"), "EXTRA");
});

test("qemu-net: parseHttpRequest decodes chunked body (and waits for completeness)", () => {
  const backend = makeBackend({ maxHttpBodyBytes: 1024 });

  const incomplete = Buffer.from(
    "POST / HTTP/1.1\r\n" +
      "Host: example.com\r\n" +
      "Transfer-Encoding: chunked\r\n" +
      "\r\n" +
      "5\r\nhe"
  );
  assert.equal((backend as any).parseHttpRequest(incomplete), null);

  const complete = Buffer.from(
    "POST / HTTP/1.1\r\n" +
      "Host: example.com\r\n" +
      "Transfer-Encoding: chunked\r\n" +
      "\r\n" +
      "5\r\nhello\r\n" +
      "0\r\n\r\n"
  );

  const parsed = (backend as any).parseHttpRequest(complete) as
    | { request: any; remaining: Buffer }
    | null;
  assert.ok(parsed);
  assert.equal(parsed.request.headers["content-length"], "5");
  assert.ok(!("transfer-encoding" in parsed.request.headers));
  assert.equal(parsed.request.body.toString("utf8"), "hello");
  assert.equal(parsed.remaining.length, 0);
});

test("qemu-net: parseHttpRequest consumes chunked trailers", () => {
  const backend = makeBackend({ maxHttpBodyBytes: 1024 });

  const complete = Buffer.from(
    "POST / HTTP/1.1\r\n" +
      "Host: example.com\r\n" +
      "Transfer-Encoding: chunked\r\n" +
      "\r\n" +
      "5\r\nhello\r\n" +
      "0\r\n" +
      "X-Trailer: yes\r\n" +
      "\r\n"
  );

  const parsed = (backend as any).parseHttpRequest(complete) as
    | { request: any; remaining: Buffer }
    | null;
  assert.ok(parsed);
  assert.equal(parsed.request.headers["content-length"], "5");
  assert.ok(!("transfer-encoding" in parsed.request.headers));
  assert.equal(parsed.request.body.toString("utf8"), "hello");
  assert.equal(parsed.remaining.length, 0);
});

test("qemu-net: parseHttpRequest rejects unsupported transfer-encodings", () => {
  const backend = makeBackend({ maxHttpBodyBytes: 1024 });

  const buf = Buffer.from(
    "POST / HTTP/1.1\r\n" +
      "Host: example.com\r\n" +
      "Transfer-Encoding: gzip, chunked\r\n" +
      "\r\n" +
      "5\r\nhello\r\n" +
      "0\r\n\r\n"
  );

  assert.throws(
    () => (backend as any).parseHttpRequest(buf),
    (err: unknown) => err instanceof HttpRequestBlockedError && err.status === 501
  );
});

test("qemu-net: parseHttpRequest errors on invalid content-length (does not hang)", () => {
  const backend = makeBackend({ maxHttpBodyBytes: 1024 });

  const buf = Buffer.from(
    "POST / HTTP/1.1\r\n" +
      "Host: example.com\r\n" +
      "Content-Length: nope\r\n" +
      "\r\n" +
      "hello"
  );

  assert.throws(() => (backend as any).parseHttpRequest(buf));
});

test("qemu-net: parseHttpRequest rejects oversized headers without terminator (fail fast)", () => {
  const backend = makeBackend({ maxHttpBodyBytes: 1024 });

  const huge = "GET / HTTP/1.1\r\n" + "X: " + "a".repeat(70_000);

  assert.throws(
    () => (backend as any).parseHttpRequest(Buffer.from(huge, "latin1")),
    (err: unknown) => err instanceof HttpRequestBlockedError && err.status === 431
  );
});

test("qemu-net: stripHopByHopHeaders removes headers nominated by Connection", () => {
  const backend = makeBackend();
  const stripped = (backend as any).stripHopByHopHeaders({
    host: "example.com",
    connection: "x-foo, keep-alive",
    "keep-alive": "timeout=5",
    "x-foo": "bar",
    "x-ok": "1",
  });

  assert.ok(!("x-foo" in stripped));
  assert.ok(!("connection" in stripped));
  assert.ok(!("keep-alive" in stripped));
  assert.equal(stripped["x-ok"], "1");
});

test("qemu-net: handleHttpDataWithWriter sends 100-continue when body is pending", async () => {
  const backend = makeBackend({ maxHttpBodyBytes: 1024 });

  const writes: Buffer[] = [];
  const session: any = { http: undefined };

  await (backend as any).handleHttpDataWithWriter(
    "key",
    session,
    Buffer.from(
      "POST / HTTP/1.1\r\n" +
        "Host: example.com\r\n" +
        "Expect: 100-continue\r\n" +
        "Content-Length: 5\r\n" +
        "\r\n"
    ),
    {
      scheme: "http",
      write: (chunk: Buffer) => writes.push(Buffer.from(chunk)),
      finish: () => {
        throw new Error("unexpected finish");
      },
    }
  );

  assert.ok(Buffer.concat(writes).toString("ascii").includes("100 Continue"));
});

test("qemu-net: handleHttpDataWithWriter sends 100-continue for supported chunked bodies", async () => {
  const backend = makeBackend({ maxHttpBodyBytes: 1024 });

  const writes: Buffer[] = [];
  const session: any = { http: undefined };

  await (backend as any).handleHttpDataWithWriter(
    "key",
    session,
    Buffer.from(
      "POST / HTTP/1.1\r\n" +
        "Host: example.com\r\n" +
        "Expect: 100-continue\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        "\r\n" +
        "1\r\n" +
        "h\r\n"
    ),
    {
      scheme: "http",
      write: (chunk: Buffer) => writes.push(Buffer.from(chunk)),
      finish: () => {
        throw new Error("unexpected finish");
      },
    }
  );

  assert.ok(Buffer.concat(writes).toString("ascii").includes("100 Continue"));
});

test("qemu-net: handleHttpDataWithWriter enforces MAX_HTTP_PIPELINE_BYTES for chunked requests", async () => {
  const backend = makeBackend({ maxHttpBodyBytes: 1024 });

  const writes: Buffer[] = [];
  const session: any = { http: undefined };
  let finished = false;

  const pipelineJunk = Buffer.alloc(__test.MAX_HTTP_PIPELINE_BYTES + 1, 0x61); // 'a'

  await (backend as any).handleHttpDataWithWriter(
    "key",
    session,
    Buffer.concat([
      Buffer.from(
        "POST / HTTP/1.1\r\n" +
          "Host: example.com\r\n" +
          "Transfer-Encoding: chunked\r\n" +
          "\r\n" +
          "0\r\n\r\n"
      ),
      pipelineJunk,
    ]),
    {
      scheme: "http",
      write: (chunk: Buffer) => writes.push(Buffer.from(chunk)),
      finish: () => {
        finished = true;
      },
    }
  );

  assert.ok(finished);
  assert.ok(session.http.closed);
  const output = Buffer.concat(writes).toString("ascii");
  assert.ok(output.includes("413 Payload Too Large"));
});

test("qemu-net: handleHttpDataWithWriter does not send 100-continue for unsupported transfer-encoding", async () => {
  const backend = makeBackend({ maxHttpBodyBytes: 1024 });

  const writes: Buffer[] = [];
  const session: any = { http: undefined };
  let finished = false;

  await (backend as any).handleHttpDataWithWriter(
    "key",
    session,
    Buffer.from(
      "POST / HTTP/1.1\r\n" +
        "Host: example.com\r\n" +
        "Expect: 100-continue\r\n" +
        "Transfer-Encoding: gzip\r\n" +
        "\r\n"
    ),
    {
      scheme: "http",
      write: (chunk: Buffer) => writes.push(Buffer.from(chunk)),
      finish: () => {
        finished = true;
      },
    }
  );

  assert.ok(finished);
  const output = Buffer.concat(writes).toString("ascii");
  assert.ok(!output.includes("100 Continue"));
  assert.ok(output.includes("501 Not Implemented"));
});

test("qemu-net: parseHttpRequest returns 417 for unsupported Expect tokens", () => {
  const backend = makeBackend({ maxHttpBodyBytes: 1024 });

  const buf = Buffer.from(
    "POST / HTTP/1.1\r\n" +
      "Host: example.com\r\n" +
      "Expect: bananas\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n"
  );

  assert.throws(
    () => (backend as any).parseHttpRequest(buf),
    (err: unknown) => err instanceof HttpRequestBlockedError && err.status === 417
  );
});

test("qemu-net: parseHttpRequest enforces maxHttpBodyBytes", () => {
  const backend = makeBackend({ maxHttpBodyBytes: 4 });
  const buf = Buffer.from(
    "POST / HTTP/1.1\r\n" +
      "Host: example.com\r\n" +
      "Content-Length: 5\r\n" +
      "\r\n" +
      "hello"
  );

  assert.throws(
    () => (backend as any).parseHttpRequest(buf),
    (err: unknown) => {
      assert.ok(err instanceof HttpRequestBlockedError);
      assert.equal(err.status, 413);
      return true;
    }
  );
});

test("qemu-net: fetchAndRespond follows redirects and rewrites POST->GET", async () => {
  const writes: Buffer[] = [];

  const calls: Array<{ url: string; init: any }> = [];
  const fetchMock = async (url: string, init: any) => {
    calls.push({ url, init });

    if (calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "/next" },
      });
    }

    // redirect should turn POST into GET and drop body + related headers
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    const headers = init.headers as Record<string, string>;
    assert.ok(!("content-length" in headers));
    assert.ok(!("content-type" in headers));
    assert.ok(!("transfer-encoding" in headers));

    return new Response("ok", {
      status: 200,
      headers: { "content-length": "2" },
    });
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    httpHooks: {
      isAllowed: () => true,
    },
  });

  // Avoid real DNS in ensureRequestAllowed()
  (backend as any).resolveHostname = async () => ({ address: "203.0.113.1", family: 4 });

  const request = {
    method: "POST",
    target: "/start",
    version: "HTTP/1.1",
    headers: {
      host: "example.com",
      "content-length": "5",
      "content-type": "text/plain",
    },
    body: Buffer.from("hello"),
  };

  await (backend as any).fetchAndRespond(request, "http", (chunk: Buffer) => {
    writes.push(Buffer.from(chunk));
  });

  assert.equal(calls.length, 2);
  const responseText = Buffer.concat(writes).toString("utf8");
  assert.match(responseText, /^HTTP\/1\.1 200 /);
  assert.match(responseText.toLowerCase(), /connection: close/);
  assert.ok(responseText.endsWith("ok"));
});

test("qemu-net: fetchAndRespond rejects OPTIONS * (asterisk-form)", async () => {
  const writes: Buffer[] = [];

  const fetchMock = async () => {
    throw new Error("fetch should not be called");
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    httpHooks: {
      isAllowed: () => true,
    },
  });

  const request = {
    method: "OPTIONS",
    target: "*",
    version: "HTTP/1.1",
    headers: { host: "example.com" },
    body: Buffer.alloc(0),
  };

  await (backend as any).fetchAndRespond(request, "http", (chunk: Buffer) => {
    writes.push(Buffer.from(chunk));
  });

  const responseText = Buffer.concat(writes).toString("utf8");
  assert.match(responseText, /^HTTP\/1\.1 501 /);
});

test("qemu-net: fetchAndRespond rejects websocket upgrade requests", async () => {
  const writes: Buffer[] = [];

  const fetchMock = async () => {
    throw new Error("fetch should not be called");
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    httpHooks: {
      isAllowed: () => true,
    },
  });

  const request = {
    method: "GET",
    target: "/",
    version: "HTTP/1.1",
    headers: {
      host: "example.com",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "x",
      "sec-websocket-version": "13",
    },
    body: Buffer.alloc(0),
  };

  await (backend as any).fetchAndRespond(request, "http", (chunk: Buffer) => {
    writes.push(Buffer.from(chunk));
  });

  const responseText = Buffer.concat(writes).toString("utf8");
  assert.match(responseText, /^HTTP\/1\.1 501 /);
});

test("qemu-net: fetchAndRespond suppresses body for HEAD responses", async () => {
  const writes: Buffer[] = [];

  const fetchMock = async () => {
    return new Response("ok", {
      status: 200,
      headers: { "content-length": "2" },
    });
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    httpHooks: {
      isAllowed: () => true,
    },
  });
  (backend as any).resolveHostname = async () => ({ address: "203.0.113.3", family: 4 });

  const request = {
    method: "HEAD",
    target: "/",
    version: "HTTP/1.1",
    headers: { host: "example.com" },
    body: Buffer.alloc(0),
  };

  await (backend as any).fetchAndRespond(request, "http", (chunk: Buffer) => {
    writes.push(Buffer.from(chunk));
  });

  const raw = Buffer.concat(writes).toString("utf8");
  assert.match(raw, /^HTTP\/1\.1 200 /);
  assert.match(raw.toLowerCase(), /content-length: 2/);
  const headerEnd = raw.indexOf("\r\n\r\n");
  assert.notEqual(headerEnd, -1);
  assert.equal(raw.slice(headerEnd + 4), "");
});

test("qemu-net: fetchAndRespond suppresses body for 204 (forces content-length: 0)", async () => {
  const writes: Buffer[] = [];

  const fetchMock = async () => {
    return new Response(null, {
      status: 204,
    });
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    httpHooks: {
      isAllowed: () => true,
    },
  });
  (backend as any).resolveHostname = async () => ({ address: "203.0.113.4", family: 4 });

  const request = {
    method: "GET",
    target: "/",
    version: "HTTP/1.1",
    headers: { host: "example.com" },
    body: Buffer.alloc(0),
  };

  await (backend as any).fetchAndRespond(request, "http", (chunk: Buffer) => {
    writes.push(Buffer.from(chunk));
  });

  const raw = Buffer.concat(writes).toString("utf8");
  assert.match(raw, /^HTTP\/1\.1 204 /);
  assert.match(raw.toLowerCase(), /content-length: 0/);
  const headerEnd = raw.indexOf("\r\n\r\n");
  assert.notEqual(headerEnd, -1);
  assert.equal(raw.slice(headerEnd + 4), "");
});

test("qemu-net: fetchAndRespond suppresses body for 304 (forces content-length: 0)", async () => {
  const writes: Buffer[] = [];

  const fetchMock = async () => {
    return new Response(null, {
      status: 304,
    });
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    httpHooks: {
      isAllowed: () => true,
    },
  });
  (backend as any).resolveHostname = async () => ({ address: "203.0.113.5", family: 4 });

  const request = {
    method: "GET",
    target: "/",
    version: "HTTP/1.1",
    headers: { host: "example.com" },
    body: Buffer.alloc(0),
  };

  await (backend as any).fetchAndRespond(request, "http", (chunk: Buffer) => {
    writes.push(Buffer.from(chunk));
  });

  const raw = Buffer.concat(writes).toString("utf8");
  assert.match(raw, /^HTTP\/1\.1 304 /);
  assert.match(raw.toLowerCase(), /content-length: 0/);
  const headerEnd = raw.indexOf("\r\n\r\n");
  assert.notEqual(headerEnd, -1);
  assert.equal(raw.slice(headerEnd + 4), "");
});

test("qemu-net: fetchAndRespond streams chunked body when length unknown/encoded", async () => {
  const writes: Buffer[] = [];

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("one"));
      controller.enqueue(new TextEncoder().encode("two"));
      controller.close();
    },
  });

  const fetchMock = async () => {
    return new Response(body, {
      status: 200,
      statusText: "OK",
      headers: {
        // triggers the chunked streaming path and header stripping
        "content-encoding": "gzip",
      },
    });
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    httpHooks: {
      isAllowed: () => true,
    },
  });
  (backend as any).resolveHostname = async () => ({ address: "203.0.113.2", family: 4 });

  const request = {
    method: "GET",
    target: "/",
    version: "HTTP/1.1",
    headers: { host: "example.com" },
    body: Buffer.alloc(0),
  };

  await (backend as any).fetchAndRespond(request, "http", (chunk: Buffer) => {
    writes.push(Buffer.from(chunk));
  });

  const raw = Buffer.concat(writes).toString("utf8");
  const headerEnd = raw.indexOf("\r\n\r\n");
  assert.notEqual(headerEnd, -1);
  const head = raw.slice(0, headerEnd);
  const bodyText = raw.slice(headerEnd + 4);

  assert.match(head.toLowerCase(), /transfer-encoding: chunked/);
  assert.ok(!head.toLowerCase().includes("content-encoding"));

  // should contain the chunked encoding frames
  assert.ok(bodyText.includes("3\r\none\r\n"));
  assert.ok(bodyText.includes("3\r\ntwo\r\n"));
  assert.ok(bodyText.includes("0\r\n\r\n"));
});

test("qemu-net: fetchAndRespond preserves multiple Set-Cookie headers", async () => {
  const writes: Buffer[] = [];

  const fetchMock = async () => {
    return new Response("ok", {
      status: 200,
      statusText: "OK",
      headers: [
        ["content-length", "2"],
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ],
    });
  };

  let sawHook = false;

  const backend = makeBackend({
    fetch: fetchMock as any,
    httpHooks: {
      isAllowed: () => true,
      onResponse: async (resp) => {
        sawHook = true;
        assert.ok(Array.isArray(resp.headers["set-cookie"]));
        assert.deepEqual(resp.headers["set-cookie"], ["a=1", "b=2"]);
        return resp;
      },
    },
  });
  (backend as any).resolveHostname = async () => ({ address: "203.0.113.21", family: 4 });

  const request = {
    method: "GET",
    target: "/",
    version: "HTTP/1.1",
    headers: { host: "example.com" },
    body: Buffer.alloc(0),
  };

  await (backend as any).fetchAndRespond(request, "http", (chunk: Buffer) => {
    writes.push(Buffer.from(chunk));
  });

  assert.equal(sawHook, true);

  const raw = Buffer.concat(writes).toString("utf8");
  const headerEnd = raw.indexOf("\r\n\r\n");
  assert.notEqual(headerEnd, -1);
  const head = raw.slice(0, headerEnd).toLowerCase();

  // must be emitted as two separate header lines (not a single comma-joined value)
  assert.ok(head.includes("\r\nset-cookie: a=1\r\n"));
  assert.ok(head.includes("\r\nset-cookie: b=2\r\n"));
});

test("qemu-net: fetchAndRespond handles HTTP/1.0 clients correctly (no chunked)", async () => {
  const writes: Buffer[] = [];

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("one"));
      controller.enqueue(new TextEncoder().encode("two"));
      controller.close();
    },
  });

  const fetchMock = async () => {
    return new Response(body, {
      status: 200,
      statusText: "OK",
      headers: {
        // triggers the unknown-length/encoded streaming path
        "content-encoding": "gzip",
      },
    });
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    httpHooks: {
      isAllowed: () => true,
    },
  });
  (backend as any).resolveHostname = async () => ({ address: "203.0.113.20", family: 4 });

  const request = {
    method: "GET",
    target: "/",
    version: "HTTP/1.0",
    headers: { host: "example.com" },
    body: Buffer.alloc(0),
  };

  await (backend as any).fetchAndRespond(request, "http", (chunk: Buffer) => {
    writes.push(Buffer.from(chunk));
  });

  const raw = Buffer.concat(writes).toString("utf8");
  const headerEnd = raw.indexOf("\r\n\r\n");
  assert.notEqual(headerEnd, -1);

  const head = raw.slice(0, headerEnd);
  const bodyText = raw.slice(headerEnd + 4);

  assert.match(raw, /^HTTP\/1\.0 200 /);
  assert.ok(!head.toLowerCase().includes("transfer-encoding"));
  assert.ok(!head.toLowerCase().includes("content-encoding"));
  assert.equal(bodyText, "onetwo");
});

test("qemu-net: fetchAndRespond enforces maxHttpResponseBodyBytes when buffering for onResponse (known length)", async () => {
  let cancelled = false;
  let hookCalls = 0;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hello"));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });

  const fetchMock = async () => {
    return new Response(body, {
      status: 200,
      headers: { "content-length": "5" },
    });
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    maxHttpResponseBodyBytes: 4,
    httpHooks: {
      isAllowed: () => true,
      onResponse: async (resp) => {
        hookCalls += 1;
        return resp;
      },
    },
  });
  (backend as any).resolveHostname = async () => ({ address: "203.0.113.10", family: 4 });

  const request = {
    method: "GET",
    target: "/",
    version: "HTTP/1.1",
    headers: { host: "example.com" },
    body: Buffer.alloc(0),
  };

  await assert.rejects(
    () => (backend as any).fetchAndRespond(request, "http", () => {}),
    (err: unknown) => err instanceof HttpRequestBlockedError && err.status === 502
  );

  assert.equal(hookCalls, 0);
  assert.equal(cancelled, true);
});

test("qemu-net: fetchAndRespond enforces maxHttpResponseBodyBytes when buffering for onResponse (encoded/unknown length)", async () => {
  let cancelled = false;
  let hookCalls = 0;

  let step = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (step === 0) {
        step += 1;
        controller.enqueue(new TextEncoder().encode("he"));
        return;
      }
      if (step === 1) {
        step += 1;
        // Keep the stream open so cancellation is observable.
        controller.enqueue(new TextEncoder().encode("llo"));
        return;
      }
      // If the implementation failed to cancel, we would keep producing data.
      controller.enqueue(new TextEncoder().encode("more"));
    },
    cancel() {
      cancelled = true;
    },
  });

  const fetchMock = async () => {
    return new Response(body, {
      status: 200,
      headers: {
        // triggers the content-encoding stripping path; we still buffer due to onResponse.
        "content-encoding": "gzip",
      },
    });
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    maxHttpResponseBodyBytes: 4,
    httpHooks: {
      isAllowed: () => true,
      onResponse: async (resp) => {
        hookCalls += 1;
        return resp;
      },
    },
  });
  (backend as any).resolveHostname = async () => ({ address: "203.0.113.11", family: 4 });

  const request = {
    method: "GET",
    target: "/",
    version: "HTTP/1.1",
    headers: { host: "example.com" },
    body: Buffer.alloc(0),
  };

  await assert.rejects(
    () => (backend as any).fetchAndRespond(request, "http", () => {}),
    (err: unknown) => err instanceof HttpRequestBlockedError && err.status === 502
  );

  assert.equal(hookCalls, 0);
  assert.equal(cancelled, true);
});

test("qemu-net: createLookupGuard filters DNS results via isAllowed", async () => {
  // Fake DNS returns a private + public address when `all: true`, but only
  // a private address for the single-result lookup.
  const lookupMock = (
    _hostname: string,
    options: any,
    cb: (err: any, address: any, family?: number) => void
  ) => {
    if (options?.all) {
      cb(null, [
        { address: "127.0.0.1", family: 4 },
        { address: "93.184.216.34", family: 4 },
      ]);
      return;
    }
    cb(null, "127.0.0.1", 4);
  };

  const isAllowed = async (info: any) => info.ip !== "127.0.0.1";
  const guarded = __test.createLookupGuard(
    { hostname: "example.com", port: 443, protocol: "https" },
    isAllowed,
    lookupMock as any
  );

  // all:false should fail if the single address is blocked.
  await assert.rejects(
    () =>
      new Promise<void>((resolve, reject) => {
        guarded("example.com", { family: 4 }, (err) => {
          if (err) return reject(err);
          resolve();
        });
      }),
    (err: unknown) => err instanceof HttpRequestBlockedError
  );

  // all:true should return only allowed entries
  const all = await new Promise<any[]>((resolve, reject) => {
    guarded("example.com", { all: true }, (err, address) => {
      if (err) return reject(err);
      resolve(address as any[]);
    });
  });
  assert.deepEqual(all, [{ address: "93.184.216.34", family: 4 }]);
});

test("qemu-net: TLS MITM generates leaf certificates per host", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-mitm-test-"));
  try {
    const backend = makeBackend({ mitmCertDir: dir });

    const ctx1 = await (backend as any).getTlsContextAsync("example.com");
    assert.ok(ctx1);

    const hostsDir = path.join(dir, "hosts");
    assert.ok(fs.existsSync(hostsDir));

    const files1 = fs.readdirSync(hostsDir).filter((f) => f.endsWith(".crt") || f.endsWith(".key"));
    assert.ok(files1.some((f) => f.endsWith(".crt")));
    assert.ok(files1.some((f) => f.endsWith(".key")));

    // Parse the generated leaf cert and validate SAN contains the hostname.
    const crtPath = path.join(hostsDir, files1.find((f) => f.endsWith(".crt"))!);
    const certPem = fs.readFileSync(crtPath, "utf8");
    const cert = forge.pki.certificateFromPem(certPem);
    const san = cert.getExtension("subjectAltName") as any;
    assert.ok(san);
    assert.ok(
      (san.altNames ?? []).some((n: any) => n.type === 2 && n.value === "example.com"),
      "expected DNS subjectAltName for example.com"
    );

    // Calling again should reuse cached context and not create new files.
    const ctx2 = await (backend as any).getTlsContextAsync("example.com");
    assert.ok(ctx2);
    const files2 = fs.readdirSync(hostsDir).filter((f) => f.endsWith(".crt") || f.endsWith(".key"));
    assert.deepEqual(files2.sort(), files1.sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("qemu-net: tls context cache enforces max entries (LRU)", async () => {
  const backend = makeBackend({
    // keep it tiny for the test
    tlsContextCacheMaxEntries: 3,
    tlsContextCacheTtlMs: 60_000,
  });

  // Avoid slow leaf cert generation; we're only testing eviction logic.
  let created = 0;
  (backend as any).createTlsContext = async (_servername: string) => {
    created += 1;
    return tls.createSecureContext({});
  };

  await (backend as any).getTlsContextAsync("a.example");
  await (backend as any).getTlsContextAsync("b.example");
  await (backend as any).getTlsContextAsync("c.example");

  assert.equal((backend as any).tlsContexts.size, 3);

  // Touch b to make it most-recently-used, then insert d and ensure a is evicted.
  await (backend as any).getTlsContextAsync("b.example");
  await (backend as any).getTlsContextAsync("d.example");

  const keys = Array.from((backend as any).tlsContexts.keys());
  assert.equal(keys.length, 3);
  assert.ok(!keys.includes("a.example"));
  assert.ok(keys.includes("b.example"));
  assert.ok(keys.includes("c.example"));
  assert.ok(keys.includes("d.example"));

  // Should have created contexts for a,b,c,d (touching b is cached)
  assert.equal(created, 4);
});

test("qemu-net: tls context cache ttl does not immediately expire slow-to-create entries", async () => {
  const backend = makeBackend({
    tlsContextCacheMaxEntries: 100,
    // Keep this comfortably larger than the immediate follow-up access to avoid timing flakes.
    tlsContextCacheTtlMs: 100,
  });

  // Simulate a slow context creation that takes longer than the TTL.
  let created = 0;
  (backend as any).createTlsContext = async (_servername: string) => {
    created += 1;
    await new Promise((r) => setTimeout(r, 150));
    return tls.createSecureContext({});
  };

  await (backend as any).getTlsContextAsync("slow.example");
  assert.equal(created, 1);

  // Immediate follow-up access should still hit the cache.
  await (backend as any).getTlsContextAsync("slow.example");
  assert.equal(created, 1);
});

test("qemu-net: tls context cache enforces ttl", async () => {
  const backend = makeBackend({
    tlsContextCacheMaxEntries: 100,
    tlsContextCacheTtlMs: 50,
  });

  let created = 0;
  (backend as any).createTlsContext = async (_servername: string) => {
    created += 1;
    return tls.createSecureContext({});
  };

  await (backend as any).getTlsContextAsync("ttl.example");
  assert.equal(created, 1);

  // Let the entry expire.
  await new Promise((r) => setTimeout(r, 80));

  await (backend as any).getTlsContextAsync("ttl.example");
  assert.equal(created, 2);
});

test("qemu-net: tls context cache ttl <= 0 disables caching", async () => {
  const backend = makeBackend({
    tlsContextCacheMaxEntries: 100,
    tlsContextCacheTtlMs: 0,
  });

  let created = 0;
  (backend as any).createTlsContext = async (_servername: string) => {
    created += 1;
    return tls.createSecureContext({});
  };

  await (backend as any).getTlsContextAsync("a.example");
  await (backend as any).getTlsContextAsync("a.example");
  assert.equal(created, 2);

  await (backend as any).getTlsContextAsync("b.example");
  assert.equal(created, 3);

  // Cache is cleared on each access, so it can't accumulate entries.
  assert.equal((backend as any).tlsContexts.size, 1);
});

test("qemu-net: caps guest->upstream pendingWrites and aborts on overflow", () => {
  const backend = makeBackend({ maxTcpPendingWriteBytes: 16 });

  // Avoid trying to connect a real TCP socket.
  (backend as any).ensureTcpSocket = () => {};

  const stackCalls: any[] = [];
  (backend as any).stack = {
    handleTcpError: (msg: any) => stackCalls.push(msg),
  };

  const key = "TCP:1.2.3.4:111:5.6.7.8:222";
  (backend as any).tcpSessions.set(key, {
    socket: null,
    srcIP: "1.2.3.4",
    srcPort: 111,
    dstIP: "5.6.7.8",
    dstPort: 222,
    connectIP: "5.6.7.8",
    flowControlPaused: false,
    protocol: null,
    connected: false,
    pendingWrites: [],
    pendingWriteBytes: 0,
  });

  // 32 bytes > cap (16) triggers abort.
  (backend as any).handleTcpSend({ key, data: Buffer.alloc(32) });

  assert.equal(stackCalls.length, 1);
  assert.deepEqual(stackCalls[0], { key });
  assert.equal((backend as any).tcpSessions.has(key), false);
});

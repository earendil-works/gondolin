import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";

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

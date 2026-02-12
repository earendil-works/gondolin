import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import tls from "node:tls";
import net from "node:net";

import forge from "node-forge";

import { HttpRequestBlockedError, QemuNetworkBackend, __test } from "../src/qemu-net";
import { EventEmitter } from "node:events";

function makeBackend(options?: Partial<ConstructorParameters<typeof QemuNetworkBackend>[0]>) {
  return new QemuNetworkBackend({
    socketPath: path.join(
      os.tmpdir(),
      `gondolin-net-test-${process.pid}-${crypto.randomUUID()}.sock`
    ),
    ...options,
  });
}

test("qemu-net: trusted dns mode requires ipv4 resolvers (no silent fallback)", () => {
  assert.throws(
    () => makeBackend({ dns: { mode: "trusted", trustedServers: ["::1"] } as any }),
    /requires at least one IPv4 resolver/i
  );
});

function buildDnsQueryA(name: string, id = 0x1234): Buffer {
  const labels = name.split(".").filter(Boolean);
  const qnameParts: Buffer[] = [];
  for (const label of labels) {
    const b = Buffer.from(label, "ascii");
    qnameParts.push(Buffer.from([b.length]));
    qnameParts.push(b);
  }
  qnameParts.push(Buffer.from([0]));
  const qname = Buffer.concat(qnameParts);

  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0); // A
  tail.writeUInt16BE(1, 2); // IN

  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // RD
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  return Buffer.concat([header, qname, tail]);
}

function runSyntheticDns(backend: QemuNetworkBackend, payload: Buffer): Buffer {
  let response: Buffer | null = null;
  (backend as any).stack = {
    handleUdpResponse: (message: { data: Buffer }) => {
      response = Buffer.from(message.data);
    },
  };

  (backend as any).handleUdpSend({
    key: "dns",
    srcIP: "192.168.127.2",
    srcPort: 55555,
    dstIP: "192.168.127.1",
    dstPort: 53,
    payload,
  });

  assert.ok(response, "expected synthetic dns response");
  return response;
}

test("qemu-net: synthetic per-host dns mapping does not throw on root query", () => {
  const backend = makeBackend({
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
  });

  const response = runSyntheticDns(backend, buildDnsQueryA("."));
  assert.equal(response.readUInt16BE(6), 1); // ANCOUNT
  assert.deepEqual([...response.subarray(response.length - 4)], [192, 0, 2, 1]);
});

test("qemu-net: synthetic per-host dns mapping does not throw on mapping exhaustion", () => {
  const backend = makeBackend({
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
  });

  const hostMap = (backend as any).syntheticDnsHostMap;
  assert.ok(hostMap);
  // Force the allocator into an exhausted state without allocating ~65k entries.
  hostMap.nextHostId = 65024 + 1;

  const response = runSyntheticDns(backend, buildDnsQueryA("example.com", 0x9999));
  assert.equal(response.readUInt16BE(0), 0x9999);
  assert.equal(response.readUInt16BE(6), 1); // ANCOUNT
  assert.deepEqual([...response.subarray(response.length - 4)], [192, 0, 2, 1]);
});

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

test("qemu-net: stripHopByHopHeadersForWebSocket strips connection-nominated headers", () => {
  const backend = makeBackend();

  const stripped = (backend as any).stripHopByHopHeadersForWebSocket({
    host: "example.com",
    connection: "Upgrade, x-foo, sec-websocket-key",
    upgrade: "websocket",
    "sec-websocket-key": "x",
    "sec-websocket-version": "13",
    "x-foo": "bar",
    "keep-alive": "timeout=5",
  });

  assert.ok(!("x-foo" in stripped));
  assert.ok(!("keep-alive" in stripped));
  assert.equal(stripped.host, "example.com");
  assert.equal(stripped.connection, "Upgrade, x-foo, sec-websocket-key");
  assert.equal(stripped.upgrade, "websocket");
  assert.equal(stripped["sec-websocket-key"], "x");
  assert.equal(stripped["sec-websocket-version"], "13");
});

test("qemu-net: resolveHostname picks first allowed DNS answer", async () => {
  const backend = makeBackend({
    httpHooks: {
      isIpAllowed: ({ ip }) => ip === "127.0.0.1",
    },
    dnsLookup: (
      _hostname,
      _options,
      cb: (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void
    ) => {
      cb(null, [
        { address: "10.0.0.1", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
    },
  });

  const resolved = await (backend as any).resolveHostname("example.com", {
    protocol: "http",
    port: 80,
  });

  assert.equal(resolved.address, "127.0.0.1");
  assert.equal(resolved.family, 4);
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

test("qemu-net: fetchAndRespond enforces request policy hook", async () => {
  let fetchCalls = 0;

  const fetchMock = async () => {
    fetchCalls += 1;
    return new Response("ok", {
      status: 200,
      headers: { "content-length": "2" },
    });
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    httpHooks: {
      isRequestAllowed: (request) => request.method !== "DELETE",
      isIpAllowed: () => true,
    },
  });

  (backend as any).resolveHostname = async () => ({ address: "203.0.113.1", family: 4 });

  const request = {
    method: "DELETE",
    target: "/resource",
    version: "HTTP/1.1",
    headers: {
      host: "example.com",
    },
    body: Buffer.alloc(0),
  };

  await assert.rejects(
    () => (backend as any).fetchAndRespond(request, "http", () => {}),
    (err: unknown) => err instanceof HttpRequestBlockedError && err.status === 403
  );
  assert.equal(fetchCalls, 0);
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
      isIpAllowed: () => true,
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

test("qemu-net: fetchAndRespond drops auth headers on cross-origin redirects", async () => {
  const calls: Array<{ url: string; init: any }> = [];

  const fetchMock = async (url: string, init: any) => {
    calls.push({ url, init });

    if (calls.length === 1) {
      return new Response(null, {
        status: 307,
        headers: { location: "https://storage.example.net/blob" },
      });
    }

    const headers = init.headers as Record<string, string>;
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);

    return new Response("ok", {
      status: 200,
      headers: { "content-length": "2" },
    });
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    httpHooks: {
      isIpAllowed: () => true,
    },
  });

  // Avoid real DNS in ensureRequestAllowed()
  (backend as any).resolveHostname = async () => ({ address: "203.0.113.1", family: 4 });

  const request = {
    method: "GET",
    target: "/start",
    version: "HTTP/1.1",
    headers: {
      host: "registry.example.com",
      authorization: "Bearer token",
      cookie: "session=secret",
    },
    body: Buffer.alloc(0),
  };

  await (backend as any).fetchAndRespond(request, "https", () => {});

  assert.equal(calls.length, 2);
});

test("qemu-net: fetchAndRespond rejects OPTIONS * (asterisk-form)", async () => {
  const writes: Buffer[] = [];

  const fetchMock = async () => {
    throw new Error("fetch should not be called");
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    httpHooks: {
      isIpAllowed: () => true,
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
      isIpAllowed: () => true,
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

test("qemu-net: websocket upgrades are tunneled when enabled", async () => {
  const serverSockets: net.Socket[] = [];
  const server = net.createServer((sock) => {
    serverSockets.push(sock);

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

        // Initial server data
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");

  const port = addr.port;

  const backend = makeBackend({
    httpHooks: {
      isIpAllowed: () => true,
    },
    allowWebSockets: true,
  });

  // Pin example.com to localhost for the test.
  (backend as any).resolveHostname = async () => ({ address: "127.0.0.1", family: 4 });

  const key = "TCP:1.1.1.1:1234:2.2.2.2:80";
  const session: any = {
    socket: null,
    srcIP: "1.1.1.1",
    srcPort: 1234,
    dstIP: "2.2.2.2",
    dstPort: 80,
    connectIP: "2.2.2.2",
    flowControlPaused: false,
    protocol: "http",
    connected: false,
    pendingWrites: [],
    pendingWriteBytes: 0,
  };

  (backend as any).tcpSessions.set(key, session);

  const writes: Buffer[] = [];

  const req = Buffer.from(
    "GET /chat HTTP/1.1\r\n" +
      `Host: example.com:${port}\r\n` +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Key: x\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "\r\n" +
      "hello"
  );

  // Call the internal HTTP handler directly with a custom writer.
  await (backend as any).handleHttpDataWithWriter(key, session, req, {
    scheme: "http",
    write: (chunk: Buffer) => writes.push(Buffer.from(chunk)),
    finish: () => {
      // ignored for this test
    },
  });

  // Send a post-upgrade frame.
  await new Promise((r) => setTimeout(r, 50));
  await (backend as any).handlePlainHttpData(key, session, Buffer.from("ping"));

  await new Promise((r) => setTimeout(r, 50));

  const out = Buffer.concat(writes).toString("utf8");
  assert.match(out, /^HTTP\/1\.1 101 /);
  assert.ok(out.includes("welcome"));
  assert.ok(out.includes("echo:hello"));
  assert.ok(out.includes("echo:ping"));

  // Ensure we don't keep open sockets/servers alive across the full test suite.
  try {
    await backend.close();
  } catch {
    // ignore
  }

  for (const s of serverSockets) {
    try {
      s.destroy();
    } catch {
      // ignore
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("qemu-net: websocket upstream connect timeout covers stalled tls handshake", async () => {
  const serverSockets: net.Socket[] = [];
  const server = net.createServer((sock) => {
    serverSockets.push(sock);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");

    const backend = makeBackend({
      webSocketUpstreamConnectTimeoutMs: 50,
    });

    await assert.rejects(
      () =>
        (backend as any).connectWebSocketUpstream({
          protocol: "https",
          hostname: "example.com",
          address: "127.0.0.1",
          port: addr.port,
        }),
      /websocket upstream connect timeout/i
    );
  } finally {
    for (const s of serverSockets) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("qemu-net: websocket upstream header read times out", async () => {
  const serverSockets: net.Socket[] = [];
  const server = net.createServer((sock) => {
    serverSockets.push(sock);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  let socket: net.Socket | null = null;

  try {
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");

    const backend = makeBackend({
      webSocketUpstreamHeaderTimeoutMs: 50,
    });

    socket = net.connect(addr.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket!.once("connect", () => resolve());
      socket!.once("error", reject);
    });

    await assert.rejects(
      () => (backend as any).readUpstreamHttpResponseHead(socket as net.Socket),
      /websocket upstream header timeout/i
    );
  } finally {
    try {
      socket?.destroy();
    } catch {
      // ignore
    }

    for (const s of serverSockets) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
      isIpAllowed: () => true,
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
      isIpAllowed: () => true,
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
      isIpAllowed: () => true,
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
      isIpAllowed: () => true,
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
      isIpAllowed: () => true,
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
      isIpAllowed: () => true,
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
      isIpAllowed: () => true,
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
      isIpAllowed: () => true,
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

test("qemu-net: createLookupGuard filters DNS results via isIpAllowed", async () => {
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

  const isIpAllowed = async (info: any) => info.ip !== "127.0.0.1";
  const guarded = __test.createLookupGuard(
    { hostname: "example.com", port: 443, protocol: "https" },
    isIpAllowed,
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

test("qemu-net: regenerates stale leaf certs after CA rotation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-mitm-rotate-test-"));
  try {
    const host = "rotate.example";

    const backend1 = makeBackend({ mitmCertDir: dir });
    await (backend1 as any).getTlsContextAsync(host);

    const hostsDir = path.join(dir, "hosts");
    const crtPath = path.join(hostsDir, fs.readdirSync(hostsDir).find((f) => f.endsWith(".crt"))!);
    const certPemBefore = fs.readFileSync(crtPath, "utf8");

    // Rotate the CA material while keeping cached host certs around.
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    const now = new Date(Date.now() - 5 * 60 * 1000);
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(now);
    cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + 3650);
    const attrs = [{ name: "commonName", value: "gondolin-mitm-ca" }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: "basicConstraints", cA: true, critical: true },
      {
        name: "keyUsage",
        keyCertSign: true,
        cRLSign: true,
        critical: true,
      },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    fs.writeFileSync(path.join(dir, "ca.key"), forge.pki.privateKeyToPem(keys.privateKey));
    fs.writeFileSync(path.join(dir, "ca.crt"), forge.pki.certificateToPem(cert));

    const backend2 = makeBackend({ mitmCertDir: dir });
    await (backend2 as any).getTlsContextAsync(host);

    const certPemAfter = fs.readFileSync(crtPath, "utf8");
    assert.notEqual(certPemAfter, certPemBefore);

    const rotatedCa = forge.pki.certificateFromPem(fs.readFileSync(path.join(dir, "ca.crt"), "utf8"));
    const rotatedLeaf = forge.pki.certificateFromPem(certPemAfter);
    assert.equal(rotatedCa.verify(rotatedLeaf), true);
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

function buildQueryA(name: string, id = 0x1234): Buffer {
  const labels = name.split(".").filter(Boolean);
  const qnameParts: Buffer[] = [];
  for (const label of labels) {
    const b = Buffer.from(label, "ascii");
    qnameParts.push(Buffer.from([b.length]));
    qnameParts.push(b);
  }
  qnameParts.push(Buffer.from([0]));
  const qname = Buffer.concat(qnameParts);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // RD
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0); // A
  tail.writeUInt16BE(1, 2); // IN

  return Buffer.concat([header, qname, tail]);
}

class FakeUdpSocket extends EventEmitter {
  lastSend: { buf: Buffer; port: number; address: string } | null = null;

  send(buf: Buffer, port: number, address: string) {
    this.lastSend = { buf: Buffer.from(buf), port, address };
  }

  close() {
    // no-op
  }
}

test("qemu-net: dns trusted mode rewrites upstream resolver and preserves guest dst ip", () => {
  const fake = new FakeUdpSocket();
  const backend = makeBackend({
    dns: { mode: "trusted", trustedServers: ["1.1.1.1"] },
    udpSocketFactory: () => fake as any,
  });

  const responses: any[] = [];
  (backend as any).stack = {
    handleUdpResponse: (msg: any) => responses.push(msg),
  };

  const payload = buildQueryA("example.com", 0x1111);

  (backend as any).handleUdpSend({
    key: "udp1",
    srcIP: "192.168.127.3",
    srcPort: 40000,
    dstIP: "9.9.9.9",
    dstPort: 53,
    payload,
  });

  assert.ok(fake.lastSend);
  assert.equal(fake.lastSend.address, "1.1.1.1");
  assert.equal(fake.lastSend.port, 53);

  fake.emit("message", Buffer.from([0, 1, 2, 3]), { address: "1.1.1.1", port: 53 });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].dstIP, "9.9.9.9");
  assert.equal(responses[0].dstPort, 53);
});

test("qemu-net: dns synthetic mode replies without opening udp socket", () => {
  let created = 0;
  const backend = makeBackend({
    dns: { mode: "synthetic" },
    udpSocketFactory: () => {
      created += 1;
      return new FakeUdpSocket() as any;
    },
  });

  const responses: any[] = [];
  (backend as any).stack = {
    handleUdpResponse: (msg: any) => responses.push(msg),
  };

  const payload = buildQueryA("example.com", 0x2222);

  (backend as any).handleUdpSend({
    key: "udp2",
    srcIP: "192.168.127.3",
    srcPort: 40001,
    dstIP: "192.168.127.1",
    dstPort: 53,
    payload,
  });

  assert.equal(created, 0);
  assert.equal(responses.length, 1);

  const response = responses[0].data as Buffer;
  assert.equal(response.readUInt16BE(0), 0x2222);
  assert.equal(response.readUInt16BE(6), 1); // ANCOUNT
  assert.deepEqual([...response.subarray(response.length - 4)], [192, 0, 2, 1]);
});

test("qemu-net: dns synthetic per-host mapping assigns stable unique IPv4 addresses", () => {
  const backend = makeBackend({
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
  });

  const responses: any[] = [];
  (backend as any).stack = {
    handleUdpResponse: (msg: any) => responses.push(msg),
  };

  const sendQuery = (name: string, id: number) => {
    (backend as any).handleUdpSend({
      key: `udp-${id}`,
      srcIP: "192.168.127.3",
      srcPort: 40000 + id,
      dstIP: "192.168.127.1",
      dstPort: 53,
      payload: buildQueryA(name, id),
    });
    const response = responses[responses.length - 1]?.data as Buffer;
    const parts = [...response.subarray(response.length - 4)];
    return `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`;
  };

  const exampleIp = sendQuery("example.com", 0x3001);
  const githubIp = sendQuery("github.com", 0x3002);
  const exampleIpAgain = sendQuery("example.com", 0x3003);

  assert.equal(exampleIpAgain, exampleIp);
  assert.notEqual(exampleIp, githubIp);
  assert.ok(exampleIp.startsWith("198.19."));
  assert.ok(githubIp.startsWith("198.19."));
  assert.equal((backend as any).syntheticDnsHostMap.lookupHostByIp(exampleIp), "example.com");
  assert.equal((backend as any).syntheticDnsHostMap.lookupHostByIp(githubIp), "github.com");
});

test("qemu-net: ssh flows require allowlisted synthetic hostname", () => {
  const backend = makeBackend({
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
    ssh: { allowedHosts: ["github.com"] },
  });

  const responses: any[] = [];
  (backend as any).stack = {
    handleUdpResponse: (msg: any) => responses.push(msg),
    handleTcpConnected: () => {},
  };

  const resolveSynthetic = (name: string, id: number) => {
    (backend as any).handleUdpSend({
      key: `udp-${id}`,
      srcIP: "192.168.127.3",
      srcPort: 41000 + id,
      dstIP: "192.168.127.1",
      dstPort: 53,
      payload: buildQueryA(name, id),
    });
    const response = responses[responses.length - 1]?.data as Buffer;
    const parts = [...response.subarray(response.length - 4)];
    return `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`;
  };

  const githubIp = resolveSynthetic("github.com", 0x4001);
  const gitlabIp = resolveSynthetic("gitlab.com", 0x4002);

  (backend as any).handleTcpConnect({
    key: "tcp-github",
    srcIP: "192.168.127.3",
    srcPort: 50001,
    dstIP: githubIp,
    dstPort: 22,
  });
  assert.equal((backend as any).isSshFlowAllowed("tcp-github", githubIp, 22), true);
  assert.equal((backend as any).tcpSessions.get("tcp-github").connectIP, "github.com");

  (backend as any).handleTcpConnect({
    key: "tcp-gitlab",
    srcIP: "192.168.127.3",
    srcPort: 50002,
    dstIP: gitlabIp,
    dstPort: 22,
  });
  assert.equal((backend as any).isSshFlowAllowed("tcp-gitlab", gitlabIp, 22), false);
});

test("qemu-net: ssh egress auto-enables per-host synthetic mapping", () => {
  const backend = makeBackend({
    dns: { mode: "synthetic" },
    ssh: { allowedHosts: ["github.com"] },
  });
  assert.equal((backend as any).syntheticDnsHostMapping, "per-host");
});

test("qemu-net: ssh egress requires synthetic dns mode", () => {
  assert.throws(
    () =>
      makeBackend({
        dns: { mode: "trusted", trustedServers: ["1.1.1.1"] },
        ssh: { allowedHosts: ["github.com"] },
      }),
    /ssh egress requires dns mode 'synthetic'/i
  );
});

test("qemu-net: ssh egress rejects single synthetic host mapping", () => {
  assert.throws(
    () =>
      makeBackend({
        dns: { mode: "synthetic", syntheticHostMapping: "single" },
        ssh: { allowedHosts: ["github.com"] },
      }),
    /ssh egress requires dns syntheticHostMapping='per-host'/i
  );
});

test("qemu-net: ssh requireCredentials enforces credential presence", () => {
  assert.throws(
    () =>
      makeBackend({
        dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
        ssh: { allowedHosts: ["github.com"], requireCredentials: true },
      }),
    /requires at least one credential/i
  );

  const backend = makeBackend({
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
    ssh: {
      allowedHosts: ["github.com"],
      requireCredentials: true,
      credentials: {
        "github.com": {
          username: "git",
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nTEST\n-----END OPENSSH PRIVATE KEY-----",
        },
      },
    },
  });

  const responses: any[] = [];
  (backend as any).stack = {
    handleUdpResponse: (msg: any) => responses.push(msg),
    handleTcpConnected: () => {},
  };

  (backend as any).handleUdpSend({
    key: "udp-cred",
    srcIP: "192.168.127.3",
    srcPort: 42000,
    dstIP: "192.168.127.1",
    dstPort: 53,
    payload: buildQueryA("github.com", 0x4444),
  });

  const response = responses[0].data as Buffer;
  const parts = [...response.subarray(response.length - 4)];
  const githubIp = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`;

  (backend as any).handleTcpConnect({
    key: "tcp-cred",
    srcIP: "192.168.127.3",
    srcPort: 50003,
    dstIP: githubIp,
    dstPort: 22,
  });

  assert.equal((backend as any).isSshFlowAllowed("tcp-cred", githubIp, 22), true);
  assert.equal((backend as any).tcpSessions.get("tcp-cred").sshCredential.pattern, "github.com");
});

test("qemu-net: ssh requireCredentials allows ssh agent", () => {
  const backend = makeBackend({
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
    ssh: {
      allowedHosts: ["github.com"],
      requireCredentials: true,
      agent: "/tmp/fake-ssh-agent.sock",
    },
  });

  assert.ok(backend);
});

test("qemu-net: ssh flows with credentials use proxy path", () => {
  const backend = makeBackend({
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
    ssh: {
      allowedHosts: ["github.com"],
      credentials: {
        "github.com": {
          username: "git",
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nTEST\n-----END OPENSSH PRIVATE KEY-----",
        },
      },
    },
  });

  const session: any = {
    socket: null,
    srcIP: "192.168.127.3",
    srcPort: 50004,
    dstIP: "198.19.0.10",
    dstPort: 22,
    connectIP: "github.com",
    syntheticHostname: "github.com",
    sshCredential: {
      pattern: "github.com",
      username: "git",
      privateKey: "k",
    },
    sshProxyAuth: "credential",
    flowControlPaused: false,
    protocol: "ssh",
    connected: false,
    pendingWrites: [],
    pendingWriteBytes: 0,
  };

  (backend as any).tcpSessions.set("tcp-proxy", session);

  let usedProxy = 0;
  let usedSocket = 0;
  (backend as any).handleSshProxyData = () => {
    usedProxy += 1;
  };
  (backend as any).ensureTcpSocket = () => {
    usedSocket += 1;
  };

  (backend as any).handleTcpSend({ key: "tcp-proxy", data: Buffer.from("SSH-2.0-test\r\n", "ascii") });

  assert.equal(usedProxy, 1);
  assert.equal(usedSocket, 0);
});

test("qemu-net: ssh flows with agent use proxy path", () => {
  const backend = makeBackend({
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
    ssh: {
      allowedHosts: ["github.com"],
      agent: "/tmp/fake-ssh-agent.sock",
    },
  });

  const session: any = {
    socket: null,
    srcIP: "192.168.127.3",
    srcPort: 50005,
    dstIP: "198.19.0.11",
    dstPort: 22,
    connectIP: "github.com",
    syntheticHostname: "github.com",
    sshCredential: null,
    sshProxyAuth: "agent",
    flowControlPaused: false,
    protocol: "ssh",
    connected: false,
    pendingWrites: [],
    pendingWriteBytes: 0,
  };

  (backend as any).tcpSessions.set("tcp-proxy-agent", session);

  let usedProxy = 0;
  let usedSocket = 0;
  (backend as any).handleSshProxyData = () => {
    usedProxy += 1;
  };
  (backend as any).ensureTcpSocket = () => {
    usedSocket += 1;
  };

  (backend as any).handleTcpSend({
    key: "tcp-proxy-agent",
    data: Buffer.from("SSH-2.0-test\r\n", "ascii"),
  });

  assert.equal(usedProxy, 1);
  assert.equal(usedSocket, 0);
});

test("qemu-net: shared checked dispatcher is reused per origin", () => {
  const backend = makeBackend({
    httpHooks: {
      isIpAllowed: () => true,
    },
  });

  const one = (backend as any).getCheckedDispatcher({
    hostname: "example.com",
    port: 443,
    protocol: "https",
  });
  const two = (backend as any).getCheckedDispatcher({
    hostname: "example.com",
    port: 443,
    protocol: "https",
  });

  assert.ok(one);
  assert.equal(one, two);

  const three = (backend as any).getCheckedDispatcher({
    hostname: "example.org",
    port: 443,
    protocol: "https",
  });

  assert.ok(three);
  assert.notEqual(one, three);
  assert.equal((backend as any).sharedDispatchers.size, 2);

  (backend as any).closeSharedDispatchers();
  assert.equal((backend as any).sharedDispatchers.size, 0);
});

test("qemu-net: createLookupGuard invokes ip policy callback", async () => {
  const seen: string[] = [];

  const lookupMock = (
    _hostname: string,
    _options: any,
    cb: (err: any, address: any, family?: number) => void
  ) => cb(null, "93.184.216.34", 4);

  const guarded = __test.createLookupGuard(
    {
      hostname: "example.com",
      port: 443,
      protocol: "https",
    },
    async (info: any) => {
      seen.push(`${info.hostname}|${info.ip}|${info.protocol}|${info.port}`);
      return true;
    },
    lookupMock as any
  );

  await new Promise<void>((resolve, reject) => {
    guarded("example.com", { family: 4 }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  assert.deepEqual(seen, ["example.com|93.184.216.34|https|443"]);
});

test("qemu-net: http bridge limits concurrent upstream fetches", async () => {
  let active = 0;
  let maxActive = 0;

  let releaseBlockedFetches: (() => void) | null = null;
  const blockedFetches = new Promise<void>((resolve) => {
    releaseBlockedFetches = resolve;
  });

  const fetchMock = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await blockedFetches;
    active = Math.max(0, active - 1);
    return new Response("ok", {
      status: 200,
      headers: { "content-length": "2" },
    });
  };

  const backend = makeBackend({
    fetch: fetchMock as any,
    httpHooks: {
      isIpAllowed: () => true,
    },
  });

  (backend as any).resolveHostname = async () => ({ address: "203.0.113.100", family: 4 });

  const request = Buffer.from("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n");

  const runs: Promise<void>[] = [];
  for (let i = 0; i < 180; i += 1) {
    const session: any = { http: undefined };
    runs.push(
      (backend as any).handleHttpDataWithWriter(`k-${i}`, session, request, {
        scheme: "http",
        write: () => {},
        finish: () => {},
      })
    );
  }

  const deadline = Date.now() + 10_000;
  while (maxActive < 128) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for concurrency saturation (max=${maxActive})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(maxActive, 128);

  if (!releaseBlockedFetches) {
    throw new Error("missing fetch release callback");
  }
  releaseBlockedFetches();
  await Promise.all(runs);
});

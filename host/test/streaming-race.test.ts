import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";

import { QemuNetworkBackend } from "../src/qemu/net";
import * as qemuHttp from "../src/qemu/http";

function makeBackend(
  options?: Partial<ConstructorParameters<typeof QemuNetworkBackend>[0]>,
) {
  return new QemuNetworkBackend({
    socketPath: path.join(
      os.tmpdir(),
      `gondolin-net-test-${process.pid}-${crypto.randomUUID()}.sock`,
    ),
    ...options,
  });
}

/**
 * Build a chunked HTTP POST request split into TLS-record-sized pieces.
 * Returns the chunks and an async body consumer for use in a fetch stub.
 */
function buildChunkedPost(bodySize: number, chunkSize = 16_384) {
  const head =
    `POST /upload HTTP/1.1\r\n` +
    `Host: example.com\r\n` +
    `Content-Length: ${bodySize}\r\n` +
    `\r\n`;
  const body = Buffer.alloc(bodySize, 0x41);
  const full = Buffer.concat([Buffer.from(head), body]);
  const chunks: Buffer[] = [];
  for (let i = 0; i < full.length; i += chunkSize) {
    chunks.push(full.subarray(i, Math.min(i + chunkSize, full.length)));
  }
  return { chunks, bodySize };
}

/**
 * Consume a streaming or buffered fetch body and return its total length.
 */
async function consumeFetchBody(init: any): Promise<number> {
  if (!init?.body) return 0;
  if (typeof init.body === "object" && Symbol.asyncIterator in init.body) {
    let total = 0;
    for await (const chunk of init.body as AsyncIterable<Uint8Array>) {
      total += chunk.length;
    }
    return total;
  }
  if (init.body instanceof Uint8Array) return init.body.length;
  return 0;
}

/**
 * Create a writer that resolves `finished` when the response is fully sent.
 */
function makeWriter() {
  let finishResolve: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    finishResolve = resolve;
  });
  const writes: Buffer[] = [];
  const writer = {
    scheme: "http" as const,
    write: (chunk: Buffer) => writes.push(Buffer.from(chunk)),
    finish: () => finishResolve?.(),
    waitForWritable: () => Promise.resolve(),
  };
  return { writer, writes, finished };
}

// ---------------------------------------------------------------------------
// Bug 1: drain() re-entrancy
//
// ReadableStream.controller.enqueue() can synchronously trigger the pull()
// callback, which re-enters drain(). If enqueue() is called before
// pending.shift(), the re-entrant drain() processes the same chunk again,
// double-decrementing pendingBytes to a negative value. The stream never
// closes because (closeAfterPending && pendingBytes === 0) is never true.
// ---------------------------------------------------------------------------

test("qemu-net: streaming POST body completes when chunks are serialized (drain re-entrancy)", async () => {
  const { chunks, bodySize } = buildChunkedPost(50_000);

  let fetchBodyLen = 0;
  let fetchCalls = 0;

  const backend = makeBackend({
    fetch: async (_url: any, init: any) => {
      fetchCalls++;
      fetchBodyLen = await consumeFetchBody(init);
      return new Response("ok", {
        status: 200,
        headers: { "content-length": "2" },
      });
    },
    dnsLookup: ((_h: string, _o: any, cb: any) => {
      setImmediate(() => cb(null, [{ address: "203.0.113.1", family: 4 }]));
    }) as any,
    httpHooks: { isIpAllowed: () => true },
  });

  const session: any = { http: undefined };
  const { writer, finished } = makeWriter();

  for (const chunk of chunks) {
    await qemuHttp.handleHttpDataWithWriter(
      backend,
      "key",
      session,
      chunk,
      writer,
    );
  }

  await Promise.race([
    finished,
    new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error("body stream never closed (drain re-entrancy)")),
        3_000,
      ),
    ),
  ]);

  assert.equal(fetchCalls, 1, "fetch should be called exactly once");
  assert.equal(fetchBodyLen, bodySize, "fetch should receive the full body");
});

test("qemu-net: large (200 KB) streaming POST body completes", async () => {
  const { chunks, bodySize } = buildChunkedPost(200_000);

  let fetchBodyLen = 0;

  const backend = makeBackend({
    fetch: async (_url: any, init: any) => {
      fetchBodyLen = await consumeFetchBody(init);
      return new Response("ok", {
        status: 200,
        headers: { "content-length": "2" },
      });
    },
    dnsLookup: ((_h: string, _o: any, cb: any) => {
      setImmediate(() => cb(null, [{ address: "203.0.113.1", family: 4 }]));
    }) as any,
    httpHooks: { isIpAllowed: () => true },
  });

  const session: any = { http: undefined };
  const { writer, finished } = makeWriter();

  for (const chunk of chunks) {
    await qemuHttp.handleHttpDataWithWriter(
      backend,
      "key",
      session,
      chunk,
      writer,
    );
  }

  await Promise.race([
    finished,
    new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error("body stream never closed (drain re-entrancy)")),
        3_000,
      ),
    ),
  ]);

  assert.equal(fetchBodyLen, bodySize);
});

// ---------------------------------------------------------------------------
// Bug 2: TLS data handler race
//
// tlsSocket.on("data") calls handleTlsHttpData without awaiting. When
// ensureRequestHeadPolicies yields (async DNS lookup), a second data event
// re-enters handleHttpDataWithWriter before httpSession.processing is set,
// causing duplicate header parsing. Simulated here by firing all chunks
// without awaiting, just like the real TLS handler does.
// ---------------------------------------------------------------------------

test("qemu-net: concurrent non-awaited data calls do not corrupt streaming state (TLS handler race)", async () => {
  const { chunks, bodySize } = buildChunkedPost(120_000);

  let fetchBodyLen = 0;
  let fetchCalls = 0;

  const backend = makeBackend({
    fetch: async (_url: any, init: any) => {
      fetchCalls++;
      fetchBodyLen = await consumeFetchBody(init);
      return new Response("ok", {
        status: 200,
        headers: { "content-length": "2" },
      });
    },
    // Async DNS lookup via setImmediate — this is what creates the race
    // window: the first call yields at ensureRequestHeadPolicies while
    // subsequent calls re-enter with more data.
    dnsLookup: ((_h: string, _o: any, cb: any) => {
      setImmediate(() => cb(null, [{ address: "203.0.113.1", family: 4 }]));
    }) as any,
    httpHooks: { isIpAllowed: () => true },
  });

  const session: any = { http: undefined };
  const { writer, finished } = makeWriter();

  // Fire all chunks WITHOUT awaiting — mirrors tlsSocket.on("data") behavior.
  for (const chunk of chunks) {
    qemuHttp.handleHttpDataWithWriter(backend, "key", session, chunk, writer);
  }

  await Promise.race([
    finished,
    new Promise<never>((_, rej) =>
      setTimeout(
        () =>
          rej(
            new Error(
              "response never arrived (concurrent data handler race)",
            ),
          ),
        3_000,
      ),
    ),
  ]);

  assert.equal(fetchCalls, 1, "fetch should be called exactly once");
  assert.equal(fetchBodyLen, bodySize, "fetch should receive the full body");
});

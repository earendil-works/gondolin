import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as qemuHttp from "../src/qemu/http.ts";
import { QemuNetworkBackend } from "../src/qemu/net.ts";

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

function buildPostChunks(bodySize: number, chunkSize = 16_384) {
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

async function consumeFetchBody(init: any): Promise<number> {
  if (!init?.body) return 0;

  if (typeof init.body === "object" && Symbol.asyncIterator in init.body) {
    let total = 0;
    for await (const chunk of init.body as AsyncIterable<Uint8Array>) {
      total += chunk.length;
    }
    return total;
  }

  if (init.body instanceof Uint8Array) {
    return init.body.length;
  }

  return 0;
}

function makeWriter() {
  let finishResolve: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    finishResolve = resolve;
  });

  const writes: Buffer[] = [];
  return {
    writes,
    finished,
    writer: {
      scheme: "http" as const,
      write: (chunk: Buffer) => writes.push(Buffer.from(chunk)),
      finish: () => finishResolve?.(),
      waitForWritable: () => Promise.resolve(),
    },
  };
}

async function waitForOrTimeout(done: Promise<void>, message: string) {
  await Promise.race([
    done,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), 3_000),
    ),
  ]);
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function runStreamingUpload(options: {
  bodySize: number;
  fireAndForget: boolean;
  gateDnsPrecheck?: boolean;
}) {
  const { chunks, bodySize } = buildPostChunks(options.bodySize);

  let fetchCalls = 0;
  let fetchBodyLen = 0;
  let dnsLookupCalls = 0;

  let releaseDns: (() => void) | null = null;
  const dnsGate =
    options.gateDnsPrecheck === true
      ? new Promise<void>((resolve) => {
          releaseDns = resolve;
        })
      : null;

  const backend = makeBackend({
    fetch: async (_url: any, init: any) => {
      fetchCalls += 1;
      fetchBodyLen = await consumeFetchBody(init);
      return new Response("ok", {
        status: 200,
        headers: { "content-length": "2" },
      });
    },
    dnsLookup: ((_hostname: string, _opts: any, cb: any) => {
      dnsLookupCalls += 1;
      setImmediate(() => {
        if (dnsGate) {
          dnsGate.then(() => cb(null, [{ address: "203.0.113.1", family: 4 }]));
          return;
        }
        cb(null, [{ address: "203.0.113.1", family: 4 }]);
      });
    }) as any,
    httpHooks: { isIpAllowed: () => true },
  });

  const errors: Error[] = [];
  backend.on("error", (err) => {
    errors.push(err instanceof Error ? err : new Error(String(err)));
  });

  const session: any = { http: undefined };
  const { writer, writes, finished } = makeWriter();

  const calls: Array<Promise<void>> = [];
  for (const chunk of chunks) {
    const call = qemuHttp.handleHttpDataWithWriter(
      backend,
      "key",
      session,
      chunk,
      writer,
    );
    calls.push(call);
    if (!options.fireAndForget) {
      await call;
    }
  }

  if (releaseDns) {
    await waitForCondition(
      () => dnsLookupCalls >= 1,
      "DNS precheck never started",
    );
    releaseDns();
  }

  await waitForOrTimeout(finished, "response never completed");

  const settled = await Promise.allSettled(calls);
  for (const result of settled) {
    assert.equal(result.status, "fulfilled");
  }

  assert.equal(errors.length, 0, "no backend error events expected");
  assert.match(Buffer.concat(writes).toString("ascii"), /^HTTP\/1\.1 200 /);

  return {
    fetchCalls,
    fetchBodyLen,
    dnsLookupCalls,
    bodySize,
  };
}

test("qemu-net: streaming POST body closes cleanly for medium and large payloads", async () => {
  for (const bodySize of [50_000, 200_000]) {
    const result = await runStreamingUpload({
      bodySize,
      fireAndForget: false,
    });

    assert.equal(result.fetchCalls, 1, `fetch once for ${bodySize} bytes`);
    assert.equal(
      result.fetchBodyLen,
      result.bodySize,
      `forwarded full ${bodySize}-byte body`,
    );
    assert.equal(result.dnsLookupCalls, 1, "single policy precheck lookup");
  }
});

test("qemu-net: concurrent non-awaited data chunks do not re-parse request head", async () => {
  const result = await runStreamingUpload({
    bodySize: 120_000,
    fireAndForget: true,
    gateDnsPrecheck: true,
  });

  assert.equal(result.fetchCalls, 1, "fetch should run exactly once");
  assert.equal(result.fetchBodyLen, result.bodySize, "full body forwarded");
  assert.equal(
    result.dnsLookupCalls,
    1,
    "request precheck should run once even under re-entrant data events",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  webRequestToInternalHttpRequest,
  webResponseToInternalHttpResponse,
  internalHttpRequestToWebRequest,
} from "../src/internal-http-conversion";
import { Request as UndiciRequest, Response as UndiciResponse } from "undici";
import { HttpRequestBlockedError } from "../src/http-utils";

function makeOverflowStream() {
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
    cancel() {
      cancelled = true;
    },
  });

  return {
    stream,
    getCancelled: () => cancelled,
  };
}

test("http-hook-conversion: GET requests with body fail fast", () => {
  assert.throws(
    () =>
      internalHttpRequestToWebRequest({
        method: "GET",
        url: "https://example.com/data",
        headers: {
          "content-length": "5",
        },
        body: Buffer.from("hello"),
      }),
    (err) => err instanceof HttpRequestBlockedError && err.status === 400,
  );
});

test("http-hook-conversion: HEAD requests with body fail fast", () => {
  assert.throws(
    () =>
      internalHttpRequestToWebRequest({
        method: "HEAD",
        url: "https://example.com/data",
        headers: {
          "content-length": "5",
        },
        body: Buffer.from("hello"),
      }),
    (err) => err instanceof HttpRequestBlockedError && err.status === 400,
  );
});

test("http-hook-conversion: accepts undici Request values", async () => {
  const request = new UndiciRequest("https://example.com/upload", {
    method: "POST",
    body: "hello",
  });

  const converted = await webRequestToInternalHttpRequest(request, {
    allowBody: true,
    maxBodyBytes: 16,
  });

  assert.ok(converted);
  assert.equal(converted.method, "POST");
  assert.equal(converted.body?.toString("utf8"), "hello");
});

test("http-hook-conversion: rejects GET-like values with bodies", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });

  await assert.rejects(
    () =>
      webRequestToInternalHttpRequest(
        {
          method: "GET",
          url: "https://example.com/data",
          headers: new Headers(),
          body: stream,
          arrayBuffer: undefined,
        },
        {
          allowBody: true,
          maxBodyBytes: 16,
        },
      ),
    (err) => err instanceof HttpRequestBlockedError && err.status === 400,
  );
});

test("http-hook-conversion: accepts undici Response values", async () => {
  const response = new UndiciResponse("hello", {
    status: 201,
    headers: { "x-test": "1" },
  });

  const converted = await webResponseToInternalHttpResponse(response, {
    maxBodyBytes: 16,
  });

  assert.ok(converted);
  assert.equal(converted.status, 201);
  assert.equal(converted.headers["x-test"], "1");
  assert.equal(converted.body.toString("utf8"), "hello");
});

test("http-hook-conversion: rejects plain invalid objects", async () => {
  await assert.rejects(() =>
    webRequestToInternalHttpRequest({} as any, {
      allowBody: true,
      maxBodyBytes: 16,
    }),
  );
  await assert.rejects(() =>
    webResponseToInternalHttpResponse({} as any, { maxBodyBytes: 16 }),
  );
});

test("http-hook-conversion: request body limit is enforced while reading", async () => {
  const { stream, getCancelled } = makeOverflowStream();

  const request = new Request("https://example.com/upload", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);

  await assert.rejects(
    () =>
      webRequestToInternalHttpRequest(request, {
        allowBody: true,
        maxBodyBytes: 4,
      }),
    (err) => err instanceof HttpRequestBlockedError && err.status === 413,
  );

  assert.equal(getCancelled(), true);
});

test("http-hook-conversion: response body limit is enforced while reading", async () => {
  const { stream, getCancelled } = makeOverflowStream();

  const response = new Response(stream, {
    status: 200,
  });

  await assert.rejects(
    () =>
      webResponseToInternalHttpResponse(response, {
        maxBodyBytes: 4,
      }),
    (err) => err instanceof HttpRequestBlockedError && err.status === 502,
  );

  assert.equal(getCancelled(), true);
});

test("http-hook-conversion: request body conversion succeeds within limit", async () => {
  const request = new Request("https://example.com/upload", {
    method: "POST",
    body: Buffer.from("hello"),
  });

  const converted = await webRequestToInternalHttpRequest(request, {
    allowBody: true,
    maxBodyBytes: 5,
  });

  assert.ok(converted);
  assert.equal(converted.body?.toString("utf8"), "hello");
});

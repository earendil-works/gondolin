import type {
  InternalHeaderValue,
  InternalHttpRequest,
  InternalHttpResponse,
  InternalHttpResponseHeaders,
} from "./http-types.ts";
import {
  HttpRequestBlockedError,
  stripRequestFramingHeaders,
} from "../http/utils.ts";

type RequestLike = Pick<Request, "url" | "method" | "headers" | "body"> & {
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

type ResponseLike = Pick<
  Response,
  "status" | "statusText" | "headers" | "body"
> & {
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

function headerValueArray(value: InternalHeaderValue): string[] {
  return Array.isArray(value) ? value : [value];
}

function httpResponseHeadersToHeadersInit(
  headers: InternalHttpResponseHeaders,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of headerValueArray(value)) out.push([name, item]);
  }
  return out;
}

function isNullBodyStatus(status: number): boolean {
  return (
    status === 101 ||
    status === 103 ||
    status === 204 ||
    status === 205 ||
    status === 304
  );
}

function isBodyStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getReader?: unknown }).getReader === "function"
  );
}

async function readBodyStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  options: {
    maxBodyBytes: number | null;
    overflowError: () => HttpRequestBlockedError;
    invalidError: () => HttpRequestBlockedError;
  },
): Promise<Buffer<ArrayBufferLike>> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      let done = false;
      let value: Uint8Array | undefined;

      try {
        const next = await reader.read();
        done = next.done;
        value = next.value;
      } catch {
        throw options.invalidError();
      }

      if (done) break;
      if (!value || value.length === 0) continue;

      if (
        options.maxBodyBytes !== null &&
        total + value.length > options.maxBodyBytes
      ) {
        try {
          await reader.cancel();
        } catch {
          // ignore cancellation failures
        }
        throw options.overflowError();
      }

      const chunk = Buffer.from(value);
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    reader.releaseLock();
  }

  return chunks.length === 0
    ? Buffer.alloc(0)
    : Buffer.from(Buffer.concat(chunks, total));
}

async function readBodyLikeWithLimit(
  value: { body: unknown; arrayBuffer?: () => Promise<ArrayBuffer> },
  options: {
    maxBodyBytes: number | null;
    overflowError: () => HttpRequestBlockedError;
    invalidError: () => HttpRequestBlockedError;
  },
): Promise<Buffer<ArrayBufferLike>> {
  if (value.body === null || value.body === undefined) {
    return Buffer.alloc(0);
  }

  if (isBodyStream(value.body)) {
    return readBodyStreamWithLimit(value.body, options);
  }

  if (typeof value.arrayBuffer !== "function") {
    throw options.invalidError();
  }

  let bytes: Buffer<ArrayBufferLike>;
  try {
    bytes = Buffer.from(await value.arrayBuffer.call(value));
  } catch {
    throw options.invalidError();
  }

  if (options.maxBodyBytes !== null && bytes.length > options.maxBodyBytes) {
    throw options.overflowError();
  }

  return bytes;
}

export async function webRequestToInternalHttpRequest(
  value: RequestLike,
  options: {
    allowBody: boolean;
    maxBodyBytes: number | null;
  },
): Promise<InternalHttpRequest> {
  const headers = requestHeadersToRecord(new Headers(value.headers));

  if (!options.allowBody && value.body !== null) {
    throw new HttpRequestBlockedError(
      "request body not allowed in this hook",
      400,
      "Bad Request",
    );
  }

  let body: InternalHttpRequest["body"] = { kind: "none" };
  const upperMethod = value.method.toUpperCase();
  if (
    options.allowBody &&
    upperMethod !== "GET" &&
    upperMethod !== "HEAD" &&
    (value.body !== null || typeof value.arrayBuffer === "function")
  ) {
    const bytes = Buffer.from(
      await readBodyLikeWithLimit(value, {
        maxBodyBytes: options.maxBodyBytes,
        overflowError: () =>
          new HttpRequestBlockedError(
            `request body exceeds ${options.maxBodyBytes} bytes`,
            413,
            "Payload Too Large",
          ),
        invalidError: () =>
          new HttpRequestBlockedError(
            "invalid request body",
            400,
            "Bad Request",
          ),
      }),
    );
    body = bytes.length > 0 ? { kind: "buffered", bytes } : { kind: "none" };
  } else if (
    options.allowBody &&
    (value.body !== null || typeof value.arrayBuffer === "function")
  ) {
    throw new HttpRequestBlockedError(
      `request body not allowed for ${upperMethod} in buffered request hooks`,
      400,
      "Bad Request",
    );
  }

  return {
    method: value.method,
    url: value.url,
    headers,
    body,
  };
}

export async function webResponseToInternalHttpResponse(
  value: ResponseLike,
  options: {
    maxBodyBytes: number | null;
  },
): Promise<InternalHttpResponse> {
  const headers = responseHeadersToRecord(new Headers(value.headers));

  const raw = value.headers as { getSetCookie?: () => unknown };
  if (typeof raw.getSetCookie === "function") {
    const cookies = raw.getSetCookie();
    if (
      Array.isArray(cookies) &&
      cookies.every((item) => typeof item === "string")
    ) {
      if (cookies.length === 1) headers["set-cookie"] = cookies[0]!;
      else if (cookies.length > 1) headers["set-cookie"] = cookies;
    }
  }

  const body = Buffer.from(
    await readBodyLikeWithLimit(value, {
      maxBodyBytes: options.maxBodyBytes,
      overflowError: () =>
        new HttpRequestBlockedError(
          `response body exceeds ${options.maxBodyBytes} bytes`,
          502,
          "Bad Gateway",
        ),
      invalidError: () =>
        new HttpRequestBlockedError(
          "invalid response body",
          502,
          "Bad Gateway",
        ),
    }),
  );

  return {
    status: value.status,
    statusText:
      typeof value.statusText === "string" && value.statusText.length > 0
        ? value.statusText
        : "OK",
    headers,
    body,
  };
}

export function requestHeadersToRecord(
  headers: Headers,
): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return stripRequestFramingHeaders(record);
}

export function requestBodyByteLength(
  request: InternalHttpRequest,
): number | null {
  switch (request.body.kind) {
    case "buffered":
      return request.body.bytes.length;
    case "stream":
    case "metadata-only":
      return request.body.byteLength;
    case "none":
      return null;
  }
}

export function responseHeadersToRecord(
  headers: Headers,
): InternalHttpResponseHeaders {
  const record: InternalHttpResponseHeaders = {};

  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });

  const anyHeaders = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    const cookies = anyHeaders.getSetCookie();
    if (cookies.length === 1) record["set-cookie"] = cookies[0]!;
    else if (cookies.length > 1) record["set-cookie"] = cookies;
  }

  return record;
}

export function internalHttpRequestToWebRequest(
  request: InternalHttpRequest,
  options: { includeBody?: boolean } = {},
): Request {
  const method = request.method.toUpperCase();
  const hasBody = request.body.kind !== "none";
  const canHaveBody = method !== "GET" && method !== "HEAD";

  if (hasBody && !canHaveBody) {
    throw new HttpRequestBlockedError(
      `request body not allowed for ${method} in web hooks`,
      400,
      "Bad Request",
    );
  }

  const headers = { ...request.headers };
  const byteLength = requestBodyByteLength(request);
  if (byteLength !== null) headers["content-length"] = String(byteLength);

  const includeBody = options.includeBody ?? true;
  const body =
    includeBody && request.body.kind === "buffered"
      ? new Uint8Array(request.body.bytes)
      : includeBody && request.body.kind === "stream"
        ? request.body.stream
        : undefined;

  return new Request(request.url, {
    method: request.method,
    headers,
    body: body as BodyInit | undefined,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

export function internalHttpResponseToWebResponse(
  response: InternalHttpResponse,
): Response {
  const body = isNullBodyStatus(response.status)
    ? null
    : new Uint8Array(response.body);

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: httpResponseHeadersToHeadersInit(response.headers),
  });
}

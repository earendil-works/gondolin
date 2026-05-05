import assert from "node:assert/strict";
import test from "node:test";

import { createHttpHooks } from "../src/http/hooks.ts";
import { HttpRequestBlockedError } from "../src/http/utils.ts";
import { Request as UndiciRequest, Response as UndiciResponse } from "undici";

function makeRequest(init: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
}): Request {
  return new Request(init.url, {
    method: init.method,
    headers: init.headers,
    body: init.body ?? undefined,
  });
}

function expectRequest(value: unknown): Request {
  assert.equal(typeof value, "object");
  assert.ok(value);
  assert.equal(typeof (value as any).url, "string");
  assert.equal(typeof (value as any).method, "string");
  assert.equal(typeof (value as any).headers?.get, "function");
  return value as Request;
}

async function runRequestHook(
  onRequest: NonNullable<
    ReturnType<typeof createHttpHooks>["httpHooks"]["onRequest"]
  >,
  request: Request,
): Promise<Request> {
  const result = await onRequest(request);
  const next = result ?? request;

  if (
    typeof next === "object" &&
    next !== null &&
    "request" in next &&
    (next as any).request
  ) {
    return expectRequest((next as any).request);
  }

  return expectRequest(next);
}

test("http hooks allowlist patterns", async () => {
  const { httpHooks } = createHttpHooks({
    allowedHosts: ["example.com", "*.example.org", "api.*.net"],
  });

  const isAllowed = httpHooks.isIpAllowed!;

  assert.equal(
    await isAllowed({
      hostname: "example.com",
      ip: "8.8.8.8",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );

  assert.equal(
    await isAllowed({
      hostname: "Foo.Example.Org",
      ip: "1.1.1.1",
      family: 4,
      port: 80,
      protocol: "http",
    }),
    true,
  );

  assert.equal(
    await isAllowed({
      hostname: "api.foo.net",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );

  assert.equal(
    await isAllowed({
      hostname: "nope.com",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    false,
  );
});

test("http hooks hostname matching handles empty patterns and multiple wildcards", async () => {
  // Empty patterns should be ignored by normalization/uniquing.
  const { httpHooks, allowedHosts } = createHttpHooks({
    allowedHosts: ["", "   ", "a**b.com"],
  });

  assert.deepEqual(allowedHosts, ["a**b.com"]);

  const isAllowed = httpHooks.isIpAllowed!;

  assert.equal(
    await isAllowed({
      hostname: "axxxb.com",
      ip: "8.8.8.8",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );

  assert.equal(
    await isAllowed({
      hostname: "ab.com",
      ip: "8.8.8.8",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );

  assert.equal(
    await isAllowed({
      hostname: "acb.com",
      ip: "8.8.8.8",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );

  assert.equal(
    await isAllowed({
      hostname: "nope.com",
      ip: "8.8.8.8",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    false,
  );
});

test("http hooks allowlist '*' matches any hostname (but still blocks internal)", async () => {
  const { httpHooks } = createHttpHooks({
    allowedHosts: ["*"],
  });

  const isAllowed = httpHooks.isIpAllowed!;

  assert.equal(
    await isAllowed({
      hostname: "anything.example",
      ip: "8.8.8.8",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );

  // '*' does not bypass internal range blocking.
  assert.equal(
    await isAllowed({
      hostname: "anything.example",
      ip: "::1",
      family: 6,
      port: 443,
      protocol: "https",
    }),
    false,
  );
});

test("http hooks block internal ranges by default", async () => {
  const { httpHooks } = createHttpHooks({
    allowedHosts: ["example.com"],
  });

  const isAllowed = httpHooks.isIpAllowed!;

  assert.equal(
    await isAllowed({
      hostname: "example.com",
      ip: "10.0.0.1",
      family: 4,
      port: 80,
      protocol: "http",
    }),
    false,
  );
});

test("http hooks allowedInternalHosts can bypass internal range block", async () => {
  const { httpHooks, allowedHosts } = createHttpHooks({
    allowedInternalHosts: ["corp.example"],
  });

  assert.deepEqual(allowedHosts, ["*"]);

  const isAllowed = httpHooks.isIpAllowed!;

  assert.equal(
    await isAllowed({
      hostname: "corp.example",
      ip: "10.0.0.1",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );

  assert.equal(
    await isAllowed({
      hostname: "corp.example",
      ip: "203.0.113.10",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );

  assert.equal(
    await isAllowed({
      hostname: "other.example",
      ip: "10.0.0.1",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    false,
  );
});

test("http hooks allowedInternalHosts only bypasses internal checks for matching hosts", async () => {
  const { httpHooks } = createHttpHooks({
    allowedHosts: ["*"],
    allowedInternalHosts: ["corp.example"],
  });

  const isAllowed = httpHooks.isIpAllowed!;

  assert.equal(
    await isAllowed({
      hostname: "corp.example",
      ip: "10.1.2.3",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );

  assert.equal(
    await isAllowed({
      hostname: "anything.example",
      ip: "10.1.2.3",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    false,
  );
});

test("http hooks allowedInternalHosts supports IPv4-style wildcard host patterns", async () => {
  const { httpHooks } = createHttpHooks({
    allowedInternalHosts: ["192.168.99.*"],
  });

  const isAllowed = httpHooks.isIpAllowed!;

  assert.equal(
    await isAllowed({
      hostname: "192.168.99.10",
      ip: "192.168.99.10",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );

  assert.equal(
    await isAllowed({
      hostname: "192.168.100.10",
      ip: "192.168.100.10",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    false,
  );
});

test("http hooks block internal IPv6 ranges (loopback, ULA, link-local)", async () => {
  const { httpHooks } = createHttpHooks({
    allowedHosts: ["example.com"],
  });

  const isAllowed = httpHooks.isIpAllowed!;

  const cases = [
    "::", // all zeros / unspecified
    "::1", // loopback
    "fc00::1", // ULA
    "fd12:3456:789a::1", // ULA
    "fe80::1", // link-local
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1", // IPv4-mapped private
  ];

  for (const ip of cases) {
    assert.equal(
      await isAllowed({
        hostname: "example.com",
        ip,
        family: 6,
        port: 443,
        protocol: "https",
      }),
      false,
      `expected ${ip} to be blocked`,
    );
  }
});

test("http hooks allow non-private IPv6 (including IPv4-suffix forms)", async () => {
  const { httpHooks } = createHttpHooks({
    allowedHosts: ["example.com"],
  });

  const isAllowed = httpHooks.isIpAllowed!;

  // IPv4-mapped *public* address
  assert.equal(
    await isAllowed({
      hostname: "example.com",
      ip: "::ffff:8.8.8.8",
      family: 6,
      port: 443,
      protocol: "https",
    }),
    true,
  );

  // IPv6 with embedded IPv4 suffix (not mapped)
  assert.equal(
    await isAllowed({
      hostname: "example.com",
      ip: "64:ff9b::8.8.8.8",
      family: 6,
      port: 443,
      protocol: "https",
    }),
    true,
  );
});

test("http hooks ignore invalid IP strings for internal-range checks", async () => {
  const { httpHooks } = createHttpHooks({
    allowedHosts: ["example.com"],
  });

  const isAllowed = httpHooks.isIpAllowed!;

  // net.isIP() returns 0 => treated as non-internal.
  assert.equal(
    await isAllowed({
      hostname: "example.com",
      ip: "zzzz::1",
      family: 6,
      port: 443,
      protocol: "https",
    }),
    true,
  );
});

test("http hooks can allow internal ranges", async () => {
  const { httpHooks } = createHttpHooks({
    allowedHosts: ["example.com"],
    blockInternalRanges: false,
  });

  const isAllowed = httpHooks.isIpAllowed!;

  assert.equal(
    await isAllowed({
      hostname: "example.com",
      ip: "10.0.0.1",
      family: 4,
      port: 80,
      protocol: "http",
    }),
    true,
  );
});

test("http hooks can enforce request policy", async () => {
  const { httpHooks } = createHttpHooks({
    isRequestAllowed: (request) => request.method !== "DELETE",
  });

  const isRequestAllowed = httpHooks.isRequestAllowed!;

  assert.equal(
    await isRequestAllowed(
      makeRequest({
        method: "GET",
        url: "https://example.com/data",
      }),
    ),
    true,
  );

  assert.equal(
    await isRequestAllowed(
      makeRequest({
        method: "DELETE",
        url: "https://example.com/data",
      }),
    ),
    false,
  );
});

test("http hooks replace secret placeholders", async () => {
  const { httpHooks, env, allowedHosts } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
  });

  assert.deepEqual(allowedHosts, ["*"]);

  const request = await runRequestHook(
    httpHooks.onRequest!,
    makeRequest({
      method: "GET",
      url: "https://example.com/data",
      headers: {
        authorization: `Bearer ${env.API_KEY}`,
      },
    }),
  );

  assert.equal(request.headers.get("authorization"), "Bearer secret-value");
});

test("http hooks update existing secrets after creation", async () => {
  const { httpHooks, env, secretManager } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
  });

  secretManager.updateSecret("API_KEY", { value: "rotated-value" });

  const request = await runRequestHook(
    httpHooks.onRequest!,
    makeRequest({
      method: "GET",
      url: "https://example.com/data",
      headers: {
        authorization: `Bearer ${env.API_KEY}`,
      },
    }),
  );

  assert.equal(request.headers.get("authorization"), "Bearer rotated-value");
});

test("http hooks update secret host allowlists after creation", async () => {
  const { httpHooks, env, allowedHosts, secretManager } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
  });

  assert.deepEqual(allowedHosts, ["*"]);

  secretManager.updateSecret("API_KEY", { hosts: ["example.org"] });

  assert.deepEqual(allowedHosts, ["*"]);

  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: "https://example.com/data",
          headers: {
            authorization: `Bearer ${env.API_KEY}`,
          },
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );

  const request = await runRequestHook(
    httpHooks.onRequest!,
    makeRequest({
      method: "GET",
      url: "https://example.org/data",
      headers: {
        authorization: `Bearer ${env.API_KEY}`,
      },
    }),
  );

  assert.equal(request.headers.get("authorization"), "Bearer secret-value");
});

test("http hooks delete secrets by substituting empty strings", async () => {
  const { httpHooks, env, allowedHosts, secretManager } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
  });

  secretManager.deleteSecret("API_KEY");

  assert.deepEqual(allowedHosts, ["*"]);

  const request = await runRequestHook(
    httpHooks.onRequest!,
    makeRequest({
      method: "GET",
      url: "https://example.org/data",
      headers: {
        authorization: `Bearer ${env.API_KEY}`,
      },
    }),
  );

  assert.match(request.headers.get("authorization") ?? "", /^Bearer ?$/);

  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: "https://example.org/data",
          headers: {
            authorization: "Bearer secret-value",
          },
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );
});

test("http hooks default global allowlist stays open when secrets are configured", async () => {
  const { httpHooks, allowedHosts } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
  });

  assert.deepEqual(allowedHosts, ["*"]);

  assert.equal(
    await httpHooks.isIpAllowed!({
      hostname: "unrelated.example",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );
});

test("http hooks explicit empty allowlist denies all even when secrets exist", async () => {
  const { httpHooks, allowedHosts } = createHttpHooks({
    allowedHosts: [],
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
  });

  assert.deepEqual(allowedHosts, []);

  assert.equal(
    await httpHooks.isIpAllowed!({
      hostname: "example.com",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    false,
  );
});

test("http hooks reject revoked secret values after rotation on allowed hosts", async () => {
  const { httpHooks, secretManager } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
  });

  secretManager.updateSecret("API_KEY", { value: "rotated-value" });

  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: "https://example.com/data",
          headers: {
            authorization: "Bearer secret-value",
          },
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );
});

test("http hooks reject revoked secret values embedded in custom headers", async () => {
  const { httpHooks, secretManager } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "oldsecret",
      },
    },
  });

  secretManager.updateSecret("API_KEY", { value: "newsecret" });

  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: "https://example.com/data",
          headers: {
            "x-api-key": "key=oldsecret",
          },
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );
});

test("http hooks reject revoked secret values embedded in authorization headers", async () => {
  const { httpHooks, secretManager } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "oldsecret",
      },
    },
  });

  secretManager.updateSecret("API_KEY", { value: "newsecret" });

  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: "https://example.com/data",
          headers: {
            authorization: "Bearer prefix-oldsecret-suffix",
          },
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );
});

test("http hooks reject revoked secret values in malformed basic auth headers", async () => {
  const { httpHooks, secretManager } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "oldsecret",
      },
    },
  });

  secretManager.updateSecret("API_KEY", { value: "newsecret" });

  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: "https://example.com/data",
          headers: {
            authorization: "Basic oldsecret",
          },
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );
});

test("http hooks reject deleted secret values in malformed basic auth headers", async () => {
  const { httpHooks, secretManager } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "oldsecret",
      },
    },
  });

  secretManager.deleteSecret("API_KEY");

  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: "https://example.com/data",
          headers: {
            authorization: "Basic oldsecret",
          },
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );
});

test("http hooks allow rotated secret values that contain revoked header values", async () => {
  const { httpHooks, secretManager } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "abc",
      },
    },
  });

  secretManager.updateSecret("API_KEY", { value: "abcd" });

  const request = await runRequestHook(
    httpHooks.onRequest!,
    makeRequest({
      method: "GET",
      url: "https://example.com/data",
      headers: {
        authorization: "Bearer abcd",
      },
    }),
  );

  assert.equal(request.headers.get("authorization"), "Bearer abcd");
});

test("http hooks allow embedded current secret values that contain revoked header values", async () => {
  const { httpHooks, secretManager } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "abc",
      },
    },
  });

  secretManager.updateSecret("API_KEY", { value: "abcd" });

  const request = await runRequestHook(
    httpHooks.onRequest!,
    makeRequest({
      method: "GET",
      url: "https://example.com/data",
      headers: {
        authorization: "Bearer prefix-abcd-suffix",
      },
    }),
  );

  assert.equal(
    request.headers.get("authorization"),
    "Bearer prefix-abcd-suffix",
  );
});

test("http hooks allow rotated secret values that contain revoked query values", async () => {
  const { httpHooks, secretManager } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "abc",
      },
    },
    replaceSecretsInQuery: true,
  });

  secretManager.updateSecret("API_KEY", { value: "abcd" });

  const request = await runRequestHook(
    httpHooks.onRequest!,
    makeRequest({
      method: "GET",
      url: "https://example.com/data?token=abcd",
    }),
  );

  assert.equal(new URL(request.url).searchParams.get("token"), "abcd");
});

test("http hooks reject revoked secret values embedded in query values", async () => {
  const { httpHooks, secretManager } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "oldsecret",
      },
    },
    replaceSecretsInQuery: true,
  });

  secretManager.updateSecret("API_KEY", { value: "newsecret" });

  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: "https://example.com/data?sig=oldsecret-v2",
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );
});

test("http hooks reject deleted secret values embedded in headers and query values", async () => {
  const { httpHooks, secretManager } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "oldsecret",
      },
    },
    replaceSecretsInQuery: true,
  });

  secretManager.deleteSecret("API_KEY");

  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: "https://example.com/data?sig=prefix-oldsecret-suffix",
          headers: {
            "x-api-key": "prefix-oldsecret-suffix",
          },
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );
});

test("http hooks keep placeholders in URL parameters by default", async () => {
  const { httpHooks, env } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
  });

  const originalUrl = `https://example.com/data?token=${env.API_KEY}`;
  const request = await runRequestHook(
    httpHooks.onRequest!,
    makeRequest({
      method: "GET",
      url: originalUrl,
    }),
  );

  assert.equal(request.url, originalUrl);
});

test("http hooks can replace placeholders in URL parameters when enabled", async () => {
  const { httpHooks, env } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "s3cr3t+/=?",
      },
    },
    replaceSecretsInQuery: true,
  });

  const request = await runRequestHook(
    httpHooks.onRequest!,
    makeRequest({
      method: "GET",
      url: `https://example.com/data?token=${env.API_KEY}&ok=1`,
    }),
  );

  assert.equal(new URL(request.url).searchParams.get("token"), "s3cr3t+/=?");
  assert.equal(request.url.includes(env.API_KEY), false);
});

test("http hooks reject URL parameter secrets on disallowed hosts when enabled", async () => {
  const { httpHooks, env } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
    replaceSecretsInQuery: true,
  });

  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: `https://example.org/data?token=${env.API_KEY}`,
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );
});

test("http hooks replace secret placeholders in basic auth", async () => {
  const { httpHooks, env } = createHttpHooks({
    secrets: {
      BASIC_USER: {
        hosts: ["example.com"],
        value: "alice",
      },
      BASIC_PASS: {
        hosts: ["example.com"],
        value: "s3cr3t",
      },
    },
  });

  const placeholderToken = Buffer.from(
    `${env.BASIC_USER}:${env.BASIC_PASS}`,
    "utf8",
  ).toString("base64");
  const expectedToken = Buffer.from("alice:s3cr3t", "utf8").toString("base64");

  const request = await runRequestHook(
    httpHooks.onRequest!,
    makeRequest({
      method: "GET",
      url: "https://example.com/data",
      headers: {
        authorization: `Basic ${placeholderToken}`,
      },
    }),
  );

  assert.equal(request.headers.get("authorization"), `Basic ${expectedToken}`);
});

test("http hooks reject basic auth secrets on disallowed hosts", async () => {
  const { httpHooks, env } = createHttpHooks({
    secrets: {
      BASIC_USER: {
        hosts: ["example.com"],
        value: "alice",
      },
      BASIC_PASS: {
        hosts: ["example.com"],
        value: "s3cr3t",
      },
    },
  });

  const placeholderToken = Buffer.from(
    `${env.BASIC_USER}:${env.BASIC_PASS}`,
    "utf8",
  ).toString("base64");

  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: "https://example.org/data",
          headers: {
            authorization: `Basic ${placeholderToken}`,
          },
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );
});

test("http hooks reject secrets on disallowed hosts", async () => {
  const { httpHooks, env } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
  });

  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: "https://example.org/data",
          headers: {
            authorization: `Bearer ${env.API_KEY}`,
          },
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );
});

test("http hooks reject already-substituted secrets on disallowed hosts", async () => {
  const { httpHooks } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
  });

  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: "https://example.org/data",
          headers: {
            authorization: "Bearer secret-value",
          },
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );
});

test("http hooks reject secrets if onRequest rewrites the destination", async () => {
  const { httpHooks, env } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
    onRequest: (req) =>
      new Request("https://example.org/data", {
        method: req.method,
        headers: req.headers,
      }),
  });

  // Secret substitution must use the *final* destination, and block here.
  await assert.rejects(
    () =>
      httpHooks.onRequest!(
        makeRequest({
          method: "GET",
          url: "https://example.com/data",
          headers: {
            authorization: `Bearer ${env.API_KEY}`,
          },
        }),
      ),
    (err) => err instanceof HttpRequestBlockedError,
  );
});

test("http hooks onRequest returns a Request when onRequest is configured", async () => {
  const { httpHooks, env } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
    onRequest: (req) => req,
  });

  const result = await httpHooks.onRequest!(
    makeRequest({
      method: "POST",
      url: "https://example.com/data",
      headers: {
        authorization: `Bearer ${env.API_KEY}`,
      },
    }),
  );

  assert.ok(result instanceof Request);
  assert.equal(result.headers.get("authorization"), "Bearer secret-value");
});

test("http hooks accept undici.Request from onRequest", async () => {
  const { httpHooks } = createHttpHooks({
    onRequest: (req) =>
      new UndiciRequest("https://example.com/rewrite", {
        method: req.method,
        headers: req.headers,
      }),
  });

  const request = await runRequestHook(
    httpHooks.onRequest!,
    makeRequest({
      method: "GET",
      url: "https://example.com/data",
    }),
  );

  assert.equal(new URL(request.url).pathname, "/rewrite");
});

test("http hooks accept undici.Response from onRequest", async () => {
  const { httpHooks } = createHttpHooks({
    onRequest: () =>
      new UndiciResponse("handled", {
        status: 207,
        headers: { "x-undici": "1" },
      }),
  });

  const result = await httpHooks.onRequest!(
    makeRequest({
      method: "POST",
      url: "https://example.com/data",
      body: "hello",
    }),
  );

  assert.ok(result instanceof Response);
  assert.equal(result.status, 207);
  assert.equal(result.headers.get("x-undici"), "1");
  assert.equal(await result.text(), "handled");
});

test("http hooks reject invalid hook return values", async () => {
  const { httpHooks: headHooks } = createHttpHooks({
    onRequest: () => ({}) as any,
  });
  await assert.rejects(() =>
    headHooks.onRequest!(
      makeRequest({ method: "GET", url: "https://example.com/data" }),
    ),
  );

  const { httpHooks: bodyHooks } = createHttpHooks({
    onRequest: () => ({}) as any,
  });
  await assert.rejects(() =>
    bodyHooks.onRequest!(
      makeRequest({
        method: "POST",
        url: "https://example.com/data",
        body: "hello",
      }),
    ),
  );
});

test("http hooks pass request through custom handler", async () => {
  const seenAuth: string[] = [];

  const { httpHooks, env } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
    onRequest: (req) => {
      seenAuth.push(req.headers.get("authorization") ?? "");
      const headers = new Headers(req.headers);
      headers.set("x-extra", "1");
      return new Request(req.url, {
        method: req.method,
        headers,
      });
    },
  });

  const result = await httpHooks.onRequest!(
    makeRequest({
      method: "POST",
      url: "https://example.com/data",
      headers: {
        authorization: `Bearer ${env.API_KEY}`,
      },
    }),
  );
  const request = expectRequest(result);

  // User hooks run before secret substitution, so they only see placeholders.
  assert.deepEqual(seenAuth, [`Bearer ${env.API_KEY}`]);

  // The request returned to the bridge has secrets substituted.
  assert.equal(request.headers.get("authorization"), "Bearer secret-value");
  assert.equal(request.headers.get("x-extra"), "1");
});

test("http hooks preserve in-place onRequest header mutations", async () => {
  const { httpHooks } = createHttpHooks({
    onRequest: (request) => {
      request.headers.set("x-inline", "1");
      return request;
    },
  });

  const result = await httpHooks.onRequest!(
    makeRequest({
      method: "POST",
      url: "https://example.com/data",
      body: "hello",
    }),
  );

  const request = expectRequest(result);
  assert.equal(request.headers.get("x-inline"), "1");
});

test("http hooks preserve request when handler returns void", async () => {
  const seenAuth: string[] = [];

  const { httpHooks, env } = createHttpHooks({
    secrets: {
      API_KEY: {
        hosts: ["example.com"],
        value: "secret-value",
      },
    },
    onRequest: (req) => {
      seenAuth.push(req.headers.get("authorization") ?? "");
    },
  });

  const result = await httpHooks.onRequest!(
    makeRequest({
      method: "POST",
      url: "https://example.com/data",
      headers: {
        authorization: `Bearer ${env.API_KEY}`,
      },
    }),
  );
  const request = expectRequest(result);

  // User hooks run before secret substitution, so they only see placeholders.
  assert.deepEqual(seenAuth, [`Bearer ${env.API_KEY}`]);

  // The request returned to the bridge has secrets substituted.
  assert.equal(request.headers.get("authorization"), "Bearer secret-value");
});

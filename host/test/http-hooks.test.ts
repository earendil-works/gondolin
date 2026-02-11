import assert from "node:assert/strict";
import test from "node:test";

import { createHttpHooks } from "../src/http-hooks";
import { HttpRequestBlockedError } from "../src/qemu-net";

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
    true
  );

  assert.equal(
    await isAllowed({
      hostname: "Foo.Example.Org",
      ip: "1.1.1.1",
      family: 4,
      port: 80,
      protocol: "http",
    }),
    true
  );

  assert.equal(
    await isAllowed({
      hostname: "api.foo.net",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true
  );

  assert.equal(
    await isAllowed({
      hostname: "nope.com",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    false
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
    true
  );

  assert.equal(
    await isAllowed({
      hostname: "ab.com",
      ip: "8.8.8.8",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true
  );

  assert.equal(
    await isAllowed({
      hostname: "acb.com",
      ip: "8.8.8.8",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true
  );

  assert.equal(
    await isAllowed({
      hostname: "nope.com",
      ip: "8.8.8.8",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    false
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
    true
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
    false
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
    false
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
      `expected ${ip} to be blocked`
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
    true
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
    true
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
    true
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
    true
  );
});

test("http hooks can enforce request policy", async () => {
  const { httpHooks } = createHttpHooks({
    isRequestAllowed: (request) => request.method !== "DELETE",
  });

  const isRequestAllowed = httpHooks.isRequestAllowed!;

  assert.equal(
    await isRequestAllowed({
      method: "GET",
      url: "https://example.com/data",
      headers: {},
      body: null,
    }),
    true
  );

  assert.equal(
    await isRequestAllowed({
      method: "DELETE",
      url: "https://example.com/data",
      headers: {},
      body: null,
    }),
    false
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

  assert.ok(allowedHosts.includes("example.com"));

  const request = await httpHooks.onRequest!({
    method: "GET",
    url: "https://example.com/data",
    headers: {
      authorization: `Bearer ${env.API_KEY}`,
    },
    body: null,
  });

  assert.equal(request.headers.authorization, "Bearer secret-value");
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

  const placeholderToken = Buffer.from(`${env.BASIC_USER}:${env.BASIC_PASS}`, "utf8").toString(
    "base64"
  );
  const expectedToken = Buffer.from("alice:s3cr3t", "utf8").toString("base64");

  const request = await httpHooks.onRequest!({
    method: "GET",
    url: "https://example.com/data",
    headers: {
      authorization: `Basic ${placeholderToken}`,
    },
    body: null,
  });

  assert.equal(request.headers.authorization, `Basic ${expectedToken}`);
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

  const placeholderToken = Buffer.from(`${env.BASIC_USER}:${env.BASIC_PASS}`, "utf8").toString(
    "base64"
  );

  await assert.rejects(
    () =>
      httpHooks.onRequest!({
        method: "GET",
        url: "https://example.org/data",
        headers: {
          authorization: `Basic ${placeholderToken}`,
        },
        body: null,
      }),
    (err) => err instanceof HttpRequestBlockedError
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
      httpHooks.onRequest!({
        method: "GET",
        url: "https://example.org/data",
        headers: {
          authorization: `Bearer ${env.API_KEY}`,
        },
        body: null,
      }),
    (err) => err instanceof HttpRequestBlockedError
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
      seenAuth.push(req.headers.authorization ?? "");
      req.headers["x-extra"] = "1";
      return req;
    },
  });

  const request = await httpHooks.onRequest!({
    method: "POST",
    url: "https://example.com/data",
    headers: {
      authorization: `Bearer ${env.API_KEY}`,
    },
    body: null,
  });

  assert.deepEqual(seenAuth, ["Bearer secret-value"]);
  assert.equal(request.headers.authorization, "Bearer secret-value");
  assert.equal(request.headers["x-extra"], "1");
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
      seenAuth.push(req.headers.authorization ?? "");
    },
  });

  const request = await httpHooks.onRequest!({
    method: "POST",
    url: "https://example.com/data",
    headers: {
      authorization: `Bearer ${env.API_KEY}`,
    },
    body: null,
  });

  assert.deepEqual(seenAuth, ["Bearer secret-value"]);
  assert.equal(request.headers.authorization, "Bearer secret-value");
});

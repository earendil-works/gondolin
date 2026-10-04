import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { __test } from "../src/build/trufflehog.ts";

test("resolveSupportedPlatform supports gondolin host platforms", () => {
  assert.equal(
    __test.resolveSupportedPlatform("darwin", "arm64"),
    "darwin-arm64",
  );
  assert.equal(__test.resolveSupportedPlatform("darwin", "x64"), "darwin-x64");
  assert.equal(
    __test.resolveSupportedPlatform("linux", "arm64"),
    "linux-arm64",
  );
  assert.equal(__test.resolveSupportedPlatform("linux", "x64"), "linux-x64");
});

test("resolveSupportedPlatform rejects unsupported platforms", () => {
  assert.throws(
    () => __test.resolveSupportedPlatform("win32", "x64"),
    /not available/,
  );
});

test("installedBinaryPath includes object dir and build id", () => {
  assert.equal(
    __test.installedBinaryPath("/tmp/gondolin-tools", "build-123"),
    path.join(
      "/tmp/gondolin-tools",
      "objects",
      "build-123",
      "bin",
      "trufflehog",
    ),
  );
});

test("parseBuiltinTrufflehogRegistry parses refs and builds", () => {
  const registry = __test.parseBuiltinTrufflehogRegistry(
    {
      schema: 1,
      refs: {
        "trufflehog:1.2.3": {
          "linux-x64": "build-1",
        },
      },
      builds: {
        "build-1": {
          version: "1.2.3",
          platform: "linux-x64",
          url: "https://example.com/trufflehog.tar.gz",
        },
      },
    },
    "https://example.com/registry.json",
  );

  assert.equal(registry.refs["trufflehog:1.2.3"]["linux-x64"], "build-1");
  assert.equal(registry.builds["build-1"].platform, "linux-x64");
});

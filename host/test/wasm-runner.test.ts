import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../src/sandbox/wasm-runner.ts";

test("wasm-runner parseArgs parses --net-socket and passthrough args", () => {
  const parsed = __test.parseArgs([
    "--wasm",
    "/tmp/guest.wasm",
    "--net-socket",
    "/tmp/net.sock",
    "--",
    "-net",
    "socket",
  ]);

  assert.equal(parsed.wasmPath, "/tmp/guest.wasm");
  assert.equal(parsed.netSocketPath, "/tmp/net.sock");
  assert.deepEqual(parsed.wasmArgs, ["-net", "socket"]);
});

test("wasm-runner parseArgs rejects missing --wasm", () => {
  assert.throws(() => __test.parseArgs(["--net-socket", "/tmp/net.sock"]));
});

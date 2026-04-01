import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  assert.deepEqual(parsed.preopens, []);
  assert.deepEqual(parsed.wasmArgs, ["-net", "socket"]);
});

test("wasm-runner parseArgs parses preopen and preopen-ro", () => {
  const hostA = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-wasm-a-"));
  const hostB = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-wasm-b-"));

  try {
    const parsed = __test.parseArgs([
      "--wasm=/tmp/guest.wasm",
      `--preopen=${hostA}::/workspace`,
      "--preopen-ro",
      `${hostB}::/readonly`,
    ]);

    assert.deepEqual(parsed.preopens, [
      {
        hostPath: hostA,
        guestPath: "/workspace",
        readOnly: false,
      },
      {
        hostPath: hostB,
        guestPath: "/readonly",
        readOnly: true,
      },
    ]);
  } finally {
    fs.rmSync(hostA, { recursive: true, force: true });
    fs.rmSync(hostB, { recursive: true, force: true });
  }
});

test("wasm-runner parseArgs rejects missing --wasm", () => {
  assert.throws(() => __test.parseArgs(["--net-socket", "/tmp/net.sock"]));
});

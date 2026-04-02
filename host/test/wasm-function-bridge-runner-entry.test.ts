import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../src/sandbox/wasm-function-bridge-runner-entry.ts";

test("runner-entry parseArgs parses wasm module args", () => {
  const parsed = __test.parseArgs([
    "--mode",
    "wasi-stdio",
    "--wasm",
    "/tmp/guest.wasm",
    "--wasm-arg",
    "--env=AAA=hello",
    "--wasm-arg=--env=BBB=world",
  ]);

  assert.equal(parsed.mode, "wasi-stdio");
  assert.equal(parsed.wasmPath, "/tmp/guest.wasm");
  assert.deepEqual(parsed.wasmArgs, ["--env=AAA=hello", "--env=BBB=world"]);
});

import assert from "node:assert/strict";
import child_process from "node:child_process";
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

test("wasm-runner resolves relative and absolute clock deadlines", () => {
  const nowMonoNs = 1_000_000_000n;
  const nowRealtimeNs = 9_000_000_000n;

  assert.equal(
    __test.resolveClockDeadlineNs(1, 50_000_000n, 0, nowMonoNs, nowRealtimeNs),
    1_050_000_000n,
  );

  assert.equal(
    __test.resolveClockDeadlineNs(0, 9_250_000_000n, 1, nowMonoNs, nowRealtimeNs),
    1_250_000_000n,
  );
});

test("wasm-runner poll wait timeout honors clock deadlines and net poll slice", () => {
  const nowMonoNs = 1_000_000_000n;

  assert.equal(
    __test.resolvePollWaitTimeoutMs(
      {
        needsNetPoll: false,
        nextClockDeadlineNs: 1_050_000_000n,
      },
      nowMonoNs,
    ),
    50,
  );

  assert.equal(
    __test.resolvePollWaitTimeoutMs(
      {
        needsNetPoll: false,
        nextClockDeadlineNs: 1_000_000_001n,
      },
      nowMonoNs,
    ),
    1,
  );

  assert.equal(
    __test.resolvePollWaitTimeoutMs(
      {
        needsNetPoll: true,
        nextClockDeadlineNs: 2_000_000_000n,
      },
      nowMonoNs,
    ),
    __test.POLL_NET_WAIT_SLICE_MS,
  );

  assert.equal(
    __test.resolvePollWaitTimeoutMs(
      {
        needsNetPoll: false,
        nextClockDeadlineNs: null,
      },
      nowMonoNs,
    ),
    undefined,
  );
});

test("wasm-runner poll_oneoff waits for relative clock subscriptions", (t) => {
  const wat2wasmPath = path.resolve(
    import.meta.dirname,
    "../node_modules/.bin/wat2wasm",
  );
  if (!fs.existsSync(wat2wasmPath)) {
    t.skip("wat2wasm is required for poll_oneoff timing test");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-wasm-poll-"));
  const watPath = path.join(tempDir, "poll-clock.wat");
  const wasmPath = path.join(tempDir, "poll-clock.wasm");
  const runnerPath = path.resolve(
    import.meta.dirname,
    "../src/sandbox/wasm-runner.ts",
  );

  try {
    fs.writeFileSync(
      watPath,
      [
        "(module",
        '  (import "wasi_snapshot_preview1" "clock_time_get" (func $clock_time_get (param i32 i64 i32) (result i32)))',
        '  (import "wasi_snapshot_preview1" "poll_oneoff" (func $poll_oneoff (param i32 i32 i32 i32) (result i32)))',
        '  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))',
        '  (memory (export "memory") 1)',
        '  (func (export "_start")',
        '    (drop (call $clock_time_get (i32.const 1) (i64.const 1) (i32.const 0)))',
        '    (i64.store (i32.const 16) (i64.const 1))',
        '    (i32.store8 (i32.const 24) (i32.const 0))',
        '    (i32.store (i32.const 32) (i32.const 1))',
        '    (i64.store (i32.const 40) (i64.const 50000000))',
        '    (i64.store (i32.const 48) (i64.const 0))',
        '    (i32.store16 (i32.const 56) (i32.const 0))',
        '    (drop (call $poll_oneoff (i32.const 16) (i32.const 64) (i32.const 1) (i32.const 96)))',
        '    (drop (call $clock_time_get (i32.const 1) (i64.const 1) (i32.const 8)))',
        '    (if (i64.lt_u (i64.sub (i64.load (i32.const 8)) (i64.load (i32.const 0))) (i64.const 40000000))',
        '      (then (call $proc_exit (i32.const 42)))',
        '    )',
        '  )',
        ')',
        "",
      ].join("\n"),
    );

    child_process.execFileSync(wat2wasmPath, [watPath, "-o", wasmPath]);

    const result = child_process.spawnSync(
      process.execPath,
      [runnerPath, "--wasm", wasmPath],
      {
        encoding: "utf8",
        timeout: 5_000,
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout || undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

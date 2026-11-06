import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  closeVm,
  withVm,
  shouldSkipVmTests,
  scheduleForceExit,
} from "./helpers/vm-fixture.ts";

const vmKey = "exec-stdin-backpressure";
const vmOptions = { sandbox: { console: "none" as const } };
const skip = shouldSkipVmTests()
  ? "hardware virtualization unavailable"
  : false;
const SIZE = 48 * 1024 * 1024; // well above the 8 MiB per-exec stdin queue

test.after(async () => {
  await closeVm(vmKey);
  scheduleForceExit();
});

test("exec stdin from a large buffer is flow controlled", {
  skip,
  timeout: 120_000,
}, async () => {
  await withVm(vmKey, vmOptions, async (vm) => {
    const result = await vm.exec(["/bin/sh", "-c", "wc -c"], {
      stdin: Buffer.alloc(SIZE, 0x61),
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), String(SIZE));
  });
});

test("exec stdin from a fast stream is flow controlled", {
  skip,
  timeout: 120_000,
}, async () => {
  await withVm(vmKey, vmOptions, async (vm) => {
    const chunk = Buffer.alloc(1024 * 1024, 0x62);
    const stream = Readable.from(
      (function* () {
        for (let i = 0; i < SIZE / chunk.length; i += 1) yield chunk;
      })(),
    );
    const result = await vm.exec(["/bin/sh", "-c", "wc -c"], { stdin: stream });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), String(SIZE));
  });
});

test("exec write() reports backpressure and drain() releases it", {
  skip,
  timeout: 120_000,
}, async () => {
  await withVm(vmKey, vmOptions, async (vm) => {
    const proc = vm.exec(["/bin/sh", "-c", "sleep 1; wc -c"], { stdin: true });
    const chunk = Buffer.alloc(256 * 1024, 0x63);
    let sawBackpressure = false;
    for (let sent = 0; sent < SIZE; sent += chunk.length) {
      if (!proc.write(chunk)) {
        sawBackpressure = true;
        await proc.drain();
      }
    }
    proc.end();
    const result = await proc;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), String(SIZE));
    assert.ok(sawBackpressure, "expected write() to signal backpressure");
  });
});

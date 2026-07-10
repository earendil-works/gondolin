import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import * as child_process from "child_process";

import { __test as controllerTest } from "../src/sandbox/controller.ts";

// In ESM, built-in modules expose live bindings via getters which cannot be
// replaced with node:test mocks. The actual mutable exports object is on
// `default`. (Matches the pattern used in sandbox-controller.test.ts.)
const cp: any = (child_process as any).default ?? (child_process as any);

const { primeAccelProbeCache, qemuCanInitializeAccel } = controllerTest as any;

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill() {
    this.killed = true;
    return true;
  }
}

afterEach(() => {
  mock.restoreAll();
});

test("primeAccelProbeCache resolves true and warms the cache on exit code 0", async () => {
  let spawnCalls = 0;
  let child: FakeChildProcess;
  mock.method(cp, "spawn", () => {
    spawnCalls++;
    child = new FakeChildProcess();
    setImmediate(() => child.emit("exit", 0));
    return child as any;
  });

  await primeAccelProbeCache("qemu-prime-test-ok", "whpx");
  assert.equal(spawnCalls, 1);

  // A warm cache must short-circuit qemuCanInitializeAccel's own spawnSync
  // probe entirely -- assert spawnSync is never called for this lookup.
  let spawnSyncCalls = 0;
  mock.method(cp, "spawnSync", () => {
    spawnSyncCalls++;
    return { status: 1 };
  });

  assert.equal(qemuCanInitializeAccel("qemu-prime-test-ok", "whpx"), true);
  assert.equal(spawnSyncCalls, 0);
});

test("primeAccelProbeCache resolves false and warms the cache on non-zero exit", async () => {
  mock.method(cp, "spawn", () => {
    const child = new FakeChildProcess();
    setImmediate(() => child.emit("exit", 1));
    return child as any;
  });

  await primeAccelProbeCache("qemu-prime-test-fail", "whpx");

  let spawnSyncCalls = 0;
  mock.method(cp, "spawnSync", () => {
    spawnSyncCalls++;
    return { status: 0 };
  });

  assert.equal(qemuCanInitializeAccel("qemu-prime-test-fail", "whpx"), false);
  assert.equal(spawnSyncCalls, 0);
});

test("primeAccelProbeCache resolves false when spawn errors (e.g. missing binary)", async () => {
  mock.method(cp, "spawn", () => {
    const child = new FakeChildProcess();
    setImmediate(() =>
      child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
    return child as any;
  });

  await primeAccelProbeCache("qemu-prime-test-missing", "whpx");

  let spawnSyncCalls = 0;
  mock.method(cp, "spawnSync", () => {
    spawnSyncCalls++;
    return { status: 0 };
  });

  assert.equal(qemuCanInitializeAccel("qemu-prime-test-missing", "whpx"), false);
  assert.equal(spawnSyncCalls, 0);
});

test("primeAccelProbeCache treats a still-running probe past the timeout as available", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let killed = false;
  mock.method(cp, "spawn", () => {
    const child = new FakeChildProcess();
    child.kill = () => {
      killed = true;
      return true;
    };
    // Never emits exit/error on its own -- simulates a running QEMU idling
    // at `-S`, which is what a successful WHPX init looks like.
    return child as any;
  });

  const primePromise = primeAccelProbeCache("qemu-prime-test-timeout", "whpx");
  mock.timers.tick(1500);
  await primePromise;

  assert.equal(killed, true);

  let spawnSyncCalls = 0;
  mock.method(cp, "spawnSync", () => {
    spawnSyncCalls++;
    return { status: 1 };
  });
  assert.equal(qemuCanInitializeAccel("qemu-prime-test-timeout", "whpx"), true);
  assert.equal(spawnSyncCalls, 0);
});

test("primeAccelProbeCache does not re-probe when the cache is already warm", async () => {
  let spawnCalls = 0;
  mock.method(cp, "spawn", () => {
    spawnCalls++;
    const child = new FakeChildProcess();
    setImmediate(() => child.emit("exit", 0));
    return child as any;
  });

  await primeAccelProbeCache("qemu-prime-test-idempotent", "whpx");
  await primeAccelProbeCache("qemu-prime-test-idempotent", "whpx");
  assert.equal(spawnCalls, 1);
});

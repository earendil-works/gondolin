import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";

import { VirtioBridge } from "../src/sandbox/server-transport.ts";

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

test("VirtioBridge retries reconnect attempts after async connect failures", async () => {
  mock.timers.enable();

  const bridge = new VirtioBridge({
    transport: "tcp",
    host: "127.0.0.1",
    port: 0,
  });

  let attempts = 0;
  (bridge as any).connect = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("bind failed");
    }
  };

  (bridge as any).scheduleReconnect();

  mock.timers.tick(500);
  await Promise.resolve();

  assert.equal(attempts, 1);
  assert.ok((bridge as any).reconnectTimer);

  mock.timers.tick(500);
  await Promise.resolve();

  assert.equal(attempts, 2);

  await bridge.disconnect();
});

test("VirtioBridge temporary disconnect keeps the bridge reusable", async () => {
  const bridge = new VirtioBridge({
    transport: "tcp",
    host: "127.0.0.1",
    port: 0,
  });

  let attempts = 0;
  (bridge as any).connect = async () => {
    attempts += 1;
  };

  await bridge.disconnect({ permanent: false });

  assert.equal(bridge.send({ v: 1, t: "test" }), true);
  await Promise.resolve();

  assert.equal(attempts, 1);

  await bridge.disconnect();
});

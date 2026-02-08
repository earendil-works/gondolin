import assert from "node:assert/strict";
import test from "node:test";

import { GondolinListeners } from "../src/ingress";
import { MemoryProvider } from "../src/vfs";

test("GondolinListeners: invalid listeners file does not crash and keeps old routes", async () => {
  const etcProvider = new MemoryProvider();
  const listeners = new GondolinListeners(etcProvider);

  // seed with a valid route
  listeners.setRoutes([{ prefix: "/", port: 8080, stripPrefix: true }]);

  // write an invalid config
  const handle = etcProvider.openSync("/listeners", "w");
  try {
    handle.writeFileSync("not-a-route\n");
  } finally {
    handle.closeSync();
  }

  const gotError = new Promise<unknown>((resolve) => {
    listeners.once("reloadError", resolve);
  });

  listeners.notifyDirty();

  const err = await gotError;
  assert.ok(err instanceof Error);
  assert.match((err as Error).message, /invalid listeners file line 1/);

  // old routes remain
  assert.deepEqual(listeners.getRoutes(), [{ prefix: "/", port: 8080, stripPrefix: true }]);
  assert.ok(listeners.getLastReloadError());
});

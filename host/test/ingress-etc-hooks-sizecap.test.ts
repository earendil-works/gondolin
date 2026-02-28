import assert from "node:assert/strict";
import test from "node:test";

import { GondolinListeners, createGondolinEtcHooks } from "../src/ingress.ts";
import { MemoryProvider } from "../src/vfs/node/index.ts";

test("createGondolinEtcHooks: enforces /etc/gondolin/listeners size cap on write", () => {
  const provider = new MemoryProvider();
  const listeners = new GondolinListeners(provider);
  const hooks = createGondolinEtcHooks(listeners, provider);

  const MAX = 64 * 1024;

  assert.throws(
    () =>
      hooks.before?.({
        op: "write",
        path: "/etc/gondolin/listeners",
        offset: 0,
        length: MAX + 1,
      } as any),
    /too large/,
  );

  assert.throws(
    () =>
      hooks.before?.({
        op: "write",
        path: "/etc/gondolin/listeners",
        offset: MAX - 1,
        length: 2,
      } as any),
    /too large/,
  );
});

test("createGondolinEtcHooks: append writes enforce cap and do not mis-error", () => {
  const provider = new MemoryProvider();
  const listeners = new GondolinListeners(provider);
  const hooks = createGondolinEtcHooks(listeners, provider);

  const MAX = 64 * 1024;

  // Small append when file doesn't exist should be allowed.
  assert.doesNotThrow(() => {
    hooks.before?.({
      op: "write",
      path: "/etc/gondolin/listeners",
      length: 1,
    } as any);
  });

  // Grow file near the cap.
  const h = provider.openSync("/listeners", "w");
  try {
    h.truncateSync(MAX - 1);
  } finally {
    h.closeSync();
  }

  // Append would exceed cap.
  assert.throws(
    () =>
      hooks.before?.({
        op: "write",
        path: "/etc/gondolin/listeners",
        length: 2,
      } as any),
    /too large/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { GondolinListeners, createGondolinEtcHooks } from "../src/ingress";
import { MemoryProvider } from "../src/vfs";

test("createGondolinEtcHooks: enforces /etc/gondolin/listeners size cap on write", () => {
  const listeners = new GondolinListeners(new MemoryProvider());
  const hooks = createGondolinEtcHooks(listeners);

  const MAX = 64 * 1024;

  assert.throws(
    () =>
      hooks.before?.({
        op: "write",
        path: "/etc/gondolin/listeners",
        offset: 0,
        length: MAX + 1,
      } as any),
    /too large/
  );

  assert.throws(
    () =>
      hooks.before?.({
        op: "write",
        path: "/etc/gondolin/listeners",
        offset: MAX - 1,
        length: 2,
      } as any),
    /too large/
  );
});

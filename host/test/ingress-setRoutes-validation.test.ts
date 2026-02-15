import assert from "node:assert/strict";
import test from "node:test";

import { GondolinListeners } from "../src/ingress";
import { MemoryProvider } from "../src/vfs/node";

test("GondolinListeners.setRoutes validates port range", () => {
  const listeners = new GondolinListeners(new MemoryProvider());

  assert.throws(
    () => listeners.setRoutes([{ prefix: "/", port: 0, stripPrefix: true }]),
    /invalid ingress route port/i,
  );

  assert.throws(
    () =>
      listeners.setRoutes([{ prefix: "/", port: 70000, stripPrefix: true }]),
    /invalid ingress route port/i,
  );
});

test("GondolinListeners.setRoutes validates prefix and stripPrefix", () => {
  const listeners = new GondolinListeners(new MemoryProvider());

  assert.throws(
    () => listeners.setRoutes([{ prefix: "", port: 8080, stripPrefix: true }]),
    /invalid ingress route prefix/i,
  );

  assert.throws(
    () =>
      listeners.setRoutes([
        { prefix: "/bad prefix", port: 8080, stripPrefix: true },
      ]),
    /invalid ingress route prefix/i,
  );

  assert.throws(
    () =>
      listeners.setRoutes([
        { prefix: "/", port: 8080, stripPrefix: "yes" as any },
      ]),
    /invalid ingress route stripPrefix/i,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { resolveSandboxEngine } from "../src/native/config.ts";

test("choosing the node engine warns once (deprecated), native does not", async () => {
  const warnings: Error[] = [];
  const onWarning = (w: Error) => warnings.push(w);
  process.on("warning", onWarning);
  try {
    assert.equal(resolveSandboxEngine("native", {}), "native");
    assert.equal(resolveSandboxEngine("node", {}), "node");
    assert.equal(
      resolveSandboxEngine(undefined, { GONDOLIN_ENGINE: "node" }),
      "node",
    );
    // warnings are emitted on the next tick
    await new Promise((resolve) => setImmediate(resolve));
    const ours = warnings.filter(
      (w) => (w as NodeJS.ErrnoException).code === "GONDOLIN_NODE_ENGINE",
    );
    assert.equal(ours.length, 1);
    assert.equal(ours[0]!.name, "DeprecationWarning");
  } finally {
    process.off("warning", onWarning);
  }
});

test("a custom fetch does not move native egress to the JS network stack", async () => {
  const { NativeSandboxServer } = await import("../src/native/server.ts");
  const { resolveSandboxServerOptions } = await import(
    "../src/sandbox/server-options.ts"
  );
  const resolved = resolveSandboxServerOptions({
    fetch: (async () => new Response("x")) as never,
  });
  const server = new NativeSandboxServer(resolved, {}) as unknown as {
    network: unknown;
    nativeNetwork: unknown;
  };
  assert.equal(server.network, null);
  assert.notEqual(server.nativeNetwork, null);
});

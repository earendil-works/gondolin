import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  GondolinListeners,
  createGondolinEtcHooks,
  createGondolinEtcMount,
} from "../src/ingress";
import { MemoryProvider, SandboxVfsProvider, type VirtualProvider } from "../src/vfs";
import { MountRouterProvider, normalizeMountMap } from "../src/vfs/mounts";

function writeListenersLikeGuest(root: VirtualProvider, text: string) {
  // Simulate the guest's typical overwrite pattern:
  // open(O_WRONLY|O_TRUNC) -> truncate(0) -> write(offset=0) -> close
  const h = root.openSync("/etc/gondolin/listeners", "r+");
  try {
    h.truncateSync(0);
    const buf = Buffer.from(text, "utf8");
    h.writeSync(buf, 0, buf.length, 0);
  } finally {
    h.closeSync();
  }
}

async function waitForChanged(listeners: GondolinListeners, timeoutMs = 1000) {
  await Promise.race([
    once(listeners, "changed"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for listeners changed")), timeoutMs)),
  ]);
}

test("/etc/gondolin/listeners: guest writes can update routes repeatedly", async () => {
  const etcProvider = new MemoryProvider();
  const { listeners } = createGondolinEtcMount(etcProvider);

  // Mirror VM defaults: only a mount at /etc/gondolin (no explicit / mount)
  const mounts = normalizeMountMap({
    "/etc/gondolin": etcProvider,
  });

  const hooks = createGondolinEtcHooks(listeners, etcProvider);
  const root = new SandboxVfsProvider(new MountRouterProvider(mounts), hooks);

  // first update
  writeListenersLikeGuest(root, "/ :8000\n");
  await waitForChanged(listeners);
  assert.deepEqual(listeners.getRoutes(), [{ prefix: "/", port: 8000, stripPrefix: true }]);

  // second update
  writeListenersLikeGuest(root, "/ :8001\n");
  await waitForChanged(listeners);
  assert.deepEqual(listeners.getRoutes(), [{ prefix: "/", port: 8001, stripPrefix: true }]);
});

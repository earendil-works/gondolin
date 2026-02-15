import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { MemoryProvider } from "../src/vfs/node";
import { SandboxVfsProvider } from "../src/vfs/provider";

const { errno: ERRNO } = os.constants;

test("SandboxVfsProvider hooks wrap handle operations", async () => {
  const provider = new MemoryProvider();
  const events: string[] = [];

  const vfs = new SandboxVfsProvider(provider, {
    before: (ctx) => events.push(`before:${ctx.op}`),
    after: (ctx) => events.push(`after:${ctx.op}`),
  });

  const handle = await vfs.open("/file.txt", "w+");
  await handle.writeFile("hello");
  await handle.close();

  assert.deepEqual(events, [
    "before:open",
    "after:open",
    "before:writeFile",
    "after:writeFile",
    "before:release",
    "after:release",
  ]);
});

test("SandboxVfsProvider link delegates and emits hooks", async () => {
  const events: string[] = [];
  let linked: { oldPath: string; newPath: string } | null = null;

  const provider = Object.assign(new MemoryProvider(), {
    link: async (oldPath: string, newPath: string) => {
      linked = { oldPath, newPath };
    },
  });

  const vfs = new SandboxVfsProvider(provider, {
    before: (ctx) => events.push(`before:${ctx.op}`),
    after: (ctx) => events.push(`after:${ctx.op}`),
  });

  await vfs.link("/a", "/b");
  assert.deepEqual(linked, { oldPath: "/a", newPath: "/b" });
  assert.deepEqual(events, ["before:link", "after:link"]);
});

test("SandboxVfsProvider link returns ENOSYS without backend support", async () => {
  const vfs = new SandboxVfsProvider(new MemoryProvider());

  await assert.rejects(
    () => vfs.link("/a", "/b"),
    (err: unknown) => {
      const error = err as NodeJS.ErrnoException;
      return error.code === "ENOSYS" || error.errno === ERRNO.ENOSYS;
    },
  );
});

test("SandboxVfsProvider sync operations reject async hooks", () => {
  const provider = new MemoryProvider();
  const vfs = new SandboxVfsProvider(provider, {
    before: async () => {
      // async hook should not be used in sync API
    },
  });

  assert.throws(
    () => vfs.openSync("/file.txt", "w"),
    /async hook used in sync operation/,
  );
});

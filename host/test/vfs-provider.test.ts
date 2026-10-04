import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { MemoryProvider } from "../src/vfs/node/index.ts";
import { SandboxVfsProvider } from "../src/vfs/provider.ts";

const { errno: ERRNO } = os.constants;

test("SandboxVfsProvider hooks wrap handle operations", async () => {
  const provider = new MemoryProvider();
  const events: string[] = [];

  const vfs = new SandboxVfsProvider(provider, {
    before: (ctx) => {
      events.push(`before:${ctx.op}`);
    },
    after: (ctx) => {
      events.push(`after:${ctx.op}`);
    },
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
    before: (ctx) => {
      events.push(`before:${ctx.op}`);
    },
    after: (ctx) => {
      events.push(`after:${ctx.op}`);
    },
  });

  await vfs.link("/a", "/b");
  assert.deepEqual(linked, { oldPath: "/a", newPath: "/b" });
  assert.deepEqual(events, ["before:link", "after:link"]);
});

test("SandboxVfsProvider link returns ENOSYS without backend support", async () => {
  const backend = new Proxy(new MemoryProvider() as any, {
    get(target, prop, receiver) {
      if (prop === "link" || prop === "linkSync") {
        return undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const vfs = new SandboxVfsProvider(backend);

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

test("MemoryProvider handles observe truncates made through other paths", async () => {
  const provider = new MemoryProvider();
  const seed = await provider.open("/file.txt", "w+");
  await seed.writeFile("x".repeat(618));
  await seed.close();

  // Mirrors FUSE without atomic O_TRUNC: open, truncate by path, then write
  const handle = await provider.open("/file.txt", "r+");
  const truncater = await provider.open("/file.txt", "r+");
  await truncater.truncate(0);
  await truncater.close();
  const data = Buffer.from("short\n");
  await handle.write(data, 0, data.length, 0);
  assert.equal((await handle.stat()).size, data.length);
  await handle.close();
  assert.equal(await readMemoryFile(provider, "/file.txt"), "short\n");

  // ftruncate through one handle while another handle keeps writing
  const a = await provider.open("/file.txt", "r+");
  const b = await provider.open("/file.txt", "r+");
  await a.truncate(0);
  await b.write(Buffer.from("ab"), 0, 2, 0);
  await a.close();
  await b.close();
  assert.equal(await readMemoryFile(provider, "/file.txt"), "ab");
});

async function readMemoryFile(provider: MemoryProvider, path: string) {
  const handle = await provider.open(path, "r");
  try {
    return (await handle.readFile("utf8")).toString();
  } finally {
    await handle.close();
  }
}

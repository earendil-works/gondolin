import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProvider } from "../src/vfs";
import type { VfsStatfs } from "../src/vfs/node";
import {
  MountRouterProvider,
  listMountPaths,
  normalizeMountMap,
  normalizeMountPath,
} from "../src/vfs/mounts";

const isENOENT = (err: unknown) => {
  const error = err as NodeJS.ErrnoException;
  return error.code === "ENOENT" || error.code === "ERRNO_2" || error.errno === 2;
};

const isEXDEV = (err: unknown) => {
  const error = err as NodeJS.ErrnoException;
  return error.code === "EXDEV" || error.code === "ERRNO_18" || error.errno === 18;
};

test("normalizeMountPath validates and normalizes", () => {
  assert.throws(() => normalizeMountPath(""), /non-empty string/);
  assert.throws(() => normalizeMountPath("relative"), /must be absolute/);
  assert.throws(() => normalizeMountPath("/bad\0path"), /null bytes/);
  assert.equal(normalizeMountPath("/data/"), "/data");
});

test("normalizeMountMap rejects invalid providers and duplicates", () => {
  const provider = new MemoryProvider();
  assert.throws(() => normalizeMountMap({ "/data": {} as any }), /invalid/);
  assert.throws(
    () => normalizeMountMap({ "/data": provider, "/data/": provider }),
    /duplicate mount path/
  );
});

test("listMountPaths sorts normalized entries", () => {
  const provider = new MemoryProvider();
  const paths = listMountPaths({ "/b": provider, "/a/": provider });
  assert.deepEqual(paths, ["/a", "/b"]);
});

test("MountRouterProvider merges virtual children", async () => {
  const rootProvider = new MemoryProvider();
  const rootHandle = await rootProvider.open("/root.txt", "w+");
  await rootHandle.writeFile("root");
  await rootHandle.close();

  const appProvider = new MemoryProvider();
  const appHandle = await appProvider.open("/info.txt", "w+");
  await appHandle.writeFile("info");
  await appHandle.close();

  const router = new MountRouterProvider({ "/": rootProvider, "/app": appProvider });

  const rootEntries = await router.readdir("/");
  assert.ok(rootEntries.includes("root.txt"));
  assert.ok(rootEntries.includes("app"));

  const appStats = await router.stat("/app");
  assert.ok(appStats.isDirectory());

  const appEntries = await router.readdir("/app");
  assert.ok(appEntries.includes("info.txt"));

  await assert.rejects(
    () => router.rename("/root.txt", "/app/other.txt"),
    isEXDEV
  );
});

test("MountRouterProvider exposes virtual root without base mount", async () => {
  const dataProvider = new MemoryProvider();
  const router = new MountRouterProvider({ "/data": dataProvider });

  const rootEntries = await router.readdir("/");
  assert.deepEqual(rootEntries, ["data"]);

  const rootStats = await router.stat("/");
  assert.ok(rootStats.isDirectory());

  await assert.rejects(() => router.open("/missing.txt", "r"), isENOENT);
});

test("MountRouterProvider resolves deep nested mounts and normalizes .. traversal", async () => {
  const write = async (provider: MemoryProvider, p: string, contents: string) => {
    const fh = await provider.open(p, "w+");
    await fh.writeFile(contents);
    await fh.close();
  };

  const root = new MemoryProvider();
  const a = new MemoryProvider();
  const b = new MemoryProvider();
  const c = new MemoryProvider();

  await write(root, "/root.txt", "root");
  await write(a, "/id.txt", "A");
  await write(b, "/id.txt", "B");
  await write(c, "/id.txt", "C");

  const router = new MountRouterProvider({
    "/": root,
    "/a": a,
    "/a/b": b,
    "/a/b/c": c,
  });

  // Longest-prefix mount should win.
  {
    const fh = await router.open("/a/b/c/id.txt", "r");
    const data = await fh.readFile({ encoding: "utf8" });
    await fh.close();
    assert.equal(data, "C");
  }
  {
    const fh = await router.open("/a/b/id.txt", "r");
    const data = await fh.readFile({ encoding: "utf8" });
    await fh.close();
    assert.equal(data, "B");
  }
  {
    const fh = await router.open("/a/id.txt", "r");
    const data = await fh.readFile({ encoding: "utf8" });
    await fh.close();
    assert.equal(data, "A");
  }

  // Virtual dirs should exist at mount boundaries.
  assert.equal((await router.stat("/a")).isDirectory(), true);
  assert.equal((await router.stat("/a/b")).isDirectory(), true);

  // Traversal should be normalized before routing.
  {
    const fh = await router.open("/a/b/c/../id.txt", "r");
    const data = await fh.readFile({ encoding: "utf8" });
    await fh.close();
    assert.equal(data, "B");
  }
  {
    const fh = await router.open("/a/../root.txt", "r");
    const data = await fh.readFile({ encoding: "utf8" });
    await fh.close();
    assert.equal(data, "root");
  }
});

test("MountRouterProvider virtual child mount masks conflicting base entry", async () => {
  const rootProvider = new MemoryProvider();
  const rootAppHandle = await rootProvider.open("/app", "w+");
  await rootAppHandle.writeFile("this is a file named app");
  await rootAppHandle.close();

  const appProvider = new MemoryProvider();
  const appFileHandle = await appProvider.open("/info.txt", "w+");
  await appFileHandle.writeFile("info");
  await appFileHandle.close();

  const router = new MountRouterProvider({ "/": rootProvider, "/app": appProvider });

  const entries = (await router.readdir("/", { withFileTypes: true })) as Array<{ name: string; isDirectory(): boolean }>;
  const app = entries.find((e) => e.name === "app");
  assert.ok(app);
  assert.equal(app!.isDirectory(), true);
});

test("MountRouterProvider statfs returns synthetic defaults for virtual dirs", async () => {
  const dataProvider = new MemoryProvider();
  const router = new MountRouterProvider({ "/data": dataProvider });

  const statfs = await router.statfs("/");
  assert.ok(statfs);
  assert.equal(statfs.bsize, 4096);
  assert.ok(statfs.blocks > 0);
  assert.ok(statfs.bfree <= statfs.blocks);
});

test("MountRouterProvider statfs delegates to mounted provider", async () => {
  const customStatfs: VfsStatfs = {
    blocks: 1000, bfree: 500, bavail: 400,
    files: 2000, ffree: 1500,
    bsize: 4096, frsize: 4096, namelen: 255,
  };

  const dataProvider = Object.assign(new MemoryProvider(), {
    statfs: async (_path: string) => customStatfs,
  });

  const router = new MountRouterProvider({ "/data": dataProvider });
  const statfs = await router.statfs("/data");
  assert.equal(statfs.blocks, 1000);
  assert.equal(statfs.bfree, 500);
  assert.equal(statfs.bavail, 400);
});

test("MountRouterProvider statfs on virtual root prefers mounted provider stats", async () => {
  const customStatfs: VfsStatfs = {
    blocks: 2222,
    bfree: 1111,
    bavail: 1000,
    files: 3333,
    ffree: 3000,
    bsize: 4096,
    frsize: 4096,
    namelen: 255,
  };

  const workspaceProvider = Object.assign(new MemoryProvider(), {
    statfs: async (_path: string) => customStatfs,
  });

  const router = new MountRouterProvider({ "/workspace": workspaceProvider, "/tmp": new MemoryProvider() });
  const statfs = await router.statfs("/");
  assert.equal(statfs.blocks, 2222);
  assert.equal(statfs.bfree, 1111);
  assert.equal(statfs.bavail, 1000);
});

test("MountRouterProvider statfs probe rethrows non-fallback errors", async () => {
  const expected = createErrorWithErrno("EIO", 5);
  const badProvider = Object.assign(new MemoryProvider(), {
    statfs: async (_path: string) => {
      throw expected;
    },
  });

  const router = new MountRouterProvider({ "/workspace": badProvider });
  await assert.rejects(() => router.statfs("/"), (error) => error === expected);
});

function createErrorWithErrno(code: string, errno: number) {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  error.errno = errno;
  return error;
}

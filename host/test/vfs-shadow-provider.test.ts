import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProvider, ShadowProvider } from "../src/vfs";

const isENOENT = (err: unknown) => {
  const error = err as NodeJS.ErrnoException;
  return error.code === "ENOENT" || error.code === "ERRNO_2" || error.errno === 2;
};

const isEACCES = (err: unknown) => {
  const error = err as NodeJS.ErrnoException;
  return error.code === "EACCES" || error.code === "ERRNO_13" || error.errno === 13;
};

test("ShadowProvider (deny mode) hides entries and blocks writes", async () => {
  const backend = new MemoryProvider();

  {
    const fh = await backend.open("/visible.txt", "w+");
    await fh.writeFile("ok");
    await fh.close();
  }
  {
    const fh = await backend.open("/.envrc", "w+");
    await fh.writeFile("SECRET");
    await fh.close();
  }

  const vfs = new ShadowProvider(backend, {
    shadowPaths: ["/.envrc"],
    writeMode: "deny",
  });

  // read behaves like ENOENT
  await assert.rejects(async () => vfs.stat("/.envrc"), isENOENT);
  await assert.rejects(async () => vfs.open("/.envrc", "r"), isENOENT);

  // directory listing omits
  const entries = await vfs.readdir("/");
  assert.ok(entries.includes("visible.txt"));
  assert.ok(!entries.includes(".envrc"));

  // write is denied
  await assert.rejects(async () => vfs.open("/.envrc", "w+"), isEACCES);
});

test("ShadowProvider (tmpfs mode) lets guest create its own shadowed file", async () => {
  const backend = new MemoryProvider();

  {
    const fh = await backend.open("/.envrc", "w+");
    await fh.writeFile("HOST_SECRET");
    await fh.close();
  }

  const vfs = new ShadowProvider(backend, {
    shadowPaths: ["/.envrc"],
    writeMode: "tmpfs",
  });

  // Initially: hidden
  await assert.rejects(async () => vfs.open("/.envrc", "r"), isENOENT);
  assert.ok(!(await vfs.readdir("/")).includes(".envrc"));

  // Write creates it in tmpfs
  {
    const fh = await vfs.open("/.envrc", "w+");
    await fh.writeFile("GUEST_VALUE");
    await fh.close();
  }

  // Now visible to guest
  {
    const fh = await vfs.open("/.envrc", "r");
    const data = await fh.readFile({ encoding: "utf8" });
    await fh.close();
    assert.equal(data, "GUEST_VALUE");
  }

  const entries = await vfs.readdir("/");
  assert.ok(entries.includes(".envrc"));

  // Underlying is untouched
  {
    const fh = await backend.open("/.envrc", "r");
    const backendData = (await fh.readFile({ encoding: "utf8" })) as string;
    await fh.close();
    assert.equal(backendData, "HOST_SECRET");
  }
});

test("ShadowProvider denies symlink bypass by default", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const backend = new MemoryProvider();

  {
    const fh = await backend.open("/.envrc", "w+");
    await fh.writeFile("SECRET");
    await fh.close();
  }

  backend.symlinkSync(".envrc", "/link");

  const vfs = new ShadowProvider(backend, {
    shadowPaths: ["/.envrc"],
    writeMode: "deny",
  });

  await assert.rejects(async () => vfs.open("/link", "r"), isENOENT);
  await assert.rejects(async () => vfs.stat("/link"), isENOENT);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { RealFSProvider } from "../src/vfs/node";

const isENOENT = (err: unknown) => {
  const error = err as NodeJS.ErrnoException;
  return (
    error.code === "ENOENT" || error.code === "ERRNO_2" || error.errno === 2
  );
};

function makeTempDir(t: TestContext, prefix = "gondolin-vfs-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("RealFSProvider proxies filesystem operations (sync + async)", async (t) => {
  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);

  assert.equal(provider.readonly, false);
  assert.equal(provider.supportsSymlinks, true);
  assert.equal(provider.supportsWatch, false);
  assert.equal(provider.rootPath, fs.realpathSync(path.resolve(root)));

  // mkdir / readdir
  provider.mkdirSync("/dir");
  provider.mkdirSync("/dir/sub");

  const dirEntries = provider.readdirSync("/dir");
  assert.ok(dirEntries.includes("sub"));

  // open + write + stat
  {
    const fh = provider.openSync("/dir/hello.txt", "w+");
    fh.writeFileSync("hello");
    assert.equal(fh.statSync().isFile(), true);
    fh.closeSync();
  }

  const st = provider.statSync("/dir/hello.txt");
  assert.equal(st.isFile(), true);

  // rename + access
  provider.renameSync("/dir/hello.txt", "/dir/renamed.txt");
  provider.accessSync("/dir/renamed.txt", fs.constants.R_OK);

  // hard link
  provider.linkSync("/dir/renamed.txt", "/dir/linked.txt");
  assert.equal(provider.statSync("/dir/renamed.txt").nlink, 2);

  // truncate via file handle
  {
    const fh = await provider.open("/dir/renamed.txt", "r+");
    await fh.truncate(2);
    await fh.close();

    const check = await provider.open("/dir/renamed.txt", "r");
    const contents = await check.readFile({ encoding: "utf8" });
    await check.close();
    assert.equal(contents, "he");
  }

  // unlink + rmdir (async)
  await provider.unlink("/dir/linked.txt");
  await provider.unlink("/dir/renamed.txt");
  await provider.rmdir("/dir/sub");
  await provider.rmdir("/dir");

  await assert.rejects(() => provider.stat("/dir"), isENOENT);
});

test("RealFSProvider blocks path traversal outside root", (t) => {
  const root = makeTempDir(t);
  const parent = path.dirname(root);
  const outsidePath = path.join(parent, "outside.txt");
  fs.writeFileSync(outsidePath, "outside");
  t.after(() => {
    fs.rmSync(outsidePath, { force: true });
  });

  const provider = new RealFSProvider(root);

  assert.throws(() => provider.openSync("/../outside.txt", "r"), isENOENT);
  assert.throws(() => provider.statSync("/../outside.txt"), isENOENT);
  assert.throws(() => provider.readdirSync("/../"), isENOENT);

  // A more complex traversal should be blocked as well.
  assert.throws(
    () => provider.openSync("/a/b/../../../../outside.txt", "r"),
    isENOENT,
  );
});

test("RealFSProvider symlink, readlink, lstat, realpath", (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);

  fs.writeFileSync(path.join(root, "target.txt"), "ok");

  provider.symlinkSync("target.txt", "/link.txt");

  const linkTarget = provider.readlinkSync("/link.txt");
  assert.equal(linkTarget, "target.txt");

  const lst = provider.lstatSync("/link.txt");
  assert.equal(lst.isSymbolicLink(), true);

  const st = provider.statSync("/link.txt");
  assert.equal(st.isFile(), true);

  const resolved = provider.realpathSync("/link.txt");
  assert.equal(resolved, "/target.txt");
});

test("RealFSProvider statfs reports host filesystem stats", async (t) => {
  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);

  assert.ok(provider.statfs, "RealFSProvider should expose statfs");
  const statfs = await provider.statfs!("/");

  assert.ok(statfs.blocks > 0);
  assert.ok(statfs.bsize > 0);
  assert.ok(statfs.frsize > 0);
  assert.ok(statfs.bfree <= statfs.blocks);
  assert.ok(statfs.bavail <= statfs.bfree);
  assert.ok(statfs.ffree <= statfs.files);
});

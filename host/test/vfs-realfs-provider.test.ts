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

test("RealFSProvider blocks read via pre-existing escaping symlink", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);

  const outsideDir = makeTempDir(t, "gondolin-outside-");
  const outsideFile = path.join(outsideDir, "secret.txt");
  fs.writeFileSync(outsideFile, "secret-data");
  fs.symlinkSync(outsideFile, path.join(root, "escape-link"));

  assert.throws(() => provider.openSync("/escape-link", "r"), isENOENT);
  assert.throws(() => provider.statSync("/escape-link"), isENOENT);
  await assert.rejects(() => provider.open("/escape-link", "r"), isENOENT);
  await assert.rejects(() => provider.stat("/escape-link"), isENOENT);
});

test("RealFSProvider blocks create under symlinked parent escaping root", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);
  const outsideDir = makeTempDir(t, "gondolin-outside-parent-");
  fs.symlinkSync(outsideDir, path.join(root, "parent-escape"));

  assert.throws(
    () => provider.openSync("/parent-escape/file.txt", "w"),
    isENOENT,
  );
  await assert.rejects(
    () => provider.open("/parent-escape/file.txt", "w"),
    isENOENT,
  );
  assert.throws(() => provider.readdirSync("/parent-escape"), isENOENT);
  assert.equal(fs.readdirSync(outsideDir).length, 0);
});

test("RealFSProvider allows lstat/readlink/unlink on escaping symlink inside root", (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);
  const outsideDir = makeTempDir(t, "gondolin-outside-");
  const outsideFile = path.join(outsideDir, "target.txt");
  fs.writeFileSync(outsideFile, "data");
  fs.symlinkSync(outsideFile, path.join(root, "escape-link"));

  const lst = provider.lstatSync("/escape-link");
  assert.equal(lst.isSymbolicLink(), true);

  const target = provider.readlinkSync("/escape-link");
  assert.equal(target, outsideFile);

  provider.unlinkSync("/escape-link");
  assert.throws(() => fs.lstatSync(path.join(root, "escape-link")), {
    code: "ENOENT",
  });
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "data");
});

test("RealFSProvider blocks unlink through escaping intermediate symlink", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);
  const outsideDir = makeTempDir(t, "gondolin-outside-");
  const outsideFile = path.join(outsideDir, "victim.txt");
  fs.writeFileSync(outsideFile, "data");
  fs.symlinkSync(outsideDir, path.join(root, "evil"));

  assert.throws(() => provider.unlinkSync("/evil/victim.txt"), isENOENT);
  await assert.rejects(() => provider.unlink("/evil/victim.txt"), isENOENT);
  assert.equal(fs.existsSync(outsideFile), true);
});

test("RealFSProvider allows in-root relative symlink", (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);
  fs.mkdirSync(path.join(root, "a"));
  fs.mkdirSync(path.join(root, "b"));
  fs.writeFileSync(path.join(root, "b", "file.txt"), "in-root-data");
  fs.symlinkSync("../b/file.txt", path.join(root, "a", "link"));

  const fh = provider.openSync("/a/link", "r");
  const contents = fh.readFileSync({ encoding: "utf8" });
  fh.closeSync();
  assert.equal(contents, "in-root-data");

  const st = provider.statSync("/a/link");
  assert.equal(st.isFile(), true);
});

test("RealFSProvider allows in-root absolute symlink", (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const resolvedRoot = fs.realpathSync(root);
  const provider = new RealFSProvider(root);
  fs.writeFileSync(path.join(resolvedRoot, "real-file.txt"), "absolute-ok");
  fs.symlinkSync(
    path.join(resolvedRoot, "real-file.txt"),
    path.join(resolvedRoot, "abs-link"),
  );

  const fh = provider.openSync("/abs-link", "r");
  const contents = fh.readFileSync({ encoding: "utf8" });
  fh.closeSync();
  assert.equal(contents, "absolute-ok");

  const st = provider.statSync("/abs-link");
  assert.equal(st.isFile(), true);
});

test("RealFSProvider blocks dangling escaping symlink on write", (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);
  const outsideTarget = path.join(
    os.tmpdir(),
    "gondolin-dangling-" + Date.now(),
  );
  t.after(() => {
    fs.rmSync(outsideTarget, { force: true });
  });
  fs.symlinkSync(outsideTarget, path.join(root, "dangling-escape"));

  assert.throws(() => provider.openSync("/dangling-escape", "w"), isENOENT);
  assert.equal(fs.existsSync(outsideTarget), false);
});

test("RealFSProvider allows write via dangling symlink inside root", (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);
  fs.symlinkSync("target.txt", path.join(root, "safe-dangling"));

  const fh = provider.openSync("/safe-dangling", "w");
  fh.writeFileSync("created-via-symlink");
  fh.closeSync();

  assert.equal(
    fs.readFileSync(path.join(root, "target.txt"), "utf8"),
    "created-via-symlink",
  );
});

test("RealFSProvider blocks hard-link to escaping symlink target", (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);
  const outsideDir = makeTempDir(t, "gondolin-outside-");
  const outsideFile = path.join(outsideDir, "secret.txt");
  fs.writeFileSync(outsideFile, "secret");
  fs.symlinkSync(outsideFile, path.join(root, "escape-link"));

  assert.throws(() => provider.linkSync("/escape-link", "/copy"), isENOENT);
});

test("RealFSProvider blocks hard-link destination through escaping intermediate symlink", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);
  const outsideDir = makeTempDir(t, "gondolin-outside-");
  fs.writeFileSync(path.join(root, "source.txt"), "source");
  fs.symlinkSync(outsideDir, path.join(root, "evil"));

  assert.throws(
    () => provider.linkSync("/source.txt", "/evil/linked.txt"),
    isENOENT,
  );
  await assert.rejects(
    () => provider.link("/source.txt", "/evil/linked.txt"),
    isENOENT,
  );
  assert.equal(fs.readdirSync(outsideDir).length, 0);
});

test("RealFSProvider blocks chained dangling symlink escape", (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);
  const outsideTarget = path.join(os.tmpdir(), "gondolin-chain-" + Date.now());
  t.after(() => {
    fs.rmSync(outsideTarget, { force: true });
  });

  fs.symlinkSync(outsideTarget, path.join(root, "level1"));
  fs.symlinkSync("level1", path.join(root, "level2"));

  assert.throws(() => provider.openSync("/level2", "w"), isENOENT);
  assert.equal(fs.existsSync(outsideTarget), false);
});

test("RealFSProvider blocks mkdir through escaping intermediate symlink", (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);
  const outsideDir = makeTempDir(t, "gondolin-outside-");
  fs.symlinkSync(outsideDir, path.join(root, "evil"));

  assert.throws(() => provider.mkdirSync("/evil/subdir"), isENOENT);
  assert.equal(fs.readdirSync(outsideDir).length, 0);
});

test("RealFSProvider blocks rename through escaping intermediate symlink", (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics require elevated permissions on Windows");
  }

  const root = makeTempDir(t);
  const provider = new RealFSProvider(root);
  const outsideDir = makeTempDir(t, "gondolin-outside-");
  fs.symlinkSync(outsideDir, path.join(root, "evil"));
  fs.writeFileSync(path.join(root, "file.txt"), "data");

  assert.throws(
    () => provider.renameSync("/file.txt", "/evil/file.txt"),
    isENOENT,
  );
  assert.equal(fs.readdirSync(outsideDir).length, 0);
  assert.ok(fs.existsSync(path.join(root, "file.txt")));
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

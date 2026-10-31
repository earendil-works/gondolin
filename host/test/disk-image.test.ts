import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { findE2fsprogsTool, findMke2fs } from "../src/alpine/utils.ts";
import { createDiskImage } from "../src/disk-image.ts";
import { isJournallessExtImage } from "../src/sandbox/extra-disks.ts";

function debugfsOrNull() {
  try {
    return findE2fsprogsTool(findMke2fs(), "debugfs");
  } catch {
    return null;
  }
}

const debugfs = debugfsOrNull();
const skip = debugfs === null ? "e2fsprogs unavailable" : false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-disk-image-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeTree(name: string) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "tool"), "#!/bin/sh\necho hi\n", {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(root, "data.bin"), randomBytes(3 * 1024 * 1024));
  fs.writeFileSync(path.join(root, 'odd "name"'), "x");
  fs.symlinkSync("bin/tool", path.join(root, "link"));
  return root;
}

function stat(image: string, guestPath: string) {
  return execFileSync(debugfs!, ["-R", `stat "${guestPath}"`, image], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function leftovers(dir: string) {
  return fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

test("createDiskImage builds a root-owned ext4 image sized to its contents", {
  skip,
}, async () => {
  const source = makeTree("tree");
  const out = path.join(tmp, "out", "tree.ext4");

  const image = await createDiskImage({ sourceDir: source, outputPath: out });

  assert.equal(image.path, out);
  assert.equal(fs.statSync(out).size, image.sizeBytes);
  // 3 MiB of data plus a few small files, with a few MiB of metadata headroom
  assert.ok(image.sizeBytes >= 3 * 1024 * 1024, String(image.sizeBytes));
  assert.ok(image.sizeBytes <= 12 * 1024 * 1024, String(image.sizeBytes));

  for (const guestPath of ["/", "/bin", "/bin/tool", "/data.bin", "/link"]) {
    assert.match(stat(out, guestPath), /User:\s+0\s+Group:\s+0\s/, guestPath);
  }
  assert.match(stat(out, '/odd ""name""'), /User:\s+0\s+Group:\s+0\s/);
  assert.match(stat(out, "/bin/tool"), /Mode:\s+0755/);
  assert.deepEqual(leftovers(path.dirname(out)), []);
  assert.equal(isJournallessExtImage(out), true);
});

test("createDiskImage gives a writable image a journal", {
  skip,
}, async () => {
  const source = makeTree("writable");
  const out = path.join(tmp, "writable.ext4");

  await createDiskImage({
    sourceDir: source,
    outputPath: out,
    allowWrite: true,
  });

  assert.equal(isJournallessExtImage(out), false);
});

test("createDiskImage honours an explicit size and replaces the output", {
  skip,
}, async () => {
  const source = makeTree("sized");
  const out = path.join(tmp, "sized.ext4");
  fs.writeFileSync(out, "previous");

  const image = await createDiskImage({
    sourceDir: source,
    outputPath: out,
    size: "32M",
  });

  assert.equal(image.sizeBytes, 32 * 1024 * 1024);
  assert.equal(fs.statSync(out).size, 32 * 1024 * 1024);
});

test("createDiskImage leaves the output untouched when the contents do not fit", {
  skip,
}, async () => {
  const source = makeTree("too-big");
  const out = path.join(tmp, "too-big.ext4");
  fs.writeFileSync(out, "previous");

  await assert.rejects(
    createDiskImage({ sourceDir: source, outputPath: out, size: "1M" }),
    /mke2fs failed/,
  );
  assert.equal(fs.readFileSync(out, "utf8"), "previous");
  assert.deepEqual(leftovers(tmp), []);
});

test("createDiskImage rejects a source that is not a directory", async () => {
  await assert.rejects(
    createDiskImage({
      sourceDir: path.join(tmp, "missing"),
      outputPath: path.join(tmp, "missing.ext4"),
    }),
    /disk image source is not a directory/,
  );
});

test("createDiskImage points at the docs when e2fsprogs is missing", () => {
  const source = makeTree("no-tools");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { createDiskImage } from ${JSON.stringify(path.join(import.meta.dirname, "..", "src", "disk-image.ts"))};
await createDiskImage({ sourceDir: process.argv[1], outputPath: process.argv[2] });`,
      source,
      path.join(tmp, "no-tools.ext4"),
    ],
    { env: { ...process.env, PATH: "" }, encoding: "utf8", timeout: 15000 },
  );
  if (result.status === 0) {
    // e2fsprogs is installed somewhere findMke2fs looks without PATH
    return;
  }
  assert.match(result.stderr, /requires e2fsprogs .*docs\/custom-images\.md/);
});

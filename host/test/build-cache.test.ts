import child_process from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectAlpineBuildCache,
  removeAlpineBuildCache,
  updateAlpineBuildCache,
} from "../src/build/cache.ts";

function createIndexArchive(tmp: string, version: string): Buffer {
  const sourceDir = path.join(tmp, `index-${version}`);
  const archivePath = path.join(tmp, `index-${version}.tar.gz`);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "APKINDEX"),
    `P:linux-virt\nV:${version}\nT:Linux lts kernel\n\nP:busybox\nV:1.0-r0\nT:Utilities\n`,
  );
  child_process.execFileSync("tar", [
    "-czf",
    archivePath,
    "-C",
    sourceDir,
    "APKINDEX",
  ]);
  return fs.readFileSync(archivePath);
}

test("build cache: inspect reports Alpine and kernel versions", () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cache-"));
  fs.writeFileSync(
    path.join(cacheDir, "alpine-minirootfs-3.23.0-x86_64.tar.gz"),
    "rootfs",
  );
  fs.writeFileSync(
    path.join(cacheDir, "APKINDEX-example-x86_64"),
    "P:linux-virt\nV:6.18.32-r0\nT:Linux lts kernel\n",
  );
  fs.writeFileSync(
    path.join(cacheDir, "x86_64-linux-virt-6.18.32-r0.apk"),
    "apk",
  );

  try {
    const info = inspectAlpineBuildCache(cacheDir);
    assert.equal(info.minirootfs[0]?.version, "3.23.0");
    assert.equal(info.minirootfs[0]?.arch, "x86_64");
    assert.deepEqual(info.indexes[0]?.kernelPackages, [
      { name: "linux-virt", version: "6.18.32-r0" },
    ]);
    assert.equal(info.packageArchiveCount, 1);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("build cache: remove deletes Alpine files but preserves other build data", () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cache-"));
  const alpineFiles = [
    "alpine-minirootfs-3.23.0-x86_64.tar.gz",
    "APKINDEX-example-x86_64",
    "APKINDEX-example-x86_64.tar.gz",
    "x86_64-linux-virt-6.18.32-r0.apk",
  ];
  for (const file of alpineFiles) {
    fs.writeFileSync(path.join(cacheDir, file), file);
  }
  fs.mkdirSync(path.join(cacheDir, "libkrunfw"));
  fs.writeFileSync(path.join(cacheDir, "unrelated"), "keep");

  try {
    const removed = removeAlpineBuildCache(cacheDir);
    assert.equal(removed.removedEntries, alpineFiles.length);
    for (const file of alpineFiles) {
      assert.equal(fs.existsSync(path.join(cacheDir, file)), false);
    }
    assert.equal(fs.existsSync(path.join(cacheDir, "libkrunfw")), true);
    assert.equal(fs.existsSync(path.join(cacheDir, "unrelated")), true);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("build cache: update atomically refreshes main and community indexes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cache-"));
  const cacheDir = path.join(tmp, "cache");
  const archive = createIndexArchive(tmp, "6.18.44-r0");
  const previousFetch = globalThis.fetch;
  const urls: string[] = [];

  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(archive, { status: 200 });
  };

  try {
    const updated = await updateAlpineBuildCache({
      arch: "x86_64",
      version: "3.23.0",
      mirror: "https://mirror.example/alpine/",
      cacheDir,
    });

    assert.equal(updated.length, 2);
    assert.deepEqual(urls, [
      "https://mirror.example/alpine/v3.23/main/x86_64/APKINDEX.tar.gz",
      "https://mirror.example/alpine/v3.23/community/x86_64/APKINDEX.tar.gz",
    ]);
    for (const indexPath of updated) {
      assert.match(fs.readFileSync(indexPath, "utf8"), /V:6\.18\.44-r0/);
      assert.equal(fs.existsSync(`${indexPath}.tar.gz`), true);
    }
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

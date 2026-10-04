import child_process from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import assert from "node:assert/strict";
import test from "node:test";

import { installPackages } from "../src/alpine/packages.ts";
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

test("build cache: installPackages refreshes stale indexes on 404", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cache-"));
  const cacheDir = path.join(tmp, "cache");
  const targetDir = path.join(tmp, "root");
  const repo = "https://mirror.example/alpine/v3.23/main";
  fs.mkdirSync(path.join(targetDir, "etc/apk"), { recursive: true });
  fs.writeFileSync(path.join(targetDir, "etc/apk/repositories"), `${repo}\n`);
  fs.mkdirSync(cacheDir, { recursive: true });

  // Stale cached index pointing at a version the mirror no longer serves
  const staleIndex = path.join(
    cacheDir,
    "APKINDEX-https_mirror_example_alpine_v3_23_main-x86_64",
  );
  fs.writeFileSync(staleIndex, "P:busybox\nV:1.0-r0\nT:Utilities\n");

  const apkDir = path.join(tmp, "apk");
  fs.mkdirSync(path.join(apkDir, "etc"), { recursive: true });
  fs.writeFileSync(path.join(apkDir, "etc/busybox-version"), "1.1\n");
  const apkPath = path.join(tmp, "busybox.apk");
  child_process.execFileSync("tar", ["-czf", apkPath, "-C", apkDir, "etc"]);
  const apk = fs.readFileSync(apkPath);

  // Upstream index after busybox was updated to 1.1-r0
  const indexSource = path.join(tmp, "fresh");
  fs.mkdirSync(indexSource);
  fs.writeFileSync(
    path.join(indexSource, "APKINDEX"),
    "P:busybox\nV:1.1-r0\nT:Utilities\n",
  );
  const freshArchive = path.join(tmp, "fresh.tar.gz");
  child_process.execFileSync("tar", [
    "-czf",
    freshArchive,
    "-C",
    indexSource,
    "APKINDEX",
  ]);

  const previousFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url === `${repo}/x86_64/APKINDEX.tar.gz`) {
      return new Response(fs.readFileSync(freshArchive), { status: 200 });
    }
    if (url === `${repo}/x86_64/busybox-1.1-r0.apk`) {
      return new Response(apk, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const logs: string[] = [];
    await installPackages(targetDir, ["busybox"], "x86_64", cacheDir, (msg) =>
      logs.push(msg),
    );

    assert.deepEqual(urls, [
      `${repo}/x86_64/busybox-1.0-r0.apk`,
      `${repo}/x86_64/APKINDEX.tar.gz`,
      `${repo}/x86_64/busybox-1.1-r0.apk`,
    ]);
    assert.ok(logs.some((msg) => /refreshing cached APKINDEX/.test(msg)));
    assert.match(fs.readFileSync(staleIndex, "utf8"), /V:1\.1-r0/);
    assert.equal(
      fs.readFileSync(path.join(targetDir, "etc/busybox-version"), "utf8"),
      "1.1\n",
    );
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

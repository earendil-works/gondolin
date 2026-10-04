import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import assert from "node:assert/strict";
import test from "node:test";

const hostDir = path.join(import.meta.dirname, "..");

function runCacheCommand(storeDir: string, args: string[], input?: string) {
  return spawnSync(
    process.execPath,
    ["bin/gondolin.ts", "build", "cache", ...args],
    {
      cwd: hostDir,
      env: { ...process.env, XDG_CACHE_HOME: storeDir },
      encoding: "utf8",
      input,
      timeout: 15000,
    },
  );
}

test("cli: build cache info reports an empty cache", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-cli-cache-"),
  );

  try {
    const result = runCacheCommand(storeDir, ["info"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Alpine build cache:/);
    assert.match(result.stdout, /Minirootfs: none/);
    assert.match(result.stdout, /Repository indexes: none/);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test("cli: build cache rm honors no and yes prompt responses", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-cli-cache-"),
  );
  const cacheDir = path.join(storeDir, "gondolin", "build");
  const cacheFile = path.join(cacheDir, "x86_64-linux-virt-1-r0.apk");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, "apk");

  try {
    const declined = runCacheCommand(storeDir, ["rm"], "n\n");
    assert.equal(declined.status, 0, declined.stderr);
    assert.match(declined.stdout, /Aborted/);
    assert.equal(fs.existsSync(cacheFile), true);

    const accepted = runCacheCommand(storeDir, ["rm"], "yes\n");
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Removed 1 cache entries/);
    assert.equal(fs.existsSync(cacheFile), false);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

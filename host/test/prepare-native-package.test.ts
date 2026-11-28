import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

test("native package stages the Windows daemon and rejects other executable formats", (t) => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-native-package-"),
  );
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const pkg = path.join(tmp, "package");
  fs.mkdirSync(pkg);
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "@earendil-works/gondolin-native-win32-x64",
      version: "0.0.0-test",
      os: ["win32"],
      cpu: ["x64"],
    }),
  );
  const source = path.join(tmp, "gondolind.exe");
  const binary = Buffer.alloc(128);
  binary.writeUInt16LE(0x5a4d, 0);
  binary.writeUInt32LE(64, 60);
  binary.writeUInt32LE(0x00004550, 64);
  binary.writeUInt16LE(0x8664, 68);
  const stage = () =>
    spawnSync(
      process.execPath,
      [
        "scripts/prepare-native-package.mjs",
        "--package",
        pkg,
        "--binary",
        source,
      ],
      { cwd: root, encoding: "utf8" },
    );
  fs.writeFileSync(source, binary);
  const result = stage();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    fs.readFileSync(path.join(pkg, "bin/gondolind.exe")),
    binary,
  );
  assert.equal(fs.existsSync(path.join(pkg, "bin/gondolin")), false);
  assert.equal(
    fs.readFileSync(path.join(pkg, "LICENSE"), "utf8"),
    fs.readFileSync(path.join(root, "LICENSE"), "utf8"),
  );
  for (const invalid of [
    "not a PE",
    "wrong architecture",
    "invalid PE offset",
  ]) {
    const bad = Buffer.from(binary);
    if (invalid === "not a PE") bad.fill(0);
    else if (invalid === "wrong architecture") bad.writeUInt16LE(0xaa64, 68);
    else bad.writeUInt32LE(0xffffffff, 60);
    fs.writeFileSync(source, bad);
    const rejected = stage();
    assert.notEqual(rejected.status, 0, invalid);
    assert.match(rejected.stderr, /not a win32-x64 executable/);
  }
});

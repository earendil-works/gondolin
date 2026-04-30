import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("cli: symlinked gondolin entry path still executes main", (t) => {
  const hostDir = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cli-symlink-"));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const targetPath = path.join(hostDir, "bin", "gondolin.ts");
  const symlinkPath = path.join(tmpDir, "gondolin-link.ts");
  fs.symlinkSync(targetPath, symlinkPath);

  const result = spawnSync(
    process.execPath,
    [symlinkPath, "bash", "--help"],
    {
      cwd: hostDir,
      env: process.env,
      encoding: "utf8",
      timeout: 15000,
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout ?? "", /--listen/);
  assert.match(result.stdout ?? "", /--resume/);
});

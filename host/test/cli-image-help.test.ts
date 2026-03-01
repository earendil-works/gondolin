import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("cli: gondolin image --help renders usage", () => {
  const hostDir = path.join(import.meta.dirname, "..");

  const result = spawnSync(
    process.execPath,
    ["bin/gondolin.ts", "image", "--help"],
    {
      cwd: hostDir,
      env: process.env,
      encoding: "utf8",
      timeout: 15000,
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout ?? "", /Usage: gondolin image/);
});

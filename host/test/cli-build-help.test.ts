import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("cli: gondolin build --help documents --tag and optional --output", () => {
  const hostDir = path.join(__dirname, "..");

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "bin/gondolin.ts", "build", "--help"],
    {
      cwd: hostDir,
      env: process.env,
      encoding: "utf8",
      timeout: 15000,
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout ?? "", /--tag REF/);
  assert.match(
    result.stdout ?? "",
    /--output DIR\s+Output directory.*optional/,
  );
});

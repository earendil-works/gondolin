import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("cli: gondolin bash --listen -1 errors (value starting with - is not silently ignored)", () => {
  const hostDir = path.join(__dirname, "..");

  const result = spawnSync(process.execPath, ["--import", "tsx", "bin/gondolin.ts", "bash", "--listen", "-1"], {
    cwd: hostDir,
    env: process.env,
    encoding: "utf8",
    timeout: 15000,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr ?? "", /Invalid --listen value: -1/);
});

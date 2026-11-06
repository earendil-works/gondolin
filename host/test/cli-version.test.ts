import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("cli: gondolin --version prints the package version and gondolind", () => {
  const hostDir = path.join(import.meta.dirname, "..");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(hostDir, "package.json"), "utf8"),
  ) as { version: string };

  for (const flag of ["--version", "-V", "version"]) {
    const result = spawnSync(process.execPath, ["bin/gondolin.ts", flag], {
      cwd: hostDir,
      env: { ...process.env, GONDOLIN_NATIVE_BIN: "/opt/test/gondolind" },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = (result.stdout ?? "").trim().split("\n");
    assert.equal(lines[0], `gondolin ${pkg.version}`);
    assert.equal(lines[1], "gondolind: /opt/test/gondolind");
  }
  // the multi-call binary is started as `gondolin daemon`
  const multi = spawnSync(process.execPath, ["bin/gondolin.ts", "--version"], {
    cwd: hostDir,
    env: { ...process.env, GONDOLIN_NATIVE_BIN: "/opt/test/gondolin" },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(
    multi.stdout.trim().split("\n")[1],
    "gondolind: /opt/test/gondolin daemon",
  );
});

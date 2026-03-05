import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test as serverOptionsTest } from "../src/sandbox/server-options.ts";

test("resolvePackagedKrunRunnerPath rejects non-runnable packaged candidate", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-packaged-runner-"),
  );

  try {
    const packageDir = path.join(tmp, "node_modules", "pkg");
    const packageJsonPath = path.join(packageDir, "package.json");
    const candidatePath = path.join(packageDir, "bin", "gondolin-krun-runner");

    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ bin: "bin/gondolin-krun-runner" }),
    );
    fs.writeFileSync(candidatePath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const resolved = serverOptionsTest.resolvePackagedKrunRunnerPath({
      platform: "linux",
      arch: "x64",
      resolvePackageJson: () => packageJsonPath,
      probeRunner: () => false,
    });

    assert.equal(resolved, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolvePackagedKrunRunnerPath accepts runnable packaged candidate", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-packaged-runner-"),
  );

  try {
    const packageDir = path.join(tmp, "node_modules", "pkg");
    const packageJsonPath = path.join(packageDir, "package.json");
    const candidatePath = path.join(packageDir, "bin", "gondolin-krun-runner");

    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ bin: "bin/gondolin-krun-runner" }),
    );
    fs.writeFileSync(candidatePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const resolved = serverOptionsTest.resolvePackagedKrunRunnerPath({
      platform: "linux",
      arch: "x64",
      resolvePackageJson: () => packageJsonPath,
      probeRunner: (candidate) => candidate === candidatePath,
    });

    assert.equal(resolved, candidatePath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveDefaultKrunRunnerPath falls back to PATH token", () => {
  const resolved = serverOptionsTest.resolveDefaultKrunRunnerPath({
    envPath: undefined,
    resolveLocalPath: () => null,
    resolvePackagedPath: () => null,
  });

  assert.equal(resolved, "gondolin-krun-runner");
});

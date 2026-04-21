import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const scriptPath = path.join(
  repoRoot,
  "scripts",
  "prepare-krun-runner-package.mjs",
);

test("prepare-krun-runner-package materializes SONAME aliases for npm pack", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-package-test-"));

  try {
    const packageDir = path.join(tmp, "pkg");
    const runnerPath = path.join(tmp, "runner", "gondolin-krun-runner");
    const libDir = path.join(tmp, "lib");

    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@earendil-works/gondolin-krun-runner-test",
        version: "1.0.0",
        files: ["bin/", "lib/", "LICENSE"],
      }),
    );
    fs.writeFileSync(path.join(packageDir, "README.md"), "test\n");
    fs.writeFileSync(path.join(packageDir, "LICENSE"), "license\n");

    fs.mkdirSync(path.dirname(runnerPath), { recursive: true });
    fs.writeFileSync(runnerPath, "#!/bin/sh\necho gondolin-krun-runner\n", {
      mode: 0o755,
    });

    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, "libkrun.so.1.0.0"), "lib");
    fs.symlinkSync("libkrun.so.1.0.0", path.join(libDir, "libkrun.so.1"));

    execFileSync(
      process.execPath,
      [
        scriptPath,
        "--package",
        packageDir,
        "--runner",
        runnerPath,
        "--lib-dir",
        libDir,
      ],
      {
        cwd: repoRoot,
        stdio: "pipe",
      },
    );

    const stagedRunner = path.join(packageDir, "bin", "gondolin-krun-runner");
    const stagedLibReal = path.join(packageDir, "lib", "libkrun.so.1.0.0");
    const stagedLibSoname = path.join(packageDir, "lib", "libkrun.so.1");

    assert.equal(fs.existsSync(stagedRunner), true);
    assert.equal(fs.existsSync(stagedLibReal), true);
    assert.equal(fs.existsSync(stagedLibSoname), true);

    const sonameStat = fs.lstatSync(stagedLibSoname);
    assert.equal(sonameStat.isSymbolicLink(), false);
    assert.equal(fs.readFileSync(stagedLibSoname, "utf8"), "lib");

    const packName = execFileSync("npm", ["pack", "--silent"], {
      cwd: packageDir,
      encoding: "utf8",
    }).trim();
    const packPath = path.join(packageDir, packName);
    const tarList = execFileSync("tar", ["-tf", packPath], {
      encoding: "utf8",
    });
    assert.match(tarList, /package\/lib\/libkrun\.so\.1\.0\.0/);
    assert.match(tarList, /package\/lib\/libkrun\.so\.1/);

    const versionOut = execFileSync(stagedRunner, ["--version"], {
      encoding: "utf8",
    });
    assert.match(versionOut, /gondolin-krun-runner/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

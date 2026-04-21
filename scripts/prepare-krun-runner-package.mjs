#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  let packageDir;
  let runnerPath;
  let libDir;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--package") {
      packageDir = argv[++i];
      continue;
    }
    if (arg === "--runner") {
      runnerPath = argv[++i];
      continue;
    }
    if (arg === "--lib-dir") {
      libDir = argv[++i];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!packageDir) {
    throw new Error("--package is required");
  }

  return {
    packageDir: path.resolve(packageDir),
    runnerPath: path.resolve(
      runnerPath ?? "host/krun-runner/zig-out/bin/gondolin-krun-runner",
    ),
    libDir: path.resolve(libDir ?? "host/krun-runner/zig-out/lib"),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function copyFile(src, dest, mode) {
  fs.copyFileSync(src, dest);
  if (mode !== undefined) {
    fs.chmodSync(dest, mode);
  }
}

function copySymlinkTarget(src, dest) {
  const realPath = fs.realpathSync(src);
  fs.copyFileSync(realPath, dest);
}

function main() {
  const { packageDir, runnerPath, libDir } = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(path.join(packageDir, "package.json"))) {
    throw new Error(`package.json not found in ${packageDir}`);
  }

  if (!fs.existsSync(runnerPath)) {
    throw new Error(`runner binary not found: ${runnerPath}`);
  }

  if (!fs.existsSync(libDir)) {
    throw new Error(`runner library directory not found: ${libDir}`);
  }

  const binDir = path.join(packageDir, "bin");
  const outLibDir = path.join(packageDir, "lib");
  ensureDir(binDir);
  ensureDir(outLibDir);
  cleanDir(binDir);
  cleanDir(outLibDir);

  const binTarget = path.join(binDir, "gondolin-krun-runner");
  copyFile(runnerPath, binTarget, 0o755);

  const libEntries = fs
    .readdirSync(libDir, { withFileTypes: true })
    .filter(
      (entry) =>
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.startsWith("libkrun"),
    );

  if (libEntries.length === 0) {
    throw new Error(`no libkrun files found in ${libDir}`);
  }

  const regularFiles = libEntries.filter((entry) => entry.isFile());
  const symlinkFiles = libEntries.filter((entry) => entry.isSymbolicLink());

  for (const entry of regularFiles) {
    const src = path.join(libDir, entry.name);
    const dest = path.join(outLibDir, entry.name);
    copyFile(src, dest);
  }

  for (const entry of symlinkFiles) {
    const src = path.join(libDir, entry.name);
    const dest = path.join(outLibDir, entry.name);
    copySymlinkTarget(src, dest);
  }

  const repoLicense = path.resolve("LICENSE");
  if (!fs.existsSync(repoLicense)) {
    throw new Error(`LICENSE not found at ${repoLicense}`);
  }
  copyFile(repoLicense, path.join(packageDir, "LICENSE"));

  console.log(`Prepared ${packageDir}`);
  console.log(`  runner: ${binTarget}`);
  console.log(`  libs:   ${libEntries.length}`);
}

main();

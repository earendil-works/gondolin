import fs from "fs";
import os from "os";
import path from "path";

import { MANIFEST_FILENAME, loadAssetManifest } from "../assets";
import type { BuildConfig } from "./config";
import {
  detectContainerRuntime,
  runCommand,
  ensureHostDistBuilt,
  findGuestDir,
  findHostPackageRoot,
  resolveConfigPath,
  type BuildOptions,
  type BuildResult,
} from "./shared";

/** Build assets inside a container */
export async function buildInContainer(
  config: BuildConfig,
  options: BuildOptions,
  log: (msg: string) => void,
): Promise<BuildResult> {
  const runtime = detectContainerRuntime(config.container?.runtime);
  const image = config.container?.image ?? "alpine:3.23";
  const outputDir = path.resolve(options.outputDir);

  log(`Using container runtime: ${runtime}`);
  log(`Container image: ${image}`);

  const guestDir = findGuestDir();
  if (!guestDir) {
    throw new Error(
      "Could not find guest directory. Make sure you're running from a gondolin checkout.",
    );
  }

  const hostPkgRoot = findHostPackageRoot();
  if (!hostPkgRoot) {
    throw new Error("Could not locate host package root (package.json)");
  }
  ensureHostDistBuilt(hostPkgRoot, log);

  const hostDistSrcDir = path.join(hostPkgRoot, "dist", "src");
  const hostDistBuilder = path.join(hostDistSrcDir, "build", "index.js");
  if (!fs.existsSync(hostDistBuilder)) {
    throw new Error(
      `Host dist build not found at ${hostDistBuilder}. ` +
        "Run `pnpm -C host build` (repo checkout) or reinstall the package.",
    );
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-build-"));
  const containerScriptPath = path.join(workDir, "build-in-container.sh");
  const runnerPath = path.join(workDir, "run-build.js");
  const configPath = path.join(workDir, "build-config.json");

  const containerConfig: BuildConfig = JSON.parse(JSON.stringify(config));
  if (containerConfig.container) {
    containerConfig.container.force = false;
  }

  const copyExecutable = (source: string, name: string) => {
    const dest = path.join(workDir, name);
    fs.copyFileSync(source, dest);
    fs.chmodSync(dest, 0o755);
    return dest;
  };

  if (containerConfig.init?.rootfsInit) {
    copyExecutable(
      resolveConfigPath(containerConfig.init.rootfsInit, options.configDir),
      "rootfs-init",
    );
    containerConfig.init.rootfsInit = "/work/rootfs-init";
  }
  if (containerConfig.init?.initramfsInit) {
    copyExecutable(
      resolveConfigPath(containerConfig.init.initramfsInit, options.configDir),
      "initramfs-init",
    );
    containerConfig.init.initramfsInit = "/work/initramfs-init";
  }
  if (containerConfig.init?.rootfsInitExtra) {
    copyExecutable(
      resolveConfigPath(
        containerConfig.init.rootfsInitExtra,
        options.configDir,
      ),
      "rootfs-init-extra",
    );
    containerConfig.init.rootfsInitExtra = "/work/rootfs-init-extra";
  }
  if (containerConfig.sandboxdPath) {
    copyExecutable(
      resolveConfigPath(containerConfig.sandboxdPath, options.configDir),
      "sandboxd",
    );
    containerConfig.sandboxdPath = "/work/sandboxd";
  }
  if (containerConfig.sandboxfsPath) {
    copyExecutable(
      resolveConfigPath(containerConfig.sandboxfsPath, options.configDir),
      "sandboxfs",
    );
    containerConfig.sandboxfsPath = "/work/sandboxfs";
  }
  if (containerConfig.sandboxsshPath) {
    copyExecutable(
      resolveConfigPath(containerConfig.sandboxsshPath, options.configDir),
      "sandboxssh",
    );
    containerConfig.sandboxsshPath = "/work/sandboxssh";
  }
  if (containerConfig.sandboxingressPath) {
    copyExecutable(
      resolveConfigPath(containerConfig.sandboxingressPath, options.configDir),
      "sandboxingress",
    );
    containerConfig.sandboxingressPath = "/work/sandboxingress";
  }

  fs.writeFileSync(configPath, JSON.stringify(containerConfig, null, 2));

  const verbose = options.verbose ?? true;

  const runner = `"use strict";
const fs = require("fs");

const { buildAssets } = require("/host-dist-src/build/index.js");

async function main() {
  const cfg = JSON.parse(fs.readFileSync("/work/build-config.json", "utf8"));
  if (cfg.container) {
    cfg.container.force = false;
  }

  await buildAssets(cfg, {
    outputDir: "/output",
    verbose: ${verbose ? "true" : "false"},
  });
}

main().catch((err) => {
  const msg = err && err.stack ? err.stack : String(err);
  process.stderr.write(msg + "\\n");
  process.exit(1);
});
`;

  fs.writeFileSync(runnerPath, runner, { mode: 0o644 });

  const containerScript = `#!/bin/sh
set -eu

# Minimal build toolchain
apk add --no-cache nodejs zig lz4 cpio e2fsprogs bash

# Make guest sources discoverable for Zig compilation
export GONDOLIN_GUEST_SRC=/guest

node /work/run-build.js
`;

  fs.writeFileSync(containerScriptPath, containerScript, { mode: 0o755 });

  fs.mkdirSync(outputDir, { recursive: true });

  const containerArgs = ["run", "--rm"];

  if (hasPostBuildCommands(config)) {
    containerArgs.push("--privileged");
  }

  containerArgs.push(
    "-v",
    `${guestDir}:/guest`,
    "-v",
    `${outputDir}:/output`,
    "-v",
    `${workDir}:/work`,
    "-v",
    `${hostDistSrcDir}:/host-dist-src:ro`,
    image,
    "/bin/sh",
    "/work/build-in-container.sh",
  );

  await runCommand(runtime, containerArgs, {}, log);

  const manifest = loadAssetManifest(outputDir);
  if (!manifest) {
    throw new Error(
      `Container build completed but manifest was not found in ${outputDir}`,
    );
  }

  const manifestPath = path.join(outputDir, MANIFEST_FILENAME);

  fs.rmSync(workDir, { recursive: true, force: true });

  log(`Build complete! Assets written to ${outputDir}`);

  return {
    outputDir,
    manifestPath,
    manifest,
  };
}

function hasPostBuildCommands(config: BuildConfig): boolean {
  return (config.postBuild?.commands?.length ?? 0) > 0;
}

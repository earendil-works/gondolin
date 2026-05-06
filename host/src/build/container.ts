import fs from "fs";
import os from "os";
import path from "path";

import { MANIFEST_FILENAME, loadAssetManifest } from "../assets.ts";
import type { BuildConfig } from "./config.ts";
import {
  detectContainerRuntime,
  runCommand,
  ensureHostDistBuilt,
  findHostPackageRoot,
  resolveConfigPath,
  resolveSandboxBinaryPaths,
  type BuildOptions,
  type BuildResult,
} from "./shared.ts";

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

  const sandboxHelpers = await resolveSandboxBinaryPaths(config, options, log);

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
  const runnerPath = path.join(workDir, "run-build.mjs");
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

  const stagePostBuildCopySource = (source: string, name: string): string => {
    const sourceStat = fs.lstatSync(source);
    const stageRoot = path.join(workDir, name);

    if (sourceStat.isDirectory()) {
      copyPostBuildSourceTree(source, stageRoot);
      return `/work/${name}`;
    }

    const sourceBaseName = path.basename(source);
    const stagedPath = path.join(stageRoot, sourceBaseName);
    copyPostBuildSourceTree(source, stagedPath);
    return `/work/${name}/${sourceBaseName}`;
  };

  const copyPostBuildSourceTree = (source: string, dest: string): void => {
    const sourceStat = fs.lstatSync(source);

    if (sourceStat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true, mode: sourceStat.mode & 0o777 });
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        copyPostBuildSourceTree(
          path.join(source, entry.name),
          path.join(dest, entry.name),
        );
      }
      return;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (sourceStat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(source);
      fs.symlinkSync(linkTarget, dest);
      return;
    }

    if (sourceStat.isFile()) {
      fs.copyFileSync(source, dest);
      fs.chmodSync(dest, sourceStat.mode & 0o777);
      return;
    }

    throw new Error(`postBuild.copy source type is not supported: ${source}`);
  };

  if (containerConfig.postBuild?.copy) {
    containerConfig.postBuild.copy = containerConfig.postBuild.copy.map(
      (entry, index) => {
        const resolved = resolveConfigPath(entry.src, options.configDir);
        if (!fs.existsSync(resolved)) {
          throw new Error(`postBuild.copy source not found: ${resolved}`);
        }

        const stagedName = `postbuild-copy-${index}`;
        const stagedSource = stagePostBuildCopySource(resolved, stagedName);

        return {
          src: stagedSource,
          dest: entry.dest,
        };
      },
    );
  }

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
  copyExecutable(sandboxHelpers.sandboxdPath, "sandboxd");
  containerConfig.sandboxdPath = "/work/sandboxd";
  copyExecutable(sandboxHelpers.sandboxfsPath, "sandboxfs");
  containerConfig.sandboxfsPath = "/work/sandboxfs";
  copyExecutable(sandboxHelpers.sandboxsshPath, "sandboxssh");
  containerConfig.sandboxsshPath = "/work/sandboxssh";
  copyExecutable(sandboxHelpers.sandboxingressPath, "sandboxingress");
  containerConfig.sandboxingressPath = "/work/sandboxingress";

  fs.writeFileSync(configPath, JSON.stringify(containerConfig, null, 2));

  const verbose = options.verbose ?? true;

  const runner = `import fs from "node:fs";

import { buildAssets } from "/host-pkg/dist/src/build/index.js";

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
apk add --no-cache nodejs lz4 cpio e2fsprogs bash ca-certificates

node /work/run-build.mjs
`;

  fs.writeFileSync(containerScriptPath, containerScript, { mode: 0o755 });

  fs.mkdirSync(outputDir, { recursive: true });

  const containerArgs = ["run", "--rm"];

  if (hasPostBuildCommands(config)) {
    containerArgs.push("--privileged");
  }

  containerArgs.push(
    "-v",
    `${outputDir}:/output`,
    "-v",
    `${workDir}:/work`,
    "-v",
    `${hostPkgRoot}:/host-pkg:ro`,
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

  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `Warning: could not remove temporary container build dir ${workDir}: ${message}`,
    );
  }

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

/**
 * Asset builder for custom Linux kernel and rootfs images.
 */

import fs from "fs";
import os from "os";
import path from "path";

import { loadAssetManifest } from "../assets";
import type { BuildConfig } from "./config";
import { detectHostArchitectureSync } from "../host/arch";
import { buildInContainer } from "./container";
import { computeFileHash, type BuildOptions, type BuildResult } from "./shared";
import { buildNative } from "./native";

export type { BuildOptions, BuildResult } from "./shared";

function hasPostBuildCommands(config: BuildConfig): boolean {
  return (config.postBuild?.commands?.length ?? 0) > 0;
}

function hasOciRootfs(config: BuildConfig): boolean {
  return config.oci !== undefined;
}

/** Determine if we need to use a container for the build */
function shouldUseContainer(config: BuildConfig): boolean {
  if (config.container?.force) {
    return true;
  }

  if (hasOciRootfs(config)) {
    return false;
  }

  if (hasPostBuildCommands(config) && process.platform !== "linux") {
    return true;
  }

  if (process.platform === "darwin") {
    const hostArch = detectHostArchitectureSync();
    if (hostArch !== config.arch) {
      return true;
    }
    return false;
  }

  return false;
}

/** Build guest assets from a configuration */
export async function buildAssets(
  config: BuildConfig,
  options: BuildOptions,
): Promise<BuildResult> {
  const verbose = options.verbose ?? true;
  const log = verbose
    ? (msg: string) => process.stderr.write(`${msg}\n`)
    : () => {};

  if (config.distro !== "alpine") {
    throw new Error(
      `Distro '${config.distro}' is not supported yet. Only 'alpine' builds are implemented.`,
    );
  }

  if (hasOciRootfs(config) && config.container?.force) {
    throw new Error(
      "OCI rootfs builds currently do not support container.force=true. " +
        "Run the build natively on the host and configure oci.runtime if needed.",
    );
  }

  if (
    hasOciRootfs(config) &&
    hasPostBuildCommands(config) &&
    process.platform !== "linux"
  ) {
    throw new Error(
      "OCI rootfs builds with postBuild.commands require a native Linux host. " +
        "Run the build on Linux or remove postBuild.commands.",
    );
  }

  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const rootfsSource = config.oci
    ? `OCI image ${config.oci.image}`
    : "Alpine minirootfs";

  log(`Building guest assets for ${config.arch} (${config.distro})`);
  log(`Rootfs source: ${rootfsSource}`);
  log(`Output directory: ${outputDir}`);

  if (shouldUseContainer(config)) {
    return buildInContainer(config, options, log);
  }

  const workDir =
    options.workDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-build-"));
  log(`Work directory: ${workDir}`);

  try {
    return await buildNative(config, options, workDir, log);
  } finally {
    if (!options.workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

/** Verify asset checksums against manifest */
export function verifyAssets(assetDir: string): boolean {
  const manifest = loadAssetManifest(assetDir);
  if (!manifest) {
    return false;
  }

  const assets = [
    {
      name: "kernel",
      file: manifest.assets.kernel,
      expected: manifest.checksums.kernel,
    },
    {
      name: "initramfs",
      file: manifest.assets.initramfs,
      expected: manifest.checksums.initramfs,
    },
    {
      name: "rootfs",
      file: manifest.assets.rootfs,
      expected: manifest.checksums.rootfs,
    },
  ];

  for (const { name, file, expected } of assets) {
    const filePath = path.join(assetDir, file);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const actual = computeFileHash(filePath);
    if (actual !== expected) {
      process.stderr.write(
        `Checksum mismatch for ${name}: expected ${expected}, got ${actual}\n`,
      );
      return false;
    }
  }

  return true;
}

/**
 * Asset builder for custom Linux kernel and rootfs images.
 *
 * This module wraps the existing guest build pipeline and provides
 * a programmatic interface for building custom VM assets.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { spawn, execFileSync, SpawnOptions } from "child_process";
import { createHash } from "crypto";

import type {
  BuildConfig,
  Architecture,
} from "./build-config";
import { MANIFEST_FILENAME, computeAssetBuildId, loadAssetManifest, type AssetManifest } from "./assets";
import {
  buildAlpineImages,
  downloadFile,
  decompressTarGz,
  parseTar,
  parseApkIndex,
} from "./build-alpine";


/** Fixed output filenames for assets */
const KERNEL_FILENAME = "vmlinuz-virt";
const INITRAMFS_FILENAME = "initramfs.cpio.lz4";
const ROOTFS_FILENAME = "rootfs.ext4";

/** Zig target triples for cross-compilation */
const ZIG_TARGETS: Record<Architecture, string> = {
  aarch64: "aarch64-linux-musl",
  x86_64: "x86_64-linux-musl",
};

const DEFAULT_ROOTFS_PACKAGES = [
  "linux-virt",
  "rng-tools",
  "bash",
  "ca-certificates",
  "curl",
  "nodejs",
  "npm",
  "uv",
  "python3",
];

type ResolvedAlpineConfig = {
  version: string;
  branch?: string;
  mirror?: string;
  kernelPackage?: string;
  kernelImage?: string;
  rootfsPackages: string[];
  initramfsPackages: string[];
};

function resolveAlpineConfig(config: BuildConfig): ResolvedAlpineConfig {
  const alpine = config.alpine ?? { version: "3.23.0" };
  const kernelPackage = alpine.kernelPackage ?? "linux-virt";
  const defaultRootfsPackages = DEFAULT_ROOTFS_PACKAGES.map((pkg) =>
    pkg === "linux-virt" ? kernelPackage : pkg
  );

  return {
    version: alpine.version,
    branch: alpine.branch,
    mirror: alpine.mirror,
    kernelPackage: alpine.kernelPackage,
    kernelImage: alpine.kernelImage,
    rootfsPackages: alpine.rootfsPackages ?? defaultRootfsPackages,
    initramfsPackages: alpine.initramfsPackages ?? [],
  };
}

function resolveConfigPath(value: string, configDir?: string): string {
  if (path.isAbsolute(value)) return value;
  return configDir ? path.resolve(configDir, value) : path.resolve(value);
}

export interface BuildOptions {
  /** output directory for the built assets */
  outputDir: string;

  /** base directory to resolve relative paths in the build config against (default: process.cwd()) */
  configDir?: string;

  /** whether to print progress to stderr (default: true) */
  verbose?: boolean;
  /** working directory for the build (default: temp directory) */
  workDir?: string;
  /** whether to skip building sandboxd/sandboxfs binaries */
  skipBinaries?: boolean;
}

export interface BuildResult {
  /** output directory path */
  outputDir: string;
  /** manifest file path */
  manifestPath: string;
  /** parsed manifest */
  manifest: AssetManifest;
}

/**
 * Build guest assets from a configuration.
 */
export async function buildAssets(
  config: BuildConfig,
  options: BuildOptions
): Promise<BuildResult> {
  const verbose = options.verbose ?? true;
  const log = verbose
    ? (msg: string) => process.stderr.write(`${msg}\n`)
    : () => {};

  if (config.distro !== "alpine") {
    throw new Error(
      `Distro '${config.distro}' is not supported yet. Only 'alpine' builds are implemented.`
    );
  }

  // Resolve paths
  const outputDir = path.resolve(options.outputDir);

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  log(`Building guest assets for ${config.arch} (${config.distro})`);
  log(`Output directory: ${outputDir}`);

  // Check if we need a container (macOS can't run Linux build tools natively)
  const needsContainer = shouldUseContainer(config);

  if (needsContainer) {
    return buildInContainer(config, options, log);
  }

  const workDir =
    options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-build-"));
  log(`Work directory: ${workDir}`);

  // Native Linux build
  return buildNative(config, options, workDir, log);
}

/**
 * Determine if we need to use a container for the build.
 */
function shouldUseContainer(config: BuildConfig): boolean {
  // Force container if explicitly configured
  if (config.container?.force) {
    return true;
  }

  // On macOS, cross-arch builds default to a Linux container to keep the build
  // environment consistent and to avoid relying on host tooling for ext4/cpio.
  if (process.platform === "darwin") {
    const hostArch = detectHostArch();
    if (hostArch !== config.arch) {
      return true;
    }
    return false;
  }

  return false;
}

function detectHostArch(): Architecture {
  let arch = process.arch;

  if (process.platform === "darwin" && process.arch === "x64") {
    try {
      const result = execFileSync("sysctl", ["-n", "hw.optional.arm64"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.trim() === "1") {
        arch = "arm64";
      }
    } catch {
      // ignore
    }
  }

  if (arch === "arm64") {
    return "aarch64";
  }

  return "x86_64";
}

/**
 * Build assets natively (Linux or macOS with appropriate tools).
 */
async function buildNative(
  config: BuildConfig,
  options: BuildOptions,
  workDir: string,
  log: (msg: string) => void
): Promise<BuildResult> {
  const outputDir = path.resolve(options.outputDir);

  const configDir = options.configDir;

  // Step 1: Build or locate sandboxd, sandboxfs, sandboxssh, and sandboxingress binaries
  let sandboxdPath = config.sandboxdPath ? resolveConfigPath(config.sandboxdPath, configDir) : undefined;
  let sandboxfsPath = config.sandboxfsPath ? resolveConfigPath(config.sandboxfsPath, configDir) : undefined;
  let sandboxsshPath = config.sandboxsshPath ? resolveConfigPath(config.sandboxsshPath, configDir) : undefined;
  let sandboxingressPath = config.sandboxingressPath
    ? resolveConfigPath(config.sandboxingressPath, configDir)
    : undefined;

  if (!options.skipBinaries && !sandboxdPath && !sandboxfsPath) {
    const guestDir = findGuestDir();
    if (!guestDir) {
      throw new Error(
        "Could not find guest directory for Zig build. Either:\n" +
        "  1. Run from a gondolin checkout, or\n" +
        "  2. Set GONDOLIN_GUEST_SRC to the guest directory, or\n" +
        "  3. Provide sandboxdPath and sandboxfsPath in the build config."
      );
    }
    log(`Using guest sources from: ${guestDir}`);
    log("Building guest binaries...");
    await buildGuestBinaries(guestDir, config.arch, log);
    sandboxdPath = path.join(guestDir, "zig-out", "bin", "sandboxd");
    sandboxfsPath = path.join(guestDir, "zig-out", "bin", "sandboxfs");
    sandboxsshPath = path.join(guestDir, "zig-out", "bin", "sandboxssh");
    sandboxingressPath = path.join(guestDir, "zig-out", "bin", "sandboxingress");
  } else {
    if (!sandboxdPath || !sandboxfsPath || !sandboxsshPath || !sandboxingressPath) {
      const guestDir = findGuestDir();
      sandboxdPath = sandboxdPath ?? path.join(guestDir ?? "", "zig-out", "bin", "sandboxd");
      sandboxfsPath = sandboxfsPath ?? path.join(guestDir ?? "", "zig-out", "bin", "sandboxfs");
      sandboxsshPath = sandboxsshPath ?? path.join(guestDir ?? "", "zig-out", "bin", "sandboxssh");
      sandboxingressPath =
        sandboxingressPath ?? path.join(guestDir ?? "", "zig-out", "bin", "sandboxingress");
    }
  }

  if (!fs.existsSync(sandboxdPath)) {
    throw new Error(`sandboxd binary not found: ${sandboxdPath}`);
  }
  if (!fs.existsSync(sandboxfsPath)) {
    throw new Error(`sandboxfs binary not found: ${sandboxfsPath}`);
  }
  if (!fs.existsSync(sandboxsshPath)) {
    throw new Error(`sandboxssh binary not found: ${sandboxsshPath}`);
  }
  if (!fs.existsSync(sandboxingressPath)) {
    throw new Error(`sandboxingress binary not found: ${sandboxingressPath}`);
  }

  // Step 2: Build the images using the TypeScript builder
  log("Building guest images...");

  const alpineConfig = resolveAlpineConfig(config);
  const { kernelPackage } = resolveKernelConfig(alpineConfig);
  warnOnKernelPackageMismatch(alpineConfig.rootfsPackages, kernelPackage);

  // Determine cache directory
  const cacheDir = path.join(
    os.homedir(), ".cache", "gondolin", "build"
  );

  // Read custom init scripts if provided
  let rootfsInit: string | undefined;
  let initramfsInit: string | undefined;
  let rootfsInitExtra: string | undefined;
  if (config.init?.rootfsInit) {
    rootfsInit = fs.readFileSync(resolveConfigPath(config.init.rootfsInit, configDir), "utf8");
  }
  if (config.init?.initramfsInit) {
    initramfsInit = fs.readFileSync(
      resolveConfigPath(config.init.initramfsInit, configDir),
      "utf8"
    );
  }
  if (config.init?.rootfsInitExtra) {
    rootfsInitExtra = fs.readFileSync(
      resolveConfigPath(config.init.rootfsInitExtra, configDir),
      "utf8"
    );
  }

  // Compute Alpine URL if a custom mirror is set
  let alpineUrl: string | undefined;
  if (alpineConfig.mirror) {
    const branch = alpineConfig.branch ?? `v${alpineConfig.version.split(".").slice(0, 2).join(".")}`;
    alpineUrl = `${alpineConfig.mirror}/${branch}/releases/${config.arch}/alpine-minirootfs-${alpineConfig.version}-${config.arch}.tar.gz`;
  }

  await buildAlpineImages({
    arch: config.arch,
    alpineVersion: alpineConfig.version,
    alpineBranch: alpineConfig.branch ?? `v${alpineConfig.version.split(".").slice(0, 2).join(".")}`,
    alpineUrl,
    rootfsPackages: alpineConfig.rootfsPackages,
    initramfsPackages: alpineConfig.initramfsPackages,
    sandboxdBin: sandboxdPath,
    sandboxfsBin: sandboxfsPath,
    sandboxsshBin: sandboxsshPath,
    sandboxingressBin: sandboxingressPath,
    rootfsLabel: config.rootfs?.label ?? "gondolin-root",
    rootfsSizeMb: config.rootfs?.sizeMb,
    rootfsInit,
    initramfsInit,
    rootfsInitExtra,
    defaultEnv: config.env,
    workDir,
    cacheDir,
    log,
  });

  // Step 3: Fetch the kernel
  log("Fetching kernel...");
  await fetchKernel(workDir, config.arch, alpineConfig, cacheDir, log);

  // Step 4: Copy assets to output directory
  log("Copying assets to output directory...");

  const kernelSrc = path.join(workDir, KERNEL_FILENAME);
  const initramfsSrc = path.join(workDir, INITRAMFS_FILENAME);
  const rootfsSrc = path.join(workDir, ROOTFS_FILENAME);

  const kernelDst = path.join(outputDir, KERNEL_FILENAME);
  const initramfsDst = path.join(outputDir, INITRAMFS_FILENAME);
  const rootfsDst = path.join(outputDir, ROOTFS_FILENAME);

  fs.copyFileSync(kernelSrc, kernelDst);
  fs.copyFileSync(initramfsSrc, initramfsDst);
  fs.copyFileSync(rootfsSrc, rootfsDst);

  // Step 5: Generate manifest
  log("Generating manifest...");

  const checksums = {
    kernel: computeFileHash(kernelDst),
    initramfs: computeFileHash(initramfsDst),
    rootfs: computeFileHash(rootfsDst),
  };

  const manifest: AssetManifest = {
    version: 1,
    buildId: computeAssetBuildId({ checksums, arch: config.arch }),
    config,
    buildTime: new Date().toISOString(),
    assets: {
      kernel: KERNEL_FILENAME,
      initramfs: INITRAMFS_FILENAME,
      rootfs: ROOTFS_FILENAME,
    },
    checksums,
  };

  const manifestPath = path.join(outputDir, MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  log(`Build complete! Assets written to ${outputDir}`);

  // Clean up work directory if it was a temp dir
  if (!options.workDir) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  return {
    outputDir,
    manifestPath,
    manifest,
  };
}

/**
 * Build assets inside a container.
 */
async function buildInContainer(
  config: BuildConfig,
  options: BuildOptions,
  log: (msg: string) => void
): Promise<BuildResult> {
  const runtime = detectContainerRuntime(config.container?.runtime);
  const image = config.container?.image ?? "alpine:3.23";
  const outputDir = path.resolve(options.outputDir);

  log(`Using container runtime: ${runtime}`);
  log(`Container image: ${image}`);

  // Find the guest directory (needed for Zig compilation)
  const guestDir = findGuestDir();
  if (!guestDir) {
    throw new Error(
      "Could not find guest directory. Make sure you're running from a gondolin checkout."
    );
  }

  // We run the TypeScript builder inside the container by executing the
  // precompiled CommonJS output (dist/). When running from a repo checkout
  // (tsx/dev), ensure dist is up-to-date first.
  const hostPkgRoot = findHostPackageRoot();
  if (!hostPkgRoot) {
    throw new Error("Could not locate host package root (package.json)");
  }
  ensureHostDistBuilt(hostPkgRoot, log);

  const hostDistSrcDir = path.join(hostPkgRoot, "dist", "src");
  const hostDistBuilder = path.join(hostDistSrcDir, "builder.js");
  if (!fs.existsSync(hostDistBuilder)) {
    throw new Error(
      `Host dist build not found at ${hostDistBuilder}. ` +
        "Run `pnpm -C host build` (repo checkout) or reinstall the package."
    );
  }

  // Create a temporary work directory (mounted into the container as /work)
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-build-"));
  const containerScriptPath = path.join(workDir, "build-in-container.sh");
  const runnerPath = path.join(workDir, "run-build.js");
  const configPath = path.join(workDir, "build-config.json");

  // Prepare a config that works inside the container.
  // - Disable container.force to avoid recursive container builds.
  // - Re-root any custom init scripts / binaries to /work.
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
      "rootfs-init"
    );
    containerConfig.init.rootfsInit = "/work/rootfs-init";
  }
  if (containerConfig.init?.initramfsInit) {
    copyExecutable(
      resolveConfigPath(containerConfig.init.initramfsInit, options.configDir),
      "initramfs-init"
    );
    containerConfig.init.initramfsInit = "/work/initramfs-init";
  }
  if (containerConfig.init?.rootfsInitExtra) {
    copyExecutable(
      resolveConfigPath(containerConfig.init.rootfsInitExtra, options.configDir),
      "rootfs-init-extra"
    );
    containerConfig.init.rootfsInitExtra = "/work/rootfs-init-extra";
  }
  if (containerConfig.sandboxdPath) {
    copyExecutable(
      resolveConfigPath(containerConfig.sandboxdPath, options.configDir),
      "sandboxd"
    );
    containerConfig.sandboxdPath = "/work/sandboxd";
  }
  if (containerConfig.sandboxfsPath) {
    copyExecutable(
      resolveConfigPath(containerConfig.sandboxfsPath, options.configDir),
      "sandboxfs"
    );
    containerConfig.sandboxfsPath = "/work/sandboxfs";
  }
  if (containerConfig.sandboxsshPath) {
    copyExecutable(
      resolveConfigPath(containerConfig.sandboxsshPath, options.configDir),
      "sandboxssh"
    );
    containerConfig.sandboxsshPath = "/work/sandboxssh";
  }
  if (containerConfig.sandboxingressPath) {
    copyExecutable(
      resolveConfigPath(containerConfig.sandboxingressPath, options.configDir),
      "sandboxingress"
    );
    containerConfig.sandboxingressPath = "/work/sandboxingress";
  }

  fs.writeFileSync(configPath, JSON.stringify(containerConfig, null, 2));

  const verbose = options.verbose ?? true;

  // Node runner that executes the (compiled) builder inside the container.
  const runner = `"use strict";
const fs = require("fs");

const { buildAssets } = require("/host-dist-src/builder.js");

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

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const containerArgs = [
    "run",
    "--rm",
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
  ];

  await runCommand(runtime, containerArgs, {}, log);

  // Load manifest generated by the builder inside the container
  const manifest = loadAssetManifest(outputDir);
  if (!manifest) {
    throw new Error(
      `Container build completed but manifest was not found in ${outputDir}`
    );
  }

  const manifestPath = path.join(outputDir, MANIFEST_FILENAME);

  // Clean up host-side temp directory
  fs.rmSync(workDir, { recursive: true, force: true });

  log(`Build complete! Assets written to ${outputDir}`);

  return {
    outputDir,
    manifestPath,
    manifest,
  };
}

/**
 * Build the guest binaries (sandboxd, sandboxfs).
 */
async function buildGuestBinaries(
  guestDir: string,
  arch: Architecture,
  log: (msg: string) => void
): Promise<void> {
  const zigTarget = ZIG_TARGETS[arch];
  log(`Building for target: ${zigTarget}`);

  await runCommand(
    "zig",
    ["build", "-Doptimize=ReleaseSmall", `-Dtarget=${zigTarget}`],
    { cwd: guestDir },
    log
  );
}

type AlpineKernelConfig = {
  kernelPackage: string;
  kernelImage: string;
};

function resolveKernelConfig(alpineConfig: {
  kernelPackage?: string;
  kernelImage?: string;
}): AlpineKernelConfig {
  const kernelPackage = alpineConfig.kernelPackage ?? "linux-virt";
  const kernelImage = alpineConfig.kernelImage ?? deriveKernelImage(kernelPackage);
  return { kernelPackage, kernelImage };
}

function deriveKernelImage(kernelPackage: string): string {
  if (kernelPackage.startsWith("linux-") && kernelPackage.length > "linux-".length) {
    return `vmlinuz-${kernelPackage.slice("linux-".length)}`;
  }
  return "vmlinuz-virt";
}

function warnOnKernelPackageMismatch(
  rootfsPackages: string[],
  kernelPackage: string
): void {
  if (!rootfsPackages.includes(kernelPackage)) {
    process.stderr.write(
      `Warning: rootfsPackages does not include kernel package '${kernelPackage}'. ` +
        "This may cause module mismatches at boot.\n"
    );
  }
}

/**
 * Fetch the kernel from Alpine repositories.
 */
async function fetchKernel(
  outputDir: string,
  arch: Architecture,
  alpineConfig: {
    version: string;
    branch?: string;
    mirror?: string;
    kernelPackage?: string;
    kernelImage?: string;
  },
  cacheDir: string,
  log: (msg: string) => void
): Promise<void> {
  const kernelPath = path.join(outputDir, KERNEL_FILENAME);

  // Skip if already present
  if (fs.existsSync(kernelPath)) {
    log("Kernel already present, skipping download");
    return;
  }

  const version = alpineConfig.version;
  const branch = alpineConfig.branch ?? `v${version.split(".").slice(0, 2).join(".")}`;
  const mirror = alpineConfig.mirror ?? "https://dl-cdn.alpinelinux.org/alpine";
  const { kernelPackage, kernelImage } = resolveKernelConfig(alpineConfig);

  log(`Fetching ${kernelPackage} from Alpine ${branch} (${arch})`);

  fs.mkdirSync(cacheDir, { recursive: true });

  // Download and parse APKINDEX to find kernel version
  const indexTarPath = path.join(cacheDir, `APKINDEX-main-${branch}-${arch}.tar.gz`);
  const indexUrl = `${mirror}/${branch}/main/${arch}/APKINDEX.tar.gz`;

  if (!fs.existsSync(indexTarPath)) {
    await downloadFile(indexUrl, indexTarPath);
  }

  const raw = await decompressTarGz(indexTarPath);
  const tarEntries = parseTar(raw);
  const indexEntry = tarEntries.find((e) => e.name === "APKINDEX" && e.content);
  if (!indexEntry?.content) {
    throw new Error("APKINDEX not found in index tarball");
  }

  const pkgs = parseApkIndex(indexEntry.content.toString("utf8"));
  const kernelMeta = pkgs.find((p) => p.P === kernelPackage);

  if (!kernelMeta) {
    throw new Error(`Failed to find ${kernelPackage} in APKINDEX`);
  }

  const kernelVersion = kernelMeta.V;
  log(`Found ${kernelPackage} version: ${kernelVersion}`);

  // Download and extract the kernel binary from the .apk
  const apkFilename = `${kernelPackage}-${kernelVersion}.apk`;
  const apkPath = path.join(cacheDir, `${arch}-${apkFilename}`);

  if (!fs.existsSync(apkPath)) {
    const apkUrl = `${mirror}/${branch}/main/${arch}/${apkFilename}`;
    await downloadFile(apkUrl, apkPath);
  }

  const apkRaw = await decompressTarGz(apkPath);
  const apkEntries = parseTar(apkRaw);
  const kernelEntry = apkEntries.find(
    (e) => e.name === `boot/${kernelImage}` && e.content
  );

  if (!kernelEntry?.content) {
    throw new Error(
      `Kernel image 'boot/${kernelImage}' not found in ${apkFilename}`
    );
  }

  fs.writeFileSync(kernelPath, kernelEntry.content);
}

/**
 * Find the guest directory relative to this package.
 *
 * Only needed for Zig compilation of sandboxd/sandboxfs. The image build
 * itself is now handled entirely in TypeScript and has no dependency on
 * files inside the guest directory.
 */
function findGuestDir(): string | null {
  // Check common locations relative to the package
  const candidates = [
    path.resolve(__dirname, "..", "..", "guest"),           // from src/
    path.resolve(__dirname, "..", "..", "..", "guest"),     // from dist/src/
  ];

  for (const candidate of candidates) {
    if (
      fs.existsSync(candidate) &&
      fs.existsSync(path.join(candidate, "build.zig"))
    ) {
      return candidate;
    }
  }

  // Check GONDOLIN_GUEST_SRC environment variable
  if (process.env.GONDOLIN_GUEST_SRC) {
    const envPath = process.env.GONDOLIN_GUEST_SRC;
    if (fs.existsSync(path.join(envPath, "build.zig"))) {
      return envPath;
    }
  }

  return null;
}

/**
 * Find the host package root (directory containing package.json).
 */
function findHostPackageRoot(): string | null {
  let dir = __dirname;

  for (let i = 0; i < 8; i++) {
    const pkgJson = path.join(dir, "package.json");
    if (fs.existsSync(pkgJson)) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return null;
}

/**
 * Ensure `dist/` exists for container builds.
 *
 * Container builds intentionally run the compiled CommonJS output (dist/) so the
 * container only needs Node + system tools (no TSX/TypeScript/node_modules).
 *
 * When running from a repository checkout (host/src via tsx), we rebuild dist so
 * the container doesn't execute stale JS.
 */
function ensureHostDistBuilt(hostPkgRoot: string, log: (msg: string) => void): void {
  const distBuilder = path.join(hostPkgRoot, "dist", "src", "builder.js");

  // If we're already running from dist/, don't rebuild (and we may not have dev deps).
  const runningFromDist =
    path.basename(__dirname) === "src" &&
    path.basename(path.dirname(__dirname)) === "dist";
  if (runningFromDist) {
    return;
  }

  const tsconfigPath = path.join(hostPkgRoot, "tsconfig.json");
  const tscPath = path.join(
    hostPkgRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc"
  );

  // If we can't find tsconfig, assume this is an installed package and dist was shipped.
  if (!fs.existsSync(tsconfigPath)) {
    return;
  }

  // If typescript is missing, fall back to existing dist (if present).
  if (!fs.existsSync(tscPath)) {
    if (fs.existsSync(distBuilder)) {
      return;
    }
    throw new Error(
      `Cannot build host dist output: typescript not found at ${tscPath}. ` +
        "Run `pnpm install` and then `pnpm -C host build`."
    );
  }

  log("Building host dist output (tsc) for container build...");

  // Note: in Node's test runner (and other harnesses) `stdio: "inherit"` can
  // result in swallowed diagnostics. Capture output and rethrow a helpful error.
  try {
    execFileSync(process.execPath, [tscPath, "-p", tsconfigPath], {
      cwd: hostPkgRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (err) {
    const e = err as {
      stdout?: unknown;
      stderr?: unknown;
      status?: unknown;
    };

    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";

    throw new Error(
      `Host dist build (tsc) failed (exit ${String(e.status ?? "?")}).\n` +
        `Command: ${process.execPath} ${tscPath} -p ${tsconfigPath}\n` +
        (stdout || stderr
          ? `--- tsc output ---\n${stdout}${stderr}`
          : "(no tsc output captured)")
    );
  }

  if (!fs.existsSync(distBuilder)) {
    throw new Error(
      `Host dist build failed: ${distBuilder} not found after tsc run`
    );
  }
}

/**
 * Detect available container runtime.
 */
function detectContainerRuntime(
  preferred?: "docker" | "podman"
): "docker" | "podman" {
  if (preferred) {
    try {
      execFileSync(preferred, ["--version"], { stdio: "pipe" });
      return preferred;
    } catch {
      throw new Error(`Preferred container runtime '${preferred}' not found`);
    }
  }

  // Try docker first, then podman
  for (const runtime of ["docker", "podman"] as const) {
    try {
      execFileSync(runtime, ["--version"], { stdio: "pipe" });
      return runtime;
    } catch {
      // Continue to next
    }
  }

  throw new Error(
    "No container runtime found. Please install Docker or Podman."
  );
}

/**
 * Run a command and stream output.
 */
async function runCommand(
  command: string,
  args: string[],
  options: SpawnOptions,
  log: (msg: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Running: ${command} ${args.join(" ")}`);

    const child = spawn(command, args, {
      ...options,
      stdio: ["inherit", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Compute SHA256 hash of a file.
 */
function computeFileHash(filePath: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest("hex");
}

/**
 * Verify asset checksums against manifest.
 */
export function verifyAssets(assetDir: string): boolean {
  const manifest = loadAssetManifest(assetDir);
  if (!manifest) {
    return false;
  }

  const assets = [
    { name: "kernel", file: manifest.assets.kernel, expected: manifest.checksums.kernel },
    { name: "initramfs", file: manifest.assets.initramfs, expected: manifest.checksums.initramfs },
    { name: "rootfs", file: manifest.assets.rootfs, expected: manifest.checksums.rootfs },
  ];

  for (const { name, file, expected } of assets) {
    const filePath = path.join(assetDir, file);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const actual = computeFileHash(filePath);
    if (actual !== expected) {
      process.stderr.write(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}\n`);
      return false;
    }
  }

  return true;
}

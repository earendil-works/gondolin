import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execFileSync, spawn, type SpawnOptions } from "child_process";

import {
  MANIFEST_FILENAME,
  computeAssetBuildId,
  type AssetManifest,
} from "../assets.ts";
import type { BuildConfig, Architecture } from "./config.ts";
import { ensureSandboxHelperBinaries } from "./sandbox-helpers.ts";

/** Fixed output filenames for assets */
export const KERNEL_FILENAME = "vmlinuz-virt";
export const INITRAMFS_FILENAME = "initramfs.cpio.lz4";
export const ROOTFS_FILENAME = "rootfs.ext4";
export const KRUN_KERNEL_FILENAME = "krun-kernel";
export const KRUN_INITRD_FILENAME = "krun-empty-initrd";

/** Zig target triples for cross-compilation */
const ZIG_TARGETS: Record<Architecture, string> = {
  aarch64: "aarch64-linux-musl",
  x86_64: "x86_64-linux-musl",
};

const BUILD_SANDBOX_HELPERS_FROM_SOURCE_ENV =
  "GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE";

export const DEFAULT_ROOTFS_PACKAGES = [
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

export type ResolvedAlpineConfig = {
  version: string;
  branch?: string;
  mirror?: string;
  kernelPackage?: string;
  kernelImage?: string;
  /** libkrunfw release version (e.g. `v5.2.1`) */
  krunfwVersion: string;
  rootfsPackages: string[];
  initramfsPackages: string[];
};

export interface BuildOptions {
  /** output directory for the built assets */
  outputDir: string;

  /** base directory to resolve relative config paths against */
  configDir?: string;

  /** whether to print progress to stderr (default: true) */
  verbose?: boolean;
  /** working directory for the build (default: temp directory) */
  workDir?: string;
  /** whether to skip building sandbox helper binaries */
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

/** Detect available container runtime */
export function detectContainerRuntime(
  preferred?: "docker" | "podman",
): "docker" | "podman" {
  if (preferred) {
    try {
      execFileSync(preferred, ["--version"], { stdio: "pipe" });
      return preferred;
    } catch {
      throw new Error(`Preferred container runtime '${preferred}' not found`);
    }
  }

  for (const runtime of ["docker", "podman"] as const) {
    try {
      execFileSync(runtime, ["--version"], { stdio: "pipe" });
      return runtime;
    } catch {
      // Continue to next runtime.
    }
  }

  throw new Error(
    "No container runtime found. Please install Docker or Podman.",
  );
}

/** Run a command and stream output */
export async function runCommand(
  command: string,
  args: string[],
  options: SpawnOptions,
  log: (msg: string) => void,
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

export function resolveConfigPath(value: string, configDir?: string): string {
  if (path.isAbsolute(value)) return value;
  return configDir ? path.resolve(configDir, value) : path.resolve(value);
}

/** Find the guest directory from the provided search roots */
export function findGuestDirFrom(
  starts: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const envPath = env.GONDOLIN_GUEST_SRC;
  if (envPath && fs.existsSync(path.join(envPath, "build.zig"))) {
    return envPath;
  }

  const visited = new Set<string>();

  for (const start of starts) {
    let dir = path.resolve(start);

    for (let i = 0; i < 12; i++) {
      const candidate = path.join(dir, "guest");
      if (!visited.has(candidate)) {
        visited.add(candidate);
        if (fs.existsSync(path.join(candidate, "build.zig"))) {
          return candidate;
        }
      }

      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  return null;
}

/** Find the guest directory relative to this package */
export function findGuestDir(): string | null {
  return findGuestDirFrom([import.meta.dirname, process.cwd()]);
}

/** Find the host package root (directory containing package.json) */
export function findHostPackageRoot(): string | null {
  let dir = import.meta.dirname;

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

/** Ensure `dist/` exists for container builds */
export function ensureHostDistBuilt(
  hostPkgRoot: string,
  log: (msg: string) => void,
): void {
  const distBuilder = path.join(
    hostPkgRoot,
    "dist",
    "src",
    "build",
    "index.js",
  );

  const runningFromDist =
    path.basename(import.meta.dirname) === "src" &&
    path.basename(path.dirname(import.meta.dirname)) === "dist";
  if (runningFromDist) {
    return;
  }

  const tsconfigPath = path.join(hostPkgRoot, "tsconfig.build.json");
  const postbuildPath = path.join(hostPkgRoot, "scripts", "postbuild.mjs");
  const tscPath = path.join(
    hostPkgRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );

  if (!fs.existsSync(tsconfigPath)) {
    return;
  }

  if (!fs.existsSync(tscPath)) {
    if (fs.existsSync(distBuilder)) {
      return;
    }
    throw new Error(
      `Cannot build host dist output: typescript not found at ${tscPath}. ` +
        "Run `pnpm install` and then `pnpm -C host build`.",
    );
  }

  log("Building host dist output (tsc) for container build...");

  try {
    execFileSync(process.execPath, [tscPath, "-p", tsconfigPath], {
      cwd: hostPkgRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });

    if (fs.existsSync(postbuildPath)) {
      execFileSync(process.execPath, [postbuildPath], {
        cwd: hostPkgRoot,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
    }
  } catch (err) {
    const e = err as {
      stdout?: unknown;
      stderr?: unknown;
      status?: unknown;
    };

    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";

    throw new Error(
      `Host dist build failed (exit ${String(e.status ?? "?")}).\n` +
        `Build command: ${process.execPath} ${tscPath} -p ${tsconfigPath}` +
        (fs.existsSync(postbuildPath)
          ? ` && ${process.execPath} ${postbuildPath}`
          : "") +
        "\n" +
        (stdout || stderr
          ? `--- build output ---\n${stdout}${stderr}`
          : "(no build output captured)"),
    );
  }

  if (!fs.existsSync(distBuilder)) {
    throw new Error(
      `Host dist build failed: ${distBuilder} not found after tsc run`,
    );
  }
}

export type SandboxBinaryPaths = {
  sandboxdPath: string;
  sandboxfsPath: string;
  sandboxsshPath: string;
  sandboxingressPath: string;
};

function envFlagEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertSandboxBinaryPathsExist(paths: SandboxBinaryPaths): void {
  for (const [name, filePath] of Object.entries(paths)) {
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `${name.replace(/Path$/, "")} binary not found: ${filePath}`,
      );
    }
  }
}

function guestZigOutBinaryPaths(guestDir: string): SandboxBinaryPaths {
  const binDir = path.join(guestDir, "zig-out", "bin");
  return {
    sandboxdPath: path.join(binDir, "sandboxd"),
    sandboxfsPath: path.join(binDir, "sandboxfs"),
    sandboxsshPath: path.join(binDir, "sandboxssh"),
    sandboxingressPath: path.join(binDir, "sandboxingress"),
  };
}

function resolveExistingGuestZigOutBinaryPaths(): SandboxBinaryPaths {
  const guestDir = findGuestDir();
  if (!guestDir) {
    throw new Error(
      "Could not find existing sandbox helper binaries. " +
        "When skipBinaries=true, provide all four sandbox helper paths or " +
        "set GONDOLIN_GUEST_SRC to a guest source directory with " +
        "zig-out/bin helpers.",
    );
  }

  return guestZigOutBinaryPaths(guestDir);
}

async function buildSandboxBinaryPathsFromSource(
  arch: Architecture,
  log: (msg: string) => void,
): Promise<SandboxBinaryPaths> {
  const guestDir = findGuestDir();
  if (!guestDir) {
    throw new Error(
      `Cannot build sandbox helpers from source because ${BUILD_SANDBOX_HELPERS_FROM_SOURCE_ENV}=1 was set, ` +
        "but guest sources were not found. Use a Gondolin checkout or set " +
        "GONDOLIN_GUEST_SRC. " +
        "This contributor path requires Zig 0.16.0.",
    );
  }

  log(`Using guest sources from: ${guestDir}`);
  log("Building sandbox helpers from Zig sources...");
  try {
    await buildGuestBinaries(guestDir, arch, log);
  } catch (error) {
    throw new Error(
      "Failed to build sandbox helpers from Zig sources. " +
        "Install Zig 0.16.0 or unset " +
        `${BUILD_SANDBOX_HELPERS_FROM_SOURCE_ENV} to use published helpers.\n` +
        `Cause: ${errorMessage(error)}`,
    );
  }

  return guestZigOutBinaryPaths(guestDir);
}

/** Resolve/build sandbox binaries used in image assembly */
export async function resolveSandboxBinaryPaths(
  config: BuildConfig,
  options: BuildOptions,
  log: (msg: string) => void,
): Promise<SandboxBinaryPaths> {
  const configDir = options.configDir;

  const customPaths: Partial<SandboxBinaryPaths> = {
    sandboxdPath: config.sandboxdPath
      ? resolveConfigPath(config.sandboxdPath, configDir)
      : undefined,
    sandboxfsPath: config.sandboxfsPath
      ? resolveConfigPath(config.sandboxfsPath, configDir)
      : undefined,
    sandboxsshPath: config.sandboxsshPath
      ? resolveConfigPath(config.sandboxsshPath, configDir)
      : undefined,
    sandboxingressPath: config.sandboxingressPath
      ? resolveConfigPath(config.sandboxingressPath, configDir)
      : undefined,
  };

  const providedCustomPaths = Object.entries(customPaths).filter(
    ([, value]) => value !== undefined,
  );
  if (providedCustomPaths.length === 4) {
    const paths = customPaths as SandboxBinaryPaths;
    assertSandboxBinaryPathsExist(paths);
    return paths;
  }

  if (providedCustomPaths.length > 0) {
    const provided = providedCustomPaths.map(([name]) => name).join(", ");
    const missing = Object.entries(customPaths)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name)
      .join(", ");
    throw new Error(
      "Partial sandbox helper path overrides are not supported. " +
        "Provide all four build config fields: sandboxdPath, " +
        "sandboxfsPath, sandboxsshPath, sandboxingressPath. " +
        `Provided: ${provided}. Missing: ${missing}.`,
    );
  }

  const explicitHelpersDir = process.env.GONDOLIN_SANDBOX_HELPERS_DIR?.trim();
  if (explicitHelpersDir && explicitHelpersDir.length > 0) {
    try {
      const resolved = await ensureSandboxHelperBinaries({
        arch: config.arch,
        log,
      });
      assertSandboxBinaryPathsExist(resolved.paths);
      return resolved.paths;
    } catch (error) {
      throw new Error(
        "Could not use sandbox helpers from " +
          `GONDOLIN_SANDBOX_HELPERS_DIR=${explicitHelpersDir}: ` +
          errorMessage(error),
      );
    }
  }

  if (options.skipBinaries) {
    const paths = resolveExistingGuestZigOutBinaryPaths();
    assertSandboxBinaryPathsExist(paths);
    return paths;
  }

  try {
    const resolved = await ensureSandboxHelperBinaries({
      arch: config.arch,
      log,
    });
    assertSandboxBinaryPathsExist(resolved.paths);
    return resolved.paths;
  } catch (error) {
    if (!envFlagEnabled(BUILD_SANDBOX_HELPERS_FROM_SOURCE_ENV)) {
      throw new Error(
        `Could not resolve published sandbox helper binaries for ${config.arch}.\n` +
          "Set GONDOLIN_SANDBOX_HELPERS_DIR to a directory containing " +
          "bin/sandboxd, bin/sandboxfs, bin/sandboxssh, and " +
          "bin/sandboxingress, or provide all four sandbox helper paths " +
          "in the build config.\n" +
          `Contributors can set ${BUILD_SANDBOX_HELPERS_FROM_SOURCE_ENV}=1 to build helpers from Zig sources instead.\n` +
          `Cause: ${errorMessage(error)}`,
      );
    }

    log(`Could not resolve published sandbox helpers: ${errorMessage(error)}`);
    log(
      `Falling back to Zig source build because ${BUILD_SANDBOX_HELPERS_FROM_SOURCE_ENV}=1`,
    );
  }

  const paths = await buildSandboxBinaryPathsFromSource(config.arch, log);
  assertSandboxBinaryPathsExist(paths);
  return paths;
}

async function buildGuestBinaries(
  guestDir: string,
  arch: Architecture,
  log: (msg: string) => void,
): Promise<void> {
  const zigTarget = ZIG_TARGETS[arch];
  log(`Building for target: ${zigTarget}`);

  await runCommand(
    "zig",
    ["build", "-Doptimize=ReleaseSmall", `-Dtarget=${zigTarget}`],
    { cwd: guestDir },
    log,
  );
}

/** Compute SHA256 hash of a file */
export function computeFileHash(filePath: string): string {
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

export function writeAssetManifest(
  outputDir: string,
  config: BuildConfig,
  ociSource?: {
    image: string;
    runtime: "docker" | "podman";
    platform: string;
    pullPolicy: "if-not-present" | "always" | "never";
    digest?: string;
    reference?: string;
  },
): { manifestPath: string; manifest: AssetManifest } {
  const kernelDst = path.join(outputDir, KERNEL_FILENAME);
  const initramfsDst = path.join(outputDir, INITRAMFS_FILENAME);
  const rootfsDst = path.join(outputDir, ROOTFS_FILENAME);

  const krunKernelDst = path.join(outputDir, KRUN_KERNEL_FILENAME);
  const krunInitrdDst = path.join(outputDir, KRUN_INITRD_FILENAME);

  const checksums: AssetManifest["checksums"] = {
    kernel: computeFileHash(kernelDst),
    initramfs: computeFileHash(initramfsDst),
    rootfs: computeFileHash(rootfsDst),
  };

  const assets: AssetManifest["assets"] = {
    kernel: KERNEL_FILENAME,
    initramfs: INITRAMFS_FILENAME,
    rootfs: ROOTFS_FILENAME,
  };

  if (fs.existsSync(krunKernelDst)) {
    assets.krunKernel = KRUN_KERNEL_FILENAME;
    checksums.krunKernel = computeFileHash(krunKernelDst);
  }

  if (fs.existsSync(krunInitrdDst)) {
    assets.krunInitrd = KRUN_INITRD_FILENAME;
    checksums.krunInitrd = computeFileHash(krunInitrdDst);
  }

  const manifest: AssetManifest = {
    version: 1,
    buildId: computeAssetBuildId({ checksums, arch: config.arch }),
    config,
    buildTime: new Date().toISOString(),
    assets,
    checksums,
  };

  if (config.runtimeDefaults) {
    manifest.runtimeDefaults = { ...config.runtimeDefaults };
  }

  if (ociSource) {
    manifest.ociSource = { ...ociSource };
  }

  const manifestPath = path.join(outputDir, MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { manifestPath, manifest };
}

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execFileSync, spawn, type SpawnOptions } from "child_process";

import {
  MANIFEST_FILENAME,
  computeAssetBuildId,
  type AssetManifest,
} from "../assets";
import type { BuildConfig, Architecture } from "./config";

/** Fixed output filenames for assets */
export const KERNEL_FILENAME = "vmlinuz-virt";
export const INITRAMFS_FILENAME = "initramfs.cpio.lz4";
export const ROOTFS_FILENAME = "rootfs.ext4";

/** Zig target triples for cross-compilation */
const ZIG_TARGETS: Record<Architecture, string> = {
  aarch64: "aarch64-linux-musl",
  x86_64: "x86_64-linux-musl",
};

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

/** Find the guest directory relative to this package */
export function findGuestDir(): string | null {
  if (process.env.GONDOLIN_GUEST_SRC) {
    const envPath = process.env.GONDOLIN_GUEST_SRC;
    if (fs.existsSync(path.join(envPath, "build.zig"))) {
      return envPath;
    }
  }

  const starts = [__dirname, process.cwd()];
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

/** Find the host package root (directory containing package.json) */
export function findHostPackageRoot(): string | null {
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
          : "(no tsc output captured)"),
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

/** Resolve/build sandbox binaries used in image assembly */
export async function resolveSandboxBinaryPaths(
  config: BuildConfig,
  options: BuildOptions,
  log: (msg: string) => void,
): Promise<SandboxBinaryPaths> {
  const configDir = options.configDir;

  let sandboxdPath = config.sandboxdPath
    ? resolveConfigPath(config.sandboxdPath, configDir)
    : undefined;
  let sandboxfsPath = config.sandboxfsPath
    ? resolveConfigPath(config.sandboxfsPath, configDir)
    : undefined;
  let sandboxsshPath = config.sandboxsshPath
    ? resolveConfigPath(config.sandboxsshPath, configDir)
    : undefined;
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
          "  3. Provide sandboxdPath and sandboxfsPath in the build config.",
      );
    }
    log(`Using guest sources from: ${guestDir}`);
    log("Building guest binaries...");
    await buildGuestBinaries(guestDir, config.arch, log);
    sandboxdPath = path.join(guestDir, "zig-out", "bin", "sandboxd");
    sandboxfsPath = path.join(guestDir, "zig-out", "bin", "sandboxfs");
    sandboxsshPath = path.join(guestDir, "zig-out", "bin", "sandboxssh");
    sandboxingressPath = path.join(
      guestDir,
      "zig-out",
      "bin",
      "sandboxingress",
    );
  } else if (
    !sandboxdPath ||
    !sandboxfsPath ||
    !sandboxsshPath ||
    !sandboxingressPath
  ) {
    const guestDir = findGuestDir();
    sandboxdPath =
      sandboxdPath ?? path.join(guestDir ?? "", "zig-out", "bin", "sandboxd");
    sandboxfsPath =
      sandboxfsPath ?? path.join(guestDir ?? "", "zig-out", "bin", "sandboxfs");
    sandboxsshPath =
      sandboxsshPath ??
      path.join(guestDir ?? "", "zig-out", "bin", "sandboxssh");
    sandboxingressPath =
      sandboxingressPath ??
      path.join(guestDir ?? "", "zig-out", "bin", "sandboxingress");
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

  return {
    sandboxdPath,
    sandboxfsPath,
    sandboxsshPath,
    sandboxingressPath,
  };
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

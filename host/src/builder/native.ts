import fs from "fs";
import os from "os";
import path from "path";

import { buildAlpineImages } from "../build/alpine";
import type { BuildConfig, Architecture } from "../build/config";
import { parseApkIndex } from "../alpine/packages";
import { decompressTarGz, parseTar } from "../alpine/tar";
import { downloadFile } from "../alpine/utils";
import {
  DEFAULT_ROOTFS_PACKAGES,
  INITRAMFS_FILENAME,
  KERNEL_FILENAME,
  ROOTFS_FILENAME,
  resolveConfigPath,
  resolveSandboxBinaryPaths,
  writeAssetManifest,
  type BuildOptions,
  type BuildResult,
  type ResolvedAlpineConfig,
} from "./shared";

function hasOciRootfs(config: BuildConfig): boolean {
  return config.oci !== undefined;
}

function resolveAlpineConfig(config: BuildConfig): ResolvedAlpineConfig {
  const alpine = config.alpine ?? { version: "3.23.0" };
  const kernelPackage = alpine.kernelPackage ?? "linux-virt";
  const useOciRootfs = hasOciRootfs(config);
  const defaultRootfsPackages = useOciRootfs
    ? []
    : DEFAULT_ROOTFS_PACKAGES.map((pkg) =>
        pkg === "linux-virt" ? kernelPackage : pkg,
      );
  const defaultInitramfsPackages = useOciRootfs ? [kernelPackage] : [];

  const initramfsPackages = [
    ...(alpine.initramfsPackages ?? defaultInitramfsPackages),
  ];
  if (useOciRootfs && !initramfsPackages.includes(kernelPackage)) {
    initramfsPackages.unshift(kernelPackage);
  }

  return {
    version: alpine.version,
    branch: alpine.branch,
    mirror: alpine.mirror,
    kernelPackage: alpine.kernelPackage,
    kernelImage: alpine.kernelImage,
    rootfsPackages: useOciRootfs
      ? []
      : (alpine.rootfsPackages ?? defaultRootfsPackages),
    initramfsPackages,
  };
}

/** Build assets natively (Linux or macOS with appropriate tools) */
export async function buildNative(
  config: BuildConfig,
  options: BuildOptions,
  workDir: string,
  log: (msg: string) => void,
): Promise<BuildResult> {
  const outputDir = path.resolve(options.outputDir);
  const configDir = options.configDir;

  const binaries = await resolveSandboxBinaryPaths(config, options, log);

  log("Building guest images...");

  const alpineConfig = resolveAlpineConfig(config);
  if (
    hasOciRootfs(config) &&
    (config.alpine?.rootfsPackages?.length ?? 0) > 0
  ) {
    log("Ignoring alpine.rootfsPackages because oci rootfs source is enabled");
  }

  const { kernelPackage } = resolveKernelConfig(alpineConfig);
  if (!hasOciRootfs(config)) {
    warnOnKernelPackageMismatch(alpineConfig.rootfsPackages, kernelPackage);
  }

  const cacheDir = path.join(os.homedir(), ".cache", "gondolin", "build");

  let rootfsInit: string | undefined;
  let initramfsInit: string | undefined;
  let rootfsInitExtra: string | undefined;
  if (config.init?.rootfsInit) {
    rootfsInit = fs.readFileSync(
      resolveConfigPath(config.init.rootfsInit, configDir),
      "utf8",
    );
  }
  if (config.init?.initramfsInit) {
    initramfsInit = fs.readFileSync(
      resolveConfigPath(config.init.initramfsInit, configDir),
      "utf8",
    );
  }
  if (config.init?.rootfsInitExtra) {
    rootfsInitExtra = fs.readFileSync(
      resolveConfigPath(config.init.rootfsInitExtra, configDir),
      "utf8",
    );
  }

  let alpineUrl: string | undefined;
  if (alpineConfig.mirror) {
    const branch =
      alpineConfig.branch ??
      `v${alpineConfig.version.split(".").slice(0, 2).join(".")}`;
    alpineUrl = `${alpineConfig.mirror}/${branch}/releases/${config.arch}/alpine-minirootfs-${alpineConfig.version}-${config.arch}.tar.gz`;
  }

  const alpineBuild = await buildAlpineImages({
    arch: config.arch,
    alpineVersion: alpineConfig.version,
    alpineBranch:
      alpineConfig.branch ??
      `v${alpineConfig.version.split(".").slice(0, 2).join(".")}`,
    alpineUrl,
    ociRootfs: config.oci,
    rootfsPackages: alpineConfig.rootfsPackages,
    initramfsPackages: alpineConfig.initramfsPackages,
    sandboxdBin: binaries.sandboxdPath,
    sandboxfsBin: binaries.sandboxfsPath,
    sandboxsshBin: binaries.sandboxsshPath,
    sandboxingressBin: binaries.sandboxingressPath,
    rootfsLabel: config.rootfs?.label ?? "gondolin-root",
    rootfsSizeMb: config.rootfs?.sizeMb,
    rootfsInit,
    initramfsInit,
    rootfsInitExtra,
    postBuildCommands: config.postBuild?.commands ?? [],
    defaultEnv: config.env,
    workDir,
    cacheDir,
    log,
  });

  log("Fetching kernel...");
  await fetchKernel(workDir, config.arch, alpineConfig, cacheDir, log);

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

  log("Generating manifest...");
  const { manifestPath, manifest } = writeAssetManifest(
    outputDir,
    config,
    alpineBuild.ociSource,
  );

  log(`Build complete! Assets written to ${outputDir}`);

  return {
    outputDir,
    manifestPath,
    manifest,
  };
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
  const kernelImage =
    alpineConfig.kernelImage ?? deriveKernelImage(kernelPackage);
  return { kernelPackage, kernelImage };
}

function deriveKernelImage(kernelPackage: string): string {
  if (
    kernelPackage.startsWith("linux-") &&
    kernelPackage.length > "linux-".length
  ) {
    return `vmlinuz-${kernelPackage.slice("linux-".length)}`;
  }
  return "vmlinuz-virt";
}

function warnOnKernelPackageMismatch(
  rootfsPackages: string[],
  kernelPackage: string,
): void {
  if (!rootfsPackages.includes(kernelPackage)) {
    process.stderr.write(
      `Warning: rootfsPackages does not include kernel package '${kernelPackage}'. ` +
        "This may cause module mismatches at boot.\n",
    );
  }
}

async function fetchKernel(
  outputDir: string,
  arch: Architecture,
  alpineConfig: ResolvedAlpineConfig,
  cacheDir: string,
  log: (msg: string) => void,
): Promise<void> {
  const kernelPath = path.join(outputDir, KERNEL_FILENAME);

  if (fs.existsSync(kernelPath)) {
    log("Kernel already present, skipping download");
    return;
  }

  const version = alpineConfig.version;
  const branch =
    alpineConfig.branch ?? `v${version.split(".").slice(0, 2).join(".")}`;
  const mirror = alpineConfig.mirror ?? "https://dl-cdn.alpinelinux.org/alpine";
  const { kernelPackage, kernelImage } = resolveKernelConfig(alpineConfig);

  log(`Fetching ${kernelPackage} from Alpine ${branch} (${arch})`);

  fs.mkdirSync(cacheDir, { recursive: true });

  const indexTarPath = path.join(
    cacheDir,
    `APKINDEX-main-${branch}-${arch}.tar.gz`,
  );
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

  const apkFilename = `${kernelPackage}-${kernelVersion}.apk`;
  const apkPath = path.join(cacheDir, `${arch}-${apkFilename}`);

  if (!fs.existsSync(apkPath)) {
    const apkUrl = `${mirror}/${branch}/main/${arch}/${apkFilename}`;
    await downloadFile(apkUrl, apkPath);
  }

  const apkRaw = await decompressTarGz(apkPath);
  const apkEntries = parseTar(apkRaw);
  const kernelEntry = apkEntries.find(
    (e) => e.name === `boot/${kernelImage}` && e.content,
  );

  if (!kernelEntry?.content) {
    throw new Error(
      `Kernel image 'boot/${kernelImage}' not found in ${apkFilename}`,
    );
  }

  fs.writeFileSync(kernelPath, kernelEntry.content);
}

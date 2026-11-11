import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

import { buildAlpineImages } from "./alpine.ts";
import { gondolinCacheDir } from "../cache.ts";
import { type Architecture, type BuildConfig, hasOciRootfs } from "./config.ts";
import { extractTarGz } from "../alpine/tar.ts";
import { downloadFile, DownloadFileError } from "../alpine/utils.ts";
import { createEmptyInitrd } from "../utils/empty-initrd.ts";
import {
  DEFAULT_ROOTFS_PACKAGES,
  INITRAMFS_FILENAME,
  KERNEL_FILENAME,
  ROOTFS_FILENAME,
  KRUN_KERNEL_FILENAME,
  KRUN_INITRD_FILENAME,
  resolveConfigPath,
  resolveSandboxBinaryPaths,
  writeAssetManifest,
  type BuildOptions,
  type BuildResult,
  type ResolvedAlpineConfig,
} from "./shared.ts";

const LIBKRUNFW_RELEASE_BASE_URL =
  "https://github.com/containers/libkrunfw/releases/download";
const DEFAULT_LIBKRUNFW_VERSION = "v5.2.1";

function resolveAlpineConfig(config: BuildConfig): ResolvedAlpineConfig {
  const alpine = config.alpine ?? { version: "3.23.7" };
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
    krunfwVersion: alpine.krunfwVersion ?? DEFAULT_LIBKRUNFW_VERSION,
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

  const { kernelPackage, kernelImage } = resolveKernelConfig(alpineConfig);
  if (!hasOciRootfs(config)) {
    warnOnKernelPackageMismatch(alpineConfig.rootfsPackages, kernelPackage);
  }

  const cacheDir = gondolinCacheDir("build");

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

  const postBuildCopy = (config.postBuild?.copy ?? []).map((entry) => ({
    src: resolveConfigPath(entry.src, configDir),
    dest: entry.dest,
  }));

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
    kernelImage,
    sandboxdBin: binaries.sandboxdPath,
    sandboxfsBin: binaries.sandboxfsPath,
    sandboxsshBin: binaries.sandboxsshPath,
    sandboxingressBin: binaries.sandboxingressPath,
    rootfsLabel: config.rootfs?.label ?? "gondolin-root",
    rootfsSizeMb: config.rootfs?.sizeMb,
    rootfsInit,
    initramfsInit,
    rootfsInitExtra,
    postBuildCopy,
    postBuildCommands: config.postBuild?.commands ?? [],
    defaultEnv: config.env,
    workDir,
    cacheDir,
    log,
  });

  log("Fetching libkrunfw-compatible kernel...");
  await fetchKrunBootAssets(
    workDir,
    config.arch,
    alpineConfig.krunfwVersion,
    cacheDir,
    log,
  );

  log("Copying assets to output directory...");

  const kernelSrc = alpineBuild.kernel;
  const initramfsSrc = path.join(workDir, INITRAMFS_FILENAME);
  const rootfsSrc = path.join(workDir, ROOTFS_FILENAME);
  const krunKernelSrc = path.join(workDir, KRUN_KERNEL_FILENAME);
  const krunInitrdSrc = path.join(workDir, KRUN_INITRD_FILENAME);

  const kernelDst = path.join(outputDir, KERNEL_FILENAME);
  const initramfsDst = path.join(outputDir, INITRAMFS_FILENAME);
  const rootfsDst = path.join(outputDir, ROOTFS_FILENAME);
  const krunKernelDst = path.join(outputDir, KRUN_KERNEL_FILENAME);
  const krunInitrdDst = path.join(outputDir, KRUN_INITRD_FILENAME);

  fs.copyFileSync(kernelSrc, kernelDst);
  fs.copyFileSync(initramfsSrc, initramfsDst);
  fs.copyFileSync(rootfsSrc, rootfsDst);
  fs.copyFileSync(krunKernelSrc, krunKernelDst);
  fs.copyFileSync(krunInitrdSrc, krunInitrdDst);

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
        "The kernel image and its modules are taken from that package, so the build will fail unless another package installs them.\n",
    );
  }
}

type KrunArchive = {
  archivePath: string;
  kind: "prebuilt" | "shared";
};

type DownloadFileFn = (url: string, dest: string) => Promise<void>;

async function fetchKrunBootAssets(
  outputDir: string,
  arch: Architecture,
  krunfwVersion: string,
  cacheDir: string,
  log: (msg: string) => void,
): Promise<void> {
  const kernelPath = path.join(outputDir, KRUN_KERNEL_FILENAME);
  const initrdPath = path.join(outputDir, KRUN_INITRD_FILENAME);

  if (fs.existsSync(kernelPath) && fs.existsSync(initrdPath)) {
    log("libkrunfw boot artifacts already present, skipping download");
    return;
  }

  const casKernelPath = await ensureKrunKernelInCache(
    arch,
    krunfwVersion,
    cacheDir,
    log,
  );

  fs.copyFileSync(casKernelPath, kernelPath);
  if (!fs.existsSync(initrdPath)) {
    fs.writeFileSync(initrdPath, createEmptyInitrd());
  }
}

async function ensureKrunKernelInCache(
  arch: Architecture,
  krunfwVersion: string,
  cacheDir: string,
  log: (msg: string) => void,
): Promise<string> {
  const archName = mapKrunArch(arch);
  const indexDir = path.join(
    cacheDir,
    "libkrunfw",
    "index",
    krunfwVersion,
    archName,
  );
  // x86_64 kernels are wrapped in an ELF since the raw bundle lost its load
  // and entry addresses: a raw kernel cached by older builds must not be used
  const digestPath = path.join(
    indexDir,
    archName === "x86_64" ? "kernel-elf.sha256" : "kernel.sha256",
  );

  if (fs.existsSync(digestPath)) {
    const digest = fs.readFileSync(digestPath, "utf8").trim();
    if (digest) {
      const cached = path.join(cacheDir, "cas", "sha256", digest);
      if (fs.existsSync(cached)) {
        log(`Using cached libkrunfw kernel ${digest.slice(0, 12)}...`);
        return cached;
      }
    }
  }

  const archive = await downloadKrunArchive(
    krunfwVersion,
    archName,
    cacheDir,
    log,
  );
  const kernel = krunKernelImage(
    await extractKrunKernelFromArchive(archive, archName, log),
    archName,
  );
  const digest = sha256(kernel);

  const casDir = path.join(cacheDir, "cas", "sha256");
  fs.mkdirSync(casDir, { recursive: true });
  const casPath = path.join(casDir, digest);
  if (!fs.existsSync(casPath)) {
    fs.writeFileSync(casPath, kernel);
  }

  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(digestPath, `${digest}\n`);

  log(`Cached libkrunfw kernel ${digest.slice(0, 12)}...`);
  return casPath;
}

async function downloadKrunArchive(
  krunfwVersion: string,
  archName: "aarch64" | "x86_64",
  cacheDir: string,
  log: (msg: string) => void,
  download: DownloadFileFn = downloadFile,
): Promise<KrunArchive> {
  const releaseDir = path.join(
    cacheDir,
    "libkrunfw",
    "downloads",
    krunfwVersion,
    archName,
  );
  fs.mkdirSync(releaseDir, { recursive: true });

  const prebuiltName = `libkrunfw-prebuilt-${archName}.tgz`;
  const prebuiltPath = path.join(releaseDir, prebuiltName);

  if (fs.existsSync(prebuiltPath)) {
    return { archivePath: prebuiltPath, kind: "prebuilt" };
  }

  const prebuiltUrl = `${LIBKRUNFW_RELEASE_BASE_URL}/${krunfwVersion}/${prebuiltName}`;
  try {
    log(`Downloading ${prebuiltUrl}`);
    await download(prebuiltUrl, prebuiltPath);
    return { archivePath: prebuiltPath, kind: "prebuilt" };
  } catch (err) {
    if (!isNotFoundDownloadError(err)) {
      throw err;
    }
    log(
      `No prebuilt libkrunfw archive for ${archName} (${krunfwVersion}); falling back to shared archive`,
    );
  }

  const sharedName = `libkrunfw-${archName}.tgz`;
  const sharedPath = path.join(releaseDir, sharedName);
  if (!fs.existsSync(sharedPath)) {
    const sharedUrl = `${LIBKRUNFW_RELEASE_BASE_URL}/${krunfwVersion}/${sharedName}`;
    log(`Downloading ${sharedUrl}`);
    await download(sharedUrl, sharedPath);
  }

  return { archivePath: sharedPath, kind: "shared" };
}

/** The kernel of a libkrunfw release: what `krunfw_get_kernel` returns. */
type KrunfwKernel = {
  /** raw kernel image (`KERNEL_BUNDLE`) */
  bundle: Buffer;
  /** guest physical address the bundle is loaded at (when known) */
  loadAddr?: number;
  /** guest physical entry point (when known) */
  entryAddr?: number;
};

/**
 * The kernel file for the image's `krunKernel`. libkrun maps a raw kernel at
 * its default address (0x80000000), which is where libkrunfw's aarch64
 * kernels expect to run; its x86_64 kernels load at 0x1000000 with their own
 * entry point, so they are wrapped in an ELF that carries both (the krun
 * runner passes ELF kernels as `KRUN_KERNEL_FORMAT_ELF`).
 */
function krunKernelImage(
  kernel: KrunfwKernel,
  archName: "aarch64" | "x86_64",
): Buffer {
  if (archName !== "x86_64") {
    return kernel.bundle;
  }
  if (kernel.loadAddr === undefined || kernel.entryAddr === undefined) {
    throw new Error(
      "cannot determine the load and entry addresses of the libkrunfw x86_64 kernel",
    );
  }
  return wrapKernelInElf(kernel.bundle, kernel.loadAddr, kernel.entryAddr);
}

/** An x86_64 `ET_EXEC` ELF with `bundle` as its only (RWX) segment. */
function wrapKernelInElf(
  bundle: Buffer,
  loadAddr: number,
  entryAddr: number,
): Buffer {
  const ehdrSize = 64;
  const phdrSize = 56;
  const dataOffset = 0x1000;
  const header = Buffer.alloc(dataOffset);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0); // ELF64, LE, version 1
  header.writeUInt16LE(2, 16); // ET_EXEC
  header.writeUInt16LE(62, 18); // EM_X86_64
  header.writeUInt32LE(1, 20);
  header.writeBigUInt64LE(BigInt(entryAddr), 24);
  header.writeBigUInt64LE(BigInt(ehdrSize), 32); // e_phoff
  header.writeUInt16LE(ehdrSize, 52);
  header.writeUInt16LE(phdrSize, 54);
  header.writeUInt16LE(1, 56); // e_phnum
  header.writeUInt16LE(64, 58); // e_shentsize (no sections)
  const ph = ehdrSize;
  header.writeUInt32LE(1, ph); // PT_LOAD
  header.writeUInt32LE(7, ph + 4); // PF_R | PF_W | PF_X
  header.writeBigUInt64LE(BigInt(dataOffset), ph + 8);
  header.writeBigUInt64LE(BigInt(loadAddr), ph + 16); // p_vaddr
  header.writeBigUInt64LE(BigInt(loadAddr), ph + 24); // p_paddr
  header.writeBigUInt64LE(BigInt(bundle.length), ph + 32); // p_filesz
  header.writeBigUInt64LE(BigInt(bundle.length), ph + 40); // p_memsz
  header.writeBigUInt64LE(0x1000n, ph + 48); // p_align
  return Buffer.concat([header, bundle]);
}

async function extractKrunKernelFromArchive(
  archive: KrunArchive,
  archName: "aarch64" | "x86_64",
  log: (msg: string) => void,
): Promise<KrunfwKernel> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-krunfw-"));

  try {
    const extractDir = path.join(tmpDir, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    await extractTarGz(archive.archivePath, extractDir);

    if (archive.kind === "prebuilt") {
      log("Extracting kernel from libkrunfw prebuilt archive");
      return extractKernelFromPrebuiltArchive(extractDir);
    }

    log("Extracting kernel from libkrunfw shared archive");
    return extractKernelFromSharedArchive(extractDir, archName);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function extractKernelBundleFromCSource(source: string): Buffer {
  const assignment = /\bKERNEL_BUNDLE\s*\[\s*\]\s*=/.exec(source);
  if (!assignment) {
    throw new Error("libkrunfw kernel.c does not define KERNEL_BUNDLE");
  }

  const chunks: Buffer[] = [];
  let current: number[] = [];
  let cursor = assignment.index + assignment[0].length;
  let sawString = false;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(Buffer.from(current));
    current = [];
  };
  const pushByte = (value: number) => {
    current.push(value & 0xff);
    if (current.length >= 64 * 1024) flush();
  };

  while (cursor < source.length) {
    cursor = skipCWhitespaceAndComments(source, cursor);
    const ch = source[cursor];
    if (ch === ";") break;
    if (ch !== '"') {
      throw new Error(
        "libkrunfw kernel.c KERNEL_BUNDLE is not a string literal",
      );
    }
    sawString = true;
    cursor = parseCStringLiteral(source, cursor, pushByte);
  }

  if (!sawString) {
    throw new Error("libkrunfw kernel.c KERNEL_BUNDLE has no string data");
  }

  flush();
  return Buffer.concat(chunks);
}

function skipCWhitespaceAndComments(source: string, offset: number): number {
  let cursor = offset;

  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      cursor += 1;
      continue;
    }

    if (source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }

    if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      if (end === -1) {
        throw new Error("unterminated comment in libkrunfw kernel.c");
      }
      cursor = end + 2;
      continue;
    }

    break;
  }

  return cursor;
}

function parseCStringLiteral(
  source: string,
  offset: number,
  pushByte: (value: number) => void,
): number {
  let cursor = offset + 1;

  while (cursor < source.length) {
    const code = source.charCodeAt(cursor);
    cursor += 1;

    if (code === 0x22) {
      return cursor;
    }

    if (code !== 0x5c) {
      pushByte(code);
      continue;
    }

    if (cursor >= source.length) break;
    const escapeChar = source[cursor];
    cursor += 1;

    switch (escapeChar) {
      case "'":
      case '"':
      case "?":
      case "\\":
        pushByte(escapeChar.charCodeAt(0));
        break;
      case "a":
        pushByte(0x07);
        break;
      case "b":
        pushByte(0x08);
        break;
      case "f":
        pushByte(0x0c);
        break;
      case "n":
        pushByte(0x0a);
        break;
      case "r":
        pushByte(0x0d);
        break;
      case "t":
        pushByte(0x09);
        break;
      case "v":
        pushByte(0x0b);
        break;
      case "\n":
        break;
      case "\r":
        if (source[cursor] === "\n") cursor += 1;
        break;
      case "x": {
        const start = cursor;
        while (
          cursor < source.length &&
          isHexDigit(source.charCodeAt(cursor))
        ) {
          cursor += 1;
        }
        if (cursor === start) {
          throw new Error("invalid hex escape in libkrunfw kernel.c");
        }
        pushByte(Number.parseInt(source.slice(start, cursor), 16));
        break;
      }
      default:
        if (isOctalDigit(escapeChar.charCodeAt(0))) {
          let value = escapeChar.charCodeAt(0) - 0x30;
          for (let i = 0; i < 2 && cursor < source.length; i++) {
            const next = source.charCodeAt(cursor);
            if (!isOctalDigit(next)) break;
            value = value * 8 + (next - 0x30);
            cursor += 1;
          }
          pushByte(value);
          break;
        }
        throw new Error(
          `unsupported C string escape in libkrunfw kernel.c: \\${escapeChar}`,
        );
    }
  }

  throw new Error("unterminated string literal in libkrunfw kernel.c");
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

function isOctalDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x37;
}

function extractKernelFromPrebuiltArchive(extractDir: string): KrunfwKernel {
  const kernelCPath = path.join(extractDir, "libkrunfw", "kernel.c");
  if (!fs.existsSync(kernelCPath)) {
    throw new Error(
      `libkrunfw prebuilt archive missing libkrunfw/kernel.c at ${kernelCPath}`,
    );
  }

  const source = fs.readFileSync(kernelCPath, "utf8");
  const kernel = extractKernelBundleFromCSource(source);

  if (kernel.length === 0) {
    throw new Error("libkrunfw prebuilt archive contains an empty kernel");
  }

  return { bundle: kernel, ...addressesFromCSource(source) };
}

/** `*load_addr = …;` / `*entry_addr = …;` of a generated `kernel.c`. */
function addressesFromCSource(
  source: string,
): Pick<KrunfwKernel, "loadAddr" | "entryAddr"> {
  const value = (name: string) => {
    const m = new RegExp(
      `\\*\\s*${name}\\s*=\\s*(0x[0-9a-fA-F]+|[0-9]+)\\s*;`,
    ).exec(source);
    return m ? Number(m[1]) : undefined;
  };
  return { loadAddr: value("load_addr"), entryAddr: value("entry_addr") };
}

function extractKernelFromSharedArchive(
  extractDir: string,
  archName: "aarch64" | "x86_64",
): KrunfwKernel {
  const lib64Path = path.join(extractDir, "lib64", "libkrunfw.so");
  const libPath = path.join(extractDir, "lib", "libkrunfw.so");
  const sharedLibPath = fs.existsSync(lib64Path)
    ? lib64Path
    : fs.existsSync(libPath)
      ? libPath
      : null;

  if (!sharedLibPath) {
    throw new Error(
      `libkrunfw shared archive does not contain libkrunfw.so for ${archName}`,
    );
  }

  const sharedLib = fs.readFileSync(sharedLibPath);
  try {
    const bundle = extractKernelBundleFromSharedLibraryBytes(
      sharedLib,
      archName,
    );
    if (archName !== "x86_64") {
      return { bundle };
    }
    return {
      bundle,
      ...readKrunfwAddressesFromSharedLibraryBytes(
        sharedLib,
        archName,
        bundle.length,
      ),
    };
  } catch (parseErr) {
    const hostArch = hostKrunArch();
    if (hostArch !== archName) {
      throw new Error(
        `failed to extract kernel bundle from libkrunfw shared archive for ${archName}: ${formatExecError(parseErr)}`,
      );
    }

    try {
      return extractKernelFromSharedArchiveByExecution(sharedLibPath, archName);
    } catch (execErr) {
      throw new Error(
        `failed to extract kernel bundle from libkrunfw shared archive for ${archName}; parser path failed (${formatExecError(parseErr)}); execution fallback failed (${formatExecError(execErr)})`,
      );
    }
  }
}

function extractKernelFromSharedArchiveByExecution(
  sharedLibPath: string,
  archName: "aarch64" | "x86_64",
): KrunfwKernel {
  const libDir = path.dirname(sharedLibPath);
  const buildDir = path.join(path.dirname(sharedLibPath), "build-shared");
  fs.mkdirSync(buildDir, { recursive: true });

  const extractorPath = path.join(buildDir, "extract-kernel");
  const sourcePath = path.join(buildDir, "extract-kernel.c");
  fs.writeFileSync(
    sourcePath,
    [
      "#include <stdio.h>",
      "#include <stddef.h>",
      "extern char *krunfw_get_kernel(size_t *load_addr, size_t *entry_addr, size_t *size);",
      "int main(void) {",
      "  size_t load_addr = 0, entry_addr = 0, size = 0;",
      "  char *kernel = krunfw_get_kernel(&load_addr, &entry_addr, &size);",
      "  if (!kernel || size == 0) {",
      "    return 1;",
      "  }",
      '  fprintf(stderr, "%zu %zu\\n", load_addr, entry_addr);',
      "  return fwrite(kernel, 1, size, stdout) == size ? 0 : 1;",
      "}",
      "",
    ].join("\n"),
  );

  try {
    execFileSync(
      "zig",
      [
        "cc",
        "-O2",
        sourcePath,
        `-L${libDir}`,
        `-Wl,-rpath,${libDir}`,
        "-lkrunfw",
        "-o",
        extractorPath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (err) {
    throw new Error(
      `failed to compile libkrunfw kernel extractor for ${archName}: ${formatExecError(err)}`,
    );
  }

  try {
    const run = spawnSync(extractorPath, [], {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${libDir}:${process.env.LD_LIBRARY_PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 512 * 1024 * 1024,
    });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      throw new Error(
        `extractor exited with ${run.status}: ${run.stderr.toString().trim()}`,
      );
    }
    const kernel = run.stdout;

    if (kernel.length === 0) {
      throw new Error("libkrunfw shared extractor produced an empty kernel");
    }

    const [loadAddr, entryAddr] = run.stderr
      .toString()
      .trim()
      .split(/\s+/)
      .map(Number);
    return { bundle: kernel, loadAddr, entryAddr };
  } catch (err) {
    throw new Error(
      `failed to run libkrunfw kernel extractor for ${archName}: ${formatExecError(err)}`,
    );
  }
}

type ElfEndian = "le" | "be";

type ParsedElfSection = {
  /** section type code */
  type: number;
  /** section file offset in `bytes` */
  offset: number;
  /** section size in `bytes` */
  size: number;
  /** section virtual address */
  address: number;
  /** linked section index */
  link: number;
  /** table entry size in `bytes` */
  entrySize: number;
};

function extractKernelBundleFromSharedLibraryBytes(
  bytes: Buffer,
  archName: "aarch64" | "x86_64",
): Buffer {
  const bundle = readDynamicSymbolBytes(bytes, archName, "KERNEL_BUNDLE");
  if (!bundle) {
    throw new Error("ELF does not expose KERNEL_BUNDLE symbol");
  }
  return normalizeKrunKernelBundle(bundle);
}

/** The file bytes of the dynamic symbol `symbolName` (`null`: no such symbol). */
function readDynamicSymbolBytes(
  bytes: Buffer,
  archName: "aarch64" | "x86_64",
  symbolName: string,
): Buffer | null {
  if (bytes.length < 64) {
    throw new Error("ELF header is truncated");
  }

  if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error("file is not an ELF shared library");
  }

  const elfClass = bytes.readUInt8(4);
  if (elfClass !== 2) {
    throw new Error(`unsupported ELF class ${elfClass} (expected ELF64)`);
  }

  const endianTag = bytes.readUInt8(5);
  const endian: ElfEndian =
    endianTag === 1
      ? "le"
      : endianTag === 2
        ? "be"
        : (() => {
            throw new Error(`unsupported ELF data encoding ${endianTag}`);
          })();

  const machine = readU16(bytes, 18, endian);
  const expectedMachine = archName === "aarch64" ? 183 : 62;
  if (machine !== expectedMachine) {
    throw new Error(
      `ELF machine ${machine} does not match expected ${expectedMachine} for ${archName}`,
    );
  }

  const sections = parseElfSections(bytes, endian);
  const dynsym = sections.find((section) => section.type === 11);
  if (!dynsym) {
    throw new Error("ELF does not contain .dynsym section");
  }
  if (dynsym.entrySize <= 0) {
    throw new Error("ELF .dynsym has invalid entry size");
  }
  if (dynsym.entrySize < 24) {
    throw new Error("ELF .dynsym entry size is too small for ELF64");
  }

  const dynstr = sections[dynsym.link];
  if (!dynstr) {
    throw new Error("ELF .dynsym string table link is out of range");
  }

  const dynstrBytes = sliceChecked(bytes, dynstr.offset, dynstr.size);

  const symbolCount = Math.floor(dynsym.size / dynsym.entrySize);
  let symbolValue = -1;
  let symbolSize = -1;
  let symbolSectionIndex = -1;

  for (let i = 0; i < symbolCount; i += 1) {
    const entryOffset = dynsym.offset + i * dynsym.entrySize;
    const entry = sliceChecked(bytes, entryOffset, dynsym.entrySize);

    const nameOffset = readU32(entry, 0, endian);
    if (nameOffset >= dynstrBytes.length) {
      continue;
    }

    const name = readCString(dynstrBytes, nameOffset);
    if (name !== symbolName) {
      continue;
    }

    symbolSectionIndex = readU16(entry, 6, endian);
    symbolValue = readU64(entry, 8, endian);
    symbolSize = readU64(entry, 16, endian);
    break;
  }

  if (symbolValue < 0 || symbolSize <= 0) {
    return null;
  }

  const bySection = tryResolveSymbolOffsetFromSection(
    sections,
    symbolSectionIndex,
    symbolValue,
    symbolSize,
  );
  if (bySection !== null) {
    return sliceChecked(bytes, bySection, symbolSize);
  }

  const byLoadSegment = tryResolveSymbolOffsetFromProgramHeaders(
    bytes,
    endian,
    symbolValue,
    symbolSize,
  );
  if (byLoadSegment !== null) {
    return sliceChecked(bytes, byLoadSegment, symbolSize);
  }

  throw new Error(`failed to map ${symbolName} symbol to file bytes`);
}

/**
 * The load and entry addresses `krunfw_get_kernel` reports, read from its
 * machine code: it stores both as constants (`movq $imm32, (reg)`). Of the
 * 32-bit immediates stored to memory, exactly one pair must be plausible
 * (the load address page aligned, the entry inside the `bundleSize` byte
 * kernel), else the build fails rather than guessing.
 */
function readKrunfwAddressesFromSharedLibraryBytes(
  bytes: Buffer,
  archName: "x86_64",
  bundleSize: number,
): { loadAddr: number; entryAddr: number } {
  const code = readDynamicSymbolBytes(bytes, archName, "krunfw_get_kernel");
  if (!code) {
    throw new Error("ELF does not expose krunfw_get_kernel");
  }
  const immediates = new Set<number>();
  for (const value of x86ImmediateStores(code)) {
    // the size store (`size` or `size - 1`, see normalizeKrunKernelBundle)
    if (value > 0 && Math.abs(value - bundleSize) > 1) immediates.add(value);
  }
  const candidates = [...immediates];
  const pairs: Array<[number, number]> = [];
  for (const load of candidates) {
    if (load % 0x1000 !== 0) continue;
    for (const entry of candidates) {
      if (entry >= load && entry < load + bundleSize) pairs.push([load, entry]);
    }
  }
  // a load address that is also the entry point is stored twice but seen once
  const distinct = pairs.filter(([l, e]) => l !== e);
  const chosen = distinct.length > 0 ? distinct : pairs;
  if (chosen.length !== 1) {
    const hex = candidates.map((v) => `0x${v.toString(16)}`).join(", ");
    throw new Error(
      `cannot tell the load and entry addresses apart in krunfw_get_kernel (constants: ${hex || "none"})`,
    );
  }
  const [loadAddr, entryAddr] = chosen[0]!;
  return { loadAddr, entryAddr };
}

/** Immediates of x86_64 `REX.W C7 /0` stores (`movq $imm32, disp(reg)`). */
function x86ImmediateStores(code: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 <= code.length; i += 1) {
    if ((code[i]! & 0xf8) !== 0x48 || code[i + 1] !== 0xc7) continue;
    const modrm = code[i + 2]!;
    const mod = modrm >> 6;
    const reg = (modrm >> 3) & 7;
    const rm = modrm & 7;
    // no SIB byte, no RIP-relative operand, a memory destination
    if (reg !== 0 || rm === 4 || mod === 3 || (mod === 0 && rm === 5)) continue;
    const displacement = mod === 1 ? 1 : mod === 2 ? 4 : 0;
    const at = i + 3 + displacement;
    if (at + 4 > code.length) continue;
    out.push(code.readInt32LE(at));
  }
  return out;
}

function normalizeKrunKernelBundle(bytes: Buffer): Buffer {
  // Shared libkrunfw archives expose KERNEL_BUNDLE with a trailing `\0`
  // sentinel while `krunfw_get_kernel` reports `size - 1`
  if (bytes.length > 0 && bytes[bytes.length - 1] === 0) {
    return bytes.subarray(0, bytes.length - 1);
  }
  return bytes;
}

function parseElfSections(
  bytes: Buffer,
  endian: ElfEndian,
): ParsedElfSection[] {
  const sectionHeaderOffset = readU64(bytes, 40, endian);
  const sectionHeaderEntrySize = readU16(bytes, 58, endian);
  const sectionHeaderCount = readU16(bytes, 60, endian);

  if (sectionHeaderEntrySize <= 0) {
    throw new Error("ELF section header entry size is invalid");
  }

  const tableSize = sectionHeaderEntrySize * sectionHeaderCount;
  sliceChecked(bytes, sectionHeaderOffset, tableSize);

  const sections: ParsedElfSection[] = [];
  for (let i = 0; i < sectionHeaderCount; i += 1) {
    const off = sectionHeaderOffset + i * sectionHeaderEntrySize;
    const entry = sliceChecked(bytes, off, sectionHeaderEntrySize);

    sections.push({
      type: readU32(entry, 4, endian),
      offset: readU64(entry, 24, endian),
      size: readU64(entry, 32, endian),
      link: readU32(entry, 40, endian),
      address: readU64(entry, 16, endian),
      entrySize: readU64(entry, 56, endian),
    });
  }

  return sections;
}

function tryResolveSymbolOffsetFromSection(
  sections: ParsedElfSection[],
  sectionIndex: number,
  symbolValue: number,
  symbolSize: number,
): number | null {
  if (sectionIndex < 0 || sectionIndex >= sections.length) {
    return null;
  }

  // 0 and values >= 0xff00 are undefined/reserved in ELF
  if (sectionIndex === 0 || sectionIndex >= 0xff00) {
    return null;
  }

  const section = sections[sectionIndex]!;
  const symbolEnd = symbolValue + symbolSize;
  const sectionEnd = section.address + section.size;

  if (symbolValue < section.address || symbolEnd > sectionEnd) {
    return null;
  }

  return section.offset + (symbolValue - section.address);
}

function tryResolveSymbolOffsetFromProgramHeaders(
  bytes: Buffer,
  endian: ElfEndian,
  symbolValue: number,
  symbolSize: number,
): number | null {
  const programHeaderOffset = readU64(bytes, 32, endian);
  const programHeaderEntrySize = readU16(bytes, 54, endian);
  const programHeaderCount = readU16(bytes, 56, endian);

  if (programHeaderEntrySize <= 0 || programHeaderCount <= 0) {
    return null;
  }

  const tableSize = programHeaderEntrySize * programHeaderCount;
  sliceChecked(bytes, programHeaderOffset, tableSize);

  for (let i = 0; i < programHeaderCount; i += 1) {
    const off = programHeaderOffset + i * programHeaderEntrySize;
    const entry = sliceChecked(bytes, off, programHeaderEntrySize);

    const type = readU32(entry, 0, endian);
    if (type !== 1) {
      continue;
    }

    const fileOffset = readU64(entry, 8, endian);
    const virtualAddress = readU64(entry, 16, endian);
    const fileSize = readU64(entry, 32, endian);

    const segmentEnd = virtualAddress + fileSize;
    const symbolEnd = symbolValue + symbolSize;

    if (symbolValue < virtualAddress || symbolEnd > segmentEnd) {
      continue;
    }

    return fileOffset + (symbolValue - virtualAddress);
  }

  return null;
}

function sliceChecked(bytes: Buffer, offset: number, size: number): Buffer {
  if (offset < 0 || size < 0) {
    throw new Error("ELF bounds are negative");
  }
  if (offset + size > bytes.length) {
    throw new Error("ELF bounds exceed file length");
  }
  return bytes.subarray(offset, offset + size);
}

function readCString(bytes: Buffer, offset: number): string {
  const end = bytes.indexOf(0, offset);
  if (end === -1) {
    throw new Error("unterminated string in ELF table");
  }
  return bytes.toString("utf8", offset, end);
}

function readU16(bytes: Buffer, offset: number, endian: ElfEndian): number {
  return endian === "le"
    ? bytes.readUInt16LE(offset)
    : bytes.readUInt16BE(offset);
}

function readU32(bytes: Buffer, offset: number, endian: ElfEndian): number {
  return endian === "le"
    ? bytes.readUInt32LE(offset)
    : bytes.readUInt32BE(offset);
}

function readU64(bytes: Buffer, offset: number, endian: ElfEndian): number {
  const value =
    endian === "le"
      ? bytes.readBigUInt64LE(offset)
      : bytes.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("ELF value exceeds JavaScript safe integer range");
  }
  return Number(value);
}

function formatExecError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }

  const execErr = err as Error & { stdout?: unknown; stderr?: unknown };
  const stdout =
    typeof execErr.stdout === "string"
      ? execErr.stdout
      : Buffer.isBuffer(execErr.stdout)
        ? execErr.stdout.toString("utf8")
        : "";
  const stderr =
    typeof execErr.stderr === "string"
      ? execErr.stderr
      : Buffer.isBuffer(execErr.stderr)
        ? execErr.stderr.toString("utf8")
        : "";

  const output = `${stdout}${stderr}`.trim();
  if (!output) {
    return execErr.message;
  }
  return `${execErr.message}: ${output}`;
}

function mapKrunArch(arch: Architecture): "aarch64" | "x86_64" {
  return arch === "aarch64" ? "aarch64" : "x86_64";
}

function hostKrunArch(): "aarch64" | "x86_64" | null {
  if (process.arch === "arm64") return "aarch64";
  if (process.arch === "x64") return "x86_64";
  return null;
}

function isNotFoundDownloadError(err: unknown): boolean {
  return err instanceof DownloadFileError && err.status === 404;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export const __test = {
  downloadKrunArchive,
  krunKernelImage,
  readKrunfwAddressesFromSharedLibraryBytes,
  wrapKernelInElf,
  extractKernelBundleFromCSource,
  extractKernelBundleFromSharedLibraryBytes,
};

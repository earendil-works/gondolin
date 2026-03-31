import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { createRequire } from "module";

import { getHostNodeArchCached } from "../host/arch.ts";
import {
  debugFlagsToArray,
  parseDebugEnv,
  resolveDebugFlags,
  type DebugConfig,
  type DebugFlag,
} from "../debug.ts";
import {
  ensureGuestAssets,
  loadAssetManifest,
  loadGuestAssets,
  resolveGuestAssetsSync,
  type GuestAssets,
} from "../assets.ts";
import { ensureImageSelector, resolveImageSelector } from "../images.ts";
import {
  DEFAULT_MAX_HTTP_BODY_BYTES,
  DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES,
  type DnsOptions,
  type HttpFetch,
  type HttpHooks,
} from "../qemu/net.ts";
import type { SshOptions } from "../qemu/ssh.ts";
import type { TcpOptions } from "../qemu/tcp.ts";
import type { VirtualProvider } from "../vfs/node/index.ts";
import { resolveDefaultWasmFunctionBridgeRunnerEntryPath } from "./wasm-function-bridge-runner.ts";

const require = createRequire(import.meta.url);

/**
 * Path or selector for guest image assets
 *
 * Can be either:
 * - A string path to a directory containing the assets (vmlinuz-virt, initramfs.cpio.lz4, rootfs.ext4)
 * - A string image selector (ref like `name:tag` or a build id)
 * - An object with explicit paths to each asset file
 */
export type ImagePath = string | GuestAssets;

/** vm backend implementation */
export type SandboxVmm = "qemu" | "krun" | "wasm-node";

const DEFAULT_MAX_STDIN_BYTES = 64 * 1024;
const DEFAULT_MAX_QUEUED_STDIN_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_QUEUED_STDIN_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_EXECS = 64;

/**
 * sandbox server options
 *
 * imagePath can be either:
 * - a directory containing the guest assets (kernel/initrd/rootfs)
 * - an object with explicit asset paths
 */
export type SandboxServerOptions = {
  /** vm backend implementation */
  vmm?: SandboxVmm;
  /** qemu binary path */
  qemuPath?: string;
  /** krun runner binary path */
  krunRunnerPath?: string;
  /** node binary path for wasm-node backend */
  wasmNodePath?: string;
  /** function-bridge runner entrypoint path for wasm-node backend */
  wasmRunnerPath?: string;
  /** function-bridge runner mode */
  wasmRunnerMode?: "harness" | "wasi-stdio";
  /** guest wasm module path for wasm-node backend */
  wasmPath?: string;
  /** guest asset directory or explicit asset paths */
  imagePath?: ImagePath;
  /** vm memory size (qemu syntax, e.g. "1G") */
  memory?: string;
  /** vm cpu count */
  cpus?: number;
  /** virtio-serial control socket path */
  virtioSocketPath?: string;
  /** virtiofs/vfs socket path */
  virtioFsSocketPath?: string;
  /** virtio-serial ssh socket path */
  virtioSshSocketPath?: string;

  /** virtio-serial ingress socket path */
  virtioIngressSocketPath?: string;
  /** qemu net socket path */
  netSocketPath?: string;
  /** guest mac address */
  netMac?: string;
  /** whether to enable networking */
  netEnabled?: boolean;
  /** whether to allow WebSocket upgrades for guest egress (default: true) */
  allowWebSockets?: boolean;

  /**
   * Root disk image path (attached as `/dev/vda`)
   *
   * If omitted, uses the base rootfs image from the guest assets.
   */
  rootDiskPath?: string;

  /** root disk image format */
  rootDiskFormat?: "raw" | "qcow2";

  /** qemu readonly mode for the root disk */
  rootDiskReadOnly?: boolean;

  /**
   * Delete the root disk image on VM close
   *
   * This is a host-side lifecycle hint. It is currently only honored by the
   * higher-level {@link VM} wrapper.
   */
  rootDiskDeleteOnClose?: boolean;

  /**
   * Debug configuration
   *
   * - `true`: enable all debug components
   * - `false`: disable all debug components
   * - `string[]`: enable selected components (e.g. `["net", "exec"]`)
   *
   * If omitted, defaults to `GONDOLIN_DEBUG`.
   */
  debug?: DebugConfig;
  /** qemu machine type */
  machineType?: string;
  /** qemu acceleration backend (e.g. kvm, hvf) */
  accel?: string;
  /** qemu cpu model */
  cpu?: string;
  /** guest console mode */
  console?: "stdio" | "none";
  /** whether to restart the vm automatically on exit */
  autoRestart?: boolean;
  /** kernel cmdline append string */
  append?: string;

  /** max stdin buffered per process in `bytes` */
  maxStdinBytes?: number;
  /** max stdin buffered for a single queued (not yet active) exec in `bytes` */
  maxQueuedStdinBytes?: number;
  /** max total stdin buffered across all queued (not yet active) execs in `bytes` */
  maxTotalQueuedStdinBytes?: number;
  /** max total exec pressure (running + queued-to-start) */
  maxQueuedExecs?: number;
  /** http fetch implementation for asset downloads */
  fetch?: HttpFetch;
  /** http interception hooks */
  httpHooks?: HttpHooks;

  /** dns configuration */
  dns?: DnsOptions;

  /** ssh egress configuration */
  ssh?: SshOptions;

  /** explicit host-mapped tcp egress configuration */
  tcp?: TcpOptions;

  /** max intercepted http request body size in `bytes` */
  maxHttpBodyBytes?: number;
  /** max buffered upstream http response body size in `bytes` */
  maxHttpResponseBodyBytes?: number;
  /** mitm ca directory path */
  mitmCertDir?: string;
  /** vfs provider to expose under the fuse mount */
  vfsProvider?: VirtualProvider;
};

export type ResolvedSandboxServerOptions = {
  /** vm backend implementation */
  vmm: SandboxVmm;
  /** qemu binary path */
  qemuPath: string;
  /** krun runner binary path */
  krunRunnerPath: string;
  /** node binary path for wasm-node backend */
  wasmNodePath?: string;
  /** function-bridge runner entrypoint path for wasm-node backend */
  wasmRunnerPath?: string;
  /** function-bridge runner mode */
  wasmRunnerMode?: "harness" | "wasi-stdio";
  /** guest wasm module path for wasm-node backend */
  wasmPath?: string;
  /** kernel image path */
  kernelPath: string;
  /** initrd/initramfs image path */
  initrdPath: string;
  /** rootfs image path */
  rootfsPath: string;

  /** root disk image path (attached as `/dev/vda`) */
  rootDiskPath: string;
  /** root disk image format */
  rootDiskFormat: "raw" | "qcow2";
  /** qemu readonly mode for the root disk */
  rootDiskReadOnly: boolean;

  /** vm memory size (qemu syntax, e.g. "1G") */
  memory: string;
  /** vm cpu count */
  cpus: number;
  /** virtio-serial control socket path */
  virtioSocketPath: string;
  /** virtiofs/vfs socket path */
  virtioFsSocketPath: string;
  /** virtio-serial ssh socket path */
  virtioSshSocketPath: string;

  /** virtio-serial ingress socket path */
  virtioIngressSocketPath: string;
  /** qemu net socket path */
  netSocketPath: string;
  /** guest mac address */
  netMac: string;
  /** whether networking is enabled */
  netEnabled: boolean;
  /** whether to allow WebSocket upgrades for guest egress */
  allowWebSockets: boolean;

  /** enabled debug components */
  debug: DebugFlag[];
  /** qemu machine type */
  machineType?: string;
  /** qemu acceleration backend (e.g. kvm, hvf) */
  accel?: string;
  /** qemu cpu model */
  cpu?: string;
  /** guest console mode */
  console?: "stdio" | "none";
  /** whether to restart the vm automatically on exit */
  autoRestart: boolean;
  /** kernel cmdline append string */
  append?: string;

  /** max stdin buffered per process in `bytes` */
  maxStdinBytes: number;
  /** max stdin buffered for a single queued (not yet active) exec in `bytes` */
  maxQueuedStdinBytes: number;
  /** max total stdin buffered across all queued (not yet active) execs in `bytes` */
  maxTotalQueuedStdinBytes: number;
  /** max total exec pressure (running + queued-to-start) */
  maxQueuedExecs: number;
  /** max intercepted http request body size in `bytes` */
  maxHttpBodyBytes: number;
  /** max buffered upstream http response body size in `bytes` */
  maxHttpResponseBodyBytes: number;
  /** http fetch implementation for asset downloads */
  fetch?: HttpFetch;
  /** http interception hooks */
  httpHooks?: HttpHooks;

  /** dns configuration */
  dns?: DnsOptions;

  /** ssh egress configuration */
  ssh?: SshOptions;

  /** explicit host-mapped tcp egress configuration */
  tcp?: TcpOptions;

  /** mitm ca directory path */
  mitmCertDir?: string;
  /** vfs provider to expose under the fuse mount */
  vfsProvider: VirtualProvider | null;
};

export type GuestFileReadOptions = {
  /** working directory for relative paths */
  cwd?: string;
  /** preferred chunk size in `bytes` */
  chunkSize?: number;
  /** abort signal for the read request */
  signal?: AbortSignal;
  /** stream highWaterMark in `bytes` */
  highWaterMark?: number;
};

export type GuestFileWriteOptions = {
  /** working directory for relative paths */
  cwd?: string;
  /** abort signal for the write request */
  signal?: AbortSignal;
};

export type GuestFileDeleteOptions = {
  /** ignore missing paths */
  force?: boolean;
  /** recursive delete for directories */
  recursive?: boolean;
  /** working directory for relative paths */
  cwd?: string;
  /** abort signal for the delete request */
  signal?: AbortSignal;
};

type ResolvedImagePath = {
  /** resolved guest asset paths */
  assets: GuestAssets;
  /** resolved image directory when available */
  imageDir: string | null;
  /** whether caller supplied explicit asset object */
  explicitAssetObject: boolean;
};

/**
 * Resolve imagePath selector to guest assets and optional image directory.
 */
function resolveImagePath(imagePath: ImagePath): ResolvedImagePath {
  if (typeof imagePath === "string") {
    const resolved = resolveImageSelector(imagePath);
    return {
      assets: loadGuestAssets(resolved.assetDir),
      imageDir: resolved.assetDir,
      explicitAssetObject: false,
    };
  }

  return {
    assets: imagePath,
    imageDir: null,
    explicitAssetObject: true,
  };
}

function normalizeVmm(value: string | null | undefined): SandboxVmm | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "qemu" ||
    normalized === "krun" ||
    normalized === "wasm-node"
  ) {
    return normalized;
  }
  return null;
}

function normalizeArch(
  value: string | null | undefined,
): "arm64" | "x64" | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === "arm64" || lower === "aarch64") return "arm64";
  if (lower === "x64" || lower === "x86_64" || lower === "amd64") return "x64";
  return null;
}

function detectQemuArch(qemuPath: string): "arm64" | "x64" | null {
  const lower = qemuPath.toLowerCase();
  if (lower.includes("aarch64") || lower.includes("arm64")) return "arm64";
  if (
    lower.includes("x86_64") ||
    lower.includes("x64") ||
    lower.includes("amd64")
  )
    return "x64";
  return null;
}

function resolveLocalKrunRunnerPath(): string | null {
  const directCandidates = [
    path.resolve(
      process.cwd(),
      "host",
      "krun-runner",
      "zig-out",
      "bin",
      "gondolin-krun-runner",
    ),
    path.resolve(
      process.cwd(),
      "krun-runner",
      "zig-out",
      "bin",
      "gondolin-krun-runner",
    ),
  ];

  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const starts = [process.cwd(), import.meta.dirname];
  const visited = new Set<string>();

  for (const start of starts) {
    let dir = path.resolve(start);

    for (let i = 0; i < 10; i += 1) {
      const candidate = path.join(
        dir,
        "krun-runner",
        "zig-out",
        "bin",
        "gondolin-krun-runner",
      );
      if (!visited.has(candidate)) {
        visited.add(candidate);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }

      const hostCandidate = path.join(
        dir,
        "host",
        "krun-runner",
        "zig-out",
        "bin",
        "gondolin-krun-runner",
      );
      if (!visited.has(hostCandidate)) {
        visited.add(hostCandidate);
        if (fs.existsSync(hostCandidate)) {
          return hostCandidate;
        }
      }

      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return null;
}

type ResolvePackagedKrunRunnerPathDeps = {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  resolvePackageJson?: (specifier: string) => string;
  readFileSync?: typeof fs.readFileSync;
  existsSync?: typeof fs.existsSync;
  probeRunner?: (candidatePath: string) => boolean;
};

function probeKrunRunnerCandidate(candidatePath: string): boolean {
  try {
    execFileSync(candidatePath, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolvePackagedKrunRunnerPath(
  deps: ResolvePackagedKrunRunnerPathDeps = {},
): string | null {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;

  if (
    (platform !== "darwin" && platform !== "linux") ||
    (arch !== "arm64" && arch !== "x64")
  ) {
    return null;
  }

  const packageName = `@earendil-works/gondolin-krun-runner-${platform}-${arch}`;
  const resolvePackageJson =
    deps.resolvePackageJson ??
    ((specifier: string) => require.resolve(specifier));
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const probeRunner = deps.probeRunner ?? probeKrunRunnerCandidate;

  try {
    const packageJsonPath = resolvePackageJson(`${packageName}/package.json`);
    const packageDir = path.dirname(packageJsonPath);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };

    const binCandidates: string[] = [];
    if (typeof packageJson.bin === "string") {
      binCandidates.push(packageJson.bin);
    } else if (packageJson.bin && typeof packageJson.bin === "object") {
      const preferred = packageJson.bin["gondolin-krun-runner"];
      if (typeof preferred === "string") {
        binCandidates.push(preferred);
      }
      for (const value of Object.values(packageJson.bin)) {
        if (typeof value === "string") {
          binCandidates.push(value);
        }
      }
    }

    binCandidates.push("bin/gondolin-krun-runner", "gondolin-krun-runner");

    const seen = new Set<string>();
    for (const rel of binCandidates) {
      const candidate = path.resolve(packageDir, rel);
      if (seen.has(candidate) || !existsSync(candidate)) {
        continue;
      }
      seen.add(candidate);
      if (probeRunner(candidate)) {
        return candidate;
      }
    }
  } catch {
    return null;
  }

  return null;
}

type ResolveDefaultKrunRunnerPathDeps = {
  envPath?: string;
  resolveLocalPath?: () => string | null;
  resolvePackagedPath?: () => string | null;
};

function resolveDefaultKrunRunnerPath(
  deps: ResolveDefaultKrunRunnerPathDeps = {},
): string {
  const envValue = Object.prototype.hasOwnProperty.call(deps, "envPath")
    ? deps.envPath
    : process.env.GONDOLIN_KRUN_RUNNER;
  const envPath = envValue?.trim();
  if (envPath) {
    return envPath;
  }

  const resolveLocalPath = deps.resolveLocalPath ?? resolveLocalKrunRunnerPath;
  const local = resolveLocalPath();
  if (local) {
    return local;
  }

  const resolvePackagedPath =
    deps.resolvePackagedPath ?? resolvePackagedKrunRunnerPath;
  const packaged = resolvePackagedPath();
  if (packaged) {
    return packaged;
  }

  return "gondolin-krun-runner";
}

type KrunKernelOverride = {
  /** replacement kernel image path */
  kernelPath: string;
  /** replacement initrd path */
  initrdPath: string;
};

function getDefaultKrunInitrdPath(): string {
  return path.join(os.tmpdir(), "gondolin-krun-empty-initrd");
}

function ensureEmptyInitrdFile(initrdPath: string): boolean {
  try {
    if (fs.existsSync(initrdPath)) return true;
    fs.mkdirSync(path.dirname(initrdPath), { recursive: true });
    fs.writeFileSync(initrdPath, "");
    return true;
  } catch {
    return false;
  }
}

function resolveManifestAssetPath(
  imageDir: string,
  relPath: string,
  fieldName: string,
): string {
  if (path.isAbsolute(relPath)) {
    throw new Error(
      `${fieldName} must be relative to image dir, got ${relPath}`,
    );
  }

  const resolved = path.resolve(imageDir, relPath);
  const relative = path.relative(imageDir, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${fieldName} must stay within image dir, got ${relPath}`);
  }

  return resolved;
}

function resolveKrunInitrdPath(
  imageManifest: ReturnType<typeof loadAssetManifest>,
  imageDir: string,
): string {
  if (imageManifest?.assets?.krunInitrd) {
    const initrdPath = resolveManifestAssetPath(
      imageDir,
      imageManifest.assets.krunInitrd,
      "manifest.assets.krunInitrd",
    );
    if (!fs.existsSync(initrdPath)) {
      throw new Error(
        `manifest.assets.krunInitrd points to missing file: ${imageManifest.assets.krunInitrd}`,
      );
    }
    return initrdPath;
  }

  const initrdPath = getDefaultKrunInitrdPath();
  if (!ensureEmptyInitrdFile(initrdPath) && !fs.existsSync(initrdPath)) {
    throw new Error(`failed to create default krun initrd at ${initrdPath}`);
  }

  return initrdPath;
}

function resolveKrunKernelOverride(
  imageManifest: ReturnType<typeof loadAssetManifest>,
  imageDir: string | null,
): KrunKernelOverride | null {
  if (!imageDir || !imageManifest?.assets?.krunKernel) {
    return null;
  }

  const kernelPath = resolveManifestAssetPath(
    imageDir,
    imageManifest.assets.krunKernel,
    "manifest.assets.krunKernel",
  );

  if (!fs.existsSync(kernelPath)) {
    throw new Error(
      `manifest.assets.krunKernel points to missing file: ${imageManifest.assets.krunKernel}`,
    );
  }

  return {
    kernelPath,
    initrdPath: resolveKrunInitrdPath(imageManifest, imageDir),
  };
}

function findCommonAssetDir(assets: Partial<GuestAssets>): string | null {
  const kernelDir = assets.kernelPath ? path.dirname(assets.kernelPath) : null;
  const initrdDir = assets.initrdPath ? path.dirname(assets.initrdPath) : null;
  const rootfsDir = assets.rootfsPath ? path.dirname(assets.rootfsPath) : null;

  if (!kernelDir || !initrdDir || !rootfsDir) return null;
  if (kernelDir !== initrdDir || kernelDir !== rootfsDir) return null;
  return kernelDir;
}

function isPathWithinOrEqual(base: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function findSharedAssetAncestor(assets: Partial<GuestAssets>): string | null {
  const assetPaths = [assets.kernelPath, assets.initrdPath, assets.rootfsPath];
  if (assetPaths.some((value) => !value)) {
    return null;
  }

  let candidate = path.dirname(path.resolve(assetPaths[0]!));

  for (const rawPath of assetPaths.slice(1)) {
    const current = path.dirname(path.resolve(rawPath!));

    while (!isPathWithinOrEqual(candidate, current)) {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        break;
      }
      candidate = parent;
    }
  }

  return candidate;
}

function manifestMatchesAssets(
  manifestDir: string,
  assets: Partial<GuestAssets>,
): boolean {
  if (!assets.kernelPath || !assets.initrdPath || !assets.rootfsPath) {
    return false;
  }

  const manifest = loadAssetManifest(manifestDir);
  if (!manifest) {
    return false;
  }

  const assetFiles = manifest.assets ?? {
    kernel: "vmlinuz-virt",
    initramfs: "initramfs.cpio.lz4",
    rootfs: "rootfs.ext4",
  };

  try {
    const kernelPath = resolveManifestAssetPath(
      manifestDir,
      assetFiles.kernel,
      "manifest.assets.kernel",
    );
    const initrdPath = resolveManifestAssetPath(
      manifestDir,
      assetFiles.initramfs,
      "manifest.assets.initramfs",
    );
    const rootfsPath = resolveManifestAssetPath(
      manifestDir,
      assetFiles.rootfs,
      "manifest.assets.rootfs",
    );

    return (
      path.resolve(kernelPath) === path.resolve(assets.kernelPath) &&
      path.resolve(initrdPath) === path.resolve(assets.initrdPath) &&
      path.resolve(rootfsPath) === path.resolve(assets.rootfsPath)
    );
  } catch {
    return false;
  }
}

function resolveImageDirFromAssets(
  assets: Partial<GuestAssets>,
): string | null {
  const sharedAncestor = findSharedAssetAncestor(assets);
  if (sharedAncestor) {
    let dir = sharedAncestor;
    for (;;) {
      if (manifestMatchesAssets(dir, assets)) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  const commonDir = findCommonAssetDir(assets);
  if (commonDir && manifestMatchesAssets(commonDir, assets)) {
    return commonDir;
  }

  return null;
}

function detectGuestArchFromManifest(assets: Partial<GuestAssets>): {
  arch: "arm64" | "x64";
  manifestPath: string;
} | null {
  const dir = resolveImageDirFromAssets(assets);
  if (!dir) return null;

  const manifest = loadAssetManifest(dir);
  const arch = normalizeArch(manifest?.config?.arch);
  if (!manifest || !arch) return null;

  return { arch, manifestPath: path.join(dir, "manifest.json") };
}

/**
 * Resolve server options synchronously.
 *
 * This version uses local development paths if available. For production use,
 * prefer `resolveSandboxServerOptionsAsync` which will download assets if needed.
 *
 * @param options User-provided options
 * @param assets Optional pre-resolved guest assets (from ensureGuestAssets)
 */
type ResolveSandboxServerOptionsDeps = {
  /** test-only override for default krun runner resolution */
  resolveDefaultKrunRunnerPath?: () => string;
};

export function resolveSandboxServerOptions(
  options: SandboxServerOptions = {},
  assets?: GuestAssets,
  deps: ResolveSandboxServerOptionsDeps = {},
): ResolvedSandboxServerOptions {
  if (Object.hasOwn(options as object, "rootDiskSnapshot")) {
    throw new Error(
      "sandbox.rootDiskSnapshot has been removed; use VM rootfs.mode='memory' for backend-native ephemeral writes on qemu or rootfs.mode='cow' for a throwaway qcow2 overlay on disk",
    );
  }

  // Resolve image paths: explicit imagePath > assets parameter > local dev paths
  let resolvedAssets: Partial<GuestAssets>;
  let explicitImageObject = false;
  let imageDir: string | null = null;

  if (options.imagePath !== undefined) {
    const resolvedImagePath = resolveImagePath(options.imagePath);
    resolvedAssets = resolvedImagePath.assets;
    explicitImageObject = resolvedImagePath.explicitAssetObject;
    imageDir = resolvedImagePath.imageDir;
  } else if (assets) {
    resolvedAssets = assets;
  } else {
    resolvedAssets = resolveGuestAssetsSync() ?? {};
  }

  if (!imageDir) {
    imageDir = resolveImageDirFromAssets(resolvedAssets);
  }

  const baseKernelPath = resolvedAssets.kernelPath;
  const baseInitrdPath = resolvedAssets.initrdPath;
  const rootfsPath = resolvedAssets.rootfsPath;

  // we are running into length limits on macos on the default temp dir
  const tmpDir = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const defaultVirtio = path.resolve(
    tmpDir,
    `gondolin-virtio-${randomUUID().slice(0, 8)}.sock`,
  );
  const defaultVirtioFs = path.resolve(
    tmpDir,
    `gondolin-virtio-fs-${randomUUID().slice(0, 8)}.sock`,
  );
  const defaultVirtioSsh = path.resolve(
    tmpDir,
    `gondolin-virtio-ssh-${randomUUID().slice(0, 8)}.sock`,
  );
  const defaultVirtioIngress = path.resolve(
    tmpDir,
    `gondolin-virtio-ingress-${randomUUID().slice(0, 8)}.sock`,
  );
  const defaultNetSock = path.resolve(
    tmpDir,
    `gondolin-net-${randomUUID().slice(0, 8)}.sock`,
  );
  const defaultNetMac = "02:00:00:00:00:01";

  const hostArch = getHostNodeArchCached();
  const hostArchNormalized = normalizeArch(hostArch);
  const defaultQemuForHostArch =
    hostArchNormalized === "arm64"
      ? "qemu-system-aarch64"
      : "qemu-system-x86_64";
  const defaultMemory = "1G";
  const envDebugFlags = parseDebugEnv();
  const resolvedDebugFlags = resolveDebugFlags(options.debug, envDebugFlags);
  const debug = debugFlagsToArray(resolvedDebugFlags);

  const explicitVmm = normalizeVmm(options.vmm ?? null);
  if (options.vmm !== undefined && !explicitVmm) {
    throw new Error(
      `invalid sandbox vmm backend: ${String(options.vmm)} (expected "qemu", "krun", or "wasm-node")`,
    );
  }
  const envVmm = normalizeVmm(process.env.GONDOLIN_VMM);
  const vmm = explicitVmm ?? envVmm ?? "qemu";
  let qemuPath = options.qemuPath ?? defaultQemuForHostArch;
  const wasmNodePath = options.wasmNodePath ?? process.execPath;
  const wasmRunnerPath =
    options.wasmRunnerPath ?? resolveDefaultWasmFunctionBridgeRunnerEntryPath();
  const wasmPath = options.wasmPath ?? process.env.GONDOLIN_WASM_PATH?.trim();
  const wasmRunnerMode =
    options.wasmRunnerMode ?? (wasmPath ? "wasi-stdio" : "harness");
  const resolveDefaultKrunRunnerPathFn =
    deps.resolveDefaultKrunRunnerPath ?? resolveDefaultKrunRunnerPath;
  const krunRunnerPath =
    options.krunRunnerPath ??
    (vmm === "krun"
      ? resolveDefaultKrunRunnerPathFn()
      : "gondolin-krun-runner");

  if (vmm === "krun") {
    const unsupported: string[] = [];
    if (options.qemuPath !== undefined) unsupported.push("sandbox.qemuPath");
    if (options.machineType !== undefined)
      unsupported.push("sandbox.machineType");
    if (options.accel !== undefined) unsupported.push("sandbox.accel");
    if (options.cpu !== undefined) unsupported.push("sandbox.cpu");

    if (unsupported.length > 0) {
      throw new Error(
        `Unsupported sandbox option${unsupported.length === 1 ? "" : "s"} for vmm=krun: ${unsupported.join(", ")}. ` +
          "These options are only supported with vmm=qemu.",
      );
    }
  } else if (vmm === "wasm-node") {
    const unsupported: string[] = [];
    if (options.qemuPath !== undefined) unsupported.push("sandbox.qemuPath");
    if (options.krunRunnerPath !== undefined)
      unsupported.push("sandbox.krunRunnerPath");
    if (options.machineType !== undefined)
      unsupported.push("sandbox.machineType");
    if (options.accel !== undefined) unsupported.push("sandbox.accel");
    if (options.cpu !== undefined) unsupported.push("sandbox.cpu");

    if (unsupported.length > 0) {
      throw new Error(
        `Unsupported sandbox option${unsupported.length === 1 ? "" : "s"} for vmm=wasm-node: ${unsupported.join(", ")}. ` +
          "These options are not supported by the experimental wasm-node backend.",
      );
    }

    if (wasmRunnerMode !== "harness" && wasmRunnerMode !== "wasi-stdio") {
      throw new Error(
        `invalid sandbox.wasmRunnerMode: ${String(wasmRunnerMode)} (expected "harness" or "wasi-stdio")`,
      );
    }

    if (!fs.existsSync(wasmRunnerPath)) {
      throw new Error(`wasm runner entrypoint not found: ${wasmRunnerPath}`);
    }

    if (wasmRunnerMode === "wasi-stdio") {
      if (!wasmPath) {
        throw new Error(
          "vmm=wasm-node with wasmRunnerMode=wasi-stdio requires sandbox.wasmPath or GONDOLIN_WASM_PATH",
        );
      }
      if (!fs.existsSync(wasmPath)) {
        throw new Error(`wasm guest module not found: ${wasmPath}`);
      }
    }
  }

  const imageManifest = imageDir ? loadAssetManifest(imageDir) : null;

  let kernelPath = baseKernelPath;
  let initrdPath = baseInitrdPath;
  let resolvedRootfsPath = rootfsPath;
  let krunKernelOverride: KrunKernelOverride | null = null;

  if (vmm === "krun" && !explicitImageObject) {
    krunKernelOverride = resolveKrunKernelOverride(imageManifest, imageDir);
    if (krunKernelOverride) {
      kernelPath = krunKernelOverride.kernelPath;
      initrdPath = krunKernelOverride.initrdPath;
    }
  }

  if (!kernelPath || !initrdPath || !resolvedRootfsPath) {
    if (vmm === "wasm-node") {
      const placeholderPath = process.execPath;
      kernelPath = kernelPath ?? placeholderPath;
      initrdPath = initrdPath ?? placeholderPath;
      resolvedRootfsPath = resolvedRootfsPath ?? placeholderPath;
    } else {
      throw new Error(
        "Guest assets not found. Either:\n" +
          "  1. Run from the gondolin repository with built guest images\n" +
          "  2. Use SandboxServer.create() to auto-download assets\n" +
          "  3. Provide imagePath option (asset directory, image selector, or explicit paths)\n" +
          "  4. Set GONDOLIN_GUEST_DIR to a directory containing the assets",
      );
    }
  }

  // Fail fast if we can detect that the guest image doesn't match the selected backend target.
  // Without this, the VM often just "hangs" until some higher-level timeout.
  const guestFromManifest = detectGuestArchFromManifest({
    kernelPath: baseKernelPath,
    initrdPath: baseInitrdPath,
    rootfsPath: rootfsPath,
  });

  if (
    vmm === "qemu" &&
    options.qemuPath === undefined &&
    guestFromManifest !== null
  ) {
    qemuPath =
      guestFromManifest.arch === "arm64"
        ? "qemu-system-aarch64"
        : "qemu-system-x86_64";
  }

  if (vmm === "qemu") {
    const qemuArch = detectQemuArch(qemuPath);
    if (guestFromManifest && qemuArch && guestFromManifest.arch !== qemuArch) {
      const host = hostArchNormalized ?? hostArch;
      throw new Error(
        "Guest image architecture mismatch.\n" +
          `  guest assets: ${guestFromManifest.arch} (from ${guestFromManifest.manifestPath})\n` +
          `  qemu binary:  ${qemuArch} (${qemuPath})\n` +
          `  host arch:    ${host}\n\n` +
          "Fix: use a matching qemuPath (e.g. qemu-system-aarch64 vs qemu-system-x86_64) " +
          "or rebuild/download guest assets for the correct architecture.",
      );
    }
  } else if (vmm === "krun" && guestFromManifest) {
    const host = normalizeArch(hostArch);
    if (host && guestFromManifest.arch !== host) {
      throw new Error(
        "Guest image architecture mismatch for libkrun backend.\n" +
          `  guest assets: ${guestFromManifest.arch} (from ${guestFromManifest.manifestPath})\n` +
          `  host arch:    ${host}\n\n` +
          "Fix: select a guest image that matches the host architecture when using vmm=krun.",
      );
    }
  }

  if (vmm === "krun" && !explicitImageObject && !krunKernelOverride) {
    throw new Error(
      "Selected image does not provide krun boot assets.\n" +
        "Expected manifest assets `krunKernel` (and optional `krunInitrd`).\n" +
        "Fix: use an image built with `gondolin build` or choose a published image that includes krun assets.",
    );
  }

  const rootDiskPath = options.rootDiskPath ?? resolvedRootfsPath;
  const rootDiskFormat =
    options.rootDiskFormat ?? (options.rootDiskPath ? "qcow2" : "raw");
  const rootDiskReadOnly = options.rootDiskReadOnly ?? false;

  const maxStdinBytes = options.maxStdinBytes ?? DEFAULT_MAX_STDIN_BYTES;
  const maxQueuedStdinBytes = Math.max(
    options.maxQueuedStdinBytes ?? DEFAULT_MAX_QUEUED_STDIN_BYTES,
    maxStdinBytes,
  );
  const maxTotalQueuedStdinBytes = Math.max(
    options.maxTotalQueuedStdinBytes ?? DEFAULT_MAX_TOTAL_QUEUED_STDIN_BYTES,
    maxQueuedStdinBytes,
  );

  return {
    vmm,
    qemuPath,
    krunRunnerPath,
    wasmNodePath,
    wasmRunnerPath,
    wasmRunnerMode,
    wasmPath,
    kernelPath,
    initrdPath,
    rootfsPath: resolvedRootfsPath,
    rootDiskPath,
    rootDiskFormat,
    rootDiskReadOnly,
    memory: options.memory ?? defaultMemory,
    cpus: options.cpus ?? 2,
    virtioSocketPath: options.virtioSocketPath ?? defaultVirtio,
    virtioFsSocketPath: options.virtioFsSocketPath ?? defaultVirtioFs,
    virtioSshSocketPath: options.virtioSshSocketPath ?? defaultVirtioSsh,
    virtioIngressSocketPath:
      options.virtioIngressSocketPath ?? defaultVirtioIngress,
    netSocketPath: options.netSocketPath ?? defaultNetSock,
    netMac: options.netMac ?? defaultNetMac,
    netEnabled: options.netEnabled ?? true,
    allowWebSockets: options.allowWebSockets ?? true,
    debug,
    machineType: options.machineType,
    accel: options.accel,
    cpu: options.cpu,
    console: options.console,
    autoRestart: options.autoRestart ?? false,
    append: options.append,
    maxStdinBytes,
    maxQueuedStdinBytes,
    maxTotalQueuedStdinBytes,
    maxQueuedExecs: options.maxQueuedExecs ?? DEFAULT_MAX_QUEUED_EXECS,
    maxHttpBodyBytes: options.maxHttpBodyBytes ?? DEFAULT_MAX_HTTP_BODY_BYTES,
    maxHttpResponseBodyBytes:
      options.maxHttpResponseBodyBytes ?? DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES,
    fetch: options.fetch,
    httpHooks: options.httpHooks,
    dns: options.dns,
    ssh: options.ssh,
    tcp: options.tcp,
    mitmCertDir: options.mitmCertDir,
    vfsProvider: options.vfsProvider ?? null,
  };
}

/**
 * Resolve server options asynchronously, downloading guest assets if needed.
 *
 * This is the recommended way to get resolved options for production use.
 */
export async function resolveSandboxServerOptionsAsync(
  options: SandboxServerOptions = {},
): Promise<ResolvedSandboxServerOptions> {
  const explicitVmm = normalizeVmm(options.vmm ?? null);
  const envVmm = normalizeVmm(process.env.GONDOLIN_VMM);
  const selectedVmm = explicitVmm ?? envVmm ?? "qemu";

  // wasm-node does not require kernel/initramfs/rootfs assets for the initial
  // function-bridge runner spike.
  if (selectedVmm === "wasm-node" && options.imagePath === undefined) {
    return resolveSandboxServerOptions(options);
  }

  // Explicit object imagePath is already fully resolved.
  if (options.imagePath && typeof options.imagePath === "object") {
    return resolveSandboxServerOptions(options);
  }

  // String image selectors may require pulling from the builtin registry.
  if (typeof options.imagePath === "string") {
    const resolvedImage = await ensureImageSelector(options.imagePath);
    return resolveSandboxServerOptions({
      ...options,
      imagePath: resolvedImage.assetDir,
    });
  }

  const assets = await ensureGuestAssets();
  return resolveSandboxServerOptions(options, assets);
}

export const __test = {
  probeKrunRunnerCandidate,
  resolvePackagedKrunRunnerPath,
  resolveDefaultKrunRunnerPath,
};

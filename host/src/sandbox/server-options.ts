import os from "os";
import path from "path";
import { randomUUID } from "crypto";

import { getHostNodeArchCached } from "../host/arch";
import {
  debugFlagsToArray,
  parseDebugEnv,
  resolveDebugFlags,
  type DebugConfig,
  type DebugFlag,
} from "../debug";
import {
  ensureGuestAssets,
  loadAssetManifest,
  loadGuestAssets,
  resolveGuestAssetsSync,
  type GuestAssets,
} from "../assets";
import {
  DEFAULT_MAX_HTTP_BODY_BYTES,
  DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES,
  type DnsOptions,
  type HttpFetch,
  type HttpHooks,
} from "../qemu/net";
import type { SshOptions } from "../qemu/ssh";
import type { TcpOptions } from "../qemu/tcp";
import type { VirtualProvider } from "../vfs/node";

/**
 * Path to guest image assets.
 *
 * Can be either:
 * - A string path to a directory containing the assets (vmlinuz-virt, initramfs.cpio.lz4, rootfs.ext4)
 * - An object with explicit paths to each asset file
 */
export type ImagePath = string | GuestAssets;

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
  /** qemu binary path */
  qemuPath?: string;
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

  /** qemu snapshot mode for the root disk (discard writes) */
  rootDiskSnapshot?: boolean;

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
  /** qemu binary path */
  qemuPath: string;
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
  /** qemu snapshot mode for the root disk (discard writes) */
  rootDiskSnapshot: boolean;
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

/**
 * Resolve imagePath to GuestAssets.
 */
function resolveImagePath(imagePath: ImagePath): GuestAssets {
  if (typeof imagePath === "string") {
    return loadGuestAssets(imagePath);
  }
  return imagePath;
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

function findCommonAssetDir(assets: Partial<GuestAssets>): string | null {
  const kernelDir = assets.kernelPath ? path.dirname(assets.kernelPath) : null;
  const initrdDir = assets.initrdPath ? path.dirname(assets.initrdPath) : null;
  const rootfsDir = assets.rootfsPath ? path.dirname(assets.rootfsPath) : null;

  if (!kernelDir || !initrdDir || !rootfsDir) return null;
  if (kernelDir !== initrdDir || kernelDir !== rootfsDir) return null;
  return kernelDir;
}

function detectGuestArchFromManifest(assets: Partial<GuestAssets>): {
  arch: "arm64" | "x64";
  manifestPath: string;
} | null {
  const dir = findCommonAssetDir(assets);
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
export function resolveSandboxServerOptions(
  options: SandboxServerOptions = {},
  assets?: GuestAssets,
): ResolvedSandboxServerOptions {
  // Resolve image paths: explicit imagePath > assets parameter > local dev paths
  let resolvedAssets: Partial<GuestAssets>;
  if (options.imagePath !== undefined) {
    resolvedAssets = resolveImagePath(options.imagePath);
  } else if (assets) {
    resolvedAssets = assets;
  } else {
    resolvedAssets = resolveGuestAssetsSync() ?? {};
  }

  const kernelPath = resolvedAssets.kernelPath;
  const initrdPath = resolvedAssets.initrdPath;
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
  const defaultQemu =
    hostArch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
  const defaultMemory = "1G";
  const envDebugFlags = parseDebugEnv();
  const resolvedDebugFlags = resolveDebugFlags(options.debug, envDebugFlags);
  const debug = debugFlagsToArray(resolvedDebugFlags);

  if (!kernelPath || !initrdPath || !rootfsPath) {
    throw new Error(
      "Guest assets not found. Either:\n" +
        "  1. Run from the gondolin repository with built guest images\n" +
        "  2. Use SandboxServer.create() to auto-download assets\n" +
        "  3. Provide imagePath option (directory path or explicit paths)\n" +
        "  4. Set GONDOLIN_GUEST_DIR to a directory containing the assets",
    );
  }

  const qemuPath = options.qemuPath ?? defaultQemu;

  // Fail fast if we can detect that the guest image doesn't match the QEMU target.
  // Without this, the VM often just "hangs" until some higher-level timeout.
  const guestFromManifest = detectGuestArchFromManifest({
    kernelPath,
    initrdPath,
    rootfsPath,
  });
  const qemuArch = detectQemuArch(qemuPath);

  if (guestFromManifest && qemuArch && guestFromManifest.arch !== qemuArch) {
    const host = normalizeArch(hostArch) ?? hostArch;
    throw new Error(
      "Guest image architecture mismatch.\n" +
        `  guest assets: ${guestFromManifest.arch} (from ${guestFromManifest.manifestPath})\n` +
        `  qemu binary:  ${qemuArch} (${qemuPath})\n` +
        `  host arch:    ${host}\n\n` +
        "Fix: use a matching qemuPath (e.g. qemu-system-aarch64 vs qemu-system-x86_64) " +
        "or rebuild/download guest assets for the correct architecture.",
    );
  }

  const rootDiskPath = options.rootDiskPath ?? rootfsPath;
  const rootDiskFormat =
    options.rootDiskFormat ?? (options.rootDiskPath ? "qcow2" : "raw");
  const rootDiskSnapshot =
    options.rootDiskSnapshot ?? (options.rootDiskPath ? false : true);
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
    qemuPath,
    kernelPath,
    initrdPath,
    rootfsPath,
    rootDiskPath,
    rootDiskFormat,
    rootDiskSnapshot,
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
  // If imagePath is explicitly provided, use sync version (no download needed)
  if (options.imagePath !== undefined) {
    return resolveSandboxServerOptions(options);
  }

  const assets = await ensureGuestAssets();
  return resolveSandboxServerOptions(options, assets);
}

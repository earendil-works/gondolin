/**
 * Option resolution for remote sessions: `gondolind` runs on another
 * machine, so nothing that names this machine's files may be resolved here
 * (guest assets, root disks, krun runners). The result has empty asset paths;
 * the daemon resolves the image selector and prepares the root disk.
 */

import type { GuestAssets } from "../assets.ts";
import {
  type ResolvedSandboxServerOptions,
  type SandboxServerOptions,
  resolveSandboxServerOptions,
} from "../sandbox/server-options.ts";
import type { NativeEngineOptions } from "./config.ts";

/** Placeholder assets: resolution needs paths, the daemon ignores them */
const PLACEHOLDER_ASSETS: GuestAssets = {
  kernelPath: "/nonexistent/gondolin-remote/vmlinuz",
  initrdPath: "/nonexistent/gondolin-remote/initramfs",
  rootfsPath: "/nonexistent/gondolin-remote/rootfs",
};

/** Sandbox options that name files on the controller's machine */
const LOCAL_PATH_OPTIONS = [
  "rootDiskPath",
  "rootDiskFormat",
  "rootDiskReadOnly",
  "rootDiskDeleteOnClose",
  "virtioSocketPath",
  "virtioFsSocketPath",
  "virtioSshSocketPath",
  "virtioIngressSocketPath",
] as const;

/** Error for options that cannot work with a remote daemon */
export function remoteUnsupported(option: string): Error {
  return new Error(`not supported with a remote daemon: ${option}`);
}

/**
 * Resolve sandbox options for a remote daemon. `imagePath` must be a selector
 * string (a ref, build id, or a directory on the daemon's machine).
 */
export function resolveRemoteSandboxOptions(
  options: SandboxServerOptions,
  native: NativeEngineOptions,
): { resolved: ResolvedSandboxServerOptions; image: string } {
  for (const key of LOCAL_PATH_OPTIONS) {
    if (options[key] !== undefined) {
      throw remoteUnsupported(`sandbox.${key}`);
    }
  }
  if (
    options.imagePath !== undefined &&
    typeof options.imagePath !== "string"
  ) {
    throw remoteUnsupported(
      "sandbox.imagePath with explicit asset paths (use an image selector)",
    );
  }
  const image = native.image ?? (options.imagePath as string | undefined) ?? "";
  const resolved = resolveSandboxServerOptions(
    {
      ...options,
      imagePath: PLACEHOLDER_ASSETS,
    },
    undefined,
    {
      // the runner lives on the daemon's machine; only an explicit path counts
      resolveDefaultKrunRunnerPath: () => options.krunRunnerPath ?? "",
    },
  );
  return {
    resolved: {
      ...resolved,
      kernelPath: "",
      initrdPath: "",
      rootfsPath: "",
      rootDiskPath: "",
      qemuPath: options.qemuPath ?? "",
      krunRunnerPath: options.krunRunnerPath ?? "",
      firecrackerPath: options.firecrackerPath ?? "",
      // the controller's platform default (macOS + hvf) says nothing about
      // the daemon's machine: only an explicit idle pause applies
      qemuIdlePauseMs:
        options.qemuIdlePauseMs !== undefined && options.qemuIdlePauseMs > 0
          ? Math.trunc(options.qemuIdlePauseMs)
          : undefined,
    },
    image,
  };
}

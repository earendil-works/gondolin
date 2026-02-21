import type { VmVfsOptions } from "./vm";

import { loadOrCreateMitmCaSync, resolveMitmCertDir } from "./mitm";
import { listMountPaths } from "./vfs/mounts";
import { MemoryProvider, type VirtualProvider } from "./vfs/node";

/** guest mount path for host-provided MITM trust material */
export const MITM_CA_MOUNT_PATH = "/etc/gondolin/mitm";

/** cert filename inside the MITM mount */
export const MITM_CA_FILENAME = "ca.crt";

/** absolute guest path for the host-provided MITM certificate */
export const MITM_CA_GUEST_PATH = `${MITM_CA_MOUNT_PATH}/${MITM_CA_FILENAME}`;

export function resolveMitmMounts(
  options?: VmVfsOptions | null,
  mitmCertDir?: string,
  netEnabled = true,
): Record<string, VirtualProvider> {
  if (options === null || !netEnabled) return {};

  const mountPaths = listMountPaths(options?.mounts);
  if (
    mountPaths.includes(MITM_CA_MOUNT_PATH) ||
    mountPaths.includes("/etc/gondolin")
  ) {
    return {};
  }

  return {
    [MITM_CA_MOUNT_PATH]: createMitmCaProvider(mitmCertDir),
  };
}

export function createMitmCaProvider(mitmCertDir?: string): VirtualProvider {
  const resolvedDir = resolveMitmCertDir(mitmCertDir);
  const ca = loadOrCreateMitmCaSync(resolvedDir);
  const provider = new MemoryProvider();
  const certPem = ca.certPem.endsWith("\n") ? ca.certPem : `${ca.certPem}\n`;
  const handle = provider.openSync(`/${MITM_CA_FILENAME}`, "w");
  try {
    handle.writeFileSync(certPem);
  } finally {
    handle.closeSync();
  }
  provider.setReadOnly();
  return provider;
}

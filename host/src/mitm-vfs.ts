import type { VmVfsOptions } from "./vm";

import { loadOrCreateMitmCaSync, resolveMitmCertDir } from "./mitm";
import { MemoryProvider, type VirtualProvider } from "./vfs/node";
import { listMountPaths } from "./vfs/mounts";

export function resolveMitmMounts(
  options?: VmVfsOptions | null,
  mitmCertDir?: string,
  netEnabled = true,
): Record<string, VirtualProvider> {
  if (options === null || !netEnabled) return {};

  const mountPaths = listMountPaths(options?.mounts);
  if (mountPaths.includes("/etc/ssl/certs")) {
    return {};
  }

  return {
    "/etc/ssl/certs": createMitmCaProvider(mitmCertDir),
  };
}

export function createMitmCaProvider(mitmCertDir?: string): VirtualProvider {
  const resolvedDir = resolveMitmCertDir(mitmCertDir);
  const ca = loadOrCreateMitmCaSync(resolvedDir);
  const provider = new MemoryProvider();
  const certPem = ca.certPem.endsWith("\n") ? ca.certPem : `${ca.certPem}\n`;
  const handle = provider.openSync("/ca-certificates.crt", "w");
  try {
    handle.writeFileSync(certPem);
  } finally {
    handle.closeSync();
  }
  provider.setReadOnly();
  return provider;
}

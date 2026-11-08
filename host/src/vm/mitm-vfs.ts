import type { VmVfsOptions } from "./types.ts";

import { loadOrCreateMitmCaSync, resolveMitmCertDir } from "../mitm.ts";
import { listMountPaths } from "../vfs/mounts.ts";
import { MemoryProvider, type VirtualProvider } from "../vfs/node/index.ts";
import { markNativeMount } from "../vfs/native-marks.ts";
import { ReadonlyProvider } from "../vfs/readonly.ts";

/** Hidden setter replacing the certificate of a {@link createMitmCaProvider} mount */
const MITM_CA_SETTER = Symbol.for("gondolin.mitmCaSetter");

/** Certificate setters of the MITM CA mounts among `mounts` */
export function mitmCaSetters(
  mounts: Record<string, VirtualProvider>,
): Array<(certPem: string) => void> {
  const out: Array<(certPem: string) => void> = [];
  for (const provider of Object.values(mounts)) {
    const setter = (provider as unknown as Record<symbol, unknown>)[
      MITM_CA_SETTER
    ];
    if (typeof setter === "function") {
      out.push(setter as (certPem: string) => void);
    }
  }
  return out;
}

/** guest mount path for host-provided MITM trust material */
const MITM_CA_MOUNT_PATH = "/etc/gondolin/mitm";

/** cert filename inside the MITM mount */
const MITM_CA_FILENAME = "ca.crt";

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
  const memory = new MemoryProvider();
  const write = (pem: string) => {
    const certPem = pem.endsWith("\n") ? pem : `${pem}\n`;
    const handle = memory.openSync(`/${MITM_CA_FILENAME}`, "w");
    try {
      handle.writeFileSync(certPem);
    } finally {
      handle.closeSync();
    }
  };
  write(ca.certPem);
  const provider = new ReadonlyProvider(memory);
  // a remote daemon terminates TLS with its own CA (`mitm_ca`)
  Object.defineProperty(provider, MITM_CA_SETTER, {
    value: write,
    enumerable: false,
  });
  // native engine: a static mount with the current certificate
  return markNativeMount(provider, {
    kind: "static",
    get files() {
      return {
        [`/${MITM_CA_FILENAME}`]: Buffer.from(
          memory.readFileSync!(`/${MITM_CA_FILENAME}`) as Buffer,
        ),
      };
    },
  });
}

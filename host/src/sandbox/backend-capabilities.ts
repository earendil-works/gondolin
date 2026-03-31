import type { SandboxVmm } from "./server-options.ts";

export type BackendCapabilities = {
  /** whether backend supports vfs mount/bind boot wiring */
  vfsMounts: boolean;
  /** whether backend supports pty-backed interactive exec */
  pty: boolean;
  /** whether backend supports guest loopback tcp forward channels */
  tcpForwardChannels: boolean;
};

const BACKEND_CAPABILITIES: Record<SandboxVmm, BackendCapabilities> = {
  qemu: {
    vfsMounts: true,
    pty: true,
    tcpForwardChannels: true,
  },
  krun: {
    vfsMounts: true,
    pty: true,
    tcpForwardChannels: true,
  },
  "wasm-node": {
    vfsMounts: false,
    pty: true,
    tcpForwardChannels: false,
  },
};

export function getBackendCapabilities(vmm: SandboxVmm): BackendCapabilities {
  return BACKEND_CAPABILITIES[vmm];
}

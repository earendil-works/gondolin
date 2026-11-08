import type { DebugLogFn } from "../debug.ts";
import type { NativeEngineOptions } from "../native/config.ts";
import type { DnsOptions, HttpFetch, HttpHooks } from "../net/types.ts";
import type { SshOptions } from "../net/ssh.ts";
import type { TcpOptions } from "../net/tcp.ts";
import type { RootfsMode } from "../build/config.ts";
import type { SandboxServerOptions } from "../sandbox/server-options.ts";
import type { GuestTmpfsMounts } from "../sandbox/tmpfs.ts";
import type { VirtualProvider } from "../vfs/node/index.ts";
import type { VfsHooks } from "../vfs/provider.ts";

export type EnvInput = string[] | Record<string, string>;

export type VmVfsOptions = {
  /** mount map (guest path -> provider) */
  mounts?: Record<string, VirtualProvider>;
  /** vfs hook callbacks */
  hooks?: VfsHooks;
  /** guest path for the fuse mount (default: "/data") */
  fuseMount?: string;
};

export type VmRootfsOptions = {
  /** rootfs write mode */
  mode?: RootfsMode;
  /** minimum virtual disk size (`bytes`, or `K`/`M`/`G`/`T` suffix) */
  size?: string | number;
};

export type VMOptions = {
  /** how to reach gondolind (native engine): local binary, a command, a connection, remote mode */
  native?: NativeEngineOptions;
  /** host engine: `native` (the `gondolind` daemon, the only engine) or `auto` (the same; kept for compatibility); `"node"` was removed and throws */
  engine?: "native" | "auto";
  /** sandbox controller options */
  sandbox?: SandboxServerOptions;
  /** rootfs mode override */
  rootfs?: VmRootfsOptions;
  /** whether operations that need a running vm (`exec`, `vm.fs`, `enableSsh`, `enableIngress`) boot it on demand (default: true); with `false`, call `start()` first */
  autoStart?: boolean;
  /**
   * Ignored: was the guest HTTP egress client of the removed node engine.
   * Use `httpHooks.onRequest` (it may return a `Response`) to intercept or
   * replace upstream requests.
   * @deprecated
   */
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
  /** whether to allow WebSocket upgrades for guest egress (default: true) */
  allowWebSockets?: boolean;
  /** vfs configuration (null disables vfs integration) */
  vfs?: VmVfsOptions | null;
  /** default environment variables */
  env?: EnvInput;
  /** vm memory size (qemu syntax, default: "1G") */
  memory?: string;
  /** vm cpu count (default: 2) */
  cpus?: number;
  /** guest tmpfs mounts replacing the built-in set (`{}` keeps scratch paths on the root disk) */
  tmpfs?: GuestTmpfsMounts;
  /** startup timeout while waiting for guest readiness in `ms` (`<= 0` disables timeout) */
  startTimeoutMs?: number;
  /** session label for `gondolin list` */
  sessionLabel?: string;

  /** debug log callback */
  debugLog?: DebugLogFn | null;
};

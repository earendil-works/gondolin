import type { DebugLogFn } from "../debug.ts";
import type { DnsOptions, HttpFetch, HttpHooks } from "../qemu/contracts.ts";
import type { SshOptions } from "../qemu/ssh.ts";
import type { TcpOptions } from "../qemu/tcp.ts";
import type { RootfsMode } from "../build/config.ts";
import type { SandboxServerOptions } from "../sandbox/server-options.ts";
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
};

export type VMOptions = {
  /** sandbox controller options */
  sandbox?: SandboxServerOptions;
  /** rootfs mode override */
  rootfs?: VmRootfsOptions;
  /** whether to boot the vm immediately (default: true) */
  autoStart?: boolean;
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
  /** startup timeout while waiting for guest readiness in `ms` (`<= 0` disables timeout) */
  startTimeoutMs?: number;
  /** session label for `gondolin list` */
  sessionLabel?: string;

  /** debug log callback */
  debugLog?: DebugLogFn | null;
};

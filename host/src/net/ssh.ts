/** Guest SSH egress options and exec policy types (served by the daemon). */

import type { SshCredential } from "../ssh/types.ts";

export type { SshCredential } from "../ssh/types.ts";

export type SshExecRequest = {
  /** target hostname derived from synthetic dns mapping */
  hostname: string;
  /** target port */
  port: number;

  /** ssh username the guest authenticated as */
  guestUsername: string;

  /** raw ssh exec command */
  command: string;

  /** source guest flow attribution */
  src: {
    /** guest source ip address */
    ip: string;
    /** guest source port */
    port: number;
  };
};

export type SshExecDecision =
  | { allow: true }
  | {
      allow: false;
      /** process exit code (default: 1) */
      exitCode?: number;
      /** message written to the guest channel stderr (trailing newline implied) */
      message?: string;
    };

export type SshExecPolicy = (
  request: SshExecRequest,
) => SshExecDecision | Promise<SshExecDecision>;

export type SshOptions = {
  /** allowed ssh host patterns (optionally with ":PORT" suffix to allow non-standard ports) */
  allowedHosts: string[];
  /** host pattern -> upstream private-key credential */
  credentials?: Record<string, SshCredential>;
  /** ssh-agent socket path (e.g. $SSH_AUTH_SOCK) */
  agent?: string;
  /** OpenSSH known_hosts file path(s) used for default host key verification when `hostVerifier` is not set */
  knownHostsFile?: string | string[];

  /** allow/deny callback for guest ssh exec requests */
  execPolicy?: SshExecPolicy;

  /** max concurrent upstream ssh connections per guest tcp flow */
  maxUpstreamConnectionsPerTcpSession?: number;
  /** max concurrent upstream ssh connections across all guest flows */
  maxUpstreamConnectionsTotal?: number;
  /** upstream ssh connect+handshake timeout in `ms` */
  upstreamReadyTimeoutMs?: number;
  /** upstream ssh keepalive interval in `ms` */
  upstreamKeepaliveIntervalMs?: number;
  /** upstream ssh keepalive probes before disconnect */
  upstreamKeepaliveCountMax?: number;

  /** guest-facing ssh host key */
  hostKey?: string | Buffer;
  /** upstream host key verifier callback (required when `allowedHosts` is non-empty unless `knownHostsFile`/default known_hosts is used) */
  hostVerifier?: (hostname: string, key: Buffer, port: number) => boolean;
};

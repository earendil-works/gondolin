#!/usr/bin/env node
import { randomUUID } from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { PassThrough } from "stream";

import { VmCheckpoint } from "../src/checkpoint.ts";
import { VM } from "../src/vm/core.ts";
import type { VirtualProvider } from "../src/vfs/node/index.ts";
import { MemoryProvider, RealFSProvider } from "../src/vfs/node/index.ts";
import { ReadonlyProvider } from "../src/vfs/readonly.ts";
import { createHttpHooks } from "../src/http/hooks.ts";
import {
  FrameReader,
  buildExecRequest,
  decodeMessage,
  encodeFrame,
  type IncomingMessage,
} from "../src/sandbox/virtio-protocol.ts";
import { attachTty } from "../src/utils/tty-attach.ts";
import {
  getDefaultBuildConfig,
  serializeBuildConfig,
  parseBuildConfig,
  type BuildConfig,
} from "../src/build/config.ts";
import { buildAssets, verifyAssets } from "../src/build/index.ts";
import { loadAssetManifest } from "../src/assets.ts";
import {
  connectToSession,
  findSession,
  gcSessions,
  listSessions,
} from "../src/session-registry.ts";
import {
  decodeOutputFrame,
  type ServerMessage,
  type SnapshotResponseMessage,
} from "../src/sandbox/control-protocol.ts";

type Command = {
  cmd: string;
  argv: string[];
  env: string[];
  cwd?: string;
  id: number;
};

type ExecArgs = {
  sock?: string;
  commands: Command[];
  common: CommonOptions;
};

function getDefaultInteractiveShellCommand(): string[] {
  return [
    "/bin/sh",
    "-lc",
    "if command -v bash >/dev/null 2>&1; then exec bash -i; else exec /bin/sh -i; fi",
  ];
}

function checkpointBaseDir(): string {
  const cacheBase =
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return (
    process.env.GONDOLIN_CHECKPOINT_DIR ??
    path.join(cacheBase, "gondolin", "checkpoints")
  );
}

function sanitizeCheckpointName(name: string): string {
  const trimmed = name.trim();
  const safe = trimmed
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "snapshot";
}

function resolveSnapshotPath(args: { output?: string; name?: string }): string {
  if (args.output) {
    return path.resolve(args.output);
  }

  const checkpointDir = checkpointBaseDir();
  const stem = args.name ? sanitizeCheckpointName(args.name) : randomUUID();
  return path.resolve(checkpointDir, `${stem}.qcow2`);
}

async function waitForCheckpointReady(
  checkpointPath: string,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(checkpointPath)) {
        VmCheckpoint.load(checkpointPath);
        return true;
      }
    } catch {
      // keep polling
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  try {
    if (fs.existsSync(checkpointPath)) {
      VmCheckpoint.load(checkpointPath);
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

function resolveResumeCheckpoint(resume: string): string {
  const value = resume.trim();
  if (!value) {
    throw new Error("--resume requires a non-empty checkpoint id or path");
  }

  const resolvedPath = path.resolve(value);
  if (fs.existsSync(resolvedPath)) {
    return resolvedPath;
  }

  if (value.includes(path.sep) || value.includes("/") || value.includes("\\")) {
    throw new Error(`checkpoint not found: ${value}`);
  }

  const dir = checkpointBaseDir();
  if (!fs.existsSync(dir)) {
    throw new Error(`checkpoint not found: ${value}`);
  }

  const normalized = value.endsWith(".qcow2") ? value.slice(0, -6) : value;
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".qcow2"))
    .map((entry) => entry.name);

  const matches = entries.filter((file) => {
    const stem = file.slice(0, -6);
    return stem === normalized || stem.startsWith(normalized);
  });

  if (matches.length === 0) {
    throw new Error(`checkpoint not found: ${value}`);
  }

  if (matches.length > 1) {
    throw new Error(
      `ambiguous checkpoint id '${value}' matches ${matches.length} snapshots:\n` +
        matches.map((file) => `  ${file.slice(0, -6)}`).join("\n"),
    );
  }

  return path.join(dir, matches[0]!);
}

function renderCliError(err: unknown) {
  const code = (err as any)?.code;
  const binary = (err as any)?.path;

  if (
    code === "ENOENT" &&
    typeof binary === "string" &&
    binary.includes("qemu")
  ) {
    console.error(`Error: QEMU binary '${binary}' not found.`);
    console.error("Please install QEMU to run the sandbox.");
    if (process.platform === "darwin") {
      console.error("  brew install qemu");
    } else {
      console.error(
        "  sudo apt install qemu-system (or equivalent for your distro)",
      );
    }
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
}

function usage() {
  console.log("Usage: gondolin <command> [options]");
  console.log("Commands:");
  console.log(
    "  exec         Run a command via the virtio socket or in-process VM",
  );
  console.log(
    "  bash         Start an interactive shell session in the VM (bash -> sh fallback)",
  );
  console.log("  list         List running VM sessions");
  console.log("  attach       Attach to a running VM session");
  console.log("  snapshot     Snapshot a running VM session");
  console.log(
    "  build        Build custom guest assets (kernel, initramfs, rootfs)",
  );
  console.log("  help         Show this help");
  console.log("\nRun gondolin <command> --help for command-specific flags.");
}

function bashUsage() {
  console.log("Usage: gondolin bash [options] [-- COMMAND [ARGS...]]");
  console.log();
  console.log(
    "Start an interactive shell session in the sandbox (bash -> sh fallback).",
  );
  console.log("Press Ctrl-] to detach and force-close the session locally.");
  console.log();
  console.log("Command Options:");
  console.log(
    "  --                              Everything after -- is treated as command + args",
  );
  console.log(
    "  --cwd PATH                      Working directory for the command",
  );
  console.log(
    "  --env KEY=VALUE                 Set environment variable (can repeat)",
  );
  console.log(
    "  --resume ID_OR_PATH             Resume from a snapshot ID or .qcow2 path",
  );
  console.log();
  console.log("VFS Options:");
  console.log(
    "  --mount-hostfs HOST:GUEST[:ro]  Mount host directory at guest path",
  );
  console.log(
    "                                  Append :ro for read-only mount",
  );
  console.log(
    "  --mount-memfs PATH              Create memory-backed mount at path",
  );
  console.log();
  console.log("Network Options:");
  console.log(
    "  --allow-host HOST               Allow HTTP requests to host (can repeat)",
  );
  console.log("  --host-secret NAME@HOST[,HOST...][=VALUE]");
  console.log(
    "                                  Add secret for specified hosts",
  );
  console.log(
    "                                  If =VALUE is omitted, reads from $NAME",
  );
  console.log(
    "  --dns MODE                      DNS mode: synthetic|trusted|open (default: synthetic)",
  );
  console.log(
    "  --dns-trusted-server IP         Trusted resolver IPv4 (repeatable; trusted mode)",
  );
  console.log(
    "  --dns-synthetic-host-mapping M  Synthetic DNS mapping: single|per-host",
  );
  console.log(
    "  --tcp-map SPEC                  Map guest HOST[:PORT] to upstream HOST:PORT",
  );
  console.log(
    "                                  Format: GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT",
  );
  console.log(
    "  --ssh-allow-host HOST[:PORT]     Allow outbound SSH to host (repeatable; default port: 22)",
  );
  console.log(
    "  --ssh-agent [SOCK]              Use ssh-agent for host-side SSH auth (defaults to $SSH_AUTH_SOCK)",
  );
  console.log(
    "  --ssh-known-hosts PATH          OpenSSH known_hosts file for upstream verification (repeatable)",
  );
  console.log(
    "  --ssh-credential SPEC           Host-side SSH key (HOST[:PORT]=PATH or USER@HOST[:PORT]=PATH)",
  );
  console.log(
    "                                  Optional: append ,passphrase-env=ENV or ,passphrase=...",
  );
  console.log(
    "  --disable-websockets            Disable WebSocket upgrades (egress + ingress)",
  );
  console.log();
  console.log("Ingress:");
  console.log(
    "  --listen [HOST:PORT]            Start host ingress gateway (default: 127.0.0.1:0)",
  );
  console.log();
  console.log("Debugging:");
  console.log(
    "  --ssh                           Enable SSH access via a localhost port forward",
  );
  console.log("  --ssh-user USER                 SSH username (default: root)");
  console.log(
    "  --ssh-port PORT                 Local listen port (default: 0 = ephemeral)",
  );
  console.log(
    "  --ssh-listen HOST               Local listen host (default: 127.0.0.1)",
  );
  console.log();
  console.log("Examples:");
  console.log("  gondolin bash --mount-hostfs /home/user/project:/workspace");
  console.log(
    "  gondolin bash --mount-hostfs /data:/data:ro --mount-memfs /tmp",
  );
  console.log("  gondolin bash --allow-host api.github.com");
  console.log("  gondolin bash --host-secret GITHUB_TOKEN@api.github.com");
  console.log("  gondolin bash --cmd claude --cwd /workspace");
  console.log("  gondolin bash --listen");
  console.log("  gondolin bash --listen 127.0.0.1:3000");
  console.log("  gondolin bash --resume 4a8f2b0c");
  console.log("  gondolin bash --resume /tmp/my-snapshot.qcow2");
  console.log("  gondolin bash --ssh");
}

function listUsage() {
  console.log("Usage: gondolin list [options]");
  console.log();
  console.log("List active VM sessions registered in the local cache.");
  console.log();
  console.log("Options:");
  console.log("  --all        Show stale/dead sessions too");
  console.log("  --help, -h   Show this help");
}

function attachUsage() {
  console.log(
    "Usage: gondolin attach <SESSION_ID> [options] [-- COMMAND [ARGS...]]",
  );
  console.log();
  console.log(
    "Attach to an already-running VM and run an interactive command.",
  );
  console.log("Press Ctrl-] to detach locally.");
  console.log();
  console.log("Options:");
  console.log("  --cwd PATH      Working directory for the command");
  console.log("  --env KEY=VALUE Set environment variable (repeatable)");
  console.log("  --help, -h      Show this help");
  console.log();
  console.log("Default command: bash -i (fallback: /bin/sh -i)");
}

function snapshotUsage() {
  console.log("Usage: gondolin snapshot <SESSION_ID> [options]");
  console.log();
  console.log("Create a disk snapshot of a running VM session and stop it.");
  console.log();
  console.log("Options:");
  console.log(
    "  --output PATH   Absolute or relative path for the snapshot .qcow2 file",
  );
  console.log("  --name NAME     Snapshot name (default output path only)");
  console.log("  --help, -h      Show this help");
}

function execUsage() {
  console.log("Usage:");
  console.log("  gondolin exec --sock PATH -- CMD [ARGS...]");
  console.log(
    "  gondolin exec --sock PATH --cmd CMD [--arg ARG] [--env KEY=VALUE] [--cwd PATH] [--cmd CMD ...]",
  );
  console.log(
    "  gondolin exec [options] -- CMD [ARGS...]  (in-process VM mode, no --sock)",
  );
  console.log();
  console.log("Use -- to pass a command and its arguments directly.");
  console.log("Arguments apply to the most recent --cmd.");
  console.log();
  console.log("VFS Options (VM mode only):");
  console.log(
    "  --mount-hostfs HOST:GUEST[:ro]  Mount host directory at guest path",
  );
  console.log(
    "  --mount-memfs PATH              Create memory-backed mount at path",
  );
  console.log();
  console.log("Network Options (VM mode only):");
  console.log("  --allow-host HOST               Allow HTTP requests to host");
  console.log("  --host-secret NAME@HOST[,HOST...][=VALUE]");
  console.log(
    "                                  Add secret for specified hosts",
  );
  console.log(
    "  --dns MODE                      DNS mode: synthetic|trusted|open (default: synthetic)",
  );
  console.log(
    "  --dns-trusted-server IP         Trusted resolver IPv4 (repeatable; trusted mode)",
  );
  console.log(
    "  --dns-synthetic-host-mapping M  Synthetic DNS mapping: single|per-host",
  );
  console.log(
    "  --tcp-map SPEC                  Map guest HOST[:PORT] to upstream HOST:PORT",
  );
  console.log(
    "                                  Format: GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT",
  );
  console.log(
    "  --ssh-allow-host HOST[:PORT]     Allow outbound SSH to host (repeatable; default port: 22)",
  );
  console.log(
    "  --ssh-agent [SOCK]              Use ssh-agent for host-side SSH auth (defaults to $SSH_AUTH_SOCK)",
  );
  console.log(
    "  --ssh-known-hosts PATH          OpenSSH known_hosts file for upstream verification (repeatable)",
  );
  console.log(
    "  --ssh-credential SPEC           Host-side SSH key (HOST[:PORT]=PATH or USER@HOST[:PORT]=PATH)",
  );
  console.log(
    "                                  Optional: append ,passphrase-env=ENV or ,passphrase=...",
  );
  console.log(
    "  --disable-websockets            Disable WebSocket upgrades (egress + ingress)",
  );
}

type MountSpec = {
  hostPath: string;
  guestPath: string;
  readonly: boolean;
};

type SecretSpec = {
  name: string;
  value: string;
  hosts: string[];
};

type SshCredentialSpec = {
  host: string;
  username?: string;
  keyPath: string;
  /** private key passphrase (optional) */
  passphrase?: string;
};

type CommonOptions = {
  mounts: MountSpec[];
  memoryMounts: string[];
  allowedHosts: string[];
  secrets: SecretSpec[];

  /** disable WebSocket upgrades (both egress and ingress) */
  disableWebSockets?: boolean;

  /** dns mode (synthetic|trusted|open) */
  dnsMode?: "synthetic" | "trusted" | "open";

  /** trusted dns server ipv4 addresses */
  dnsTrustedServers: string[];

  /** synthetic dns hostname mapping mode */
  dnsSyntheticHostMapping?: "single" | "per-host";

  /** guest host[:port] -> upstream host:port tcp mappings */
  tcpHostMappings: Record<string, string>;

  /** allowed ssh host patterns for outbound ssh */
  sshAllowedHosts: string[];

  /** ssh-agent socket path (defaults to $SSH_AUTH_SOCK) */
  sshAgent?: string;

  /** OpenSSH known_hosts file paths for upstream host key verification */
  sshKnownHostsFiles: string[];

  /** ssh credentials for host-side proxy auth */
  sshCredentials: SshCredentialSpec[];

  /** enable ssh (bash command only) */
  ssh?: boolean;
  /** ssh user (bash command only) */
  sshUser?: string;
  /** local ssh listen port (bash command only) */
  sshPort?: number;
  /** local ssh listen host (bash command only) */
  sshListen?: string;
};

function parseMount(spec: string): MountSpec {
  const parts = spec.split(":");
  if (parts.length < 2) {
    throw new Error(`Invalid mount format: ${spec} (expected HOST:GUEST[:ro])`);
  }

  // Handle Windows paths like C:\path by checking if the second part looks like a path
  let hostPath: string;
  let rest: string[];

  // Check if this looks like a Windows drive letter (single letter followed by nothing before the colon)
  if (
    parts[0].length === 1 &&
    /^[a-zA-Z]$/.test(parts[0]) &&
    parts.length >= 3
  ) {
    hostPath = `${parts[0]}:${parts[1]}`;
    rest = parts.slice(2);
  } else {
    hostPath = parts[0];
    rest = parts.slice(1);
  }

  if (rest.length === 0) {
    throw new Error(`Invalid mount format: ${spec} (missing guest path)`);
  }

  // Similar check for guest path (though unlikely to be Windows in a VM)
  let guestPath: string;
  let options: string[];

  if (rest[0].length === 1 && /^[a-zA-Z]$/.test(rest[0]) && rest.length >= 2) {
    guestPath = `${rest[0]}:${rest[1]}`;
    options = rest.slice(2);
  } else {
    guestPath = rest[0];
    options = rest.slice(1);
  }

  const readonly = options.includes("ro");

  return { hostPath, guestPath, readonly };
}

function parseHostSecret(spec: string): SecretSpec {
  // Format: NAME@HOST[,HOST...][=VALUE]
  const atIndex = spec.indexOf("@");
  if (atIndex === -1) {
    throw new Error(
      `Invalid host-secret format: ${spec} (expected NAME@HOST[,HOST...][=VALUE])`,
    );
  }

  const name = spec.slice(0, atIndex);
  if (!name) {
    throw new Error(`Invalid host-secret format: ${spec} (empty name)`);
  }

  const afterAt = spec.slice(atIndex + 1);
  const eqIndex = afterAt.indexOf("=");

  let hostsStr: string;
  let value: string;

  if (eqIndex === -1) {
    // No explicit value, read from environment
    hostsStr = afterAt;
    const envValue = process.env[name];
    if (envValue === undefined) {
      throw new Error(`Environment variable ${name} not set for host-secret`);
    }
    value = envValue;
  } else {
    hostsStr = afterAt.slice(0, eqIndex);
    value = afterAt.slice(eqIndex + 1);
  }

  const hosts = hostsStr.split(",").filter(Boolean);
  if (hosts.length === 0) {
    throw new Error(`Invalid host-secret format: ${spec} (no hosts specified)`);
  }

  return { name, value, hosts };
}

function parseSshCredential(spec: string): SshCredentialSpec {
  // Format:
  //   HOST=KEY_PATH[,passphrase=...][,passphrase-env=ENV]
  //   USER@HOST=KEY_PATH[,passphrase=...][,passphrase-env=ENV]
  //
  // Prefer passphrase-env to avoid leaking secrets into shell history.
  const eq = spec.indexOf("=");
  if (eq === -1) {
    throw new Error(
      `Invalid --ssh-credential format: ${spec} (expected HOST=KEY_PATH)`,
    );
  }

  const left = spec.slice(0, eq).trim();
  const right = spec.slice(eq + 1).trim();
  if (!left || !right) {
    throw new Error(
      `Invalid --ssh-credential format: ${spec} (expected HOST=KEY_PATH)`,
    );
  }

  const [keyPathRaw, ...opts] = right.split(",");
  const keyPath = keyPathRaw.trim();
  if (!keyPath) {
    throw new Error(
      `Invalid --ssh-credential format: ${spec} (missing KEY_PATH)`,
    );
  }

  let passphrase: string | undefined;
  let passphraseEnv: string | undefined;

  for (const optRaw of opts) {
    const opt = optRaw.trim();
    if (!opt) continue;

    if (opt.startsWith("passphrase-env=")) {
      passphraseEnv = opt.slice("passphrase-env=".length);
      if (!passphraseEnv) {
        throw new Error(
          `Invalid --ssh-credential option: ${opt} (missing env var name)`,
        );
      }
      continue;
    }

    if (opt === "passphrase-ask") {
      throw new Error(
        `Invalid --ssh-credential option: ${opt} (interactive prompting is not supported; use passphrase-env=ENV)`,
      );
    }

    if (opt.startsWith("passphrase=")) {
      passphrase = opt.slice("passphrase=".length);
      continue;
    }

    throw new Error(`Invalid --ssh-credential option: ${opt}`);
  }

  if (passphraseEnv && passphrase !== undefined) {
    throw new Error(
      `Invalid --ssh-credential format: ${spec} (cannot combine passphrase and passphrase-env)`,
    );
  }

  if (passphraseEnv) {
    const envValue = process.env[passphraseEnv];
    if (envValue === undefined) {
      throw new Error(
        `--ssh-credential passphrase env var '${passphraseEnv}' is not set (for ${left})`,
      );
    }
    passphrase = envValue;
  }

  const at = left.indexOf("@");
  if (at === -1) {
    return { host: left, keyPath, passphrase };
  }

  const username = left.slice(0, at).trim();
  const host = left.slice(at + 1).trim();
  if (!username || !host) {
    throw new Error(
      `Invalid --ssh-credential format: ${spec} (expected USER@HOST=KEY_PATH)`,
    );
  }

  return { host, username, keyPath, passphrase };
}

function parseTcpMapSpec(spec: string): { key: string; value: string } {
  const trimmed = spec.trim();
  const eq = trimmed.indexOf("=");
  if (eq <= 0 || eq === trimmed.length - 1) {
    throw new Error(
      `Invalid --tcp-map format: ${spec} (expected GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT)`,
    );
  }

  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  if (!key || !value) {
    throw new Error(
      `Invalid --tcp-map format: ${spec} (expected GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT)`,
    );
  }

  return { key, value };
}

function resolveSshAgent(explicit?: string): string {
  const sock = (explicit ?? process.env.SSH_AUTH_SOCK)?.trim();
  if (!sock) {
    throw new Error("--ssh-agent requires a socket path or $SSH_AUTH_SOCK");
  }
  return sock;
}

function parseListenSpec(spec: string): { host: string; port: number } {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("--listen requires a non-empty value");
  }

  let host = "127.0.0.1";
  let portStr = trimmed;

  // Support IPv6 bracket form: [::1]:1234
  if (portStr.startsWith("[")) {
    const bracketEnd = portStr.indexOf("]");
    if (bracketEnd === -1) {
      throw new Error(`Invalid --listen value: ${spec} (missing ']')`);
    }
    host = portStr.slice(1, bracketEnd);
    if (!host) {
      throw new Error(
        `Invalid --listen value: ${spec} (empty host in brackets)`,
      );
    }
    const rest = portStr.slice(bracketEnd + 1);
    if (!rest.startsWith(":")) {
      throw new Error(
        `Invalid --listen value: ${spec} (expected :PORT after ])`,
      );
    }
    portStr = rest.slice(1);
  } else if (portStr.includes(":")) {
    // HOST:PORT or :PORT
    const idx = portStr.lastIndexOf(":");
    const rawHost = portStr.slice(0, idx);
    if (rawHost) host = rawHost;
    portStr = portStr.slice(idx + 1);
  }

  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --listen value: ${spec} (port must be 0-65535)`);
  }

  return { host, port };
}

function buildVmOptions(common: CommonOptions) {
  const mounts: Record<string, VirtualProvider> = {};

  // Add host filesystem mounts
  for (const mount of common.mounts) {
    // Resolve and validate host path
    const resolvedHostPath = path.resolve(mount.hostPath);
    if (!fs.existsSync(resolvedHostPath)) {
      throw new Error(`Host path does not exist: ${mount.hostPath}`);
    }
    const stat = fs.statSync(resolvedHostPath);
    if (!stat.isDirectory()) {
      throw new Error(`Host path is not a directory: ${mount.hostPath}`);
    }

    let provider: VirtualProvider = new RealFSProvider(resolvedHostPath);
    if (mount.readonly) {
      provider = new ReadonlyProvider(provider);
    }
    mounts[mount.guestPath] = provider;
  }

  // Add memory mounts
  for (const path of common.memoryMounts) {
    mounts[path] = new MemoryProvider();
  }

  // Build HTTP hooks if we have network options
  let httpHooks;
  let env: Record<string, string> | undefined;

  if (common.allowedHosts.length > 0 || common.secrets.length > 0) {
    const secrets: Record<string, { hosts: string[]; value: string }> = {};
    for (const secret of common.secrets) {
      secrets[secret.name] = { hosts: secret.hosts, value: secret.value };
    }

    const result = createHttpHooks({
      allowedHosts: common.allowedHosts,
      secrets,
    });
    httpHooks = result.httpHooks;
    env = result.env;
  }

  if (common.dnsTrustedServers.length > 0) {
    if (common.dnsMode === undefined) {
      throw new Error("--dns-trusted-server requires --dns trusted");
    }
    if (common.dnsMode !== "trusted") {
      throw new Error(
        "--dns-trusted-server can only be used with --dns trusted",
      );
    }
  }

  if (
    common.dnsSyntheticHostMapping &&
    common.dnsMode &&
    common.dnsMode !== "synthetic"
  ) {
    throw new Error("--dns-synthetic-host-mapping requires --dns synthetic");
  }

  if (common.sshCredentials.length > 0) {
    for (const credential of common.sshCredentials) {
      if (!common.sshAllowedHosts.includes(credential.host)) {
        common.sshAllowedHosts.push(credential.host);
      }
    }
  }

  if (common.sshAgent && common.sshAllowedHosts.length === 0) {
    throw new Error(
      "--ssh-agent requires at least one --ssh-allow-host (or --ssh-credential)",
    );
  }

  if (common.sshAllowedHosts.length > 0) {
    if (common.dnsMode && common.dnsMode !== "synthetic") {
      throw new Error("--ssh-allow-host requires --dns synthetic");
    }
    if (!common.dnsMode) {
      common.dnsMode = "synthetic";
    }
    if (!common.dnsSyntheticHostMapping) {
      common.dnsSyntheticHostMapping = "per-host";
    }
  }

  if (Object.keys(common.tcpHostMappings).length > 0) {
    if (common.dnsMode && common.dnsMode !== "synthetic") {
      throw new Error("--tcp-map requires --dns synthetic");
    }
    if (!common.dnsMode) {
      common.dnsMode = "synthetic";
    }
    if (!common.dnsSyntheticHostMapping) {
      common.dnsSyntheticHostMapping = "per-host";
    }
  }

  const sshCredentials =
    common.sshCredentials.length > 0
      ? Object.fromEntries(
          common.sshCredentials.map((credential) => {
            const resolvedPath = path.resolve(credential.keyPath);
            if (!fs.existsSync(resolvedPath)) {
              throw new Error(
                `SSH key file does not exist: ${credential.keyPath}`,
              );
            }
            return [
              credential.host,
              {
                username: credential.username,
                privateKey: fs.readFileSync(resolvedPath, "utf8"),
                passphrase: credential.passphrase,
              },
            ];
          }),
        )
      : undefined;

  const dns =
    common.dnsMode ||
    common.dnsTrustedServers.length > 0 ||
    common.dnsSyntheticHostMapping
      ? {
          mode: common.dnsMode,
          trustedServers: common.dnsTrustedServers,
          syntheticHostMapping: common.dnsSyntheticHostMapping,
        }
      : undefined;

  const vmOptions: any = {
    vfs: Object.keys(mounts).length > 0 ? { mounts } : undefined,
    httpHooks,
    dns,
    ssh:
      common.sshAllowedHosts.length > 0
        ? {
            allowedHosts: common.sshAllowedHosts,
            credentials: sshCredentials,
            agent: common.sshAgent,
            knownHostsFile:
              common.sshKnownHostsFiles.length > 0
                ? common.sshKnownHostsFiles
                : undefined,
          }
        : undefined,
    tcp:
      Object.keys(common.tcpHostMappings).length > 0
        ? {
            hosts: common.tcpHostMappings,
          }
        : undefined,
    env,
  };

  if (common.disableWebSockets) {
    vmOptions.allowWebSockets = false;
  }

  return vmOptions;
}

function parseExecArgs(argv: string[]): ExecArgs {
  const args: ExecArgs = {
    commands: [],
    common: {
      mounts: [],
      memoryMounts: [],
      allowedHosts: [],
      secrets: [],
      dnsTrustedServers: [],
      tcpHostMappings: {},
      sshAllowedHosts: [],
      sshCredentials: [],
      sshAgent: undefined,
      sshKnownHostsFiles: [],
    },
  };
  let current: Command | null = null;
  let nextId = 1;

  const fail = (message: string): never => {
    console.error(message);
    execUsage();
    process.exit(1);
  };

  const parseId = (value: string) => {
    const id = Number(value);
    if (!Number.isFinite(id)) fail("--id must be a number");
    if (id >= nextId) nextId = id + 1;
    return id;
  };

  const parseCommonOption = (optionArgs: string[], i: number): number => {
    const arg = optionArgs[i];
    switch (arg) {
      case "--mount-hostfs": {
        const spec = optionArgs[++i];
        if (!spec) fail("--mount-hostfs requires an argument");
        args.common.mounts.push(parseMount(spec));
        return i;
      }
      case "--mount-memfs": {
        const path = optionArgs[++i];
        if (!path) fail("--mount-memfs requires a path argument");
        args.common.memoryMounts.push(path);
        return i;
      }
      case "--allow-host": {
        const host = optionArgs[++i];
        if (!host) fail("--allow-host requires a host argument");
        args.common.allowedHosts.push(host);
        return i;
      }
      case "--host-secret": {
        const spec = optionArgs[++i];
        if (!spec) fail("--host-secret requires an argument");
        args.common.secrets.push(parseHostSecret(spec));
        return i;
      }
      case "--dns": {
        const mode = optionArgs[++i] as any;
        if (mode !== "synthetic" && mode !== "trusted" && mode !== "open") {
          fail("--dns must be one of: synthetic, trusted, open");
        }
        args.common.dnsMode = mode;
        return i;
      }
      case "--dns-trusted-server": {
        const ip = optionArgs[++i];
        if (!ip) fail("--dns-trusted-server requires an argument");
        if (net.isIP(ip) !== 4)
          fail("--dns-trusted-server must be a valid IPv4 address");
        args.common.dnsTrustedServers.push(ip);
        return i;
      }
      case "--dns-synthetic-host-mapping": {
        const mode = optionArgs[++i] as any;
        if (mode !== "single" && mode !== "per-host") {
          fail("--dns-synthetic-host-mapping must be one of: single, per-host");
        }
        args.common.dnsSyntheticHostMapping = mode;
        return i;
      }
      case "--tcp-map": {
        const spec = optionArgs[++i];
        if (!spec) fail("--tcp-map requires an argument");
        try {
          const mapping = parseTcpMapSpec(spec);
          args.common.tcpHostMappings[mapping.key] = mapping.value;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
        return i;
      }
      case "--ssh-allow-host": {
        const host = optionArgs[++i];
        if (!host) fail("--ssh-allow-host requires a host argument");
        args.common.sshAllowedHosts.push(host);
        return i;
      }
      case "--ssh-agent": {
        const next = optionArgs[i + 1];
        if (next && !next.startsWith("--") && next !== "-h" && next !== "--") {
          i += 1;
          args.common.sshAgent = resolveSshAgent(next);
        } else {
          args.common.sshAgent = resolveSshAgent();
        }
        return i;
      }
      case "--ssh-known-hosts": {
        const file = optionArgs[++i];
        if (!file) fail("--ssh-known-hosts requires a path argument");
        args.common.sshKnownHostsFiles.push(file);
        return i;
      }
      case "--ssh-credential": {
        const spec = optionArgs[++i];
        if (!spec) fail("--ssh-credential requires an argument");
        try {
          args.common.sshCredentials.push(parseSshCredential(spec));
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
        return i;
      }
      case "--disable-websockets": {
        args.common.disableWebSockets = true;
        return i;
      }
    }
    return -1; // Not a common option
  };

  const separatorIndex = argv.indexOf("--");
  if (separatorIndex !== -1) {
    const optionArgs = argv.slice(0, separatorIndex);
    const commandArgs = argv.slice(separatorIndex + 1);
    if (commandArgs.length === 0) fail("missing command after --");

    current = {
      cmd: commandArgs[0],
      argv: commandArgs.slice(1),
      env: [],
      id: nextId++,
    };
    args.commands.push(current);

    for (let i = 0; i < optionArgs.length; i += 1) {
      const arg = optionArgs[i];

      // Try parsing as common option first
      const newIndex = parseCommonOption(optionArgs, i);
      if (newIndex >= 0) {
        i = newIndex;
        continue;
      }

      switch (arg) {
        case "--sock":
          args.sock = optionArgs[++i];
          break;
        case "--env":
          current.env.push(optionArgs[++i]);
          break;
        case "--cwd":
          current.cwd = optionArgs[++i];
          break;
        case "--id":
          current.id = parseId(optionArgs[++i]);
          break;
        case "--help":
        case "-h":
          execUsage();
          process.exit(0);
        default:
          fail(`Unknown argument: ${arg}`);
      }
    }

    return args;
  }

  const requireCurrent = (flag: string): Command => {
    if (!current) fail(`${flag} requires --cmd`);
    return current!;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    // Try parsing as common option first
    const newIndex = parseCommonOption(argv, i);
    if (newIndex >= 0) {
      i = newIndex;
      continue;
    }

    switch (arg) {
      case "--sock":
        args.sock = argv[++i];
        break;
      case "--cmd":
        current = { cmd: argv[++i], argv: [], env: [], id: nextId++ };
        args.commands.push(current);
        break;
      case "--arg": {
        const command = requireCurrent("--arg");
        command.argv.push(argv[++i]);
        break;
      }
      case "--env": {
        const command = requireCurrent("--env");
        command.env.push(argv[++i]);
        break;
      }
      case "--cwd": {
        const command = requireCurrent("--cwd");
        command.cwd = argv[++i];
        break;
      }
      case "--id": {
        const command = requireCurrent("--id");
        command.id = parseId(argv[++i]);
        break;
      }
      case "--help":
      case "-h":
        execUsage();
        process.exit(0);
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function buildCommandPayload(command: Command) {
  const payload: {
    cmd: string;
    argv?: string[];
    env?: string[];
    cwd?: string;
  } = {
    cmd: command.cmd,
  };

  if (command.argv.length > 0) payload.argv = command.argv;
  if (command.env.length > 0) payload.env = command.env;
  if (command.cwd) payload.cwd = command.cwd;

  return payload;
}

async function runExecVm(args: ExecArgs) {
  const vmOptions = buildVmOptions(args.common);
  let vm: VM | null = null;
  let exitCode = 0;

  try {
    // Use VM.create() to ensure guest assets are available
    vm = await VM.create({
      ...vmOptions,
    });

    for (const command of args.commands) {
      const result = await vm.exec([command.cmd, ...command.argv], {
        env: command.env.length > 0 ? command.env : undefined,
        cwd: command.cwd,
      });

      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);

      if (result.signal !== undefined) {
        process.stderr.write(`process exited due to signal ${result.signal}\n`);
      }

      if (result.exitCode !== 0 && exitCode === 0) {
        exitCode = result.exitCode;
      }
    }
  } catch (err) {
    renderCliError(err);
    exitCode = 1;
  } finally {
    if (vm) {
      try {
        await vm.close();
      } catch {
        // ignore close errors
      }
    }
  }

  process.exit(exitCode);
}

function runExecSocket(args: ExecArgs) {
  const socket = net.createConnection({ path: args.sock! });
  const reader = new FrameReader();
  let currentIndex = 0;
  let inflightId: number | null = null;
  let exitCode = 0;
  let closing = false;

  const sendNext = () => {
    const command = args.commands[currentIndex];
    inflightId = command.id;
    const payload = buildCommandPayload(command);
    const message = buildExecRequest(command.id, payload);
    socket.write(encodeFrame(message));
  };

  const finish = (code?: number) => {
    if (code !== undefined && exitCode === 0) exitCode = code;
    if (closing) return;
    closing = true;
    socket.end();
  };

  socket.on("connect", () => {
    console.log(`connected to ${args.sock}`);
    sendNext();
  });

  socket.on("data", (chunk) => {
    reader.push(chunk, (frame) => {
      const message = decodeMessage(frame) as IncomingMessage;
      if (message.t === "exec_output") {
        const data = message.p.data;
        if (message.p.stream === "stdout") {
          process.stdout.write(data);
        } else {
          process.stderr.write(data);
        }
      } else if (message.t === "exec_response") {
        if (inflightId !== null && message.id !== inflightId) {
          console.error(
            `unexpected response id ${message.id} (expected ${inflightId})`,
          );
          finish(1);
          return;
        }
        const code = message.p.exit_code ?? 1;
        const signal = message.p.signal;
        if (signal !== undefined) {
          console.error(`process exited due to signal ${signal}`);
        }
        if (code !== 0 && exitCode === 0) exitCode = code;
        currentIndex += 1;
        if (currentIndex < args.commands.length) {
          sendNext();
        } else {
          finish();
        }
      } else if (message.t === "error") {
        console.error(`error ${message.p.code}: ${message.p.message}`);
        finish(1);
      }
    });
  });

  socket.on("error", (err) => {
    console.error(`socket error: ${err.message}`);
    finish(1);
  });

  socket.on("end", () => {
    if (!closing && exitCode === 0) exitCode = 1;
  });

  socket.on("close", () => {
    process.exit(exitCode);
  });
}

async function runExec(argv: string[] = process.argv.slice(2)) {
  const args = parseExecArgs(argv);

  if (args.commands.length === 0) {
    execUsage();
    process.exit(1);
  }

  if (args.sock) {
    // Socket mode (direct virtio connection)
    runExecSocket(args);
  } else {
    // VM mode (in-process server)
    await runExecVm(args);
  }
}

type BashArgs = CommonOptions & {
  /** enable ingress gateway */
  listen?: boolean;
  /** host interface to bind ingress gateway */
  listenHost?: string;
  /** host port to bind ingress gateway (0 = ephemeral) */
  listenPort?: number;
  /** custom command with arguments to run instead of the default shell */
  command?: string[];
  /** working directory for the command */
  cwd?: string;
  /** environment variables */
  env?: string[];
  /** snapshot id or checkpoint path to resume */
  resume?: string;
};

function parseBashArgs(argv: string[]): BashArgs {
  const args: BashArgs = {
    mounts: [],
    memoryMounts: [],
    allowedHosts: [],
    secrets: [],
    dnsTrustedServers: [],
    tcpHostMappings: {},
    sshAllowedHosts: [],
    sshCredentials: [],
    sshAgent: undefined,
    sshKnownHostsFiles: [],
    ssh: false,
    listen: false,
    env: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    // Handle -- delimiter for command + args
    if (arg === "--") {
      if (i + 1 < argv.length) {
        args.command = argv.slice(i + 1);
      }
      break; // Stop processing arguments
    }

    switch (arg) {
      case "--mount-hostfs": {
        const spec = argv[++i];
        if (!spec) {
          console.error("--mount-hostfs requires an argument");
          process.exit(1);
        }
        args.mounts.push(parseMount(spec));
        break;
      }
      case "--mount-memfs": {
        const path = argv[++i];
        if (!path) {
          console.error("--mount-memfs requires a path argument");
          process.exit(1);
        }
        args.memoryMounts.push(path);
        break;
      }
      case "--allow-host": {
        const host = argv[++i];
        if (!host) {
          console.error("--allow-host requires a host argument");
          process.exit(1);
        }
        args.allowedHosts.push(host);
        break;
      }
      case "--host-secret": {
        const spec = argv[++i];
        if (!spec) {
          console.error("--host-secret requires an argument");
          process.exit(1);
        }
        args.secrets.push(parseHostSecret(spec));
        break;
      }
      case "--dns": {
        const mode = argv[++i] as any;
        if (mode !== "synthetic" && mode !== "trusted" && mode !== "open") {
          console.error("--dns must be one of: synthetic, trusted, open");
          process.exit(1);
        }
        args.dnsMode = mode;
        break;
      }
      case "--dns-trusted-server": {
        const ip = argv[++i];
        if (!ip) {
          console.error("--dns-trusted-server requires an argument");
          process.exit(1);
        }
        if (net.isIP(ip) !== 4) {
          console.error("--dns-trusted-server must be a valid IPv4 address");
          process.exit(1);
        }
        args.dnsTrustedServers.push(ip);
        break;
      }
      case "--dns-synthetic-host-mapping": {
        const mode = argv[++i] as any;
        if (mode !== "single" && mode !== "per-host") {
          console.error(
            "--dns-synthetic-host-mapping must be one of: single, per-host",
          );
          process.exit(1);
        }
        args.dnsSyntheticHostMapping = mode;
        break;
      }
      case "--tcp-map": {
        const spec = argv[++i];
        if (!spec) {
          console.error("--tcp-map requires an argument");
          process.exit(1);
        }
        try {
          const mapping = parseTcpMapSpec(spec);
          args.tcpHostMappings[mapping.key] = mapping.value;
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
        break;
      }
      case "--ssh-allow-host": {
        const host = argv[++i];
        if (!host) {
          console.error("--ssh-allow-host requires a host argument");
          process.exit(1);
        }
        args.sshAllowedHosts.push(host);
        break;
      }
      case "--ssh-agent": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--") && next !== "-h") {
          i += 1;
          args.sshAgent = resolveSshAgent(next);
        } else {
          args.sshAgent = resolveSshAgent();
        }
        break;
      }
      case "--ssh-known-hosts": {
        const file = argv[++i];
        if (!file) {
          console.error("--ssh-known-hosts requires a path argument");
          process.exit(1);
        }
        args.sshKnownHostsFiles.push(file);
        break;
      }
      case "--ssh-credential": {
        const spec = argv[++i];
        if (!spec) {
          console.error("--ssh-credential requires an argument");
          process.exit(1);
        }
        try {
          args.sshCredentials.push(parseSshCredential(spec));
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
        break;
      }
      case "--disable-websockets": {
        args.disableWebSockets = true;
        break;
      }
      case "--listen": {
        args.listen = true;
        const spec = argv[i + 1];

        // --listen optionally accepts a value. If the next token looks like a
        // long option ("--foo"), treat it as another flag; otherwise treat it
        // as the listen spec even if it starts with "-" (so "--listen -1"
        // errors instead of being silently ignored).
        if (spec && !spec.startsWith("--") && spec !== "-h") {
          i += 1;
          const parsed = parseListenSpec(spec);
          args.listenHost = parsed.host;
          args.listenPort = parsed.port;
        }
        break;
      }
      case "--ssh":
        args.ssh = true;
        break;
      case "--ssh-user": {
        const user = argv[++i];
        if (!user) {
          console.error("--ssh-user requires an argument");
          process.exit(1);
        }
        args.sshUser = user;
        break;
      }
      case "--ssh-port": {
        const raw = argv[++i];
        if (!raw) {
          console.error("--ssh-port requires an argument");
          process.exit(1);
        }
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          console.error("--ssh-port must be an integer between 0 and 65535");
          process.exit(1);
        }
        args.sshPort = port;
        break;
      }
      case "--ssh-listen": {
        const host = argv[++i];
        if (!host) {
          console.error("--ssh-listen requires an argument");
          process.exit(1);
        }
        args.sshListen = host;
        break;
      }
      case "--cwd": {
        const cwd = argv[++i];
        if (!cwd) {
          console.error("--cwd requires an argument");
          process.exit(1);
        }
        args.cwd = cwd;
        break;
      }
      case "--env": {
        const env = argv[++i];
        if (!env) {
          console.error("--env requires an argument");
          process.exit(1);
        }
        args.env!.push(env);
        break;
      }
      case "--resume": {
        const resume = argv[++i];
        if (!resume) {
          console.error("--resume requires an argument");
          process.exit(1);
        }
        args.resume = resume;
        break;
      }
      case "--help":
      case "-h":
        bashUsage();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${arg}`);
        bashUsage();
        process.exit(1);
    }
  }

  return args;
}

async function runBash(argv: string[]) {
  const args = parseBashArgs(argv);
  const vmOptions = buildVmOptions(args);
  let vm: VM | null = null;
  let ingressAccess: { url: string; close(): Promise<void> } | null = null;
  let exitCode = 1;

  try {
    if (args.resume) {
      const checkpointPath = resolveResumeCheckpoint(args.resume);
      const checkpoint = VmCheckpoint.load(checkpointPath);
      vm = (await checkpoint.resume(vmOptions)) as VM;
    } else {
      // Use VM.create() to ensure guest assets are available
      vm = await VM.create({
        ...vmOptions,
      });
    }

    if (args.ssh) {
      const access = await vm.enableSsh({
        user: args.sshUser,
        listenHost: args.sshListen,
        listenPort: args.sshPort,
      });
      process.stderr.write(`SSH enabled: ${access.command}\n`);
    }

    if (args.listen) {
      ingressAccess = await vm.enableIngress({
        listenHost: args.listenHost,
        listenPort: args.listenPort,
        allowWebSockets: args.disableWebSockets ? false : undefined,
      });
      process.stderr.write(`Ingress enabled: ${ingressAccess.url}\n`);
      process.stderr.write(
        "Configure routes by editing /etc/gondolin/listeners inside the VM.\n",
      );
    }

    // Start the shell (or custom command) without using ExecProcess.attach() so we can implement
    // a CLI-local escape hatch (Ctrl-]) that always regains control.
    const proc = vm.shell({
      attach: false,
      cwd: args.cwd,
      command: args.command ?? getDefaultInteractiveShellCommand(),
      env: args.env && args.env.length > 0 ? args.env : undefined,
    });

    const stdin = process.stdin as NodeJS.ReadStream;
    const stdout = process.stdout as NodeJS.WriteStream;
    const stderr = process.stderr as NodeJS.WriteStream;

    const ESCAPE_BYTE = 0x1d; // Ctrl-]

    let resolveEscape!: () => void;
    const escapePromise = new Promise<void>((resolve) => {
      resolveEscape = resolve;
    });

    // This intentionally shares logic with ExecProcess.attach() via attachTty()
    // to minimize drift while still allowing the CLI-local Ctrl-] escape hatch.
    const { cleanup } = attachTty(
      stdin,
      stdout,
      stderr,
      proc.stdout,
      proc.stderr,
      {
        write: (chunk) => proc.write(chunk),
        end: () => proc.end(),
        resize: (rows, cols) => proc.resize(rows, cols),
        escape: {
          byte: ESCAPE_BYTE,
          onEscape: () => {
            // Detach output immediately (Ctrl-] should stop forwarding stdout/stderr too).
            if (proc.stdout) {
              try {
                proc.stdout.unpipe(stdout);
              } catch {
                // ignore
              }
              proc.stdout.pause();
            }
            if (proc.stderr) {
              try {
                proc.stderr.unpipe(stderr);
              } catch {
                // ignore
              }
              proc.stderr.pause();
            }

            process.stderr.write("\n[gondolin] detached (Ctrl-])\n");
            resolveEscape();
          },
        },
      },
    );

    void proc.result.then(
      () => cleanup(),
      () => cleanup(),
    );

    const raced = await Promise.race([
      proc.result.then((result) => ({ type: "result" as const, result })),
      escapePromise.then(() => ({ type: "escape" as const })),
    ]);

    if (raced.type === "escape") {
      // 130 matches typical "terminated by user" conventions (SIGINT-like)
      exitCode = 130;
    } else {
      const result = raced.result;
      if (result.signal !== undefined) {
        process.stderr.write(`process exited due to signal ${result.signal}\n`);
      }
      exitCode = result.exitCode;
    }
  } catch (err) {
    renderCliError(err);
    exitCode = 1;
  } finally {
    if (ingressAccess) {
      try {
        await ingressAccess.close();
      } catch {
        // ignore close errors
      }
    }

    if (vm) {
      try {
        await vm.close();
      } catch {
        // ignore close errors
      }
    }
  }

  process.exit(exitCode);
}

type ListArgs = {
  all: boolean;
};

function parseListArgs(argv: string[]): ListArgs {
  const args: ListArgs = { all: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") {
      args.all = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      listUsage();
      process.exit(0);
    }

    console.error(`Unknown argument: ${arg}`);
    listUsage();
    process.exit(1);
  }

  return args;
}

function formatAge(createdAt: string): string {
  const ts = new Date(createdAt).getTime();
  if (!Number.isFinite(ts)) return "?";

  const diffMs = Math.max(0, Date.now() - ts);
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

async function runList(argv: string[]) {
  const args = parseListArgs(argv);

  // Best-effort cleanup first.
  await gcSessions().catch(() => {
    // ignore
  });

  const sessions = await listSessions();
  const visible = args.all ? sessions : sessions.filter((s) => s.alive);

  if (visible.length === 0) {
    console.log("No running sessions.");
    return;
  }

  const rows = visible.map((entry) => ({
    id: entry.id,
    pid: String(entry.pid),
    age: formatAge(entry.createdAt),
    alive: entry.alive ? "yes" : "no",
    label: entry.label ?? "",
  }));

  const width = {
    id: Math.max("ID".length, ...rows.map((row) => row.id.length)),
    pid: Math.max("PID".length, ...rows.map((row) => row.pid.length)),
    age: Math.max("AGE".length, ...rows.map((row) => row.age.length)),
    alive: Math.max("ALIVE".length, ...rows.map((row) => row.alive.length)),
  };

  const pad = (value: string, len: number) => value.padEnd(len, " ");

  console.log(
    `${pad("ID", width.id)}  ${pad("PID", width.pid)}  ${pad("AGE", width.age)}  ${pad("ALIVE", width.alive)}  LABEL`,
  );

  for (const row of rows) {
    console.log(
      `${pad(row.id, width.id)}  ${pad(row.pid, width.pid)}  ${pad(row.age, width.age)}  ${pad(row.alive, width.alive)}  ${row.label}`,
    );
  }
}

type AttachArgs = {
  sessionId: string;
  command?: string[];
  cwd?: string;
  env: string[];
};

function parseAttachArgs(argv: string[]): AttachArgs {
  if (argv.length === 0) {
    attachUsage();
    process.exit(1);
  }

  const args: AttachArgs = {
    sessionId: "",
    env: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === "--") {
      if (i + 1 < argv.length) {
        args.command = argv.slice(i + 1);
      }
      break;
    }

    if (arg === "--help" || arg === "-h") {
      attachUsage();
      process.exit(0);
    }

    if (!args.sessionId && !arg.startsWith("-")) {
      args.sessionId = arg;
      i += 1;
      continue;
    }

    if (arg === "--cwd") {
      const value = argv[i + 1];
      if (!value) {
        console.error("--cwd requires an argument");
        process.exit(1);
      }
      args.cwd = value;
      i += 2;
      continue;
    }

    if (arg === "--env") {
      const value = argv[i + 1];
      if (!value) {
        console.error("--env requires an argument");
        process.exit(1);
      }
      args.env.push(value);
      i += 2;
      continue;
    }

    console.error(`Unknown argument: ${arg}`);
    attachUsage();
    process.exit(1);
  }

  if (!args.sessionId) {
    console.error("attach requires a session id");
    attachUsage();
    process.exit(1);
  }

  return args;
}

async function runAttach(argv: string[]) {
  const args = parseAttachArgs(argv);

  await gcSessions().catch(() => {
    // ignore
  });

  const session = await findSession(args.sessionId);
  if (!session || !session.alive) {
    throw new Error(`session not found or not running: ${args.sessionId}`);
  }

  const command = args.command ?? getDefaultInteractiveShellCommand();
  if (command.length === 0) {
    throw new Error("attach command must not be empty");
  }

  let done = false;
  let exitCode = 1;
  const requestId = 1;

  const stdoutPipe = new PassThrough();
  const stderrPipe = new PassThrough();

  let resolveDone!: (result: { exitCode: number; signal?: number }) => void;
  let rejectDone!: (error: Error) => void;
  const donePromise = new Promise<{ exitCode: number; signal?: number }>(
    (resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    },
  );

  const client = connectToSession(session.socketPath, {
    onJson(message: ServerMessage) {
      if (message.type === "status") {
        return;
      }

      if (message.type === "exec_response") {
        if (message.id !== requestId) return;
        done = true;
        resolveDone({
          exitCode: message.exit_code,
          signal: message.signal,
        });
        return;
      }

      if (message.type === "error") {
        if (message.id !== undefined && message.id !== requestId) return;
        if (
          message.id === requestId &&
          (message.code === "stdin_backpressure" ||
            message.code === "stdin_chunk_too_large")
        ) {
          return;
        }
        done = true;
        rejectDone(new Error(`error ${message.code}: ${message.message}`));
      }
    },
    onBinary(frame: Buffer) {
      const decoded = decodeOutputFrame(frame);
      if (decoded.id !== requestId) return;

      if (decoded.stream === "stdout") {
        stdoutPipe.write(decoded.data);
        client.send({
          type: "exec_window",
          id: requestId,
          stdout: decoded.data.length,
        });
      } else {
        stderrPipe.write(decoded.data);
        client.send({
          type: "exec_window",
          id: requestId,
          stderr: decoded.data.length,
        });
      }
    },
    onClose(error?: Error) {
      if (done) return;
      done = true;
      rejectDone(error ?? new Error("session connection closed"));
    },
  });

  client.send({
    type: "exec",
    id: requestId,
    cmd: command[0]!,
    argv: command.slice(1),
    env: args.env.length > 0 ? args.env : undefined,
    cwd: args.cwd,
    stdin: true,
    pty: true,
    stdout_window: 1024 * 1024,
    stderr_window: 1024 * 1024,
  });

  const procEscapePromise = new Promise<void>((resolve) => {
    const { cleanup } = attachTty(
      process.stdin as NodeJS.ReadStream,
      process.stdout as NodeJS.WriteStream,
      process.stderr as NodeJS.WriteStream,
      stdoutPipe,
      stderrPipe,
      {
        write: (chunk) => {
          client.send({
            type: "stdin",
            id: requestId,
            data: chunk.toString("base64"),
          });
        },
        end: () => {
          client.send({
            type: "stdin",
            id: requestId,
            eof: true,
          });
        },
        resize: (rows, cols) => {
          client.send({
            type: "pty_resize",
            id: requestId,
            rows,
            cols,
          });
        },
        escape: {
          byte: 0x1d,
          onEscape: () => {
            done = true;
            resolve();
          },
        },
      },
    );

    void donePromise.finally(() => cleanup());
  });

  try {
    const raced = await Promise.race([
      donePromise.then((result) => ({ type: "done" as const, result })),
      procEscapePromise.then(() => ({ type: "escape" as const })),
    ]);

    if (raced.type === "escape") {
      exitCode = 130;
    } else {
      if (raced.result.signal !== undefined) {
        process.stderr.write(
          `process exited due to signal ${raced.result.signal}\n`,
        );
      }
      exitCode = raced.result.exitCode;
    }
  } finally {
    stdoutPipe.end();
    stderrPipe.end();
    client.close();
  }

  process.exit(exitCode);
}

type SnapshotArgs = {
  sessionId: string;
  output?: string;
  name?: string;
};

function parseSnapshotArgs(argv: string[]): SnapshotArgs {
  if (argv.length === 0) {
    snapshotUsage();
    process.exit(1);
  }

  const args: SnapshotArgs = {
    sessionId: "",
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      snapshotUsage();
      process.exit(0);
    }

    if (!args.sessionId && !arg.startsWith("-")) {
      args.sessionId = arg;
      i += 1;
      continue;
    }

    if (arg === "--output") {
      const value = argv[i + 1];
      if (!value) {
        console.error("--output requires an argument");
        process.exit(1);
      }
      args.output = value;
      i += 2;
      continue;
    }

    if (arg === "--name") {
      const value = argv[i + 1];
      if (!value) {
        console.error("--name requires an argument");
        process.exit(1);
      }
      args.name = value;
      i += 2;
      continue;
    }

    console.error(`Unknown argument: ${arg}`);
    snapshotUsage();
    process.exit(1);
  }

  if (!args.sessionId) {
    console.error("snapshot requires a session id");
    snapshotUsage();
    process.exit(1);
  }

  if (args.output && args.name) {
    console.error("--name cannot be combined with --output");
    process.exit(1);
  }

  return args;
}

async function runSnapshot(argv: string[]) {
  const args = parseSnapshotArgs(argv);

  await gcSessions().catch(() => {
    // ignore
  });

  const session = await findSession(args.sessionId);
  if (!session || !session.alive) {
    throw new Error(`session not found or not running: ${args.sessionId}`);
  }

  const snapshotPath = resolveSnapshotPath(args);
  const requestId = 1;

  let done = false;
  let resolveDone!: (message: SnapshotResponseMessage) => void;
  let rejectDone!: (error: Error) => void;
  const donePromise = new Promise<SnapshotResponseMessage>(
    (resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    },
  );

  const client = connectToSession(session.socketPath, {
    onJson(message: ServerMessage) {
      if (message.type === "status") {
        return;
      }

      if (message.type === "snapshot_response") {
        if (message.id !== requestId) return;
        done = true;
        resolveDone(message);
        return;
      }

      if (message.type === "error") {
        if (message.id !== undefined && message.id !== requestId) return;
        done = true;
        rejectDone(new Error(`error ${message.code}: ${message.message}`));
      }
    },
    onBinary() {
      // snapshot command does not stream binary data
    },
    onClose(error?: Error) {
      if (done) return;

      void (async () => {
        const ready = await waitForCheckpointReady(snapshotPath);
        if (done) return;

        if (ready) {
          done = true;
          resolveDone({
            type: "snapshot_response",
            id: requestId,
            path: snapshotPath,
            name: path.basename(snapshotPath, path.extname(snapshotPath)),
          });
          return;
        }

        done = true;
        rejectDone(error ?? new Error("session connection closed"));
      })();
    },
  });

  client.send({
    type: "snapshot",
    id: requestId,
    path: snapshotPath,
  });

  try {
    const result = await donePromise;

    const snapshotId = path.basename(result.path, path.extname(result.path));
    const defaultDir = path.resolve(checkpointBaseDir());
    const snapshotDir = path.dirname(result.path);
    const resumeArg = snapshotDir === defaultDir ? snapshotId : result.path;

    console.log("Snapshot created:");
    console.log(`  ID: ${snapshotId}`);
    console.log(`  PATH: ${result.path}`);
    console.log("Resume with:");
    console.log(`  gondolin bash --resume ${resumeArg}`);
  } finally {
    client.close();
  }
}

// ============================================================================
// Build command
// ============================================================================

function buildUsage() {
  console.log("Usage: gondolin build [options]");
  console.log();
  console.log("Build custom guest assets (kernel, initramfs, rootfs).");
  console.log();
  console.log("Options:");
  console.log(
    "  --init-config           Generate a default build configuration",
  );
  console.log(
    "  --config FILE           Use the specified build configuration file",
  );
  console.log(
    "  --output DIR            Output directory for built assets (required for build)",
  );
  console.log(
    "  --arch ARCH             Target architecture (aarch64, x86_64)",
  );
  console.log(
    "  --verify DIR            Verify assets in directory against manifest",
  );
  console.log("  --quiet                 Reduce output verbosity");
  console.log();
  console.log("Workflows:");
  console.log();
  console.log("  1. Generate default config:");
  console.log("     gondolin build --init-config > build-config.json");
  console.log();
  console.log("  2. Edit the config to customize packages, settings, etc.");
  console.log();
  console.log("  3. Build assets:");
  console.log(
    "     gondolin build --config build-config.json --output ./my-assets",
  );
  console.log();
  console.log("  4. Use custom assets with VM:");
  console.log("     GONDOLIN_GUEST_DIR=./my-assets gondolin bash");
  console.log();
  console.log("Quick build (uses defaults for current architecture):");
  console.log("  gondolin build --output ./my-assets");
  console.log();
  console.log("Verify built assets:");
  console.log("  gondolin build --verify ./my-assets");
}

type BuildArgs = {
  initConfig: boolean;
  configFile?: string;
  outputDir?: string;
  arch?: "aarch64" | "x86_64";
  verify?: string;
  quiet: boolean;
};

function parseBuildArgs(argv: string[]): BuildArgs {
  const args: BuildArgs = {
    initConfig: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--init-config":
        args.initConfig = true;
        break;
      case "--config": {
        const value = argv[++i];
        if (!value) {
          console.error("--config requires a file path");
          process.exit(1);
        }
        args.configFile = value;
        break;
      }
      case "--output": {
        const value = argv[++i];
        if (!value) {
          console.error("--output requires a directory path");
          process.exit(1);
        }
        args.outputDir = value;
        break;
      }
      case "--arch": {
        const value = argv[++i];
        if (value !== "aarch64" && value !== "x86_64") {
          console.error("--arch must be aarch64 or x86_64");
          process.exit(1);
        }
        args.arch = value;
        break;
      }
      case "--verify": {
        const value = argv[++i];
        if (!value) {
          console.error("--verify requires a directory path");
          process.exit(1);
        }
        args.verify = value;
        break;
      }
      case "--quiet":
      case "-q":
        args.quiet = true;
        break;
      case "--help":
      case "-h":
        buildUsage();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${arg}`);
        buildUsage();
        process.exit(1);
    }
  }

  return args;
}

async function runBuild(argv: string[]) {
  const args = parseBuildArgs(argv);

  // Handle --init-config
  if (args.initConfig) {
    const config = getDefaultBuildConfig();
    if (args.arch) {
      config.arch = args.arch;
    }
    console.log(serializeBuildConfig(config));
    return;
  }

  // Handle --verify
  if (args.verify) {
    const assetDir = path.resolve(args.verify);
    const manifest = loadAssetManifest(assetDir);

    if (!manifest) {
      console.error(`No manifest found in ${assetDir}`);
      process.exit(1);
    }

    console.log(`Verifying assets in ${assetDir}...`);
    console.log(`Build time: ${manifest.buildTime}`);
    console.log(`Architecture: ${manifest.config.arch}`);
    console.log(`Distribution: ${manifest.config.distro}`);

    if (verifyAssets(assetDir)) {
      console.log("✓ All assets verified successfully");
      process.exit(0);
    } else {
      console.error("✗ Asset verification failed");
      process.exit(1);
    }
  }

  // Build mode - require output directory
  if (!args.outputDir) {
    console.error("--output is required for build");
    buildUsage();
    process.exit(1);
  }

  // Load or create config
  let config: BuildConfig;
  let configDir: string | undefined;
  if (args.configFile) {
    const configPath = path.resolve(args.configFile);
    configDir = path.dirname(configPath);
    if (!fs.existsSync(configPath)) {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }
    const configContent = fs.readFileSync(configPath, "utf8");
    try {
      config = parseBuildConfig(configContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to parse config: ${message}`);
      process.exit(1);
    }
  } else {
    config = getDefaultBuildConfig();
  }

  // Override arch if specified
  if (args.arch) {
    config.arch = args.arch;
  }

  // Run the build
  try {
    const result = await buildAssets(config, {
      outputDir: args.outputDir,
      configDir,
      verbose: !args.quiet,
    });

    if (!args.quiet) {
      console.log();
      console.log("Build successful!");
      console.log(`  Output directory: ${result.outputDir}`);
      console.log(`  Manifest: ${result.manifestPath}`);
      console.log();
      console.log("To use these assets:");
      console.log(`  GONDOLIN_GUEST_DIR=${result.outputDir} gondolin bash`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Build failed: ${message}`);
    process.exit(1);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    usage();
    process.exit(command ? 0 : 1);
  }

  switch (command) {
    case "exec":
      await runExec(args);
      return;
    case "bash":
      await runBash(args);
      return;
    case "list":
      await runList(args);
      return;
    case "attach":
      await runAttach(args);
      return;
    case "snapshot":
      await runSnapshot(args);
      return;
    case "build":
      await runBuild(args);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  renderCliError(err);
  process.exit(1);
});

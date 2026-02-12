#!/usr/bin/env node
import fs from "fs";
import net from "net";
import path from "path";

import { VM } from "../src/vm";
import type { VirtualProvider } from "../src/vfs";
import { MemoryProvider, RealFSProvider, ReadonlyProvider } from "../src/vfs";
import { createHttpHooks } from "../src/http-hooks";
import {
  FrameReader,
  buildExecRequest,
  decodeMessage,
  encodeFrame,
  IncomingMessage,
} from "../src/virtio-protocol";
import { attachTty } from "../src/tty-attach";
import {
  getDefaultBuildConfig,
  serializeBuildConfig,
  parseBuildConfig,
  type BuildConfig,
} from "../src/build-config";
import { buildAssets, verifyAssets } from "../src/builder";
import { loadAssetManifest } from "../src/assets";

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

function renderCliError(err: unknown) {
  const code = (err as any)?.code;
  const binary = (err as any)?.path;

  if (code === "ENOENT" && typeof binary === "string" && binary.includes("qemu")) {
    console.error(`Error: QEMU binary '${binary}' not found.`);
    console.error("Please install QEMU to run the sandbox.");
    if (process.platform === "darwin") {
      console.error("  brew install qemu");
    } else {
      console.error("  sudo apt install qemu-system (or equivalent for your distro)");
    }
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
}

function usage() {
  console.log("Usage: gondolin <command> [options]");
  console.log("Commands:");
  console.log("  exec         Run a command via the virtio socket or in-process VM");
  console.log("  bash         Start an interactive bash session in the VM");
  console.log("  build        Build custom guest assets (kernel, initramfs, rootfs)");
  console.log("  help         Show this help");
  console.log("\nRun gondolin <command> --help for command-specific flags.");
}

function bashUsage() {
  console.log("Usage: gondolin bash [options]");
  console.log();
  console.log("Start an interactive bash session in the sandbox.");
  console.log("Press Ctrl-] to detach and force-close the session locally.");
  console.log();
  console.log("Command Options:");
  console.log("  --cmd CMD                       Run custom command interactively");
  console.log("  --cwd PATH                      Working directory for the command");
  console.log("  --env KEY=VALUE                 Set environment variable (can repeat)");
  console.log();
  console.log("VFS Options:");
  console.log("  --mount-hostfs HOST:GUEST[:ro]  Mount host directory at guest path");
  console.log("                                  Append :ro for read-only mount");
  console.log("  --mount-memfs PATH              Create memory-backed mount at path");
  console.log();
  console.log("Network Options:");
  console.log("  --allow-host HOST               Allow HTTP requests to host (can repeat)");
  console.log("  --host-secret NAME@HOST[,HOST...][=VALUE]");
  console.log("                                  Add secret for specified hosts");
  console.log("                                  If =VALUE is omitted, reads from $NAME");
  console.log("  --dns MODE                      DNS mode: synthetic|trusted|open (default: synthetic)");
  console.log("  --dns-trusted-server IP         Trusted resolver IPv4 (repeatable; trusted mode)");
  console.log("  --disable-websockets            Disable WebSocket upgrades (egress + ingress)");
  console.log();
  console.log("Ingress:");
  console.log(
    "  --listen [HOST:PORT]            Start host ingress gateway (default: 127.0.0.1:0)"
  );
  console.log();
  console.log("Debugging:");
  console.log("  --ssh                           Enable SSH access via a localhost port forward");
  console.log("  --ssh-user USER                 SSH username (default: root)");
  console.log("  --ssh-port PORT                 Local listen port (default: 0 = ephemeral)");
  console.log("  --ssh-listen HOST               Local listen host (default: 127.0.0.1)");
  console.log();
  console.log("Examples:");
  console.log("  gondolin bash --mount-hostfs /home/user/project:/workspace");
  console.log("  gondolin bash --mount-hostfs /data:/data:ro --mount-memfs /tmp");
  console.log("  gondolin bash --allow-host api.github.com");
  console.log("  gondolin bash --host-secret GITHUB_TOKEN@api.github.com");
  console.log("  gondolin bash --cmd claude --cwd /workspace");
  console.log("  gondolin bash --listen");
  console.log("  gondolin bash --listen 127.0.0.1:3000");
  console.log("  gondolin bash --ssh");
}

function execUsage() {
  console.log("Usage:");
  console.log("  gondolin exec --sock PATH -- CMD [ARGS...]");
  console.log(
    "  gondolin exec --sock PATH --cmd CMD [--arg ARG] [--env KEY=VALUE] [--cwd PATH] [--cmd CMD ...]"
  );
  console.log("  gondolin exec [options] -- CMD [ARGS...]  (in-process VM mode, no --sock)");
  console.log();
  console.log("Use -- to pass a command and its arguments directly.");
  console.log("Arguments apply to the most recent --cmd.");
  console.log();
  console.log("VFS Options (VM mode only):");
  console.log("  --mount-hostfs HOST:GUEST[:ro]  Mount host directory at guest path");
  console.log("  --mount-memfs PATH              Create memory-backed mount at path");
  console.log();
  console.log("Network Options (VM mode only):");
  console.log("  --allow-host HOST               Allow HTTP requests to host");
  console.log("  --host-secret NAME@HOST[,HOST...][=VALUE]");
  console.log("                                  Add secret for specified hosts");
  console.log("  --dns MODE                      DNS mode: synthetic|trusted|open (default: synthetic)");
  console.log("  --dns-trusted-server IP         Trusted resolver IPv4 (repeatable; trusted mode)");
  console.log("  --disable-websockets            Disable WebSocket upgrades (egress + ingress)");
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
  if (parts[0].length === 1 && /^[a-zA-Z]$/.test(parts[0]) && parts.length >= 3) {
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
      `Invalid host-secret format: ${spec} (expected NAME@HOST[,HOST...][=VALUE])`
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
      throw new Error(`Invalid --listen value: ${spec} (empty host in brackets)`);
    }
    const rest = portStr.slice(bracketEnd + 1);
    if (!rest.startsWith(":")) {
      throw new Error(`Invalid --listen value: ${spec} (expected :PORT after ])`);
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
      throw new Error("--dns-trusted-server can only be used with --dns trusted");
    }
  }

  const dns =
    common.dnsMode || common.dnsTrustedServers.length > 0
      ? {
          mode: common.dnsMode,
          trustedServers: common.dnsTrustedServers,
        }
      : undefined;

  const vmOptions: any = {
    vfs: Object.keys(mounts).length > 0 ? { mounts } : undefined,
    httpHooks,
    dns,
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
        if (net.isIP(ip) !== 4) fail("--dns-trusted-server must be a valid IPv4 address");
        args.common.dnsTrustedServers.push(ip);
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
  const payload: { cmd: string; argv?: string[]; env?: string[]; cwd?: string } = {
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
          console.error(`unexpected response id ${message.id} (expected ${inflightId})`);
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
  /** custom command to run instead of bash */
  cmd?: string;
  /** working directory for the command */
  cwd?: string;
  /** environment variables */
  env?: string[];
};

function parseBashArgs(argv: string[]): BashArgs {
  const args: BashArgs = {
    mounts: [],
    memoryMounts: [],
    allowedHosts: [],
    secrets: [],
    dnsTrustedServers: [],
    ssh: false,
    listen: false,
    env: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
      case "--cmd": {
        const cmd = argv[++i];
        if (!cmd) {
          console.error("--cmd requires an argument");
          process.exit(1);
        }
        args.cmd = cmd;
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
    // Use VM.create() to ensure guest assets are available
    vm = await VM.create({
      ...vmOptions,
    });

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
        "Configure routes by editing /etc/gondolin/listeners inside the VM.\n"
      );
    }

    // Start the shell (or custom command) without using ExecProcess.attach() so we can implement
    // a CLI-local escape hatch (Ctrl-]) that always regains control.
    const proc = vm.shell({
      attach: false,
      cwd: args.cwd,
      command: args.cmd ? [args.cmd] : undefined,
      env: args.env && args.env.length > 0 ? args.env : undefined
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
    const { cleanup } = attachTty(stdin, stdout, stderr, proc.stdout, proc.stderr, {
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
    });

    void proc.result.then(
      () => cleanup(),
      () => cleanup()
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

// ============================================================================
// Build command
// ============================================================================

function buildUsage() {
  console.log("Usage: gondolin build [options]");
  console.log();
  console.log("Build custom guest assets (kernel, initramfs, rootfs).");
  console.log();
  console.log("Options:");
  console.log("  --init-config           Generate a default build configuration");
  console.log("  --config FILE           Use the specified build configuration file");
  console.log("  --output DIR            Output directory for built assets (required for build)");
  console.log("  --arch ARCH             Target architecture (aarch64, x86_64)");
  console.log("  --verify DIR            Verify assets in directory against manifest");
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
  console.log("     gondolin build --config build-config.json --output ./my-assets");
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

  if (!command || command === "help" || command === "--help" || command === "-h") {
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

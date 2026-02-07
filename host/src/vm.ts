import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Readable } from "stream";

import {
  ErrorMessage,
  ExecResponseMessage,
  StatusMessage,
  decodeOutputFrame,
  type ClientMessage,
} from "./control-protocol";
import {
  SandboxServer,
  SandboxServerOptions,
  resolveSandboxServerOptionsAsync,
  type ResolvedSandboxServerOptions,
  type SandboxConnection,
} from "./sandbox-server";
import type { SandboxState } from "./sandbox-controller";
import type { HttpFetch, HttpHooks } from "./qemu-net";
import {
  MemoryProvider,
  SandboxVfsProvider,
  VirtualProvider,
  type VfsHooks,
} from "./vfs";
import { loadOrCreateMitmCaSync, resolveMitmCertDir } from "./mitm";
import { defaultDebugLog, resolveDebugFlags, type DebugComponent, type DebugLogFn } from "./debug";
import {
  MountRouterProvider,
  listMountPaths,
  normalizeMountMap,
  normalizeMountPath,
} from "./vfs/mounts";
import {
  ExecProcess,
  ExecResult,
  ExecOptions,
  ExecSession,
  createExecSession,
  finishExecSession,
  rejectExecSession,
} from "./exec";

const MAX_REQUEST_ID = 0xffffffff;
const DEFAULT_STDIN_CHUNK = 32 * 1024;
const DEFAULT_VFS_READY_TIMEOUT_MS = 30000;
const VFS_READY_SLEEP_SECONDS = resolveEnvNumber(
  "GONDOLIN_VFS_READY_SLEEP_SECONDS",
  0.1
);
const VFS_READY_TIMEOUT_MS = resolveEnvNumber(
  "GONDOLIN_VFS_READY_TIMEOUT_MS",
  DEFAULT_VFS_READY_TIMEOUT_MS
);
const VFS_READY_ATTEMPTS = Math.max(
  1,
  Math.ceil(VFS_READY_TIMEOUT_MS / (VFS_READY_SLEEP_SECONDS * 1000))
);


function resolveEnvNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

type ExecInput = string | string[];

type EnvInput = string[] | Record<string, string>;

type ExecStdin = boolean | string | Buffer | Readable | AsyncIterable<Buffer>;

export type VmVfsOptions = {
  /** mount map (guest path -> provider) */
  mounts?: Record<string, VirtualProvider>;
  /** vfs hook callbacks */
  hooks?: VfsHooks;
  /** guest path for the fuse mount (default: "/data") */
  fuseMount?: string;
};

export type VMOptions = {
  /** sandbox controller options */
  sandbox?: SandboxServerOptions;
  /** whether to boot the vm immediately (default: true) */
  autoStart?: boolean;
  /** http fetch implementation for asset downloads */
  fetch?: HttpFetch;
  /** http interception hooks */
  httpHooks?: HttpHooks;
  /** max intercepted http request body size in `bytes` */
  maxHttpBodyBytes?: number;
  /** max buffered upstream http response body size in `bytes` */
  maxHttpResponseBodyBytes?: number;
  /** vfs configuration (null disables vfs integration) */
  vfs?: VmVfsOptions | null;
  /** default environment variables */
  env?: EnvInput;
  /** vm memory size (qemu syntax, default: "1G") */
  memory?: string;
  /** vm cpu count (default: 2) */
  cpus?: number;

  /**
   * Debug log callback.
   *
   * If any debug mode is enabled (via `sandbox.debug` or `GONDOLIN_DEBUG`),
   * debug messages are delivered here.
   *
   * - `undefined`: defaults to `console.log` with `[component]` prefix
   * - `null`: disable debug output even if debug modes are enabled
   */
  debugLog?: DebugLogFn | null;
};

export type ShellOptions = {
  /** command to run (default: bash) */
  command?: string | string[];
  /** environment variables */
  env?: EnvInput;
  /** working directory */
  cwd?: string;
  /** abort signal */
  signal?: AbortSignal;
  /** whether to attach to stdin/stdout/stderr (default: true in a tty) */
  attach?: boolean;
};

export type EnableSshOptions = {
  /** ssh username (default: "root") */
  user?: string;
  /** local listen host (default: 127.0.0.1) */
  listenHost?: string;
  /** local listen port (0 picks an ephemeral port) */
  listenPort?: number;
};

export type SshAccess = {
  /** local host to connect to */
  host: string;
  /** local port to connect to */
  port: number;
  /** ssh username */
  user: string;
  /** path to a temporary private key file */
  identityFile: string;
  /** ready-to-run ssh command */
  command: string;
  /** close the local forwarder and remove temporary key material */
  close(): Promise<void>;
};

// Re-export types from exec.ts
export { ExecProcess, ExecResult, ExecOptions } from "./exec";

export type VMState = SandboxState | "unknown";

export class VM {
  /**
   * Replace the debug log callback.
   *
   * Passing `null` disables debug output.
   */
  setDebugLog(callback: DebugLogFn | null) {
    this.debugLog = callback;
  }
  private readonly autoStart: boolean;
  private server: SandboxServer | null;
  private readonly defaultEnv: EnvInput | undefined;
  private connection: SandboxConnection | null = null;
  private connectPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private statusPromise: Promise<SandboxState> | null = null;
  private statusResolve: ((state: SandboxState) => void) | null = null;
  private statusReject: ((error: Error) => void) | null = null;
  private state: SandboxState | "unknown" = "unknown";
  private stateWaiters: Array<{
    state: SandboxState;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private sessions = new Map<number, ExecSession>();
  private nextId = 1;
  private vfs: SandboxVfsProvider | null;
  private readonly fuseMount: string;
  private readonly fuseBinds: string[];
  private bootSent = false;
  private vfsReadyPromise: Promise<void> | null = null;
  private qemuChecked = false;
  private debugLog: DebugLogFn | null = null;
  private debugListener: ((component: DebugComponent, message: string) => void) | null = null;
  private sshAccess: SshAccess | null = null;

  /**
   * Create a VM instance, downloading guest assets if needed.
   *
   * This is the recommended way to create a VM in production, as it will
   * automatically download the guest image if it's not available locally.
   *
   * @param options VM configuration options
   * @returns A configured VM instance
   */
  static async create(options: VMOptions = {}): Promise<VM> {
    // Resolve sandbox options with async asset fetching
    const sandboxOptions: SandboxServerOptions = { ...options.sandbox };

    // Build the combined sandbox options
    if (options.fetch && sandboxOptions.fetch === undefined) {
      sandboxOptions.fetch = options.fetch;
    }
    if (options.httpHooks && sandboxOptions.httpHooks === undefined) {
      sandboxOptions.httpHooks = options.httpHooks;
    }
    if (options.maxHttpBodyBytes !== undefined && sandboxOptions.maxHttpBodyBytes === undefined) {
      sandboxOptions.maxHttpBodyBytes = options.maxHttpBodyBytes;
    }
    if (
      options.maxHttpResponseBodyBytes !== undefined &&
      (sandboxOptions as any).maxHttpResponseBodyBytes === undefined
    ) {
      (sandboxOptions as any).maxHttpResponseBodyBytes = options.maxHttpResponseBodyBytes;
    }
    if (options.memory && sandboxOptions.memory === undefined) {
      sandboxOptions.memory = options.memory;
    }
    if (options.cpus && sandboxOptions.cpus === undefined) {
      sandboxOptions.cpus = options.cpus;
    }

    // Resolve options with asset fetching
    const resolvedSandboxOptions = await resolveSandboxServerOptionsAsync(sandboxOptions);

    // Create VM with pre-resolved options
    return new VM(options, resolvedSandboxOptions);
  }

  /**
   * Create a VM instance synchronously.
   *
   * This constructor requires that guest assets are available locally (either
   * in a development checkout or via GONDOLIN_GUEST_DIR). For automatic asset
   * downloading, use the async `VM.create()` factory instead.
   *
   * @param options VM configuration options
   * @param resolvedSandboxOptions Optional pre-resolved sandbox options (from VM.create())
   */
  constructor(options: VMOptions = {}, resolvedSandboxOptions?: ResolvedSandboxServerOptions) {
    this.autoStart = options.autoStart ?? true;
    const mitmMounts = resolveMitmMounts(
      options.vfs,
      options.sandbox?.mitmCertDir,
      options.sandbox?.netEnabled ?? true
    );
    const resolvedVfs = resolveVmVfs(options.vfs, mitmMounts);
    this.vfs = resolvedVfs.provider;
    this.defaultEnv = options.env;
    let fuseMounts = resolvedVfs.mounts;
    let fuseConfig = resolveFuseConfig(options.vfs, fuseMounts);
    this.fuseMount = fuseConfig.fuseMount;
    this.fuseBinds = fuseConfig.fuseBinds;

    const sandboxOptions: SandboxServerOptions = { ...options.sandbox };
    if (sandboxOptions.vfsProvider && options.vfs) {
      throw new Error("VM cannot specify both vfs and sandbox.vfsProvider");
    }
    if (sandboxOptions.vfsProvider) {
      const injectedMounts = resolveMitmMounts(
        undefined,
        sandboxOptions.mitmCertDir,
        sandboxOptions.netEnabled ?? true
      );
      if (Object.keys(injectedMounts).length > 0) {
        const normalized = normalizeMountMap({
          "/": sandboxOptions.vfsProvider,
          ...injectedMounts,
        });
        this.vfs = wrapProvider(new MountRouterProvider(normalized), {});
        fuseMounts = { "/": sandboxOptions.vfsProvider, ...injectedMounts };
      } else {
        this.vfs = wrapProvider(sandboxOptions.vfsProvider, {});
        fuseMounts = { "/": sandboxOptions.vfsProvider };
      }
      fuseConfig = resolveFuseConfig(options.vfs, fuseMounts);
      this.fuseMount = fuseConfig.fuseMount;
      this.fuseBinds = fuseConfig.fuseBinds;
      sandboxOptions.vfsProvider = this.vfs;
    }
    if (options.fetch && sandboxOptions.fetch === undefined) {
      sandboxOptions.fetch = options.fetch;
    }
    if (options.httpHooks && sandboxOptions.httpHooks === undefined) {
      sandboxOptions.httpHooks = options.httpHooks;
    }
    if (options.maxHttpBodyBytes !== undefined && sandboxOptions.maxHttpBodyBytes === undefined) {
      sandboxOptions.maxHttpBodyBytes = options.maxHttpBodyBytes;
    }
    if (
      options.maxHttpResponseBodyBytes !== undefined &&
      (sandboxOptions as any).maxHttpResponseBodyBytes === undefined
    ) {
      (sandboxOptions as any).maxHttpResponseBodyBytes = options.maxHttpResponseBodyBytes;
    }
    if (this.vfs && sandboxOptions.vfsProvider === undefined) {
      sandboxOptions.vfsProvider = this.vfs;
    }
    if (options.memory && sandboxOptions.memory === undefined) {
      sandboxOptions.memory = options.memory;
    }
    if (options.cpus && sandboxOptions.cpus === undefined) {
      sandboxOptions.cpus = options.cpus;
    }

    // Handle VFS in resolved options
    if (resolvedSandboxOptions) {
      // Merge VFS provider into resolved options
      if (this.vfs) {
        (resolvedSandboxOptions as any).vfsProvider = this.vfs;
      }
      this.server = new SandboxServer(resolvedSandboxOptions);
    } else {
      this.server = new SandboxServer(sandboxOptions);
    }

    const effectiveDebugFlags = resolvedSandboxOptions
      ? new Set(resolvedSandboxOptions.debug ?? [])
      : resolveDebugFlags(sandboxOptions.debug);

    const anyDebug = effectiveDebugFlags.size > 0;

    if (anyDebug) {
      // If the user didn't provide a debug sink, default to console.log
      this.debugLog = options.debugLog === undefined ? defaultDebugLog : options.debugLog;

      // Always attach the listener so `vm.setDebugLog()` can enable logging later.
      this.debugListener = (component, message) => {
        const logger = this.debugLog;
        if (!logger) return;
        try {
          logger(component, message);
        } catch {
          // ignore logger errors
        }
      };
      this.server.on("debug", this.debugListener);
    }
  }

  /**
   * Start the VM.
   *
   * If VFS is configured, this also waits for the VFS mount(s) to be ready.
   */
  async start() {
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  /**
   * Close the VM and release associated resources.
   */
  async close() {
    if (this.closePromise) return this.closePromise;

    this.closePromise = this.closeInternal().finally(() => {
      this.closePromise = null;
    });

    return this.closePromise;
  }

  /**
   * Execute a command in the sandbox.
   * 
   * Returns an ExecProcess which can be:
   * - awaited for a buffered result with strings
   * - iterated for streaming output
   * - used with stdin via write()/end()
   * 
   * @example
   * ```typescript
   * // Simple command - await for result
   * const result = await vm.exec(['echo', 'hello']);
   * console.log(result.stdout); // 'hello\n'
   * 
   * // Streaming output
   * for await (const line of vm.exec(['tail', '-f', '/var/log/syslog'])) {
   *   console.log(line);
   * }
   * 
   * // Interactive with stdin
   * const proc = vm.exec(['cat'], { stdin: true });
   * proc.write('hello\n');
   * proc.end();
   * const result = await proc;
   * ```
   */
  exec(command: ExecInput, options: ExecOptions = {}): ExecProcess {
    const proc = this.execInternal(command, options);
    return proc;
  }

  /**
   * Start an interactive shell session.
   * 
   * By default, attaches to process.stdin/stdout/stderr when running in a TTY.
   * 
   * @example
   * ```typescript
   * // Simple interactive shell
   * const result = await vm.shell();
   * process.exit(result.exitCode);
   * 
   * // Custom command
   * const result = await vm.shell({ command: 'python3' });
   * 
   * // Manual control
   * const proc = vm.shell({ attach: false });
   * proc.write('ls\n');
   * for await (const chunk of proc) {
   *   process.stdout.write(chunk);
   * }
   * ```
   */
  shell(options: ShellOptions = {}): ExecProcess {
    const command = options.command ?? ["bash", "-i"];
    const shouldAttach = options.attach ?? process.stdin.isTTY;

    const env = buildShellEnv(this.defaultEnv, options.env);

    const proc = this.exec(command, {
      env,
      cwd: options.cwd,
      stdin: true,
      pty: true,
      signal: options.signal,
    });

    if (shouldAttach) {
      proc.attach(
        process.stdin as NodeJS.ReadStream,
        process.stdout as NodeJS.WriteStream,
        process.stderr as NodeJS.WriteStream
      );
    }

    return proc;
  }

  /**
   * Enable SSH access to the VM by starting `sshd` in the guest (bound to loopback)
   * and creating a host-local TCP forwarder.
   */
  async enableSsh(options: EnableSshOptions = {}): Promise<SshAccess> {
    if (this.sshAccess) return this.sshAccess;

    await this.start();

    const user = options.user ?? "root";
    const listenHost = options.listenHost ?? "127.0.0.1";
    const listenPort = options.listenPort ?? 0;

    // Generate ephemeral client keypair
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-ssh-"));
    const keyPath = path.join(tmpDir, "id_ed25519");

    try {
      execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath], {
        stdio: "ignore",
      });
    } catch (err) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      throw new Error(
        `failed to run ssh-keygen (needed for vm.enableSsh): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const pubKey = fs.readFileSync(keyPath + ".pub", "utf8").trim();

    const shQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const sshUser = shQuote(user);

    // Install authorized_keys + start sandboxssh + start sshd
    const setupScript = `set -eu
SSH_USER=${sshUser}
if ! command -v sshd >/dev/null 2>&1; then
  echo "sshd not found in guest image" 1>&2
  exit 127
fi

if ! command -v sandboxssh >/dev/null 2>&1; then
  echo "sandboxssh not found in guest image" 1>&2
  exit 126
fi

if ! id "$SSH_USER" >/dev/null 2>&1; then
  echo "ssh user '$SSH_USER' does not exist in guest image" 1>&2
  exit 125
fi

SSH_UID=$(id -u "$SSH_USER")
SSH_GID=$(id -g "$SSH_USER")

SSH_HOME=""
if command -v getent >/dev/null 2>&1; then
  SSH_HOME=$(getent passwd "$SSH_USER" | cut -d: -f6 || true)
fi
if [ -z "$SSH_HOME" ] && [ -r /etc/passwd ]; then
  SSH_HOME=$(awk -F: -v u="$SSH_USER" '$1==u{print $6;exit}' /etc/passwd || true)
fi
if [ -z "$SSH_HOME" ]; then
  if [ "$SSH_UID" = "0" ]; then
    SSH_HOME=/root
  else
    SSH_HOME="/home/$SSH_USER"
  fi
fi

# Ensure loopback is up (needed for ListenAddress=127.0.0.1 and tcp forwarding)
if command -v ip >/dev/null 2>&1; then
  ip link set lo up || true
else
  ifconfig lo up || true
fi

# sshd on Alpine wants /var/empty to be root-owned
mkdir -p /var/empty
chown root:root /var/empty || true
chmod 755 /var/empty || true

mkdir -p "$SSH_HOME" "$SSH_HOME/.ssh" /run/sshd /etc/ssh

chown "$SSH_UID:$SSH_GID" "$SSH_HOME" "$SSH_HOME/.ssh" || true
if [ "$SSH_UID" = "0" ]; then
  chmod 700 "$SSH_HOME" || true
else
  chmod 755 "$SSH_HOME" || true
fi
chmod 700 "$SSH_HOME/.ssh" || true

cat > "$SSH_HOME/.ssh/authorized_keys" <<'EOF'
${pubKey}
EOF
chown "$SSH_UID:$SSH_GID" "$SSH_HOME/.ssh/authorized_keys" || true
chmod 600 "$SSH_HOME/.ssh/authorized_keys"

# Generate host keys if missing
ssh-keygen -A >/dev/null 2>&1 || true

# Start sandboxssh if it's not already running (required for host-side TCP forwarding)
if ! ps | grep -q '[s]andboxssh'; then
  sandboxssh >/tmp/sandboxssh.log 2>&1 &
fi

# Start sshd bound to loopback only
#
# Don't try to be clever about whether it's already running; it's easy to
# accidentally match our own command line. Starting twice is harmless (it will fail
# to bind), and we validate by probing the port from the host.
/usr/sbin/sshd -D -e -p 22 \
  -o ListenAddress=127.0.0.1 \
  -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no \
  -o ChallengeResponseAuthentication=no \
  -o PubkeyAuthentication=yes \
  -o AllowUsers=$SSH_USER \
  -o AllowAgentForwarding=no \
  -o AllowTcpForwarding=no \
  -o X11Forwarding=no \
  -o PermitTunnel=no \
  -o PermitRootLogin=prohibit-password \
  -o PidFile=/run/sshd.pid \
  >/tmp/sshd.log 2>&1 &
`;

    const setupResult = await this.exec(["sh", "-lc", setupScript]);
    if (
      setupResult.exitCode !== 0 &&
      setupResult.exitCode !== 127 &&
      setupResult.exitCode !== 126 &&
      setupResult.exitCode !== 125
    ) {
      throw new Error(
        `failed to configure ssh in guest (exit ${setupResult.exitCode}): ${setupResult.stderr.trim()}`
      );
    }
    if (setupResult.exitCode === 127) {
      throw new Error(
        "sshd not available in guest image. Rebuild guest assets with openssh installed (default images should include it)."
      );
    }
    if (setupResult.exitCode === 126) {
      throw new Error(
        "sandboxssh not available in guest image. Rebuild guest assets to include sandboxssh."
      );
    }
    if (setupResult.exitCode === 125) {
      throw new Error(
        `ssh user '${user}' does not exist in guest image (vm.enableSsh({ user }))`
      );
    }

    // Verify that the virtio tcp-forwarder is working and that sshd is reachable.
    const server = this.server;
    if (!server) {
      throw new Error("sandbox server is not available");
    }

    const deadline = Date.now() + 3000;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        const probe = await server.openTcpStream({ host: "127.0.0.1", port: 22, timeoutMs: 750 });
        probe.destroy();
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (lastErr) {
      const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new Error(`ssh port-forward is not available: ${detail}`);
    }

    // Create local forwarder
    const forwardServer = net.createServer((socket) => {
      socket.setNoDelay(true);
      // Ensure we always have an error handler; otherwise socket.destroy(err)
      // can turn into an uncaught exception.
      socket.on("error", () => {
        // ignore
      });

      void (async () => {
        const server = this.server;
        if (!server) {
          socket.destroy();
          return;
        }
        try {
          const tunnel = await server.openTcpStream({ host: "127.0.0.1", port: 22 });
          tunnel.on("error", () => socket.destroy());
          socket.on("error", (err) => tunnel.destroy(err));
          socket.pipe(tunnel).pipe(socket);
        } catch {
          socket.destroy();
        }
      })();
    });

    await new Promise<void>((resolve, reject) => {
      forwardServer.once("error", reject);
      forwardServer.listen({ host: listenHost, port: listenPort }, () => {
        forwardServer.off("error", reject);
        resolve();
      });
    });

    const addr = forwardServer.address();
    if (!addr || typeof addr === "string") {
      forwardServer.close();
      throw new Error("unexpected local forward server address");
    }

    const host = listenHost;
    const port = addr.port;

    const access: SshAccess = {
      host,
      port,
      user,
      identityFile: keyPath,
      command:
        `ssh -p ${port} -i ${keyPath} ` +
        `-o ForwardAgent=no -o ClearAllForwardings=yes -o IdentitiesOnly=yes ` +
        `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${user}@${host}`,
      close: async () => {
        await new Promise<void>((resolve) => forwardServer.close(() => resolve()));
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        if (this.sshAccess === access) {
          this.sshAccess = null;
        }
      },
    };

    this.sshAccess = access;
    return access;
  }

  private execInternal(command: ExecInput, options: ExecOptions): ExecProcess {
    const { cmd, argv } = normalizeCommand(command, options);
    const id = this.allocateId();

    const stdinSetting = options.stdin;
    const stdinEnabled = stdinSetting !== undefined && stdinSetting !== false;

    const session = createExecSession(id, {
      stdinEnabled,
      encoding: options.encoding,
      signal: options.signal,
      buffer: options.buffer,
    });

    // Setup abort handling
    if (options.signal) {
      const onAbort = () => {
        rejectExecSession(session, new Error("exec aborted"));
        this.sessions.delete(id);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      session.signalListener = onAbort;
    }

    this.sessions.set(id, session);

    // Create the process handle
    const proc = new ExecProcess(session, {
      sendStdin: (id, data) => this.sendStdinData(id, data),
      sendStdinEof: (id) => this.sendStdinEof(id),
      sendResize: (id, rows, cols) => this.sendPtyResize(id, rows, cols),
      cleanup: (id) => this.sessions.delete(id),
    });

    // Start the command asynchronously
    this.startExec(id, cmd, argv, options, session, stdinSetting);

    return proc;
  }

  private async startExec(
    id: number,
    cmd: string,
    argv: string[],
    options: ExecOptions,
    session: ExecSession,
    stdinSetting: ExecStdin | undefined
  ) {
    try {
      await this.start();

      const mergedEnv = mergeEnvInputs(this.defaultEnv, options.env);

      const message = {
        type: "exec" as const,
        id,
        cmd,
        argv: argv.length ? argv : undefined,
        env: mergedEnv && mergedEnv.length ? mergedEnv : undefined,
        cwd: options.cwd,
        stdin: session.stdinEnabled ? true : undefined,
        pty: options.pty ? true : undefined,
      };

      this.sendJson(message);
      this.markSessionReady(session);

      // Pipe stdin if provided (and not just `true`)
      if (session.stdinEnabled && stdinSetting !== true && stdinSetting !== undefined) {
        void this.pipeStdin(id, stdinSetting, session);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      rejectExecSession(session, error);
      this.sessions.delete(id);
    }
  }

  private ensureQemuAvailable() {
    if (this.qemuChecked) return;

    const server = this.server;
    if (!server) {
      throw new Error("sandbox server is not available");
    }

    execFileSync(server.getQemuPath(), ["--version"], { stdio: "ignore" });
    this.qemuChecked = true;
  }

  private async startInternal() {
    this.ensureQemuAvailable();

    if (this.server) {
      await this.server.start();
    }

    await this.ensureConnection();
    await this.ensureRunning();
    // If VFS is configured, also wait for mounts to be ready.
    await this.ensureVfsReady();
  }

  private async closeInternal() {
    if (this.sshAccess) {
      try {
        await this.sshAccess.close();
      } catch {
        // ignore
      }
    }
    if (this.server) {
      await this.server.close();
    }
    if (this.vfs) {
      await this.vfs.close();
    }
    await this.disconnect();
    this.vfsReadyPromise = null;
  }

  private allocateId(): number {
    for (let i = 0; i <= MAX_REQUEST_ID; i += 1) {
      const id = this.nextId;
      this.nextId = this.nextId + 1;
      if (this.nextId > MAX_REQUEST_ID) this.nextId = 1;
      if (!this.sessions.has(id)) return id;
    }
    throw new Error("no available request ids");
  }

  private async pipeStdin(id: number, input: ExecStdin, session: ExecSession) {
    if (!session.stdinEnabled) return;
    try {
      if (typeof input === "string" || Buffer.isBuffer(input)) {
        this.sendStdinData(id, input);
        this.sendStdinEof(id);
      } else if (typeof input === "boolean") {
        // no-op for `true`
      } else {
        for await (const chunk of toAsyncIterable(input)) {
          if (!this.sessions.has(id)) return;
          this.sendStdinData(id, chunk);
        }
        if (this.sessions.has(id)) {
          this.sendStdinEof(id);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      rejectExecSession(session, error);
      this.sessions.delete(id);
    }
  }

  private markSessionReady(session: ExecSession) {
    if (session.requestReady) return;
    session.requestReady = true;

    if (session.pendingResize) {
      const { rows, cols } = session.pendingResize;
      session.pendingResize = null;
      this.sendPtyResizeNow(session.id, rows, cols);
    }

    if (session.pendingStdin.length > 0) {
      const pending = session.pendingStdin;
      session.pendingStdin = [];
      for (const item of pending) {
        if (item.type === "data") {
          this.sendStdinDataNow(session.id, item.data);
        } else {
          this.sendStdinEofNow(session.id);
        }
      }
    }
  }

  private sendStdinData(id: number, data: Buffer | string) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (!session.requestReady) {
      session.pendingStdin.push({ type: "data", data });
      return;
    }
    this.sendStdinDataNow(id, data);
  }

  private sendStdinEof(id: number) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (!session.requestReady) {
      session.pendingStdin.push({ type: "eof" });
      return;
    }
    this.sendStdinEofNow(id);
  }

  private sendStdinDataNow(id: number, data: Buffer | string) {
    const payload = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    for (let offset = 0; offset < payload.length; offset += DEFAULT_STDIN_CHUNK) {
      const slice = payload.subarray(offset, offset + DEFAULT_STDIN_CHUNK);
      this.sendJson({
        type: "stdin",
        id,
        data: slice.toString("base64"),
      });
    }
  }

  private sendStdinEofNow(id: number) {
    this.sendJson({
      type: "stdin",
      id,
      eof: true,
    });
  }

  private sendPtyResize(id: number, rows: number, cols: number) {
    if (!Number.isFinite(rows) || !Number.isFinite(cols)) return;
    const session = this.sessions.get(id);
    if (!session) return;
    const safeRows = Math.max(1, Math.trunc(rows));
    const safeCols = Math.max(1, Math.trunc(cols));
    if (!session.requestReady) {
      session.pendingResize = { rows: safeRows, cols: safeCols };
      return;
    }
    this.sendPtyResizeNow(id, safeRows, safeCols);
  }

  private sendPtyResizeNow(id: number, rows: number, cols: number) {
    if (!this.connection) return;
    this.sendJson({
      type: "pty_resize",
      id,
      rows,
      cols,
    });
  }

  private async ensureConnection() {
    if (this.connection) return;
    if (this.connectPromise) return this.connectPromise;
    const server = this.server;
    if (!server) {
      throw new Error("sandbox server is not available");
    }

    this.resetConnectionState();

    this.connectPromise = (async () => {
      await server.start();
      this.connection = server.connect(
        (data, isBinary) => {
          this.handleMessage(data, isBinary);
        },
        () => {
          this.handleDisconnect(new Error("sandbox connection closed"));
        }
      );
    })().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private resetConnectionState() {
    this.state = "unknown";
    this.bootSent = false;
    this.vfsReadyPromise = null;
    this.initStatusPromise();
  }

  private initStatusPromise() {
    this.statusPromise = new Promise((resolve, reject) => {
      this.statusResolve = resolve;
      this.statusReject = reject;
    });
  }

  private ensureBoot() {
    if (this.bootSent) return;
    this.bootSent = true;
    this.state = "unknown";
    this.initStatusPromise();
    this.sendJson({
      type: "boot",
      fuseMount: this.fuseMount,
      fuseBinds: this.fuseBinds,
    });
  }

  private async ensureRunning() {
    const state = await this.waitForStatus();
    if (state === "stopped" && !this.autoStart) {
      throw new Error("sandbox is stopped");
    }

    this.ensureBoot();

    const nextState = await this.waitForStatus();
    if (nextState === "running") return;

    await this.waitForState("running");
  }

  private async ensureVfsReady() {
    if (!this.vfs) return;
    if (!this.vfsReadyPromise) {
      this.vfsReadyPromise = this.waitForVfsReadyInternal().catch((error) => {
        this.vfsReadyPromise = null;
        throw error;
      });
    }
    await this.vfsReadyPromise;
  }

  private async waitForVfsReadyInternal() {
    await this.waitForMount(this.fuseMount, "fuse.sandboxfs");
    for (const mountPoint of this.fuseBinds) {
      await this.waitForBindMount(mountPoint);
    }
  }

  private async waitForMount(mountPoint: string, fsType?: string) {
    const mountCheck = fsType
      ? `grep -q " $1 ${fsType} " /proc/mounts`
      : `grep -q " $1 " /proc/mounts`;
    const script = `for i in $(seq 1 ${VFS_READY_ATTEMPTS}); do ${mountCheck} && exit 0; sleep ${VFS_READY_SLEEP_SECONDS}; done; exit 1`;

    // Use internal exec that bypasses VFS check
    const result = await this.execInternalNoVfsWait(["sh", "-c", script, "sh", mountPoint]);
    if (result.exitCode !== 0) {
      throw new Error(
        `vfs mount ${mountPoint} not ready (exit ${result.exitCode}): ${result.stderr.trim()}`
      );
    }
  }

  private async waitForBindMount(mountPoint: string) {
    if (mountPoint === this.fuseMount) return;
    if (this.fuseMount === "/") {
      await this.waitForPath(mountPoint);
      return;
    }

    const source = `${this.fuseMount}${mountPoint}`;
    const script = `for i in $(seq 1 ${VFS_READY_ATTEMPTS}); do if grep -q " $1 " /proc/mounts; then exit 0; fi; mkdir -p "$1"; mount --bind "$2" "$1" > /dev/null 2>&1 || true; sleep ${VFS_READY_SLEEP_SECONDS}; done; exit 1`;

    const result = await this.execInternalNoVfsWait([
      "sh",
      "-c",
      script,
      "sh",
      mountPoint,
      source,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `vfs mount ${mountPoint} not ready (exit ${result.exitCode}): ${result.stderr.trim()}`
      );
    }
  }

  private async waitForPath(entryPath: string) {
    const script = `for i in $(seq 1 ${VFS_READY_ATTEMPTS}); do [ -e "$1" ] && exit 0; sleep ${VFS_READY_SLEEP_SECONDS}; done; exit 1`;
    const result = await this.execInternalNoVfsWait(["sh", "-c", script, "sh", entryPath]);
    if (result.exitCode !== 0) {
      throw new Error(
        `vfs path ${entryPath} not ready (exit ${result.exitCode}): ${result.stderr.trim()}`
      );
    }
  }

  private async execInternalNoVfsWait(command: ExecInput): Promise<ExecResult> {
    const { cmd, argv } = normalizeCommand(command, {});
    const id = this.allocateId();

    const session = createExecSession(id, {
      stdinEnabled: false,
    });

    this.sessions.set(id, session);

    const message = {
      type: "exec" as const,
      id,
      cmd,
      argv: argv.length ? argv : undefined,
    };

    try {
      this.sendJson(message);
      this.markSessionReady(session);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.sessions.delete(id);
      rejectExecSession(session, error);
    }

    return session.resultPromise;
  }

  private async waitForStatus(): Promise<SandboxState> {
    if (this.state !== "unknown") return this.state;
    if (!this.statusPromise) {
      this.initStatusPromise();
    }
    return this.statusPromise!;
  }

  private waitForState(state: SandboxState): Promise<void> {
    if (this.state === state) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.stateWaiters.push({ state, resolve, reject });
    });
  }

  private handleMessage(data: Buffer | string, isBinary: boolean) {
    if (isBinary) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const frame = decodeOutputFrame(buffer);
      const session = this.sessions.get(frame.id);
      if (!session) return;
      if (frame.stream === "stdout") {
        if (session.buffer && !session.iterating) {
          session.stdoutChunks.push(frame.data);
        }
        session.stdout.write(frame.data);
      } else {
        if (session.buffer && !session.iterating) {
          session.stderrChunks.push(frame.data);
        }
        session.stderr.write(frame.data);
      }
      return;
    }

    let message: StatusMessage | ExecResponseMessage | ErrorMessage;
    try {
      message = JSON.parse(typeof data === "string" ? data : data.toString()) as
        | StatusMessage
        | ExecResponseMessage
        | ErrorMessage;
    } catch {
      return;
    }

    if (message.type === "status") {
      this.updateState(message.state);
      return;
    }

    if (message.type === "exec_response") {
      this.handleExecResponse(message);
      return;
    }

    if (message.type === "error") {
      this.handleError(message);
    }
  }

  private updateState(state: SandboxState) {
    this.state = state;

    if (this.statusResolve) {
      this.statusResolve(state);
      this.statusResolve = null;
      this.statusReject = null;
      this.statusPromise = null;
    }

    if (this.stateWaiters.length > 0) {
      const remaining: typeof this.stateWaiters = [];
      for (const waiter of this.stateWaiters) {
        if (waiter.state === state) {
          waiter.resolve();
        } else {
          remaining.push(waiter);
        }
      }
      this.stateWaiters = remaining;
    }
  }

  private handleExecResponse(message: ExecResponseMessage) {
    const session = this.sessions.get(message.id);
    if (!session) return;
    this.sessions.delete(message.id);
    finishExecSession(session, message.exit_code ?? 1, message.signal);
  }

  private handleError(message: ErrorMessage) {
    const error = new Error(`error ${message.code}: ${message.message}`);
    if (message.id === undefined) {
      this.rejectAll(error);
      return;
    }
    const session = this.sessions.get(message.id);
    if (session) {
      this.sessions.delete(message.id);
      rejectExecSession(session, error);
    }
  }

  private rejectAll(error: Error) {
    for (const session of this.sessions.values()) {
      rejectExecSession(session, error);
    }
    this.sessions.clear();
  }

  private handleDisconnect(error?: Error) {
    this.connection = null;
    const disconnectError = error ?? new Error("sandbox connection disconnected");
    if (this.statusReject) {
      this.statusReject(disconnectError);
      this.statusReject = null;
      this.statusResolve = null;
      this.statusPromise = null;
    }
    if (this.stateWaiters.length > 0) {
      for (const waiter of this.stateWaiters) {
        waiter.reject(disconnectError);
      }
      this.stateWaiters = [];
    }
    this.rejectAll(disconnectError);
  }

  private async disconnect() {
    if (!this.connection) return;

    const connection = this.connection;
    this.connection = null;
    connection.close();
  }

  private sendJson(message: ClientMessage) {
    if (!this.connection) {
      throw new Error("sandbox connection is not available");
    }
    this.connection.send(message);
  }
}

function normalizeCommand(command: ExecInput, options: ExecOptions): {
  cmd: string;
  argv: string[];
} {
  if (Array.isArray(command)) {
    if (command.length === 0) {
      throw new Error("command array must include the executable");
    }
    return { cmd: command[0], argv: command.slice(1) };
  }

  return { cmd: command, argv: options.argv ?? [] };
}

type ResolvedVfs = {
  provider: SandboxVfsProvider | null;
  mounts: Record<string, VirtualProvider>;
};

function resolveVmVfs(
  options?: VmVfsOptions | null,
  injectedMounts?: Record<string, VirtualProvider>
): ResolvedVfs {
  if (options === null) {
    return { provider: null, mounts: {} };
  }
  const hooks = options?.hooks ?? {};
  const mounts: Record<string, VirtualProvider> = { ...(options?.mounts ?? {}) };

  if (injectedMounts) {
    for (const [mountPath, provider] of Object.entries(injectedMounts)) {
      if (!(mountPath in mounts)) {
        mounts[mountPath] = provider;
      }
    }
  }

  const mountKeys = Object.keys(mounts);
  if (mountKeys.length === 0) {
    return { provider: wrapProvider(new MemoryProvider(), hooks), mounts };
  }

  const normalized = normalizeMountMap(mounts);
  let provider: VirtualProvider;
  if (normalized.size === 1 && normalized.has("/")) {
    provider = normalized.get("/")!;
  } else {
    provider = new MountRouterProvider(normalized);
  }

  return { provider: wrapProvider(provider, hooks), mounts };
}

function wrapProvider(provider: VirtualProvider, hooks: VfsHooks) {
  if (provider instanceof SandboxVfsProvider) return provider;
  return new SandboxVfsProvider(provider, hooks);
}

function resolveFuseConfig(
  options?: VmVfsOptions | null,
  mounts?: Record<string, VirtualProvider>
) {
  const fuseMount = normalizeMountPath(options?.fuseMount ?? "/data");
  const mountPaths = listMountPaths(mounts ?? options?.mounts);
  const fuseBinds = mountPaths.filter((mountPath) => mountPath !== "/");
  return { fuseMount, fuseBinds };
}

function resolveMitmMounts(
  options?: VmVfsOptions | null,
  mitmCertDir?: string,
  netEnabled = true
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

function createMitmCaProvider(mitmCertDir?: string): VirtualProvider {
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

function isAsyncIterable(value: unknown): value is AsyncIterable<Buffer> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<Buffer>)[Symbol.asyncIterator] === "function"
  );
}

async function* toAsyncIterable(value: ExecStdin): AsyncIterable<Buffer> {
  if (typeof value === "string" || Buffer.isBuffer(value) || typeof value === "boolean") {
    return;
  }

  if (isAsyncIterable(value)) {
    for await (const chunk of value) {
      yield Buffer.from(chunk);
    }
    return;
  }

  if (value instanceof Readable) {
    for await (const chunk of value) {
      yield Buffer.from(chunk as Buffer);
    }
    return;
  }

  throw new Error("unsupported stdin type");
}

function buildShellEnv(baseEnv?: EnvInput, extraEnv?: EnvInput): string[] | undefined {
  const envMap = mergeEnvMap(baseEnv, extraEnv);
  if (envMap.size === 0) {
    const term = resolveTermValue();
    return term ? [`TERM=${term}`] : undefined;
  }

  if (!envMap.has("TERM")) {
    const term = resolveTermValue();
    if (term) envMap.set("TERM", term);
  }

  return mapToEnvArray(envMap);
}

function resolveTermValue(): string | null {
  const term = process.env.TERM;
  if (!term || term === "xterm-ghostty") {
    return "xterm-256color";
  }
  return term;
}

function mergeEnvInputs(baseEnv?: EnvInput, extraEnv?: EnvInput): string[] | undefined {
  const envMap = mergeEnvMap(baseEnv, extraEnv);
  return envMap.size > 0 ? mapToEnvArray(envMap) : undefined;
}

function mergeEnvMap(baseEnv?: EnvInput, extraEnv?: EnvInput): Map<string, string> {
  const envMap = new Map<string, string>();
  for (const [key, value] of envInputToEntries(baseEnv)) {
    envMap.set(key, value);
  }
  for (const [key, value] of envInputToEntries(extraEnv)) {
    envMap.set(key, value);
  }
  return envMap;
}

function envInputToEntries(env?: EnvInput): Array<[string, string]> {
  if (!env) return [];
  if (Array.isArray(env)) {
    return env.map(parseEnvEntry);
  }
  return Object.entries(env);
}

function parseEnvEntry(entry: string): [string, string] {
  const idx = entry.indexOf("=");
  if (idx === -1) return [entry, ""];
  return [entry.slice(0, idx), entry.slice(idx + 1)];
}

function mapToEnvArray(envMap: Map<string, string>): string[] {
  return Array.from(envMap.entries(), ([key, value]) => `${key}=${value}`);
}

/** @internal */
// Expose internal helpers for unit tests. Not part of the public API.
export const __test = {
  normalizeCommand,
  resolveVmVfs,
  resolveFuseConfig,
  resolveMitmMounts,
  createMitmCaProvider,
  buildShellEnv,
  mergeEnvInputs,
  envInputToEntries,
  parseEnvEntry,
  mapToEnvArray,
};

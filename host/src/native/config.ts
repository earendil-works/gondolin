/**
 * Native engine configuration: engine selection and the `configure` message
 * built from resolved sandbox options.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ResolvedSandboxServerOptions,
  SandboxServerOptions,
} from "../sandbox/server-options.ts";
import { defaultDebugLog, parseDebugEnv } from "../debug.ts";
import { buildTmpfsAppend } from "../sandbox/tmpfs.ts";
import { gondolinCacheDir } from "../cache.ts";
import { nativeDaemonCommand, resolveNativeBinary } from "./binary.ts";
import type { NativeConnection } from "./transport.ts";

/**
 * How to reach `gondolind` (`VMOptions.native`).
 *
 * Local by default (the daemon binary of this machine). With `command` or
 * `connect` the daemon may run elsewhere; set `remote` then, so the
 * controller sends no paths of its own machine: the image is a selector
 * resolved by the daemon, the root disk overlay is created by the daemon,
 * the MITM CA is the daemon's own, and controller-local VFS providers are
 * served through the object tier.
 */
export type NativeEngineOptions = {
  /** command that starts gondolind with the controller protocol on stdio (e.g. `["ssh", host, "gondolind"]`) */
  command?: string[];
  /** connection factory (e.g. pi-env's `openProcess`); wins over `command` */
  connect?: () => NativeConnection | Promise<NativeConnection>;
  /** the daemon runs on another machine (no shared filesystem) */
  remote?: boolean;
  /** image selector for remote daemons (`name:tag`, build id or daemon-side directory; default image when absent) */
  image?: string;
  /** local checkpoint file to boot from (remote resume; uploaded to the daemon) */
  checkpoint?: string;
};

/**
 * `VMOptions.native` merged with the environment: `GONDOLIN_NATIVE_COMMAND`
 * (JSON array, or a whitespace-separated command) and `GONDOLIN_NATIVE_REMOTE=1`.
 */
export function resolveNativeEngineOptions(
  options: NativeEngineOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NativeEngineOptions {
  const resolved: NativeEngineOptions = { ...options };
  const rawCommand = env.GONDOLIN_NATIVE_COMMAND?.trim();
  if (!resolved.command && !resolved.connect && rawCommand) {
    resolved.command = rawCommand.startsWith("[")
      ? (JSON.parse(rawCommand) as string[])
      : rawCommand.split(/\s+/);
  }
  if (resolved.remote === undefined) {
    const flag = env.GONDOLIN_NATIVE_REMOTE?.trim().toLowerCase();
    resolved.remote = flag === "1" || flag === "true";
  }
  if (resolved.image === undefined && env.GONDOLIN_NATIVE_IMAGE !== undefined) {
    resolved.image = env.GONDOLIN_NATIVE_IMAGE;
  }
  return resolved;
}

/** Host engine implementation */
export type SandboxEngine = "node" | "native";

/**
 * Engine used when neither `VMOptions.engine` nor `GONDOLIN_ENGINE` choose
 * one: `auto` is the native engine when a usable gondolind binary is
 * available, else node (`GONDOLIN_ENGINE=node` restores the old default; see
 * "Flipping the default engine" in `native/DESIGN.md`).
 */
export const DEFAULT_SANDBOX_ENGINE: SandboxEngine | "auto" = "auto";

/** `gondolind --version` results per binary (path, size, mtime) */
const usableBinaries = new Map<string, string | null>();

/**
 * Whether `binary` runs on this machine: `gondolind --version` succeeds and
 * identifies the daemon. Returns the reason otherwise. Cached per file state.
 */
export function checkNativeBinary(binary: string): string | null {
  let key = binary;
  try {
    const st = fs.statSync(binary);
    key = `${binary}\0${st.size}\0${st.mtimeMs}`;
  } catch (err) {
    return `cannot stat ${binary}: ${(err as Error).message}`;
  }
  const cached = usableBinaries.get(key);
  if (cached !== undefined) return cached;
  let problem: string | null = null;
  try {
    const [file, ...args] = nativeDaemonCommand(binary);
    const out = execFileSync(file!, [...args, "--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!out.startsWith("gondolind ")) {
      problem = `${binary} --version did not identify gondolind`;
    }
  } catch (err) {
    problem = `${binary} --version failed: ${(err as Error).message}`;
  }
  usableBinaries.set(key, problem);
  return problem;
}

/** `auto`: the native engine when a usable gondolind binary resolves, else node */
function autoEngine(env: NodeJS.ProcessEnv): SandboxEngine {
  let binary: string;
  try {
    binary = resolveNativeBinary(env);
  } catch {
    return "node";
  }
  const problem = checkNativeBinary(binary);
  if (problem) {
    if (parseDebugEnv(env.GONDOLIN_DEBUG).size > 0) {
      defaultDebugLog(
        "error",
        `engine auto: using the node engine, gondolind is unusable (${problem})`,
      );
    }
    return "node";
  }
  return "native";
}

let nodeEngineWarned = false;

/**
 * Warns once per process that the node engine was chosen explicitly
 * (deprecated; it keeps working). A `DeprecationWarning`, so
 * `--no-deprecation` silences it.
 */
export function warnNodeEngineDeprecated(): void {
  if (nodeEngineWarned) return;
  nodeEngineWarned = true;
  process.emitWarning(
    'The node engine (GONDOLIN_ENGINE=node, engine: "node", --engine node) is deprecated and will be removed; the native engine is the default. See docs/native.md.',
    { type: "DeprecationWarning", code: "GONDOLIN_NODE_ENGINE" },
  );
}

/** Resolve the engine: explicit option, else `GONDOLIN_ENGINE`, else {@link DEFAULT_SANDBOX_ENGINE} */
export function resolveSandboxEngine(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SandboxEngine {
  const raw = value ?? env.GONDOLIN_ENGINE?.trim() ?? "";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") {
    return DEFAULT_SANDBOX_ENGINE === "auto"
      ? autoEngine(env)
      : DEFAULT_SANDBOX_ENGINE;
  }
  if (normalized === "auto") return autoEngine(env);
  if (normalized === "node") {
    warnNodeEngineDeprecated();
    return "node";
  }
  if (normalized === "native") return "native";
  throw new Error(
    `invalid sandbox engine: ${raw} (expected "node", "native" or "auto")`,
  );
}

/**
 * The engine of a VM: explicit `engine`, else `native` when native options
 * name a daemon (`command`, `connect`, `remote`), else `GONDOLIN_ENGINE`.
 */
export function resolveVmEngine(
  engine: string | undefined,
  native: NativeEngineOptions,
  env: NodeJS.ProcessEnv = process.env,
): SandboxEngine {
  if (engine !== undefined) return resolveSandboxEngine(engine, env);
  if (native.connect || native.command || native.remote) return "native";
  return resolveSandboxEngine(undefined, env);
}

/** Error for options the native engine cannot honour yet */
export function nativeUnsupported(option: string): Error {
  return new Error(`not supported by the native engine yet: ${option}`);
}

/**
 * Throw for options the native engine does not implement yet. `raw` are the
 * caller's (unresolved) sandbox options, so defaults are not mistaken for
 * explicit choices.
 */
export function assertNativeSupported(
  resolved: ResolvedSandboxServerOptions,
  raw: SandboxServerOptions | undefined,
): void {
  if (resolved.vmm !== "qemu" && resolved.vmm !== "krun") {
    throw nativeUnsupported(`sandbox.vmm=${resolved.vmm}`);
  }
  const socketOptions = [
    "virtioSocketPath",
    "virtioFsSocketPath",
    "virtioSshSocketPath",
    "virtioIngressSocketPath",
  ] as const;
  for (const key of socketOptions) {
    if (raw?.[key] !== undefined) {
      throw nativeUnsupported(`sandbox.${key}`);
    }
  }
}

/** Interim subsystem modes (see `native/DESIGN.md`) */
export type NativeSubsystems = {
  /** serve the guest filesystem from the controller (`vfs_rpc`) */
  vfsController: boolean;
  /** native VFS configuration (`mode: "native"`, takes precedence) */
  vfs?: Record<string, unknown>;
  /** network socket served by the controller's node network stack */
  netSocketPath: string | null;
  /** native network configuration (`configure.net`, `mode: "native"`) */
  netNative?: Record<string, unknown> | null;
  /** relay the netdev stream to the controller's node network stack (remote) */
  netRelay?: boolean;
};

/** Remote session settings for {@link buildNativeConfigure} */
export type NativeRemoteConfig = {
  /** image selector ("" = the daemon's default image) */
  image: string;
  /** rootfs mode (`auto` = the image manifest's default, `checkpoint` = boot `checkpointPath`) */
  rootfsMode: "auto" | "cow" | "memory" | "readonly" | "checkpoint";
  /** local checkpoint file uploaded before boot (controller-side, never sent as a path) */
  checkpointPath?: string;
  /** minimum rootfs size in `bytes` */
  rootfsSizeBytes?: number;
  /** daemon-side qemu binary given explicitly by the user */
  qemuPath?: string;
  /** daemon-side krun runner given explicitly by the user */
  krunRunnerPath?: string;
};

/** Build the `configure` payload */
export function buildNativeConfigure(
  options: ResolvedSandboxServerOptions,
  internal: {
    /** qemu root disk volatility mode */
    qemuRootDiskVolatileMode?: "snapshot";
  },
  subsystems: NativeSubsystems,
  remote?: NativeRemoteConfig,
) {
  const appendExtra: string[] = [];
  if (options.tmpfs !== undefined) {
    appendExtra.push(buildTmpfsAppend(options.tmpfs));
  }
  const krun = options.vmm === "krun";
  const vm = remote
    ? {
        vmm: options.vmm,
        krun_runner_path: krun ? remote.krunRunnerPath : undefined,
        qemu_path: krun ? "" : (remote.qemuPath ?? ""),
        image: remote.image,
        kernel_path: "",
        initrd_path: "",
        root_disk: {
          path: "",
          format: "",
          mode: remote.rootfsMode,
          size: remote.rootfsSizeBytes,
        },
      }
    : {
        vmm: options.vmm,
        krun_runner_path: krun ? options.krunRunnerPath : undefined,
        qemu_path: krun ? "" : options.qemuPath,
        kernel_path: options.kernelPath,
        initrd_path: options.initrdPath,
        root_disk: options.rootDiskPath
          ? {
              path: options.rootDiskPath,
              format: options.rootDiskFormat ?? "raw",
              read_only: options.rootDiskReadOnly ?? false,
              snapshot: internal.qemuRootDiskVolatileMode === "snapshot",
            }
          : undefined,
      };
  return {
    vm: {
      ...vm,
      memory: options.memory,
      cpus: options.cpus,
      machine_type: options.machineType,
      accel: options.accel,
      cpu: options.cpu,
      console: options.console,
      append: options.append,
      append_extra: appendExtra,
      mac: options.netMac,
      auto_restart: options.autoRestart,
      idle_pause_ms: krun ? undefined : options.qemuIdlePauseMs,
    },
    limits: {
      max_stdin_bytes: options.maxStdinBytes,
      max_queued_stdin_bytes: options.maxQueuedStdinBytes,
      max_total_queued_stdin_bytes: options.maxTotalQueuedStdinBytes,
      max_queued_execs: options.maxQueuedExecs,
    },
    debug: options.debug ?? [],
    vfs:
      subsystems.vfs ??
      (subsystems.vfsController ? { mode: "controller" } : undefined),
    net: subsystems.netNative
      ? subsystems.netNative
      : subsystems.netRelay
        ? { mode: "relay" }
        : subsystems.netSocketPath
          ? { mode: "external", socket_path: subsystems.netSocketPath }
          : undefined,
  };
}

/** Directories of the controller machine a remote configure must never name */
function controllerLocalRoots(): string[] {
  return [os.tmpdir(), "/tmp", gondolinCacheDir(), os.homedir(), process.cwd()]
    .filter((dir) => dir && dir !== "/")
    .map((dir) => path.resolve(dir));
}

/**
 * Assert that a remote `configure` payload contains no paths of the
 * controller's machine: asset and disk paths must be empty (the daemon
 * resolves them), and no string may point into the controller's temp, cache,
 * home or working directory. `allowed` are daemon-side paths the user gave
 * explicitly (e.g. `sandbox.qemuPath`).
 */
export function assertRemoteConfigure(
  payload: ReturnType<typeof buildNativeConfigure>,
  allowed: ReadonlyArray<string> = [],
): void {
  const vm = payload.vm as Record<string, any>;
  for (const key of ["kernel_path", "initrd_path"]) {
    if (vm[key]) {
      throw new Error(
        `remote native session must not send a local path: vm.${key}=${vm[key]}`,
      );
    }
  }
  if (vm.root_disk?.path) {
    throw new Error(
      `remote native session must not send a local path: vm.root_disk.path=${vm.root_disk.path}`,
    );
  }
  if ((payload.net as any)?.mode === "external") {
    throw new Error(
      "remote native session cannot use an external network socket",
    );
  }
  const roots = controllerLocalRoots();
  const visit = (value: unknown, where: string) => {
    if (typeof value === "string") {
      if (!value.startsWith("/") || allowed.includes(value)) return;
      const resolved = path.resolve(value);
      for (const root of roots) {
        if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
          throw new Error(
            `remote native session must not send a controller-local path: ${where}=${value}`,
          );
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const [i, entry] of value.entries()) visit(entry, `${where}[${i}]`);
      return;
    }
    if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, where ? `${where}.${key}` : key);
      }
    }
  };
  visit(payload, "");
}

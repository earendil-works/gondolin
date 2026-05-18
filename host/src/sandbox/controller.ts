import { EventEmitter } from "events";
import child_process from "child_process";
import type { ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { randomUUID } from "crypto";

const activeChildren = new Set<ChildProcess>();
let exitHookRegistered = false;

function killActiveChildren() {
  for (const child of activeChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

function registerExitHook() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => {
    killActiveChildren();
  });
}

function trackChild(child: ChildProcess) {
  registerExitHook();
  activeChildren.add(child);
  const cleanup = () => {
    activeChildren.delete(child);
  };
  child.once("exit", cleanup);
  child.once("error", cleanup);
}

const QMP_COMMAND_TIMEOUT_MS = 2000;

type QmpCommand = "stop" | "cont" | "query-status";

type QmpErrorReason =
  | "timeout"
  | "closed"
  | "socket_error"
  | "qmp_error"
  | "invalid_response";

class QmpCommandError extends Error {
  readonly command: QmpCommand;
  readonly reason: QmpErrorReason;
  readonly commandSent: boolean;

  constructor(
    command: QmpCommand,
    reason: QmpErrorReason,
    message: string,
    commandSent: boolean,
  ) {
    super(message);
    this.name = "QmpCommandError";
    this.command = command;
    this.reason = reason;
    this.commandSent = commandSent;
  }
}

function isUnknownQmpOutcome(err: unknown) {
  return (
    err instanceof QmpCommandError &&
    err.commandSent &&
    err.reason !== "qmp_error"
  );
}

type QmpMessage = {
  QMP?: unknown;
  return?: unknown;
  error?: {
    class?: string;
    desc?: string;
  };
  event?: string;
};

function formatQmpError(command: QmpCommand, message: QmpMessage) {
  const errorClass = message.error?.class;
  const desc = message.error?.desc ?? "unknown qmp error";
  return errorClass
    ? `qmp ${command} failed (${errorClass}): ${desc}`
    : `qmp ${command} failed: ${desc}`;
}

function executeQmpCommand(
  socketPath: string,
  command: QmpCommand,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let done = false;
    let buffer = "";
    let commandSent = false;
    let stage: "greeting" | "capabilities" | "command" = "greeting";

    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let timer: NodeJS.Timeout;

    const finish = (err?: Error, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    timer = setTimeout(() => {
      finish(
        new QmpCommandError(
          command,
          "timeout",
          `qmp ${command} timed out`,
          commandSent,
        ),
      );
    }, QMP_COMMAND_TIMEOUT_MS);
    timer.unref?.();

    const send = (message: object) => {
      socket.write(`${JSON.stringify(message)}\r\n`);
    };

    const handleMessage = (message: QmpMessage) => {
      if (message.error) {
        finish(
          new QmpCommandError(
            command,
            "qmp_error",
            formatQmpError(command, message),
            commandSent,
          ),
        );
        return;
      }

      if (stage === "greeting") {
        if (!message.QMP) return;
        stage = "capabilities";
        send({ execute: "qmp_capabilities" });
        return;
      }

      if (stage === "capabilities") {
        if (!Object.hasOwn(message, "return")) return;
        stage = "command";
        commandSent = true;
        send({ execute: command });
        return;
      }

      if (Object.hasOwn(message, "return")) {
        finish(undefined, message.return);
      }
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!raw) continue;

        let message: QmpMessage;
        try {
          message = JSON.parse(raw) as QmpMessage;
        } catch {
          finish(
            new QmpCommandError(
              command,
              "invalid_response",
              `invalid qmp response for ${command}`,
              commandSent,
            ),
          );
          return;
        }

        handleMessage(message);
        if (done) return;
      }
    });

    socket.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      finish(
        new QmpCommandError(command, "socket_error", message, commandSent),
      );
    });

    socket.on("close", () => {
      finish(
        new QmpCommandError(
          command,
          "closed",
          `qmp ${command} connection closed`,
          commandSent,
        ),
      );
    });
  });
}

function defaultQmpSocketPath(config: SandboxConfig) {
  return path.join(
    path.resolve(path.dirname(config.virtioSocketPath)),
    `gondolin-qmp-${randomUUID().slice(0, 8)}.sock`,
  );
}

export type SandboxConfig = {
  /** qemu binary path */
  qemuPath: string;
  /** kernel image path */
  kernelPath: string;
  /** initrd/initramfs image path */
  initrdPath: string;

  /**
   * Root disk image path (attached as `/dev/vda`)
   *
   * If omitted, no root disk is attached.
   */
  rootDiskPath?: string;
  /** root disk image format */
  rootDiskFormat?: "raw" | "qcow2";
  /** transient root disk mode */
  rootDiskVolatileMode?: "snapshot";
  /** qemu readonly mode for the root disk */
  rootDiskReadOnly?: boolean;

  /** vm memory size (qemu syntax, e.g. "1G") */
  memory: string;
  /** vm cpu count */
  cpus: number;
  /** virtio-serial control socket path */
  virtioSocketPath: string;
  /** virtiofs/vfs socket path */
  virtioFsSocketPath: string;
  /** virtio-serial ssh socket path */
  virtioSshSocketPath: string;

  /** virtio-serial ingress socket path */
  virtioIngressSocketPath: string;
  /** kernel cmdline append string */
  append: string;
  /** qemu machine type */
  machineType?: string;
  /** qemu acceleration backend (e.g. kvm, hvf) */
  accel?: string;
  /** qemu cpu model */
  cpu?: string;
  /** guest console mode */
  console?: "stdio" | "none";
  /** qemu net socket path */
  netSocketPath?: string;
  /** guest mac address */
  netMac?: string;
  /** qemu monitor socket path */
  qmpSocketPath?: string;
  /** qemu idle pause timeout in `ms` */
  qemuIdlePauseMs?: number;
  /** whether to restart the vm automatically on exit */
  autoRestart: boolean;
};

export type SandboxState = "starting" | "running" | "stopped";

export type SandboxLogStream = "stdout" | "stderr";

export class SandboxController extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: SandboxState = "stopped";
  private restartTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private manualStop = false;
  private paused = false;
  private pauseInProgress = false;
  private qmpIdleDisabled = false;
  private qmpChain: Promise<void> = Promise.resolve();
  private qmpGeneration = 0;
  private readonly config: SandboxConfig;
  private readonly qmpSocketPath: string | null;
  private readonly idlePauseMs: number | null;

  constructor(config: SandboxConfig) {
    super();
    this.config = config;

    if (
      config.qemuIdlePauseMs !== undefined &&
      (!Number.isFinite(config.qemuIdlePauseMs) || config.qemuIdlePauseMs < 0)
    ) {
      throw new Error(
        `invalid qemu idle pause timeout: ${config.qemuIdlePauseMs}`,
      );
    }

    const idlePauseMs = Math.trunc(config.qemuIdlePauseMs ?? 0);
    this.idlePauseMs = idlePauseMs > 0 ? idlePauseMs : null;
    this.qmpSocketPath = this.idlePauseMs
      ? (config.qmpSocketPath ?? defaultQmpSocketPath(config))
      : null;
  }

  setAppend(append: string) {
    this.config.append = append;
  }

  getState() {
    return this.state;
  }

  getHostPid(): number | null {
    return this.child?.pid ?? null;
  }

  async start() {
    if (this.child) return;

    this.cancelIdlePause();
    this.qmpGeneration += 1;
    this.paused = false;
    this.pauseInProgress = false;
    this.qmpIdleDisabled = false;
    this.qmpChain = Promise.resolve();
    this.manualStop = false;
    this.setState("starting");

    this.cleanupQmpSocket();

    const args = buildQemuArgs({
      ...this.config,
      qmpSocketPath: this.qmpSocketPath ?? undefined,
    });
    this.child = child_process.spawn(this.config.qemuPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackChild(this.child);

    this.child.stdout?.on("data", (chunk) => {
      this.emit("log", chunk.toString(), "stdout" satisfies SandboxLogStream);
    });

    this.child.stderr?.on("data", (chunk) => {
      this.emit("log", chunk.toString(), "stderr" satisfies SandboxLogStream);
    });

    this.child.on("spawn", () => {
      this.setState("running");
    });

    this.child.on("error", (err) => {
      this.cancelIdlePause();
      this.qmpGeneration += 1;
      this.cleanupQmpSocket();
      this.paused = false;
      this.pauseInProgress = false;
      this.child = null;
      this.setState("stopped");
      this.emit("exit", { code: null, signal: null, error: err });
    });

    this.child.on("exit", (code, signal) => {
      this.cancelIdlePause();
      this.qmpGeneration += 1;
      this.cleanupQmpSocket();
      this.paused = false;
      this.pauseInProgress = false;
      this.child = null;
      this.setState("stopped");
      this.emit("exit", { code, signal });
      if (this.manualStop) {
        this.manualStop = false;
        return;
      }
      if (this.config.autoRestart) {
        this.scheduleRestart();
      }
    });
  }

  async close() {
    this.cancelIdlePause();
    this.qmpGeneration += 1;
    if (!this.child) {
      this.cleanupQmpSocket();
      return;
    }
    const child = this.child;
    this.child = null;
    this.manualStop = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Best-effort shutdown sequence:
    // - SIGTERM first
    // - SIGKILL after a short grace period
    // - never hang forever waiting on an "exit" event
    //
    // CI runners (notably Linux/KVM) have occasionally exhibited situations where
    // QEMU does not terminate promptly and keeps Node alive via its stdio pipes.
    // In that case we fall back to destroying the pipes + unref'ing the child so
    // the process can still exit.
    const closeTimeoutMs = 10_000;

    let exited = false;
    let exitHandler: (() => void) | null = null;
    let errorHandler: ((err: Error) => void) | null = null;

    const waitForExit = new Promise<void>((resolve) => {
      // If the process is already gone, don't wait.
      // (ChildProcess.exitCode is `number | null`; treat `undefined` as "unknown" and keep waiting.)
      const exitCode = (child as any).exitCode as number | null | undefined;
      if (typeof exitCode === "number") {
        exited = true;
        resolve();
        return;
      }

      exitHandler = () => {
        exited = true;
        resolve();
      };

      errorHandler = () => {
        exited = true;
        resolve();
      };

      child.once("exit", exitHandler);
      child.once("error", errorHandler);
    });

    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }

    const sigkillTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 3000);

    // Hard cap on waiting for the child to exit.
    let closeTimeoutTimer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        waitForExit,
        new Promise<void>((resolve) => {
          closeTimeoutTimer = setTimeout(resolve, closeTimeoutMs);
        }),
      ]);
    } finally {
      if (closeTimeoutTimer) {
        clearTimeout(closeTimeoutTimer);
      }
      clearTimeout(sigkillTimer);
    }

    // If the child is still around, do not keep the event loop alive waiting for it.
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }

      // Last resort: detach the child so it cannot keep Node alive.
      try {
        (child.stdin as any)?.destroy?.();
      } catch {
        // ignore
      }
      try {
        (child.stdout as any)?.destroy?.();
      } catch {
        // ignore
      }
      try {
        (child.stderr as any)?.destroy?.();
      } catch {
        // ignore
      }
      try {
        child.unref();
      } catch {
        // ignore
      }

      // Also SIGKILL any other tracked children (best-effort)
      killActiveChildren();

      // Remove our listeners to avoid leaks if the child exits later.
      if (exitHandler) child.off("exit", exitHandler);
      if (errorHandler) child.off("error", errorHandler);
    }

    this.cleanupQmpSocket();
    this.paused = false;
    this.pauseInProgress = false;
    this.qmpChain = Promise.resolve();
    this.setState("stopped");
  }

  resumeForActivity(): Promise<void> | void {
    if (!this.qmpSocketPath) return;
    this.cancelIdlePause();
    if (!this.paused && !this.pauseInProgress) return;
    return this.resumeForActivityAsync(this.qmpGeneration, this.child);
  }

  private async resumeForActivityAsync(
    generation: number,
    child: ChildProcess | null,
  ): Promise<void> {
    try {
      await this.runQmpCommand("cont");
    } catch (err) {
      if (!this.isCurrentQmpGeneration(generation, child)) return;
      const running = await this.queryQmpRunning(generation, child);
      if (!this.isCurrentQmpGeneration(generation, child)) return;
      if (running !== true) throw err;
    }

    if (!this.isCurrentQmpGeneration(generation, child)) return;
    this.paused = false;
    this.pauseInProgress = false;
  }

  scheduleIdlePause() {
    if (
      !this.qmpSocketPath ||
      this.qmpIdleDisabled ||
      !this.child ||
      this.state !== "running" ||
      this.paused ||
      this.pauseInProgress
    ) {
      return;
    }

    this.cancelIdlePause();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.pauseForIdle();
    }, this.idlePauseMs!);
    this.idleTimer.unref?.();
  }

  cancelIdlePause() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async pauseForIdle() {
    if (
      !this.qmpSocketPath ||
      this.qmpIdleDisabled ||
      !this.child ||
      this.state !== "running" ||
      this.paused ||
      this.pauseInProgress
    ) {
      return;
    }

    const generation = this.qmpGeneration;
    const child = this.child;

    this.pauseInProgress = true;
    try {
      await this.runQmpCommand("stop");
      if (!this.isCurrentQmpGeneration(generation, child)) return;
      if (this.child && this.state === "running") {
        this.paused = true;
      }
    } catch (err) {
      if (!this.isCurrentQmpGeneration(generation, child)) return;
      const mayBePaused = isUnknownQmpOutcome(err);
      this.qmpIdleDisabled = true;
      if (mayBePaused && this.child && this.state === "running") {
        this.paused = true;
        try {
          const resume = this.resumeForActivity();
          if (resume) await resume;
        } catch {
          // Keep paused=true so later activity keeps retrying QMP cont.
        }
      }

      const message = err instanceof Error ? err.message : String(err);
      this.emit(
        "log",
        `qmp idle pause disabled: ${message}\n`,
        "stderr" satisfies SandboxLogStream,
      );
    } finally {
      if (this.isCurrentQmpGeneration(generation, child)) {
        this.pauseInProgress = false;
      }
    }
  }

  private isCurrentQmpGeneration(
    generation: number,
    child: ChildProcess | null,
  ) {
    return this.qmpGeneration === generation && this.child === child;
  }

  private async queryQmpRunning(
    generation: number,
    child: ChildProcess | null,
  ): Promise<boolean | null> {
    try {
      const result = await this.runQmpCommand("query-status");
      if (!this.isCurrentQmpGeneration(generation, child)) return null;
      if (result && typeof result === "object") {
        const status = result as { running?: unknown; status?: unknown };
        if (typeof status.running === "boolean") return status.running;
        if (status.status === "running") return true;
        if (status.status === "paused") return false;
      }
    } catch {
      // ignore query-status failures; callers decide how to handle unknown state
    }
    return null;
  }

  private async runQmpCommand(command: QmpCommand): Promise<unknown> {
    if (!this.qmpSocketPath) return;

    const run = this.qmpChain
      .catch(() => {
        // keep the command chain alive after a failed command
      })
      .then(() => executeQmpCommand(this.qmpSocketPath!, command));
    this.qmpChain = run.then(
      () => {
        // keep the command chain alive after a completed command
      },
      () => {
        // keep the command chain alive after a failed command
      },
    );
    return await run;
  }

  private cleanupQmpSocket() {
    if (!this.qmpSocketPath) return;
    try {
      fs.rmSync(this.qmpSocketPath, { force: true });
    } catch {
      // ignore
    }
  }

  async restart() {
    await this.close();
    await this.start();
  }

  private scheduleRestart() {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, 1000);
  }

  private setState(state: SandboxState) {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }
}

function buildQemuArgs(config: SandboxConfig) {
  const args: string[] = [
    "-nodefaults",
    "-no-reboot",
    "-m",
    config.memory,
    "-smp",
    String(config.cpus),
    "-kernel",
    config.kernelPath,
    "-initrd",
    config.initrdPath,
    "-append",
    config.append,
    "-nographic",
  ];

  const targetArch = detectTargetArch(config);
  const accel = config.accel ?? selectAccel(targetArch);
  const machineType =
    config.machineType ?? selectMachineType(targetArch, accel);

  if (config.rootDiskPath) {
    const format = config.rootDiskFormat ?? "raw";
    const snapshot = config.rootDiskVolatileMode === "snapshot";
    const readOnly = config.rootDiskReadOnly ?? false;

    args.push(
      "-drive",
      `file=${config.rootDiskPath},format=${format},if=none,id=drive0${snapshot ? ",snapshot=on" : ""}${readOnly ? ",readonly=on" : ""}`,
    );
    // microvm has no PCI bus; use virtio-blk-device (MMIO) instead
    const blkDevice =
      machineType === "microvm" ? "virtio-blk-device" : "virtio-blk-pci";
    args.push("-device", `${blkDevice},drive=drive0`);
  }
  if (machineType === "microvm") {
    // microvm has no PCI bus and uses virtio-mmio devices.
    //
    // On x86_64, virtio-mmio devices are typically discovered via kernel cmdline
    // (virtio_mmio.device=...) unless ACPI tables are provided.
    // QEMU's microvm machine can auto-generate those cmdline entries.
    //
    // Ensure this is enabled explicitly as older QEMU versions may default it off.
    // Also keep ISA serial enabled so the kernel console can use ttyS0.
    args.push("-machine", "microvm,isa-serial=on,auto-kernel-cmdline=on");
  } else {
    args.push("-machine", machineType);
  }

  if (accel) args.push("-accel", accel);

  // Keep CPU selection consistent with the selected accelerator.
  // In particular, "-cpu host" generally requires hardware acceleration.
  const cpu = config.cpu ?? selectCpu(targetArch, accel);
  if (cpu) args.push("-cpu", cpu);

  if (config.console === "none") {
    // Keep the serial device (needed for e.g. microvm ttyS0 console) but
    // discard output.
    args.push("-serial", "null");
  } else {
    args.push("-serial", "stdio");
  }

  // microvm has no PCI bus; use virtio-*-device (MMIO) variants
  const useMmio = machineType === "microvm";
  const rngDev = useMmio ? "virtio-rng-device" : "virtio-rng-pci";
  const serialDev = useMmio ? "virtio-serial-device" : "virtio-serial-pci";
  const netDev = useMmio ? "virtio-net-device" : "virtio-net-pci";

  args.push("-object", "rng-random,filename=/dev/urandom,id=rng0");
  args.push("-device", `${rngDev},rng=rng0`);
  args.push(
    "-chardev",
    `socket,id=virtiocon0,path=${config.virtioSocketPath},server=off`,
  );
  args.push(
    "-chardev",
    `socket,id=virtiofs0,path=${config.virtioFsSocketPath},server=off`,
  );
  args.push(
    "-chardev",
    `socket,id=virtiossh0,path=${config.virtioSshSocketPath},server=off`,
  );
  args.push(
    "-chardev",
    `socket,id=virtioingress0,path=${config.virtioIngressSocketPath},server=off`,
  );

  args.push("-device", `${serialDev},id=virtio-serial0`);
  args.push(
    "-device",
    "virtserialport,chardev=virtiocon0,name=virtio-port,bus=virtio-serial0.0",
  );
  args.push(
    "-device",
    "virtserialport,chardev=virtiofs0,name=virtio-fs,bus=virtio-serial0.0",
  );
  args.push(
    "-device",
    "virtserialport,chardev=virtiossh0,name=virtio-ssh,bus=virtio-serial0.0",
  );
  args.push(
    "-device",
    "virtserialport,chardev=virtioingress0,name=virtio-ingress,bus=virtio-serial0.0",
  );

  if (config.netSocketPath) {
    args.push(
      "-netdev",
      `stream,id=net0,server=off,addr.type=unix,addr.path=${config.netSocketPath}`,
    );
    const mac = config.netMac ?? "02:00:00:00:00:01";
    args.push("-device", `${netDev},netdev=net0,mac=${mac}`);
  }

  if (config.qmpSocketPath) {
    args.push("-qmp", `unix:${config.qmpSocketPath},server=on,wait=off`);
  }

  return args;
}

function detectTargetArch(config: SandboxConfig): string {
  const qemuPath = config.qemuPath.toLowerCase();
  if (qemuPath.includes("aarch64") || qemuPath.includes("arm64")) {
    return "arm64";
  }
  if (qemuPath.includes("x86_64") || qemuPath.includes("x64")) {
    return "x64";
  }
  return process.arch;
}

function selectMachineType(targetArch: string, accel?: string) {
  if (process.platform === "linux" && targetArch === "x64") {
    // `microvm` is optimized for Linux/KVM but can hang under pure TCG.
    // Fall back to q35 when hardware acceleration is unavailable.
    const accelName = (accel ?? "").split(",", 1)[0]!.trim().toLowerCase();
    return accelName === "kvm" ? "microvm" : "q35";
  }
  if (targetArch === "arm64") {
    return "virt";
  }
  return "q35";
}

function getHostArch(): "arm64" | "x64" {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function selectAccel(targetArch: string) {
  const hostArch = getHostArch();

  // Cross-arch emulation cannot use hardware acceleration.
  if (targetArch !== hostArch) {
    return "tcg";
  }

  if (process.platform === "linux") {
    // Check if KVM is actually available (e.g., not in CI without nested virt)
    try {
      fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
      return "kvm";
    } catch {
      return "tcg";
    }
  }

  if (process.platform === "darwin") return "hvf";
  return "tcg";
}

function selectCpu(targetArch: string, accel?: string) {
  const hostArch = getHostArch();

  // "-cpu host" only makes sense when running the same arch with hardware accel.
  if (targetArch !== hostArch) {
    return "max";
  }

  const accelName = (accel ?? "").split(",", 1)[0]!.trim().toLowerCase();

  // Be conservative: "host" generally requires hardware acceleration.
  if (process.platform === "linux") {
    return accelName === "kvm" ? "host" : "max";
  }

  if (process.platform === "darwin") {
    return accelName === "hvf" ? "host" : "max";
  }

  return "max";
}

/** @internal */
// Expose internal helpers for unit tests. Not part of the public API.
export const __test = {
  buildQemuArgs,
  detectTargetArch,
  selectMachineType,
  selectAccel,
  selectCpu,
  killActiveChildren,
  getActiveChildrenCount: () => activeChildren.size,
};

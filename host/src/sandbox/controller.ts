import { EventEmitter } from "events";
import child_process from "child_process";
import type { ChildProcess } from "child_process";
import fs from "fs";

import {
  normalizeLocalEndpoint,
  type LocalEndpoint,
  type LocalEndpointInput,
} from "../local-endpoint.ts";

const activeChildren = new Set<ChildProcess>();
const accelSupportCache = new Map<string, Set<string>>();
const accelRuntimeProbeCache = new Map<string, boolean>();
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
  /** virtio-serial control endpoint */
  virtioSocketPath: LocalEndpointInput;
  /** virtiofs/vfs endpoint */
  virtioFsSocketPath: LocalEndpointInput;
  /** virtio-serial ssh endpoint */
  virtioSshSocketPath: LocalEndpointInput;

  /** virtio-serial ingress endpoint */
  virtioIngressSocketPath: LocalEndpointInput;
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
  /** qemu net backend endpoint */
  netSocketPath?: LocalEndpointInput;
  /** guest mac address */
  netMac?: string;
  /** whether to restart the vm automatically on exit */
  autoRestart: boolean;
};

export type SandboxState = "starting" | "running" | "stopped";

export type SandboxLogStream = "stdout" | "stderr";

export class SandboxController extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: SandboxState = "stopped";
  private restartTimer: NodeJS.Timeout | null = null;
  private manualStop = false;
  private readonly config: SandboxConfig;

  constructor(config: SandboxConfig) {
    super();
    this.config = config;
  }

  setAppend(append: string) {
    this.config.append = append;
  }

  getState() {
    return this.state;
  }

  async start() {
    if (this.child) return;

    this.manualStop = false;
    this.setState("starting");

    const args = buildQemuArgs(this.config);
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
      this.child = null;
      this.setState("stopped");
      this.emit("exit", { code: null, signal: null, error: err });
    });

    this.child.on("exit", (code, signal) => {
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
    if (!this.child) return;
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

    this.setState("stopped");
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
  const virtioEndpoint = normalizeLocalEndpoint(
    config.virtioSocketPath,
    "sandbox.virtioSocketPath",
  );
  const virtioFsEndpoint = normalizeLocalEndpoint(
    config.virtioFsSocketPath,
    "sandbox.virtioFsSocketPath",
  );
  const virtioSshEndpoint = normalizeLocalEndpoint(
    config.virtioSshSocketPath,
    "sandbox.virtioSshSocketPath",
  );
  const virtioIngressEndpoint = normalizeLocalEndpoint(
    config.virtioIngressSocketPath,
    "sandbox.virtioIngressSocketPath",
  );
  const netEndpoint = config.netSocketPath
    ? normalizeLocalEndpoint(config.netSocketPath, "sandbox.netSocketPath")
    : null;

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
  const accel = config.accel ?? selectAccel(targetArch, config.qemuPath);
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

  const rngObject = selectRngObject();
  if (rngObject) {
    args.push("-object", rngObject);
    args.push("-device", `${rngDev},rng=rng0`);
  }
  args.push("-chardev", buildQemuSocketChardevArg("virtiocon0", virtioEndpoint));
  args.push("-chardev", buildQemuSocketChardevArg("virtiofs0", virtioFsEndpoint));
  args.push("-chardev", buildQemuSocketChardevArg("virtiossh0", virtioSshEndpoint));
  args.push(
    "-chardev",
    buildQemuSocketChardevArg("virtioingress0", virtioIngressEndpoint),
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

  if (netEndpoint) {
    args.push("-netdev", buildQemuStreamNetdevArg("net0", netEndpoint));
    const mac = config.netMac ?? "02:00:00:00:00:01";
    args.push("-device", `${netDev},netdev=net0,mac=${mac}`);
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

function buildQemuSocketChardevArg(id: string, endpoint: LocalEndpoint) {
  return endpoint.transport === "unix"
    ? `socket,id=${id},path=${endpoint.path},server=off`
    : `socket,id=${id},host=${endpoint.host},port=${endpoint.port},server=off`;
}

function buildQemuStreamNetdevArg(id: string, endpoint: LocalEndpoint) {
  return endpoint.transport === "unix"
    ? `stream,id=${id},server=off,addr.type=unix,addr.path=${endpoint.path}`
    : `stream,id=${id},server=off,addr.type=inet,addr.host=${endpoint.host},addr.port=${endpoint.port}`;
}

function selectRngObject() {
  if (process.platform === "win32") {
    return null;
  }
  return "rng-random,filename=/dev/urandom,id=rng0";
}

function getHostArch(): "arm64" | "x64" {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function readSupportedAccels(qemuPath: string): Set<string> | null {
  const cached = accelSupportCache.get(qemuPath);
  if (cached) {
    return cached;
  }

  try {
    const result = child_process.spawnSync(qemuPath, ["-accel", "help"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) {
      return null;
    }

    const supported = new Set(
      `${result.stdout ?? ""}`
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line.length > 0 && !line.includes("accelerators supported")),
    );
    accelSupportCache.set(qemuPath, supported);
    return supported;
  } catch {
    return null;
  }
}

function qemuSupportsAccel(qemuPath: string, accel: string) {
  const supported = readSupportedAccels(qemuPath);
  return supported?.has(accel.toLowerCase()) ?? false;
}

function qemuCanInitializeAccel(qemuPath: string, accel: string) {
  const cacheKey = `${qemuPath}\0${accel.toLowerCase()}`;
  const cached = accelRuntimeProbeCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const result = child_process.spawnSync(
      qemuPath,
      [
        "-accel",
        accel,
        "-machine",
        "none",
        "-nodefaults",
        "-display",
        "none",
        "-S",
      ],
      {
        timeout: 1500,
        windowsHide: true,
        encoding: "utf8",
      },
    );
    const available =
      (result.error as NodeJS.ErrnoException | undefined)?.code ===
        "ETIMEDOUT" || result.status === 0;
    accelRuntimeProbeCache.set(cacheKey, available);
    return available;
  } catch {
    accelRuntimeProbeCache.set(cacheKey, false);
    return false;
  }
}

export function selectAccel(targetArch: string, qemuPath?: string) {
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
  if (process.platform === "win32") {
    if (targetArch !== "x64") return "tcg";
    if (!qemuPath) return "whpx";
    if (!qemuSupportsAccel(qemuPath, "whpx")) {
      return "tcg";
    }
    return qemuCanInitializeAccel(qemuPath, "whpx") ? "whpx" : "tcg";
  }
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

  if (process.platform === "win32") {
    if (targetArch === "x64" && accelName === "whpx") {
      // WHPX is more stable with a conservative named CPU model than with
      // broad synthetic models like `max` on current QEMU/Windows builds.
      return "qemu64";
    }
    return "max";
  }

  return "max";
}

/** @internal */
// Expose internal helpers for unit tests. Not part of the public API.
export const __test = {
  buildQemuArgs,
  buildQemuSocketChardevArg,
  buildQemuStreamNetdevArg,
  detectTargetArch,
  selectMachineType,
  selectAccel,
  selectCpu,
  selectRngObject,
  qemuSupportsAccel,
  qemuCanInitializeAccel,
  killActiveChildren,
  getActiveChildrenCount: () => activeChildren.size,
};

import { EventEmitter } from "events";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";

const activeChildren = new Set<ChildProcess>();
let exitHookRegistered = false;

function registerExitHook() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => {
    for (const child of activeChildren) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
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
  qemuPath: string;
  kernelPath: string;
  initrdPath: string;
  rootfsPath?: string;
  memory: string;
  cpus: number;
  virtioSocketPath: string;
  virtioFsSocketPath: string;
  append: string;
  machineType?: string;
  accel?: string;
  cpu?: string;
  console?: "stdio" | "none";
  netSocketPath?: string;
  netMac?: string;
  autoRestart: boolean;
};

export type SandboxState = "starting" | "running" | "stopped";

export class SandboxController extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: SandboxState = "stopped";
  private restartTimer: NodeJS.Timeout | null = null;
  private manualStop = false;

  constructor(private readonly config: SandboxConfig) {
    super();
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
    this.child = spawn(this.config.qemuPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackChild(this.child);

    this.child.stdout?.on("data", (chunk) => {
      this.emit("log", chunk.toString());
    });

    this.child.stderr?.on("data", (chunk) => {
      this.emit("log", chunk.toString());
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

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

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
  const machineType = config.machineType ?? selectMachineType(targetArch);

  if (config.rootfsPath) {
    args.push(
      "-drive",
      `file=${config.rootfsPath},format=raw,if=none,id=drive0,snapshot=on`
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

  const accel = config.accel ?? selectAccel(targetArch);
  if (accel) args.push("-accel", accel);

  const cpu = config.cpu ?? selectCpu(targetArch);
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
    `socket,id=virtiocon0,path=${config.virtioSocketPath},server=off`
  );
  args.push(
    "-chardev",
    `socket,id=virtiofs0,path=${config.virtioFsSocketPath},server=off`
  );

  args.push("-device", `${serialDev},id=virtio-serial0`);
  args.push(
    "-device",
    "virtserialport,chardev=virtiocon0,name=virtio-port,bus=virtio-serial0.0"
  );
  args.push(
    "-device",
    "virtserialport,chardev=virtiofs0,name=virtio-fs,bus=virtio-serial0.0"
  );

  if (config.netSocketPath) {
    args.push(
      "-netdev",
      `stream,id=net0,server=off,addr.type=unix,addr.path=${config.netSocketPath}`
    );
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

function selectMachineType(targetArch: string) {
  if (process.platform === "linux" && targetArch === "x64") {
    return "microvm";
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

function selectCpu(targetArch: string) {
  const hostArch = getHostArch();

  // "-cpu host" only makes sense when using hardware accel for the same arch.
  if (targetArch !== hostArch) {
    return "max";
  }

  if (process.platform === "linux" || process.platform === "darwin") {
    return "host";
  }
  return "max";
}

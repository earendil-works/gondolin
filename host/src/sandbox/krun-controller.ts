import { EventEmitter } from "node:events";
import child_process from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  forwardChildLogs,
  terminateChild,
  trackChild,
} from "./child-process.ts";
import type { SandboxState } from "./controller.ts";

function resolveExecutableForInspection(executable: string): string {
  if (path.isAbsolute(executable) || executable.includes(path.sep)) {
    return executable;
  }

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next PATH entry
    }
  }

  return executable;
}

function hasMacHypervisorEntitlement(executable: string): boolean {
  const inspectPath = resolveExecutableForInspection(executable);
  try {
    const entitlements = child_process.execFileSync(
      "/usr/bin/codesign",
      ["-d", "--entitlements", ":-", inspectPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return entitlements.includes("com.apple.security.hypervisor");
  } catch {
    return false;
  }
}

export function assertMacHypervisorEntitlement(executable: string) {
  if (process.platform !== "darwin") return;
  if (hasMacHypervisorEntitlement(executable)) return;

  const inspectPath = resolveExecutableForInspection(executable);
  throw new Error(
    "krun runner is not signed with the macOS Hypervisor entitlement " +
      `(com.apple.security.hypervisor): ${inspectPath}\n` +
      "Fix: rebuild the local runner with `make krun-runner` or set " +
      "GONDOLIN_KRUN_RUNNER to a signed runner binary.",
  );
}

export type KrunConfig = {
  /** krun runner binary path */
  krunRunnerPath: string;
  /** kernel image path */
  kernelPath: string;
  /** initrd/initramfs image path */
  initrdPath: string;

  /** root disk image path */
  rootDiskPath?: string;
  /** root disk image format */
  rootDiskFormat?: "raw" | "qcow2";
  /** readonly mode for the root disk */
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
  /** guest console mode */
  console?: "stdio" | "none";
  /** qemu net socket path */
  netSocketPath?: string;
  /** guest mac address */
  netMac?: string;
  /** whether to restart the vm automatically on exit */
  autoRestart: boolean;
};

type KrunRunnerConfig = {
  kernelPath: string;
  initrdPath: string;
  rootDiskPath?: string;
  rootDiskFormat?: "raw" | "qcow2";
  rootDiskReadOnly: boolean;
  memoryMiB: number;
  cpus: number;
  virtioSocketPath: string;
  virtioFsSocketPath: string;
  virtioSshSocketPath: string;
  virtioIngressSocketPath: string;
  append: string;
  console: "stdio" | "none";
  netSocketPath?: string;
  netMac?: string;
};

export class KrunController extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: SandboxState = "stopped";
  private restartTimer: NodeJS.Timeout | null = null;
  private manualStop = false;
  private readonly config: KrunConfig;
  private activeConfigPath: string | null = null;

  constructor(config: KrunConfig) {
    super();
    this.config = config;
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

    this.manualStop = false;
    this.setState("starting");

    try {
      assertMacHypervisorEntitlement(this.config.krunRunnerPath);
      const runnerConfig = buildRunnerConfig(this.config);
      const configPath = writeRunnerConfig(runnerConfig);
      this.activeConfigPath = configPath;

      this.child = child_process.spawn(
        this.config.krunRunnerPath,
        ["--config", configPath],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      trackChild(this.child);
      forwardChildLogs(this, this.child);

      this.child.on("spawn", () => {
        this.setState("running");
      });

      this.child.on("error", (err) => {
        this.cleanupActiveConfig();
        this.child = null;
        this.setState("stopped");
        this.emit("exit", { code: null, signal: null, error: err });
      });

      this.child.on("exit", (code, signal) => {
        this.cleanupActiveConfig();
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
    } catch (err) {
      this.cleanupActiveConfig();
      this.child = null;
      this.setState("stopped");
      throw err;
    }
  }

  async close() {
    if (!this.child) {
      this.cleanupActiveConfig();
      return;
    }
    const child = this.child;
    this.child = null;
    this.manualStop = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    await terminateChild(child);

    this.cleanupActiveConfig();
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

  private cleanupActiveConfig() {
    if (!this.activeConfigPath) return;
    try {
      fs.rmSync(this.activeConfigPath, { force: true });
    } catch {
      // ignore
    }
    this.activeConfigPath = null;
  }
}

function parseMemoryToMiB(value: string): number {
  const trimmed = value.trim();
  const match = /^(\d+)([kKmMgGtT]?)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `invalid vm memory value for krun backend: ${JSON.stringify(value)}`,
    );
  }

  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toUpperCase();

  let bytes = amount;
  if (unit === "K") bytes *= 1024;
  else if (unit === "M" || unit === "") bytes *= 1024 * 1024;
  else if (unit === "G") bytes *= 1024 * 1024 * 1024;
  else if (unit === "T") bytes *= 1024 * 1024 * 1024 * 1024;

  const mib = Math.max(1, Math.ceil(bytes / (1024 * 1024)));
  if (!Number.isSafeInteger(mib) || mib > 0xffffffff) {
    throw new Error(`vm memory is too large for krun backend: ${value}`);
  }

  return mib;
}

function buildRunnerConfig(config: KrunConfig): KrunRunnerConfig {
  if (config.cpus < 1 || config.cpus > 255 || !Number.isInteger(config.cpus)) {
    throw new Error(`invalid vm cpu count for krun backend: ${config.cpus}`);
  }

  return {
    kernelPath: config.kernelPath,
    initrdPath: config.initrdPath,
    rootDiskPath: config.rootDiskPath,
    rootDiskFormat: config.rootDiskFormat,
    rootDiskReadOnly: config.rootDiskReadOnly ?? false,
    memoryMiB: parseMemoryToMiB(config.memory),
    cpus: config.cpus,
    virtioSocketPath: config.virtioSocketPath,
    virtioFsSocketPath: config.virtioFsSocketPath,
    virtioSshSocketPath: config.virtioSshSocketPath,
    virtioIngressSocketPath: config.virtioIngressSocketPath,
    append: config.append,
    console: config.console ?? "none",
    netSocketPath: config.netSocketPath,
    netMac: config.netMac,
  };
}

function writeRunnerConfig(config: KrunRunnerConfig): string {
  const configPath = path.resolve(
    os.tmpdir(),
    `gondolin-krun-runner-${randomUUID().slice(0, 8)}.json`,
  );
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
  return configPath;
}

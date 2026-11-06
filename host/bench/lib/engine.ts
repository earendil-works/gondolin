import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

import { VM, type VMOptions } from "../../src/index.ts";
import { nsToMs, processTree, readProcess } from "./harness.ts";

export type EngineName = "node" | "native";

export function resolveEngine(flag: string | undefined): EngineName {
  const value = flag ?? process.env.GONDOLIN_ENGINE ?? "node";
  if (value !== "node" && value !== "native") {
    throw new Error(`unknown engine '${value}' (expected node or native)`);
  }
  return value;
}

let currentEngine: EngineName = "node";

export function setEngine(engine: EngineName) {
  currentEngine = engine;
}

export function getEngine(): EngineName {
  return currentEngine;
}

/**
 * Create a VM for the selected engine. `engine` is only passed when it is not
 * `node` so the harness keeps working on versions without `VMOptions.engine`.
 */
export async function createVm(options: VMOptions = {}): Promise<VM> {
  const opts: VMOptions & { engine?: EngineName } = {
    ...options,
    sandbox: { console: "none", ...options.sandbox },
  };
  if (currentEngine === "node") return VM.create(opts);
  opts.engine = currentEngine;
  const vm = await VM.create(opts);
  await assertNativeEngine(vm);
  return vm;
}

/**
 * Guard against silently benchmarking the node engine when `engine` is not
 * supported yet: the VM's host pid must be a `gondolind` process.
 */
async function assertNativeEngine(vm: VM) {
  if (process.env.GONDOLIN_BENCH_SKIP_ENGINE_CHECK === "1") return;
  try {
    await vm.start();
    const pid = vm.getHostPid();
    const info = pid ? await readProcess(pid) : null;
    if (!info?.comm.includes("gondolind")) {
      throw new Error(
        `engine=native but VM host pid ${pid} is '${info?.comm ?? "?"}', not gondolind (set GONDOLIN_BENCH_SKIP_ENGINE_CHECK=1 to bypass)`,
      );
    }
  } catch (err) {
    await vm.close().catch(() => {});
    throw err;
  }
}

/**
 * Engine-side processes of a VM for resource accounting.
 *
 * `VM.getHostPid()` is the VMM (QEMU) pid on the node engine and the
 * `gondolind` pid on the native engine; descendants (e.g. QEMU under the
 * daemon) are included. A `getEnginePids()` method on the VM, if present,
 * wins so engines can report exactly what they own.
 */
export async function enginePids(vm: VM): Promise<number[]> {
  const custom = (vm as unknown as { getEnginePids?: () => number[] })
    .getEnginePids;
  if (typeof custom === "function") return custom.call(vm);
  const pid = vm.getHostPid();
  if (!pid || pid === process.pid) return [];
  return processTree(pid);
}

/** Run a shell command in the guest and fail on a non-zero exit */
export async function sh(
  vm: VM,
  command: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await vm.exec(["/bin/sh", "-c", command], { signal });
  if (result.exitCode !== 0) {
    throw new Error(
      `guest command failed (${result.exitCode}): ${command.slice(0, 120)}: ${result.stderr.trim().slice(0, 400)}`,
    );
  }
  return result.stdout;
}

const GUEST_TOOLS = ["fsbench.py", "netclient.py", "timeit.py"];

/** Copy the guest-side helper scripts to `/tmp/bench/` */
export async function installGuestTools(vm: VM) {
  await sh(vm, "mkdir -p /tmp/bench");
  for (const name of GUEST_TOOLS) {
    const content = fs.readFileSync(
      new URL(`../guest/${name}`, import.meta.url),
      "utf8",
    );
    await vm.fs.writeFile(`/tmp/bench/${name}`, content);
  }
}

/** Time a guest shell snippet inside the guest (needs `installGuestTools`); returns `ms` */
export async function guestTime(
  vm: VM,
  command: string,
  signal?: AbortSignal,
): Promise<number> {
  const result = await vm.exec(
    ["/usr/bin/python3", "/tmp/bench/timeit.py", command],
    { signal },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `guest command failed (${result.exitCode}): ${command.slice(0, 120)}: ${result.stderr.trim().slice(0, 400)}`,
    );
  }
  return nsToMs(result.stdout);
}

/**
 * Remove a guest directory tree. Uses `shutil.rmtree` because busybox
 * `rm -rf` leaves entries behind on sandboxfs mounts with many entries.
 */
export async function guestRmTree(vm: VM, dir: string) {
  await sh(
    vm,
    `python3 -c 'import shutil, sys; shutil.rmtree(sys.argv[1], ignore_errors=True)' ${dir}`,
  );
}

function tryRun(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function machineInfo() {
  const qemu =
    os.arch() === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
  return {
    hostname: os.hostname(),
    platform: process.platform,
    osRelease: os.release(),
    osVersion: os.version(),
    productVersion:
      process.platform === "darwin"
        ? tryRun("sw_vers", ["-productVersion"])
        : null,
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    loadAvg: os.loadavg().map((v) => Math.round(v * 100) / 100),
    totalMemGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    qemu: tryRun(qemu, ["--version"])?.split("\n")[0] ?? null,
    gitCommit: tryRun("git", ["rev-parse", "--short", "HEAD"]),
    gitDirty:
      (tryRun("git", ["status", "--porcelain", "--untracked-files=no"]) ??
        "") !== "",
    image: process.env.GONDOLIN_DEFAULT_IMAGE ?? "alpine-base:latest",
  };
}

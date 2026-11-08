import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

import { VM, type VMOptions } from "../../src/index.ts";
import { nsToMs, processTree, readProcess } from "./harness.ts";

/**
 * Engine variant under test (all run the native engine). `native-virtiofs` is the native engine with
 * `GONDOLIN_VIRTIOFS=1` and a vhost-user capable QEMU first on `PATH`
 * (`GONDOLIN_BENCH_VIRTIOFS_QEMU_DIR`, default `/tmp/qemu-vu/qemu-10.2.1/build`).
 * `native-prev*` run the binary in `GONDOLIN_BENCH_PREV_BIN` (an earlier
 * build) instead of `GONDOLIN_NATIVE_BIN`, to compare builds side by side.
 */
export type EngineName =
  | "native"
  | "native-virtiofs"
  | "native-prev"
  | "native-prev-virtiofs";

const ENGINE_NAMES: EngineName[] = [
  "native",
  "native-virtiofs",
  "native-prev",
  "native-prev-virtiofs",
];

/** Whether an engine variant serves the VFS over virtio-fs */
export function isVirtiofsEngine(engine: EngineName): boolean {
  return engine.endsWith("-virtiofs");
}

/**
 * Engine variant from `--engine` (or one `--interleave` entry), else
 * `native` (`auto` is accepted as an alias, like in the SDK).
 */
export function resolveEngine(flag: string | undefined): EngineName {
  const raw = (flag ?? "").trim();
  const value = raw === "" || raw === "auto" ? "native" : raw;
  if (!ENGINE_NAMES.includes(value as EngineName)) {
    throw new Error(
      `unknown engine '${value}' (expected auto, ${ENGINE_NAMES.join(", ")})`,
    );
  }
  return value as EngineName;
}

let currentEngine: EngineName = "native";
const baseEnv = {
  PATH: process.env.PATH,
  GONDOLIN_VIRTIOFS: process.env.GONDOLIN_VIRTIOFS,
  GONDOLIN_NATIVE_BIN: process.env.GONDOLIN_NATIVE_BIN,
};

export function virtiofsQemuDir(): string {
  return (
    process.env.GONDOLIN_BENCH_VIRTIOFS_QEMU_DIR ??
    "/tmp/qemu-vu/qemu-10.2.1/build"
  );
}

function restoreEnv(name: keyof typeof baseEnv) {
  if (baseEnv[name] === undefined) delete process.env[name];
  else process.env[name] = baseEnv[name];
}

export function setEngine(engine: EngineName) {
  currentEngine = engine;
  // The daemon inherits the environment when a VM is created.
  restoreEnv("PATH");
  restoreEnv("GONDOLIN_VIRTIOFS");
  restoreEnv("GONDOLIN_NATIVE_BIN");
  if (engine.startsWith("native-prev")) {
    const prev = process.env.GONDOLIN_BENCH_PREV_BIN;
    if (!prev) throw new Error(`${engine} needs GONDOLIN_BENCH_PREV_BIN`);
    process.env.GONDOLIN_NATIVE_BIN = prev;
  }
  if (isVirtiofsEngine(engine)) {
    process.env.PATH = `${virtiofsQemuDir()}:${baseEnv.PATH ?? ""}`;
    process.env.GONDOLIN_VIRTIOFS = "1";
  }
}

export function getEngine(): EngineName {
  return currentEngine;
}

/** QEMU version on the current `PATH` */
export function qemuVersion(): string | null {
  const qemu =
    os.arch() === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
  return tryRun(qemu, ["--version"])?.split("\n")[0] ?? null;
}

/** QEMU binary path on the current `PATH` */
export function qemuPath(): string | null {
  const qemu =
    os.arch() === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
  return tryRun("/bin/sh", ["-c", `command -v ${qemu}`]);
}

/** Guest filesystem transport of a running VM (`virtiofs` or `sandboxfs`) */
export async function guestVfsTransport(vm: VM): Promise<string> {
  const mounts = await sh(vm, "cat /proc/mounts");
  if (/\svirtiofs\s/.test(mounts)) return "virtiofs";
  if (/fuse\.sandboxfs/.test(mounts)) return "sandboxfs";
  return "unknown";
}

/** Create a VM for the selected engine variant */
export async function createVm(options: VMOptions = {}): Promise<VM> {
  const opts: VMOptions = {
    ...options,
    sandbox: { console: "none", ...options.sandbox },
  };
  const vm = await VM.create(opts);
  await assertNativeEngine(vm);
  return vm;
}

/** `gondolind` pid of a VM */
function daemonPid(vm: VM): number | null {
  const server = (
    vm as unknown as { server?: { getDaemonPid?: () => number | null } }
  ).server;
  return server?.getDaemonPid?.() ?? null;
}

/**
 * Guard against benchmarking something else than gondolind (e.g. a wrong
 * `GONDOLIN_NATIVE_BIN`): the VM's daemon pid must be a `gondolind` process.
 */
let nativeEngineChecked = false;

async function assertNativeEngine(vm: VM) {
  // Checked once per process: the check starts the VM, which would otherwise
  // move boot time from the first exec into `createMs`.
  if (
    process.env.GONDOLIN_BENCH_SKIP_ENGINE_CHECK === "1" ||
    nativeEngineChecked
  )
    return;
  try {
    await vm.start();
    const pid = daemonPid(vm);
    const info = pid ? await readProcess(pid) : null;
    // the daemon is `gondolind` or the multi-call `gondolin daemon`
    if (!info?.comm.includes("gondolin")) {
      throw new Error(
        `daemon pid ${pid} is '${info?.comm ?? "?"}', not gondolind (set GONDOLIN_BENCH_SKIP_ENGINE_CHECK=1 to bypass)`,
      );
    }
    nativeEngineChecked = true;
  } catch (err) {
    await vm.close().catch(() => {});
    throw err;
  }
}

/**
 * Engine-side processes of a VM for resource accounting: the `gondolind`
 * daemon and `VM.getHostPid()` (QEMU or the krun runner), each
 * with its descendants. A `getEnginePids()` method on the VM, if present,
 * wins so engines can report exactly what they own.
 */
export async function enginePids(vm: VM): Promise<number[]> {
  const custom = (vm as unknown as { getEnginePids?: () => number[] })
    .getEnginePids;
  if (typeof custom === "function") return custom.call(vm);
  const pids = new Set<number>();
  for (const root of [daemonPid(vm), vm.getHostPid()]) {
    if (!root || root === process.pid || pids.has(root)) continue;
    for (const pid of await processTree(root)) pids.add(pid);
  }
  return [...pids];
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
 * `rm -rf` used to leave entries behind on sandboxfs mounts (fixed since).
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
    image: imageInfo(),
    nativeBin: process.env.GONDOLIN_NATIVE_BIN ?? null,
  };
}

/** Guest image in use: `GONDOLIN_GUEST_DIR` (with its build id) or the default image ref */
function imageInfo() {
  const dir = process.env.GONDOLIN_GUEST_DIR;
  if (!dir) return process.env.GONDOLIN_DEFAULT_IMAGE ?? "alpine-base:latest";
  try {
    const manifest = JSON.parse(
      fs.readFileSync(`${dir}/manifest.json`, "utf8"),
    );
    return `${dir} (buildId ${manifest.buildId})`;
  } catch {
    return dir;
  }
}

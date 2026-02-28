import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import * as child_process from "child_process";

import {
  SandboxController,
  type SandboxConfig,
  type SandboxState,
  __test,
} from "../src/sandbox/controller.ts";

// In ESM, built-in modules expose live bindings via getters which cannot be
// replaced with node:test mocks. The actual mutable exports object is on
// `default`.
const cp: any = (child_process as any).default ?? (child_process as any);

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedSignals: Array<string | undefined> = [];

  kill(signal?: string) {
    this.killedSignals.push(signal);
    return true;
  }
}

function makeConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    qemuPath: "qemu-system-aarch64",
    kernelPath: "/tmp/vmlinuz",
    initrdPath: "/tmp/initrd",
    memory: "256M",
    cpus: 1,
    virtioSocketPath: "/tmp/virtio.sock",
    virtioFsSocketPath: "/tmp/virtiofs.sock",
    virtioSshSocketPath: "/tmp/virtio-ssh.sock",
    virtioIngressSocketPath: "/tmp/virtio-ingress.sock",
    append: "console=ttyS0",
    machineType: "virt",
    accel: "tcg",
    cpu: "max",
    console: "none",
    autoRestart: false,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

test("SandboxController: start emits state transitions and forwards logs", async () => {
  const spawned: FakeChildProcess[] = [];
  mock.method(cp, "spawn", () => {
    const c = new FakeChildProcess();
    spawned.push(c);
    return c as any;
  });

  const controller = new SandboxController(makeConfig());

  const states: SandboxState[] = [];
  const logs: Array<{ stream: string; chunk: string }> = [];
  const exits: any[] = [];
  controller.on("state", (s) => states.push(s));
  controller.on("log", (chunk: any, stream: any) =>
    logs.push({ stream, chunk }),
  );
  controller.on("exit", (e) => exits.push(e));

  await controller.start();
  assert.equal(controller.getState(), "starting");
  assert.deepEqual(states, ["starting"]);

  assert.equal(spawned.length, 1);
  const child = spawned[0]!;

  child.stdout.write("out");
  child.stderr.write("err");
  await flush();
  assert.deepEqual(logs, [
    { stream: "stdout", chunk: "out" },
    { stream: "stderr", chunk: "err" },
  ]);

  child.emit("spawn");
  assert.equal(controller.getState(), "running");
  assert.deepEqual(states, ["starting", "running"]);

  child.emit("exit", 0, null);
  assert.equal(controller.getState(), "stopped");
  assert.deepEqual(states, ["starting", "running", "stopped"]);

  assert.equal(exits.length, 1);
  assert.deepEqual(exits[0], { code: 0, signal: null });
});

test("SandboxController: start is idempotent while running", async () => {
  let spawnCalls = 0;
  const child = new FakeChildProcess();

  mock.method(cp, "spawn", () => {
    spawnCalls += 1;
    return child as any;
  });

  const controller = new SandboxController(makeConfig());
  await controller.start();
  child.emit("spawn");

  await controller.start();
  assert.equal(spawnCalls, 1);
});

test("SandboxController: close sends SIGTERM and does not SIGKILL if child exits quickly", async () => {
  mock.timers.enable();

  const child = new FakeChildProcess();
  mock.method(cp, "spawn", () => child as any);

  const controller = new SandboxController(makeConfig());
  await controller.start();
  child.emit("spawn");

  const closing = controller.close();
  assert.deepEqual(child.killedSignals, ["SIGTERM"]);

  child.emit("exit", 0, null);
  await closing;

  // Even if we advance time past the escalation threshold, the timeout should
  // have been cleared.
  mock.timers.tick(5000);
  assert.deepEqual(child.killedSignals, ["SIGTERM"]);
  assert.equal(controller.getState(), "stopped");
});

test("SandboxController: close escalates to SIGKILL after 3s", async () => {
  mock.timers.enable();

  const child = new FakeChildProcess();
  mock.method(cp, "spawn", () => child as any);

  const controller = new SandboxController(makeConfig());
  await controller.start();
  child.emit("spawn");

  const closing = controller.close();
  assert.deepEqual(child.killedSignals, ["SIGTERM"]);

  mock.timers.tick(3000);
  assert.deepEqual(child.killedSignals, ["SIGTERM", "SIGKILL"]);

  child.emit("exit", 0, null);
  await closing;
});

test("SandboxController: crash triggers auto-restart after 1s (unless manual stop)", async () => {
  mock.timers.enable();

  const spawned: FakeChildProcess[] = [];
  mock.method(cp, "spawn", () => {
    const c = new FakeChildProcess();
    spawned.push(c);
    return c as any;
  });

  const controller = new SandboxController(makeConfig({ autoRestart: true }));

  await controller.start();
  spawned[0]!.emit("spawn");

  // Simulate crash.
  spawned[0]!.emit("exit", 1, null);
  assert.equal(controller.getState(), "stopped");

  // Restart should be scheduled.
  mock.timers.tick(1000);
  assert.equal(spawned.length, 2);
  assert.equal(controller.getState(), "starting");

  // If we manually stop, auto-restart must NOT happen.
  spawned[1]!.emit("spawn");
  const closing = controller.close();
  spawned[1]!.emit("exit", 0, null);
  await closing;

  mock.timers.tick(2000);
  assert.equal(spawned.length, 2);
});

test("SandboxController: error event emits exit with error and does not auto-restart", async () => {
  mock.timers.enable();

  const child = new FakeChildProcess();
  mock.method(cp, "spawn", () => child as any);

  const controller = new SandboxController(makeConfig({ autoRestart: true }));

  const exits: any[] = [];
  controller.on("exit", (e) => exits.push(e));

  await controller.start();
  child.emit("error", new Error("boom"));

  assert.equal(controller.getState(), "stopped");
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, null);
  assert.equal(exits[0].signal, null);
  assert.ok(exits[0].error instanceof Error);

  // No restart should be scheduled from the error path.
  mock.timers.tick(2000);
  assert.equal(controller.getState(), "stopped");
});

test("sandbox-controller: buildQemuArgs does not select -cpu host when using tcg", () => {
  const hostArch = process.arch === "arm64" ? "arm64" : "x64";

  // Note: cpu/accel selection is platform-specific, but "tcg" should always
  // avoid "-cpu host".
  const args = (__test as any).buildQemuArgs({
    qemuPath:
      hostArch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64",
    kernelPath: "/tmp/vmlinuz",
    initrdPath: "/tmp/initrd",
    memory: "256M",
    cpus: 1,
    virtioSocketPath: "/tmp/virtio.sock",
    virtioFsSocketPath: "/tmp/virtiofs.sock",
    virtioSshSocketPath: "/tmp/virtiossh.sock",
    append: "console=ttyS0",
    machineType: "q35",
    accel: "tcg",
    // cpu intentionally omitted
    console: "none",
    autoRestart: false,
  });

  const cpuIndex = args.indexOf("-cpu");
  assert.notEqual(cpuIndex, -1);
  assert.equal(args[cpuIndex + 1], "max");
});

test("sandbox-controller: selectCpu only uses host with matching hw accel", () => {
  const hostArch = process.arch === "arm64" ? "arm64" : "x64";

  assert.equal((__test as any).selectCpu(hostArch, "tcg"), "max");

  if (process.platform === "linux") {
    assert.equal((__test as any).selectCpu(hostArch, "kvm"), "host");
  } else if (process.platform === "darwin") {
    assert.equal((__test as any).selectCpu(hostArch, "hvf"), "host");
  } else {
    assert.equal((__test as any).selectCpu(hostArch, "kvm"), "max");
  }

  const otherArch = hostArch === "arm64" ? "x64" : "arm64";
  assert.equal((__test as any).selectCpu(otherArch, "kvm"), "max");
});

test("sandbox-controller: selectMachineType avoids microvm for x64 tcg", () => {
  const selectMachineType = (__test as any).selectMachineType as (
    targetArch: string,
    accel?: string,
  ) => string;

  if (process.platform === "linux") {
    assert.equal(selectMachineType("x64", "kvm"), "microvm");
    assert.equal(selectMachineType("x64", "tcg"), "q35");
    assert.equal(selectMachineType("x64", undefined), "q35");
  }

  assert.equal(selectMachineType("arm64", "tcg"), "virt");
});

test("sandbox-controller: killActiveChildren kills tracked processes", async () => {
  const child = new FakeChildProcess();
  mock.method(cp, "spawn", () => child as any);

  const controller = new SandboxController(makeConfig());
  await controller.start();

  assert.equal(__test.getActiveChildrenCount() >= 1, true);
  __test.killActiveChildren();
  assert.ok(child.killedSignals.includes("SIGKILL"));
});

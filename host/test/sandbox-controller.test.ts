import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as child_process from "child_process";

import {
  SandboxController,
  type SandboxConfig,
  type SandboxState,
  __test,
} from "../src/sandbox/controller.ts";
import type { LocalEndpointInput } from "../src/local-endpoint.ts";

// In ESM, built-in modules expose live bindings via getters which cannot be
// replaced with node:test mocks. The actual mutable exports object is on
// `default`.
const cp: any = (child_process as any).default ?? (child_process as any);

class FakeChildProcess extends EventEmitter {
  pid = 12345;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedSignals: Array<string | undefined> = [];

  kill(signal?: string) {
    this.killedSignals.push(signal);
    return true;
  }
}

function makeEndpoint(name: string): LocalEndpointInput {
  return process.platform === "win32"
    ? { transport: "tcp", host: "127.0.0.1", port: 4000 }
    : `/tmp/${name}.sock`;
}

function makeConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    qemuPath: "qemu-system-aarch64",
    kernelPath: "/tmp/vmlinuz",
    initrdPath: "/tmp/initrd",
    memory: "256M",
    cpus: 1,
    virtioSocketPath: makeEndpoint("virtio"),
    virtioFsSocketPath: makeEndpoint("virtiofs"),
    virtioSshSocketPath: makeEndpoint("virtio-ssh"),
    virtioIngressSocketPath: makeEndpoint("virtio-ingress"),
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
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

test("SandboxController: getHostPid reflects the active child process", async () => {
  const child = new FakeChildProcess();
  child.pid = 23456;
  mock.method(cp, "spawn", () => child as any);

  const controller = new SandboxController(makeConfig());
  assert.equal(controller.getHostPid(), null);

  await controller.start();
  assert.equal(controller.getHostPid(), 23456);

  child.emit("exit", 0, null);
  assert.equal(controller.getHostPid(), null);
});

test("buildQemuArgs: rootDiskVolatileMode=snapshot enables qemu snapshot mode", () => {
  const args = __test.buildQemuArgs(
    makeConfig({
      rootDiskPath: "/tmp/rootfs.ext4",
      rootDiskFormat: "raw",
      rootDiskVolatileMode: "snapshot",
    }),
  );

  const driveIndex = args.indexOf("-drive");
  assert.notEqual(driveIndex, -1);
  assert.match(args[driveIndex + 1]!, /snapshot=on/);
});

test(
  "SandboxController: idle pause uses a short QMP socket",
  {
    skip:
      process.platform === "win32"
        ? "QMP idle pause currently uses a Unix monitor socket"
        : false,
  },
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-qmp-test-"));
    const seenCommands: string[] = [];
    const child = new FakeChildProcess();
    let spawnedArgs: string[] = [];

    mock.method(cp, "spawn", (_cmd: string, args: string[]) => {
      spawnedArgs = args;
      return child as any;
    });

    const controller = new SandboxController(
      makeConfig({
        qemuIdlePauseMs: 1,
        virtioSocketPath: path.join(tmpDir, "virtio.sock"),
      }),
    );

    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.write(
        JSON.stringify({ QMP: { version: {}, capabilities: [] } }) + "\r\n",
      );

      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) break;
          const raw = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!raw) continue;
          const message = JSON.parse(raw) as { execute?: string };
          if (message.execute) seenCommands.push(message.execute);
          socket.write(JSON.stringify({ return: {} }) + "\r\n");
        }
      });
    });

    try {
      await controller.start();
      child.emit("spawn");

      const qmpIndex = spawnedArgs.indexOf("-qmp");
      assert.notEqual(qmpIndex, -1);
      const match = /^unix:(.*),server=on,wait=off$/.exec(
        spawnedArgs[qmpIndex + 1]!,
      );
      assert.ok(match);
      const qmpSocketPath = match[1]!;
      assert.equal(path.dirname(qmpSocketPath), tmpDir);

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(qmpSocketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });

      controller.scheduleIdlePause();
      await waitFor(() => seenCommands.includes("stop"));

      const resume = controller.resumeForActivity();
      if (resume) await resume;

      assert.deepEqual(
        seenCommands.filter(
          (command) => command === "stop" || command === "cont",
        ),
        ["stop", "cont"],
      );

      const closing = controller.close();
      child.emit("exit", 0, null);
      await closing;
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test("buildQemuArgs supports tcp-backed chardev and netdev endpoints", () => {
  const args = __test.buildQemuArgs(
    makeConfig({
      qemuPath: "qemu-system-x86_64",
      machineType: "q35",
      virtioSocketPath: { transport: "tcp", host: "127.0.0.1", port: 4101 },
      virtioFsSocketPath: {
        transport: "tcp",
        host: "127.0.0.1",
        port: 4102,
      },
      virtioSshSocketPath: {
        transport: "tcp",
        host: "127.0.0.1",
        port: 4103,
      },
      virtioIngressSocketPath: {
        transport: "tcp",
        host: "127.0.0.1",
        port: 4104,
      },
      netSocketPath: { transport: "tcp", host: "127.0.0.1", port: 4105 },
    }),
  );

  assert.ok(
    args.includes("socket,id=virtiocon0,host=127.0.0.1,port=4101,server=off"),
  );
  assert.ok(
    args.includes(
      "stream,id=net0,server=off,addr.type=inet,addr.host=127.0.0.1,addr.port=4105",
    ),
  );
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
    virtioSocketPath: makeEndpoint("virtio"),
    virtioFsSocketPath: makeEndpoint("virtiofs"),
    virtioSshSocketPath: makeEndpoint("virtiossh"),
    virtioIngressSocketPath: makeEndpoint("virtioingress"),
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
  } else if (process.platform === "win32") {
    assert.equal((__test as any).selectCpu(hostArch, "whpx"), "qemu64");
    assert.equal((__test as any).selectCpu(hostArch, "tcg"), "max");
  } else {
    assert.equal((__test as any).selectCpu(hostArch, "kvm"), "max");
  }

  const otherArch = hostArch === "arm64" ? "x64" : "arm64";
  assert.equal((__test as any).selectCpu(otherArch, "kvm"), "max");
});

test("sandbox-controller: qemuSupportsAccel parses '-accel help' output", () => {
  mock.method(cp, "spawnSync", () => ({
    status: 0,
    stdout: "Accelerators supported in QEMU binary:\r\ntcg\r\nwhpx\r\n",
  }));

  assert.equal(
    (__test as any).qemuSupportsAccel("qemu-system-x86_64", "whpx"),
    true,
  );
  assert.equal(
    (__test as any).qemuSupportsAccel("qemu-system-x86_64", "hvf"),
    false,
  );
});

test("sandbox-controller: selectAccel falls back to tcg when WHPX cannot initialize", (t) => {
  if (process.platform !== "win32") {
    t.skip("WHPX probing is Windows-specific");
    return;
  }

  mock.method(cp, "spawnSync", (_bin: string, args: string[]) => {
    if (args[1] === "help") {
      return {
        status: 0,
        stdout: "Accelerators supported in QEMU binary:\r\ntcg\r\nwhpx\r\n",
      };
    }

    return {
      status: 1,
      stdout: "",
    };
  });

  assert.equal(
    (__test as any).selectAccel("x64", "qemu-system-x86_64-runtime-fail"),
    "tcg",
  );
});

test("sandbox-controller: selectAccel keeps WHPX when runtime probe succeeds", (t) => {
  if (process.platform !== "win32") {
    t.skip("WHPX probing is Windows-specific");
    return;
  }

  mock.method(cp, "spawnSync", (_bin: string, args: string[]) => {
    if (args[1] === "help") {
      return {
        status: 0,
        stdout: "Accelerators supported in QEMU binary:\r\ntcg\r\nwhpx\r\n",
      };
    }

    return {
      status: null,
      stdout: "",
      error: { code: "ETIMEDOUT" },
    };
  });

  assert.equal(
    (__test as any).selectAccel("x64", "qemu-system-x86_64-runtime-ok"),
    "whpx",
  );
});

test("sandbox-controller: selectRngObject uses the cross-platform builtin RNG on Windows", (t) => {
  if (process.platform !== "win32") {
    t.skip("this asserts the Windows-specific branch");
    return;
  }

  assert.equal((__test as any).selectRngObject(), "rng-builtin,id=rng0");
});

test("sandbox-controller: selectRngObject uses /dev/urandom off Windows", (t) => {
  if (process.platform === "win32") {
    t.skip("this asserts the non-Windows branch");
    return;
  }

  assert.equal(
    (__test as any).selectRngObject(),
    "rng-random,filename=/dev/urandom,id=rng0",
  );
});

test("sandbox-controller: buildQemuArgs always emits a virtio-rng device (never silently drops RNG)", () => {
  const args = __test.buildQemuArgs(makeConfig());

  const objectIndex = args.indexOf("-object");
  assert.notEqual(objectIndex, -1);
  const rngObject = args[objectIndex + 1]!;
  assert.match(rngObject, /^rng-(random|builtin),.*id=rng0/);

  const deviceIndex = args.indexOf("-device");
  assert.notEqual(deviceIndex, -1);
  assert.match(args[deviceIndex + 1]!, /^virtio-rng-(pci|device),rng=rng0/);
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

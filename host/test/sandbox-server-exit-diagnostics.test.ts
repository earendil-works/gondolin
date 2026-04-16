import assert from "node:assert/strict";
import test from "node:test";

import { SandboxServer } from "../src/sandbox/server.ts";
import type { ResolvedSandboxServerOptions } from "../src/sandbox/server-options.ts";
import type { LocalEndpoint } from "../src/local-endpoint.ts";

function makeEndpoint(name: string): LocalEndpoint {
  return process.platform === "win32"
    ? { transport: "tcp", host: "127.0.0.1", port: 0 }
    : { transport: "unix", path: `/tmp/${name}.sock` };
}

function makeResolvedOptions(
  overrides: Partial<ResolvedSandboxServerOptions> = {},
): ResolvedSandboxServerOptions {
  return {
    vmm: "qemu",
    qemuPath: "/bin/false",
    krunRunnerPath: "/bin/false",
    kernelPath: "/tmp/vmlinuz",
    initrdPath: "/tmp/initramfs.cpio",
    rootfsPath: "/tmp/rootfs.ext4",

    rootDiskPath: "/tmp/rootfs.ext4",
    rootDiskFormat: "raw",
    rootDiskReadOnly: false,

    memory: "256M",
    cpus: 1,
    virtioSocketPath: makeEndpoint("gondolin-test-virtio"),
    virtioFsSocketPath: makeEndpoint("gondolin-test-virtiofs"),
    virtioSshSocketPath: makeEndpoint("gondolin-test-virtiossh"),
    virtioIngressSocketPath: makeEndpoint("gondolin-test-virtioingress"),
    netSocketPath: makeEndpoint("gondolin-test-net"),
    netMac: "02:00:00:00:00:01",
    netEnabled: false,
    allowWebSockets: true,

    debug: [],
    machineType: undefined,
    accel: undefined,
    cpu: undefined,
    console: "none",
    autoRestart: false,
    append: "",

    maxStdinBytes: 64 * 1024,
    maxQueuedStdinBytes: 1024,
    maxTotalQueuedStdinBytes: 1024 * 1024,
    maxQueuedExecs: 64,
    maxHttpBodyBytes: 1024 * 1024,
    maxHttpResponseBodyBytes: 1024 * 1024,
    fetch: undefined,
    httpHooks: undefined,
    dns: undefined,
    mitmCertDir: undefined,
    vfsProvider: null,

    ...overrides,
  };
}

type Captured = { json: any[] };

function makeClient(): { client: any; captured: Captured } {
  const captured: Captured = { json: [] };
  const client = {
    sendJson: (message: any) => {
      captured.json.push(message);
      return true;
    },
    sendBinary: (_data: Buffer) => true,
    close: () => {},
  };
  return { client, captured };
}

function execMessage(id: number) {
  return {
    type: "exec",
    id,
    cmd: "/bin/sh",
    argv: ["-lc", "echo hi"],
    env: [],
    stdin: false,
    pty: false,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

test("SandboxServer: stop->exit emits enriched inflight error (not generic)", async () => {
  const server = new SandboxServer(makeResolvedOptions());
  (server as any).bridge.send = () => true;

  const { client, captured } = makeClient();
  (server as any).handleExec(client, execMessage(1));

  const controller = (server as any).controller;

  controller.emit("log", "qemu: badness\n", "stderr");

  // Matches SandboxController ordering: state=stopped then exit.
  controller.emit("state", "stopped");
  controller.emit("exit", { code: 1, signal: null });

  await flushMicrotasks();

  assert.equal(captured.json.length, 1);
  assert.deepEqual(captured.json[0], {
    type: "error",
    id: 1,
    code: "sandbox_stopped",
    message: "sandbox exited (code=1) (qemu: qemu: badness)",
  });
});

test("SandboxServer: QEMU hint does not include stdout (guest console) and strips ANSI", async () => {
  const server = new SandboxServer(makeResolvedOptions());
  (server as any).bridge.send = () => true;

  const { client, captured } = makeClient();
  (server as any).handleExec(client, execMessage(1));

  const controller = (server as any).controller;

  controller.emit("log", "SECRET\u001b[31m\n", "stdout");
  controller.emit("log", "qemu: oops \u001b[31mred\u001b[0m\n", "stderr");

  controller.emit("state", "stopped");
  controller.emit("exit", { code: 2, signal: null });

  await flushMicrotasks();

  assert.equal(captured.json.length, 1);
  const msg = captured.json[0].message as string;
  assert.ok(msg.includes("sandbox exited (code=2)"));
  assert.ok(msg.includes("(qemu:"));
  assert.ok(!msg.includes("SECRET"));
  assert.ok(!msg.includes("\u001b"));
  assert.ok(msg.includes("qemu: oops red"));
});

test("SandboxServer: boot start failure closes client and rejects later messages", async () => {
  const server = new SandboxServer(makeResolvedOptions());
  const captured: any[] = [];
  let closed = 0;

  const connection = server.connect((data, isBinary) => {
    if (isBinary) return;
    captured.push(JSON.parse(String(data)));
  }, () => {
    closed += 1;
  });

  const controller = (server as any).controller;
  controller.start = async () => {
    throw new Error("no hypervisor entitlement");
  };

  connection.send({ type: "boot" });
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(closed, 1);
  assert.deepEqual(captured.at(-1), {
    type: "error",
    code: "sandbox_start_failed",
    message: "no hypervisor entitlement",
  });
  assert.equal((server as any).bootConfig, null);

  const capturedCount = captured.length;
  connection.send(execMessage(99));
  await flushMicrotasks();

  assert.equal(captured.length, capturedCount);
  assert.equal((server as any).inflight.size, 0);

  await (server as any).close();
});

test("SandboxServer: krun hint skips low-value Zig stack frames", async () => {
  const server = new SandboxServer(makeResolvedOptions({ vmm: "krun" }));
  (server as any).bridge.send = () => true;

  const { client, captured } = makeClient();
  (server as any).handleExec(client, execMessage(1));

  const controller = (server as any).controller;

  controller.emit("log", "error: krun_start_enter failed: rc=-22\n", "stderr");
  controller.emit("log", "error: KrunError\n", "stderr");
  controller.emit(
    "log",
    "/tmp/gondolin/host/krun-runner/main.zig:158:23: 0x100393f7f in runVm\n",
    "stderr",
  );
  controller.emit(
    "log",
    "    if (start_rc < 0) return krunError(\"krun_start_enter\", start_rc);\n",
    "stderr",
  );
  controller.emit("log", "                       ^\n", "stderr");
  controller.emit(
    "log",
    "(additional stack frames may have been skipped...)\n",
    "stderr",
  );

  controller.emit("state", "stopped");
  controller.emit("exit", { code: 1, signal: null });

  await flushMicrotasks();

  assert.equal(captured.json.length, 1);
  assert.equal(
    captured.json[0].message,
    "sandbox exited (code=1) (krun: error: krun_start_enter failed: rc=-22)",
  );
});

test("SandboxServer: QEMU hint tail is cleared on starting", async () => {
  const server = new SandboxServer(makeResolvedOptions());
  (server as any).bridge.send = () => true;

  const controller = (server as any).controller;

  controller.emit("log", "qemu: old\n", "stderr");
  controller.emit("state", "starting");
  controller.emit("log", "qemu: new\n", "stderr");

  const { client, captured } = makeClient();
  (server as any).handleExec(client, execMessage(1));

  controller.emit("state", "stopped");
  controller.emit("exit", { code: 3, signal: null });

  await flushMicrotasks();

  assert.equal(captured.json.length, 1);
  const message = captured.json[0].message as string;
  assert.ok(message.includes("qemu: qemu: new"));
  assert.ok(!message.includes("old"));
});

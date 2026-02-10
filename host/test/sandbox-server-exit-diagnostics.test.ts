import assert from "node:assert/strict";
import test from "node:test";

import { SandboxServer, type ResolvedSandboxServerOptions } from "../src/sandbox-server";

function makeResolvedOptions(
  overrides: Partial<ResolvedSandboxServerOptions> = {}
): ResolvedSandboxServerOptions {
  return {
    qemuPath: "/bin/false",
    kernelPath: "/tmp/vmlinuz",
    initrdPath: "/tmp/initramfs.cpio",
    rootfsPath: "/tmp/rootfs.ext4",

    rootDiskPath: "/tmp/rootfs.ext4",
    rootDiskFormat: "raw",
    rootDiskSnapshot: true,

    memory: "256M",
    cpus: 1,
    virtioSocketPath: "/tmp/gondolin-test-virtio.sock",
    virtioFsSocketPath: "/tmp/gondolin-test-virtiofs.sock",
    virtioSshSocketPath: "/tmp/gondolin-test-virtiossh.sock",
    netSocketPath: "/tmp/gondolin-test-net.sock",
    netMac: "02:00:00:00:00:01",
    netEnabled: false,

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

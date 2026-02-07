import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryProvider, type VirtualProvider } from "../src/vfs";
import { createExecSession } from "../src/exec";
import { VM, __test, type VMOptions } from "../src/vm";

function makeTempResolvedServerOptions() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-vm-test-"));
  const kernelPath = path.join(dir, "vmlinuz");
  const initrdPath = path.join(dir, "initrd");
  const rootfsPath = path.join(dir, "rootfs");
  fs.writeFileSync(kernelPath, "");
  fs.writeFileSync(initrdPath, "");
  fs.writeFileSync(rootfsPath, "");

  return {
    dir,
    resolved: {
      qemuPath: "qemu-system-aarch64",
      kernelPath,
      initrdPath,
      rootfsPath,
      memory: "256M",
      cpus: 1,
      virtioSocketPath: path.join(dir, "virtio.sock"),
      virtioFsSocketPath: path.join(dir, "virtiofs.sock"),
      netSocketPath: path.join(dir, "net.sock"),
      netMac: "02:00:00:00:00:01",
      netEnabled: false,
      debug: [],
      machineType: "virt",
      accel: "tcg",
      cpu: "max",
      console: "none" as const,
      autoRestart: false,
      append: "console=ttyAMA0",
      maxStdinBytes: 64 * 1024,
      maxHttpBodyBytes: 1024 * 1024,
      mitmCertDir: path.join(dir, "mitm"),
      vfsProvider: null,
    },
  };
}

function makeVm(options: VMOptions = {}) {
  const { dir, resolved } = makeTempResolvedServerOptions();
  const vm = new VM(options, resolved as any);
  return {
    vm,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("vm internals: resolveFuseConfig normalizes fuseMount and binds", () => {
  const mounts: Record<string, VirtualProvider> = {
    "/": new MemoryProvider(),
    "/app": new MemoryProvider(),
    "/deep/nested": new MemoryProvider(),
  };

  const cfg = __test.resolveFuseConfig({ fuseMount: "/data" }, mounts);
  assert.equal(cfg.fuseMount, "/data");
  // bind mounts exclude "/"
  assert.deepEqual(cfg.fuseBinds.sort(), ["/app", "/deep/nested"].sort());
});

test("vm internals: resolveVmVfs supports null vfs and default MemoryProvider", () => {
  const disabled = __test.resolveVmVfs(null, undefined);
  assert.equal(disabled.provider, null);
  assert.deepEqual(disabled.mounts, {});

  const enabled = __test.resolveVmVfs(undefined, undefined);
  assert.ok(enabled.provider, "expected default vfs provider");
});

test("vm internals: resolveMitmMounts injects /etc/ssl/certs unless already mounted", () => {
  const injected = __test.resolveMitmMounts(undefined, undefined, true);
  assert.ok(injected["/etc/ssl/certs"], "expected mitm mounts to include /etc/ssl/certs");

  const custom = __test.resolveMitmMounts(
    { mounts: { "/etc/ssl/certs": new MemoryProvider() } },
    undefined,
    true
  );
  assert.deepEqual(custom, {});

  const disabledNet = __test.resolveMitmMounts(undefined, undefined, false);
  assert.deepEqual(disabledNet, {});

  const disabledVfs = __test.resolveMitmMounts(null, undefined, true);
  assert.deepEqual(disabledVfs, {});
});

test("vm internals: createMitmCaProvider creates readonly ca-certificates.crt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-mitmca-test-"));
  try {
    const provider = __test.createMitmCaProvider(dir) as any;
    assert.equal(provider.readonly, true);

    const handle = provider.openSync("/ca-certificates.crt", "r");
    try {
      const pem = handle.readFileSync({ encoding: "utf8" });
      assert.ok(typeof pem === "string");
      assert.match(pem, /BEGIN CERTIFICATE/);
      assert.ok(pem.endsWith("\n"), "expected trailing newline");
    } finally {
      handle.closeSync();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("vm internals: mergeEnvInputs and buildShellEnv normalize TERM", () => {
  const prevTerm = process.env.TERM;
  try {
    process.env.TERM = "xterm-ghostty";

    const merged = __test.mergeEnvInputs({ A: "1" }, ["B=2", "A=3"]);
    assert.deepEqual(new Set(merged), new Set(["A=3", "B=2"]));

    const shellEnv = __test.buildShellEnv(undefined, undefined);
    assert.deepEqual(shellEnv, ["TERM=xterm-256color"]);

    const shellEnv2 = __test.buildShellEnv(["TERM=screen"], ["X=1"]);
    assert.ok(shellEnv2);
    assert.ok(shellEnv2.includes("TERM=screen"));
    assert.ok(shellEnv2.includes("X=1"));
  } finally {
    process.env.TERM = prevTerm;
  }
});

test("vm internals: pending stdin and pty resize flush after markSessionReady", async () => {
  const { vm, cleanup } = makeVm({ vfs: null });
  try {
    const sent: any[] = [];
    (vm as any).connection = {
      send: (msg: any) => sent.push(msg),
      close: () => {},
    };

    const session = createExecSession(1, { stdinEnabled: true });
    (vm as any).sessions.set(1, session);

    // Queue stdin + resize before the request is marked ready.
    (vm as any).sendPtyResize(1, 24.9, 80.2);
    (vm as any).sendStdinData(1, "hi");
    (vm as any).sendStdinEof(1);

    assert.equal(sent.length, 0);

    (vm as any).markSessionReady(session);

    assert.deepEqual(
      sent.map((m) => m.type),
      ["pty_resize", "stdin", "stdin"]
    );
    assert.deepEqual(sent[0], { type: "pty_resize", id: 1, rows: 24, cols: 80 });
    assert.deepEqual(sent[1], { type: "stdin", id: 1, data: Buffer.from("hi").toString("base64") });
    assert.deepEqual(sent[2], { type: "stdin", id: 1, eof: true });
  } finally {
    cleanup();
  }
});

test("vm internals: ensureRunning sends boot and resolves once running", async () => {
  const { vm, cleanup } = makeVm({ autoStart: true, vfs: null });

  try {
    const sent: any[] = [];
    const fakeConn = {
      send: (msg: any) => sent.push(msg),
      close: () => {},
    };

    let onMessage: ((data: any, isBinary: boolean) => void) | null = null;
    let onDisconnect: (() => void) | null = null;

    const fakeServer = {
      start: async () => {},
      connect: (m: any, d: any) => {
        onMessage = m;
        onDisconnect = d;
        return fakeConn;
      },
    };

    (vm as any).server = fakeServer;
    await (vm as any).ensureConnection();

    const runningPromise = (vm as any).ensureRunning();

    // First status resolves initial waitForStatus().
    onMessage!(JSON.stringify({ type: "status", state: "stopped" }), false);

    // allow ensureRunning() continuation to run
    await new Promise<void>((resolve) => setImmediate(resolve));

    // ensureBoot() should have sent boot.
    assert.ok(sent.some((m) => m.type === "boot"));

    // Second status resolves post-boot waitForStatus().
    onMessage!(JSON.stringify({ type: "status", state: "running" }), false);

    await runningPromise;

    // Boot should be sent exactly once.
    assert.equal(sent.filter((m) => m.type === "boot").length, 1);
    assert.ok(onDisconnect);
  } finally {
    cleanup();
  }
});

test("vm internals: ensureRunning throws when stopped and autoStart disabled", async () => {
  const { vm, cleanup } = makeVm({ autoStart: false, vfs: null });
  try {
    const sent: any[] = [];
    const fakeConn = {
      send: (msg: any) => sent.push(msg),
      close: () => {},
    };

    let onMessage: ((data: any, isBinary: boolean) => void) | null = null;

    const fakeServer = {
      start: async () => {},
      connect: (m: any) => {
        onMessage = m;
        return fakeConn;
      },
    };

    (vm as any).server = fakeServer;
    await (vm as any).ensureConnection();

    const p = (vm as any).ensureRunning();
    onMessage!(JSON.stringify({ type: "status", state: "stopped" }), false);

    await assert.rejects(p, /sandbox is stopped/);
    assert.equal(sent.filter((m) => m.type === "boot").length, 0);
  } finally {
    cleanup();
  }
});

test("vm internals: handleDisconnect rejects pending state waiters and sessions", async () => {
  const { vm, cleanup } = makeVm({ vfs: null });
  try {
    const waiter = (vm as any).waitForState("running");

    const session1 = createExecSession(1, { stdinEnabled: false });
    const session2 = createExecSession(2, { stdinEnabled: false });
    (vm as any).sessions.set(1, session1);
    (vm as any).sessions.set(2, session2);

    (vm as any).handleDisconnect(new Error("bye"));

    await assert.rejects(waiter, /bye/);
    await assert.rejects(session1.resultPromise, /bye/);
    await assert.rejects(session2.resultPromise, /bye/);
  } finally {
    cleanup();
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryProvider, type VirtualProvider } from "../src/vfs/node";
import { createExecSession } from "../src/exec";
import { VM, __test, type VMOptions } from "../src/vm";
import type { RootfsMode } from "../src/rootfs-mode";

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
      virtioSshSocketPath: path.join(dir, "virtio-ssh.sock"),
      virtioIngressSocketPath: path.join(dir, "virtio-ingress.sock"),
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
      maxHttpResponseBodyBytes: 1024 * 1024,
      mitmCertDir: path.join(dir, "mitm"),
      vfsProvider: null,
    },
  };
}

function writeAssetManifest(dir: string, rootfsMode?: RootfsMode) {
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        config: {
          arch: "aarch64",
          distro: "alpine",
          alpine: { version: "3.23.0" },
        },
        runtimeDefaults: rootfsMode ? { rootfsMode } : undefined,
        buildTime: new Date().toISOString(),
        assets: {
          kernel: "vmlinuz",
          initramfs: "initrd",
          rootfs: "rootfs",
        },
        checksums: {
          kernel: "",
          initramfs: "",
          rootfs: "",
        },
      },
      null,
      2,
    ),
  );
}

function makeVm(options: VMOptions = {}) {
  const { dir, resolved } = makeTempResolvedServerOptions();
  const vm = new VM(options, resolved as any);
  return {
    vm,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("vm internals: rootfs readonly mode sets readonly root disk", async () => {
  const { vm, cleanup } = makeVm({
    autoStart: false,
    vfs: null,
    rootfs: { mode: "readonly" },
  });

  try {
    const resolved = (vm as any).resolvedSandboxOptions;
    assert.equal(resolved.rootDiskPath, resolved.rootfsPath);
    assert.equal(resolved.rootDiskSnapshot, false);
    assert.equal(resolved.rootDiskReadOnly, true);

    const rootDisk = (vm as any).rootDisk;
    assert.equal(rootDisk.snapshot, false);
    assert.equal(rootDisk.readOnly, true);
  } finally {
    await vm.close();
    cleanup();
  }
});

test("vm internals: manifest runtimeDefaults.rootfsMode is used by default", async () => {
  const { dir, resolved } = makeTempResolvedServerOptions();
  writeAssetManifest(dir, "readonly");

  const vm = new VM({ autoStart: false, vfs: null }, resolved as any);

  try {
    const resolvedOptions = (vm as any).resolvedSandboxOptions;
    assert.equal(resolvedOptions.rootDiskSnapshot, false);
    assert.equal(resolvedOptions.rootDiskReadOnly, true);
  } finally {
    await vm.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("vm internals: rootfs option overrides manifest default", async () => {
  const { dir, resolved } = makeTempResolvedServerOptions();
  writeAssetManifest(dir, "readonly");

  const vm = new VM(
    {
      autoStart: false,
      vfs: null,
      rootfs: { mode: "memory" },
    },
    resolved as any,
  );

  try {
    const resolvedOptions = (vm as any).resolvedSandboxOptions;
    assert.equal(resolvedOptions.rootDiskSnapshot, true);
    assert.equal(resolvedOptions.rootDiskReadOnly, false);
  } finally {
    await vm.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
  assert.ok(
    injected["/etc/ssl/certs"],
    "expected mitm mounts to include /etc/ssl/certs",
  );

  const custom = __test.resolveMitmMounts(
    { mounts: { "/etc/ssl/certs": new MemoryProvider() } },
    undefined,
    true,
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

test("vm internals: file helpers short-circuit VFS mounts", async () => {
  const provider = new MemoryProvider();
  const { vm, cleanup } = makeVm({
    autoStart: false,
    vfs: {
      mounts: {
        "/workspace": provider,
      },
    },
  });

  try {
    (vm as any).start = async () => {
      throw new Error("start should not be called for VFS shortcut");
    };

    await vm.fs.writeFile("/workspace/hello.txt", "hello world");

    const text = await vm.fs.readFile("/workspace/hello.txt", {
      encoding: "utf-8",
    });
    assert.equal(text, "hello world");

    const stream = await vm.fs.readFileStream("/workspace/hello.txt");
    assert.equal(stream.readableObjectMode, false);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    assert.equal(Buffer.concat(chunks).toString("utf-8"), "hello world");

    await vm.fs.writeFile("/data/workspace/from-fuse.txt", "fuse-path");
    const fromFuse = await vm.fs.readFile("/workspace/from-fuse.txt", {
      encoding: "utf-8",
    });
    assert.equal(fromFuse, "fuse-path");

    await vm.fs.access("/workspace/from-fuse.txt");
    const fileStats = await vm.fs.stat("/workspace/from-fuse.txt");
    assert.equal(fileStats.isFile(), true);

    await vm.fs.mkdir("/workspace/nested/dir", { recursive: true });
    await vm.fs.access("/workspace/nested/dir");

    await vm.fs.rename(
      "/workspace/from-fuse.txt",
      "/workspace/from-fuse-renamed.txt",
    );
    const renamed = await vm.fs.readFile("/workspace/from-fuse-renamed.txt", {
      encoding: "utf-8",
    });
    assert.equal(renamed, "fuse-path");

    const workspaceEntries = await vm.fs.listDir("/workspace");
    assert.ok(workspaceEntries.includes("from-fuse-renamed.txt"));
    assert.ok(!workspaceEntries.includes("from-fuse.txt"));
    assert.ok(workspaceEntries.includes("nested"));

    await vm.fs.deleteFile("/workspace/hello.txt");
    await assert.rejects(
      () => provider.stat("/hello.txt"),
      (err: unknown) => {
        const e = err as NodeJS.ErrnoException;
        return (
          e.code === "ENOENT" ||
          e.code === "ERRNO_2" ||
          e.errno === 2 ||
          e.errno === -2
        );
      },
    );

    await provider.mkdir("/dir");
    await assert.rejects(
      () => vm.fs.deleteFile("/workspace/dir"),
      /failed to delete guest file/,
    );
    await vm.fs.deleteFile("/workspace/dir", { recursive: true });
  } finally {
    cleanup();
  }
});

test("vm internals: file helpers still use VM path for non-VFS files", async () => {
  const provider = new MemoryProvider();
  const { vm, cleanup } = makeVm({
    autoStart: false,
    vfs: {
      mounts: {
        "/workspace": provider,
      },
    },
  });

  try {
    (vm as any).start = async () => {
      throw new Error("start called");
    };

    await assert.rejects(() => vm.fs.readFile("/tmp/not-vfs"), /start called/);
    await assert.rejects(() => vm.fs.access("/tmp/not-vfs"), /start called/);
    await assert.rejects(
      () => vm.fs.mkdir("/tmp/not-vfs", { recursive: true }),
      /start called/,
    );
    await assert.rejects(() => vm.fs.listDir("/tmp/not-vfs"), /start called/);
    await assert.rejects(() => vm.fs.stat("/tmp/not-vfs"), /start called/);
    await assert.rejects(
      () => vm.fs.rename("/tmp/a", "/tmp/b"),
      /start called/,
    );
  } finally {
    cleanup();
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

    const session = createExecSession(1, {
      stdinEnabled: true,
      stdout: { mode: "buffer" },
      stderr: { mode: "buffer" },
    });
    (vm as any).sessions.set(1, session);

    // Queue stdin + resize before the request is marked ready.
    (vm as any).sendPtyResize(1, 24.9, 80.2);
    (vm as any).sendStdinData(1, "hi");
    (vm as any).sendStdinEof(1);

    assert.equal(sent.length, 0);

    (vm as any).markSessionReady(session);

    assert.deepEqual(
      sent.map((m) => m.type),
      ["pty_resize", "stdin", "stdin"],
    );
    assert.deepEqual(sent[0], {
      type: "pty_resize",
      id: 1,
      rows: 24,
      cols: 80,
    });
    assert.deepEqual(sent[1], {
      type: "stdin",
      id: 1,
      data: Buffer.from("hi").toString("base64"),
    });
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

    const session1 = createExecSession(1, {
      stdinEnabled: false,
      stdout: { mode: "buffer" },
      stderr: { mode: "buffer" },
    });
    const session2 = createExecSession(2, {
      stdinEnabled: false,
      stdout: { mode: "buffer" },
      stderr: { mode: "buffer" },
    });
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

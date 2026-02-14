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

type Captured = {
  json: any[];
  binary: Buffer[];
  closed: boolean;
};

function makeClient(): { client: any; captured: Captured } {
  const captured: Captured = { json: [], binary: [], closed: false };
  const client = {
    sendJson: (message: any) => {
      captured.json.push(message);
      return true;
    },
    sendBinary: (data: Buffer) => {
      captured.binary.push(data);
      return true;
    },
    close: () => {
      captured.closed = true;
    },
  };
  return { client, captured };
}

function execMessage(id: number, extra: Partial<any> = {}) {
  return {
    type: "exec",
    id,
    cmd: "/bin/sh",
    argv: ["-lc", "echo hi"],
    env: [],
    stdin: true,
    pty: false,
    ...extra,
  };
}

function stdinMessage(id: number, data: Buffer, eof = false) {
  return {
    type: "stdin",
    id,
    data: data.toString("base64"),
    eof,
  };
}

test("exec requests are started concurrently when no file operation is active", () => {
  const server = new SandboxServer(makeResolvedOptions());
  const sent: any[] = [];
  const bridge = (server as any).bridge;
  bridge.send = (msg: any) => {
    sent.push(msg);
    return true;
  };

  const a = makeClient();
  const b = makeClient();

  (server as any).handleExec(a.client, execMessage(1));
  (server as any).handleExec(b.client, execMessage(2));

  assert.ok(sent.some((m) => m.t === "exec_request" && m.id === 1));
  assert.ok(sent.some((m) => m.t === "exec_request" && m.id === 2));
  assert.ok((server as any).inflight.has(1));
  assert.ok((server as any).inflight.has(2));
  assert.ok((server as any).startedExecs.has(1));
  assert.ok((server as any).startedExecs.has(2));
});

test("maxQueuedExecs caps total running plus queued exec pressure", () => {
  const server = new SandboxServer(makeResolvedOptions({ maxQueuedExecs: 1 }));
  const bridge = (server as any).bridge;
  bridge.send = () => true;

  const a = makeClient();
  const b = makeClient();

  (server as any).handleExec(a.client, execMessage(1));
  (server as any).handleExec(b.client, execMessage(2));

  assert.ok((server as any).startedExecs.has(1));
  assert.ok(!(server as any).inflight.has(2));
  assert.ok(
    b.captured.json.some((m) => m?.type === "error" && m?.id === 2 && m?.code === "queue_full"),
    "expected queue_full once running+queued exec pressure reaches limit"
  );
});

test("started exec stdin replay keeps data buffered on queue pressure and retries", () => {
  const server = new SandboxServer(makeResolvedOptions());

  const sent: any[] = [];
  const bridge = (server as any).bridge;

  let failStdin = true;
  bridge.send = (msg: any) => {
    sent.push(msg);
    if (msg.t === "stdin_data" && msg.id === 1 && failStdin) return false;
    return true;
  };

  const a = makeClient();

  (server as any).handleExec(a.client, execMessage(1));

  // sandboxd advertises stdin credits via a stdin_window message.
  bridge.onMessage({ v: 1, t: "stdin_window", id: 1, p: { stdin: 1024 } });

  (server as any).handleStdin(a.client, stdinMessage(1, Buffer.from("hello")));

  assert.ok((server as any).queuedStdin.has(1), "stdin should stay buffered after send failure");
  assert.ok((server as any).inflight.has(1), "exec should stay inflight");
  assert.ok(
    !a.captured.json.some((m) => m?.type === "error" && m?.id === 1),
    "transient queue pressure must not fail a started exec"
  );

  failStdin = false;
  (server as any).flushQueuedStdin();

  assert.equal(
    sent.filter((m) => m.t === "stdin_data" && m.id === 1).length,
    2,
    "expected one failed send and one retry"
  );
  assert.ok(!((server as any).queuedStdin.has(1)), "stdin buffer should clear after retry");
});

test("stdin sending is gated by guest-advertised stdin credits", () => {
  const server = new SandboxServer(makeResolvedOptions());

  const sent: any[] = [];
  const bridge = (server as any).bridge;
  bridge.send = (msg: any) => {
    sent.push(msg);
    return true;
  };

  const a = makeClient();
  (server as any).handleExec(a.client, execMessage(10));

  // No initial stdin credits yet, so stdin chunks must be buffered.
  (server as any).handleStdin(a.client, stdinMessage(10, Buffer.from("hello")));
  assert.equal(sent.filter((m) => m.t === "stdin_data" && m.id === 10).length, 0);
  assert.ok((server as any).queuedStdin.has(10));

  // Grant 2 bytes: should send a partial chunk.
  bridge.onMessage({ v: 1, t: "stdin_window", id: 10, p: { stdin: 2 } });
  const first = sent.find((m) => m.t === "stdin_data" && m.id === 10);
  assert.ok(first, "expected first stdin_data frame");
  assert.equal(first.p.data.toString("utf8"), "he");

  // Grant remaining 3 bytes: should flush the rest.
  bridge.onMessage({ v: 1, t: "stdin_window", id: 10, p: { stdin: 3 } });
  const frames = sent.filter((m) => m.t === "stdin_data" && m.id === 10);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].p.data.toString("utf8"), "llo");
});

test("stdin backpressure errors stay non-terminal and are not forwarded as client errors", () => {
  const server = new SandboxServer(makeResolvedOptions());
  const bridge = (server as any).bridge;
  bridge.send = () => true;

  const a = makeClient();
  (server as any).handleExec(a.client, execMessage(3));

  assert.ok((server as any).inflight.has(3));
  assert.ok((server as any).startedExecs.has(3));

  bridge.onMessage({
    v: 1,
    t: "error",
    id: 3,
    p: { code: "stdin_backpressure", message: "stdin queue full" },
  });

  assert.ok(
    !a.captured.json.some((m) => m?.type === "error" && m?.id === 3),
    "non-terminal stdin backpressure must not be forwarded as a client error"
  );
  assert.ok((server as any).inflight.has(3));
  assert.ok((server as any).startedExecs.has(3));

  bridge.onMessage({
    v: 1,
    t: "error",
    id: 3,
    p: { code: "stdin_chunk_too_large", message: "stdin chunk exceeds guest limit" },
  });

  assert.ok(
    !a.captured.json.some((m) => m?.type === "error" && m?.id === 3),
    "stdin_chunk_too_large must also stay advisory"
  );
  assert.ok((server as any).inflight.has(3));
  assert.ok((server as any).startedExecs.has(3));

  bridge.onMessage({ v: 1, t: "exec_output", id: 3, p: { stream: "stdout", data: Buffer.from("ok") } });
  assert.equal(a.captured.binary.length, 1, "exec output should still be delivered after backpressure error");

  bridge.onMessage({ v: 1, t: "exec_response", id: 3, p: { exit_code: 0 } });
  assert.ok(!(server as any).inflight.has(3));
  assert.ok(!(server as any).startedExecs.has(3));
});

test("queued exec stdin is bounded while file operation blocks startup", () => {
  const server = new SandboxServer(makeResolvedOptions({ maxQueuedStdinBytes: 10 }));
  const bridge = (server as any).bridge;
  bridge.send = () => true;

  // Simulate an in-progress file operation. Exec should queue but not start.
  (server as any).activeFileOpId = 99;

  const a = makeClient();
  (server as any).handleExec(a.client, execMessage(2));

  (server as any).handleStdin(a.client, stdinMessage(2, Buffer.from("12345678"))); // 8 bytes
  (server as any).handleStdin(a.client, stdinMessage(2, Buffer.from("abcde"))); // +5 => overflow

  assert.ok(
    a.captured.json.some((m) => m?.type === "error" && m?.id === 2 && m?.code === "payload_too_large"),
    "expected payload_too_large on queued stdin overflow"
  );

  assert.ok(!(server as any).inflight.has(2));
  assert.ok(!(server as any).startedExecs.has(2));
  assert.ok(!(server as any).execQueue.some((e: any) => e.message.id === 2));
  assert.ok(!(server as any).queuedStdin.has(2));
});

test("queued PTY resize survives send failure and retries after queued exec starts", () => {
  const server = new SandboxServer(makeResolvedOptions());

  const sent: any[] = [];
  const bridge = (server as any).bridge;

  let failResize = true;
  bridge.send = (msg: any) => {
    sent.push(msg);
    if (msg.t === "pty_resize" && msg.id === 2 && failResize) return false;
    return true;
  };

  // Hold exec startup behind a simulated file operation.
  (server as any).activeFileOpId = 100;

  const b = makeClient();
  (server as any).handleExec(b.client, execMessage(2, { pty: true }));
  (server as any).handlePtyResize(b.client, { type: "pty_resize", id: 2, rows: 40, cols: 100 });

  assert.ok((server as any).queuedPtyResize.has(2), "resize should queue before exec starts");

  // Release file operation and start queued exec.
  (server as any).activeFileOpId = null;
  (server as any).pumpExecQueue();

  assert.ok((server as any).startedExecs.has(2));
  assert.ok((server as any).queuedPtyResize.has(2), "failed resize send should stay queued");

  failResize = false;
  (server as any).flushQueuedPtyResize();

  assert.ok(sent.some((m) => m.t === "pty_resize" && m.id === 2));
  assert.ok(!((server as any).queuedPtyResize.has(2)), "queued resize should clear after retry");
});

test("queued exec requests are bounded by maxQueuedExecs while file operation is active", () => {
  const server = new SandboxServer(makeResolvedOptions({ maxQueuedExecs: 1 }));

  const bridge = (server as any).bridge;
  bridge.send = () => true;

  (server as any).activeFileOpId = 7;

  const a = makeClient();
  const b = makeClient();

  (server as any).handleExec(a.client, execMessage(1));
  (server as any).handleExec(b.client, execMessage(2));

  assert.ok((server as any).execQueue.some((e: any) => e.message.id === 1));
  assert.ok(
    b.captured.json.some((m) => m?.type === "error" && m?.id === 2 && m?.code === "queue_full"),
    "expected queue_full for second queued exec"
  );
  assert.ok(!(server as any).inflight.has(2));
});

test("total queued stdin cap applies across queued execs", () => {
  const server = new SandboxServer(
    makeResolvedOptions({ maxQueuedStdinBytes: 100, maxTotalQueuedStdinBytes: 10 })
  );

  const bridge = (server as any).bridge;
  bridge.send = () => true;

  (server as any).activeFileOpId = 42;

  const b = makeClient();
  const c = makeClient();

  (server as any).handleExec(b.client, execMessage(2));
  (server as any).handleExec(c.client, execMessage(3));

  (server as any).handleStdin(b.client, stdinMessage(2, Buffer.from("123456"))); // 6 bytes
  (server as any).handleStdin(c.client, stdinMessage(3, Buffer.from("abcdef"))); // +6 => overflow

  assert.ok(
    c.captured.json.some((m) => m?.type === "error" && m?.id === 3 && m?.code === "payload_too_large"),
    "expected payload_too_large when global queued stdin is exceeded"
  );

  assert.ok((server as any).inflight.has(2));
  assert.ok(!(server as any).inflight.has(3));
  assert.equal((server as any).queuedStdinBytesTotal, 6);
});

test("disconnect keeps started exec ids reserved", () => {
  const server = new SandboxServer(makeResolvedOptions());
  const bridge = (server as any).bridge;
  bridge.send = () => true;

  const a = makeClient();
  const b = makeClient();

  (server as any).handleExec(a.client, execMessage(11));
  assert.ok((server as any).inflight.has(11));
  assert.ok((server as any).startedExecs.has(11));

  (server as any).disconnectClient(a.client);

  assert.ok(!(server as any).inflight.has(11));
  assert.ok((server as any).startedExecs.has(11));

  (server as any).handleExec(b.client, execMessage(11));

  assert.ok(
    b.captured.json.some((m) => m?.type === "error" && m?.id === 11 && m?.code === "duplicate_id"),
    "expected duplicate_id while orphaned guest exec is still active"
  );
});

test("orphaned exec error clears started lifecycle tracking", () => {
  const server = new SandboxServer(makeResolvedOptions());
  const bridge = (server as any).bridge;
  bridge.send = () => true;

  const a = makeClient();
  (server as any).handleExec(a.client, execMessage(12));
  (server as any).disconnectClient(a.client);

  assert.ok((server as any).startedExecs.has(12));

  bridge.onMessage({
    v: 1,
    t: "error",
    id: 12,
    p: { code: "exec_failed", message: "failed to execute" },
  });

  assert.ok(!(server as any).startedExecs.has(12));
});

test("waitForExecIdle waits for guest-started exec lifecycle", async () => {
  const server = new SandboxServer(makeResolvedOptions());

  (server as any).startedExecs.add(5);

  const abort = new AbortController();
  abort.abort();

  await assert.rejects((server as any).waitForExecIdle(abort.signal), /operation aborted/);

  (server as any).startedExecs.delete(5);
  await (server as any).waitForExecIdle();
});

test("allocateFileOpId does not reuse active guest exec ids", () => {
  const server = new SandboxServer(makeResolvedOptions());

  (server as any).nextFileOpId = 1;
  (server as any).startedExecs.add(1);

  const id = (server as any).allocateFileOpId();
  assert.equal(id, 2);
});

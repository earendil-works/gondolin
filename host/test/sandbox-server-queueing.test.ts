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

test("startExecNow stdin replay queue_full keeps exec inflight and retries", () => {
  const server = new SandboxServer(makeResolvedOptions());

  const sent: any[] = [];
  const bridge = (server as any).bridge;

  let failStdin = true;
  bridge.send = (msg: any) => {
    sent.push(msg);
    if (msg.t === "stdin_data" && msg.id === 2 && failStdin) return false;
    return true;
  };

  const a = makeClient();
  const b = makeClient();
  const c = makeClient();

  (server as any).handleExec(a.client, execMessage(1));
  assert.equal((server as any).activeExecId, 1);

  (server as any).handleExec(b.client, execMessage(2));
  assert.equal((server as any).activeExecId, 1);

  (server as any).handleStdin(b.client, stdinMessage(2, Buffer.from("hello")));

  // Exec 1 finishes -> exec 2 starts -> queued stdin replay initially hits backpressure
  bridge.onMessage({ v: 1, t: "exec_response", id: 1, p: { exit_code: 0 } });

  assert.equal((server as any).activeExecId, 2);
  assert.ok((server as any).inflight.has(2), "exec 2 should remain inflight");
  assert.ok((server as any).stdinAllowed.has(2), "exec 2 should retain stdin ownership");
  assert.ok((server as any).queuedStdin.has(2), "unsent queued stdin should remain buffered");

  assert.equal(
    sent.filter((m) => m.t === "stdin_data" && m.id === 2).length,
    1,
    "expected exactly one failed stdin replay attempt"
  );

  assert.ok(
    !b.captured.json.some((m) => m?.type === "error" && m?.id === 2),
    "should not fail exec 2 or drop inflight state on transient backpressure"
  );

  // Retry once the bridge becomes writable again
  failStdin = false;
  (server as any).flushQueuedStdin();

  assert.equal(
    sent.filter((m) => m.t === "stdin_data" && m.id === 2).length,
    2,
    "expected stdin replay to be retried"
  );
  assert.ok(!((server as any).queuedStdin.has(2)), "queued stdin should be cleared after retry");

  // A new exec should NOT start immediately; it must wait for exec 2 completion.
  (server as any).handleExec(c.client, execMessage(3));

  assert.ok(
    !sent.some((m) => m.t === "exec_request" && m.id === 3),
    "exec 3 should not start while exec 2 is still active"
  );

  // Exec 2 finishes -> queue should pump and start exec 3
  bridge.onMessage({ v: 1, t: "exec_response", id: 2, p: { exit_code: 0 } });

  assert.ok(
    sent.some((m) => m.t === "exec_request" && m.id === 3),
    "exec 3 should start after exec 2 completion"
  );
});

test("queued stdin is bounded by maxQueuedStdinBytes and cancels queued exec on overflow", () => {
  const server = new SandboxServer(makeResolvedOptions({ maxQueuedStdinBytes: 10 }));

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

  (server as any).handleStdin(b.client, stdinMessage(2, Buffer.from("12345678"))); // 8 bytes
  (server as any).handleStdin(b.client, stdinMessage(2, Buffer.from("abcde"))); // +5 bytes => overflow

  assert.ok(
    b.captured.json.some((m) => m?.type === "error" && m?.id === 2 && m?.code === "payload_too_large"),
    "expected payload_too_large error"
  );

  // Exec 2 should have been cancelled/removed from queue
  assert.ok(!(server as any).inflight.has(2));
  assert.ok(!(server as any).stdinAllowed.has(2));
  assert.ok(!(server as any).queuedStdin.has(2));
  assert.ok(!(server as any).queuedPtyResize.has(2));
  assert.ok(!(server as any).execQueue.some((e: any) => e.message.id === 2));

  // Finishing exec 1 should not start exec 2
  bridge.onMessage({ v: 1, t: "exec_response", id: 1, p: { exit_code: 0 } });

  assert.ok(
    !sent.some((m) => m.t === "exec_request" && m.id === 2),
    "exec 2 should not start after being cancelled"
  );
});

test("queued PTY resize is not dropped on send failure and can be retried", () => {
  const server = new SandboxServer(makeResolvedOptions());

  const sent: any[] = [];
  const bridge = (server as any).bridge;

  let failResize = true;
  bridge.send = (msg: any) => {
    sent.push(msg);
    if (msg.t === "pty_resize" && msg.id === 2 && failResize) return false;
    return true;
  };

  const a = makeClient();
  const b = makeClient();

  (server as any).handleExec(a.client, execMessage(1));
  (server as any).handleExec(b.client, execMessage(2, { pty: true }));

  (server as any).handlePtyResize(b.client, { type: "pty_resize", id: 2, rows: 40, cols: 100 });
  assert.ok((server as any).queuedPtyResize.has(2));

  // Exec 1 finishes -> exec 2 starts -> resize replay fails
  bridge.onMessage({ v: 1, t: "exec_response", id: 1, p: { exit_code: 0 } });

  assert.equal((server as any).activeExecId, 2);
  assert.ok(
    (server as any).queuedPtyResize.has(2),
    "resize should remain queued after send failure"
  );

  // Now allow resize send and explicitly flush
  failResize = false;
  (server as any).flushQueuedPtyResize();

  assert.ok(
    !((server as any).queuedPtyResize.has(2)),
    "resize should be removed after successful retry"
  );

  assert.ok(sent.some((m) => m.t === "pty_resize" && m.id === 2));
});

test("queued PTY resize is cleared on exec completion if still queued", () => {
  const server = new SandboxServer(makeResolvedOptions());

  const bridge = (server as any).bridge;
  bridge.send = (msg: any) => {
    if (msg.t === "pty_resize" && msg.id === 2) return false;
    return true;
  };

  const a = makeClient();
  const b = makeClient();

  (server as any).handleExec(a.client, execMessage(1));
  (server as any).handleExec(b.client, execMessage(2, { pty: true }));

  (server as any).handlePtyResize(b.client, { type: "pty_resize", id: 2, rows: 40, cols: 100 });
  assert.ok((server as any).queuedPtyResize.has(2));

  // Exec 1 finishes -> exec 2 starts -> resize send fails and remains queued
  bridge.onMessage({ v: 1, t: "exec_response", id: 1, p: { exit_code: 0 } });
  assert.equal((server as any).activeExecId, 2);
  assert.ok((server as any).queuedPtyResize.has(2));

  // Exec 2 finishes before the resize can be retried
  bridge.onMessage({ v: 1, t: "exec_response", id: 2, p: { exit_code: 0 } });

  assert.ok(!((server as any).queuedPtyResize.has(2)), "queued resize should be cleared on exec completion");
});

test("queued exec requests are bounded by maxQueuedExecs", () => {
  const server = new SandboxServer(makeResolvedOptions({ maxQueuedExecs: 1 }));

  const bridge = (server as any).bridge;
  bridge.send = () => true;

  const a = makeClient();
  const b = makeClient();
  const c = makeClient();

  (server as any).handleExec(a.client, execMessage(1));
  (server as any).handleExec(b.client, execMessage(2));

  assert.ok((server as any).execQueue.some((e: any) => e.message.id === 2));

  (server as any).handleExec(c.client, execMessage(3));

  assert.ok(
    c.captured.json.some((m) => m?.type === "error" && m?.id === 3 && m?.code === "queue_full"),
    "expected queue_full error"
  );

  assert.ok(!(server as any).inflight.has(3));
  assert.ok(!(server as any).execQueue.some((e: any) => e.message.id === 3));
});

test("total queued stdin is bounded by maxTotalQueuedStdinBytes and cancels queued exec on overflow", () => {
  const server = new SandboxServer(
    makeResolvedOptions({ maxQueuedStdinBytes: 100, maxTotalQueuedStdinBytes: 10 })
  );

  const sent: any[] = [];
  const bridge = (server as any).bridge;
  bridge.send = (msg: any) => {
    sent.push(msg);
    return true;
  };

  const a = makeClient();
  const b = makeClient();
  const c = makeClient();

  (server as any).handleExec(a.client, execMessage(1));
  (server as any).handleExec(b.client, execMessage(2));
  (server as any).handleExec(c.client, execMessage(3));

  (server as any).handleStdin(b.client, stdinMessage(2, Buffer.from("123456"))); // 6 bytes
  (server as any).handleStdin(c.client, stdinMessage(3, Buffer.from("abcdef"))); // +6 bytes => overflow

  assert.ok(
    c.captured.json.some((m) => m?.type === "error" && m?.id === 3 && m?.code === "payload_too_large"),
    "expected payload_too_large error"
  );

  // Exec 3 should have been cancelled/removed from queue
  assert.ok(!(server as any).inflight.has(3));
  assert.ok(!(server as any).stdinAllowed.has(3));
  assert.ok(!(server as any).queuedStdin.has(3));
  assert.ok(!(server as any).queuedPtyResize.has(3));
  assert.ok(!(server as any).execQueue.some((e: any) => e.message.id === 3));

  assert.equal((server as any).queuedStdinBytesTotal, 6);

  // Ensure we can still queue more stdin for exec 2 within the global limit.
  (server as any).handleStdin(b.client, stdinMessage(2, Buffer.from("xx"))); // +2 bytes
  assert.equal((server as any).queuedStdinBytesTotal, 8);

  // Finishing exec 1 should not start exec 3
  bridge.onMessage({ v: 1, t: "exec_response", id: 1, p: { exit_code: 0 } });

  assert.ok(
    !sent.some((m) => m.t === "exec_request" && m.id === 3),
    "exec 3 should not start after being cancelled"
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { decodeOutputFrame } from "../src/sandbox/control-protocol.ts";
import { SandboxServer } from "../src/sandbox/server.ts";
import type { ResolvedSandboxServerOptions } from "../src/sandbox/server-options.ts";

function makeResolvedOptions(
  overrides: Partial<ResolvedSandboxServerOptions> = {},
): ResolvedSandboxServerOptions {
  return {
    vmm: "qemu",
    qemuPath: "/bin/false",
    krunRunnerPath: "gondolin-krun-runner",
    kernelPath: "/tmp/vmlinuz",
    initrdPath: "/tmp/initramfs.cpio",
    rootfsPath: "/tmp/rootfs.ext4",

    rootDiskPath: "/tmp/rootfs.ext4",
    rootDiskFormat: "raw",
    rootDiskReadOnly: false,

    memory: "256M",
    cpus: 1,
    virtioSocketPath: "/tmp/gondolin-test-virtio.sock",
    virtioFsSocketPath: "/tmp/gondolin-test-virtiofs.sock",
    virtioSshSocketPath: "/tmp/gondolin-test-virtiossh.sock",
    virtioIngressSocketPath: "/tmp/gondolin-test-virtioingress.sock",
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
    ssh: undefined,
    tcp: undefined,
    mitmCertDir: undefined,
    vfsProvider: null,

    ...overrides,
  };
}

test("pty output normalization repairs CRCR to CRLF without backend-specific logic", () => {
  const server = new SandboxServer(makeResolvedOptions());

  const binaryFrames: Buffer[] = [];
  const client = {
    sendJson: () => true,
    sendBinary: (data: Buffer) => {
      binaryFrames.push(data);
      return true;
    },
    close: () => {},
  };

  (server as any).inflight.set(7, client);
  (server as any).ptyExecIds.add(7);

  (server as any).bridge.onMessage({
    v: 1,
    t: "exec_output",
    id: 7,
    p: {
      stream: "stdout",
      data: Buffer.from("foo\r\r", "utf8"),
    },
  });

  (server as any).bridge.onMessage({
    v: 1,
    t: "exec_response",
    id: 7,
    p: {
      exit_code: 0,
    },
  });

  const output = binaryFrames
    .map((frame) => decodeOutputFrame(frame).data.toString("utf8"))
    .join("");

  assert.equal(output, "foo\r\n");
});

test("pty output normalization leaves regular CRLF output unchanged", () => {
  const server = new SandboxServer(makeResolvedOptions());

  const binaryFrames: Buffer[] = [];
  const client = {
    sendJson: () => true,
    sendBinary: (data: Buffer) => {
      binaryFrames.push(data);
      return true;
    },
    close: () => {},
  };

  (server as any).inflight.set(11, client);
  (server as any).ptyExecIds.add(11);

  (server as any).bridge.onMessage({
    v: 1,
    t: "exec_output",
    id: 11,
    p: {
      stream: "stdout",
      data: Buffer.from("bar\r\n", "utf8"),
    },
  });

  const output = binaryFrames
    .map((frame) => decodeOutputFrame(frame).data.toString("utf8"))
    .join("");

  assert.equal(output, "bar\r\n");
});

test("pty output normalization collapses CRCRLF to a single CRLF", () => {
  const server = new SandboxServer(makeResolvedOptions());

  const binaryFrames: Buffer[] = [];
  const client = {
    sendJson: () => true,
    sendBinary: (data: Buffer) => {
      binaryFrames.push(data);
      return true;
    },
    close: () => {},
  };

  (server as any).inflight.set(12, client);
  (server as any).ptyExecIds.add(12);

  (server as any).bridge.onMessage({
    v: 1,
    t: "exec_output",
    id: 12,
    p: {
      stream: "stdout",
      data: Buffer.from("baz\r\r\n", "utf8"),
    },
  });

  const output = binaryFrames
    .map((frame) => decodeOutputFrame(frame).data.toString("utf8"))
    .join("");

  assert.equal(output, "baz\r\n");
});

test("pty output normalization drops a split trailing LF after CRCR across frames", () => {
  const server = new SandboxServer(makeResolvedOptions());

  const binaryFrames: Buffer[] = [];
  const client = {
    sendJson: () => true,
    sendBinary: (data: Buffer) => {
      binaryFrames.push(data);
      return true;
    },
    close: () => {},
  };

  (server as any).inflight.set(13, client);
  (server as any).ptyExecIds.add(13);

  (server as any).bridge.onMessage({
    v: 1,
    t: "exec_output",
    id: 13,
    p: {
      stream: "stdout",
      data: Buffer.from("qux\r\r", "utf8"),
    },
  });

  (server as any).bridge.onMessage({
    v: 1,
    t: "exec_output",
    id: 13,
    p: {
      stream: "stdout",
      data: Buffer.from("\nend", "utf8"),
    },
  });

  const output = binaryFrames
    .map((frame) => decodeOutputFrame(frame).data.toString("utf8"))
    .join("");

  assert.equal(output, "qux\r\nend");
});

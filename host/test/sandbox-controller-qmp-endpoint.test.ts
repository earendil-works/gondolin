import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test as controllerTest } from "../src/sandbox/controller.ts";
import type { SandboxConfig } from "../src/sandbox/controller.ts";

const { defaultUnixQmpEndpoint, reserveEphemeralTcpEndpoint, resolveDefaultQmpEndpoint } =
  controllerTest as any;

function baseConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    qemuPath: "qemu-system-x86_64",
    kernelPath: "/tmp/vmlinuz",
    initrdPath: "/tmp/initrd",
    memory: "256M",
    cpus: 1,
    virtioSocketPath: "/tmp/virtio.sock",
    virtioFsSocketPath: "/tmp/virtiofs.sock",
    virtioSshSocketPath: "/tmp/virtio-ssh.sock",
    virtioIngressSocketPath: "/tmp/virtio-ingress.sock",
    append: "console=ttyS0",
    machineType: "q35",
    autoRestart: false,
    ...overrides,
  };
}

test(
  "defaultUnixQmpEndpoint places the qmp socket next to the virtio socket",
  { skip: process.platform === "win32" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-qmp-endpoint-test-"));
    const endpoint = defaultUnixQmpEndpoint(
      baseConfig({ virtioSocketPath: path.join(dir, "virtio.sock") }),
    );
    assert.equal(endpoint.transport, "unix");
    assert.equal(path.dirname(endpoint.path), dir);
    assert.match(path.basename(endpoint.path), /^gondolin-qmp-[0-9a-f]{8}\.sock$/);
  },
);

test("reserveEphemeralTcpEndpoint returns a real, currently-free loopback port", async () => {
  const endpoint = await reserveEphemeralTcpEndpoint("127.0.0.1");
  assert.equal(endpoint.transport, "tcp");
  assert.equal(endpoint.host, "127.0.0.1");
  assert.ok(endpoint.port > 0 && endpoint.port < 65536);

  // The port was released after reservation, so a fresh listener should be
  // able to bind it immediately (accepting the same small TOCTOU window the
  // production code accepts).
  const net = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(endpoint.port, endpoint.host, () => {
      server.close(() => resolve());
    });
  });
});

test(
  "resolveDefaultQmpEndpoint returns a unix endpoint off Windows",
  { skip: process.platform === "win32" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-qmp-endpoint-test-"));
    const endpoint = await resolveDefaultQmpEndpoint(
      baseConfig({ virtioSocketPath: path.join(dir, "virtio.sock") }),
    );
    assert.equal(endpoint.transport, "unix");
    assert.equal(path.dirname(endpoint.path), dir);
  },
);

test(
  "resolveDefaultQmpEndpoint returns a reserved loopback tcp endpoint on Windows",
  { skip: process.platform !== "win32" },
  async () => {
    const endpoint = await resolveDefaultQmpEndpoint(
      baseConfig({
        virtioSocketPath: { transport: "tcp", host: "127.0.0.1", port: 0 },
      }),
    );
    assert.equal(endpoint.transport, "tcp");
    assert.equal(endpoint.host, "127.0.0.1");
    assert.ok(endpoint.port > 0);
  },
);

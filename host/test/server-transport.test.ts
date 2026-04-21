import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { SandboxServer } from "../src/sandbox/server.ts";
import {
  FunctionBridgeTransport,
  StreamTransport,
  UnixSocketTransport,
  type ServerTransport,
} from "../src/sandbox/server-transport.ts";
import type { ResolvedSandboxServerOptions } from "../src/sandbox/server-options.ts";
import {
  FrameReader,
  decodeMessage,
  encodeFrame,
} from "../src/sandbox/virtio-protocol.ts";

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

class ScriptedWritable extends EventEmitter {
  writable = true;
  writes: Buffer[] = [];
  private readonly writeResults: boolean[];

  constructor(writeResults: boolean[]) {
    super();
    this.writeResults = [...writeResults];
  }

  write(chunk: Buffer | string): boolean {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return this.writeResults.shift() ?? true;
  }

  destroy(): void {
    this.writable = false;
  }
}

class ScriptedFunctionBridge extends EventEmitter {
  writes: Buffer[] = [];
  private readonly writeResults: boolean[];
  private readonly frameListeners = new Set<
    (frame: Buffer | Uint8Array) => void
  >();

  constructor(writeResults: boolean[]) {
    super();
    this.writeResults = [...writeResults];
  }

  sendFrame(frame: Buffer): boolean {
    this.writes.push(Buffer.from(frame));
    return this.writeResults.shift() ?? true;
  }

  subscribeFrame(listener: (frame: Buffer | Uint8Array) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  subscribeWritable(listener: () => void): () => void {
    this.on("writable", listener);
    return () => {
      this.off("writable", listener);
    };
  }

  emitWritable(): void {
    this.emit("writable");
  }

  pushInboundFrame(frame: Buffer): void {
    for (const listener of this.frameListeners) {
      listener(frame);
    }
  }
}

function decodeFrames(chunks: Buffer[]): any[] {
  const reader = new FrameReader();
  const messages: any[] = [];
  for (const chunk of chunks) {
    reader.push(chunk, (frame) => {
      messages.push(decodeMessage(frame));
    });
  }
  return messages;
}

async function runBackpressureScenario(create: () => {
  transport: ServerTransport;
  triggerWritable: () => void;
  readWrites: () => any[];
  cleanup: () => Promise<void>;
}): Promise<{ writes: any[]; writableCalls: number }> {
  const { transport, triggerWritable, readWrites, cleanup } = create();

  const message = { v: 1, t: "exec_window", id: 1, p: { stdout: 1 } };

  let writableCalls = 0;
  transport.onWritable = () => {
    writableCalls += 1;
  };

  assert.equal(transport.send(message), true);
  assert.equal(transport.send(message), true);
  assert.equal(transport.send(message), false);

  triggerWritable();

  const writes = readWrites();
  await cleanup();
  return { writes, writableCalls };
}

test("StreamTransport encodes outbound frames and decodes inbound frames", async () => {
  const input = new PassThrough();
  const output = new PassThrough();

  const transport = new StreamTransport({ input, output });
  const outboundChunks: Buffer[] = [];
  const inboundMessages: any[] = [];

  output.on("data", (chunk: Buffer | string) => {
    outboundChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  transport.onMessage = (message) => {
    inboundMessages.push(message);
  };

  transport.connect();

  const outbound = { v: 1, t: "exec_window", id: 7, p: { stdout: 32 } };
  assert.equal(transport.send(outbound), true);

  const outboundDecoded = decodeFrames(outboundChunks);
  assert.equal(outboundDecoded.length, 1);
  assert.equal(outboundDecoded[0].t, "exec_window");
  assert.equal(outboundDecoded[0].id, 7);

  const inbound = { v: 1, t: "stdin_window", id: 7, p: { stdin: 64 } };
  input.write(encodeFrame(inbound));
  assert.deepEqual(inboundMessages, [inbound]);

  await transport.disconnect();
});

test("Stream, unix-socket, and function-bridge transports keep backpressure parity", async () => {
  const message = { v: 1, t: "exec_window", id: 2, p: { stdout: 1 } };
  const frameSize = encodeFrame(message).length;

  const streamResult = await runBackpressureScenario(() => {
    const input = new PassThrough();
    const sink = new ScriptedWritable([false, true]);
    const transport = new StreamTransport(
      {
        input,
        output: sink as unknown as NodeJS.WritableStream,
      },
      frameSize,
    );

    return {
      transport,
      triggerWritable: () => sink.emit("drain"),
      readWrites: () => decodeFrames(sink.writes),
      cleanup: () => transport.disconnect(),
    };
  });

  const unixResult = await runBackpressureScenario(() => {
    const sink = new ScriptedWritable([false, true]);
    const transport = new UnixSocketTransport(
      "/tmp/gondolin-test-unused.sock",
      frameSize,
    );
    (transport as any).attachSocket(sink);

    return {
      transport,
      triggerWritable: () => sink.emit("drain"),
      readWrites: () => decodeFrames(sink.writes),
      cleanup: () => transport.disconnect(),
    };
  });

  const functionResult = await runBackpressureScenario(() => {
    const bridge = new ScriptedFunctionBridge([false, true]);
    const transport = new FunctionBridgeTransport(
      {
        sendFrame: (frame) => bridge.sendFrame(frame),
        subscribeFrame: (listener) => bridge.subscribeFrame(listener),
        subscribeWritable: (listener) => bridge.subscribeWritable(listener),
      },
      frameSize,
    );

    return {
      transport,
      triggerWritable: () => bridge.emitWritable(),
      readWrites: () => decodeFrames(bridge.writes),
      cleanup: () => transport.disconnect(),
    };
  });

  assert.deepEqual(streamResult.writes, unixResult.writes);
  assert.deepEqual(functionResult.writes, unixResult.writes);
  assert.equal(streamResult.writableCalls, 1);
  assert.equal(unixResult.writableCalls, 1);
  assert.equal(functionResult.writableCalls, 1);
});

test("FunctionBridgeTransport carries PTY exec and resize frames without stdio framing hacks", async () => {
  const guestReader = new FrameReader();
  const guestInbound: any[] = [];
  const hostInboundListeners = new Set<(frame: Buffer | Uint8Array) => void>();

  const transport = new FunctionBridgeTransport({
    sendFrame: (frame) => {
      guestReader.push(frame, (payload) => {
        guestInbound.push(decodeMessage(payload));
      });
      return true;
    },
    subscribeFrame: (listener) => {
      hostInboundListeners.add(listener);
      return () => {
        hostInboundListeners.delete(listener);
      };
    },
  });

  const hostMessages: any[] = [];
  transport.onMessage = (message) => {
    hostMessages.push(message);
  };

  transport.connect();

  assert.equal(
    transport.send({
      v: 1,
      t: "exec_request",
      id: 9,
      p: {
        cmd: "/bin/bash",
        argv: ["-i"],
        stdin: true,
        pty: true,
      },
    }),
    true,
  );
  assert.equal(
    transport.send({
      v: 1,
      t: "pty_resize",
      id: 9,
      p: {
        rows: 40,
        cols: 120,
      },
    }),
    true,
  );

  assert.equal(guestInbound.length, 2);
  assert.equal(guestInbound[0]?.t, "exec_request");
  assert.equal(guestInbound[0]?.p?.pty, true);
  assert.equal(guestInbound[1]?.t, "pty_resize");

  const guestSend = (message: object) => {
    const frame = encodeFrame(message);
    for (const listener of hostInboundListeners) {
      listener(frame);
    }
  };

  guestSend({
    v: 1,
    t: "exec_output",
    id: 9,
    p: {
      stream: "stdout",
      data: Buffer.from("bash-5.2$ "),
    },
  });
  guestSend({
    v: 1,
    t: "exec_response",
    id: 9,
    p: {
      exit_code: 0,
    },
  });

  assert.equal(hostMessages.length, 2);
  assert.equal(hostMessages[0]?.t, "exec_output");
  assert.equal(hostMessages[1]?.t, "exec_response");

  await transport.disconnect();
});

test("SandboxServer supports injected stream transports", async () => {
  const channels = {
    control: { input: new PassThrough(), output: new PassThrough() },
    fs: { input: new PassThrough(), output: new PassThrough() },
    ssh: { input: new PassThrough(), output: new PassThrough() },
    ingress: { input: new PassThrough(), output: new PassThrough() },
  };

  const server = new SandboxServer(makeResolvedOptions(), {
    transportFactory: ({ name, maxPendingBytes }) =>
      new StreamTransport(channels[name], maxPendingBytes),
  } as any);

  assert.ok((server as any).bridge instanceof StreamTransport);
  assert.ok((server as any).fsBridge instanceof StreamTransport);
  assert.ok((server as any).sshBridge instanceof StreamTransport);
  assert.ok((server as any).ingressBridge instanceof StreamTransport);

  await Promise.all([
    (server as any).bridge.disconnect(),
    (server as any).fsBridge.disconnect(),
    (server as any).sshBridge.disconnect(),
    (server as any).ingressBridge.disconnect(),
  ]);
});

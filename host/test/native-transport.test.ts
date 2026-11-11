import assert from "node:assert/strict";
import test from "node:test";

import {
  type NativeConnection,
  NativeFrameReader,
  NativeRequestError,
  NativeTransport,
  encodeNativeFrame,
  resolveNativeBinary,
  spawnNativeConnection,
  stripUndefined,
} from "../src/native/transport.ts";
import { nativeDaemonCommand } from "../src/native/binary.ts";
import { resolveSandboxEngine } from "../src/native/config.ts";
import { shouldSkipVmTests, skipOnFirecracker } from "./helpers/vm-fixture.ts";

function findBinary(): string | null {
  try {
    return resolveNativeBinary();
  } catch {
    return null;
  }
}

const binary = findBinary();

test("native frame reader reassembles split and coalesced frames", () => {
  const a = encodeNativeFrame({
    v: 1,
    t: "a",
    id: 1,
    p: { data: Buffer.from("xy") },
  });
  const b = encodeNativeFrame({ v: 1, t: "b", id: 0, p: {} });
  const all = Buffer.concat([a, b]);
  const frames: Buffer[] = [];
  const reader = new NativeFrameReader();
  for (let i = 0; i < all.length; i += 3) {
    reader.push(all.subarray(i, i + 3), (frame) => frames.push(frame));
  }
  assert.equal(frames.length, 2);
  const bad = Buffer.alloc(4);
  bad.writeUInt32BE(4 * 1024 * 1024 + 1, 0);
  assert.throws(() => new NativeFrameReader().push(bad, () => {}), /too large/);
});

test("stripUndefined drops undefined keys but keeps buffers", () => {
  const data = Buffer.from("z");
  assert.deepEqual(
    stripUndefined({ a: undefined, b: { c: undefined, d: 1 }, data }),
    {
      b: { d: 1 },
      data,
    },
  );
});

test("resolveSandboxEngine: native and auto select native, node throws", () => {
  assert.equal(resolveSandboxEngine(undefined, {}), "native");
  assert.equal(resolveSandboxEngine("auto", {}), "native");
  assert.equal(
    resolveSandboxEngine(undefined, { GONDOLIN_ENGINE: "native" }),
    "native",
  );
  assert.equal(
    resolveSandboxEngine("native", { GONDOLIN_ENGINE: "auto" }),
    "native",
  );
  assert.throws(
    () => resolveSandboxEngine("node", {}),
    /the node engine has been removed/,
  );
  assert.throws(
    () => resolveSandboxEngine(undefined, { GONDOLIN_ENGINE: "node" }),
    /the node engine has been removed/,
  );
  assert.throws(
    () => resolveSandboxEngine("rust", {}),
    /invalid sandbox engine/,
  );
});

test("gondolind handshake, validation and shutdown", {
  skip: binary ? false : "gondolind binary not built",
  timeout: 30_000,
}, async () => {
  const transport = new NativeTransport(binary!);
  try {
    const hello = await transport.hello;
    assert.equal(hello.protocol, 1);
    assert.ok(hello.features.includes("exec"));

    // start before configure is refused
    await assert.rejects(transport.request("start"), (err: unknown) => {
      assert.ok(err instanceof NativeRequestError);
      assert.equal(err.code, "invalid_state");
      return true;
    });

    // unknown request types are answered with `unsupported`
    await assert.rejects(
      transport.request("bogus"),
      /unsupported message type: bogus/,
    );

    await assert.rejects(
      transport.request("configure", { vm: { qemu_path: "x" } }),
      /invalid configure/,
    );

    await transport.request("configure", {
      vm: {
        qemu_path: "/nonexistent/qemu-system-aarch64",
        kernel_path: "/k",
        initrd_path: "/i",
        memory: "256M",
        cpus: 1,
      },
    });
    // a missing VMM binary fails the session start with a clear error
    await assert.rejects(
      transport.request("start"),
      /cannot run \/nonexistent\/qemu-system-aarch64/,
    );

    await transport.request("shutdown");
    const { code } = await transport.exited;
    assert.equal(code, 0);
  } finally {
    await transport.close(2000);
  }
});

test("native engine rejects options it cannot honour yet", async () => {
  const { assertNativeSupported } = await import("../src/native/config.ts");
  const resolved = { vmm: "qemu" } as any;
  assert.doesNotThrow(() => assertNativeSupported(resolved, {}));
  assert.doesNotThrow(() => assertNativeSupported({ vmm: "krun" } as any, {}));
  assert.throws(
    () => assertNativeSupported(resolved, { virtioSocketPath: "/tmp/x.sock" }),
    /not supported: sandbox.virtioSocketPath/,
  );
});

test("gondolind resolves an image selector and boots it", {
  skip: !binary
    ? "gondolind binary not built"
    : shouldSkipVmTests()
      ? "hardware virtualization unavailable"
      : // the selector resolves a published image, without vsock support
        skipOnFirecracker("published images built before vsock support"),
  timeout: 60_000,
}, async () => {
  const transport = new NativeTransport(binary!);
  try {
    await transport.hello;
    const configured = await transport.request("configure", {
      vm: {
        image: "",
        memory: "512M",
        cpus: 1,
        console: "none",
        root_disk: { snapshot: true },
      },
    });
    assert.equal(typeof configured.image.kernel, "string");
    assert.equal(typeof configured.image.rootfs, "string");
    await transport.request("start");
    const output: Buffer[] = [];
    transport.onMessage("exec_output", (p) => output.push(p.data));
    const done = new Promise<any>((resolve) =>
      transport.onMessage("exec_response", resolve),
    );
    transport.send("client_open", { client: 1 });
    transport.send("boot", { client: 1 });
    transport.send("exec", {
      client: 1,
      id: 1,
      cmd: "/bin/echo",
      argv: ["booted"],
    });
    const response = await done;
    assert.equal(response.exit_code, 0);
    assert.equal(Buffer.concat(output).toString(), "booted\n");
    await transport.request("shutdown");
  } finally {
    await transport.close(5000);
  }
});

test("transport works over a pi-env style connection (async writes)", {
  skip: binary ? false : "gondolind binary not built",
  timeout: 30_000,
}, async () => {
  const inner = spawnNativeConnection(nativeDaemonCommand(binary!));
  let writes = 0;
  // openProcess-like: promise-returning write, stdout/stderr callbacks, no kill
  const connection: NativeConnection = {
    write: (data) =>
      new Promise<void>((resolve) => {
        writes += 1;
        inner.write(data);
        setImmediate(resolve);
      }),
    onStdout: (listener) => inner.onStdout(listener),
    onStderr: (listener) => inner.onStderr?.(listener),
    close: () => inner.close(),
    exited: inner.exited,
  };
  const transport = new NativeTransport(connection);
  try {
    const hello = await transport.hello;
    assert.equal(hello.protocol, 1);
    assert.equal(transport.pid, null);
    await assert.rejects(
      transport.request("bogus"),
      /unsupported message type/,
    );
    await transport.request("shutdown");
    assert.ok(writes >= 2);
    const { code } = await transport.exited;
    assert.equal(code, 0);
  } finally {
    await transport.close(2000);
  }
});

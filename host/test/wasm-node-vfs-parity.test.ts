import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { VM } from "../src/vm/core.ts";
import { MemoryProvider, RealFSProvider } from "../src/vfs/node/index.ts";
import { scheduleForceExit } from "./helpers/vm-fixture.ts";

const wasmPath = process.env.GONDOLIN_TEST_WASM_PATH?.trim();
const skipReason = wasmPath
  ? false
  : "set GONDOLIN_TEST_WASM_PATH to run wasm-node parity tests";
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);
const startTimeoutMs = Math.max(
  1,
  Number(process.env.GONDOLIN_WASM_VFS_PARITY_START_TIMEOUT_MS ?? 90000),
);

function wasmSandboxOptions() {
  if (!wasmPath) {
    throw new Error("GONDOLIN_TEST_WASM_PATH is required");
  }

  return {
    vmm: "wasm-node" as const,
    wasmPath,
  };
}

test.after(() => {
  scheduleForceExit();
});

test(
  "wasm-node vfs parity: memfs round-trip",
  { skip: skipReason, timeout: timeoutMs },
  async () => {
    const provider = new MemoryProvider();
    const hostFile = await provider.open("/from-host.txt", "w+");
    await hostFile.writeFile("memfs-ok");
    await hostFile.close();

    const vm = await VM.create({
      startTimeoutMs,
      sandbox: wasmSandboxOptions(),
      vfs: {
        mounts: {
          "/": provider,
        },
      },
    });

    try {
      await vm.start();

      const read = await vm.exec(["/bin/sh", "-lc", "cat /data/from-host.txt"]);
      assert.equal(read.exitCode, 0);
      assert.equal(read.stdout.trim(), "memfs-ok");

      const write = await vm.exec([
        "/bin/sh",
        "-lc",
        "echo -n memfs-guest > /data/from-guest.txt",
      ]);
      assert.equal(write.exitCode, 0);

      const guestFile = await provider.open("/from-guest.txt", "r");
      const guestData = await guestFile.readFile({ encoding: "utf8" });
      await guestFile.close();
      assert.equal(guestData, "memfs-guest");
    } finally {
      await vm.close();
    }
  },
);

test(
  "wasm-node vfs parity: hostfs round-trip",
  { skip: skipReason, timeout: timeoutMs },
  async () => {
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-wasm-hostfs-"));
    fs.writeFileSync(path.join(hostDir, "from-host.txt"), "hostfs-ok");

    const provider = new RealFSProvider(hostDir);
    const vm = await VM.create({
      startTimeoutMs,
      sandbox: wasmSandboxOptions(),
      vfs: {
        mounts: {
          "/": provider,
        },
      },
    });

    try {
      await vm.start();

      const read = await vm.exec(["/bin/sh", "-lc", "cat /data/from-host.txt"]);
      assert.equal(read.exitCode, 0);
      assert.equal(read.stdout.trim(), "hostfs-ok");

      const write = await vm.exec([
        "/bin/sh",
        "-lc",
        "echo -n hostfs-guest > /data/from-guest.txt",
      ]);
      assert.equal(write.exitCode, 0);

      const guestData = fs.readFileSync(path.join(hostDir, "from-guest.txt"), "utf8");
      assert.equal(guestData, "hostfs-guest");
    } finally {
      await vm.close();
      fs.rmSync(hostDir, { recursive: true, force: true });
    }
  },
);

class TracingProvider extends MemoryProvider {
  openCalls: string[] = [];

  override async open(
    filePath: string,
    flags: string | number,
    mode?: number,
  ) {
    this.openCalls.push(`${filePath}:${String(flags)}`);
    return await super.open(filePath, flags, mode);
  }
}

test(
  "wasm-node vfs parity: custom provider round-trip",
  { skip: skipReason, timeout: timeoutMs },
  async () => {
    const provider = new TracingProvider();
    const hostFile = await provider.open("/custom.txt", "w+");
    await hostFile.writeFile("custom-ok");
    await hostFile.close();

    const vm = await VM.create({
      startTimeoutMs,
      sandbox: wasmSandboxOptions(),
      vfs: {
        mounts: {
          "/": provider,
        },
      },
    });

    try {
      await vm.start();

      const read = await vm.exec(["/bin/sh", "-lc", "cat /data/custom.txt"]);
      assert.equal(read.exitCode, 0);
      assert.equal(read.stdout.trim(), "custom-ok");

      const write = await vm.exec([
        "/bin/sh",
        "-lc",
        "echo -n custom-guest > /data/custom-out.txt",
      ]);
      assert.equal(write.exitCode, 0);

      const guestFile = await provider.open("/custom-out.txt", "r");
      const guestData = await guestFile.readFile({ encoding: "utf8" });
      await guestFile.close();
      assert.equal(guestData, "custom-guest");
      assert.ok(
        provider.openCalls.some((entry) => entry.startsWith("/custom-out.txt:")),
      );
    } finally {
      await vm.close();
    }
  },
);

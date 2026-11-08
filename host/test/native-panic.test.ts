/**
 * Panic containment in gondolind (native engine, debug builds): panics are
 * injected at chosen points with `GONDOLIND_TEST_PANICS=1` (see
 * `native/crates/gondolind/src/panics.rs`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  NativeTransport,
  resolveNativeBinary,
} from "../src/native/transport.ts";
import { VM } from "../src/vm/core.ts";
import { scheduleForceExit, shouldSkipVmTests } from "./helpers/vm-fixture.ts";

process.env.GONDOLIND_TEST_PANICS = "1";

async function skipReason(): Promise<string | false> {
  if (shouldSkipVmTests()) return "hardware virtualization unavailable";
  let binary: string;
  try {
    binary = resolveNativeBinary();
  } catch {
    return "gondolind binary not built";
  }
  const transport = new NativeTransport(binary);
  try {
    const hello = await transport.hello;
    if (!hello.features.includes("test_panics")) {
      return "gondolind without test hooks (release build)";
    }
    return false;
  } finally {
    await transport.close(2000);
  }
}

const skip = await skipReason();

test.after(() => {
  scheduleForceExit();
});

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a panicking flow resets that connection; the VM and other flows keep working", {
  skip,
  timeout: 120_000,
}, async () => {
  const vm = await VM.create({
    sandbox: { console: "none" },
    httpHooks: {
      isIpAllowed: () => true,
      onRequest: () => new Response("still-fine\n"),
    },
  });
  try {
    for (let i = 0; i < 5; i += 1) {
      const broken = await vm.exec([
        "/bin/sh",
        "-c",
        "curl -sS -m 10 http://203.0.113.5:9/; echo exit=$?",
      ]);
      // reset by the daemon (connect failure 7 or recv reset 56) instead of a
      // clean close (52, "empty reply") or a hang until the timeout (28)
      assert.match(
        broken.stdout,
        /exit=(7|55|56)\b/,
        broken.stdout + broken.stderr,
      );
    }
    const fine = await vm.exec([
      "/bin/sh",
      "-c",
      "curl -sS -m 10 http://203.0.113.5/",
    ]);
    assert.equal(fine.exitCode, 0, fine.stderr);
    assert.equal(fine.stdout, "still-fine\n");
  } finally {
    await vm.close();
  }
});

test("a panicking VFS request fails with EIO; the mount keeps working", {
  skip,
  timeout: 120_000,
}, async () => {
  const vm = await VM.create({ sandbox: { console: "none" } });
  try {
    const broken = await vm.exec(["/bin/ls", "/data/gondolind-test-panic"]);
    assert.notEqual(broken.exitCode, 0);
    assert.match(broken.stderr, /I\/O error/);
    const fine = await vm.exec(["/bin/ls", "/etc/gondolin"]);
    assert.equal(fine.exitCode, 0, fine.stderr);
    assert.match(fine.stdout, /listeners/);
  } finally {
    await vm.close();
  }
});

test("a session panic stops the VM and the daemon (fail closed)", {
  skip,
  timeout: 120_000,
}, async () => {
  const vm = await VM.create({ sandbox: { console: "none" } });
  const server = (vm as any).server;
  const exits: any[] = [];
  server.on("exit", (info: unknown) => exits.push(info));
  server.on("error", () => {});
  try {
    await vm.start();
    const qemuPid = server.getHostPid() as number;
    const daemonPid = server.getDaemonPid() as number;
    assert.ok(alive(qemuPid) && alive(daemonPid));

    await assert.rejects(vm.exec(["gondolind-test-panic"]).result);

    for (let i = 0; i < 100 && (alive(qemuPid) || alive(daemonPid)); i += 1) {
      await delay(50);
    }
    assert.equal(alive(qemuPid), false, "qemu must be killed");
    assert.equal(alive(daemonPid), false, "the daemon must exit");
    const reported = exits.find((e) =>
      String(e?.error ?? "").includes("session task panicked"),
    );
    assert.ok(
      reported,
      `exit with a reason expected, got ${JSON.stringify(exits)}`,
    );
  } finally {
    await vm.close().catch(() => {});
  }
});

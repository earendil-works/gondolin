import assert from "node:assert/strict";
import test from "node:test";

import { VM } from "../src/vm";
import { VmCheckpoint } from "../src/checkpoint";
import { shouldSkipVmTests, scheduleForceExit } from "./helpers/vm-fixture";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);

test.after(() => {
  scheduleForceExit();
});

test("disk checkpoints can be cloned (qcow2 backing)", { skip: skipVmTests, timeout: timeoutMs }, async () => {
  let base: VM | null = null;
  let checkpoint: any = null;
  let clone1: VM | null = null;
  let clone2: VM | null = null;
  let fresh: VM | null = null;

  try {
    base = await VM.create({
      vfs: null,
      sandbox: {
        console: "none",
        netEnabled: false,
      },
    });

    // Materialize a recognizable file on the root disk.
    const write = await base!.exec(["/bin/sh", "-c", "echo base > /etc/checkpoint.txt"]);
    assert.equal(write.exitCode, 0);

    checkpoint = await base!.checkpoint(`test-${Date.now()}`);
    base = null;

    // Ensure checkpoints can be reloaded from disk.
    checkpoint = VmCheckpoint.load(checkpoint.dir);

    // Clone 1 sees the base file
    clone1 = await checkpoint.clone({
      vfs: null,
      sandbox: {
        console: "none",
        netEnabled: false,
      },
    });
    const r1 = await clone1.exec(["/bin/cat", "/etc/checkpoint.txt"]);
    assert.equal(r1.stdout.trim(), "base");

    // Modify clone 1
    const m1 = await clone1.exec(["/bin/sh", "-c", "echo clone1 > /etc/checkpoint.txt"]);
    assert.equal(m1.exitCode, 0);
    await clone1.close();
    clone1 = null;

    // Clone 2 should not see clone1's change
    clone2 = await checkpoint.clone({
      vfs: null,
      sandbox: {
        console: "none",
        netEnabled: false,
      },
    });
    const r2 = await clone2.exec(["/bin/cat", "/etc/checkpoint.txt"]);
    assert.equal(r2.stdout.trim(), "base");
    await clone2.close();
    clone2 = null;

    // A fresh VM must not see checkpoint writes (base image stays clean)
    fresh = await VM.create({ vfs: null, sandbox: { console: "none", netEnabled: false } });
    const r3 = await fresh.exec(["/bin/sh", "-c", "test ! -f /etc/checkpoint.txt"]);
    assert.equal(r3.exitCode, 0);
    await fresh.close();
    fresh = null;

    checkpoint.delete();
    checkpoint = null;
  } finally {
    if (base) await base.close().catch(() => undefined);
    if (clone1) await clone1.close().catch(() => undefined);
    if (clone2) await clone2.close().catch(() => undefined);
    if (fresh) await fresh.close().catch(() => undefined);
    if (checkpoint) {
      try {
        checkpoint.delete();
      } catch {
        // ignore
      }
    }
  }
});

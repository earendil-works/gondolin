import assert from "node:assert/strict";
import test from "node:test";

import { closeVm, withVm, shouldSkipVmTests, scheduleForceExit } from "./helpers/vm-fixture";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 60000);
const vmKey = "exec-backpressure";
const vmOptions = {
  server: { console: "none" },
};

test.after(async () => {
  await closeVm(vmKey);
  scheduleForceExit();
});

function makeSpamCommand(lines: number) {
  // ~65 bytes per line -> 20k lines ~1.3MB
  return [
    "/bin/sh",
    "-lc",
    `for i in $(seq 1 ${lines}); do echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done`,
  ] as const;
}

test(
  "exec buffered mode continues without deadlocking (window updates on receipt)",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(vmKey, vmOptions, async (vm) => {
      await vm.start();
      const result = await vm.exec(makeSpamCommand(5000), { windowBytes: 4096 });
      assert.equal(result.exitCode, 0);
      assert.ok(result.stdout.length > 4096, "expected stdout > window size");
    });
  }
);

test(
  "exec pipe mode applies backpressure (stdout buffer bounded by window)",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    await withVm(vmKey, vmOptions, async (vm) => {
      await vm.start();

      const windowBytes = 4096;
      const proc = vm.exec(makeSpamCommand(20000), {
        stdout: "pipe",
        stderr: "ignore",
        windowBytes,
      });

      const stdout = proc.stdout;
      assert.ok(stdout, "expected stdout to be piped");

      let received = 0;
      let maxBuffered = 0;

      // Throttle consumption: pause after each chunk, resume shortly after.
      stdout.on("data", (chunk: Buffer) => {
        received += chunk.length;
        maxBuffered = Math.max(maxBuffered, stdout.readableLength);
        stdout.pause();
        setTimeout(() => stdout.resume(), 2);
      });

      await new Promise<void>((resolve, reject) => {
        stdout.once("end", () => resolve());
        stdout.once("error", (err) => reject(err));
      });

      const result = await proc;
      assert.equal(result.exitCode, 0);
      assert.ok(received > 1024 * 1024, `expected to receive >1MiB, got ${received}`);

      // We expect the internal readable buffer to remain bounded.
      // Allow a little slack for Node stream bookkeeping.
      assert.ok(
        maxBuffered <= windowBytes + 1024,
        `expected max buffered <= ${windowBytes + 1024}, got ${maxBuffered}`
      );
    });
  }
);

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
  // ~65 bytes per line
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
      const proc = vm.exec(makeSpamCommand(12000), {
        stdout: "pipe",
        stderr: "ignore",
        windowBytes,
      });

      const stdout = proc.stdout;
      assert.ok(stdout, "expected stdout to be piped");

      let received = 0;
      let maxBuffered = 0;

      // Throttle consumption enough to trigger host↔guest backpressure, but avoid
      // a timer-per-chunk strategy (slow/flaky on loaded CI runners).
      const pauseEveryBytes = 64 * 1024;
      let sincePause = 0;
      let ended = false;
      let paused = false;

      stdout.on("data", (chunk: Buffer) => {
        received += chunk.length;
        sincePause += chunk.length;
        maxBuffered = Math.max(maxBuffered, stdout.readableLength);

        if (!paused && sincePause >= pauseEveryBytes) {
          paused = true;
          sincePause = 0;
          stdout.pause();
          setTimeout(() => {
            paused = false;
            if (!ended) stdout.resume();
          }, 2);
        }
      });

      await new Promise<void>((resolve, reject) => {
        stdout.once("end", () => {
          ended = true;
          resolve();
        });
        stdout.once("error", (err) => reject(err));
      });

      const result = await proc;
      assert.equal(result.exitCode, 0);
      assert.ok(received > 512 * 1024, `expected to receive >512KiB, got ${received}`);

      // We expect the internal readable buffer to remain bounded.
      // Allow a little slack for Node stream bookkeeping.
      assert.ok(
        maxBuffered <= windowBytes + 1024,
        `expected max buffered <= ${windowBytes + 1024}, got ${maxBuffered}`
      );
    });
  }
);

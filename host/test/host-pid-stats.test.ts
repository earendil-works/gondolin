import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { VM } from "../src/vm/core.ts";
import { scheduleForceExit, shouldSkipVmTests } from "./helpers/vm-fixture.ts";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 60000);
const startTimeoutMs = Math.max(
  1,
  Number(process.env.GONDOLIN_HOST_PID_START_TIMEOUT_MS ?? 30000),
);

function readHostPidStats(pid: number): string {
  if (process.platform === "win32") {
    return execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId,ParentProcessId,WorkingSetSize,VirtualSize,CommandLine | Format-List`,
      ],
      { encoding: "utf8" },
    );
  }

  return execFileSync(
    "ps",
    ["-o", "pid,ppid,rss,vsz,pcpu,pmem,etime,command", "-p", String(pid)],
    { encoding: "utf8" },
  );
}

function assertHostPidStats(stats: string, pid: number): void {
  if (process.platform === "win32") {
    assert.match(stats, new RegExp(`ProcessId\\s+:\\s+${pid}\\b`));
    assert.match(stats, /CommandLine\s+:/);
    return;
  }

  assert.match(
    stats,
    /^\s*PID\s+PPID\s+RSS\s+VSZ\s+%CPU\s+%MEM\s+ELAPSED\s+COMMAND/m,
  );
  assert.match(stats, new RegExp(`\\b${pid}\\b`));
}

test.after(() => {
  scheduleForceExit();
});

test(
  "VM.getHostPid exposes a pid that can be sampled by host process tools",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    const vm = await VM.create({
      startTimeoutMs,
      sandbox: { console: "none" },
    });

    try {
      await vm.start();

      const pid = vm.getHostPid();
      assert.equal(typeof pid, "number");
      assert.ok(pid > 0, "expected a positive host pid");

      const stats = readHostPidStats(pid);
      console.log(`host process stats for VM host pid ${pid}:\n${stats}`);
      assertHostPidStats(stats, pid);
    } finally {
      await vm.close();
    }
  },
);

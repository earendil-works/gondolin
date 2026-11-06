import type { VM } from "../../src/index.ts";
import { createVm, enginePids } from "../lib/engine.ts";
import { type Bench, MiB, mbps } from "../lib/harness.ts";

export async function execSuite(bench: Bench) {
  const names = [
    "rtt-sh",
    "rtt-argv",
    "concurrent",
    "stdout-throughput",
    "stdin-throughput",
  ];
  if (!names.some((n) => bench.matches(`exec.${n}`))) return;
  let vm: VM;
  try {
    vm = await createVm();
    await vm.exec("true");
  } catch (err) {
    bench.fail("exec.setup", err);
    return;
  }
  const pids = () => enginePids(vm);

  try {
    await bench.run({
      name: "exec.rtt-sh",
      params: { command: 'exec("true")', shell: "/bin/sh -lc" },
      warmup: 10,
      iterations: bench.q(200, 20),
      run: async () => {
        const r = await vm.exec("true");
        if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`);
      },
    });

    await bench.run({
      name: "exec.rtt-argv",
      params: { command: '["/bin/true"]' },
      warmup: 10,
      iterations: bench.q(200, 20),
      run: async () => {
        const r = await vm.exec(["/bin/true"]);
        if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`);
      },
    });

    const concurrency = 16;
    await bench.run({
      name: "exec.concurrent",
      params: { command: '["/bin/true"]', concurrency },
      warmup: 2,
      iterations: bench.q(20, 3),
      units: { execsPerSec: "ops/s" },
      run: async () => {
        const t0 = performance.now();
        const results = await Promise.all(
          Array.from({ length: concurrency }, () => vm.exec(["/bin/true"])),
        );
        const ms = performance.now() - t0;
        if (results.some((r) => r.exitCode !== 0))
          throw new Error("exec failed");
        return { execsPerSec: concurrency / (ms / 1000) };
      },
    });

    const stdoutBytes = bench.q(256, 32) * MiB;
    await bench.run({
      name: "exec.stdout-throughput",
      params: {
        command: `dd if=/dev/zero bs=1M count=${stdoutBytes / MiB}`,
        bytes: stdoutBytes,
        stdout: "pipe (stream consumed)",
      },
      warmup: 1,
      iterations: bench.q(5, 2),
      cost: true,
      enginePids: pids,
      units: { MBps: "MB/s" },
      run: async (_i, signal) => {
        const t0 = performance.now();
        const proc = vm.exec(
          ["/bin/dd", "if=/dev/zero", "bs=1M", `count=${stdoutBytes / MiB}`],
          {
            stdout: "pipe",
            stderr: "ignore",
            signal,
          },
        );
        let received = 0;
        for await (const chunk of proc.stdout!)
          received += (chunk as Buffer).length;
        const r = await proc;
        const ms = performance.now() - t0;
        if (r.exitCode !== 0 || received !== stdoutBytes)
          throw new Error(`exit ${r.exitCode}, got ${received} bytes`);
        return { MBps: mbps(stdoutBytes, ms) };
      },
    });

    const stdinBytes = bench.q(256, 32) * MiB;
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    await bench.run({
      name: "exec.stdin-throughput",
      iterations: bench.q(5, 2),
      params: {
        command: "wc -c",
        bytes: stdinBytes,
        chunkBytes: chunk.length,
        stdin: "async iterable",
      },
      warmup: 1,
      cost: true,
      enginePids: pids,
      units: { MBps: "MB/s" },
      run: async (_i, signal) => {
        async function* input() {
          for (let sent = 0; sent < stdinBytes; sent += chunk.length)
            yield chunk;
        }
        const t0 = performance.now();
        const r = await vm.exec(["/usr/bin/wc", "-c"], {
          stdin: input(),
          signal,
        });
        const ms = performance.now() - t0;
        if (r.exitCode !== 0 || Number(r.stdout.trim()) !== stdinBytes) {
          throw new Error(
            `exit ${r.exitCode}, guest counted ${r.stdout.trim()}`,
          );
        }
        return { MBps: mbps(stdinBytes, ms) };
      },
    });
  } finally {
    await vm.close().catch(() => {});
  }
}

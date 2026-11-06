import type { VM } from "../../src/index.ts";
import { createVm } from "../lib/engine.ts";
import type { Bench } from "../lib/harness.ts";

/** Fresh VM per iteration: `VM.create` until the first `exec("true")` completes, then close */
export async function bootSuite(bench: Bench) {
  let vm: VM | null = null;
  await bench.run({
    name: "boot.create-to-first-exec",
    params: { command: "true", options: "defaults, console none" },
    warmup: 1,
    iterations: 10,
    timeoutMs: 300_000,
    run: async () => {
      const t0 = performance.now();
      vm = await createVm();
      const firstExecStart = performance.now();
      const r = await vm.exec("true");
      if (r.exitCode !== 0) throw new Error(`exec failed: ${r.exitCode}`);
      const bootMs = performance.now() - t0;
      const firstExecMs = performance.now() - firstExecStart;
      const c0 = performance.now();
      await vm.close();
      vm = null;
      const closeMs = performance.now() - c0;
      return {
        wallMs: bootMs,
        createMs: firstExecStart - t0,
        firstExecMs,
        closeMs,
      };
    },
  });
  if (vm) await (vm as VM).close().catch(() => {});
}

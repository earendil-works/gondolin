import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { getEngine, isVirtiofsEngine } from "../lib/engine.ts";
import type { Bench } from "../lib/harness.ts";

const execFileAsync = promisify(execFile);
const NODE_CLI = path.join(
  import.meta.dirname,
  "..",
  "..",
  "bin",
  "gondolin.ts",
);

type Cli = { label: string; command: string[]; env: Record<string, string> };

/**
 * `gondolin exec -- true` wall time per CLI: the static CLI
 * (`GONDOLIN_NATIVE_BIN`, the multi-call binary) and the node CLI. Cold runs
 * use a fresh `XDG_CACHE_HOME` (MITM CA, QEMU probe
 * cache, sessions); warm runs share one after a warmup. The guest image comes
 * from `GONDOLIN_GUEST_DIR` either way, so nothing is downloaded.
 */
export async function cliSuite(bench: Bench) {
  const engine = getEngine();
  if (isVirtiofsEngine(engine)) return;
  const clis: Cli[] = [
    { label: "exec-true", command: [staticCli()], env: {} },
    {
      label: "node-cli-exec-true",
      command: [process.execPath, NODE_CLI],
      env: {},
    },
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-bench-cli-"));
  try {
    for (const cli of clis) {
      const run = async (cacheDir: string, signal: AbortSignal) => {
        const [file, ...args] = cli.command;
        await execFileAsync(file, [...args, "exec", "--", "true"], {
          env: { ...process.env, ...cli.env, XDG_CACHE_HOME: cacheDir },
          signal,
        });
      };
      const params = {
        cli: cli.command.map((c) => path.basename(c)).join(" "),
        env: cli.env,
        command: "gondolin exec -- true",
      };
      await bench.run({
        name: `cli.${cli.label}.cold`,
        params: { ...params, cache: "fresh XDG_CACHE_HOME per run" },
        warmup: 1,
        iterations: 10,
        run: async (i, signal) =>
          run(path.join(tmp, `${cli.label}-cold-${i}`), signal),
      });
      const warm = path.join(tmp, `${cli.label}-warm`);
      await bench.run({
        name: `cli.${cli.label}.warm`,
        params: { ...params, cache: "shared XDG_CACHE_HOME" },
        warmup: 2,
        iterations: 20,
        run: async (_i, signal) => run(warm, signal),
      });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function staticCli(): string {
  const bin = process.env.GONDOLIN_NATIVE_BIN;
  if (!bin)
    throw new Error(
      "GONDOLIN_NATIVE_BIN must point at the static gondolin binary",
    );
  return bin;
}

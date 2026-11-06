/**
 * Gondolin engine benchmarks.
 *
 *   node bench/run.ts [--engine node|native] [--suite boot,exec,vfs,net]
 *                     [--quick] [--iterations N] [--filter substr]
 *                     [--out dir] [--no-save] [--summary-only]
 *
 * See bench/README.md.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { machineInfo, resolveEngine, setEngine } from "./lib/engine.ts";
import { Bench } from "./lib/harness.ts";
import { type RunFile, loadRuns, renderSummary } from "./lib/summary.ts";
import { bootSuite } from "./suites/boot.ts";
import { execSuite } from "./suites/exec.ts";
import { netSuite } from "./suites/net.ts";
import { vfsSuite } from "./suites/vfs.ts";

const SUITES: Record<string, (bench: Bench) => Promise<void>> = {
  boot: bootSuite,
  exec: execSuite,
  vfs: vfsSuite,
  net: netSuite,
};

const { values } = parseArgs({
  options: {
    engine: { type: "string" },
    suite: { type: "string" },
    quick: { type: "boolean", default: false },
    iterations: { type: "string" },
    filter: { type: "string" },
    out: { type: "string" },
    "no-save": { type: "boolean", default: false },
    "summary-only": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
  process.exit(0);
}

const outDir = path.resolve(
  values.out ?? path.join(import.meta.dirname, "results"),
);

function writeSummary() {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "SUMMARY.md"),
    renderSummary(loadRuns(outDir)),
  );
  console.log(`summary: ${path.join(outDir, "SUMMARY.md")}`);
}

if (values["summary-only"]) {
  writeSummary();
  process.exit(0);
}

const engine = resolveEngine(values.engine);
setEngine(engine);
const suites = (values.suite ?? Object.keys(SUITES).join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
for (const suite of suites) {
  if (!SUITES[suite])
    throw new Error(
      `unknown suite '${suite}' (have: ${Object.keys(SUITES).join(", ")})`,
    );
}

const machine = machineInfo();
console.log(
  `engine=${engine} suites=${suites.join(",")} quick=${values.quick}`,
);
console.log(
  `machine: ${machine.cpuModel} x${machine.cpuCount}, ${machine.platform} ${machine.osRelease}, node ${machine.node}, ${machine.qemu}`,
);

for (const suite of suites) {
  const bench = new Bench({
    quick: values.quick,
    iterations: values.iterations ? Number(values.iterations) : undefined,
    filter: values.filter,
    log: (line) => console.log(line),
  });
  const startedAt = new Date();
  console.log(`[${suite}]`);
  try {
    await SUITES[suite](bench);
  } catch (err) {
    bench.fail(`${suite}.suite`, err);
  }
  const run: RunFile = {
    version: 1,
    engine,
    suite,
    quick: values.quick,
    filter: values.filter ?? null,
    iterations: values.iterations ? Number(values.iterations) : null,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    machine,
    workloads: bench.results,
  };
  if (!values["no-save"]) {
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
    const file = path.join(
      outDir,
      `${engine}-${suite}${values.quick ? "-quick" : ""}-${stamp}.json`,
    );
    fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
    console.log(`wrote ${file}`);
  }
}

if (!values["no-save"]) writeSummary();
// Lingering sockets or timers from a failed workload must not keep us alive.
process.exit(0);

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Summary statistics over a list of samples */
export type Stats = {
  n: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
};

/** Unit of a metric; decides how ratios are read in the summary */
export type Unit = "ms" | "MB/s" | "ops/s" | "MB" | "count";

export type MetricResult = { unit: Unit; stats: Stats; samples: number[] };

/** Per-process resource usage over the measured iterations of a workload */
export type ProcessCost = {
  /** process role (`host` for this node process, else the command name) */
  role: string;
  pid: number;
  /** user + system cpu time in `ms` */
  cpuMs: number | null;
  /** peak resident set size in `MB` (sampled) */
  rssPeakMB: number | null;
};

export type WorkloadResult = {
  name: string;
  params: Record<string, unknown>;
  warmup: number;
  iterations: number;
  metrics: Record<string, MetricResult>;
  /** resource usage of the host and engine processes during measured iterations */
  cost?: ProcessCost[];
  error?: string;
  /** total wall time spent on the workload including warmups in `ms` */
  totalMs: number;
  /** host 1-minute load average when the workload started */
  loadAvg?: number;
};

export function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0)
    return { n, median: NaN, p95: NaN, min: NaN, max: NaN, mean: NaN };
  const q = (p: number) => {
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  return {
    n,
    median: q(0.5),
    p95: q(0.95),
    min: sorted[0],
    max: sorted[n - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / n,
  };
}

/** Values one iteration reports: metric name -> sample (single value or several) */
export type IterationOutput = Record<string, number | number[]> | void;

export type WorkloadSpec = {
  name: string;
  params?: Record<string, unknown>;
  warmup?: number;
  iterations?: number;
  /** per-workload timeout in `ms` (all iterations together) */
  timeoutMs?: number;
  /** metric units; metrics not listed default to `ms` */
  units?: Record<string, Unit>;
  /** whether to sample host/engine RSS and cpu (`true` for throughput workloads) */
  cost?: boolean;
  /** pids of engine processes to account for (resolved lazily) */
  enginePids?: () => Promise<number[]>;
  /** runs before every iteration, not timed */
  before?: (i: number) => Promise<void>;
  /** runs after every iteration, not timed */
  after?: (i: number) => Promise<void>;
  /**
   * One iteration. `wallMs` is measured around it unless the iteration
   * reports its own `wallMs`.
   */
  run: (i: number, signal: AbortSignal) => Promise<IterationOutput>;
};

export type RunOptions = {
  quick: boolean;
  /** iteration override (`--iterations`) */
  iterations?: number;
  /** regex filter on workload names */
  filter?: string;
  log: (line: string) => void;
};

export class WorkloadTimeoutError extends Error {}

export class Bench {
  readonly results: WorkloadResult[] = [];
  readonly options: RunOptions;
  constructor(options: RunOptions) {
    this.options = options;
  }

  /** Whether a workload name passes `--filter` (suites use it to skip setup) */
  matches(name: string): boolean {
    return !this.options.filter || new RegExp(this.options.filter).test(name);
  }

  /** Scale a full-run value down for `--quick` */
  q<T>(full: T, quick: T): T {
    return this.options.quick ? quick : full;
  }

  /** Record a failure that prevented a group of workloads from running */
  fail(name: string, err: unknown) {
    const error = formatError(err);
    this.options.log(`  ${name}: FAILED ${error}`);
    this.results.push({
      name,
      params: {},
      warmup: 0,
      iterations: 0,
      metrics: {},
      error,
      totalMs: 0,
    });
  }

  async run(spec: WorkloadSpec): Promise<WorkloadResult | null> {
    const { log } = this.options;
    if (!this.matches(spec.name)) return null;
    const warmup = this.options.quick
      ? Math.min(spec.warmup ?? 1, 1)
      : (spec.warmup ?? 1);
    const iterations =
      this.options.iterations ??
      (this.options.quick
        ? Math.min(spec.iterations ?? 10, 3)
        : (spec.iterations ?? 10));
    const result: WorkloadResult = {
      name: spec.name,
      params: spec.params ?? {},
      warmup,
      iterations,
      metrics: {},
      totalMs: 0,
      loadAvg: Math.round(os.loadavg()[0] * 100) / 100,
    };
    const samples: Record<string, number[]> = {};
    const controller = new AbortController();
    const started = performance.now();
    const timeoutMs = spec.timeoutMs ?? 600_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new WorkloadTimeoutError(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });

    let sampler: CostSampler | null = null;
    const body = async () => {
      for (let i = 0; i < warmup + iterations; i++) {
        const measured = i >= warmup;
        if (measured && i === warmup && spec.cost) {
          sampler = new CostSampler((await spec.enginePids?.()) ?? []);
          await sampler.start();
        }
        await spec.before?.(i);
        const t0 = performance.now();
        const out = await spec.run(i, controller.signal);
        const wallMs = performance.now() - t0;
        await spec.after?.(i);
        if (!measured) continue;
        const values: Record<string, number | number[]> = {
          wallMs,
          ...(out ?? {}),
        };
        for (const [key, value] of Object.entries(values)) {
          (samples[key] ??= []).push(
            ...(Array.isArray(value) ? value : [value]),
          );
        }
      }
    };

    try {
      await Promise.race([body(), timeout]);
    } catch (err) {
      result.error = formatError(err);
    } finally {
      clearTimeout(timer);
      if (sampler) result.cost = await (sampler as CostSampler).stop();
    }
    result.totalMs = performance.now() - started;
    for (const [key, values] of Object.entries(samples)) {
      result.metrics[key] = {
        unit: spec.units?.[key] ?? "ms",
        stats: computeStats(values),
        samples: values.map((v) => Math.round(v * 1000) / 1000),
      };
    }
    this.results.push(result);
    log(`  ${formatResultLine(result)}`);
    return result;
  }
}

function formatResultLine(r: WorkloadResult): string {
  const parts = Object.entries(r.metrics)
    .filter(
      ([key]) =>
        key !== "wallMs" ||
        Object.keys(r.metrics).length === 1 ||
        !("guestMs" in r.metrics),
    )
    .map(
      ([key, m]) =>
        `${key}=${fmt(m.stats.median)}${m.unit === "ms" ? "ms" : ` ${m.unit}`} (p95 ${fmt(m.stats.p95)})`,
    );
  const err = r.error ? ` ERROR ${r.error}` : "";
  return `${r.name}: ${parts.join(", ")}${err}`;
}

export function fmt(v: number): string {
  if (!Number.isFinite(v)) return "-";
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export function formatError(err: unknown): string {
  if (err instanceof Error)
    return err.message.split("\n").slice(0, 5).join(" | ");
  return String(err);
}

// --- process accounting ----------------------------------------------------

type ProcSample = { cpuMs: number | null; rssMB: number | null; comm: string };

/** Read cpu time and rss of a process (`/proc` on Linux, `ps` elsewhere) */
export async function readProcess(pid: number): Promise<ProcSample | null> {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[11]) + Number(fields[12]);
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? NaN);
      return { cpuMs: (ticks * 1000) / 100, rssMB: rssKb / 1024, comm };
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", [
      "-o",
      "rss=,time=,comm=",
      "-p",
      String(pid),
    ]);
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(stdout.trim());
    if (!m) return null;
    return {
      rssMB: Number(m[1]) / 1024,
      cpuMs: parseCpuTime(m[2]),
      comm: m[3].split("/").pop() ?? m[3],
    };
  } catch {
    return null;
  }
}

/** Parse `ps` cpu time (`[[dd-]hh:]mm:ss[.cc]`) into `ms` */
export function parseCpuTime(text: string): number {
  let days = 0;
  let rest = text;
  const dash = rest.indexOf("-");
  if (dash >= 0) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return (days * 86400 + seconds) * 1000;
}

/** List a pid and all of its descendants */
export async function processTree(rootPid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="]);
    const children = new Map<number, number[]>();
    for (const line of stdout.trim().split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)!.push(pid);
    }
    const out: number[] = [];
    const queue = [rootPid];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      out.push(pid);
      queue.push(...(children.get(pid) ?? []));
    }
    return out;
  } catch {
    return [rootPid];
  }
}

/** Samples cpu and peak rss of this process and the engine processes */
class CostSampler {
  private readonly pids: number[];
  private readonly startCpu = new Map<number, number | null>();
  private readonly peak = new Map<number, number>();
  private readonly comm = new Map<number, string>();
  private hostCpu0: NodeJS.CpuUsage | null = null;
  private hostRssPeak = 0;
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;

  constructor(pids: number[]) {
    this.pids = pids.filter((pid) => pid !== process.pid);
  }

  async start() {
    this.hostCpu0 = process.cpuUsage();
    this.hostRssPeak = process.memoryUsage.rss();
    for (const pid of this.pids) {
      const s = await readProcess(pid);
      this.startCpu.set(pid, s?.cpuMs ?? null);
      if (s) this.comm.set(pid, s.comm);
      if (s?.rssMB != null) this.peak.set(pid, s.rssMB);
    }
    this.timer = setInterval(() => void this.sample(), 250);
  }

  private async sample() {
    this.hostRssPeak = Math.max(this.hostRssPeak, process.memoryUsage.rss());
    if (this.sampling) return;
    this.sampling = true;
    try {
      for (const pid of this.pids) {
        const s = await readProcess(pid);
        if (s?.rssMB != null)
          this.peak.set(pid, Math.max(this.peak.get(pid) ?? 0, s.rssMB));
      }
    } finally {
      this.sampling = false;
    }
  }

  async stop(): Promise<ProcessCost[]> {
    if (this.timer) clearInterval(this.timer);
    const hostCpu = process.cpuUsage(this.hostCpu0 ?? undefined);
    this.hostRssPeak = Math.max(this.hostRssPeak, process.memoryUsage.rss());
    const out: ProcessCost[] = [
      {
        role: "host",
        pid: process.pid,
        cpuMs: (hostCpu.user + hostCpu.system) / 1000,
        rssPeakMB: this.hostRssPeak / (1024 * 1024),
      },
    ];
    for (const pid of this.pids) {
      const s = await readProcess(pid);
      const c0 = this.startCpu.get(pid);
      const peak = Math.max(this.peak.get(pid) ?? 0, s?.rssMB ?? 0);
      out.push({
        role: this.comm.get(pid) ?? s?.comm ?? "engine",
        pid,
        cpuMs: s?.cpuMs != null && c0 != null ? s.cpuMs - c0 : null,
        rssPeakMB: peak || null,
      });
    }
    return out;
  }
}

/** Parse `<ns>` lines printed by guest timing wrappers into `ms` */
export function nsToMs(text: string): number {
  const value = Number(text.trim().split("\n").pop());
  if (!Number.isFinite(value))
    throw new Error(`unexpected guest timing output: ${text.slice(0, 200)}`);
  return value / 1e6;
}

export const MiB = 1024 * 1024;

export function mbps(bytes: number, ms: number): number {
  return bytes / MiB / (ms / 1000);
}

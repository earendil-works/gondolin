import fs from "fs";
import path from "path";

const PROFILE_DIR = process.env.GONDOLIN_WASM_PROFILE_DIR?.trim();
const TRACE_DIR = process.env.GONDOLIN_WASM_TRACE_DIR?.trim();
const ENABLED = Boolean(PROFILE_DIR || TRACE_DIR);
const PROCESS_START_NS = process.hrtime.bigint();
const PROCESS_START_ISO = new Date().toISOString();

type CounterSummary = {
  count: number;
  total: number;
  min: number;
  max: number;
};

type DurationSummary = {
  count: number;
  totalNs: bigint;
  minNs: bigint;
  maxNs: bigint;
};

function ensureDir(dir: string | undefined): string | null {
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function toMs(valueNs: bigint): number {
  return Number(valueNs) / 1_000_000;
}

function safeUnlink(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // ignore
  }
}

export class ProcessProfiler {
  /** profiler label used in output file names */
  readonly label: string;
  private readonly enabled: boolean;
  private readonly summaryPath: string | null;
  private readonly tracePath: string | null;
  private readonly counters = new Map<string, CounterSummary>();
  private readonly durations = new Map<string, DurationSummary>();
  private flushed = false;

  constructor(label: string) {
    this.label = label;
    this.enabled = ENABLED;

    const safeLabel = label.replace(/[^a-zA-Z0-9_.-]+/g, "-");
    const profileDir = ensureDir(PROFILE_DIR);
    const traceDir = ensureDir(TRACE_DIR);

    this.summaryPath = profileDir
      ? path.join(profileDir, `${safeLabel}-${process.pid}.summary.json`)
      : null;
    this.tracePath = traceDir
      ? path.join(traceDir, `${safeLabel}-${process.pid}.trace.ndjson`)
      : null;

    if (this.tracePath) {
      safeUnlink(this.tracePath);
    }

    process.once("exit", () => {
      this.flush();
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  count(name: string, value = 1): void {
    if (!this.enabled) return;
    this.observeCounter(name, value);
  }

  observe(name: string, value: number): void {
    if (!this.enabled) return;
    this.observeCounter(name, value);
  }

  duration(name: string, valueNs: bigint): void {
    if (!this.enabled) return;
    const entry = this.durations.get(name);
    if (entry) {
      entry.count += 1;
      entry.totalNs += valueNs;
      if (valueNs < entry.minNs) entry.minNs = valueNs;
      if (valueNs > entry.maxNs) entry.maxNs = valueNs;
      return;
    }

    this.durations.set(name, {
      count: 1,
      totalNs: valueNs,
      minNs: valueNs,
      maxNs: valueNs,
    });
  }

  startSpan(name: string, args?: Record<string, unknown>): () => void {
    if (!this.enabled) {
      return () => {};
    }

    const startNs = process.hrtime.bigint();
    this.trace("begin", name, args, startNs);
    return () => {
      const endNs = process.hrtime.bigint();
      this.duration(name, endNs - startNs);
      this.trace("end", name, args, endNs);
    };
  }

  traceInstant(name: string, args?: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.trace("instant", name, args, process.hrtime.bigint());
  }

  flush(): void {
    if (!this.enabled || this.flushed || !this.summaryPath) {
      this.flushed = true;
      return;
    }
    this.snapshot();
    this.flushed = true;
  }

  snapshot(): void {
    if (!this.enabled || !this.summaryPath) {
      return;
    }

    const nowNs = process.hrtime.bigint();
    const durations: Record<string, unknown> = {};
    for (const [name, entry] of this.durations) {
      durations[name] = {
        count: entry.count,
        totalMs: toMs(entry.totalNs),
        avgMs: toMs(entry.totalNs) / entry.count,
        minMs: toMs(entry.minNs),
        maxMs: toMs(entry.maxNs),
      };
    }

    const counters: Record<string, unknown> = {};
    for (const [name, entry] of this.counters) {
      counters[name] = {
        count: entry.count,
        total: entry.total,
        avg: entry.total / entry.count,
        min: entry.min,
        max: entry.max,
      };
    }

    const payload = {
      label: this.label,
      pid: process.pid,
      argv: process.argv,
      startTime: PROCESS_START_ISO,
      endTime: new Date().toISOString(),
      runtimeMs: toMs(nowNs - PROCESS_START_NS),
      counters,
      durations,
    };

    fs.writeFileSync(this.summaryPath, JSON.stringify(payload, null, 2) + "\n");
  }

  private observeCounter(name: string, value: number): void {
    const entry = this.counters.get(name);
    if (entry) {
      entry.count += 1;
      entry.total += value;
      if (value < entry.min) entry.min = value;
      if (value > entry.max) entry.max = value;
      return;
    }

    this.counters.set(name, {
      count: 1,
      total: value,
      min: value,
      max: value,
    });
  }

  private trace(
    kind: "begin" | "end" | "instant",
    name: string,
    args: Record<string, unknown> | undefined,
    timestampNs: bigint,
  ): void {
    if (!this.tracePath) return;

    const payload = {
      tsMs: toMs(timestampNs - PROCESS_START_NS),
      kind,
      name,
      pid: process.pid,
      label: this.label,
      args,
    };

    fs.appendFileSync(this.tracePath, JSON.stringify(payload) + "\n");
  }
}

const profilers = new Map<string, ProcessProfiler>();

export function getProcessProfiler(label: string): ProcessProfiler {
  let profiler = profilers.get(label);
  if (!profiler) {
    profiler = new ProcessProfiler(label);
    profilers.set(label, profiler);
  }
  return profiler;
}

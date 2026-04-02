#!/usr/bin/env node
import fs from "fs";
import os from "os";
import path from "path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

function usage(): never {
  console.error(
    [
      "usage: node scripts/profile-wasm-node.ts [options]",
      "",
      "Options:",
      "  --wasm PATH              wasm module path (defaults to GONDOLIN_TEST_WASM_PATH or GONDOLIN_WASM_PATH)",
      "  --profile-dir DIR        directory for per-process summary JSON (default: temp dir)",
      "  --trace-dir DIR          directory for optional per-process trace ndjson",
      "  --start-timeout-ms N     VM start timeout in ms (default: 90000)",
      "  --pty-lines N            line count for PTY throughput burst (default: 10000)",
      "  --window-bytes N         exec output window size in bytes (default: 262144)",
      "  --net-disabled           disable guest networking for the wasm VM",
      "  --help                   show this help",
    ].join("\n"),
  );
  process.exit(1);
}

type Options = {
  wasmPath: string;
  profileDir: string;
  traceDir?: string;
  startTimeoutMs: number;
  ptyLines: number;
  windowBytes: number;
  netEnabled: boolean;
};

function parseInteger(value: string, flag: string, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return Math.trunc(n) || fallback;
}

function parseArgs(argv: string[]): Options {
  let wasmPath = process.env.GONDOLIN_TEST_WASM_PATH?.trim();
  if (!wasmPath) {
    wasmPath = process.env.GONDOLIN_WASM_PATH?.trim();
  }

  let profileDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-wasm-profile-"),
  );
  let traceDir: string | undefined;
  let startTimeoutMs = 90_000;
  let ptyLines = 10_000;
  let windowBytes = 256 * 1024;
  let netEnabled = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      usage();
    }

    if (arg === "--net-disabled") {
      netEnabled = false;
      continue;
    }

    if (arg === "--wasm") {
      wasmPath = argv[++i]?.trim();
      if (!wasmPath) throw new Error("--wasm requires a path");
      continue;
    }
    if (arg.startsWith("--wasm=")) {
      wasmPath = arg.slice("--wasm=".length).trim();
      if (!wasmPath) throw new Error("--wasm requires a path");
      continue;
    }

    if (arg === "--profile-dir") {
      profileDir = argv[++i]?.trim() || "";
      if (!profileDir) throw new Error("--profile-dir requires a directory");
      continue;
    }
    if (arg.startsWith("--profile-dir=")) {
      profileDir = arg.slice("--profile-dir=".length).trim();
      if (!profileDir) throw new Error("--profile-dir requires a directory");
      continue;
    }

    if (arg === "--trace-dir") {
      traceDir = argv[++i]?.trim() || "";
      if (!traceDir) throw new Error("--trace-dir requires a directory");
      continue;
    }
    if (arg.startsWith("--trace-dir=")) {
      traceDir = arg.slice("--trace-dir=".length).trim();
      if (!traceDir) throw new Error("--trace-dir requires a directory");
      continue;
    }

    if (arg === "--start-timeout-ms") {
      startTimeoutMs = parseInteger(
        argv[++i] || "",
        "--start-timeout-ms",
        startTimeoutMs,
      );
      continue;
    }
    if (arg.startsWith("--start-timeout-ms=")) {
      startTimeoutMs = parseInteger(
        arg.slice("--start-timeout-ms=".length),
        "--start-timeout-ms",
        startTimeoutMs,
      );
      continue;
    }

    if (arg === "--pty-lines") {
      ptyLines = parseInteger(argv[++i] || "", "--pty-lines", ptyLines);
      continue;
    }
    if (arg.startsWith("--pty-lines=")) {
      ptyLines = parseInteger(
        arg.slice("--pty-lines=".length),
        "--pty-lines",
        ptyLines,
      );
      continue;
    }

    if (arg === "--window-bytes") {
      windowBytes = parseInteger(
        argv[++i] || "",
        "--window-bytes",
        windowBytes,
      );
      continue;
    }
    if (arg.startsWith("--window-bytes=")) {
      windowBytes = parseInteger(
        arg.slice("--window-bytes=".length),
        "--window-bytes",
        windowBytes,
      );
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  if (!wasmPath) {
    throw new Error(
      "wasm path is required (pass --wasm or set GONDOLIN_TEST_WASM_PATH)",
    );
  }

  fs.mkdirSync(profileDir, { recursive: true });
  if (traceDir) fs.mkdirSync(traceDir, { recursive: true });

  return {
    wasmPath,
    profileDir,
    traceDir,
    startTimeoutMs,
    ptyLines,
    windowBytes,
    netEnabled,
  };
}

type TimingResult = {
  name: string;
  durationMs: number;
  extra?: Record<string, unknown>;
};

type Waiter = {
  token: string;
  startMs: number;
  resolve: (value: { durationMs: number; bytesSinceStart: number }) => void;
  reject: (error: Error) => void;
};

class OutputProbe {
  private readonly startMs: number;
  private transcript = "";
  private totalBytes = 0;
  private firstOutputResolve: ((value: number) => void) | null = null;
  private firstOutputReject: ((error: Error) => void) | null = null;
  private firstOutputDone = false;
  private readonly waiters = new Set<Waiter>();
  readonly firstOutput: Promise<number>;
  readonly pumpDone: Promise<void>;

  constructor(proc: {
    output(): AsyncIterable<{ data: Buffer; text: string }>;
  }) {
    this.startMs = performance.now();
    this.firstOutput = new Promise<number>((resolve, reject) => {
      this.firstOutputResolve = resolve;
      this.firstOutputReject = reject;
    });

    this.pumpDone = (async () => {
      try {
        for await (const chunk of proc.output()) {
          if (!this.firstOutputDone) {
            this.firstOutputDone = true;
            this.firstOutputResolve?.(performance.now() - this.startMs);
            this.firstOutputResolve = null;
            this.firstOutputReject = null;
          }

          this.totalBytes += chunk.data.length;
          this.transcript += chunk.text;
          if (this.transcript.length > 256 * 1024) {
            this.transcript = this.transcript.slice(-256 * 1024);
          }

          for (const waiter of Array.from(this.waiters)) {
            if (this.transcript.includes(waiter.token)) {
              this.waiters.delete(waiter);
              waiter.resolve({
                durationMs: performance.now() - waiter.startMs,
                bytesSinceStart: this.totalBytes,
              });
            }
          }
        }

        if (!this.firstOutputDone) {
          this.firstOutputReject?.(new Error("exec completed before producing output"));
          this.firstOutputResolve = null;
          this.firstOutputReject = null;
        }

        for (const waiter of Array.from(this.waiters)) {
          waiter.reject(new Error(`token not observed before exec completed: ${waiter.token}`));
        }
        this.waiters.clear();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!this.firstOutputDone) {
          this.firstOutputReject?.(error);
          this.firstOutputResolve = null;
          this.firstOutputReject = null;
        }
        for (const waiter of Array.from(this.waiters)) {
          waiter.reject(error);
        }
        this.waiters.clear();
        throw error;
      }
    })();
  }

  getBytes(): number {
    return this.totalBytes;
  }

  waitForToken(token: string, startMs = performance.now()) {
    if (this.transcript.includes(token)) {
      return Promise.resolve({
        durationMs: performance.now() - startMs,
        bytesSinceStart: this.totalBytes,
      });
    }

    return new Promise<{ durationMs: number; bytesSinceStart: number }>(
      (resolve, reject) => {
        this.waiters.add({ token, startMs, resolve, reject });
      },
    );
  }
}

function markerToken(): { token: string; command: string } {
  const token = randomUUID();
  return {
    token: `\x1e${token}\x1f`,
    command: `printf '\\036${token}\\037\\n'`,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  process.env.GONDOLIN_WASM_PROFILE_DIR = options.profileDir;
  if (options.traceDir) {
    process.env.GONDOLIN_WASM_TRACE_DIR = options.traceDir;
  }

  const cpuProfEnabled = (process.env.NODE_OPTIONS || "").includes("--cpu-prof");

  const [{ VM }, { getProcessProfiler }] = await Promise.all([
    import("../src/vm/core.ts"),
    import("../src/utils/profile.ts"),
  ]);

  const hostProfiler = getProcessProfiler("wasm-host");
  const scriptProfiler = getProcessProfiler("wasm-profile-script");

  const results: TimingResult[] = [];

  console.log(`wasm path:    ${options.wasmPath}`);
  console.log(`profile dir:  ${options.profileDir}`);
  console.log(`net enabled:  ${options.netEnabled ? "yes" : "no"}`);
  if (options.traceDir) {
    console.log(`trace dir:    ${options.traceDir}`);
  }
  if (!cpuProfEnabled) {
    console.log(
      "cpu profiles: disabled (tip: run with NODE_OPTIONS='--cpu-prof --cpu-prof-dir=<dir>')",
    );
  }
  console.log("");

  const vm = await VM.create({
    startTimeoutMs: options.startTimeoutMs,
    sandbox: {
      vmm: "wasm-node",
      wasmPath: options.wasmPath,
      console: "none",
      netEnabled: options.netEnabled,
    },
  });

  try {
    const bootStart = performance.now();
    await vm.start();
    const bootMs = performance.now() - bootStart;
    results.push({ name: "boot", durationMs: bootMs });
    console.log(`boot:                 ${round(bootMs)} ms`);

    const execStart = performance.now();
    const execResult = await vm.exec("echo profile-ok");
    const execMs = performance.now() - execStart;
    results.push({
      name: "exec.echo",
      durationMs: execMs,
      extra: {
        exitCode: execResult.exitCode,
        stdout: execResult.stdout.trim(),
      },
    });
    console.log(`exec echo:            ${round(execMs)} ms`);

    const streamStart = performance.now();
    const streamResult = await vm.exec(
      `yes x | head -n ${options.ptyLines} | wc -c`,
      {
        stdout: "buffer",
        stderr: "buffer",
        windowBytes: options.windowBytes,
      },
    );
    const streamMs = performance.now() - streamStart;
    results.push({
      name: "exec.stream-throughput",
      durationMs: streamMs,
      extra: {
        stdout: streamResult.stdout.trim(),
      },
    });
    console.log(`exec stream burst:    ${round(streamMs)} ms`);

    const ptyStart = performance.now();
    const proc = vm.exec(["/bin/sh", "-i"], {
      stdin: true,
      pty: true,
      stdout: "pipe",
      stderr: "pipe",
      windowBytes: options.windowBytes,
    });
    const probe = new OutputProbe(proc);

    let firstOutputMs: number | null = null;
    try {
      firstOutputMs = await Promise.race([
        probe.firstOutput,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("timeout waiting for first PTY output")), 5_000).unref?.();
        }),
      ]);
    } catch {
      firstOutputMs = null;
    }

    const ready = markerToken();
    const readyStart = performance.now();
    proc.write(`${ready.command}\n`);
    const readyObserved = await probe.waitForToken(ready.token, readyStart);

    const ping = markerToken();
    const pingStart = performance.now();
    proc.write(`echo gondolin-pty >/dev/null; ${ping.command}\n`);
    const pingObserved = await probe.waitForToken(ping.token, pingStart);

    const throughput = markerToken();
    const burstStartBytes = probe.getBytes();
    const burstStart = performance.now();
    proc.write(`yes x | head -n ${options.ptyLines}; ${throughput.command}\n`);
    const throughputObserved = await probe.waitForToken(
      throughput.token,
      burstStart,
    );
    const burstBytes = probe.getBytes() - burstStartBytes;

    proc.write("exit\n");
    await proc.result;
    await probe.pumpDone;

    const ptyTotalMs = performance.now() - ptyStart;
    const burstBytesPerSec = burstBytes / Math.max(throughputObserved.durationMs / 1000, 0.001);

    results.push({
      name: "pty.session",
      durationMs: ptyTotalMs,
      extra: {
        firstOutputMs,
        readyRttMs: readyObserved.durationMs,
        pingRttMs: pingObserved.durationMs,
        burstDurationMs: throughputObserved.durationMs,
        burstBytes,
        burstBytesPerSec,
      },
    });

    console.log(
      `pty first output:     ${firstOutputMs === null ? "n/a" : `${round(firstOutputMs)} ms`}`,
    );
    console.log(`pty ready RTT:        ${round(readyObserved.durationMs)} ms`);
    console.log(`pty ping RTT:         ${round(pingObserved.durationMs)} ms`);
    console.log(
      `pty burst (${options.ptyLines}): ${round(throughputObserved.durationMs)} ms, ${Math.round(burstBytesPerSec)} B/s`,
    );
  } finally {
    await vm.close();
  }

  hostProfiler.flush();
  scriptProfiler.flush();

  const summaryFiles = fs
    .readdirSync(options.profileDir)
    .filter((entry) => entry.endsWith(".summary.json"))
    .map((entry) => path.join(options.profileDir, entry))
    .sort();

  console.log("\nscenario summary:");
  console.log(JSON.stringify(results, null, 2));

  if (summaryFiles.length > 0) {
    console.log("\nprocess profile summaries:");
    for (const filePath of summaryFiles) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        label: string;
        pid: number;
        durations?: Record<string, { totalMs: number; count: number }>;
        counters?: Record<string, { total: number; count: number }>;
      };

      console.log(`- ${parsed.label} (pid ${parsed.pid})`);

      const topDurations = Object.entries(parsed.durations ?? {})
        .sort((a, b) => (b[1].totalMs ?? 0) - (a[1].totalMs ?? 0))
        .slice(0, 8);
      for (const [name, stats] of topDurations) {
        console.log(
          `    duration ${name}: total=${round(stats.totalMs)} ms count=${stats.count}`,
        );
      }

      const topCounters = Object.entries(parsed.counters ?? {})
        .sort((a, b) => (b[1].total ?? 0) - (a[1].total ?? 0))
        .slice(0, 8);
      for (const [name, stats] of topCounters) {
        console.log(
          `    counter  ${name}: total=${round(stats.total)} count=${stats.count}`,
        );
      }
    }
  }
}

void main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  console.error(message);
  process.exit(1);
});

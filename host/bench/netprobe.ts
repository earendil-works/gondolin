/**
 * Ad-hoc network probe for profiling (not part of the suites): boots one VM
 * with the net suite's `policy` hooks and runs netclient.py workloads against
 * local upstreams, printing guest-measured numbers.
 *
 *   node bench/netprobe.ts [--engine node|native] [--repeat N]
 *                          [--work download,upload,https-download,seq,https-seq]
 *                          [--mib 64] [--hold]
 *
 * `--hold` keeps looping the workloads until interrupted (attach a profiler to
 * gondolind meanwhile). `NETPROBE_IDLE=N` keeps N idle guest TCP connections
 * open during the run (connection-count scaling). Workloads: netclient.py modes
 * (seq, keepalive, concurrent, download, upload), `https-` prefixed for TLS.
 */
import { parseArgs } from "node:util";

import { createHttpHooks } from "../src/index.ts";
import {
  createVm,
  installGuestTools,
  resolveEngine,
  setEngine,
  sh,
} from "./lib/engine.ts";
import { startUpstreams } from "./suites/net.ts";

const { values } = parseArgs({
  options: {
    engine: { type: "string" },
    work: {
      type: "string",
      default: "seq,download,upload,https-seq,https-download,https-upload",
    },
    mib: { type: "string", default: "64" },
    repeat: { type: "string", default: "3" },
    hold: { type: "boolean", default: false },
  },
});

setEngine(resolveEngine(values.engine));
const up = await startUpstreams();
const vm = await createVm({
  httpHooks: createHttpHooks({
    allowedHosts: ["localhost"],
    allowedInternalHosts: ["localhost"],
  }).httpHooks,
  maxHttpBodyBytes: 64 * 1024 * 1024,
});
try {
  await installGuestTools(vm);
  const bytes = Number(values.mib) * 1024 * 1024;
  const idle = Number(process.env.NETPROBE_IDLE ?? "0");
  if (idle > 0) {
    // Hold `idle` idle keep-alive connections open in the background.
    await vm.fs.writeFile(
      "/tmp/bench/idle.py",
      `import socket, time, resource
resource.setrlimit(resource.RLIMIT_NOFILE, (4096, 4096))
conns = [socket.create_connection(("203.0.113.5", ${up.ports.http})) for i in range(${idle})]
open("/tmp/bench/idle.ready", "w").close()
time.sleep(3600)
`,
    );
    await sh(
      vm,
      "rm -f /tmp/bench/idle.ready; (python3 /tmp/bench/idle.py >/dev/null 2>&1 &)",
    );
    await sh(vm, "while [ ! -e /tmp/bench/idle.ready ]; do sleep 0.1; done");
    console.log(
      `idle connections: ${(await sh(vm, "cat /proc/net/sockstat; pgrep -fl idle.py")).trim()}`,
    );
  }
  const run = async (w: string) => {
    const https = w.startsWith("https-");
    const mode = w.replace(/^https-/, "");
    const cfg = {
      scheme: https ? "https" : "http",
      host: "localhost",
      port: https ? up.ports.https : up.ports.http,
      ip: "203.0.113.5",
      mode,
      bytes,
      count: mode === "concurrent" ? 200 : 50,
      concurrency: 8,
      path: "/small",
    };
    const out = JSON.parse(
      await sh(
        vm,
        `SSL_CERT_FILE=/run/gondolin/ca-certificates.crt python3 /tmp/bench/netclient.py '${JSON.stringify(cfg)}'`,
      ),
    );
    if (out.requests) {
      return `${w}: ${(out.requests / (out.wallMs / 1000)).toFixed(0)} req/s`;
    }
    if (out.ms) {
      const ms = [...out.ms].sort((a: number, b: number) => a - b);
      return `${w}: median ${ms[ms.length >> 1].toFixed(2)} ms`;
    }
    return `${w}: ${(((bytes / out.wallMs) * 1000) / 1e6).toFixed(0)} MB/s (${out.wallMs.toFixed(0)} ms)`;
  };
  do {
    for (const w of values.work!.split(",")) {
      const results = [];
      for (let i = 0; i < Number(values.repeat); i++)
        results.push(await run(w));
      console.log(results.join(" | "));
    }
  } while (values.hold);
} finally {
  await vm.close();
  up.close();
}

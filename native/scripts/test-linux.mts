// Runs cross-compiled Linux test binaries inside a Gondolin VM (default engine).
//
// usage: node native/scripts/test-linux.mts <cargo-json-file> [skip-file]
//
// <cargo-json-file> is the `--message-format=json` output of
// `cargo test --no-run --target <linux-target>`. The repository is mounted
// read-only at its host path so compile-time paths (`CARGO_MANIFEST_DIR`,
// fixtures) resolve inside the guest; each binary runs with its package
// directory as cwd, like `cargo test`.
//
// The skip file lists `<test-binary> <test-name-filter>  # reason` lines
// (`*` as binary matches all); matching tests are passed as `--skip`.

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const { VM, RealFSProvider, ReadonlyProvider } = await import(
  path.join(repoRoot, "host/src/index.ts")
);

type TestBinary = {
  /** cargo target name, e.g. `tcp` or `gondolin_netstack` */
  name: string;
  /** package name */
  pkg: string;
  /** absolute path of the test executable */
  exe: string;
  /** package directory (cwd for the run) */
  cwd: string;
};

function readBinaries(file: string): TestBinary[] {
  const out: TestBinary[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    const msg = JSON.parse(line);
    if (msg.reason !== "compiler-artifact" || !msg.profile?.test || !msg.executable) continue;
    const pkg = String(msg.package_id).match(/#([^@/]+)@/)?.[1] ?? path.basename(path.dirname(msg.manifest_path));
    out.push({
      name: msg.target.name,
      pkg,
      exe: msg.executable,
      cwd: path.dirname(msg.manifest_path),
    });
  }
  return out;
}

function readSkips(file: string | undefined): Array<{ binary: string; filter: string; reason: string }> {
  if (!file || !fs.existsSync(file)) return [];
  const out = [];
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const [spec, reason = ""] = raw.split("#", 2);
    const parts = spec.trim().split(/\s+/);
    if (parts.length < 2 || !parts[0]) continue;
    out.push({ binary: parts[0], filter: parts[1], reason: reason.trim() });
  }
  return out;
}

const [jsonFile, skipFile] = process.argv.slice(2);
if (!jsonFile) {
  console.error("usage: test-linux.mts <cargo-json-file> [skip-file]");
  process.exit(2);
}
const binaries = readBinaries(jsonFile);
const skips = readSkips(skipFile);
if (binaries.length === 0) {
  console.error("no test binaries found");
  process.exit(2);
}

const vm = await VM.create({
  memory: "2G",
  cpus: 4,
  vfs: {
    mounts: {
      [repoRoot]: new ReadonlyProvider(new RealFSProvider(repoRoot)),
    },
  },
});

const results: Array<{ bin: TestBinary; code: number; ms: number }> = [];
try {
  const uname = await vm.exec("uname -sm");
  console.log(`guest: ${uname.stdout.trim()}`);
  for (const bin of binaries) {
    const skipArgs: string[] = [];
    for (const s of skips) {
      if (s.binary === "*" || s.binary === bin.name || s.binary === `${bin.pkg}/${bin.name}`) {
        skipArgs.push("--skip", s.filter);
        console.log(`  skipping ${bin.pkg}/${bin.name} ${s.filter}: ${s.reason}`);
      }
    }
    console.log(`\n==> ${bin.pkg}/${bin.name}`);
    const started = Date.now();
    const result = await vm.exec(
      ["/bin/sh", "-c", 'cd "$1" && shift && exec "$@"', "sh", bin.cwd, bin.exe, ...skipArgs],
      {
        stdout: process.stdout,
        stderr: process.stderr,
        env: {
          RUST_BACKTRACE: "1",
          CARGO_MANIFEST_DIR: bin.cwd,
          GONDOLIN_TEST_IN_GUEST: "1",
        },
      },
    );
    results.push({ bin, code: result.exitCode, ms: Date.now() - started });
  }
} finally {
  await vm.close();
}

console.log("\nsummary:");
let failed = 0;
for (const r of results) {
  const status = r.code === 0 ? "ok  " : "FAIL";
  if (r.code !== 0) failed++;
  console.log(`  ${status} ${r.bin.pkg}/${r.bin.name} (${(r.ms / 1000).toFixed(1)}s)`);
}
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

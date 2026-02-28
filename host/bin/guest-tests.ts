import fs from "fs";
import path from "path";
import crypto from "crypto";

import { VM } from "../src/vm/core.ts";

const MAX_STDIN_BYTES = 16 * 1024 * 1024;

const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  4: "SIGILL",
  5: "SIGTRAP",
  6: "SIGABRT",
  7: "SIGBUS",
  8: "SIGFPE",
  9: "SIGKILL",
  10: "SIGUSR1",
  11: "SIGSEGV",
  12: "SIGUSR2",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
};

function formatExitCode(exitCode: number): string {
  if (exitCode === 0) return "0";
  if (exitCode >= 128) {
    const sig = exitCode - 128;
    const name = SIGNAL_NAMES[sig];
    return name ? `${exitCode} (${name})` : `${exitCode} (signal ${sig})`;
  }
  return String(exitCode);
}

async function dumpGuestLogs(vm: VM, label: string) {
  // Segfaults in the guest often only show up in dmesg, not in the test
  // binary output. Grab a tail to make CI failures actionable.
  const commands: Array<{ title: string; cmd: string | string[] }> = [
    {
      title: `dmesg (tail) after ${label}`,
      cmd: ["/bin/sh", "-lc", "dmesg | tail -n 200 || true"],
    },
    {
      title: `/tmp listing after ${label}`,
      cmd: ["/bin/sh", "-lc", "ls -lah /tmp | tail -n 200 || true"],
    },
  ];

  for (const { title, cmd } of commands) {
    try {
      const r = await vm.exec(cmd, { stdout: "pipe", stderr: "pipe" });
      const out = `${r.stdout}${r.stderr}`.trimEnd();
      if (!out) continue;
      process.stderr.write(`\n----- ${title} -----\n`);
      process.stderr.write(out);
      process.stderr.write("\n----- end -----\n");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `\n----- ${title} (failed) -----\n${detail}\n----- end -----\n`,
      );
    }
  }
}

/**
 * Check if hardware virtualization is available.
 * On Linux, this checks for KVM. On macOS, HVF is always available.
 */
function hasHardwareAccel(): boolean {
  if (process.platform === "darwin") {
    return true;
  }
  if (process.platform === "linux") {
    try {
      fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function resolveRepoRoot() {
  return path.resolve(import.meta.dirname, "../..");
}

function defaultTestPaths(repoRoot: string) {
  return [
    {
      label: "module",
      hostPath: path.resolve(repoRoot, "guest/zig-out/bin/sandboxd-mod-tests"),
    },
    {
      label: "executable",
      hostPath: path.resolve(repoRoot, "guest/zig-out/bin/sandboxd-exe-tests"),
    },
  ];
}

async function runTest(vm: VM, label: string, payload: Buffer) {
  const guestPath = `/tmp/sandboxd-${label}-tests`;

  const expectedSize = payload.length;
  const expectedSha256 = crypto
    .createHash("sha256")
    .update(payload)
    .digest("hex");

  // If a test binary segfaults, we want to catch it in dmesg.
  // Enabling core dumps might help too (depends on guest settings).
  //
  // We also sanity-check that the uploaded binary matches what we intended to
  // execute (truncated/corrupted uploads can otherwise look like flaky segfaults).
  const command = [
    "/bin/sh",
    "-lc",
    [
      `ulimit -c unlimited || true`,
      `cat > ${guestPath}`,
      `actual_size=$(wc -c < ${guestPath} | tr -d '[:space:]' || true)`,
      `if [ "$actual_size" != "${expectedSize}" ]; then echo "short write to ${guestPath}: expected ${expectedSize} bytes, got $actual_size" 1>&2; exit 111; fi`,
      `if command -v sha256sum >/dev/null 2>&1; then echo "${expectedSha256}  ${guestPath}" | sha256sum -c -; fi`,
      `chmod +x ${guestPath}`,
      `${guestPath}`,
    ].join(" && "),
  ];

  const proc = vm.exec(command, {
    stdin: payload,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Stream output as it arrives
  for await (const chunk of proc.output()) {
    if (chunk.stream === "stdout") {
      process.stdout.write(chunk.data);
    } else {
      process.stderr.write(chunk.data);
    }
  }

  const result = await proc;
  if (result.exitCode !== 0) {
    await dumpGuestLogs(vm, label);
    throw new Error(
      `guest ${label} tests failed with exit code ${formatExitCode(result.exitCode)}`,
    );
  }
}

async function main() {
  // Skip guest tests when hardware acceleration is not available
  // (TCG emulation is too slow for reliable CI)
  if (!hasHardwareAccel() && process.env.GONDOLIN_FORCE_VM_TESTS !== "1") {
    process.stderr.write(
      "Skipping guest tests: hardware virtualization not available (KVM on Linux, HVF on macOS).\n" +
        "Set GONDOLIN_FORCE_VM_TESTS=1 to run anyway (may be slow).\n",
    );
    return;
  }

  const repoRoot = resolveRepoRoot();
  const tests = defaultTestPaths(repoRoot);

  for (const test of tests) {
    if (!fs.existsSync(test.hostPath)) {
      throw new Error(`missing test binary: ${test.hostPath}`);
    }
  }

  const consoleMode =
    process.env.GONDOLIN_VM_CONSOLE === "stdio" || process.env.CI
      ? "stdio"
      : "none";

  const vm = new VM({
    sandbox: {
      console: consoleMode,
      maxStdinBytes: MAX_STDIN_BYTES,
    },
  });

  try {
    await vm.start();
    for (const test of tests) {
      const payload = fs.readFileSync(test.hostPath);
      await runTest(vm, test.label, payload);
    }
  } finally {
    await vm.close();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

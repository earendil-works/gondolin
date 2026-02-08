import fs from "fs";
import path from "path";

import { VM } from "../src/vm";

const MAX_STDIN_BYTES = 16 * 1024 * 1024;

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
  return path.resolve(__dirname, "../..");
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
  const command = [
    "/bin/sh",
    "-c",
    `cat > ${guestPath} && chmod +x ${guestPath} && ${guestPath}`,
  ];

  const proc = vm.exec(command, { stdin: payload, stdout: "pipe", stderr: "pipe" });

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
    throw new Error(`guest ${label} tests failed with exit code ${result.exitCode}`);
  }
}

async function main() {
  // Skip guest tests when hardware acceleration is not available
  // (TCG emulation is too slow for reliable CI)
  if (!hasHardwareAccel() && process.env.GONDOLIN_FORCE_VM_TESTS !== "1") {
    process.stderr.write(
      "Skipping guest tests: hardware virtualization not available (KVM on Linux, HVF on macOS).\n" +
      "Set GONDOLIN_FORCE_VM_TESTS=1 to run anyway (may be slow).\n"
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

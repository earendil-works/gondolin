/**
 * Basic usage examples for the Gondolin VM API.
 *
 * Run with: npx tsx examples/basic-usage.ts
 */

import { VM } from "../src/vm";

function printResult(label: string, result: { exitCode: number; stdout: string; stderr: string }) {
  console.log(`\n=== ${label} ===`);
  console.log("exitCode:", result.exitCode);
  console.log("stdout:\n", result.stdout);
  console.log("stderr:\n", result.stderr);
}

async function main() {
  const vm = new VM();

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // Example 1: Simple command execution (absolute path required)
    // ═══════════════════════════════════════════════════════════════════════
    // NOTE: `vm.exec([cmd, ...argv])` does not search `$PATH`.
    // The first argv element must be an absolute path.
    const hello = await vm.exec(["/bin/echo", "Hello, World!"]);
    printResult("Simple command", hello);

    // ═══════════════════════════════════════════════════════════════════════
    // Example 2: String form uses `/bin/sh -lc` (pipelines/expansions work)
    // ═══════════════════════════════════════════════════════════════════════
    const shellCmd = `
      echo "HOME=$HOME" | sed 's|^|prefix: |'
    `;
    const shell = await vm.exec(shellCmd);
    printResult("String form (runs in /bin/sh -lc)", shell);

    // ═══════════════════════════════════════════════════════════════════════
    // Example 3: Result helpers
    // ═══════════════════════════════════════════════════════════════════════
    const lsResult = await vm.exec(["/bin/ls", "-la", "/tmp"]);
    console.log("\n=== Result helpers ===");
    console.log("exitCode:", lsResult.exitCode);
    console.log("/tmp listing has", lsResult.lines().length, "lines");

    const jsonCmd = `echo '{"name": "gondolin", "version": 1}'`;
    const jsonResult = await vm.exec(["/bin/sh", "-lc", jsonCmd]);
    const data = jsonResult.json<{ name: string; version: number }>();
    console.log("Parsed JSON:", data);

    // ═══════════════════════════════════════════════════════════════════════
    // Example 4: Streaming output with async iteration
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n=== Streaming output ===");
    const streamProc = vm.exec(["/bin/sh", "-lc", "for i in 1 2 3; do echo Line $i; sleep 0.1; done"], { stdout: "pipe" });

    for await (const chunk of streamProc) {
      process.stdout.write(`[stream] ${chunk}`);
    }
    const streamResult = await streamProc;
    console.log("stream exitCode:", streamResult.exitCode);

    // ═══════════════════════════════════════════════════════════════════════
    // Example 5: Labeled output (stdout + stderr)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n=== Labeled output ===");
    const mixedProc = vm.exec(["/bin/sh", "-lc", "echo stdout; echo stderr >&2; echo stdout2"], { stdout: "pipe", stderr: "pipe" });

    for await (const { stream, text } of mixedProc.output()) {
      console.log(`[${stream}] ${text.trimEnd()}`);
    }
    const mixedResult = await mixedProc;
    console.log("mixed exitCode:", mixedResult.exitCode);

    // ═══════════════════════════════════════════════════════════════════════
    // Example 6: Line-by-line iteration
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n=== Line iteration ===");
    const lineProc = vm.exec(["/bin/sh", "-lc", "printf 'one\\ntwo\\nthree\\n'"], { stdout: "pipe" });

    let lineNum = 1;
    for await (const line of lineProc.lines()) {
      console.log(`Line ${lineNum++}: ${line}`);
    }
    const lineResult = await lineProc;
    console.log("line exitCode:", lineResult.exitCode);

    // ═══════════════════════════════════════════════════════════════════════
    // Example 7: Stdin input
    // ═══════════════════════════════════════════════════════════════════════
    const catResult = await vm.exec(["/bin/cat"], { stdin: "Hello from stdin!\n" });
    printResult("Stdin input", catResult);

    // ═══════════════════════════════════════════════════════════════════════
    // Example 8: Manual stdin with write/end
    // ═══════════════════════════════════════════════════════════════════════
    const proc = vm.exec(["/bin/cat"], { stdin: true });
    proc.write("First line\n");
    proc.write("Second line\n");
    proc.end();

    const manualResult = await proc;
    printResult("Manual stdin", manualResult);

    // ═══════════════════════════════════════════════════════════════════════
    // Example 9: Non-zero exit codes are not thrown
    // ═══════════════════════════════════════════════════════════════════════
    const failResult = await vm.exec(["/bin/sh", "-lc", "exit 42"]);
    printResult("Non-zero exit code", failResult);

    // ═══════════════════════════════════════════════════════════════════════
    // Example 10: Interactive shell helper (non-blocking demo)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n=== Shell helper (non-interactive demo) ===");
    const sh = vm.shell({ attach: false, command: ["/bin/sh"] });
    sh.write("echo Hello from shell helper\n");
    sh.write("exit\n");

    for await (const chunk of sh) {
      process.stdout.write(chunk);
    }
    const shResult = await sh;
    console.log("shell exitCode:", shResult.exitCode);

    console.log("\n=== All examples completed! ===");
  } finally {
    await vm.close();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

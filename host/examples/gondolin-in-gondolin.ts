/**
 * Gondolin-in-Gondolin (nested VM) example.
 *
 * This starts an outer Gondolin VM (L1) and mounts:
 * - the local host package at `/opt/gondolin-host`
 * - inner guest assets at `/inner-assets`
 *
 * Inside L1 we install a helper command:
 *   gondolin-bash
 *
 * Running `gondolin-bash` in L1 starts an inner Gondolin VM (L2) with
 * software emulation (`accel: "tcg"`) and drops you into an interactive
 * `/bin/bash` in L2.
 *
 * Prerequisites:
 *   1) Build host package so `/dist` exists:
 *        cd host
 *        pnpm build
 *
 *   2) Build outer guest assets with QEMU + Node installed:
 *        gondolin build --config examples/gondolin-in-gondolin.json --output ./tmp/nested-outer
 *
 *   3) Run this example:
 *        GONDOLIN_OUTER_GUEST_DIR=./tmp/nested-outer pnpm exec tsx examples/gondolin-in-gondolin.ts
 *
 * Optional:
 *   - GONDOLIN_INNER_GUEST_DIR=/path/to/guest/assets
 *     (if omitted, reuses GONDOLIN_OUTER_GUEST_DIR for the inner VM)
 *   - GONDOLIN_NESTED_COMMAND='echo hi from inner'
 *     (non-interactive mode; runs this command inside L2)
 */

import fs from "node:fs";
import path from "node:path";

import {
  VM,
  loadGuestAssets,
  RealFSProvider,
  ReadonlyProvider,
} from "../dist/src/index.js";

type GuestAssets = {
  kernelPath: string;
  initrdPath: string;
  rootfsPath: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required\n` +
        `Example:\n` +
        `  ${name}=./tmp/nested-outer pnpm exec tsx examples/gondolin-in-gondolin.ts`,
    );
  }
  return value;
}

function resolveAssetDir(assets: GuestAssets): string {
  const kernelDir = path.dirname(assets.kernelPath);
  const initrdDir = path.dirname(assets.initrdPath);
  const rootfsDir = path.dirname(assets.rootfsPath);

  if (kernelDir !== initrdDir || kernelDir !== rootfsDir) {
    throw new Error(
      "guest assets are not colocated in one directory; please provide a directory via GONDOLIN_INNER_GUEST_DIR",
    );
  }

  return kernelDir;
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got: ${raw})`);
  }
  return value;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveInnerGuestDir(outerGuestDir: string): string {
  const explicit = process.env.GONDOLIN_INNER_GUEST_DIR;
  if (explicit) {
    const loaded = loadGuestAssets(path.resolve(explicit));
    return resolveAssetDir(loaded);
  }

  return outerGuestDir;
}

function buildInnerRunnerScript() {
  return [
    'const { VM } = require("/opt/gondolin-host/dist/src/index.js");',
    "",
    "async function main() {",
    "  const vm = await VM.create({",
    "    sandbox: {",
    '      imagePath: "/inner-assets",',
    '      accel: "tcg",',
    "      netEnabled: true,",
    "    },",
    '    memory: process.env.INNER_MEMORY || "256M",',
    '    cpus: Number(process.env.INNER_CPUS || "1"),',
    "  });",
    "",
    "  try {",
    "    const argv = process.argv.slice(2);",
    "",
    "    if (argv.length > 0) {",
    "      const [cmd, ...cmdArgv] = argv;",
    "      const result = await vm.exec([cmd, ...cmdArgv], {",
    "        stdin: true,",
    '        stdout: "inherit",',
    '        stderr: "inherit",',
    "      });",
    "      process.exit(result.exitCode || 0);",
    "      return;",
    "    }",
    "",
    "    const result = await vm.shell({",
    '      command: ["/bin/bash", "-i"],',
    "      attach: true,",
    "    });",
    "",
    "    if (result.signal !== undefined) {",
    "      console.error(`[inner] signal: ${result.signal}`);",
    "    }",
    "",
    "    process.exit(result.exitCode || 0);",
    "  } finally {",
    "    await vm.close();",
    "  }",
    "}",
    "",
    "main().catch((err) => {",
    '  console.error("[inner] error:", err);',
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
}

async function installNestedCommand(outerVm: VM) {
  await outerVm.exec([
    "/bin/sh",
    "-lc",
    "mkdir -p /usr/bin /usr/local/bin /usr/local/lib/gondolin",
  ]);

  await outerVm.fs.writeFile(
    "/usr/local/lib/gondolin/run-inner-bash.js",
    buildInnerRunnerScript(),
  );

  // Alpine's /bin/bash default PATH typically omits /usr/local/bin, so install
  // the command into /usr/bin and keep /usr/local/bin as a convenience symlink.
  await outerVm.fs.writeFile(
    "/usr/bin/gondolin-bash",
    '#!/bin/sh\nexec node /usr/local/lib/gondolin/run-inner-bash.js "$@"\n',
  );

  const chmodResult = await outerVm.exec([
    "/bin/sh",
    "-lc",
    "chmod +x /usr/bin/gondolin-bash && ln -sf /usr/bin/gondolin-bash /usr/local/bin/gondolin-bash",
  ]);

  if (!chmodResult.ok) {
    throw new Error(
      `failed to install gondolin-bash: ${chmodResult.stderr || "chmod failed"}`,
    );
  }
}

async function runNestedCommand(
  outerVm: VM,
  command: string,
  innerMemory: string,
  innerCpus: number,
) {
  const wrapped = `gondolin-bash /bin/sh -lc ${shQuote(command)}`;
  const result = await outerVm.exec(["/bin/sh", "-lc", wrapped], {
    env: {
      INNER_MEMORY: innerMemory,
      INNER_CPUS: String(innerCpus),
    },
  });

  console.log("[outer] exitCode:", result.exitCode);
  if (result.stdout.trim()) {
    console.log("[outer] stdout:\n" + result.stdout);
  }
  if (result.stderr.trim()) {
    console.log("[outer] stderr:\n" + result.stderr);
  }

  if (!result.ok) {
    process.exit(result.exitCode || 1);
  }
}

async function main() {
  const outerGuestDir = path.resolve(requireEnv("GONDOLIN_OUTER_GUEST_DIR"));
  // Validate outer assets eagerly for clearer startup errors.
  loadGuestAssets(outerGuestDir);

  const innerGuestDir = resolveInnerGuestDir(outerGuestDir);

  const hostPackageDir = path.resolve(__dirname, "..");
  const hostDistEntry = path.join(hostPackageDir, "dist/src/index.js");

  if (!fs.existsSync(hostDistEntry)) {
    throw new Error(
      `Host package build output missing: ${hostDistEntry}\n` +
        `Run:\n` +
        `  cd host\n` +
        `  pnpm build`,
    );
  }

  const outerMemory = process.env.GONDOLIN_OUTER_MEMORY ?? "1536M";
  const outerCpus = parsePositiveInt("GONDOLIN_OUTER_CPUS", 2);
  const innerMemory = process.env.GONDOLIN_INNER_MEMORY ?? "256M";
  const innerCpus = parsePositiveInt("GONDOLIN_INNER_CPUS", 1);

  console.log("[host] outer assets:", outerGuestDir);
  console.log("[host] inner assets:", innerGuestDir);
  console.log("[host] host package mount:", hostPackageDir);

  const outerVm = await VM.create({
    sandbox: {
      imagePath: outerGuestDir,
      netEnabled: true,
    },
    memory: outerMemory,
    cpus: outerCpus,
    vfs: {
      mounts: {
        "/opt/gondolin-host": new ReadonlyProvider(
          new RealFSProvider(hostPackageDir),
        ),
        "/inner-assets": new ReadonlyProvider(
          new RealFSProvider(innerGuestDir),
        ),
      },
    },
  });

  try {
    await installNestedCommand(outerVm);
    console.log("[host] installed command inside outer VM: gondolin-bash");

    const scriptedCommand = process.env.GONDOLIN_NESTED_COMMAND;
    const inInteractiveTerminal = process.stdin.isTTY && process.stdout.isTTY;

    if (scriptedCommand || !inInteractiveTerminal) {
      const command =
        scriptedCommand ??
        "echo hello-from-inner-gondolin; uname -m; cat /etc/alpine-release";
      await runNestedCommand(outerVm, command, innerMemory, innerCpus);
      return;
    }

    console.log("[host] entering outer shell");
    console.log("[host] run `gondolin-bash` inside it to open an inner shell");

    const shellResult = await outerVm.shell({
      command: ["/bin/bash", "-i"],
      env: {
        INNER_MEMORY: innerMemory,
        INNER_CPUS: String(innerCpus),
      },
    });

    console.log("\n[outer] exitCode:", shellResult.exitCode);
    if (shellResult.signal !== undefined) {
      console.log("[outer] signal:", shellResult.signal);
    }

    if (!shellResult.ok) {
      process.exit(shellResult.exitCode || 1);
    }
  } finally {
    await outerVm.close();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

import fs from "fs";
import { WASI } from "node:wasi";

type RunnerArgs = {
  /** wasm module path */
  wasmPath: string;
  /** argv forwarded to the wasm module */
  wasmArgs: string[];
};

function parseArgs(argv: string[]): RunnerArgs {
  let wasmPath: string | null = null;
  const passthrough: string[] = [];
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (afterDoubleDash) {
      passthrough.push(arg);
      continue;
    }

    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new Error(
        "usage: node wasm-runner.ts --wasm PATH [-- ARG ...]\n" +
          "runs a wasi module and wires stdin/stdout/stderr directly",
      );
    }

    if (arg === "--wasm") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--wasm requires a path");
      }
      wasmPath = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--wasm=")) {
      wasmPath = arg.slice("--wasm=".length);
      continue;
    }

    throw new Error(`unknown wasm-runner argument: ${arg}`);
  }

  if (!wasmPath) {
    throw new Error("missing --wasm path");
  }

  return {
    wasmPath: wasmPath,
    wasmArgs: passthrough,
  };
}

async function runWasi(args: RunnerArgs): Promise<void> {
  if (!fs.existsSync(args.wasmPath)) {
    throw new Error(`wasm module does not exist: ${args.wasmPath}`);
  }

  const moduleBytes = await fs.promises.readFile(args.wasmPath);
  const module = await WebAssembly.compile(moduleBytes);

  const wasi = new WASI({
    version: "preview1",
    args: [args.wasmPath, ...args.wasmArgs],
    env: process.env as Record<string, string>,
    preopens: {
      "/": "/",
    },
  });

  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });

  wasi.start(instance as WebAssembly.Instance);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    await runWasi(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[wasm-runner] ${message}\n`);
    process.exitCode = 1;
  }
}

void main();

export const __test = {
  parseArgs,
};

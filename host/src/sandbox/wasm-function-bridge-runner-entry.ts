import child_process from "child_process";
import fs from "fs";
import path from "path";
import type { ChildProcess } from "child_process";
import {
  FrameReader,
  decodeMessage,
  encodeFrame,
} from "./virtio-protocol.ts";

type RunnerMode = "harness" | "wasi-stdio";

type RunnerOutboundMessage =
  | {
      /** runner readiness signal */
      t: "ready";
    }
  | {
      /** framed guest payload bytes encoded as base64 */
      t: "frame";
      /** base64-encoded frame bytes */
      frame: string;
    }
  | {
      /** optional structured log entry */
      t: "log";
      /** log stream name */
      stream: "stdout" | "stderr";
      /** log chunk */
      chunk: string;
    }
  | {
      /** writable notification for outbound queue draining */
      t: "writable";
    }
  | {
      /** structured runner-side error */
      t: "error";
      /** human-readable error message */
      message: string;
    };

type RunnerInboundMessage =
  | {
      /** outbound framed payload from host, encoded as base64 */
      t: "frame";
      /** base64-encoded frame bytes */
      frame: string;
    }
  | {
      /** graceful runner shutdown */
      t: "close";
    };

type ParsedArgs = {
  /** runner mode */
  mode: RunnerMode;
  /** guest wasm module path for wasi-stdio mode */
  wasmPath?: string;
};

function sendToParent(message: RunnerOutboundMessage): void {
  if (typeof process.send !== "function") {
    return;
  }
  process.send(message);
}

function sendFrame(message: object): void {
  const frame = encodeFrame(message);
  sendToParent({
    t: "frame",
    frame: frame.toString("base64"),
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  let mode: RunnerMode = "harness";
  let wasmPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === "--mode") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--mode requires a value");
      }
      if (value !== "harness" && value !== "wasi-stdio") {
        throw new Error(`unsupported runner mode: ${value}`);
      }
      mode = value;
      i += 1;
      continue;
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
      const value = arg.slice("--wasm=".length).trim();
      if (!value) {
        throw new Error("--wasm requires a path");
      }
      wasmPath = value;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new Error(
        "usage: node wasm-function-bridge-runner-entry.ts [--mode harness|wasi-stdio] [--wasm PATH]",
      );
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return { mode, wasmPath };
}

function decodeRunnerInboundMessage(raw: unknown): RunnerInboundMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const t = value.t;
  if (typeof t !== "string") return null;

  if (t === "close") {
    return { t: "close" };
  }

  if (t === "frame" && typeof value.frame === "string") {
    return {
      t: "frame",
      frame: value.frame,
    };
  }

  return null;
}

function asPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function asId(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.trunc(value);
}

function handleHarnessFrame(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }

  const envelope = message as Record<string, unknown>;
  const type = envelope.t;
  const id = asId(envelope.id);

  if (type === "exec_request") {
    const payload = asPayload(envelope.p);
    const cmd = typeof payload?.cmd === "string" ? payload.cmd : "";
    const pty = payload?.pty === true;
    const stdinEnabled = payload?.stdin === true;

    sendFrame({
      v: 1,
      t: "exec_output",
      id,
      p: {
        stream: "stdout",
        data: Buffer.from(
          `[wasm-harness] cmd=${cmd} pty=${pty ? 1 : 0}\n`,
          "utf8",
        ),
      },
    });

    if (stdinEnabled) {
      sendFrame({
        v: 1,
        t: "stdin_window",
        id,
        p: {
          stdin: 64 * 1024,
        },
      });
    }

    sendFrame({
      v: 1,
      t: "exec_response",
      id,
      p: {
        exit_code: 0,
      },
    });
    return;
  }

  if (type === "pty_resize") {
    const payload = asPayload(envelope.p);
    const rows =
      typeof payload?.rows === "number" && Number.isFinite(payload.rows)
        ? Math.trunc(payload.rows)
        : 0;
    const cols =
      typeof payload?.cols === "number" && Number.isFinite(payload.cols)
        ? Math.trunc(payload.cols)
        : 0;

    sendFrame({
      v: 1,
      t: "exec_output",
      id,
      p: {
        stream: "stdout",
        data: Buffer.from(`[wasm-harness] resize=${rows}x${cols}\n`, "utf8"),
      },
    });
    return;
  }

  if (type === "stdin_data") {
    const payload = asPayload(envelope.p);
    const data = Buffer.isBuffer(payload?.data)
      ? payload.data
      : payload?.data instanceof Uint8Array
        ? Buffer.from(payload.data)
        : Buffer.alloc(0);

    if (data.length > 0) {
      sendFrame({
        v: 1,
        t: "exec_output",
        id,
        p: {
          stream: "stdout",
          data,
        },
      });
    }

    if (payload?.eof === true) {
      sendFrame({
        v: 1,
        t: "exec_output",
        id,
        p: {
          stream: "stdout",
          data: Buffer.from("[wasm-harness] stdin=eof\n", "utf8"),
        },
      });
    }
    return;
  }

  // Control-plane keepalives/credit updates are accepted but ignored in harness mode.
  if (type === "exec_window") {
    return;
  }

  sendFrame({
    v: 1,
    t: "error",
    id,
    p: {
      code: "unsupported_request",
      message: `harness mode does not handle ${String(type ?? "unknown")}`,
    },
  });
}

function resolveDefaultWasmModuleRunnerPath(): string {
  const localJs = path.resolve(import.meta.dirname, "wasm-runner.js");
  if (fs.existsSync(localJs)) {
    return localJs;
  }
  return path.resolve(import.meta.dirname, "wasm-runner.ts");
}

async function runHarnessMode(): Promise<void> {
  const reader = new FrameReader();

  process.on("message", (raw) => {
    const message = decodeRunnerInboundMessage(raw);
    if (!message) {
      sendToParent({
        t: "error",
        message: "received invalid runner message",
      });
      return;
    }

    if (message.t === "close") {
      process.exit(0);
      return;
    }

    let chunk: Buffer;
    try {
      chunk = Buffer.from(message.frame, "base64");
    } catch {
      sendToParent({
        t: "error",
        message: "received non-base64 frame payload",
      });
      return;
    }

    try {
      reader.push(chunk, (payload) => {
        const decoded = decodeMessage(payload);
        handleHarnessFrame(decoded);
      });
      sendToParent({ t: "writable" });
    } catch (err) {
      sendToParent({
        t: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  sendToParent({ t: "ready" });
  sendFrame({
    v: 1,
    t: "vfs_ready",
  });
}

async function runWasiStdioMode(wasmPath: string): Promise<void> {
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`wasm module not found: ${wasmPath}`);
  }

  const wasmRunnerPath = resolveDefaultWasmModuleRunnerPath();
  if (!fs.existsSync(wasmRunnerPath)) {
    throw new Error(`wasm-runner entrypoint not found: ${wasmRunnerPath}`);
  }

  const child = child_process.spawn(
    process.execPath,
    [wasmRunnerPath, "--wasm", wasmPath, "--", "--transport=stdio"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    },
  );

  let closed = false;
  let closing = false;

  const closeChild = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (data.length === 0) return;
    sendToParent({
      t: "frame",
      frame: data.toString("base64"),
    });
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sendToParent({
      t: "log",
      stream: "stderr",
      chunk: data.toString("utf8"),
    });
  });

  child.stdin?.on("drain", () => {
    sendToParent({ t: "writable" });
  });

  child.on("error", (err) => {
    sendToParent({
      t: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  });

  child.on("exit", (code, signal) => {
    if (closed) return;
    closed = true;

    if (signal || (typeof code === "number" && code !== 0)) {
      sendToParent({
        t: "error",
        message: `wasm guest exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      });
    }

    process.exit(code ?? 0);
  });

  process.on("message", (raw) => {
    const message = decodeRunnerInboundMessage(raw);
    if (!message) {
      sendToParent({
        t: "error",
        message: "received invalid runner message",
      });
      return;
    }

    if (message.t === "close") {
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      const killTimer = setTimeout(() => {
        closeChild("SIGKILL");
      }, 2_000);
      killTimer.unref?.();
      closeChild("SIGTERM");
      return;
    }

    let chunk: Buffer;
    try {
      chunk = Buffer.from(message.frame, "base64");
    } catch {
      sendToParent({
        t: "error",
        message: "received non-base64 frame payload",
      });
      return;
    }

    try {
      const writable = child.stdin?.write(chunk) ?? false;
      if (writable) {
        sendToParent({ t: "writable" });
      }
    } catch (err) {
      sendToParent({
        t: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  sendToParent({ t: "ready" });
  sendToParent({ t: "writable" });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "harness") {
    await runHarnessMode();
    return;
  }

  if (!args.wasmPath) {
    throw new Error("--wasm is required when --mode wasi-stdio");
  }

  await runWasiStdioMode(args.wasmPath);
}

void main().catch((err) => {
  sendToParent({
    t: "error",
    message: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});

export const __test = {
  parseArgs,
  resolveDefaultWasmModuleRunnerPath,
};

import {
  FrameReader,
  decodeMessage,
  encodeFrame,
} from "./virtio-protocol.ts";

type RunnerMode = "harness";

type RunnerOutboundMessage =
  | {
      /** runner readiness signal */
      t: "ready";
    }
  | {
      /** framed guest payload encoded as base64 */
      t: "frame";
      /** frame bytes encoded as base64 */
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
      /** frame bytes encoded as base64 */
      frame: string;
    }
  | {
      /** graceful runner shutdown */
      t: "close";
    };

type ParsedArgs = {
  /** runner mode */
  mode: RunnerMode;
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

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === "--mode") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--mode requires a value");
      }
      if (value !== "harness") {
        throw new Error(`unsupported runner mode: ${value}`);
      }
      mode = value;
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new Error("usage: node wasm-function-bridge-runner-entry.ts [--mode harness]");
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return { mode };
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode !== "harness") {
    throw new Error(`unsupported mode: ${args.mode}`);
  }

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

try {
  main();
} catch (err) {
  sendToParent({
    t: "error",
    message: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
}

export const __test = {
  parseArgs,
};

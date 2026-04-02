import child_process from "child_process";
import fs from "fs";
import path from "path";
import type { ChildProcess } from "child_process";
import {
  FrameReader,
  MAX_FRAME,
  decodeMessage,
  encodeFrame,
} from "./virtio-protocol.ts";

type RunnerMode = "harness" | "wasi-stdio";

type BridgeChannel = "control" | "fs" | "ssh" | "ingress";
const DEFAULT_CHANNEL: BridgeChannel = "control";

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
      /** logical bridge channel */
      channel?: BridgeChannel;
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
      /** logical bridge channel */
      channel?: BridgeChannel;
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
  /** qemu-network backend unix socket path */
  netSocketPath?: string;
  /** wasi preopened host directories */
  preopens: Array<{ spec: string; readOnly: boolean }>;
  /** extra argv entries forwarded to the wasm module */
  wasmArgs: string[];
};

const STDIO_ENVELOPE_CHUNK_BASE64 = 120;

function sendToParent(message: RunnerOutboundMessage): void {
  if (typeof process.send !== "function") {
    return;
  }
  process.send(message);
}

function normalizeChannel(value: unknown): BridgeChannel | null {
  if (value === undefined) return DEFAULT_CHANNEL;
  if (
    value === "control" ||
    value === "fs" ||
    value === "ssh" ||
    value === "ingress"
  ) {
    return value;
  }
  return null;
}

function sendFrame(message: object, channel: BridgeChannel = DEFAULT_CHANNEL): void {
  const frame = encodeFrame(message);
  sendToParent({
    t: "frame",
    frame: frame.toString("base64"),
    channel,
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  let mode: RunnerMode = "harness";
  let wasmPath: string | undefined;
  let netSocketPath: string | undefined;
  const preopens: Array<{ spec: string; readOnly: boolean }> = [];
  const wasmArgs: string[] = [];

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

    if (arg === "--net-socket") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--net-socket requires a path");
      }
      netSocketPath = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--net-socket=")) {
      const value = arg.slice("--net-socket=".length).trim();
      if (!value) {
        throw new Error("--net-socket requires a path");
      }
      netSocketPath = value;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new Error(
        "usage: node wasm-function-bridge-runner-entry.ts [--mode harness|wasi-stdio] [--wasm PATH] [--net-socket PATH] [--preopen HOST::GUEST] [--preopen-ro HOST::GUEST] [--wasm-arg ARG]",
      );
    }

    if (arg === "--preopen" || arg === "--preopen-ro") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a HOST::GUEST value`);
      }
      preopens.push({ spec: value, readOnly: arg === "--preopen-ro" });
      i += 1;
      continue;
    }

    if (arg.startsWith("--preopen=")) {
      const value = arg.slice("--preopen=".length).trim();
      if (!value) {
        throw new Error("--preopen requires a HOST::GUEST value");
      }
      preopens.push({ spec: value, readOnly: false });
      continue;
    }

    if (arg.startsWith("--preopen-ro=")) {
      const value = arg.slice("--preopen-ro=".length).trim();
      if (!value) {
        throw new Error("--preopen-ro requires a HOST::GUEST value");
      }
      preopens.push({ spec: value, readOnly: true });
      continue;
    }

    if (arg === "--wasm-arg") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--wasm-arg requires a value");
      }
      wasmArgs.push(value);
      i += 1;
      continue;
    }

    if (arg.startsWith("--wasm-arg=")) {
      const value = arg.slice("--wasm-arg=".length);
      wasmArgs.push(value);
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return { mode, wasmPath, netSocketPath, preopens, wasmArgs };
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
    const channel = normalizeChannel(value.channel);
    if (!channel) return null;
    return {
      t: "frame",
      frame: value.frame,
      channel,
    };
  }

  return null;
}

function encodeStdioEnvelopePayload(payload: Buffer): Buffer[] {
  const encoded = payload.toString("base64");
  if (encoded.length <= STDIO_ENVELOPE_CHUNK_BASE64) {
    return [Buffer.from(`@${encoded}\n`, "utf8")];
  }

  const lines: Buffer[] = [];
  for (
    let offset = 0;
    offset < encoded.length;
    offset += STDIO_ENVELOPE_CHUNK_BASE64
  ) {
    const chunk = encoded.slice(offset, offset + STDIO_ENVELOPE_CHUNK_BASE64);
    const isLast = offset + STDIO_ENVELOPE_CHUNK_BASE64 >= encoded.length;
    lines.push(Buffer.from(`@${isLast ? "." : "!"}${chunk}\n`, "utf8"));
  }

  return lines;
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

function handleHarnessFrame(channel: BridgeChannel, message: unknown): void {
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

    sendFrame(
      {
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
      },
      channel,
    );

    if (stdinEnabled) {
      sendFrame(
        {
          v: 1,
          t: "stdin_window",
          id,
          p: {
            stdin: 64 * 1024,
          },
        },
        channel,
      );
    }

    sendFrame(
      {
        v: 1,
        t: "exec_response",
        id,
        p: {
          exit_code: 0,
        },
      },
      channel,
    );
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

    sendFrame(
      {
        v: 1,
        t: "exec_output",
        id,
        p: {
          stream: "stdout",
          data: Buffer.from(`[wasm-harness] resize=${rows}x${cols}\n`, "utf8"),
        },
      },
      channel,
    );
    return;
  }

  if (type === "tcp_open") {
    sendFrame(
      {
        v: 1,
        t: "tcp_opened",
        id,
        p: {
          ok: true,
        },
      },
      channel,
    );
    return;
  }

  if (type === "tcp_data") {
    const payload = asPayload(envelope.p);
    const data = Buffer.isBuffer(payload?.data)
      ? payload.data
      : payload?.data instanceof Uint8Array
        ? Buffer.from(payload.data)
        : Buffer.alloc(0);
    if (data.length > 0) {
      sendFrame(
        {
          v: 1,
          t: "tcp_data",
          id,
          p: {
            data,
          },
        },
        channel,
      );
    }
    return;
  }

  if (type === "tcp_eof") {
    sendFrame(
      {
        v: 1,
        t: "tcp_closed",
        id,
        p: {},
      },
      channel,
    );
    return;
  }

  if (type === "tcp_close") {
    sendFrame(
      {
        v: 1,
        t: "tcp_closed",
        id,
        p: {},
      },
      channel,
    );
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
      sendFrame(
        {
          v: 1,
          t: "exec_output",
          id,
          p: {
            stream: "stdout",
            data,
          },
        },
        channel,
      );
    }

    if (payload?.eof === true) {
      sendFrame(
        {
          v: 1,
          t: "exec_output",
          id,
          p: {
            stream: "stdout",
            data: Buffer.from("[wasm-harness] stdin=eof\n", "utf8"),
          },
        },
        channel,
      );
    }
    return;
  }

  // Control-plane keepalives/credit updates are accepted but ignored in harness mode.
  if (type === "exec_window") {
    return;
  }

  sendFrame(
    {
      v: 1,
      t: "error",
      id,
      p: {
        code: "unsupported_request",
        message: `harness mode does not handle ${String(type ?? "unknown")}`,
      },
    },
    channel,
  );
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
        handleHarnessFrame(message.channel ?? DEFAULT_CHANNEL, decoded);
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

async function runWasiStdioMode(
  wasmPath: string,
  netSocketPath?: string,
  preopens: Array<{ spec: string; readOnly: boolean }> = [],
  wasmArgs: string[] = [],
): Promise<void> {
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`wasm module not found: ${wasmPath}`);
  }

  const wasmRunnerPath = resolveDefaultWasmModuleRunnerPath();
  if (!fs.existsSync(wasmRunnerPath)) {
    throw new Error(`wasm-runner entrypoint not found: ${wasmRunnerPath}`);
  }

  const childArgs = [wasmRunnerPath, "--wasm", wasmPath];
  if (netSocketPath && netSocketPath.length > 0) {
    childArgs.push("--net-socket", netSocketPath);
  }
  for (const preopen of preopens) {
    childArgs.push(preopen.readOnly ? "--preopen-ro" : "--preopen", preopen.spec);
  }
  if (wasmArgs.length > 0) {
    childArgs.push("--", ...wasmArgs);
  }

  const child = child_process.spawn(process.execPath, childArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS ?? "1",
      },
    });

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

  let stdoutBuffer = Buffer.alloc(0);
  let stdoutSynced = false;
  let malformedStdoutFrames = 0;
  let waitingDrain = false;
  const outboundQueue: Buffer[] = [];

  const tcpHostToGuest = new Map<string, number>();
  const tcpGuestToHost = new Map<
    number,
    { channel: BridgeChannel; hostId: number }
  >();
  const fsHostToGuest = new Map<number, BridgeChannel>();
  const fsGuestToHost = new Map<number, BridgeChannel>();
  let nextGuestTcpId = 1;

  const makeTcpKey = (channel: BridgeChannel, hostId: number) =>
    `${channel}:${hostId}`;

  const releaseTcpGuestId = (guestId: number) => {
    const route = tcpGuestToHost.get(guestId);
    if (!route) return;
    tcpGuestToHost.delete(guestId);
    tcpHostToGuest.delete(makeTcpKey(route.channel, route.hostId));
  };

  const allocateGuestTcpId = (): number => {
    for (let i = 0; i < 0xffffffff; i += 1) {
      const candidate = nextGuestTcpId;
      nextGuestTcpId += 1;
      if (nextGuestTcpId > 0xffffffff) {
        nextGuestTcpId = 1;
      }
      if (!tcpGuestToHost.has(candidate)) {
        return candidate;
      }
    }
    throw new Error("no available tcp stream ids for wasm bridge");
  };

  const isTcpType = (type: string): boolean =>
    type === "tcp_open" ||
    type === "tcp_data" ||
    type === "tcp_eof" ||
    type === "tcp_close" ||
    type === "tcp_opened" ||
    type === "tcp_closed";

  const isFsRequestType = (type: string): boolean => type === "fs_request";
  const isFsResponseType = (type: string): boolean => type === "fs_response";

  const encodePayload = (decoded: Record<string, unknown>): Buffer =>
    encodeFrame(decoded).subarray(4);

  const flushOutboundQueue = () => {
    if (!child.stdin || waitingDrain) {
      return;
    }

    while (outboundQueue.length > 0) {
      const part = outboundQueue.shift()!;
      const ok = child.stdin.write(part);
      if (!ok) {
        waitingDrain = true;
        return;
      }
    }

    sendToParent({ t: "writable" });
  };

  const frameFromPayload = (payload: Buffer): Buffer => {
    const framed = Buffer.allocUnsafe(4 + payload.length);
    framed.writeUInt32BE(payload.length, 0);
    payload.copy(framed, 4);
    return framed;
  };

  const forwardGuestFrame = (frame: Buffer): boolean => {
    stdoutSynced = true;

    const payload = frame.subarray(4);
    let decoded: Record<string, unknown>;
    try {
      decoded = decodeMessage(payload) as Record<string, unknown>;
    } catch {
      malformedStdoutFrames += 1;
      if (malformedStdoutFrames <= 5) {
        sendToParent({
          t: "error",
          message: "dropping malformed guest control frame",
        });
      }
      return false;
    }

    let outboundFrame: Buffer = frame;
    let outboundChannel: BridgeChannel = DEFAULT_CHANNEL;

    const type = typeof decoded?.t === "string" ? decoded.t : "";
    const id = asId(decoded?.id);

    if (isTcpType(type)) {
      const route = tcpGuestToHost.get(id);
      if (route) {
        decoded.id = route.hostId;
        outboundChannel = route.channel;
        outboundFrame = encodeFrame(decoded);

        if (type === "tcp_closed") {
          releaseTcpGuestId(id);
        }

        if (type === "tcp_opened") {
          const payloadMap = asPayload(decoded.p);
          if (payloadMap.ok === false) {
            releaseTcpGuestId(id);
          }
        }
      }
    } else if (isFsRequestType(type)) {
      outboundChannel = "control";
      fsGuestToHost.set(id, outboundChannel);
    } else if (isFsResponseType(type)) {
      const route = fsHostToGuest.get(id);
      if (route) {
        outboundChannel = route;
        fsHostToGuest.delete(id);
      } else {
        outboundChannel = "control";
      }
    }

    sendToParent({
      t: "frame",
      frame: outboundFrame.toString("base64"),
      channel: outboundChannel,
    });

    return true;
  };

  const readEnvelopeLineEnd = (start: number): number => {
    for (let i = start; i < stdoutBuffer.length; i += 1) {
      const byte = stdoutBuffer[i]!;
      if (byte === 0x0a || byte === 0x0d) {
        return i;
      }
    }
    return -1;
  };

  const skipLineEnd = (start: number): number => {
    let offset = start;
    while (offset < stdoutBuffer.length) {
      const byte = stdoutBuffer[offset]!;
      if (byte !== 0x0a && byte !== 0x0d) {
        break;
      }
      offset += 1;
    }
    return offset;
  };

  const isStrictBase64 = (value: string): boolean => {
    if (value.length === 0 || value.length % 4 !== 0) {
      return false;
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(value)) {
      return false;
    }

    const firstPad = value.indexOf("=");
    if (firstPad !== -1) {
      for (let i = firstPad; i < value.length; i += 1) {
        if (value[i] !== "=") {
          return false;
        }
      }
      const padLen = value.length - firstPad;
      if (padLen > 2) {
        return false;
      }
    }

    try {
      return Buffer.from(value, "base64").toString("base64") === value;
    } catch {
      return false;
    }
  };

  type EnvelopeParseResult =
    | { kind: "frame"; frame: Buffer }
    | { kind: "need-more" }
    | { kind: "invalid"; drop: number };

  const invalidEnvelope = (
    reason: string,
    drop: number,
  ): EnvelopeParseResult => {
    malformedStdoutFrames += 1;
    if (malformedStdoutFrames <= 5) {
      sendToParent({
        t: "error",
        message: `invalid guest stdio envelope (${reason})`,
      });
    }
    return {
      kind: "invalid",
      drop: Math.max(1, drop),
    };
  };

  const parseStdoutEnvelopeFrame = (): EnvelopeParseResult => {
    if (stdoutBuffer.length === 0 || stdoutBuffer[0] !== 0x40) {
      return invalidEnvelope("missing_at_prefix", 1);
    }

    if (stdoutBuffer.length < 2) {
      return { kind: "need-more" };
    }

    let offset = 1;
    let marker = stdoutBuffer[offset]!;
    let encoded = "";

    const appendEncodedChunk = (start: number, end: number): boolean => {
      const chunk = stdoutBuffer.subarray(start, end).toString("utf8");
      if (chunk.length === 0) {
        return false;
      }
      if (!/^[A-Za-z0-9+/=]+$/.test(chunk)) {
        return false;
      }
      encoded += chunk;
      return encoded.length <= MAX_FRAME * 2;
    };

    if (marker === 0x21 || marker === 0x2e) {
      offset += 1;

      while (true) {
        const lineEnd = readEnvelopeLineEnd(offset);
        if (lineEnd === -1) {
          return { kind: "need-more" };
        }

        if (!appendEncodedChunk(offset, lineEnd)) {
          return invalidEnvelope("invalid_chunk", skipLineEnd(lineEnd));
        }

        offset = skipLineEnd(lineEnd);

        if (marker === 0x2e) {
          break;
        }

        if (offset + 2 > stdoutBuffer.length) {
          return { kind: "need-more" };
        }

        if (stdoutBuffer[offset] !== 0x40) {
          return invalidEnvelope("missing_continuation_at", offset);
        }

        marker = stdoutBuffer[offset + 1]!;
        if (marker !== 0x21 && marker !== 0x2e) {
          return invalidEnvelope("invalid_continuation_marker", offset + 1);
        }

        offset += 2;
      }
    } else {
      const lineEnd = readEnvelopeLineEnd(offset);
      if (lineEnd === -1) {
        return { kind: "need-more" };
      }

      if (!appendEncodedChunk(offset, lineEnd)) {
        return invalidEnvelope("invalid_single_chunk", skipLineEnd(lineEnd));
      }

      offset = skipLineEnd(lineEnd);
    }

    if (!isStrictBase64(encoded)) {
      return invalidEnvelope("base64_validation_failed", offset);
    }

    const payload = Buffer.from(encoded, "base64");
    if (payload.length === 0 || payload.length > MAX_FRAME) {
      return invalidEnvelope("payload_size_invalid", offset);
    }

    try {
      decodeMessage(payload);
    } catch {
      return invalidEnvelope("payload_decode_failed", offset);
    }

    stdoutBuffer = stdoutBuffer.subarray(offset);
    return { kind: "frame", frame: frameFromPayload(payload) };
  };

  const parseStdoutFrames = () => {
    while (stdoutBuffer.length > 0) {
      while (stdoutBuffer.length > 0) {
        const lead = stdoutBuffer[0]!;
        if (lead !== 0x0a && lead !== 0x0d && lead !== 0x3d) {
          break;
        }
        stdoutBuffer = stdoutBuffer.subarray(1);
      }

      if (stdoutBuffer.length === 0) {
        break;
      }

      if (stdoutBuffer[0] === 0x40) {
        const parsed = parseStdoutEnvelopeFrame();
        if (parsed.kind === "need-more") {
          break;
        }

        if (parsed.kind === "invalid") {
          const drop = Math.min(
            stdoutBuffer.length,
            Math.max(parsed.drop, 1),
          );
          stdoutBuffer = stdoutBuffer.subarray(drop);
          continue;
        }

        forwardGuestFrame(parsed.frame);
        continue;
      }

      // sandboxd can emit line-based logs on stdout; keep those away from the
      // frame decoder and only attempt raw frame parsing when the first byte
      // matches the 4-byte length-prefix format (`0x00`).
      if (stdoutBuffer[0] !== 0x00) {
        const lineEnd = readEnvelopeLineEnd(0);
        if (lineEnd === -1) {
          const nextEnvelope = stdoutBuffer.indexOf(0x40);
          if (nextEnvelope > 0) {
            const noise = stdoutBuffer.subarray(0, nextEnvelope);
            sendToParent({
              t: "log",
              stream: "stdout",
              chunk: noise.toString("utf8"),
            });
            stdoutBuffer = stdoutBuffer.subarray(nextEnvelope);
            continue;
          }
          break;
        }

        const lineOffset = skipLineEnd(lineEnd);
        const line = stdoutBuffer.subarray(0, lineOffset);
        sendToParent({
          t: "log",
          stream: "stdout",
          chunk: line.toString("utf8"),
        });
        stdoutBuffer = stdoutBuffer.subarray(lineOffset);
        continue;
      }

      if (stdoutBuffer.length < 4) {
        break;
      }

      const frameLength = stdoutBuffer.readUInt32BE(0);
      if (frameLength === 0 || frameLength > MAX_FRAME) {
        stdoutBuffer = stdoutBuffer.subarray(1);
        continue;
      }

      const frameEnd = 4 + frameLength;
      if (stdoutBuffer.length < frameEnd) {
        break;
      }

      const frame = stdoutBuffer.subarray(0, frameEnd);
      stdoutBuffer = stdoutBuffer.subarray(frameEnd);
      forwardGuestFrame(frame);
    }

    if (!stdoutSynced && stdoutBuffer.length > 64 * 1024) {
      stdoutBuffer = stdoutBuffer.subarray(stdoutBuffer.length - 64 * 1024);
    }
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (data.length === 0) return;
    stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
    parseStdoutFrames();
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
    waitingDrain = false;
    flushOutboundQueue();
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

    if (chunk.length < 4) {
      sendToParent({
        t: "error",
        message: "received short framed payload from host",
      });
      return;
    }

    const payloadLength = chunk.readUInt32BE(0);
    if (payloadLength + 4 > chunk.length) {
      sendToParent({
        t: "error",
        message: "received truncated framed payload from host",
      });
      return;
    }

    let payload = chunk.subarray(4, 4 + payloadLength);
    const channel = message.channel ?? DEFAULT_CHANNEL;

    try {
      const decoded = decodeMessage(payload) as Record<string, unknown>;
      const type = typeof decoded?.t === "string" ? decoded.t : "";
      const hostId = asId(decoded?.id);

      if (isTcpType(type)) {
        const key = makeTcpKey(channel, hostId);

        if (type === "tcp_open") {
          const prior = tcpHostToGuest.get(key);
          if (prior !== undefined) {
            releaseTcpGuestId(prior);
          }

          const guestId = allocateGuestTcpId();
          tcpHostToGuest.set(key, guestId);
          tcpGuestToHost.set(guestId, { channel, hostId });
          decoded.id = guestId;
          payload = encodePayload(decoded);
        } else {
          const guestId = tcpHostToGuest.get(key);
          if (guestId === undefined) {
            sendToParent({
              t: "error",
              message: `unknown tcp stream id on channel=${channel}: ${hostId}`,
            });
            return;
          }
          decoded.id = guestId;
          payload = encodePayload(decoded);

          if (type === "tcp_close") {
            // Keep mapping until the corresponding tcp_closed is observed.
          }
        }
      } else if (isFsRequestType(type)) {
        fsHostToGuest.set(hostId, channel);
      } else if (isFsResponseType(type)) {
        fsGuestToHost.delete(hostId);
      }
    } catch {
      // Preserve forward-compatibility: if decoding fails, relay the raw payload
      // unchanged instead of rejecting host traffic.
    }

    try {
      const lines = encodeStdioEnvelopePayload(payload);
      outboundQueue.push(...lines);
      flushOutboundQueue();
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

  await runWasiStdioMode(
    args.wasmPath,
    args.netSocketPath,
    args.preopens,
    args.wasmArgs,
  );
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

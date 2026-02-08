import { Readable } from "stream";

const DEFAULT_ENCODING = "utf-8";
const DEFAULT_WINDOW_BYTES = 256 * 1024;
const MIN_WINDOW_UPDATE_BYTES = 32 * 1024;

/**
 * Output chunk from a streaming exec, with stream label.
 */
export type OutputChunk = {
  stream: "stdout" | "stderr";
  data: Buffer;
  text: string;
};

/**
 * Result of a completed exec command.
 */
export class ExecResult {
  readonly id: number;
  readonly exitCode: number;
  readonly signal?: number;
  private readonly _stdout: Buffer;
  private readonly _stderr: Buffer;
  private readonly _encoding: BufferEncoding;

  constructor(
    id: number,
    exitCode: number,
    stdout: Buffer,
    stderr: Buffer,
    signal?: number,
    encoding: BufferEncoding = DEFAULT_ENCODING
  ) {
    this.id = id;
    this.exitCode = exitCode;
    this._stdout = stdout;
    this._stderr = stderr;
    this.signal = signal;
    this._encoding = encoding;
  }

  /** stdout as string */
  get stdout(): string {
    return this._stdout.toString(this._encoding);
  }

  /** stderr as string */
  get stderr(): string {
    return this._stderr.toString(this._encoding);
  }

  /** stdout as Buffer (for binary data) */
  get stdoutBuffer(): Buffer {
    return this._stdout;
  }

  /** stderr as Buffer (for binary data) */
  get stderrBuffer(): Buffer {
    return this._stderr;
  }

  /** Parse stdout as JSON */
  json<T = unknown>(): T {
    return JSON.parse(this.stdout) as T;
  }

  /** Split stdout into lines */
  lines(): string[] {
    return this.stdout.split("\n").filter((line) => line.length > 0);
  }

  /** Check if the command succeeded (exit code 0) */
  get ok(): boolean {
    return this.exitCode === 0;
  }

  toString(): string {
    return this.stdout;
  }
}

export type ExecOutputMode =
  | "buffer"
  | "pipe"
  | "inherit"
  | "ignore"
  | NodeJS.WritableStream;

/**
 * Options for exec.
 */
export type ExecOptions = {
  /** extra argv entries passed as shell positional parameters when `command` is a string */
  argv?: string[];
  /** environment variables */
  env?: string[] | Record<string, string>;
  /** working directory */
  cwd?: string;
  /** stdin input (true enables manual write/end) */
  stdin?: boolean | string | Buffer | Readable | AsyncIterable<Buffer>;
  /** whether to allocate a pty */
  pty?: boolean;
  /** string encoding for decoded output (default: utf-8) */
  encoding?: BufferEncoding;
  /** abort signal */
  signal?: AbortSignal;

  /** stdout handling (default: "buffer") */
  stdout?: ExecOutputMode;
  /** stderr handling (default: "buffer") */
  stderr?: ExecOutputMode;

  /**
   * Backpressure window size in `bytes` for stdout/stderr when using streaming modes.
   *
   * Defaults to 256 KiB.
   */
  windowBytes?: number;

  /**
   * Legacy option: whether to buffer stdout/stderr for the result (default: true).
   *
   * - buffer=true: stdout/stderr default to "buffer"
   * - buffer=false: stdout/stderr default to "ignore"
   */
  buffer?: boolean;
};

export type ResolvedExecOutputMode =
  | { mode: "buffer" }
  | { mode: "ignore" }
  | { mode: "pipe" }
  | { mode: "inherit" }
  | { mode: "writable"; stream: NodeJS.WritableStream };

function asWritableStream(value: unknown): NodeJS.WritableStream | null {
  // Best-effort detection: we intentionally only require `.write(...)`.
  // Some call sites pass custom writable-like objects and we don't want to be
  // overly strict. At the same time, avoid obvious false-positives like Buffer.
  if (!value || typeof value !== "object") return null;
  if (Buffer.isBuffer(value)) return null;
  const v: any = value as any;
  if (typeof v.write !== "function") return null;
  return value as NodeJS.WritableStream;
}

export function resolveOutputMode(
  value: ExecOutputMode | undefined,
  legacyBuffer: boolean | undefined,
  streamName: "stdout" | "stderr"
): ResolvedExecOutputMode {
  // Treat custom Node writable streams as a dedicated output mode.
  // Detection is best-effort; if it quacks like a writable, we accept it.
  const writable = asWritableStream(value);
  if (writable) {
    return { mode: "writable", stream: writable };
  }

  const mode = value;
  if (mode === "buffer" || mode === "pipe" || mode === "inherit" || mode === "ignore") {
    return { mode };
  }

  // default based on legacy buffer option
  const buffer = legacyBuffer ?? true;
  if (buffer) return { mode: "buffer" };

  // If output is not being buffered, default to ignore. This avoids accidental deadlocks
  // where the guest blocks on output because the caller didn't consume a pipe.
  return { mode: "ignore" };
}

export function resolveWindowBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WINDOW_BYTES;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_BYTES;
  // Keep sane bounds (also ensures it fits comfortably in uint32)
  return Math.max(4 * 1024, Math.min(16 * 1024 * 1024, Math.trunc(n)));
}

class ExecPipeStream extends Readable {
  constructor(
    windowBytes: number,
    private readonly onConsumed: () => void
  ) {
    super({ highWaterMark: windowBytes });
  }

  private bufferedBytes = 0;
  private consumedPending = 0;
  private consumedScheduled = false;

  getBufferedBytes(): number {
    // `readableLength` reflects Node's internal queue size (what `pause()`/`resume()`
    // interacts with).  Our own `bufferedBytes` tracks byte counts independent of
    // encoding.
    //
    // When these disagree, we must never *undercount* buffered bytes; otherwise we
    // may grant too many credits and allow unbounded growth in the stream buffer.
    const rl = (this as any).readableLength as unknown;
    if (typeof rl === "number" && Number.isFinite(rl)) {
      return Math.max(this.bufferedBytes, rl);
    }
    return this.bufferedBytes;
  }

  private queueConsumed(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.consumedPending += bytes;

    if (this.consumedScheduled) return;
    this.consumedScheduled = true;

    // Defer credit replenishment to avoid re-entrancy and allow pause()/resume()
    // to take effect before we grant more credits.
    queueMicrotask(() => {
      this.consumedScheduled = false;
      const n = this.consumedPending;
      this.consumedPending = 0;
      if (n > 0) this.onConsumed();
    });
  }

  private consume(chunk: unknown) {
    let bytes = 0;
    if (Buffer.isBuffer(chunk)) {
      bytes = chunk.length;
    } else if (typeof chunk === "string") {
      bytes = Buffer.byteLength(chunk);
    }

    if (bytes > 0) {
      // Track bytes buffered independent of Node's readableLength, which can
      // change units when setEncoding() is used.
      this.bufferedBytes = Math.max(0, this.bufferedBytes - bytes);
      this.queueConsumed(bytes);
    }
  }

  override emit(eventName: string | symbol, ...args: any[]): boolean {
    // Intercept actual delivery of data in flowing mode without installing a
    // 'data' listener (which would force flowing mode early and can drop output).
    if (eventName === "data") {
      this.consume(args[0]);
    }
    return super.emit(eventName as any, ...args);
  }

  override read(size?: number): any {
    const chunk = super.read(size as any);

    // In non-flowing mode, reading does not emit 'data', so we need to account
    // credits here.
    const state: any = (this as any)._readableState;
    if (chunk && !state?.flowing) {
      this.consume(chunk);
    }

    return chunk;
  }

  _read(_size: number) {
    // No-op: backpressure is enforced by the host↔guest credit window.
  }

  pushChunk(chunk: Buffer) {
    // We intentionally ignore the return value here; backpressure is enforced
    // by the credit window between host and guest.
    this.bufferedBytes += chunk.length;
    this.push(chunk);
  }

  endStream() {
    this.push(null);
  }
}

export type ExecSession = {
  id: number;

  stdoutMode: ResolvedExecOutputMode;
  stderrMode: ResolvedExecOutputMode;

  // Streaming pipes (only when mode=pipe)
  stdoutPipe: ExecPipeStream | null;
  stderrPipe: ExecPipeStream | null;

  // Buffered output (only when mode=buffer)
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];

  // Flow control window size in `bytes`
  windowBytes: number;

  // Remaining credits granted to the guest in `bytes`
  stdoutCredit: number;
  stderrCredit: number;

  // Pending window update bytes to grant back to the guest
  stdoutUpdatePending: number;
  stderrUpdatePending: number;

  // First output write error (writable mode)
  outputWriteError: Error | null;

  // Whether we already installed an error listener on the stdout/stderr writable
  stdoutWritableErrorHooked: boolean;
  stderrWritableErrorHooked: boolean;

  // Writable backpressure state (only for mode=writable)
  stdoutWritableBlocked: boolean;
  stderrWritableBlocked: boolean;
  stdoutWritableBlockedBytes: number;
  stderrWritableBlockedBytes: number;

  // Called when we want to send a window update to the guest
  sendWindowUpdate: ((stdoutBytes: number, stderrBytes: number) => void) | null;

  resolve: (result: ExecResult) => void;
  reject: (error: Error) => void;
  resultPromise: Promise<ExecResult>;

  stdinEnabled: boolean;
  encoding: BufferEncoding;
  signal?: AbortSignal;
  signalListener?: () => void;

  requestReady: boolean;
  pendingStdin: Array<{ type: "data"; data: Buffer | string } | { type: "eof" }>;
  pendingResize: { rows: number; cols: number } | null;
};

export type ExecProcessCallbacks = {
  sendStdin: (id: number, data: Buffer | string) => void;
  sendStdinEof: (id: number) => void;
  sendResize?: (id: number, rows: number, cols: number) => void;
  cleanup: (id: number) => void;
};

export class ExecProcess implements PromiseLike<ExecResult>, AsyncIterable<string> {
  private attached = false;

  constructor(
    private readonly session: ExecSession,
    private readonly callbacks: ExecProcessCallbacks
  ) {}

  get id(): number {
    return this.session.id;
  }

  then<TResult1 = ExecResult, TResult2 = never>(
    onfulfilled?: ((value: ExecResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.session.resultPromise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<ExecResult | TResult> {
    return this.session.resultPromise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<ExecResult> {
    return this.session.resultPromise.finally(onfinally);
  }

  get result(): Promise<ExecResult> {
    return this.session.resultPromise;
  }

  write(data: string | Buffer): void {
    if (!this.session.stdinEnabled) {
      throw new Error("stdin was not enabled for this exec");
    }
    this.callbacks.sendStdin(this.session.id, data);
  }

  end(): void {
    if (!this.session.stdinEnabled) {
      throw new Error("stdin was not enabled for this exec");
    }
    this.callbacks.sendStdinEof(this.session.id);
  }

  resize(rows: number, cols: number): void {
    if (!this.callbacks.sendResize) return;
    this.callbacks.sendResize(this.session.id, rows, cols);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    const stdout = this.session.stdoutPipe;
    if (!stdout) {
      throw new Error("stdout is not piped (set exec options.stdout=\"pipe\")");
    }
    const encoding = this.session.encoding;
    for await (const chunk of stdout) {
      yield (chunk as Buffer).toString(encoding);
    }
  }

  async *output(): AsyncIterable<OutputChunk> {
    const stdout = this.session.stdoutPipe;
    const stderr = this.session.stderrPipe;
    if (!stdout || !stderr) {
      throw new Error("stdout/stderr are not piped (set exec options.stdout/stderr=\"pipe\")");
    }

    const encoding = this.session.encoding;

    // Merge stdout/stderr without switching streams into flowing mode.
    // Using Readable async iteration preserves credit-based backpressure.
    const outIt = stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    const errIt = stderr[Symbol.asyncIterator]() as AsyncIterator<Buffer>;

    let outNext: Promise<IteratorResult<Buffer>> | null = outIt.next();
    let errNext: Promise<IteratorResult<Buffer>> | null = errIt.next();

    while (outNext || errNext) {
      const raced = await Promise.race([
        outNext
          ? outNext.then((r) => ({ stream: "stdout" as const, r }))
          : new Promise<never>(() => {}),
        errNext
          ? errNext.then((r) => ({ stream: "stderr" as const, r }))
          : new Promise<never>(() => {}),
      ]);

      if (raced.r.done) {
        if (raced.stream === "stdout") outNext = null;
        else errNext = null;
        continue;
      }

      const data = raced.r.value as Buffer;
      yield {
        stream: raced.stream,
        data,
        text: data.toString(encoding),
      };

      if (raced.stream === "stdout") outNext = outIt.next();
      else errNext = errIt.next();
    }
  }

  async *lines(): AsyncIterable<string> {
    const stdout = this.session.stdoutPipe;
    if (!stdout) {
      throw new Error("stdout is not piped (set exec options.stdout=\"pipe\")");
    }

    let buffer = "";
    const encoding = this.session.encoding;

    for await (const chunk of stdout) {
      buffer += (chunk as Buffer).toString(encoding);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        yield line;
      }
    }

    if (buffer.length > 0) {
      yield buffer;
    }
  }

  get stdout(): Readable | null {
    return this.session.stdoutPipe;
  }

  get stderr(): Readable | null {
    return this.session.stderrPipe;
  }

  attach(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, stderr?: NodeJS.WriteStream): void {
    if (this.attached) {
      throw new Error("already attached");
    }
    this.attached = true;

    const out = this.session.stdoutPipe;
    const err = this.session.stderrPipe;

    // In pipe mode we forward output here; in inherit/writable modes output is
    // already written by the VM output router.
    const shouldForwardStdout = out != null;
    const shouldForwardStderr = err != null;

    if (!shouldForwardStdout && !shouldForwardStderr) {
      const hasLiveOutput =
        this.session.stdoutMode.mode === "writable" || this.session.stderrMode.mode === "writable";
      if (!hasLiveOutput) {
        throw new Error(
          "attach() requires streaming output (set exec options stdout/stderr=\"pipe\" or \"inherit\")"
        );
      }
    }

    const stderrOut = stderr ?? stdout;

    const onResize = () => {
      if (!stdout.isTTY) return;
      const cols = stdout.columns;
      const rows = stdout.rows;
      if (typeof cols === "number" && typeof rows === "number") {
        this.resize(rows, cols);
      }
    };

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();

    if (stdout.isTTY) {
      onResize();
      stdout.on("resize", onResize);
    }

    const onStdinData = (chunk: Buffer) => this.write(chunk);
    const onStdinEnd = () => this.end();
    stdin.on("data", onStdinData);
    stdin.on("end", onStdinEnd);

    if (shouldForwardStdout) {
      out!.on("data", (chunk: Buffer) => stdout.write(chunk));
    }
    if (shouldForwardStderr) {
      err!.on("data", (chunk: Buffer) => stderrOut.write(chunk));
    }

    this.session.resultPromise.finally(() => {
      stdin.off("data", onStdinData);
      stdin.off("end", onStdinEnd);
      if (stdout.isTTY) {
        stdout.off("resize", onResize);
      }
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    });
  }
}

export function createExecSession(
  id: number,
  options: {
    stdinEnabled: boolean;
    encoding?: BufferEncoding;
    signal?: AbortSignal;
    stdout: ResolvedExecOutputMode;
    stderr: ResolvedExecOutputMode;
    windowBytes?: number;
  }
): ExecSession {
  let resolve!: (result: ExecResult) => void;
  let reject!: (error: Error) => void;
  const resultPromise = new Promise<ExecResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const windowBytes = resolveWindowBytes(options.windowBytes);

  const session: ExecSession = {
    id,
    stdoutMode: options.stdout,
    stderrMode: options.stderr,
    stdoutPipe: null,
    stderrPipe: null,
    stdoutChunks: [],
    stderrChunks: [],
    windowBytes,
    stdoutCredit: windowBytes,
    stderrCredit: windowBytes,
    stdoutUpdatePending: 0,
    stderrUpdatePending: 0,
    outputWriteError: null,
    stdoutWritableErrorHooked: false,
    stderrWritableErrorHooked: false,
    stdoutWritableBlocked: false,
    stderrWritableBlocked: false,
    stdoutWritableBlockedBytes: 0,
    stderrWritableBlockedBytes: 0,
    sendWindowUpdate: null,
    resolve,
    reject,
    resultPromise,
    stdinEnabled: options.stdinEnabled,
    encoding: options.encoding ?? DEFAULT_ENCODING,
    signal: options.signal,
    requestReady: false,
    pendingStdin: [],
    pendingResize: null,
  };

  if (session.stdoutMode.mode === "pipe") {
    session.stdoutPipe = new ExecPipeStream(windowBytes, () => {
      refillPipeWindow(session, "stdout");
    });
  }
  if (session.stderrMode.mode === "pipe") {
    session.stderrPipe = new ExecPipeStream(windowBytes, () => {
      refillPipeWindow(session, "stderr");
    });
  }

  return session;
}

function refillPipeWindow(session: ExecSession, stream: "stdout" | "stderr") {
  if (!session.sendWindowUpdate) return;

  const pipe = stream === "stdout" ? session.stdoutPipe : session.stderrPipe;
  if (!pipe) return;

  // Keep guest credit aligned with host-side pipe buffering.
  const targetCredit = Math.max(0, session.windowBytes - pipe.getBufferedBytes());

  const advertisedCredit =
    stream === "stdout"
      ? session.stdoutCredit + session.stdoutUpdatePending
      : session.stderrCredit + session.stderrUpdatePending;

  const delta = targetCredit - advertisedCredit;
  if (delta > 0) {
    queueWindowUpdate(session, stream, delta);
  }
}

function updateThreshold(session: ExecSession): number {
  // Coalesce updates, but ensure small windows still make progress.
  return Math.max(1024, Math.min(MIN_WINDOW_UPDATE_BYTES, Math.floor(session.windowBytes / 2)));
}

function flushWindowUpdates(session: ExecSession) {
  if (!session.sendWindowUpdate) return;

  const stdoutBytes = session.stdoutUpdatePending;
  const stderrBytes = session.stderrUpdatePending;
  if (stdoutBytes <= 0 && stderrBytes <= 0) return;

  session.stdoutUpdatePending = 0;
  session.stderrUpdatePending = 0;

  session.stdoutCredit += stdoutBytes;
  session.stderrCredit += stderrBytes;

  session.sendWindowUpdate(stdoutBytes, stderrBytes);
}

function queueWindowUpdate(session: ExecSession, stream: "stdout" | "stderr", bytes: number) {
  if (!session.sendWindowUpdate) return;
  if (!Number.isFinite(bytes) || bytes <= 0) return;

  if (stream === "stdout") session.stdoutUpdatePending += bytes;
  else session.stderrUpdatePending += bytes;

  const threshold = updateThreshold(session);

  // Send if we have a meaningful batch, or if the guest is starved on this stream.
  if (
    session.stdoutUpdatePending >= threshold ||
    session.stderrUpdatePending >= threshold ||
    session.stdoutCredit === 0 ||
    session.stderrCredit === 0
  ) {
    flushWindowUpdates(session);
  }
}

export function finishExecSession(session: ExecSession, exitCode: number, signal?: number): void {
  const result = new ExecResult(
    session.id,
    exitCode,
    Buffer.concat(session.stdoutChunks),
    Buffer.concat(session.stderrChunks),
    signal,
    session.encoding
  );

  session.stdoutPipe?.endStream();
  session.stderrPipe?.endStream();

  if (session.signal && session.signalListener) {
    session.signal.removeEventListener("abort", session.signalListener);
  }

  session.resolve(result);
}

export function rejectExecSession(session: ExecSession, error: Error): void {
  session.stdoutPipe?.endStream();
  session.stderrPipe?.endStream();

  if (session.signal && session.signalListener) {
    session.signal.removeEventListener("abort", session.signalListener);
  }

  session.reject(error);
}

function failWritableOutput(
  session: ExecSession,
  stream: "stdout" | "stderr",
  err: unknown,
  extraBytes: number
) {
  // Switch to ignore mode to avoid deadlocks (we still grant credits back)
  if (stream === "stdout") {
    session.stdoutMode = { mode: "ignore" };
    extraBytes += session.stdoutWritableBlockedBytes;
    session.stdoutWritableBlockedBytes = 0;
    session.stdoutWritableBlocked = false;
  } else {
    session.stderrMode = { mode: "ignore" };
    extraBytes += session.stderrWritableBlockedBytes;
    session.stderrWritableBlockedBytes = 0;
    session.stderrWritableBlocked = false;
  }

  if (extraBytes > 0) {
    queueWindowUpdate(session, stream, extraBytes);
    flushWindowUpdates(session);
  }

  const error = err instanceof Error ? err : new Error(String(err));
  if (!session.outputWriteError) {
    session.outputWriteError = error;
    rejectExecSession(session, new Error(`${stream} output write failed: ${error.message}`));
  }
}

export function applyOutputChunk(session: ExecSession, stream: "stdout" | "stderr", data: Buffer) {
  // Update credit accounting (credits represent what the guest can still send)
  if (stream === "stdout") {
    session.stdoutCredit = Math.max(0, session.stdoutCredit - data.length);
  } else {
    session.stderrCredit = Math.max(0, session.stderrCredit - data.length);
  }

  const mode = stream === "stdout" ? session.stdoutMode : session.stderrMode;

  if (mode.mode === "buffer") {
    if (stream === "stdout") session.stdoutChunks.push(data);
    else session.stderrChunks.push(data);

    // Stored output is consumed immediately.
    queueWindowUpdate(session, stream, data.length);
    return;
  }

  if (mode.mode === "ignore") {
    // Dropped output is consumed immediately.
    queueWindowUpdate(session, stream, data.length);
    return;
  }

  if (mode.mode === "pipe") {
    const pipe = stream === "stdout" ? session.stdoutPipe : session.stderrPipe;
    pipe?.pushChunk(data);
    // Credits are replenished based on host-side pipe buffering.
    return;
  }

  if (mode.mode === "writable") {
    const w: any = mode.stream as any;

    // Observe async errors (e.g. EPIPE on a closed pipe)
    if (typeof w.once === "function") {
      if (stream === "stdout") {
        if (!session.stdoutWritableErrorHooked) {
          session.stdoutWritableErrorHooked = true;
          w.once("error", (err: unknown) => {
            const current = session.stdoutMode;
            if (current.mode === "writable" && (current as any).stream === w) {
              failWritableOutput(session, "stdout", err, 0);
            }
          });
        }
      } else {
        if (!session.stderrWritableErrorHooked) {
          session.stderrWritableErrorHooked = true;
          w.once("error", (err: unknown) => {
            const current = session.stderrMode;
            if (current.mode === "writable" && (current as any).stream === w) {
              failWritableOutput(session, "stderr", err, 0);
            }
          });
        }
      }
    }

    let ok: any;
    try {
      ok = w.write(data);
    } catch (err) {
      // Treat as consumed to avoid guest deadlocks, but fail the exec.
      failWritableOutput(session, stream, err, data.length);
      return;
    }

    if (ok) {
      queueWindowUpdate(session, stream, data.length);
      return;
    }

    // Backpressured: don't grant credits back until drain.
    if (stream === "stdout") {
      session.stdoutWritableBlockedBytes += data.length;
      if (!session.stdoutWritableBlocked) {
        session.stdoutWritableBlocked = true;
        if (typeof w.once === "function") {
          w.once("drain", () => {
            const n = session.stdoutWritableBlockedBytes;
            session.stdoutWritableBlockedBytes = 0;
            session.stdoutWritableBlocked = false;
            if (n > 0) {
              queueWindowUpdate(session, "stdout", n);
              flushWindowUpdates(session);
            }
          });
        } else {
          // Unknown writable implementation: avoid deadlocking by treating as consumed.
          queueWindowUpdate(session, "stdout", session.stdoutWritableBlockedBytes);
          session.stdoutWritableBlockedBytes = 0;
          session.stdoutWritableBlocked = false;
          flushWindowUpdates(session);
        }
      }
    } else {
      session.stderrWritableBlockedBytes += data.length;
      if (!session.stderrWritableBlocked) {
        session.stderrWritableBlocked = true;
        if (typeof w.once === "function") {
          w.once("drain", () => {
            const n = session.stderrWritableBlockedBytes;
            session.stderrWritableBlockedBytes = 0;
            session.stderrWritableBlocked = false;
            if (n > 0) {
              queueWindowUpdate(session, "stderr", n);
              flushWindowUpdates(session);
            }
          });
        } else {
          // Unknown writable implementation: avoid deadlocking by treating as consumed.
          queueWindowUpdate(session, "stderr", session.stderrWritableBlockedBytes);
          session.stderrWritableBlockedBytes = 0;
          session.stderrWritableBlocked = false;
          flushWindowUpdates(session);
        }
      }
    }

    return;
  }

  // inherit should not reach here (resolved to writable by VM)
}

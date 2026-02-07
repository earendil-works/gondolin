import { PassThrough, Readable } from "stream";

const DEFAULT_ENCODING = "utf-8";

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

/**
 * Options for exec/execStream.
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
  /** whether to buffer stdout/stderr for the result (default: true) */
  buffer?: boolean;
};

/**
 * Internal session state for tracking an exec command.
 */
export type ExecSession = {
  id: number;
  stdout: PassThrough;
  stderr: PassThrough;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  resolve: (result: ExecResult) => void;
  reject: (error: Error) => void;
  resultPromise: Promise<ExecResult>;
  stdinEnabled: boolean;
  encoding: BufferEncoding;
  signal?: AbortSignal;
  signalListener?: () => void;
  buffer: boolean;
  iterating: boolean;
  requestReady: boolean;
  pendingStdin: Array<{ type: "data"; data: Buffer | string } | { type: "eof" }>;
  pendingResize: { rows: number; cols: number } | null;
};

/**
 * Callbacks for ExecProcess to communicate with VM.
 */
export type ExecProcessCallbacks = {
  sendStdin: (id: number, data: Buffer | string) => void;
  sendStdinEof: (id: number) => void;
  sendResize?: (id: number, rows: number, cols: number) => void;
  cleanup: (id: number) => void;
};

/**
 * A running exec process that is both a Promise and an AsyncIterable.
 * 
 * Usage:
 * ```typescript
 * // Await for buffered result (strings)
 * // NOTE: `vm.exec([cmd, ...argv])` does not search `$PATH`
 * const result = await vm.exec(["/bin/echo", "hello"]);
 * console.log(result.stdout);
 * 
 * // Iterate for streaming output
 * for await (const chunk of vm.exec(["/bin/tail", "-f", "/var/log/syslog"])) {
 *   console.log(chunk);
 * }
 * 
 * // Interactive with stdin
 * const proc = vm.exec(["/bin/sh"], { stdin: true, pty: true });
 * proc.write("ls\n");
 * for await (const chunk of proc) {
 *   process.stdout.write(chunk);
 * }
 * ```
 */
export class ExecProcess implements PromiseLike<ExecResult>, AsyncIterable<string> {
  private readonly session: ExecSession;
  private readonly callbacks: ExecProcessCallbacks;
  private attached = false;

  constructor(session: ExecSession, callbacks: ExecProcessCallbacks) {
    this.session = session;
    this.callbacks = callbacks;
  }

  /** The process ID */
  get id(): number {
    return this.session.id;
  }

  /**
   * Promise interface - await this to get the buffered result.
   */
  then<TResult1 = ExecResult, TResult2 = never>(
    onfulfilled?: ((value: ExecResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.session.resultPromise.then(onfulfilled, onrejected);
  }

  /**
   * Catch interface for promise compatibility.
   */
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<ExecResult | TResult> {
    return this.session.resultPromise.catch(onrejected);
  }

  /**
   * Finally interface for promise compatibility.
   */
  finally(onfinally?: (() => void) | null): Promise<ExecResult> {
    return this.session.resultPromise.finally(onfinally);
  }

  /**
   * The underlying result promise.
   */
  get result(): Promise<ExecResult> {
    return this.session.resultPromise;
  }

  /**
   * Write data to stdin (only if stdin was enabled).
   */
  write(data: string | Buffer): void {
    if (!this.session.stdinEnabled) {
      throw new Error("stdin was not enabled for this exec");
    }
    this.callbacks.sendStdin(this.session.id, data);
  }

  /**
   * Close stdin (only if stdin was enabled).
   */
  end(): void {
    if (!this.session.stdinEnabled) {
      throw new Error("stdin was not enabled for this exec");
    }
    this.callbacks.sendStdinEof(this.session.id);
  }

  /**
   * Resize the PTY if supported by the underlying transport.
   */
  resize(rows: number, cols: number): void {
    if (!this.callbacks.sendResize) return;
    this.callbacks.sendResize(this.session.id, rows, cols);
  }

  /**
   * Async iterator over stdout lines/chunks as strings.
   * Default iteration yields stdout only.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    this.session.iterating = true;
    const encoding = this.session.encoding;

    for await (const chunk of this.session.stdout) {
      yield (chunk as Buffer).toString(encoding);
    }
  }

  /**
   * Async iterator over labeled output chunks from both stdout and stderr.
   */
  async *output(): AsyncIterable<OutputChunk> {
    this.session.iterating = true;
    const encoding = this.session.encoding;

    // We need to merge stdout and stderr streams while preserving order
    // This is tricky because we have two separate streams
    // We'll use a simple interleaving approach with a shared queue

    type QueueItem = { stream: "stdout" | "stderr"; data: Buffer } | { done: true };
    const queue: QueueItem[] = [];
    let resolveWait: (() => void) | null = null;
    let stdoutDone = false;
    let stderrDone = false;

    const push = (item: QueueItem) => {
      queue.push(item);
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    };

    this.session.stdout.on("data", (chunk: Buffer) => {
      push({ stream: "stdout", data: chunk });
    });
    this.session.stdout.on("end", () => {
      stdoutDone = true;
      if (stderrDone) push({ done: true });
    });

    this.session.stderr.on("data", (chunk: Buffer) => {
      push({ stream: "stderr", data: chunk });
    });
    this.session.stderr.on("end", () => {
      stderrDone = true;
      if (stdoutDone) push({ done: true });
    });

    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
      }

      const item = queue.shift()!;
      if ("done" in item) break;

      yield {
        stream: item.stream,
        data: item.data,
        text: item.data.toString(encoding),
      };
    }
  }

  /**
   * Async iterator over lines from stdout.
   */
  async *lines(): AsyncIterable<string> {
    let buffer = "";
    const encoding = this.session.encoding;

    for await (const chunk of this.session.stdout) {
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

  /**
   * Direct access to stdout stream.
   */
  get stdout(): Readable {
    return this.session.stdout;
  }

  /**
   * Direct access to stderr stream.
   */
  get stderr(): Readable {
    return this.session.stderr;
  }

  /**
   * Attach to terminal streams for interactive use.
   * Handles raw mode, stdin piping, and cleanup automatically.
   * 
   * @param stdin - Input stream (e.g., process.stdin)
   * @param stdout - Output stream for stdout (e.g., process.stdout)
   * @param stderr - Output stream for stderr (optional, defaults to stdout)
   */
  attach(
    stdin: NodeJS.ReadStream,
    stdout: NodeJS.WriteStream,
    stderr?: NodeJS.WriteStream
  ): void {
    if (this.attached) {
      throw new Error("already attached");
    }
    this.attached = true;

    const stderrOut = stderr ?? stdout;

    const onResize = () => {
      if (!stdout.isTTY) return;
      const cols = stdout.columns;
      const rows = stdout.rows;
      if (typeof cols === "number" && typeof rows === "number") {
        this.resize(rows, cols);
      }
    };

    // Setup raw mode for TTY
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();

    if (stdout.isTTY) {
      onResize();
      stdout.on("resize", onResize);
    }

    // Pipe stdin to process
    const onStdinData = (chunk: Buffer) => {
      this.write(chunk);
    };
    const onStdinEnd = () => {
      this.end();
    };
    stdin.on("data", onStdinData);
    stdin.on("end", onStdinEnd);

    // Pipe output to stdout/stderr
    this.session.stdout.on("data", (chunk: Buffer) => {
      stdout.write(chunk);
    });
    this.session.stderr.on("data", (chunk: Buffer) => {
      stderrOut.write(chunk);
    });

    // Cleanup on exit
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

/**
 * Create an ExecSession with the given parameters.
 */
export function createExecSession(
  id: number,
  options: {
    stdinEnabled: boolean;
    encoding?: BufferEncoding;
    signal?: AbortSignal;
    buffer?: boolean;
  }
): ExecSession {
  let resolve!: (result: ExecResult) => void;
  let reject!: (error: Error) => void;
  const resultPromise = new Promise<ExecResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const session: ExecSession = {
    id,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdoutChunks: [],
    stderrChunks: [],
    resolve,
    reject,
    resultPromise,
    stdinEnabled: options.stdinEnabled,
    encoding: options.encoding ?? DEFAULT_ENCODING,
    signal: options.signal,
    buffer: options.buffer ?? true,
    iterating: false,
    requestReady: false,
    pendingStdin: [],
    pendingResize: null,
  };

  // Output buffering is handled in VM.handleMessage to avoid
  // putting the streams into flowing mode before a consumer attaches.

  return session;
}

/**
 * Finish an ExecSession with a successful result.
 */
export function finishExecSession(
  session: ExecSession,
  exitCode: number,
  signal?: number
): void {
  const result = new ExecResult(
    session.id,
    exitCode,
    Buffer.concat(session.stdoutChunks),
    Buffer.concat(session.stderrChunks),
    signal,
    session.encoding
  );

  session.stdout.end();
  session.stderr.end();

  if (session.signal && session.signalListener) {
    session.signal.removeEventListener("abort", session.signalListener);
  }

  session.resolve(result);
}

/**
 * Reject an ExecSession with an error.
 */
export function rejectExecSession(session: ExecSession, error: Error): void {
  session.stdout.end();
  session.stderr.end();

  if (session.signal && session.signalListener) {
    session.signal.removeEventListener("abort", session.signalListener);
  }

  session.reject(error);
}

import { WebSocket } from "ws";
import type { RawData } from "ws";
import { PassThrough, Readable } from "stream";

import {
  ErrorMessage,
  ExecResponseMessage,
  StatusMessage,
  decodeOutputFrame,
  SandboxPolicy,
} from "./ws-protocol";
import { SandboxWsServer, SandboxWsServerOptions } from "./sandbox-ws-server";
import type { SandboxState } from "./sandbox-controller";
import type { HttpFetch, HttpHooks } from "./qemu-net";

const MAX_REQUEST_ID = 0xffffffff;
const DEFAULT_STDIN_CHUNK = 32 * 1024;

type ExecInput = string | string[];

type ExecStdin = boolean | string | Buffer | Readable | AsyncIterable<Buffer>;

export type ExecOptions = {
  argv?: string[];
  env?: string[];
  cwd?: string;
  stdin?: ExecStdin;
  pty?: boolean;
  stdout?: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
  signal?: AbortSignal;
};

export type ExecStreamOptions = ExecOptions & {
  buffer?: boolean;
};

export type ExecResult = {
  id: number;
  exitCode: number;
  signal?: number;
  stdout: Buffer;
  stderr: Buffer;
};

export type ExecStream = {
  id: number;
  stdout: Readable;
  stderr: Readable;
  sendStdin: (data: Buffer | string) => Promise<void>;
  endStdin: () => Promise<void>;
  result: Promise<ExecResult>;
};

export type VMOptions = {
  url?: string;
  token?: string;
  server?: SandboxWsServerOptions;
  policy?: SandboxPolicy;
  autoStart?: boolean;
  fetch?: HttpFetch;
  httpHooks?: HttpHooks;
};

type ExecSession = {
  id: number;
  stdout: PassThrough;
  stderr: PassThrough;
  bufferOutput: boolean;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  resolve: (result: ExecResult) => void;
  reject: (error: Error) => void;
  result: Promise<ExecResult>;
  stdinEnabled: boolean;
  stdoutCallback?: (chunk: Buffer) => void;
  stderrCallback?: (chunk: Buffer) => void;
  signal?: AbortSignal;
  signalListener?: () => void;
};

export class VM {
  private readonly token?: string;
  private readonly autoStart: boolean;
  private readonly server: SandboxWsServer | null;
  private url: string | null;
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private statusPromise: Promise<SandboxState> | null = null;
  private statusResolve: ((state: SandboxState) => void) | null = null;
  private statusReject: ((error: Error) => void) | null = null;
  private state: SandboxState | "unknown" = "unknown";
  private stateWaiters: Array<{
    state: SandboxState;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private sessions = new Map<number, ExecSession>();
  private nextId = 1;
  private policy: SandboxPolicy | null;

  constructor(options: VMOptions = {}) {
    if (options.url && options.server) {
      throw new Error("VM cannot specify both url and server options");
    }

    this.token =
      options.token ?? process.env.ELWING_TOKEN ?? process.env.SANDBOX_WS_TOKEN;
    this.autoStart = options.autoStart ?? true;
    this.policy = options.policy ?? null;

    if (options.url) {
      this.url = options.url;
      this.server = null;
      return;
    }

    const serverOptions: SandboxWsServerOptions = { ...options.server };
    if (options.fetch && serverOptions.fetch === undefined) {
      serverOptions.fetch = options.fetch;
    }
    if (options.httpHooks && serverOptions.httpHooks === undefined) {
      serverOptions.httpHooks = options.httpHooks;
    }
    if (serverOptions.host === undefined) serverOptions.host = "127.0.0.1";
    if (serverOptions.port === undefined) serverOptions.port = 0;
    if (this.policy && serverOptions.policy === undefined) {
      serverOptions.policy = this.policy;
    }

    this.server = new SandboxWsServer(serverOptions);
    this.url = null;
  }

  getState() {
    return this.state;
  }

  getUrl() {
    return this.url;
  }

  getPolicy() {
    return this.policy;
  }

  setPolicy(policy: SandboxPolicy) {
    this.policy = policy;
    if (this.server) {
      this.server.setPolicy(policy);
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendJson({ type: "policy", policy });
    }
  }

  async start() {
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = null;
    });

    return this.stopPromise;
  }

  async exec(command: ExecInput, options: ExecOptions = {}): Promise<ExecResult> {
    const stream = await this.execStream(command, { ...options, buffer: true });
    return stream.result;
  }

  async execStream(
    command: ExecInput,
    options: ExecStreamOptions = {}
  ): Promise<ExecStream> {
    await this.start();

    const { cmd, argv } = normalizeCommand(command, options);
    const id = this.allocateId();

    const stdinSetting = options.stdin;
    const stdinEnabled = stdinSetting !== undefined && stdinSetting !== false;

    const session = this.createSession(id, {
      bufferOutput: options.buffer ?? false,
      stdinEnabled,
      stdout: options.stdout,
      stderr: options.stderr,
      signal: options.signal,
    });

    this.sessions.set(id, session);

    const message = {
      type: "exec" as const,
      id,
      cmd,
      argv: argv.length ? argv : undefined,
      env: options.env && options.env.length ? options.env : undefined,
      cwd: options.cwd,
      stdin: stdinEnabled ? true : undefined,
      pty: options.pty ? true : undefined,
    };

    try {
      this.sendJson(message);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectSession(session, error);
      throw error;
    }

    if (stdinEnabled && stdinSetting !== true) {
      void this.pipeStdin(id, stdinSetting ?? "", session);
    }

    return {
      id,
      stdout: session.stdout,
      stderr: session.stderr,
      sendStdin: async (data: Buffer | string) => {
        this.ensureStdinAllowed(id);
        this.sendStdinData(id, data);
      },
      endStdin: async () => {
        this.ensureStdinAllowed(id);
        this.sendStdinEof(id);
      },
      result: session.result,
    };
  }

  private async startInternal() {
    if (this.server) {
      const address = await this.server.start();
      this.url = address.url;
    }

    await this.ensureConnection();
    await this.ensureRunning();
  }

  private async stopInternal() {
    if (this.server) {
      await this.server.stop();
      this.url = null;
    }
    await this.disconnect();
  }

  private allocateId(): number {
    for (let i = 0; i <= MAX_REQUEST_ID; i += 1) {
      const id = this.nextId;
      this.nextId = this.nextId + 1;
      if (this.nextId > MAX_REQUEST_ID) this.nextId = 1;
      if (!this.sessions.has(id)) return id;
    }
    throw new Error("no available request ids");
  }

  private createSession(
    id: number,
    options: {
      bufferOutput: boolean;
      stdinEnabled: boolean;
      stdout?: (chunk: Buffer) => void;
      stderr?: (chunk: Buffer) => void;
      signal?: AbortSignal;
    }
  ): ExecSession {
    let resolve!: (result: ExecResult) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<ExecResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const session: ExecSession = {
      id,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      bufferOutput: options.bufferOutput,
      stdoutChunks: [],
      stderrChunks: [],
      resolve,
      reject,
      result,
      stdinEnabled: options.stdinEnabled,
      stdoutCallback: options.stdout,
      stderrCallback: options.stderr,
      signal: options.signal,
    };

    if (options.signal) {
      const onAbort = () => {
        this.rejectSession(session, new Error("exec aborted"));
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      session.signalListener = onAbort;
    }

    return session;
  }

  private ensureStdinAllowed(id: number) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`stdin is not available for request ${id}`);
    }
    if (!session.stdinEnabled) {
      throw new Error(`stdin was not enabled for request ${id}`);
    }
  }

  private async pipeStdin(id: number, input: ExecStdin, session: ExecSession) {
    if (!session.stdinEnabled) return;
    try {
      if (typeof input === "string" || Buffer.isBuffer(input)) {
        this.sendStdinData(id, input);
      } else if (typeof input === "boolean") {
        // no-op
      } else {
        for await (const chunk of toAsyncIterable(input)) {
          if (!this.sessions.has(id)) return;
          this.sendStdinData(id, chunk);
        }
      }
      if (this.sessions.has(id)) {
        this.sendStdinEof(id);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectSession(session, error);
    }
  }

  private sendStdinData(id: number, data: Buffer | string) {
    const payload = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    for (let offset = 0; offset < payload.length; offset += DEFAULT_STDIN_CHUNK) {
      const slice = payload.subarray(offset, offset + DEFAULT_STDIN_CHUNK);
      this.sendJson({
        type: "stdin",
        id,
        data: slice.toString("base64"),
      });
    }
  }

  private sendStdinEof(id: number) {
    this.sendJson({
      type: "stdin",
      id,
      eof: true,
    });
  }

  private async ensureConnection() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    if (!this.url) {
      throw new Error("WebSocket URL is not available");
    }

    this.resetConnectionState();

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.token) headers.Authorization = `Bearer ${this.token}`;

      const ws = new WebSocket(this.url!, { headers });
      this.ws = ws;
      let opened = false;

      ws.on("open", () => {
        opened = true;
        this.flushPolicy();
        resolve();
      });

      ws.on("message", (data, isBinary) => {
        this.handleMessage(data, isBinary);
      });

      ws.on("close", () => {
        const error = new Error("WebSocket closed");
        if (!opened) {
          reject(error);
        }
        this.handleDisconnect(error);
      });

      ws.on("error", (err) => {
        if (!opened) {
          reject(err);
          return;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        this.handleDisconnect(error);
      });
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private resetConnectionState() {
    this.state = "unknown";
    this.initStatusPromise();
  }

  private initStatusPromise() {
    this.statusPromise = new Promise((resolve, reject) => {
      this.statusResolve = resolve;
      this.statusReject = reject;
    });
  }

  private flushPolicy() {
    if (this.policy) {
      this.sendJson({ type: "policy", policy: this.policy });
    }
  }

  private async ensureRunning() {
    const state = await this.waitForStatus();
    if (state === "running") return;

    if (state === "stopped") {
      if (!this.autoStart) {
        throw new Error("sandbox is stopped");
      }
      this.sendJson({ type: "lifecycle", action: "restart" });
    }

    await this.waitForState("running");
  }

  private async waitForStatus(): Promise<SandboxState> {
    if (this.state !== "unknown") return this.state;
    if (!this.statusPromise) {
      this.initStatusPromise();
    }
    return this.statusPromise!;
  }

  private waitForState(state: SandboxState): Promise<void> {
    if (this.state === state) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.stateWaiters.push({ state, resolve, reject });
    });
  }

  private handleMessage(data: RawData, isBinary: boolean) {
    if (isBinary) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const frame = decodeOutputFrame(buffer);
      const session = this.sessions.get(frame.id);
      if (!session) return;
      if (frame.stream === "stdout") {
        session.stdout.write(frame.data);
        if (session.bufferOutput) session.stdoutChunks.push(frame.data);
        session.stdoutCallback?.(frame.data);
      } else {
        session.stderr.write(frame.data);
        if (session.bufferOutput) session.stderrChunks.push(frame.data);
        session.stderrCallback?.(frame.data);
      }
      return;
    }

    let message: StatusMessage | ExecResponseMessage | ErrorMessage;
    try {
      message = JSON.parse(data.toString()) as StatusMessage | ExecResponseMessage | ErrorMessage;
    } catch {
      return;
    }

    if (message.type === "status") {
      this.updateState(message.state);
      return;
    }

    if (message.type === "exec_response") {
      this.handleExecResponse(message);
      return;
    }

    if (message.type === "error") {
      this.handleError(message);
    }
  }

  private updateState(state: SandboxState) {
    this.state = state;

    if (this.statusResolve) {
      this.statusResolve(state);
      this.statusResolve = null;
      this.statusReject = null;
      this.statusPromise = null;
    }

    if (this.stateWaiters.length > 0) {
      const remaining: typeof this.stateWaiters = [];
      for (const waiter of this.stateWaiters) {
        if (waiter.state === state) {
          waiter.resolve();
        } else {
          remaining.push(waiter);
        }
      }
      this.stateWaiters = remaining;
    }
  }

  private handleExecResponse(message: ExecResponseMessage) {
    const session = this.sessions.get(message.id);
    if (!session) return;
    const result: ExecResult = {
      id: message.id,
      exitCode: message.exit_code ?? 1,
      signal: message.signal,
      stdout: session.bufferOutput ? Buffer.concat(session.stdoutChunks) : Buffer.alloc(0),
      stderr: session.bufferOutput ? Buffer.concat(session.stderrChunks) : Buffer.alloc(0),
    };
    this.finishSession(session, result);
  }

  private handleError(message: ErrorMessage) {
    const error = new Error(`error ${message.code}: ${message.message}`);
    if (message.id === undefined) {
      this.rejectAll(error);
      return;
    }
    const session = this.sessions.get(message.id);
    if (session) {
      this.rejectSession(session, error);
    }
  }

  private finishSession(session: ExecSession, result: ExecResult) {
    this.sessions.delete(session.id);
    session.stdout.end();
    session.stderr.end();
    if (session.signal && session.signalListener) {
      session.signal.removeEventListener("abort", session.signalListener);
    }
    session.resolve(result);
  }

  private rejectSession(session: ExecSession, error: Error) {
    this.sessions.delete(session.id);
    session.stdout.end();
    session.stderr.end();
    if (session.signal && session.signalListener) {
      session.signal.removeEventListener("abort", session.signalListener);
    }
    session.reject(error);
  }

  private rejectAll(error: Error) {
    for (const session of this.sessions.values()) {
      this.rejectSession(session, error);
    }
    this.sessions.clear();
  }

  private handleDisconnect(error?: Error) {
    this.ws = null;
    if (this.statusReject) {
      this.statusReject(error ?? new Error("WebSocket disconnected"));
      this.statusReject = null;
      this.statusResolve = null;
      this.statusPromise = null;
    }
    if (this.stateWaiters.length > 0) {
      for (const waiter of this.stateWaiters) {
        waiter.reject(error ?? new Error("WebSocket disconnected"));
      }
      this.stateWaiters = [];
    }
    this.rejectAll(error ?? new Error("WebSocket disconnected"));
  }

  private async disconnect() {
    if (!this.ws) return;

    const ws = this.ws;
    this.ws = null;

    if (ws.readyState === WebSocket.CLOSED) return;

    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve();
      };

      const timeout = setTimeout(() => {
        ws.terminate();
        finish();
      }, 1000);

      ws.once("close", finish);
      ws.once("error", finish);

      if (ws.readyState === WebSocket.CLOSING) {
        return;
      }

      ws.close();
    });
  }

  private sendJson(message: object) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.ws.send(JSON.stringify(message));
  }
}

function normalizeCommand(command: ExecInput, options: ExecOptions): {
  cmd: string;
  argv: string[];
} {
  if (Array.isArray(command)) {
    if (command.length === 0) {
      throw new Error("command array must include the executable");
    }
    return { cmd: command[0], argv: command.slice(1) };
  }

  return { cmd: command, argv: options.argv ?? [] };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Buffer> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<Buffer>)[Symbol.asyncIterator] === "function"
  );
}

async function* toAsyncIterable(value: ExecStdin): AsyncIterable<Buffer> {
  if (typeof value === "string" || Buffer.isBuffer(value) || typeof value === "boolean") {
    return;
  }

  if (isAsyncIterable(value)) {
    for await (const chunk of value) {
      yield Buffer.from(chunk);
    }
    return;
  }

  if (value instanceof Readable) {
    for await (const chunk of value) {
      yield Buffer.from(chunk as Buffer);
    }
    return;
  }

  throw new Error("unsupported stdin type");
}

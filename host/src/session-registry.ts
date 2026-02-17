import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

import type { SandboxConnection } from "./sandbox-server";
import {
  decodeOutputFrame,
  encodeOutputFrame,
  type ClientMessage,
  type ErrorMessage,
  type ExecCommandMessage,
  type ExecResponseMessage,
  type ExecWindowCommandMessage,
  type PtyResizeCommandMessage,
  type ServerMessage,
  type StdinCommandMessage,
} from "./control-protocol";

const CACHE_BASE =
  process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");

const SESSIONS_DIR =
  process.env.GONDOLIN_SESSIONS_DIR ??
  path.join(CACHE_BASE, "gondolin", "sessions");

const MAX_REQUEST_ID = 0xffffffff;
const INTERNAL_ID_FLOOR = 0x80000000;

/** persisted session metadata */
export type SessionInfo = {
  /** session uuid */
  id: string;
  /** host process pid */
  pid: number;
  /** unix socket path for IPC */
  socketPath: string;
  /** iso 8601 creation timestamp */
  createdAt: string;
  /** human-readable label */
  label?: string;
};

/** discovered session entry */
export type SessionEntry = SessionInfo & {
  /** whether the session socket is connectable */
  alive: boolean;
};

function ensureSessionsDir(): string {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  return SESSIONS_DIR;
}

function metadataPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function socketPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.sock`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isSocketAlive(sockPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) {
      resolve(false);
      return;
    }

    const socket = net.createConnection({ path: sockPath });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** register a live session */
export function registerSession(options: { id: string; label?: string }): {
  socketPath: string;
  metadataPath: string;
} {
  ensureSessionsDir();

  const sockPath = socketPath(options.id);
  const metaPath = metadataPath(options.id);

  const info: SessionInfo = {
    id: options.id,
    pid: process.pid,
    socketPath: sockPath,
    createdAt: new Date().toISOString(),
    label: options.label,
  };

  fs.writeFileSync(metaPath, JSON.stringify(info, null, 2) + "\n");
  return { socketPath: sockPath, metadataPath: metaPath };
}

/** unregister a session */
export function unregisterSession(id: string): void {
  try {
    fs.rmSync(metadataPath(id), { force: true });
  } catch {
    // ignore
  }

  try {
    fs.rmSync(socketPath(id), { force: true });
  } catch {
    // ignore
  }
}

/** list known sessions */
export async function listSessions(): Promise<SessionEntry[]> {
  const dir = ensureSessionsDir();
  let files: string[];

  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const entries: SessionEntry[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const filePath = path.join(dir, file);

    try {
      const info = JSON.parse(fs.readFileSync(filePath, "utf8")) as SessionInfo;
      if (!info.id || !Number.isInteger(info.pid) || !info.socketPath) {
        continue;
      }

      const pidAlive = isPidAlive(info.pid);
      const sockAlive = pidAlive ? await isSocketAlive(info.socketPath) : false;

      entries.push({ ...info, alive: pidAlive && sockAlive });
    } catch {
      // ignore malformed metadata
    }
  }

  entries.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return entries;
}

/** collect stale sessions and orphan socket files */
export async function gcSessions(): Promise<number> {
  const dir = ensureSessionsDir();
  let files: string[];

  try {
    files = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  const staleIds = new Set<string>();
  const knownIds = new Set<string>();

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const filePath = path.join(dir, file);

    try {
      const info = JSON.parse(fs.readFileSync(filePath, "utf8")) as SessionInfo;
      if (!info.id || !Number.isInteger(info.pid) || !info.socketPath) {
        staleIds.add(file.replace(/\.json$/, ""));
        continue;
      }

      knownIds.add(info.id);

      if (!isPidAlive(info.pid)) {
        staleIds.add(info.id);
        continue;
      }

      const alive = await isSocketAlive(info.socketPath);
      if (!alive) {
        staleIds.add(info.id);
      }
    } catch {
      staleIds.add(file.replace(/\.json$/, ""));
    }
  }

  for (const file of files) {
    if (!file.endsWith(".sock")) continue;
    const id = file.replace(/\.sock$/, "");
    if (!knownIds.has(id)) {
      staleIds.add(id);
    }
  }

  for (const id of staleIds) {
    unregisterSession(id);
  }

  return staleIds.size;
}

/** find a session by exact or prefix id */
export async function findSession(query: string): Promise<SessionEntry | null> {
  const sessions = await listSessions();
  const needle = query.toLowerCase();

  const exact = sessions.find((session) => session.id === needle);
  if (exact) return exact;

  const matches = sessions.filter((session) => session.id.startsWith(needle));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;

  throw new Error(
    `ambiguous session prefix '${query}' matches ${matches.length} sessions:\n` +
      matches.map((session) => `  ${session.id}`).join("\n"),
  );
}

function isNonTerminalExecErrorCode(code: string): boolean {
  return code === "stdin_backpressure" || code === "stdin_chunk_too_large";
}

function sendFramed(socket: net.Socket, type: 0 | 1, payload: Buffer): boolean {
  if (socket.destroyed || !socket.writable) return false;

  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);

  try {
    socket.write(Buffer.concat([header, payload]));
    return true;
  } catch {
    return false;
  }
}

function sendJson(socket: net.Socket, message: ServerMessage): boolean {
  return sendFramed(socket, 0, Buffer.from(JSON.stringify(message)));
}

function sendError(
  socket: net.Socket,
  code: string,
  message: string,
  id?: number,
): boolean {
  const payload: ErrorMessage = {
    type: "error",
    code,
    message,
    id,
  };
  return sendJson(socket, payload);
}

export class SessionIpcServer {
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  private allocatedInternalIds = new Set<number>();
  private nextInternalId = 0xffffffff;

  constructor(
    private readonly sockPath: string,
    private readonly connectToSandbox: (
      onMessage: (data: Buffer | string, isBinary: boolean) => void,
      onClose?: () => void,
    ) => SandboxConnection,
  ) {}

  start(): void {
    if (this.server) return;

    try {
      fs.rmSync(this.sockPath, { force: true });
    } catch {
      // ignore
    }

    const server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    server.on("error", () => {
      // ignore
    });

    server.listen(this.sockPath);
    this.server = server;
  }

  async close(): Promise<void> {
    for (const socket of this.clients) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.clients.clear();

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    try {
      fs.rmSync(this.sockPath, { force: true });
    } catch {
      // ignore
    }
  }

  private allocateInternalId(): number {
    for (let i = 0; i <= MAX_REQUEST_ID; i += 1) {
      if (
        this.nextInternalId < INTERNAL_ID_FLOOR ||
        this.nextInternalId === 0
      ) {
        this.nextInternalId = 0xffffffff;
      }

      const candidate = this.nextInternalId;
      this.nextInternalId = (this.nextInternalId - 1) >>> 0;

      if (candidate < INTERNAL_ID_FLOOR) continue;
      if (this.allocatedInternalIds.has(candidate)) continue;

      this.allocatedInternalIds.add(candidate);
      return candidate;
    }

    throw new Error("no available internal request ids");
  }

  private releaseInternalId(id: number): void {
    this.allocatedInternalIds.delete(id);
  }

  private handleConnection(socket: net.Socket): void {
    this.clients.add(socket);
    socket.setNoDelay(true);

    // Per-client id translation to keep each external channel independent.
    const externalToInternal = new Map<number, number>();
    const internalToExternal = new Map<number, number>();

    let connection: SandboxConnection | null = null;

    try {
      connection = this.connectToSandbox(
        (data, isBinary) => {
          if (isBinary) {
            try {
              const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
              const decoded = decodeOutputFrame(frame);
              const externalId = internalToExternal.get(decoded.id);
              if (externalId === undefined) {
                return;
              }

              const remapped = encodeOutputFrame(
                externalId,
                decoded.stream,
                decoded.data,
              );
              sendFramed(socket, 1, remapped);
            } catch {
              // ignore malformed frames
            }
            return;
          }

          let message: ServerMessage;
          try {
            message = JSON.parse(
              typeof data === "string" ? data : data.toString(),
            ) as ServerMessage;
          } catch {
            return;
          }

          if (message.type === "exec_response") {
            const externalId = internalToExternal.get(message.id);
            if (externalId === undefined) return;

            const remapped: ExecResponseMessage = {
              ...message,
              id: externalId,
            };

            sendJson(socket, remapped);

            const internalId = message.id;
            internalToExternal.delete(internalId);
            externalToInternal.delete(externalId);
            this.releaseInternalId(internalId);
            return;
          }

          if (message.type === "error" && message.id !== undefined) {
            const externalId = internalToExternal.get(message.id);
            if (externalId === undefined) return;

            const remapped: ErrorMessage = {
              ...message,
              id: externalId,
            };

            sendJson(socket, remapped);

            if (!isNonTerminalExecErrorCode(message.code)) {
              const internalId = message.id;
              internalToExternal.delete(internalId);
              externalToInternal.delete(externalId);
              this.releaseInternalId(internalId);
            }
            return;
          }

          sendJson(socket, message);
        },
        () => {
          socket.destroy();
        },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      sendError(socket, "ipc_unavailable", detail);
      socket.destroy();
      return;
    }

    let readBuffer = Buffer.alloc(0);
    let expectedLength: number | null = null;

    const handleExec = (message: ExecCommandMessage): void => {
      if (!Number.isInteger(message.id) || message.id < 0) {
        sendError(socket, "invalid_request", "exec requires a uint32 id");
        return;
      }

      if (externalToInternal.has(message.id)) {
        sendError(
          socket,
          "duplicate_id",
          "request id already in use",
          message.id,
        );
        return;
      }

      let internalId: number;
      try {
        internalId = this.allocateInternalId();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        sendError(socket, "queue_full", detail, message.id);
        return;
      }

      externalToInternal.set(message.id, internalId);
      internalToExternal.set(internalId, message.id);

      try {
        connection?.send({ ...message, id: internalId });
      } catch (err) {
        externalToInternal.delete(message.id);
        internalToExternal.delete(internalId);
        this.releaseInternalId(internalId);
        const detail = err instanceof Error ? err.message : String(err);
        sendError(socket, "ipc_error", detail, message.id);
      }
    };

    const forwardMappedIdMessage = (
      message:
        | StdinCommandMessage
        | PtyResizeCommandMessage
        | ExecWindowCommandMessage,
    ): void => {
      const internalId = externalToInternal.get(message.id);
      if (internalId === undefined) {
        sendError(socket, "unknown_id", "request id not found", message.id);
        return;
      }

      try {
        connection?.send({ ...message, id: internalId } as ClientMessage);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        sendError(socket, "ipc_error", detail, message.id);
      }
    };

    const handleMessage = (message: ClientMessage): void => {
      if (message.type === "boot") {
        // Attach clients connect to an already-running VM; ignore boot requests.
        return;
      }

      if (message.type === "exec") {
        handleExec(message);
        return;
      }

      if (message.type === "stdin") {
        forwardMappedIdMessage(message);
        return;
      }

      if (message.type === "pty_resize") {
        forwardMappedIdMessage(message);
        return;
      }

      if (message.type === "exec_window") {
        forwardMappedIdMessage(message);
        return;
      }

      if (message.type === "lifecycle") {
        sendError(
          socket,
          "unsupported",
          "lifecycle actions are not supported over attach IPC",
        );
        return;
      }
    };

    socket.on("data", (chunk: Buffer) => {
      readBuffer = Buffer.concat([readBuffer, chunk]);

      while (true) {
        if (expectedLength === null) {
          if (readBuffer.length < 4) return;
          expectedLength = readBuffer.readUInt32BE(0);
          readBuffer = readBuffer.subarray(4);
        }

        if (readBuffer.length < expectedLength) return;

        const frame = readBuffer.subarray(0, expectedLength);
        readBuffer = readBuffer.subarray(expectedLength);
        expectedLength = null;

        try {
          const message = JSON.parse(frame.toString()) as ClientMessage;
          handleMessage(message);
        } catch {
          sendError(socket, "invalid_request", "invalid framed JSON message");
        }
      }
    });

    const cleanup = () => {
      this.clients.delete(socket);

      for (const internalId of internalToExternal.keys()) {
        this.releaseInternalId(internalId);
      }

      internalToExternal.clear();
      externalToInternal.clear();

      connection?.close();
      connection = null;
    };

    socket.on("error", cleanup);
    socket.on("close", cleanup);
    socket.on("end", cleanup);
  }
}

export type IpcClientCallbacks = {
  /** called with JSON server messages */
  onJson: (message: ServerMessage) => void;
  /** called with binary output frames */
  onBinary: (data: Buffer) => void;
  /** called when the connection closes */
  onClose: (error?: Error) => void;
};

/** connect to an external session IPC socket */
export function connectToSession(
  sockPath: string,
  callbacks: IpcClientCallbacks,
): {
  send: (message: ClientMessage) => void;
  close: () => void;
} {
  const socket = net.createConnection({ path: sockPath });
  socket.setNoDelay(true);

  let closed = false;
  let readBuffer = Buffer.alloc(0);
  let expectedLength: number | null = null;
  let frameType: number | null = null;

  socket.on("data", (chunk: Buffer) => {
    readBuffer = Buffer.concat([readBuffer, chunk]);

    while (true) {
      if (expectedLength === null) {
        if (readBuffer.length < 5) return;
        frameType = readBuffer.readUInt8(0);
        expectedLength = readBuffer.readUInt32BE(1);
        readBuffer = readBuffer.subarray(5);
      }

      if (readBuffer.length < expectedLength) return;

      const frame = readBuffer.subarray(0, expectedLength);
      readBuffer = readBuffer.subarray(expectedLength);

      const type = frameType;
      expectedLength = null;
      frameType = null;

      if (type === 1) {
        callbacks.onBinary(Buffer.from(frame));
        continue;
      }

      try {
        const message = JSON.parse(frame.toString()) as ServerMessage;
        callbacks.onJson(message);
      } catch {
        // ignore malformed json frames
      }
    }
  });

  socket.on("error", (err) => {
    if (closed) return;
    closed = true;
    callbacks.onClose(err);
  });

  socket.on("close", () => {
    if (closed) return;
    closed = true;
    callbacks.onClose();
  });

  return {
    send(message: ClientMessage) {
      if (closed) return;
      const payload = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length, 0);
      socket.write(Buffer.concat([header, payload]));
    },
    close() {
      if (closed) return;
      closed = true;
      socket.destroy();
    },
  };
}

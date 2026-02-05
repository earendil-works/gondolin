import cbor from "cbor";

export const MAX_FRAME = 4 * 1024 * 1024;

export type ExecOutput = {
  v: number;
  t: "exec_output";
  id: number;
  p: {
    stream: "stdout" | "stderr";
    data: Buffer;
  };
};

export type ExecResponse = {
  v: number;
  t: "exec_response";
  id: number;
  p: {
    exit_code: number;
    signal?: number;
  };
};

export type ErrorResponse = {
  v: number;
  t: "error";
  id: number;
  p: {
    code: string;
    message: string;
  };
};

export type FsRequest = {
  v: number;
  t: "fs_request";
  id: number;
  p: {
    op: string;
    req: Record<string, unknown>;
  };
};

export type FsResponse = {
  v: number;
  t: "fs_response";
  id: number;
  p: {
    op: string;
    err: number;
    res?: Record<string, unknown>;
    message?: string;
  };
};

export type VfsReady = {
  v: number;
  t: "vfs_ready";
  id: number;
  p: Record<string, never>;
};

export type VfsError = {
  v: number;
  t: "vfs_error";
  id: number;
  p: {
    message: string;
  };
};

export type IncomingMessage =
  | ExecOutput
  | ExecResponse
  | ErrorResponse
  | FsRequest
  | FsResponse
  | VfsReady
  | VfsError;

export type ExecRequest = {
  v: number;
  t: "exec_request";
  id: number;
  p: {
    cmd: string;
    argv?: string[];
    env?: string[];
    cwd?: string;
    stdin?: boolean;
    pty?: boolean;
  };
};

export type StdinData = {
  v: number;
  t: "stdin_data";
  id: number;
  p: {
    data: Buffer;
    eof?: boolean;
  };
};

export type PtyResize = {
  v: number;
  t: "pty_resize";
  id: number;
  p: {
    rows: number;
    cols: number;
  };
};

export class FrameReader {
  private buffer = Buffer.alloc(0);
  private expectedLength: number | null = null;

  push(chunk: Buffer, onFrame: (frame: Buffer) => void) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      if (this.expectedLength === null) {
        if (this.buffer.length < 4) return;
        this.expectedLength = this.buffer.readUInt32BE(0);
        this.buffer = this.buffer.slice(4);
        if (this.expectedLength > MAX_FRAME) {
          throw new Error(`Frame too large: ${this.expectedLength}`);
        }
      }

      if (this.buffer.length < this.expectedLength) return;

      const frame = this.buffer.slice(0, this.expectedLength);
      this.buffer = this.buffer.slice(this.expectedLength);
      this.expectedLength = null;
      onFrame(frame);
    }
  }
}

export function normalize(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      obj[String(key)] = normalize(entry);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry));
  }
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  return value;
}

export function decodeMessage(frame: Buffer): IncomingMessage {
  const raw = cbor.decodeFirstSync(frame);
  return normalize(raw) as IncomingMessage;
}

export function buildExecRequest(
  id: number,
  payload: ExecRequest["p"]
): ExecRequest {
  const cleaned: ExecRequest["p"] = { cmd: payload.cmd };
  if (payload.argv !== undefined) cleaned.argv = payload.argv;
  if (payload.env !== undefined) cleaned.env = payload.env;
  if (payload.cwd !== undefined) cleaned.cwd = payload.cwd;
  if (payload.stdin !== undefined) cleaned.stdin = payload.stdin;
  if (payload.pty !== undefined) cleaned.pty = payload.pty;

  return {
    v: 1,
    t: "exec_request",
    id,
    p: cleaned,
  };
}

export function buildStdinData(id: number, data: Buffer, eof?: boolean): StdinData {
  return {
    v: 1,
    t: "stdin_data",
    id,
    p: {
      data,
      ...(eof ? { eof } : {}),
    },
  };
}

export function buildPtyResize(id: number, rows: number, cols: number): PtyResize {
  return {
    v: 1,
    t: "pty_resize",
    id,
    p: {
      rows,
      cols,
    },
  };
}

export function encodeFrame(message: object): Buffer {
  const payload = cbor.encode(message);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

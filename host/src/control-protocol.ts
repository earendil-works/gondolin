/**
 * Sandbox control protocol.
 *
 * Transport:
 * - JSON control messages typed in this module.
 * - Binary output frames stream stdout/stderr chunks.
 *
 * Client → Server:
 * - exec { type: "exec", id, cmd, argv?, env?, cwd?, stdin?, pty? }
 * - stdin { type: "stdin", id, data?: base64 string, eof? }
 * - pty_resize { type: "pty_resize", id, rows, cols }
 * - lifecycle { type: "lifecycle", action: "restart" | "shutdown" }
 * - boot { type: "boot", fuseMount?, fuseBinds? }
 *
 * Server → Client:
 * - status { type: "status", state: "starting" | "running" | "stopped" }
 * - exec_response { type: "exec_response", id, exit_code, signal? }
 * - error { type: "error", id?, code, message }
 *
 * Binary output frame:
 * +---------+-----------+-------------------+
 * | u8 tag  | u32 id    | data bytes        |
 * +---------+-----------+-------------------+
 * tag = 1 stdout, tag = 2 stderr, id big-endian.
 */
export type ExecCommandMessage = {
  type: "exec";
  /** request id */
  id: number;
  /** executable */
  cmd: string;
  /** argv entries (excluding cmd) */
  argv?: string[];
  /** environment variables as `KEY=VALUE` */
  env?: string[];
  /** working directory */
  cwd?: string;
  /** whether stdin messages will be sent */
  stdin?: boolean;
  /** whether to allocate a pty */
  pty?: boolean;

  /** initial stdout credit window in `bytes` */
  stdout_window?: number;
  /** initial stderr credit window in `bytes` */
  stderr_window?: number;
};

export type StdinCommandMessage = {
  type: "stdin";
  /** request id */
  id: number;
  /** stdin chunk as base64 */
  data?: string;
  /** whether this chunk closes stdin */
  eof?: boolean;
};

export type PtyResizeCommandMessage = {
  type: "pty_resize";
  /** request id */
  id: number;
  /** pty row count */
  rows: number;
  /** pty column count */
  cols: number;
};

export type LifecycleCommandMessage = {
  type: "lifecycle";
  /** lifecycle action */
  action: "restart" | "shutdown";
};

export type BootCommandMessage = {
  type: "boot";
  /** guest mountpoint for fuse (defaults to server config) */
  fuseMount?: string;
  /** guest paths to bind into the fuse mount */
  fuseBinds?: string[];
};

export type ExecWindowCommandMessage = {
  type: "exec_window";
  /** request id */
  id: number;
  /** additional stdout credits in `bytes` */
  stdout?: number;
  /** additional stderr credits in `bytes` */
  stderr?: number;
};

export type ClientMessage =
  | BootCommandMessage
  | ExecCommandMessage
  | StdinCommandMessage
  | PtyResizeCommandMessage
  | ExecWindowCommandMessage
  | LifecycleCommandMessage;

export type ExecResponseMessage = {
  type: "exec_response";
  /** request id */
  id: number;
  /** process exit code */
  exit_code: number;
  /** termination signal (if any) */
  signal?: number;
};

export type ErrorMessage = {
  type: "error";
  /** request id (when the error is correlated to a request) */
  id?: number;
  /** stable error code */
  code: string;
  /** human-readable error message */
  message: string;
};

export type StatusMessage = {
  type: "status";
  /** sandbox state */
  state: "starting" | "running" | "stopped";
};

export type ServerMessage = ExecResponseMessage | ErrorMessage | StatusMessage;

export type OutputStream = "stdout" | "stderr";

export const OUTPUT_HEADER_BYTES = 5;

export function encodeOutputFrame(id: number, stream: OutputStream, data: Buffer): Buffer {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) {
    throw new RangeError("id must be a uint32");
  }
  const header = Buffer.alloc(OUTPUT_HEADER_BYTES);
  header.writeUInt8(stream === "stdout" ? 1 : 2, 0);
  header.writeUInt32BE(id, 1);
  return Buffer.concat([header, data]);
}

export function decodeOutputFrame(frame: Buffer): {
  id: number;
  stream: OutputStream;
  data: Buffer;
} {
  if (frame.length < OUTPUT_HEADER_BYTES) {
    throw new Error("output frame too short");
  }
  const streamFlag = frame.readUInt8(0);
  const stream = streamFlag === 1 ? "stdout" : "stderr";
  const id = frame.readUInt32BE(1);
  return {
    id,
    stream,
    data: frame.slice(OUTPUT_HEADER_BYTES),
  };
}
